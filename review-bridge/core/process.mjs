import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";

export async function runProcess({
  invocation,
  cwd,
  input = "",
  stdoutPath,
  stderrPath,
  timeoutMs = 0,
  onSpawn = null,
}) {
  await fsp.mkdir(path.dirname(stdoutPath), { recursive: true });
  await fsp.mkdir(path.dirname(stderrPath), { recursive: true });
  const stdout = fs.createWriteStream(stdoutPath);
  const stderr = fs.createWriteStream(stderrPath);
  const child = spawn(invocation.command, invocation.args, {
    cwd,
    env: invocation.env || process.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    // T0-06 G3.2: a sealed Gate A command string runs through the platform shell as one line.
    shell: invocation.shell === true,
    // A shell run gets its own process group on POSIX so a timeout can reach its descendants.
    detached: invocation.shell === true && process.platform !== "win32",
  });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  child.stdin.end(input);
  // T0-04 D5.1: the caller records the pid so `stop` can reach the process tree.
  if (onSpawn && Number.isInteger(child.pid)) await onSpawn(child.pid);

  let timer;
  let forceTimer;
  let timedOut = false;
  let treeKill = null;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      // Codex finding 2026-10-13: the tree is terminated while the shell is still alive, and the
      // result is awaited below so runProcess returns only once the kill has finished.
      treeKill = killProcessTree(child.pid, { group: invocation.shell === true })
        .catch((error) => ({ killed: false, reason: "kill_error:" + String(error?.message || error) }))
        .finally(() => { try { child.kill("SIGKILL"); } catch {} });
      forceTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 6_000);
      forceTimer.unref();
    }, timeoutMs);
    timer.unref();
  }

  let result;
  try {
    result = await new Promise((resolve, reject) => {
      child.once("error", (error) => {
        stdout.end();
        stderr.end();
        reject(error);
      });
      child.once("close", (code, signal) => resolve({
        exitCode: code === null ? 2 : code,
        signal,
        timedOut,
        pid: child.pid,
      }));
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (forceTimer) clearTimeout(forceTimer);
    await Promise.allSettled([finished(stdout), finished(stderr)]);
  }
  if (treeKill) result.tree_kill = await treeKill;
  return result;
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// On POSIX a process group is alive while any member is; signal 0 to -pgid answers that.
function isGroupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// T0-04 D5.2: terminate a recorded process and everything it spawned. On win32 taskkill /T
// walks the tree. On POSIX the tree is reachable only when `pid` leads its own process group
// (`group: true`, as shell runs are spawned detached); the wait then covers every member.
// Verified on win32 (2026-10-13); the POSIX group path has not been exercised on a POSIX host.
export async function killProcessTree(pid, { platform = process.platform, waitMs = 5_000, group = false, taskkill = "taskkill.exe" } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { killed: false, reason: "invalid_pid" };
  const posixGroup = platform !== "win32" && group;
  const alive = () => (posixGroup ? isGroupAlive(pid) || isPidAlive(pid) : isPidAlive(pid));
  if (!alive()) return { killed: false, reason: "not_running" };
  if (platform === "win32") {
    // Codex finding 2026-10-13: a failed taskkill must not be reported as a cleared tree.
    const walked = spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], { windowsHide: true, encoding: "utf8" });
    if (walked.error || walked.status !== 0) {
      try { process.kill(pid, "SIGKILL"); } catch {}
      const hardDeadline = Date.now() + 2_000;
      while (isPidAlive(pid) && Date.now() < hardDeadline) await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        killed: false,
        reason: "taskkill_failed:" + (walked.error ? walked.error.code || "error" : String(walked.status)),
        scope: "pid",
        parent_alive: isPidAlive(pid),
        detail: String(walked.stderr || walked.error?.message || "").trim().slice(0, 200),
      };
    }
  } else if (posixGroup) {
    try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} }
  } else {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  const deadline = Date.now() + waitMs;
  while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  if (alive()) {
    if (platform !== "win32") {
      if (posixGroup) { try { process.kill(-pid, "SIGKILL"); } catch {} }
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    const hardDeadline = Date.now() + 2_000;
    while (alive() && Date.now() < hardDeadline) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { killed: !alive(), reason: alive() ? "still_running" : "killed", scope: platform === "win32" ? "tree" : posixGroup ? "group" : "pid" };
}
