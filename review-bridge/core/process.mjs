import { spawn } from "node:child_process";
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
      }));
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (forceTimer) clearTimeout(forceTimer);
    await Promise.allSettled([finished(stdout), finished(stderr)]);
  }
  return result;
}
