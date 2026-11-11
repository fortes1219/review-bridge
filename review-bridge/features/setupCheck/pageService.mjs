// The resident page service, as Supabase CLI treats its stack owner (supabase/cli c75aea2,
// packages/stack/ARCHITECTURE.md:487-536; src/HostProcess.ts). It runs while it holds its lease
// (pageLease.mjs); a command finds it through the lease, its published record and its control
// endpoint's identity, never through a pid or a page that answers. `up` and `watch` start it the one
// way: spawned with a readiness pipe it answers on once it serves. `down` asks it to shut down and waits
// until its process is gone.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileExists, isPidAlive, readJson } from "../../service/index.mjs";
import { bridgeRunner } from "../../utils/bridgeCommand.mjs";
import { createTranslator, resolveLocale } from "../workOrder/i18n.mjs";

// The lease module reaches the person's database; it is loaded only by the commands that look for the page service.
const leaseModule = () => import("./pageLease.mjs");

const STATUS_TIMEOUT_MS = 2_000;
// What these say is in the project's language, as the database lines beside them are (Fortes 2026-11-09).
const wordsFor = async (paths) => createTranslator(await resolveLocale(paths));
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// The page service's files outside its lease: the address editors read, the log its stdout and stderr
// go to (one file, as the stack owner's owner.log), and the record an older Bridge (0.3.0-rc.3) kept.
export function serviceFiles(paths) {
  return {
    sessionPath: paths.watchSessionPath,
    urlPath: paths.watchUrlPath,
    logPath: path.join(paths.logRoot, "page-service.log"),
  };
}

export class PageServiceError extends Error {
  constructor(message, reason, extra = {}) {
    super(message);
    this.reason = reason;
    Object.assign(this, extra);
  }
}

// ---- Release (ARCHITECTURE.md:489) -------------------------------------------------------------
// The package version plus a digest of the runtime's module sources: any change to the page service or
// its protocol is a new release, and a source checkout computes it as an installed copy does.
const releases = new Map();
export function currentRelease(bridgeRoot) {
  if (!releases.has(bridgeRoot)) releases.set(bridgeRoot, computeRelease(bridgeRoot));
  return releases.get(bridgeRoot);
}

async function computeRelease(bridgeRoot) {
  const version = await readJson(path.join(bridgeRoot, "..", "package.json")).then((manifest) => manifest.version, () => "source");
  const files = [];
  // A queue of folders, not recursion; the files are sorted afterwards.
  const queue = [[bridgeRoot, ""]];
  while (queue.length) {
    const [directory, relative] = queue.shift();
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const next = relative ? relative + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && next !== "tests") queue.push([path.join(directory, entry.name), next]);
      } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
        files.push([next, createHash("sha256").update(await fsp.readFile(path.join(directory, entry.name))).digest("hex")]);
      }
    }
  }
  files.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return version + "+" + createHash("sha256").update(JSON.stringify(files)).digest("hex").slice(0, 16);
}

// ---- Control requests (HostProcess.ts:72-83,200-241) --------------------------------------------
function controlRequest(record, method, requestPath, { timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const req = http.request({
      host: "127.0.0.1", port: record.port, method, path: requestPath,
      headers: { authorization: "Bearer " + record.secret },
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => finish({ status: res.statusCode, body: data }));
      res.on("error", (error) => finish({ error }));
    });
    const timer = setTimeout(() => { finish({ timedOut: true }); req.destroy(); }, timeoutMs);
    req.on("error", (error) => finish({ error }));
    req.end();
  });
}

// Anything but a matching answer means the record names a process that no longer serves it: that is a
// record not yet replaced, so the lookup goes on. Only a request that times out is a connection failure.
async function identityOf(record) {
  const answer = await controlRequest(record, "GET", "/identity", { timeoutMs: 2_000 });
  if (answer.timedOut) return { reason: "connection-failure", message: "Timed out connecting to the page service's control endpoint" };
  const stale = (message) => ({ reason: "owner-starting", message });
  if (answer.error) return stale(answer.error.message);
  if (answer.status !== 200) return stale("The control endpoint answered " + answer.status);
  let endpoint;
  try { endpoint = JSON.parse(answer.body); } catch { return stale("The control endpoint's answer is not JSON"); }
  if (endpoint?.port !== record.port || endpoint?.pid !== record.pid || endpoint?.project_id !== record.project_id || typeof endpoint?.release !== "string") {
    return stale("The control endpoint belongs to another process");
  }
  return { reason: "ok", endpoint, record };
}

// An older Bridge's page service (0.3.0-rc.3) kept a record without a lease. Its process still running is
// neither this release's page service nor no page service: it is said with its pid, to be stopped first.
async function olderPageService(paths) {
  const record = await readJson(serviceFiles(paths).sessionPath).catch(() => null);
  return Number.isInteger(record?.pid) && record.pid > 0 && isPidAlive(record.pid) ? record : null;
}

// One reader of the project's lease for one look or one wait: a connection to the person's database that
// only reads pg_locks. None when the database is not running, which is no page service: it starts after
// the database.
async function withLeaseReader(paths, use) {
  const { openLeaseReader } = await leaseModule();
  // The settings first: a read that fails leaves no connection open.
  const projectId = (await readJson(paths.bridgeConfigPath)).project_id;
  const reader = await openLeaseReader();
  try {
    return await use(() => lookup(paths, reader, projectId));
  } finally {
    await reader?.close();
  }
}

async function lookup(paths, reader, projectId) {
  const { readRecord } = await leaseModule();
  if (!reader || !(await reader.held(projectId))) {
    const older = await olderPageService(paths);
    if (older) return { reason: "older-release", pid: older.pid };
    return { reason: "not-running" };
  }
  const holder = await readRecord(paths);
  if (!holder) return { reason: "owner-starting", message: "The page service has not published its record" };
  return await identityOf(holder);
}

const olderMessage = (pid) => "An older Bridge page service (pid " + pid + ") is still running. Run: " + bridgeRunner() + " down, then run this again.";

// Resolves the page service holding the lease, waiting while it publishes its record: every 50 ms for
// at most 30 s, then a failure naming its log (HostProcess.ts:271-336). A free lease is "not running" at
// once. A page service of another release is refused, except for `down`, which reaches any release.
export async function connectPage(paths, { anyRelease = false } = {}) {
  const deadline = Date.now() + 30_000;
  const found = await withLeaseReader(paths, async (look) => {
    let seen = await look();
    while (seen.reason === "owner-starting" && Date.now() < deadline) {
      await pause(50);
      seen = await look();
    }
    return seen;
  });
  if (found.reason === "not-running") throw new PageServiceError("The Bridge page service is not running.", "not-running");
  if (found.reason === "older-release") throw new PageServiceError(olderMessage(found.pid), "older-release", { pid: found.pid });
  if (found.reason !== "ok") {
    throw new PageServiceError("The Bridge page service did not become reachable: " + found.message + " (log: " + serviceFiles(paths).logPath + ")", found.reason === "owner-starting" ? "owner-startup" : found.reason);
  }
  const release = await currentRelease(paths.bridgeRoot);
  if (!anyRelease && found.endpoint.release !== release) {
    throw new PageServiceError("The Bridge page service is release " + found.endpoint.release + ", but this command is release " + release
      + ". Run: " + bridgeRunner() + " down, then run this again.", "release-mismatch", { pid: found.record.pid });
  }
  return { record: found.record, endpoint: found.endpoint, url: found.record.url, pagePort: found.record.page_port };
}

// Reads the live page service without waiting; a free lease costs no request (HostProcess.ts:254-265).
// For what only looks: status, ps, doctor and the installer's plans.
export async function observePage(paths) {
  try {
    const found = await withLeaseReader(paths, (look) => look());
    if (found.reason === "ok") return { running: true, reason: "running", url: found.record.url, pid: found.record.pid };
    if (found.reason === "older-release") return { running: false, reason: "older_release", url: null, pid: found.pid, message: olderMessage(found.pid) };
    return { running: false, reason: found.reason === "not-running" ? "not_running" : "not_answering", url: null };
  } catch (error) {
    return { running: false, reason: "unreadable", url: null, message: error.message };
  }
}

// ---- Starting (HostProcess.ts:467-616,662-707; internal/host-process.ts:18-41) ------------------
// The end of the log, read through the launcher's own descriptor: its last 20 lines, from 4096 bytes.
function logTail(descriptor) {
  try {
    const size = fs.fstatSync(descriptor).size;
    const length = Math.min(size, 4096);
    const bytes = Buffer.alloc(length);
    fs.readSync(descriptor, bytes, 0, length, size - length);
    return bytes.toString("utf8").trimEnd().split("\n").slice(-20).join("\n");
  } catch {
    return "";
  }
}

const exited = (child) => child.exitCode !== null || child.signalCode !== null || child.pid === undefined;
function awaitExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (exited(child)) return resolve(true);
    const timer = setTimeout(() => { child.off("exit", done); resolve(false); }, timeoutMs);
    function done() { clearTimeout(timer); resolve(true); }
    child.once("exit", done);
  });
}
function signalChild(child, name) {
  if (exited(child)) return;
  try {
    if (process.platform === "win32") child.kill(name);
    else process.kill(-child.pid, name);
  } catch {
    try { child.kill(name); } catch {}
  }
}
async function terminate(child) {
  signalChild(child, "SIGTERM");
  if (!(await awaitExit(child, 2_000))) {
    signalChild(child, "SIGKILL");
    await awaitExit(child, 2_000);
  }
}

// The first line on the readiness pipe, within 30 s; the pipe ending first is a page service that exited
// before reporting.
function readyLine(child) {
  return new Promise((resolve, reject) => {
    const readiness = child.stdio[3];
    if (!readiness) return reject(new Error("The page service's readiness pipe is unavailable"));
    let text = "";
    const timer = setTimeout(() => finish(reject, new Error("Timed out waiting for the page service to report it is ready")), 30_000);
    function finish(settle, value) {
      clearTimeout(timer);
      readiness.off("data", onData);
      readiness.off("end", onEnd);
      child.off("error", onError);
      readiness.destroy();
      settle(value);
    }
    function onData(chunk) {
      text += chunk;
      const end = text.indexOf("\n");
      if (end >= 0) finish(resolve, text.slice(0, end));
    }
    function onEnd() { finish(reject, new Error("The page service exited before reporting it is ready")); }
    function onError(error) { finish(reject, error); }
    readiness.setEncoding("utf8");
    readiness.on("data", onData);
    readiness.once("end", onEnd);
    child.once("error", onError);
  });
}

async function spawnOwner(paths, { bootstrapPath, ownerArgs, lifetime }) {
  const { logPath } = serviceFiles(paths);
  await fsp.mkdir(path.dirname(logPath), { recursive: true });
  const descriptor = fs.openSync(logPath, "a", 0o600);
  try {
    const failure = (message, extra) => new PageServiceError("The Bridge page service failed to start: " + message + " (log: " + logPath + ")"
      + (logTail(descriptor) ? "\n" + logTail(descriptor) : ""), "startup", extra);
    let child;
    try {
      child = spawn(process.execPath, [bootstrapPath, "page-service", "--lifetime", lifetime, ...ownerArgs], {
        cwd: paths.repoRoot,
        detached: true,
        windowsHide: true,
        stdio: [lifetime === "session" ? "pipe" : "ignore", descriptor, descriptor, "pipe"],
      });
    } catch (error) {
      throw failure(error.message);
    }
    let line;
    try {
      line = JSON.parse(await readyLine(child));
    } catch (error) {
      await terminate(child);
      throw failure(error.message);
    }
    if (line?.type === "error") {
      await awaitExit(child, 5_000);
      if (line.reason === "lease-held") return { ready: false };
      // The page service said why: its words and where its log is, not the log's lines
      // (HostProcess.ts:581-587; HostProcess.integration.test.ts:555-577).
      throw new PageServiceError("The Bridge page service failed to start: " + String(line.message || "it reported an error") + " (log: " + logPath + ")", "startup");
    }
    const projectId = (await readJson(paths.bridgeConfigPath)).project_id;
    if (line?.type !== "ready" || line.endpoint?.project_id !== projectId || typeof line.secret !== "string") {
      await terminate(child);
      throw failure("its readiness report does not match this project");
    }
    child.unref();
    if (lifetime === "session") {
      // Ending the lifeline of a page service that already exited reports EPIPE, which changes nothing.
      child.stdin.on("error", () => {});
      child.stdin.unref?.();
    }
    const record = { ...line.endpoint, secret: line.secret };
    return { ready: true, child, record, endpoint: line.endpoint, url: line.endpoint.url, pagePort: line.endpoint.page_port, notice: line.notice || null };
  } finally {
    fs.closeSync(descriptor);
  }
}

// Connects to the live page service, or starts one and attaches to whichever wins the lease. A spawn
// that lost the lease to another finds the winner; a page service that is not running yet is tried
// again every 100 ms for 10 s (HostProcess.ts:662-707).
export async function launchPage(paths, { bootstrapPath, ownerArgs = [], lifetime = "detached" }) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      return { ...(await connectPage(paths)), attached: true };
    } catch (error) {
      if (error.reason !== "not-running") throw error;
    }
    const spawned = await spawnOwner(paths, { bootstrapPath, ownerArgs, lifetime });
    if (spawned.ready) return { ...spawned, attached: false };
    try {
      return { ...(await connectPage(paths)), attached: true };
    } catch (error) {
      if (error.reason !== "not-running" || Date.now() >= deadline) throw error;
    }
    await pause(100);
  }
}

// Ends the lifeline of a page service started for this terminal and waits until it has shut down.
export async function closeLifeline(child) {
  child.stdin?.end();
  if (!(await awaitExit(child, 120_000))) process.stderr.write("The Bridge page service " + child.pid + " is still shutting down.\n");
}

// ---- Stopping (StackHost.ts:363-372; HostProcess.ts:709-815; ARCHITECTURE.md:532) ----------------
// The state field of /proc/<pid>/stat follows the last ")": the command name may hold spaces and parens.
const procStatState = (stat) => stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/u)[0];

// Probes the pid with signal 0: ESRCH is gone, EPERM is not known; on Linux a Z or X process is a zombie.
export function ownerExitProbe(platform = process.platform) {
  return async (pid) => {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return { state: "absent" };
      if (error.code === "EPERM") return { state: "inconclusive", code: "EPERM" };
      throw error;
    }
    if (platform !== "linux") return { state: "present" };
    const state = await fsp.readFile("/proc/" + pid + "/stat", "utf8").then(procStatState, () => undefined);
    return state === "Z" || state === "X" ? { state: "zombie" } : { state: "present" };
  };
}

// Waits until the pid is gone, every 25 ms for at most 5 s. A process still a zombie at the end has
// exited but was never reaped (a sandbox PID 1 that does not reap orphans) and counts as gone; one still
// present, or not known, is a failure carrying its pid.
export async function waitForOwnerExit(pid, probe, { clock = Date.now, sleep = pause } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new PageServiceError("The page service returned an invalid pid: " + pid, "invalid-owner-pid");
  const deadline = clock() + 5_000;
  let last;
  for (;;) {
    last = await probe(pid);
    if (last.state === "absent") return;
    if (clock() >= deadline) break;
    await sleep(25);
  }
  if (last.state === "zombie") return;
  throw new PageServiceError(last.state === "inconclusive"
    ? "The page service acknowledged the shutdown, but process " + pid + " is inaccessible (" + last.code + "); its exit is not known."
    : "The page service acknowledged the shutdown, but process " + pid + " is still running.", "owner-exit-pending", { pid });
}

// Asks the page service of any release to shut down, then waits for its process to be gone.
export async function stopPage(paths) {
  let found;
  try {
    found = await connectPage(paths, { anyRelease: true });
  } catch (error) {
    if (error.reason === "older-release") return await stopOlderPage(paths, { pid: error.pid });
    if (error.reason !== "not-running") throw error;
    await fsp.rm(serviceFiles(paths).sessionPath, { force: true });
    return { stopped: false };
  }
  const answer = await controlRequest(found.record, "POST", "/shutdown", { timeoutMs: 120_000 });
  // A lost answer is not known to be a shutdown; it is said as such, never retried blindly.
  if (answer.error || answer.timedOut) throw new PageServiceError("The page service's answer to the shutdown was lost; whether it stopped is not known (pid " + found.record.pid + ").", "shutdown-uncertain", { pid: found.record.pid });
  if (answer.status !== 204) throw new PageServiceError("The page service refused to shut down: " + answer.body, "shutdown-refused", { pid: found.record.pid });
  await waitForOwnerExit(found.record.pid, ownerExitProbe());
  return { stopped: true };
}

// An older Bridge's page service has no lease and no control endpoint: its identity is asked the way
// that release asked it (checkService), and only a process that proves it is stopped.
async function stopOlderPage(paths, older) {
  const check = await checkService(paths);
  if (!check.running || check.session.pid !== older.pid) {
    await fsp.rm(serviceFiles(paths).sessionPath, { force: true });
    return { stopped: false };
  }
  try { process.kill(older.pid); } catch {}
  await waitForOwnerExit(older.pid, ownerExitProbe());
  await fsp.rm(serviceFiles(paths).sessionPath, { force: true });
  return { stopped: true };
}

// ---- The page's own status, for the reviewer check ---------------------------------------------
function probeStatus(port, reviewer = null, mcp = null) {
  const query = [...(reviewer ? ["reviewer=" + encodeURIComponent(reviewer)] : []), ...(mcp ? ["mcp=" + encodeURIComponent(JSON.stringify(mcp))] : [])].join("&");
  return new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method: "GET",
      path: "/api/status" + (query ? "?" + query : ""),
      headers: { Host: "localhost:" + port },
      timeout: STATUS_TIMEOUT_MS,
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

// The page service found the waiting way, then its page's status: what the reviewer check and the
// native gate read. Whether the page service runs is decided by connectPage alone.
export async function checkPageStatus(paths, { reviewer = null, mcp = null } = {}) {
  let found;
  try {
    found = await connectPage(paths);
  } catch (error) {
    return { running: false, reason: error.reason, message: error.message, url: null };
  }
  const page = await probeStatus(found.pagePort, reviewer, mcp);
  if (page.reason !== "ok") return { running: true, reason: "status_" + page.reason, url: found.url, pagePort: found.pagePort, status: null };
  return { running: true, reason: "running", url: found.url, pagePort: found.pagePort, status: page.body };
}

// ---- An older layout's page service (the installer's rc2 check, and 0.3.0-rc.3 above) ----------
// How those releases asked: their record's pid alive and its port answering /api/status with the same
// service id and pid. Nothing of this release's page service is decided here.
function validSession(session) {
  return Boolean(session)
    && Number.isInteger(session.pid) && session.pid > 0
    && Number.isInteger(session.port) && session.port > 0 && session.port <= 65535
    && typeof session.url === "string"
    && typeof session.service_id === "string" && /^[0-9a-f]{32}$/.test(session.service_id);
}

export async function checkService(paths, { reviewer = null, mcp = null } = {}) {
  const { sessionPath } = serviceFiles(paths);
  const session = (await fileExists(sessionPath)) ? await readJson(sessionPath).catch(() => null) : null;
  if (!validSession(session)) return { running: false, reason: "no_session", url: null, session: null };
  if (!isPidAlive(session.pid)) return { running: false, reason: "pid_dead", url: session.url, session };
  const probe = await probeStatus(session.port, reviewer, mcp);
  if (probe.reason !== "ok") return { running: false, reason: probe.reason, url: session.url, session };
  if (probe.body.service_id !== session.service_id || probe.body.pid !== session.pid) {
    return { running: false, reason: "wrong_service", url: session.url, session };
  }
  return { running: true, reason: "running", url: session.url, session, status: probe.body };
}

// ---- The commands -----------------------------------------------------------------------------
export async function serviceUp({ paths, bootstrapPath, ownerArgs = [], out = process.stdout }) {
  const t = await wordsFor(paths);
  let launched;
  try {
    launched = await launchPage(paths, { bootstrapPath, ownerArgs, lifetime: "detached" });
  } catch (error) {
    out.write(t("page.up.failed", { reason: error.message }) + "\n");
    return { exitCode: 2, url: null, already_running: false, reason: error.reason };
  }
  if (launched.attached) {
    out.write(t("page.up.already_running", { url: launched.url }) + "\n");
    return { exitCode: 0, url: launched.url, already_running: true, reason: "running" };
  }
  // Display only: the port the page took instead of the one asked for.
  if (launched.notice) out.write(launched.notice + "\n");
  out.write(t("page.up.started", { url: launched.url }) + "\n");
  return { exitCode: 0, url: launched.url, already_running: false, reason: "running", notice: launched.notice };
}

export async function serviceDown({ paths, out = process.stdout }) {
  const t = await wordsFor(paths);
  let stopped;
  try {
    stopped = await stopPage(paths);
  } catch (error) {
    out.write(t("page.down.failed", { pid: error.pid ?? "?" }) + "\n" + error.message + "\n");
    return { exitCode: 2, reason: error.reason };
  }
  if (!stopped.stopped) {
    out.write(t("page.down.not_running") + "\n");
    return { exitCode: 1, reason: "not_running" };
  }
  out.write(t("page.down.stopped") + "\n");
  return { exitCode: 0, reason: "stopped" };
}

export async function serviceStatus({ paths, out = process.stdout }) {
  const t = await wordsFor(paths);
  const page = await observePage(paths);
  if (!page.running) {
    out.write(t("page.not_running") + "\n" + (page.message ? page.message + "\n" : ""));
    return { exitCode: 1, running: false, reason: page.reason };
  }
  // The page's address only: a count printed here was never counted (Fortes 2026-11-09); `status` lists the runs.
  out.write(page.url + "\n");
  return { exitCode: 0, running: true, url: page.url, reason: page.reason };
}
