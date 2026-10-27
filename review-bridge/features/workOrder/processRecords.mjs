// The calling side of the stop protocol, shared by every process Bridge starts for a run: the
// writer, the tests, the contract calls and the reviewer. `stop` marks the run stopped inside the run
// lock and only then reads the recorded pid; a call records its pid and then reads the status.
// Whichever side comes second sees the other, so a process started around a stop does not keep
// running.
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { ensureDir, isStoppedRun, killProcessTree, readRun, writeJsonAtomic } from "../../service/index.mjs";
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

// Fails closed: a run that is stopped, missing, or whose record cannot be read must not keep a
// model call or test command running.
export async function runMustStop(paths, runId) {
  if (!runId) return false;
  try {
    return isStoppedRun(await readRun(paths, runId));
  } catch {
    return true;
  }
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

// Whether the run was closed by a stop; false when its record cannot be read.
export async function runStopped(paths, runId) {
  if (!runId) return false;
  return isStoppedRun(await readRun(paths, runId).catch(() => null));
}
