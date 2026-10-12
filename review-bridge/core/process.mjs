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
  });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  child.stdin.end(input);
  // T0-04 D5.1: the caller records the pid so `stop` can reach the process tree.
  if (onSpawn && Number.isInteger(child.pid)) await onSpawn(child.pid);

  let timer;
  let forceTimer;
  let timedOut = false;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 1500);
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

// T0-04 D5.2: terminate a recorded process and everything it spawned.
export async function killProcessTree(pid, { platform = process.platform, waitMs = 5_000 } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { killed: false, reason: "invalid_pid" };
  if (!isPidAlive(pid)) return { killed: false, reason: "not_running" };
  if (platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, encoding: "utf8" });
  } else {
    try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} }
  }
  const deadline = Date.now() + waitMs;
  while (isPidAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  if (isPidAlive(pid)) {
    if (platform !== "win32") { try { process.kill(pid, "SIGKILL"); } catch {} }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { killed: !isPidAlive(pid), reason: isPidAlive(pid) ? "still_running" : "killed" };
}
