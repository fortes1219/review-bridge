// The embedded PostgreSQL server that holds Bridge's long-term records (RC3-BLOCKER-01). This file
// only creates, starts, stops and connects to the server; it owns no table.
//
// The binaries come from the @embedded-postgres/<platform> package. Its wrapper is never imported:
// it hooks process exit and would stop the server whenever a Bridge command ends. Starting runs
// `pg_ctl start -w` and never reads log text. Ready means a SQL round trip answers: pg_ctl's own wait
// can be fooled by the postmaster.pid a killed server left behind (measured on Windows: it reported
// the server ready while the new one was still recovering). Stopping is pg_ctl's fast shutdown and
// waits for it; the server is never killed. While a server runs, its own postmaster.pid is the truth
// for where it listens.
//
// Not exported from service/index.mjs: every command imports that index, and only the commands that
// keep records load pg and the server binaries (through database/index.mjs).
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import pg from "pg";

export { bridgeDataHome } from "./dataHome.mjs";
import { postgresPackageName } from "./platformPackages.mjs";

export const SERVER_USER = "bridge";
const LISTEN_HOST = "127.0.0.1";

// The three server binaries for this machine. A platform with no package is refused by name.
export async function postgresBinaries({ platform = process.platform, arch = process.arch } = {}) {
  const name = postgresPackageName({ platform, arch });
  if (!name) throw new Error("No PostgreSQL binaries are packaged for " + platform + "-" + arch + ".");
  let binaries;
  try {
    binaries = await import(name);
  } catch (error) {
    throw new Error("The PostgreSQL binaries for " + platform + "-" + arch + " are not installed (" + name + "): " + error.message);
  }
  return Object.freeze({ initdb: binaries.initdb, pg_ctl: binaries.pg_ctl, postgres: binaries.postgres });
}

// One server's files: the cluster itself, its password, its last chosen port, the server's own daily
// logs (written by PostgreSQL inside the cluster) and the words of the last pg_ctl call.
export function clusterPaths(root) {
  const data = path.join(root, "data");
  return {
    root,
    data,
    secret: path.join(root, "secret"),
    settings: path.join(root, "server.json"),
    logs: path.join(data, "log"),
    control: path.join(root, "pg_ctl.out"),
  };
}

// The server writes its own log, one file per day. pg_ctl is not given a log file: on Windows it
// opens one through cmd.exe, and a second start then fails to open the file the running server holds
// before it even tries, so two starts at once could both fail. Without it, both launch a server and
// PostgreSQL's own lock file lets exactly one through.
const SERVER_SETTINGS = [
  "",
  "# Set by Review Bridge when the cluster was created.",
  "logging_collector = on",
  "log_directory = 'log'",
  "log_filename = 'server-%Y-%m-%d.log'",
  "log_rotation_age = 1d",
  "log_rotation_size = 0",
  "lc_messages = 'C'",
  "",
].join("\n");
const SERVER_LOG = /^server-\d{4}-\d{2}-\d{2}\.log$/;

// The server's logs, oldest day first.
export async function serverLogFiles(root) {
  const { logs } = clusterPaths(root);
  const names = await fsp.readdir(logs).catch(() => []);
  return names.filter((name) => SERVER_LOG.test(name)).sort().map((name) => path.join(logs, name));
}

// The tools speak English whatever the machine's language, so their words can be kept as evidence.
const TOOL_ENV = Object.freeze({ ...process.env, LC_ALL: "C", LC_MESSAGES: "C", LANG: "C" });

function runTool(file, args, { timeoutMs }) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, encoding: "utf8", env: TOOL_ENV }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, timedOut: Boolean(error?.killed), stdout, stderr });
    });
  });
}

// `pg_ctl start` leaves the server running, and the server inherits pg_ctl's output handles. With
// pipes, the call would wait until the server closed them (measured on Windows: 90 s instead of
// 0.3 s). The output goes to a file instead, so the call ends with pg_ctl and its words are kept.
// The server it leaves running works in `cwd` (the cluster's folder), never in the folder the
// command ran in: on Windows a running process holds its working folder, which then could not be
// removed (init's self-test copy, a test's project).
async function runDetaching(file, args, { timeoutMs, outputFile, cwd }) {
  const output = await fsp.open(outputFile, "w");
  try {
    const code = await new Promise((resolve) => {
      const child = spawn(file, args, { cwd, windowsHide: true, env: TOOL_ENV, stdio: ["ignore", output.fd, output.fd] });
      const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
      child.once("error", () => { clearTimeout(timer); resolve(1); });
      child.once("exit", (exitCode) => { clearTimeout(timer); resolve(exitCode ?? 1); });
    });
    return { code, stdout: await fsp.readFile(outputFile, "utf8").catch(() => ""), stderr: "" };
  } finally {
    await output.close();
  }
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.once("error", reject).listen(0, LISTEN_HOST, resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function portFree(port) {
  const probe = net.createServer();
  const free = await new Promise((resolve) => {
    probe.once("error", () => resolve(false));
    probe.listen(port, LISTEN_HOST, () => resolve(true));
  });
  if (free) await new Promise((resolve) => probe.close(resolve));
  return free;
}

async function readSettings(paths) {
  return JSON.parse(await fsp.readFile(paths.settings, "utf8"));
}

async function writeSettings(paths, settings) {
  const temporary = paths.settings + ".tmp-" + process.pid;
  await fsp.writeFile(temporary, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  await fsp.rename(temporary, paths.settings);
}

const lastLines = (text, count = 5) => String(text || "").trim().split(/\r?\n/).slice(-count).join(" | ");

const isCluster = (paths) => fsp.access(path.join(paths.data, "PG_VERSION")).then(() => true, () => false);

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

// A cluster is built beside its root, in a folder named after the building process, and becomes the
// root in one rename. A process that died while building leaves only such a folder, never a root that
// looks finished; it is removed once its process is gone.
const BUILDING = ".creating-";

async function removeAbandonedBuilds(root) {
  const prefix = path.basename(root) + BUILDING;
  const entries = await fsp.readdir(path.dirname(root)).catch(() => []);
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const pid = Number(name.slice(prefix.length).split("-")[0]);
    if (Number.isInteger(pid) && pid > 0 && !processAlive(pid)) await fsp.rm(path.join(path.dirname(root), name), { recursive: true, force: true });
  }
}

async function buildCluster(building, { binaries }) {
  const paths = clusterPaths(building);
  await fsp.mkdir(building);
  const password = randomBytes(24).toString("hex");
  const pwfile = path.join(building, "initdb-password.tmp");
  await fsp.writeFile(pwfile, password + "\n", { mode: 0o600 });
  try {
    const made = await runTool(binaries.initdb, [
      "-D", paths.data, "-U", SERVER_USER, "--pwfile", pwfile, "--auth=scram-sha-256", "--encoding=UTF8", "--locale=C",
    ], { timeoutMs: 120_000 });
    if (made.code !== 0) throw new Error("initdb failed: " + lastLines(made.stderr || made.stdout));
  } finally {
    await fsp.rm(pwfile, { force: true });
  }
  await fsp.appendFile(path.join(paths.data, "postgresql.conf"), SERVER_SETTINGS);
  await fsp.writeFile(paths.secret, password + "\n", { mode: 0o600 });
  await writeSettings(paths, { port: await freePort() });
}

// Creates the cluster once. A missing or empty root is built; a root that holds anything but a
// cluster is refused untouched. The password is random, kept beside the cluster with owner-only
// permissions, and the server only accepts SCRAM logins. When several processes create the same
// cluster at once, each builds its own and the first rename wins; the others use the winner's.
export async function ensureCluster(root, { binaries }) {
  const paths = clusterPaths(root);
  await removeAbandonedBuilds(root);
  if (await isCluster(paths)) return { created: false, paths };
  // A root that is found holding something may have just been published by another process (the
  // rename makes it whole at once), so it is looked at again before it is called someone else's.
  const occupied = async () => {
    if (await isCluster(paths)) return { created: false, paths };
    throw new Error("The folder " + root + " holds files but no PostgreSQL cluster; Bridge will not touch it.");
  };
  const entries = await fsp.readdir(root).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
  if (entries.length) return occupied();
  await fsp.mkdir(path.dirname(root), { recursive: true });
  const building = root + BUILDING + process.pid + "-" + randomBytes(6).toString("hex");
  try {
    await buildCluster(building, { binaries });
    for (let attempt = 0; ; attempt += 1) {
      // A folder is not renamed over another on Windows, even an empty one, so an empty root goes
      // first. rmdir refuses a root that is no longer empty, which leaves the winner alone.
      await fsp.rmdir(root).catch(() => {});
      try {
        await fsp.rename(building, root);
        return { created: true, paths };
      } catch (error) {
        const now = await fsp.readdir(root).catch(() => []);
        if (now.length) return occupied();
        // Nothing is at the root, yet the rename failed: on Windows a scanner can hold a new file
        // for a moment. Anything else, or a hold that does not let go, is reported.
        if (attempt >= 10 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  } finally {
    await fsp.rm(building, { recursive: true, force: true });
  }
}

// Running means pg_ctl finds a live server for this data folder (exit 0); 3 is "not running".
export async function serverRunning(root, { binaries }) {
  const status = await runTool(binaries.pg_ctl, ["status", "-D", clusterPaths(root).data], { timeoutMs: 30_000 });
  if (status.code === 0) return true;
  if (status.code === 3) return false;
  throw new Error("pg_ctl status failed: " + lastLines(status.stderr || status.stdout));
}

// Where a running server listens, from its own postmaster.pid (the fourth line is the port).
async function runningPort(paths) {
  const lines = (await fsp.readFile(path.join(paths.data, "postmaster.pid"), "utf8")).split(/\r?\n/);
  const port = Number(lines[3]);
  if (!Number.isInteger(port) || port <= 0) throw new Error("The running server's postmaster.pid has no port.");
  return port;
}

export async function connectionSettings(root, { database = "postgres" } = {}) {
  const paths = clusterPaths(root);
  return {
    host: LISTEN_HOST,
    port: await runningPort(paths),
    user: SERVER_USER,
    password: (await fsp.readFile(paths.secret, "utf8")).trim(),
    database,
  };
}

export async function connect(root, options) {
  const client = new pg.Client(await connectionSettings(root, options));
  await client.connect();
  return client;
}

// A server that is starting, recovering or not yet listening answers with one of these; anything
// else is a real failure and is not waited out.
const NOT_YET = new Set(["ECONNREFUSED", "ECONNRESET", "ENOENT", "57P03"]);
const notYet = (error) => NOT_YET.has(error?.code) || /postmaster\.pid has no port/.test(String(error?.message));

// The deadline bounds every attempt, including a connection or a query that never answers: when it
// passes, the attempt's socket is closed. The server itself is left as it is.
async function waitUntilReady(root, deadline) {
  let last = null;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("PostgreSQL did not become ready in time: " + (last?.message || "no answer"));
    let client = null;
    let timer = null;
    let outOfTime = false;
    try {
      client = new pg.Client(await connectionSettings(root));
      // A socket cut after the login is also reported as an event; the awaited calls below carry it.
      client.on("error", () => {});
      timer = setTimeout(() => { outOfTime = true; client.connection.stream.destroy(); }, remaining);
      await client.connect();
      await client.query("select 1");
      clearTimeout(timer);
      await client.end();
      return;
    } catch (error) {
      clearTimeout(timer);
      client?.connection.stream.destroy();
      if (!outOfTime && !notYet(error)) throw error;
      last = outOfTime ? new Error("no answer within the deadline") : error;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(200, deadline - Date.now()))));
  }
}

// Starts the server, or finds it already running (another Bridge command may have started it, or
// won a race to start it). The last port is reused when free; otherwise a free one is taken and
// remembered. Either way the start counts only once a SQL round trip answers, within the timeout.
export async function startServer(root, { binaries, timeoutSeconds = 60 }) {
  const paths = clusterPaths(root);
  const deadline = Date.now() + timeoutSeconds * 1000;
  try {
    await fsp.access(path.join(paths.data, "PG_VERSION"));
  } catch {
    throw new Error("There is no PostgreSQL cluster at " + paths.data + "; create it first.");
  }
  // Whether this call is the one that launched the server is not reported: when several start at
  // once, every pg_ctl that waited sees the winner's server ready and exits 0 (measured on Windows).
  if (!(await serverRunning(root, { binaries }))) {
    let settings = await readSettings(paths);
    if (!(await portFree(settings.port))) {
      settings = { ...settings, port: await freePort() };
      await writeSettings(paths, settings);
    }
    const result = await runDetaching(binaries.pg_ctl, [
      "start", "-D", paths.data, "-w", "-t", String(timeoutSeconds),
      "-o", "-h " + LISTEN_HOST + " -p " + settings.port,
    ], { timeoutMs: (timeoutSeconds + 30) * 1000, outputFile: paths.control, cwd: paths.root });
    if (result.code !== 0 && !(await serverRunning(root, { binaries }))) {
      const latest = (await serverLogFiles(root)).at(-1);
      const log = latest ? await fsp.readFile(latest, "utf8").catch(() => "") : "";
      throw new Error("PostgreSQL did not start within " + timeoutSeconds + "s: " + lastLines(result.stderr || result.stdout) + " | log: " + lastLines(log, 3));
    }
  }
  await waitUntilReady(root, deadline);
  return { port: await runningPort(paths) };
}

// A fast shutdown that is waited for: sessions are ended, the cluster is checkpointed and closed
// cleanly. A server that does not stop in time is reported, never killed.
export async function stopServer(root, { binaries, timeoutSeconds = 60 }) {
  if (!(await serverRunning(root, { binaries }))) return { stopped: false, reason: "not_running" };
  const result = await runTool(binaries.pg_ctl, ["stop", "-D", clusterPaths(root).data, "-m", "fast", "-w", "-t", String(timeoutSeconds)], {
    timeoutMs: (timeoutSeconds + 30) * 1000,
  });
  if (await serverRunning(root, { binaries })) {
    throw new Error("PostgreSQL did not stop within " + timeoutSeconds + "s; it was not killed: " + lastLines(result.stderr || result.stdout));
  }
  return { stopped: true, reason: "stopped" };
}
