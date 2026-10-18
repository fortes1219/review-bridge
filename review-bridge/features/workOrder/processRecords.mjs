// The calling side of the stop protocol, shared by every process Bridge starts for a run: the
// writer, Gate A, the contract calls and the reviewer. `stop` marks the run stopped inside the run
// lock and only then reads the recorded pid; a call records its pid and then reads the status.
// Whichever side comes second sees the other, so a process started around a stop does not keep
// running.
import fsp from "node:fs/promises";
import path from "node:path";

import { ensureDir, killProcessTree, readRun, writeJsonAtomic } from "../../service/index.mjs";

export function processFile(paths, runId) {
  return path.join(paths.runLocksDir, runId + ".process.json");
}

export async function recordProcess(paths, runId, record) {
  if (!runId) return;
  await ensureDir(paths.runLocksDir);
  await writeJsonAtomic(processFile(paths, runId), { ...record, started_at: new Date().toISOString() });
}

// Fails closed: a run that is stopped, missing, or whose record cannot be read must not keep a
// model call or Gate A command running.
export async function runMustStop(paths, runId) {
  if (!runId) return false;
  try {
    return (await readRun(paths, runId)).status === "stopped";
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

export async function readRunStatus(paths, runId) {
  if (!runId) return null;
  return (await readRun(paths, runId).catch(() => null))?.status || null;
}
