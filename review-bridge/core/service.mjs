import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileExists, readJson, writeJsonAtomic } from "./io.mjs";

// T0-01 contract: "running" means the recorded process answers on its recorded
// port with its own service id. Nothing here decides from a pid alone, a file's
// presence alone, or any printed text.
const READY_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 250;
const STOP_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 2_000;
export const NOT_RUNNING_LINE = "Bridge 沒在跑，執行 review-bridge up";
export const CHECK_REASONS = Object.freeze(["running", "no_session", "pid_dead", "unreachable", "timeout", "wrong_service"]);

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

// C1: written by the watch process itself right after listen succeeds.
export async function writeServiceSession(paths, { pid, port, url, service_id, started_at }) {
  const record = { pid, port, url, service_id, started_at };
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null) throw new Error("Service session is missing " + key + ".");
  }
  await writeJsonAtomic(serviceFiles(paths).sessionPath, record);
  return record;
}

export async function removeServiceSession(paths) {
  await fsp.rm(serviceFiles(paths).sessionPath, { force: true });
}

function validSession(session) {
  return Boolean(session)
    && Number.isInteger(session.pid) && session.pid > 0
    && Number.isInteger(session.port) && session.port > 0 && session.port <= 65535
    && typeof session.url === "string"
    && typeof session.service_id === "string" && /^[0-9a-f]{32}$/.test(session.service_id);
}

async function readSessionRecord(paths) {
  const { sessionPath } = serviceFiles(paths);
  if (!(await fileExists(sessionPath))) return null;
  const session = await readJson(sessionPath).catch(() => null);
  return validSession(session) ? session : null;
}

function probeStatus(port) {
  return new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method: "GET",
      path: "/api/status",
      headers: { Host: "localhost:" + port },
      timeout: PROBE_TIMEOUT_MS,
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode !== 200) return resolve({ reason: "wrong_service" });
        try {
          const body = JSON.parse(data);
          resolve(body && typeof body === "object" ? { reason: "ok", body } : { reason: "wrong_service" });
        } catch {
          resolve({ reason: "wrong_service" });
        }
      });
    });
    req.once("timeout", () => { req.destroy(); resolve({ reason: "timeout" }); });
    req.once("error", (error) => resolve({ reason: error.code === "ETIMEDOUT" ? "timeout" : "unreachable" }));
    req.end();
  });
}

// C4/C5: the one check every command uses. Four steps in order, first failure wins,
// never throws.
export async function checkService(paths) {
  const session = await readSessionRecord(paths);
  if (!session) return { running: false, reason: "no_session", url: null, session: null };
  if (!isPidAlive(session.pid)) return { running: false, reason: "pid_dead", url: session.url, session };
  const probe = await probeStatus(session.port);
  if (probe.reason !== "ok") return { running: false, reason: probe.reason, url: session.url, session };
  if (probe.body.service_id !== session.service_id || probe.body.pid !== session.pid) {
    return { running: false, reason: "wrong_service", url: session.url, session };
  }
  return { running: true, reason: "running", url: session.url, session };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readText(file) {
  return await fsp.readFile(file, "utf8").catch(() => "");
}

export async function serviceUp({ paths, bootstrapPath, watchArgs = [], out = process.stdout }) {
  const files = serviceFiles(paths);
  const current = await checkService(paths);
  if (current.running) {
    out.write("已在跑：" + current.url + "\n");
    return { exitCode: 0, url: current.url, already_running: true, reason: current.reason };
  }
  // B4: whatever the stale record said, it is not a running service.
  await removeServiceSession(paths);
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
  let check = { running: false, reason: "no_session", url: null };
  while (Date.now() < deadline && exited === null) {
    check = await checkService(paths);
    if (check.running) break;
    await pause(READY_POLL_MS);
  }
  if (!check.running) {
    // B5
    if (exited === null) { try { process.kill(child.pid); } catch {} }
    const stderrTail = (await readText(files.stderrPath)).trim().split(/\r?\n/).pop();
    const reason = exited !== null && stderrTail ? stderrTail : check.reason;
    out.write("Bridge 沒有啟動：" + reason + "\n");
    return { exitCode: 2, url: null, already_running: false, reason: check.reason };
  }
  child.unref();
  // Display only: the bump line the watch process printed; never a decision input.
  for (const line of (await readText(files.stdoutPath)).split(/\r?\n/)) {
    if (line.includes("占用，改用")) out.write(line + "\n");
  }
  out.write("網頁：" + check.url + "\n");
  return { exitCode: 0, url: check.url, already_running: false, reason: check.reason };
}

export async function serviceDown({ paths, out = process.stdout }) {
  const check = await checkService(paths);
  if (!check.running) {
    // B7: nothing verified as ours is running. A stale record is dropped; a pid that
    // did not prove its identity is never killed on the record's say-so.
    await removeServiceSession(paths);
    out.write("Bridge 沒在跑\n");
    return { exitCode: 1, reason: check.reason };
  }
  const { pid } = check.session;
  try { process.kill(pid); } catch {}
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  let after = await checkService(paths);
  while (!["unreachable", "no_session"].includes(after.reason) && Date.now() < deadline) {
    await pause(100);
    after = await checkService(paths);
  }
  if (isPidAlive(pid) && !["unreachable", "no_session"].includes(after.reason)) {
    out.write("Bridge 沒有停下來（pid " + pid + "）。\n");
    return { exitCode: 2, reason: after.reason };
  }
  await removeServiceSession(paths);
  out.write("Bridge 已停止。\n");
  return { exitCode: 0, reason: "stopped" };
}

export async function serviceStatus({ paths, out = process.stdout }) {
  const check = await checkService(paths);
  if (!check.running) {
    out.write(NOT_RUNNING_LINE + "\n");
    return { exitCode: 1, running: false, reason: check.reason };
  }
  out.write(check.url + "\n進行中 0\n");
  return { exitCode: 0, running: true, url: check.url, reason: check.reason };
}
