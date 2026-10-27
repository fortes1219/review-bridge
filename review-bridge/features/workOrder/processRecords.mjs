// The calling side of the stop protocol, shared by every process Bridge starts for a run: the
// writer, the tests, the contract calls and the reviewer. `stop` marks the run stopped inside the run
// lock and only then reads the recorded pid; a call records its pid and then reads the status.
// Whichever side comes second sees the other, so a process started around a stop does not keep
// running.
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { ensureDir, isActiveRun, isStoppedRun, killProcessTree, readRun, RunEndedError, stopRunRecord, writeJsonAtomic } from "../../service/index.mjs";
import { timestampId } from "../../utils/dates.mjs";

export function processFile(paths, runId) {
  return path.join(paths.runLocksDir, runId + ".process.json");
}

// The work lock of one run: held by the process working it, from just before the run is created
// until its loop returns. Runs of different work orders hold different locks and work side by side.
export function workLockFile(paths, runId) {
  return path.join(paths.runLocksDir, runId + ".work.lock");
}

// The start lock of one work order, keyed by its place (workOrderLocation): held from
// looking for its running version until the new run exists, so two starts of one work order never
// both find nothing to replace, however its path is spelled. Starts of different work orders take
// different locks and do not wait for each other.
export function startLockFile(paths, location) {
  return path.join(paths.runLocksDir, "start-" + createHash("sha256").update(String(location)).digest("hex").slice(0, 16) + ".lock");
}

// File names for one call of one run: the time, then the run, so two runs never share a name.
export function callStamp(runId) {
  return timestampId() + "-r" + String(runId || "").slice(0, 8);
}

export async function recordProcess(paths, runId, record) {
  if (!runId) return;
  await ensureDir(paths.runLocksDir);
  await writeJsonAtomic(processFile(paths, runId), { ...record, started_at: new Date().toISOString() });
}

// The run's own time limit (run_timeout): a running run past its timeout_at is closed here, at the
// checkpoint that finds it, as timed out. No timer of its own runs; every call is cut short at the
// deadline (callTimeLeft), so the next checkpoint comes no later than that.
const pastDeadline = (run) => isActiveRun(run) && Boolean(run.timeout_at) && Date.parse(run.timeout_at) <= Date.now();

async function closeAtDeadline(paths, runId) {
  try {
    await stopRunRecord(paths, runId, { closedReason: "run_timeout" });
  } catch (error) {
    if (!(error instanceof RunEndedError)) throw error;
  }
  return isStoppedRun(await readRun(paths, runId));
}

// Fails closed: a run that is stopped, missing, past its deadline, or whose record cannot be read
// must not keep a model call or test command running.
export async function runMustStop(paths, runId) {
  if (!runId) return false;
  try {
    const run = await readRun(paths, runId);
    return pastDeadline(run) ? await closeAtDeadline(paths, runId) : isStoppedRun(run);
  } catch {
    return true;
  }
}

// How long the next call of a run may take: its own limit (none for the reviewer), cut to what is
// left before the run's deadline. Null when nothing is left; the run is then closed as timed out
// and no call starts.
export async function callTimeLeft(paths, runId, timeoutMs) {
  if (!runId) return timeoutMs;
  // A run whose record cannot be read has no deadline to cut to; the stop checks fail closed on it.
  const run = await readRun(paths, runId).catch(() => null);
  if (!run?.timeout_at) return timeoutMs;
  if (pastDeadline(run)) {
    await closeAtDeadline(paths, runId);
    return null;
  }
  const left = Date.parse(run.timeout_at) - Date.now();
  return Number.isFinite(timeoutMs) ? Math.min(timeoutMs, left) : left;
}

// A kill counts as done only when killProcessTree confirms it, or when nothing was running. A
// failed tree walk on Windows may have killed only the main process and left its children, so
// killed:false is never a success, whatever the main pid looks like afterwards.
export function killConfirmed(result) {
  return result?.killed === true || result?.reason === "not_running";
}

// The calling side's kill of its own process after finding the run stopped. A kill that is not
// confirmed is an error: the pid record stays for another stop, and runProcess kills what it can
// before the error goes up.
export async function killStartedAfterStop(pid, { kill = killProcessTree } = {}) {
  const result = await kill(pid);
  if (!killConfirmed(result)) throw new Error("A process started after the stop could not be killed: pid " + pid + " (" + result.reason + ").");
}

// Record the pid, then read the status; a run stopped in between gets its new process killed here,
// since stop may have read no pid.
export async function recordProcessOrKill(paths, runId, record, options = {}) {
  await recordProcess(paths, runId, record);
  if (await runMustStop(paths, runId)) await killStartedAfterStop(record.pid, options);
}

export async function clearProcess(paths, runId) {
  if (!runId) return;
  await fsp.rm(processFile(paths, runId), { force: true });
}

// Whether the run was closed by a stop or by its deadline; false when its record cannot be read.
export async function runStopped(paths, runId) {
  if (!runId) return false;
  const run = await readRun(paths, runId).catch(() => null);
  return pastDeadline(run) ? await closeAtDeadline(paths, runId) : isStoppedRun(run);
}
