// The embedded PostgreSQL server that holds Bridge's long-term records (RC3-BLOCKER-01). This file
// only creates, starts, stops and connects to the server; it owns no table.
//
// The binaries come from the @embedded-postgres/<platform> package. Its wrapper is never imported:
// it hooks process exit and would stop the server whenever a Bridge command ends. Starting runs
// `pg_ctl start -w -l <file>` with no console of the terminal's (see runDetaching); what the server said
// is read only when a start fails, to tell a taken port and an old server's leftovers apart. Ready means
// a SQL round trip answers: pg_ctl's own wait can be fooled by the postmaster.pid a killed server left
// behind (measured on Windows: it reported the server ready while the new one was still recovering).
// Stopping is pg_ctl's fast shutdown and waits for it; a running server is never killed, only the
// children a dead one left behind (see clearOldServer). While a server runs, its own postmaster.pid is
// the truth for where it listens; nothing else records the port.
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
import { readDatabasePort } from "./personalSettings.mjs";
import { OldServerError } from "./serverErrors.mjs";

export { OldServerError } from "./serverErrors.mjs";

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

// One server's files: the cluster itself, its password, the server's own daily logs (written by
// PostgreSQL inside the cluster) and pg_ctl's -l file, where the last start's server wrote until its own
// log took over (the name is older than -l; backup leaves it out by that name).
export function clusterPaths(root) {
  const data = path.join(root, "data");
  return {
    root,
    data,
    secret: path.join(root, "secret"),
    logs: path.join(data, "log"),
    control: path.join(root, "pg_ctl.out"),
  };
}

// The server writes its own log, one file per day. What it says before that log is open (a start that
// fails says it there) goes to pg_ctl's -l file, as PostgreSQL's pg_ctl page asks for on Windows. On
// Windows the running server holds that file (cmd.exe opened it for it): a second start finds it held,
// launches nothing, and finds the first one's server running (see startServer).
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

function runTool(file, args, { timeoutMs, env = TOOL_ENV }) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, encoding: "utf8", env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, timedOut: Boolean(error?.killed), stdout, stderr });
    });
  });
}

// `pg_ctl start` leaves the server running, and the server would keep whatever pg_ctl was given. It is
// given nothing of this process: no stdio is inherited and windowsHide is set, the one case where libuv
// adds CREATE_NO_WINDOW (src/win/process.c), so pg_ctl, the cmd.exe it starts the server through and the
// server get a console of their own that has no window. Closing the terminal or VS Code sends its close
// event only to the processes on that terminal's console (Console-Docs handlerroutine), and none of these
// is. `detached` is not used: it gives pg_ctl no console at all, and its cmd.exe then opens a window
// (measured 2026-11-07). The server's words go to the -l file in `args`, PostgreSQL's Windows advice;
// pg_ctl's start code says that file must not be made beforehand, so the last start's file is removed
// first. A file another process holds is reported, not launched over: on Windows the running server, or
// a dead one's children, keep it open. The server works in `cwd` (the cluster's folder), never in the
// folder the command ran in: on Windows a running process holds its working folder, which then could not
// be removed (init's self-test copy, a test's project). `spawnProcess` is a seam for tests.
const HELD = new Set(["EBUSY", "EPERM", "EACCES"]);

export async function runDetaching(file, args, { timeoutMs, logFile, cwd, spawnProcess = spawn }) {
  try {
    await fsp.rm(logFile, { force: true });
  } catch (error) {
    if (HELD.has(error.code)) return { code: 1, held: true, output: "" };
    throw error;
  }
  const code = await new Promise((resolve) => {
    const child = spawnProcess(file, args, { cwd, windowsHide: true, env: TOOL_ENV, stdio: "ignore" });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.once("error", () => { clearTimeout(timer); resolve(1); });
    child.once("exit", (exitCode) => { clearTimeout(timer); resolve(exitCode ?? 1); });
  });
  return { code, held: false, output: await fsp.readFile(logFile, "utf8").catch(() => "") };
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

// The port follows PostgreSQL's own default, the way the local page and Vite pick theirs: every start
// looks from 5432 (or the person's `database.port` in settings.json) and takes the first free port up,
// as far as 65535, with no other limit.
export const DEFAULT_PORT = 5432;

// The first free port from `from` up to 65535, or null when every one is taken.
async function firstFreePort(from) {
  for (let port = from; port <= 65535; port += 1) {
    if (await portFree(port)) return port;
  }
  return null;
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
export async function serverRunning(root, { binaries, tool = runTool }) {
  const status = await tool(binaries.pg_ctl, ["status", "-D", clusterPaths(root).data], { timeoutMs: 30_000 });
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

// A server that died without shutting down (killed, the machine off, its console closed) leaves its
// postmaster.pid, and on Windows its busy children keep running and hold the cluster's shared memory and
// the -l file (measured: a backend in a long query and the log collector stay, their parent the dead
// postmaster). The next start then stops with "pre-existing shared memory block is still in use" and
// PostgreSQL's hint, said in the -l file since the log collector is not up yet
// (src/backend/port/win32_shmem.c; POSIX sysv_shmem.c), or finds the -l file held.
const OLD_SERVER_HINT = /Check if there are any old server processes still running|Terminate any old server processes associated with data directory/;
const STOP_WAIT_MS = 10_000;

async function postmasterPidOf(paths) {
  const text = await fsp.readFile(path.join(paths.data, "postmaster.pid"), "utf8").catch(() => null);
  const pid = Number(text?.split(/\r?\n/)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

// The binary as its path was given and as the file system resolves it: either may be what a process shows.
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
async function binaryPaths(postgres) {
  const resolved = path.resolve(postgres);
  const real = await fsp.realpath(postgres).catch(() => resolved);
  return [...new Set([resolved, real])];
}

// The processes that run this Bridge's postgres binary, each with its parent and whether it is a
// postmaster, from Win32_Process's rows. A postmaster's command line is `"<postgres>" -D "<data>" …`; a
// child's is `"<postgres>" --forkchild="<kind>" <handle>` (launch_backend.c internal_forkexec). The program
// is the executable path, or the command line's first part when the path is empty (measured 2026-11-07 on
// an orphaned io_worker). A process with neither is not counted as Bridge's.
export function windowsServerProcesses(rows, postgresPaths) {
  return [].concat(rows ?? []).flatMap((row) => {
    const line = String(row.CommandLine || "");
    const program = row.ExecutablePath || /^"([^"]+)"/.exec(line)?.[1] || "";
    if (!program || !postgresPaths.some((postgres) => samePath(program, postgres))) return [];
    return [{ pid: Number(row.ProcessId), ppid: Number(row.ParentProcessId), postmaster: !line.includes("--forkchild") }];
  });
}

// The same from `ps -A -o pid=,ppid=,args=`. A postmaster keeps the command line pg_ctl gave it, which
// starts with the binary's path; a child shows its title "postgres: <kind>", and is Bridge's only when
// the program it runs (/proc/<pid>/exe, read by `exeOf`) is the binary. Where that cannot be read (no
// /proc), the child is not counted: what cannot be told to be Bridge's is not stopped.
export async function posixServerProcesses(text, postgresPaths, exeOf) {
  const found = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [pid, ppid, args] = [Number(match[1]), Number(match[2]), match[3]];
    if (postgresPaths.some((postgres) => args === postgres || args.startsWith(postgres + " "))) found.push({ pid, ppid, postmaster: true });
    else if (args.startsWith("postgres: ") && postgresPaths.includes(await exeOf(pid))) found.push({ pid, ppid, postmaster: false });
  }
  return found;
}

// The processes of this binary whose parent is `parent`, from the operating system. Only called with the
// pid a dead server's postmaster.pid names. On Windows the query asks Win32_Process for that parent's
// children only (Get-CimInstance -Filter); elsewhere `ps` lists all and the parent is matched here.
export async function serverProcesses(binaries, parent) {
  const postgresPaths = await binaryPaths(binaries.postgres);
  if (process.platform === "win32") {
    const listed = await runTool("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter ('ParentProcessId = ' + [int]$env:BRIDGE_PARENT)"
      + " | Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine | ConvertTo-Json -Compress"],
    { timeoutMs: 30_000, env: { ...TOOL_ENV, BRIDGE_PARENT: String(parent) } });
    if (listed.code !== 0) throw new Error("the old server's processes could not be listed: " + lastLines(listed.stderr || listed.stdout));
    return windowsServerProcesses(listed.stdout.trim() ? JSON.parse(listed.stdout) : [], postgresPaths);
  }
  const listed = await runTool("ps", ["-A", "-o", "pid=,ppid=,args="], { timeoutMs: 30_000 });
  if (listed.code !== 0) throw new Error("the old server's processes could not be listed: " + lastLines(listed.stderr || listed.stdout));
  const found = await posixServerProcesses(listed.stdout, postgresPaths, (pid) => fsp.readlink("/proc/" + pid + "/exe").catch(() => null));
  return found.filter((entry) => entry.ppid === parent);
}

// The program a live process runs, or null when it cannot be read. Postgres.app reads it with macOS's
// proc_pidpath; here Win32_Process's ExecutablePath (or its command line's program), Linux's
// /proc/<pid>/exe, and `ps -o comm=` elsewhere.
export async function programOf(pid) {
  if (process.platform === "win32") {
    const listed = await runTool("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$env:BRIDGE_PID)"
      + " | Select-Object ExecutablePath, CommandLine | ConvertTo-Json -Compress"],
    { timeoutMs: 30_000, env: { ...TOOL_ENV, BRIDGE_PID: String(pid) } });
    if (listed.code !== 0 || !listed.stdout.trim()) return null;
    const row = JSON.parse(listed.stdout);
    const line = String(row.CommandLine || "").trim();
    return row.ExecutablePath || /^"([^"]+)"/.exec(line)?.[1] || line.split(/\s+/)[0] || null;
  }
  if (process.platform === "linux") return fsp.readlink("/proc/" + pid + "/exe").catch(() => null);
  const listed = await runTool("ps", ["-o", "comm=", "-p", String(pid)], { timeoutMs: 30_000 });
  return listed.code === 0 ? listed.stdout.trim() || null : null;
}

// Postgres.app's test: the program's name ends in postgres or postmaster (hasSuffix), here also with .exe.
export const isPostgresProgram = (program) => /(postgres|postmaster)(\.exe)?$/i.test(String(program).trim());

// What a dead server left (Owner 2026-11-04): the processes of this binary whose parent is the postmaster
// its postmaster.pid names. Nothing is looked for across folders by binary: zonky's embedded-postgres,
// PostgreSQL and docker compose down each act only on their own data folder's or project's identity
// (ECOSYSTEM-REFERENCES E). A child whose parent is no longer that pid (a POSIX child is re-parented when
// its postmaster dies) is not stopped; PostgreSQL's hint and Bridge's sentence leave it to the person.
export function leftoverProcesses(processes, postmaster) {
  return processes.filter((entry) => !entry.postmaster && entry.ppid === postmaster);
}

// Clears what a server that is gone left in this cluster, on `down` only (as docker compose down stops
// what its project started; a start clears nothing). A server that is running is never touched.
// Without a postmaster.pid nothing is listed: PostgreSQL removes it as the last thing a clean shutdown
// does (miscinit.c UnlinkLockFiles), and on Windows a start that met a dead server's leftovers replaced
// it with its own and took that with it (win32_shmem.c writes no shmem key, so CreateLockFile unlinks
// the old file first), so no parent is left to match. When the pid file's number is alive, what runs
// under it decides, as Postgres.app's updateServerStatus and startSync do (Server.swift, issue #573):
// Bridge's own postgres binary is stopped the way a running server is, with pg_ctl's fast shutdown,
// waited for and never killed; another postgres is left alone and said; any other program means the
// number was reused and the pid file is a dead server's, so it is removed; a program that cannot be
// read is left alone. When the number is gone, the dead postmaster's own children are
// stopped (Owner 2026-11-04), since pg_ctl cannot reach them. `tool`, `processes`, `alive`, `signal`
// and `program` are seams for tests.
export async function clearOldServer(root, {
  binaries, tool = runTool, processes = serverProcesses, alive = processAlive, signal = (pid) => process.kill(pid),
  program = programOf,
}) {
  const paths = clusterPaths(root);
  if (await serverRunning(root, { binaries, tool })) return { cleared: "nothing", stopped: [] };
  const pid = await postmasterPidOf(paths);
  if (pid === null) return { cleared: "nothing", stopped: [] };
  if (alive(pid)) {
    const running = await program(pid);
    if (!running) return { cleared: "nothing", stopped: [] };
    const ours = (await binaryPaths(binaries.postgres)).some((postgres) => samePath(running, postgres));
    // Another PostgreSQL took the number (Postgres.app's DataDirInUse): pg_ctl stop would signal it, and
    // its pid file is not this one's to judge, so nothing is stopped or removed.
    if (!ours && isPostgresProgram(running)) return { cleared: "in_use", stopped: [], pid };
    if (!ours) {
      await fsp.rm(path.join(paths.data, "postmaster.pid"));
      return { cleared: "pid_file", stopped: [] };
    }
    const result = await tool(binaries.pg_ctl, ["stop", "-D", paths.data, "-m", "fast", "-w", "-t", "60"], { timeoutMs: 90_000 });
    if (alive(pid)) throw new Error("PostgreSQL did not stop within 60s; it was not killed: " + lastLines(result.stderr || result.stdout));
    return { cleared: "pg_ctl", stopped: [] };
  }
  const old = leftoverProcesses(await processes(binaries, pid), pid);
  // No child of that number is left: nothing was cleared, and `down` must not say it was. The pid file
  // stays for the next start, which removes a dead server's itself.
  if (!old.length) return { cleared: "nothing", stopped: [] };
  for (const { pid: child } of old) { try { signal(child); } catch {} }
  const deadline = Date.now() + STOP_WAIT_MS;
  while (old.some((entry) => alive(entry.pid)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  return { cleared: "processes", stopped: old.map((entry) => entry.pid) };
}

// What the server itself said when it stopped: its FATAL, ERROR, DETAIL and HINT lines.
const serverWords = (text) => String(text || "").split(/\r?\n/).filter((line) => /\b(PANIC|FATAL|ERROR|DETAIL|HINT):/.test(line)).slice(-4).join(" | ");

// Starts the server, or finds it already running (another Bridge command may have started it, or
// won a race to start it). The server takes the first free port from the start port up. Either way
// the start counts only once a SQL round trip answers, within the timeout. Nothing is cleared before
// it, as PostgreSQL and Postgres.app do: PostgreSQL removes a dead server's postmaster.pid itself
// (miscinit.c CreateLockFile), and a start that meets processes a dead server left (its hint, or the
// -l file held) is told to the person and not cleared (OldServerError; Owner 2026-11-08).
// `tool`, `detached` and `ready` are seams for tests.
export async function startServer(root, {
  binaries, timeoutSeconds = 60, tool = runTool, detached = runDetaching, ready = waitUntilReady,
}) {
  const paths = clusterPaths(root);
  const deadline = Date.now() + timeoutSeconds * 1000;
  try {
    await fsp.access(path.join(paths.data, "PG_VERSION"));
  } catch {
    throw new Error("There is no PostgreSQL cluster at " + paths.data + "; create it first.");
  }
  // Whether this call is the one that launched the server is not reported: when several start at
  // once, every pg_ctl that waited sees the winner's server ready and exits 0 (measured on Windows).
  // A port found free can be taken by another process before the server binds it; the server then
  // stops at once with "could not create any TCP/IP sockets", and the search goes on from the next
  // port up, as many times as that happens. The cluster's root is the postgres folder of the data
  // home, beside the person's settings.json.
  const start = (await readDatabasePort({ dataHome: path.dirname(root) })) ?? DEFAULT_PORT;
  let from = start;
  while (!(await serverRunning(root, { binaries, tool }))) {
    const port = await firstFreePort(from);
    if (port === null) throw new Error("PostgreSQL's ports from " + start + " up to 65535 are all taken.");
    const began = Date.now();
    const result = await detached(binaries.pg_ctl, [
      "start", "-D", paths.data, "-l", paths.control, "-w", "-t", String(timeoutSeconds),
      "-o", "-h " + LISTEN_HOST + " -p " + port,
    ], { timeoutMs: (timeoutSeconds + 30) * 1000, logFile: paths.control, cwd: paths.root });
    if (result.code === 0 || (await serverRunning(root, { binaries, tool }))) break;
    const latest = (await serverLogFiles(root)).at(-1);
    const log = latest ? await fsp.readFile(latest, "utf8").catch(() => "") : "";
    const said = result.output + "\n" + log.split(/\r?\n/).slice(-5).join("\n");
    if (!result.held && /could not create any TCP\/IP sockets/.test(said)) {
      from = port + 1;
      continue;
    }
    if (result.held || OLD_SERVER_HINT.test(said)) throw new OldServerError(paths.control, serverWords(said));
    // Said as it was: how long pg_ctl waited (a server that dies at once is not a timeout) and the server's
    // last lines as written. The log collector writes a dying server's last words after it is gone and
    // exits last (syslogger.c, "we'll ignore postmaster death"), so they may not be in the file yet; the
    // folder is named for them.
    const waited = Math.round((Date.now() - began) / 1000);
    throw new Error("PostgreSQL did not start: pg_ctl gave up after " + waited + "s (it waits up to " + timeoutSeconds + "s). It said: "
      + (lastLines(said, 8) || "nothing; pg_ctl exited " + result.code + "."));
  }
  await ready(root, deadline);
  return { port: await runningPort(paths) };
}

// What makes this data home's data directory unusable, as pg_ctl status finds it before it looks for a
// server (pg_ctl.c get_pgpid, REL_18_STABLE 246-273, exit 4): a directory that does not exist or cannot
// be read, or one without PG_VERSION, which is no database cluster directory. Null when it is usable.
export async function dataDirectoryProblem(root) {
  const { data } = clusterPaths(root);
  try {
    await fsp.stat(data);
  } catch (error) {
    return error.code === "ENOENT" ? { problem: "missing", path: data } : { problem: "unreadable", path: data, code: error.code || "error" };
  }
  const version = await fsp.stat(path.join(data, "PG_VERSION")).then(() => null, (error) => error);
  return version?.code === "ENOENT" ? { problem: "not_cluster", path: data } : null;
}

// Whether this data home's server is running, without starting it: no cluster is a server not running.
export async function serverState(root, { binaries, tool = runTool }) {
  if (!(await isCluster(clusterPaths(root)))) return { running: false, cluster: false };
  return { running: await serverRunning(root, { binaries, tool }), cluster: true };
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
