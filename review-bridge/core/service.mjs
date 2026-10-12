import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileExists, readJson, writeJsonAtomic } from "./io.mjs";

const READY_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 10_000;
export const NOT_RUNNING_LINE = "Bridge 沒在跑，執行 review-bridge up";

// Everything the resident service exposes after a restart is read back from these files.
export function serviceFiles(paths) {
  return {
    sessionPath: path.join(paths.privateRoot, "watch-session.json"),
    urlPath: path.join(paths.privateRoot, "watch-url.txt"),
    stdoutPath: path.join(paths.privateRoot, "logs", "watch.stdout.log"),
    stderrPath: path.join(paths.privateRoot, "logs", "watch.stderr.log"),
  };
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

export async function readServiceSession(paths) {
  const { sessionPath } = serviceFiles(paths);
  if (!(await fileExists(sessionPath))) return null;
  const session = await readJson(sessionPath).catch(() => null);
  if (!session || !isPidAlive(session.pid) || typeof session.url !== "string") return null;
  return session;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readText(file) {
  return await fsp.readFile(file, "utf8").catch(() => "");
}

export async function serviceUp({ paths, bootstrapPath, watchArgs = [], out = process.stdout }) {
  const files = serviceFiles(paths);
  const running = await readServiceSession(paths);
  if (running) {
    out.write("已在跑：" + running.url + "\n");
    return { exitCode: 0, url: running.url, already_running: true };
  }
  await fsp.rm(files.sessionPath, { force: true });
  await fsp.rm(files.urlPath, { force: true });
  await fsp.mkdir(path.dirname(files.stdoutPath), { recursive: true });
  const stdoutFd = fs.openSync(files.stdoutPath, "w");
  const stderrFd = fs.openSync(files.stderrPath, "w");
  let exited = null;
  let child;
  try {
    child = spawn(process.execPath, [bootstrapPath, "watch", ...watchArgs], {
      cwd: paths.repoRoot,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", stdoutFd, stderrFd],
    });
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
  child.once("exit", (code) => { exited = code ?? 1; });
  child.once("error", () => { exited = 1; });
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let url = "";
  while (Date.now() < deadline && exited === null) {
    url = (await readText(files.urlPath)).trim();
    if (url) break;
    await pause(100);
  }
  if (!url) {
    if (exited === null) { try { process.kill(child.pid); } catch {} }
    const reason = (await readText(files.stderrPath)).trim().split(/\r?\n/).pop()
      || "watch did not report a URL in time.";
    out.write("Bridge 沒有啟動：" + reason + "\n");
    return { exitCode: 2, url: null, already_running: false };
  }
  child.unref();
  await writeJsonAtomic(files.sessionPath, { pid: child.pid, url, started_at: new Date().toISOString() });
  for (const line of (await readText(files.stdoutPath)).split(/\r?\n/)) {
    if (line.includes("占用，改用")) out.write(line + "\n");
  }
  out.write("網頁：" + url + "\n");
  return { exitCode: 0, url, already_running: false };
}

export async function serviceDown({ paths, out = process.stdout }) {
  const files = serviceFiles(paths);
  const session = await fileExists(files.sessionPath) ? await readJson(files.sessionPath).catch(() => null) : null;
  if (session && isPidAlive(session.pid)) {
    try { process.kill(session.pid); } catch {}
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (isPidAlive(session.pid) && Date.now() < deadline) await pause(100);
    if (isPidAlive(session.pid)) {
      out.write("Bridge 沒有停下來（pid " + session.pid + "）。\n");
      return { exitCode: 2 };
    }
    await fsp.rm(files.sessionPath, { force: true });
    out.write("Bridge 已停止。\n");
    return { exitCode: 0 };
  }
  await fsp.rm(files.sessionPath, { force: true });
  out.write("Bridge 沒在跑。\n");
  return { exitCode: 0 };
}

export async function serviceStatus({ paths, out = process.stdout }) {
  const session = await readServiceSession(paths);
  if (!session) {
    out.write(NOT_RUNNING_LINE + "\n");
    return { exitCode: 1, running: false };
  }
  out.write(session.url + "\n進行中 0\n");
  return { exitCode: 0, running: true, url: session.url };
}
