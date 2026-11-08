import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { downService } from "../features/setupCheck/commands.mjs";
import { statusOverview } from "../features/workOrder/commands.mjs";
import { createTranslator } from "../features/workOrder/i18n.mjs";
import { stopDatabase } from "../service/database/index.mjs";
import {
  clearOldServer, clusterPaths, isPostgresProgram, leftoverProcesses, OldServerError, posixServerProcesses, runDetaching, startServer,
  windowsServerProcesses,
} from "../service/database/postgresServer.mjs";
import { failureLine } from "../service/database/serverErrors.mjs";

// RC3-DOWN-01. No server is started, no process is listed and no signal is sent: pg_ctl, the process list,
// liveness and signals are all made up through the seams (Owner 2026-11-04: tests on the Owner's machine
// never enumerate real processes). Only files in the test's own temporary folder are real.
const HINT = "FATAL:  pre-existing shared memory block is still in use\nHINT:  Check if there are any old server processes still running, and terminate them.\n";
const DEAD_POSTMASTER = 900_001;
const ORPHAN = 900_002;
const LIVE_POSTMASTER = 900_003;
const LIVE_CHILD = 900_004;
const OTHER_FOLDER_ORPHAN = 900_005;
const OTHER_DEAD_POSTMASTER = 900_006;
const NEW_POSTMASTER = 900_010;

async function cluster(t, { pid = null, said = null } = {}) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-down-"));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const root = path.join(home, "postgres");
  const paths = clusterPaths(root);
  await fsp.mkdir(paths.data, { recursive: true });
  await fsp.writeFile(path.join(paths.data, "PG_VERSION"), "18\n");
  if (pid !== null) await fsp.writeFile(path.join(paths.data, "postmaster.pid"), pid + "\n" + paths.data + "\n0\n5432\n");
  if (said !== null) await fsp.writeFile(paths.control, said);
  return { home, root, paths };
}

// The seams of a server that is not running. `alive` lists the pids that are; a signalled pid is gone,
// and so is the pid file's number once pg_ctl stop answers, unless `stopWorks` is false. `running` is
// the program the pid file's number runs.
function seams({ root, live = [], listing = null, starts = [], running = null, stopWorks = true } = {}) {
  const calls = { tool: [], listed: 0, parents: [], signals: [], starts: [], ready: 0, programs: [] };
  const paths = clusterPaths(root);
  return {
    calls,
    binaries: { pg_ctl: "fake-pg_ctl", postgres: "fake-postgres" },
    tool: async (file, args) => {
      calls.tool.push(args[0]);
      if (args[0] === "stop" && stopWorks) calls.signals.push(DEAD_POSTMASTER);
      return { code: args[0] === "stop" ? 0 : 3, stdout: "", stderr: "" };
    },
    program: async (pid) => { calls.programs.push(pid); return running; },
    // Everything of this binary on the machine; clearOldServer keeps only the pid file's children.
    processes: async (binaries, parent) => {
      calls.listed += 1;
      calls.parents.push(parent);
      return listing ?? [
        { pid: ORPHAN, ppid: DEAD_POSTMASTER, postmaster: false },
        { pid: OTHER_FOLDER_ORPHAN, ppid: OTHER_DEAD_POSTMASTER, postmaster: false },
        { pid: LIVE_POSTMASTER, ppid: 1, postmaster: true },
        { pid: LIVE_CHILD, ppid: LIVE_POSTMASTER, postmaster: false },
      ];
    },
    alive: (pid) => live.includes(pid) && !calls.signals.includes(pid),
    signal: (pid) => { calls.signals.push(pid); },
    // Each start answers in turn: "hint" fails as a server's leftovers make it fail (taking the pid file
    // with it), "held" finds the -l file held, "ok" writes the new server's pid file.
    detached: async (file, args, options) => {
      const outcome = starts[calls.starts.length] ?? "ok";
      calls.starts.push({ args, options });
      await fsp.rm(path.join(paths.data, "postmaster.pid"), { force: true });
      if (outcome === "hint") return { code: 1, held: false, output: HINT };
      if (outcome === "held") return { code: 1, held: true, output: "" };
      await fsp.writeFile(path.join(paths.data, "postmaster.pid"), NEW_POSTMASTER + "\n" + paths.data + "\n0\n" + /-p (\d+)/.exec(args.at(-1))[1] + "\n");
      return { code: 0, held: false, output: "" };
    },
    ready: async () => { calls.ready += 1; },
  };
}

test("pg_ctl start inherits no stdio, has windowsHide, writes to its -l file, and last start's file is removed first, not made", async (t) => {
  const { root, paths } = await cluster(t, { said: "the last start's words\n" });
  const fake = seams({ root });
  let seen = null;
  const spawnProcess = (file, args, options) => {
    seen = { file, args, options, logFileThere: null };
    const child = new EventEmitter();
    child.kill = () => {};
    fsp.access(paths.control).then(() => true, () => false).then(async (there) => {
      seen.logFileThere = there;
      await fsp.writeFile(path.join(paths.data, "postmaster.pid"), NEW_POSTMASTER + "\n" + paths.data + "\n0\n" + /-p (\d+)/.exec(args.at(-1))[1] + "\n");
      child.emit("exit", 0);
    });
    return child;
  };
  await startServer(root, { ...fake, detached: (file, args, options) => runDetaching(file, args, { ...options, spawnProcess }) });
  assert.equal(seen.file, "fake-pg_ctl");
  assert.equal(seen.options.stdio, "ignore", "no stdio of this process is given to pg_ctl");
  assert.equal(seen.options.windowsHide, true);
  assert.ok(!seen.options.detached, "detached opens a console for cmd.exe (2026-11-07)");
  assert.equal(seen.options.cwd, paths.root);
  assert.equal(seen.args[seen.args.indexOf("-l") + 1], paths.control);
  assert.equal(seen.logFileThere, false, "the -l file is removed before pg_ctl runs and not made for it");
});

test("without a postmaster.pid nothing is listed or stopped, even when the last start said the hint", async (t) => {
  for (const said of [null, HINT]) {
    const { root } = await cluster(t, { said });
    const fake = seams({ root, live: [ORPHAN, OTHER_FOLDER_ORPHAN] });
    assert.deepEqual(await clearOldServer(root, fake), { cleared: "nothing", stopped: [] });
    assert.deepEqual([fake.calls.listed, fake.calls.signals, fake.calls.tool], [0, [], ["status"]]);
  }
});

// The seams' binaries name "fake-postgres"; this is how a process running it shows its program.
const OURS = path.resolve("fake-postgres");

test("the pid file's number alive and running Bridge's own postgres: stopped as a running server is, never listed or killed", async (t) => {
  for (const running of [OURS, OURS.toUpperCase()]) {
    const { root } = await cluster(t, { pid: DEAD_POSTMASTER });
    const fake = seams({ root, live: [DEAD_POSTMASTER, ORPHAN], running });
    assert.equal((await clearOldServer(root, fake)).cleared, "pg_ctl");
    assert.deepEqual([fake.calls.tool, fake.calls.programs, fake.calls.listed], [["status", "stop"], [DEAD_POSTMASTER], 0]);
  }
  const { root } = await cluster(t, { pid: DEAD_POSTMASTER });
  const fake = seams({ root, live: [DEAD_POSTMASTER], running: OURS, stopWorks: false });
  await assert.rejects(clearOldServer(root, fake), /did not stop within 60s; it was not killed/);
});

test("the pid file's number alive and running another PostgreSQL: not stopped, the pid file not removed, and said (Postgres.app's DataDirInUse)", async (t) => {
  for (const running of ["C:\\Program Files\\PostgreSQL\\18\\bin\\postgres.exe", "/usr/lib/postgresql/18/bin/postgres"]) {
    const { root, paths } = await cluster(t, { pid: DEAD_POSTMASTER });
    const fake = seams({ root, live: [DEAD_POSTMASTER, ORPHAN], running });
    assert.deepEqual(await clearOldServer(root, fake), { cleared: "in_use", stopped: [], pid: DEAD_POSTMASTER });
    assert.ok(await fsp.stat(path.join(paths.data, "postmaster.pid")), "its pid file stays");
    assert.deepEqual([fake.calls.tool, fake.calls.listed, fake.calls.signals], [["status"], 0, []], "no pg_ctl stop, no listing, no signal");
  }
});

test("the pid file's number alive but running another program: the number was reused, so only the pid file is removed (Postgres.app)", async (t) => {
  const { root, paths } = await cluster(t, { pid: DEAD_POSTMASTER });
  const fake = seams({ root, live: [DEAD_POSTMASTER, ORPHAN], running: "C:\\Windows\\System32\\notepad.exe" });
  assert.deepEqual(await clearOldServer(root, fake), { cleared: "pid_file", stopped: [] });
  assert.equal(await fsp.stat(path.join(paths.data, "postmaster.pid")).catch(() => null), null);
  assert.deepEqual([fake.calls.tool, fake.calls.listed, fake.calls.signals], [["status"], 0, []]);
});

test("the pid file's number alive but its program unreadable: nothing is touched", async (t) => {
  const { root, paths } = await cluster(t, { pid: DEAD_POSTMASTER });
  const fake = seams({ root, live: [DEAD_POSTMASTER, ORPHAN], running: null });
  assert.deepEqual(await clearOldServer(root, fake), { cleared: "nothing", stopped: [] });
  assert.ok(await fsp.stat(path.join(paths.data, "postmaster.pid")));
  assert.deepEqual([fake.calls.tool, fake.calls.listed, fake.calls.signals], [["status"], 0, []]);
});

test("a program is a postgres when its name ends in postgres or postmaster, as Postgres.app tests it", () => {
  for (const yes of ["C:\\Bridge\\bin\\postgres.exe", "C:\\BRIDGE\\BIN\\POSTGRES.EXE", "/opt/bridge/bin/postgres", "/usr/lib/postgresql/18/bin/postmaster"]) assert.equal(isPostgresProgram(yes), true, yes);
  for (const no of ["C:\\Windows\\System32\\notepad.exe", "/usr/bin/node", "/opt/postgres-helper"]) assert.equal(isPostgresProgram(no), false, no);
});

test("only the pid file's postmaster's children are stopped: not another folder's orphan, not a running server's child", async (t) => {
  const { root } = await cluster(t, { pid: DEAD_POSTMASTER });
  const fake = seams({ root, live: [ORPHAN, OTHER_FOLDER_ORPHAN, LIVE_POSTMASTER, LIVE_CHILD] });
  assert.deepEqual(await clearOldServer(root, fake), { cleared: "processes", stopped: [ORPHAN] });
  assert.deepEqual(fake.calls.parents, [DEAD_POSTMASTER], "the listing is asked for that parent's children");
  assert.deepEqual(fake.calls.signals, [ORPHAN]);
  assert.deepEqual(leftoverProcesses([
    { pid: 1, ppid: 0, postmaster: true }, { pid: 2, ppid: 1, postmaster: false }, { pid: 3, ppid: 99, postmaster: false }, { pid: 4, ppid: 99, postmaster: true },
  ], 99).map((entry) => entry.pid), [3]);
});

test("a start clears nothing: with a dead server's pid file it lists no process, signals none and starts once", async (t) => {
  const { root } = await cluster(t, { pid: DEAD_POSTMASTER });
  const fake = seams({ root, live: [ORPHAN] });
  await startServer(root, fake);
  assert.deepEqual([fake.calls.listed, fake.calls.signals, fake.calls.tool.filter((action) => action === "stop"), fake.calls.starts.length], [0, [], [], 1]);
});

test("a start that meets a dead server's leftovers is not cleared or started again: it ends with the sentence in the project's language", async (t) => {
  for (const first of ["hint", "held"]) {
    const { root, paths } = await cluster(t, { pid: DEAD_POSTMASTER });
    const fake = seams({ root, live: [ORPHAN], starts: [first, "ok"] });
    const error = await startServer(root, fake).then(() => null, (failure) => failure);
    assert.ok(error instanceof OldServerError, first + ": " + error?.message);
    assert.equal(fake.calls.starts.length, 1, "no second start");
    assert.deepEqual([fake.calls.listed, fake.calls.signals], [0, []], "PostgreSQL and Postgres.app tell the person and stop nothing");
    assert.equal(error.logFile, paths.control);
    const zh = failureLine(error, await createTranslator("zh-TW"));
    assert.match(zh, /^資料庫上次沒有正常關閉，還有它留下的程序在跑，Bridge 無法安全地清掉；請重開機後再執行一次。細節在 /);
    assert.ok(zh.includes(paths.control), "the details stay in pg_ctl's file, which the sentence names");
    assert.match(failureLine(error, await createTranslator("en")), /^The database was not shut down properly last time, .*Restart the computer and run this again\. Details are in /);
  }
});

test("Windows rows: only this binary's processes, by path or by the command line's program, and --forkchild marks a child", () => {
  const postgres = "C:\\Bridge\\native\\bin\\postgres.exe";
  const rows = windowsServerProcesses([
    { ProcessId: 10, ParentProcessId: 4, ExecutablePath: postgres, CommandLine: "\"" + postgres + "\" -D \"C:\\data\" -p 5432" },
    { ProcessId: 11, ParentProcessId: 10, ExecutablePath: "c:\\bridge\\NATIVE\\bin\\postgres.exe", CommandLine: "\"" + postgres + "\" --forkchild=\"checkpointer\" 1234" },
    { ProcessId: 12, ParentProcessId: 77, ExecutablePath: null, CommandLine: "\"" + postgres + "\" --forkchild=\"io_worker\" 99" },
    { ProcessId: 13, ParentProcessId: 4, ExecutablePath: "C:\\Program Files\\PostgreSQL\\18\\bin\\postgres.exe", CommandLine: "postgres -D C:\\other" },
    { ProcessId: 14, ParentProcessId: 4, ExecutablePath: null, CommandLine: null },
  ], [postgres]);
  assert.deepEqual(rows, [
    { pid: 10, ppid: 4, postmaster: true }, { pid: 11, ppid: 10, postmaster: false }, { pid: 12, ppid: 77, postmaster: false },
  ]);
  assert.deepEqual(leftoverProcesses(rows, 77).map((entry) => entry.pid), [12]);
  assert.deepEqual(windowsServerProcesses({ ProcessId: 10, ParentProcessId: 4, ExecutablePath: postgres, CommandLine: "" }, [postgres]), [{ pid: 10, ppid: 4, postmaster: true }]);
});

test("ps rows: a postmaster by its command line, a child only when its program is this binary", async () => {
  const postgres = "/opt/bridge/bin/postgres";
  const text = [
    "  20     1 " + postgres + " -D /data -p 5432",
    "  21    20 postgres: checkpointer ",
    "  22    30 postgres: io worker 0",
    "  23    30 postgres: walwriter ",
    "  24     1 /usr/lib/postgresql/18/bin/postgres -D /other",
    "  25     1 node bridge.mjs",
    "  26     1 postgres: io worker 1",
  ].join("\n");
  const exe = { 21: postgres, 22: postgres, 23: "/usr/lib/postgresql/18/bin/postgres", 26: postgres };
  const rows = await posixServerProcesses(text, [postgres], async (pid) => exe[pid] ?? null);
  assert.deepEqual(rows, [
    { pid: 20, ppid: 1, postmaster: true }, { pid: 21, ppid: 20, postmaster: false }, { pid: 22, ppid: 30, postmaster: false }, { pid: 26, ppid: 1, postmaster: false },
  ]);
  // 26 was re-parented: its parent is no longer the pid file's, so it is not Bridge's to stop.
  assert.deepEqual(leftoverProcesses(rows, 30).map((entry) => entry.pid), [22]);
});

// The commands, with the database calls and the page made up.
async function project(t, locale) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-down-project-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const bridgeConfigPath = path.join(dir, "bridge.json");
  await fsp.writeFile(bridgeConfigPath, JSON.stringify({ locale }) + "\n");
  return { repoRoot: dir, bridgeConfigPath };
}

function output() {
  const lines = [];
  return { lines, write: (text) => lines.push(...text.split("\n").filter(Boolean)) };
}

test("down while a run is running refuses, lists the runs, and stops neither the page nor the database", async (t) => {
  const paths = await project(t, "zh-TW");
  const calls = [];
  const out = output();
  const database = {
    runsRunning: async () => [{ run_id: "run-1", root_path: "C:/farm" }],
    runLines: (runs) => runs.map((run) => "  " + run.run_id + "  " + run.root_path).join("\n"),
    stopDatabase: async () => { calls.push("database"); return { database: "stopped" }; },
  };
  const code = await downService({ paths, out, database, page: async () => { calls.push("page"); return { exitCode: 0, reason: "stopped" }; } });
  assert.equal(code, 2);
  assert.deepEqual(calls, []);
  assert.match(out.lines[0], /^沒有停任何東西：/);
  assert.equal(out.lines[1], "  run-1  C:/farm");
});

test("down with no run running stops the page and then the database, and says so in the project's language", async (t) => {
  const paths = await project(t, "zh-TW");
  const calls = [];
  const out = output();
  const database = {
    runsRunning: async () => [],
    runLines: () => "",
    stopDatabase: async () => { calls.push("database"); return { database: "stopped" }; },
  };
  const code = await downService({ paths, out, database, page: async () => { calls.push("page"); return { exitCode: 0, reason: "stopped" }; } });
  assert.equal(code, 0);
  assert.deepEqual(calls, ["page", "database"]);
  assert.deepEqual(out.lines, ["頁面已停止。", "資料庫已停止。"]);
});

test("down says when another PostgreSQL uses the number the database recorded", async (t) => {
  const paths = await project(t, "zh-TW");
  const out = output();
  const database = { runsRunning: async () => [], runLines: () => "", stopDatabase: async () => ({ database: "in_use", pid: 4242 }) };
  const code = await downService({ paths, out, database, page: async () => ({ exitCode: 0, reason: "not_running" }) });
  assert.equal(code, 0);
  assert.equal(out.lines[1], "資料庫本來就沒在跑；另一套 PostgreSQL 在用它記的號碼（4242），Bridge 沒有停它，也沒有刪任何檔案。");
});

test("down stops a running database, and on a cleanly stopped one lists no process", async (t) => {
  const { home, root } = await cluster(t);
  const stopped = [];
  const listing = { calls: 0 };
  const server = (running) => ({
    binaries: { pg_ctl: "fake-pg_ctl", postgres: "fake-postgres" },
    state: async () => ({ running, cluster: true }),
    stop: async (at) => { stopped.push(at); },
    clear: (at, options) => clearOldServer(at, {
      ...options, tool: async () => ({ code: 3, stdout: "", stderr: "" }), processes: async () => { listing.calls += 1; return []; },
    }),
  });
  assert.deepEqual(await stopDatabase({ dataHome: home, server: server(true) }), { database: "stopped" });
  assert.deepEqual(stopped, [root]);
  assert.deepEqual(await stopDatabase({ dataHome: home, server: server(false) }), { database: "not_running" });
  assert.equal(listing.calls, 0, "a cluster stopped cleanly is not looked for in the process list");
});

test("status says the database is stopped and does not start it", async (t) => {
  const paths = await project(t, "zh-TW");
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = (text) => { lines.push(...String(text).split("\n").filter(Boolean)); return true; };
  try {
    const code = await statusOverview({
      paths, options: {}, page: async () => ({ running: false, url: null, reason: "no_session" }), databaseRunning: async () => false,
    });
    assert.equal(code, 0);
  } finally {
    process.stdout.write = write;
  }
  assert.deepEqual(lines, ["Page: not running; start it with review-bridge up", "資料庫：已停止；review-bridge up 會把它起來，下一次 start 也會。"]);
});
