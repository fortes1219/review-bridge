import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  bridgeDataHome, clusterPaths, connect, ensureCluster, postgresBinaries, serverLogFiles, serverRunning, startServer, stopServer,
} from "../service/database/postgresServer.mjs";

// RC3-BLOCKER-01 step 1: the embedded PostgreSQL server is created, started, stopped and found again
// with its data. Every test uses a real server in its own temporary folder; none calls a model.
const moduleUrl = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "service", "database", "postgresServer.mjs")).href;
const binaries = await postgresBinaries();

async function cluster(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-pg-"));
  t.after(async () => {
    await stopServer(root, { binaries }).catch(() => {});
    await fsp.rm(root, { recursive: true, force: true });
  });
  await ensureCluster(root, { binaries });
  return root;
}

async function serverLog(root) {
  const texts = await Promise.all((await serverLogFiles(root)).map((file) => fsp.readFile(file, "utf8")));
  return texts.join("");
}

const postmasterPid = async (root) => Number((await fsp.readFile(path.join(clusterPaths(root).data, "postmaster.pid"), "utf8")).split(/\r?\n/)[0]);

// The postmaster processes serving this data folder, counted by the operating system. Server
// children carry --forkchild on Windows and a "postgres: ..." title elsewhere, so only the
// postmaster names the data folder without one.
async function postmasterCount(root) {
  const windows = process.platform === "win32";
  const [file, args] = windows
    ? ["powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"name='postgres.exe'\" | ForEach-Object { $_.CommandLine }"]]
    : ["ps", ["-eo", "args"]];
  const listing = await new Promise((resolve, reject) => execFile(file, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout))));
  const plain = (text) => (windows ? text.replaceAll("\\", "/").toLowerCase() : text);
  const data = plain(clusterPaths(root).data);
  return listing.split(/\r?\n/).filter((line) => plain(line).includes(data) && !line.includes("--forkchild")).length;
}

async function query(root, sql, values) {
  const client = await connect(root);
  try {
    return (await client.query(sql, values)).rows;
  } finally {
    await client.end();
  }
}

test("a new cluster starts, answers SQL, stops cleanly, and keeps its data across a restart", { timeout: 120_000 }, async (t) => {
  const root = await cluster(t);
  assert.deepEqual((await ensureCluster(root, { binaries })).created, false, "a second ensure creates nothing");
  await startServer(root, { binaries });
  const first = await postmasterPid(root);
  await startServer(root, { binaries });
  assert.equal(await postmasterPid(root), first, "a running server is found, not started twice");
  assert.equal(await postmasterCount(root), 1);
  await query(root, "create table kept(id int primary key, note text not null)");
  await query(root, "insert into kept select n, 'row ' || n from generate_series(1, 1000) n");
  assert.deepEqual(await stopServer(root, { binaries }), { stopped: true, reason: "stopped" });
  assert.equal(await serverRunning(root, { binaries }), false);
  assert.deepEqual(await stopServer(root, { binaries }), { stopped: false, reason: "not_running" });
  await startServer(root, { binaries });
  assert.deepEqual(await query(root, "select count(*)::int as n from kept"), [{ n: 1000 }]);
  // The restart found a cleanly shut down cluster: no crash recovery.
  const log = await serverLog(root);
  assert.match(log, /database system was shut down at/);
  assert.doesNotMatch(log, /not properly shut down|automatic recovery in progress/);
});

test("a folder that holds files but no cluster is refused and left untouched", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-pg-foreign-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, "data"));
  await fsp.writeFile(path.join(root, "data", "someone-elses.txt"), "keep me\n");
  await assert.rejects(ensureCluster(root, { binaries }), /holds files but no PostgreSQL cluster/);
  assert.deepEqual(await fsp.readdir(path.join(root, "data")), ["someone-elses.txt"]);
  await assert.rejects(startServer(root, { binaries }), /There is no PostgreSQL cluster/);
});

test("a server killed without warning comes back with every committed row", { timeout: 120_000 }, async (t) => {
  const root = await cluster(t);
  await startServer(root, { binaries });
  await query(root, "create table kept(id int primary key)");
  await query(root, "insert into kept select generate_series(1, 500)");
  const postmaster = Number((await fsp.readFile(path.join(clusterPaths(root).data, "postmaster.pid"), "utf8")).split(/\r?\n/)[0]);
  process.kill(postmaster, "SIGKILL");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && await serverRunning(root, { binaries })) await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await serverRunning(root, { binaries }), false, "the killed server is not running");
  await startServer(root, { binaries });
  assert.notEqual(await postmasterPid(root), postmaster, "a new server was started");
  assert.deepEqual(await query(root, "select count(*)::int as n from kept"), [{ n: 500 }]);
  assert.match(await serverLog(root), /not properly shut down|automatic recovery/);
});

test("a remembered port that is taken is replaced by a free one, and the server is found there", { timeout: 120_000 }, async (t) => {
  const root = await cluster(t);
  const settingsFile = clusterPaths(root).settings;
  const { port: remembered } = JSON.parse(await fsp.readFile(settingsFile, "utf8"));
  const squatter = net.createServer();
  await new Promise((resolve) => squatter.listen(remembered, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => squatter.close(resolve)));
  const { port } = await startServer(root, { binaries });
  assert.notEqual(port, remembered);
  assert.equal(JSON.parse(await fsp.readFile(settingsFile, "utf8")).port, port);
  assert.deepEqual(await query(root, "select 1 as one"), [{ one: 1 }]);
});

test("four processes starting the same cluster at once leave one server, and all can use it", { timeout: 120_000 }, async (t) => {
  const root = await cluster(t);
  const script = [
    "const m = await import(process.env.RB_MODULE);",
    "const binaries = await m.postgresBinaries();",
    "const result = await m.startServer(process.env.RB_ROOT, { binaries });",
    "const client = await m.connect(process.env.RB_ROOT);",
    "await client.query('select 1');",
    "await client.end();",
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  const outcomes = await Promise.all([0, 1, 2, 3].map(() => new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      windowsHide: true, env: { ...process.env, RB_MODULE: moduleUrl, RB_ROOT: root }, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.once("close", (code) => resolve({ code, out, err }));
  })));
  for (const outcome of outcomes) assert.equal(outcome.code, 0, outcome.err);
  assert.equal(await serverRunning(root, { binaries }), true);
  assert.equal(await postmasterCount(root), 1, "one server runs for the cluster");
  const ports = new Set(outcomes.map((outcome) => JSON.parse(outcome.out).port));
  assert.equal(ports.size, 1, "all found the same server");
});

test("the server writes its own log, one file per day, inside the cluster", { timeout: 120_000 }, async (t) => {
  const root = await cluster(t);
  await startServer(root, { binaries });
  const names = (await serverLogFiles(root)).map((file) => path.basename(file));
  assert.equal(names.length, 1, JSON.stringify(names));
  assert.match(names[0], /^server-\d{4}-\d{2}-\d{2}\.log$/);
  assert.match(await serverLog(root), /database system is ready to accept connections/);
});

// A finished cluster built elsewhere, to be published at the root at a chosen moment, the way
// another process's rename would.
async function finishedCluster(t) {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-pg-race-"));
  t.after(() => fsp.rm(parent, { recursive: true, force: true }));
  const other = path.join(parent, "other");
  await ensureCluster(other, { binaries });
  return { parent, root: path.join(parent, "postgres"), publish: () => fsp.rename(other, path.join(parent, "postgres")) };
}

// Runs callback while fsp.readdir of `folder` first runs `before`, on the chosen call only.
async function onReaddir(folder, call, before, callback) {
  const original = fsp.readdir;
  let seen = 0;
  fsp.readdir = async (target, ...rest) => {
    if (path.resolve(String(target)) === path.resolve(folder) && ++seen === call) await before();
    return original.call(fsp, target, ...rest);
  };
  try {
    return await callback();
  } finally {
    fsp.readdir = original;
  }
}

test("a cluster published by another process just before the root is looked at is used, not refused", { timeout: 120_000 }, async (t) => {
  const race = await finishedCluster(t);
  // The first look at the root comes after "is it a cluster?" said no; the other process publishes now.
  const result = await onReaddir(race.root, 1, race.publish, () => ensureCluster(race.root, { binaries }));
  assert.equal(result.created, false);
  assert.deepEqual((await fsp.readdir(race.parent)).sort(), ["postgres"], "nothing else is left beside it");
});

test("a cluster published by another process after this one's rename failed is used, not refused", { timeout: 120_000 }, async (t) => {
  const race = await finishedCluster(t);
  const originalRename = fsp.rename;
  let failed = false;
  // This process's rename fails once with nothing at the root (on Windows a scanner can hold a new
  // file); the other process publishes just before the root is looked at again.
  fsp.rename = async (from, to, ...rest) => {
    if (!failed && path.resolve(String(to)) === path.resolve(race.root)) {
      failed = true;
      throw Object.assign(new Error("held by a scanner"), { code: "EPERM" });
    }
    return originalRename.call(fsp, from, to, ...rest);
  };
  try {
    const result = await onReaddir(race.root, 2, race.publish, () => ensureCluster(race.root, { binaries }));
    assert.equal(result.created, false);
  } finally {
    fsp.rename = originalRename;
  }
  assert.ok(failed, "the rename was made to fail");
  assert.deepEqual((await fsp.readdir(race.parent)).sort(), ["postgres"], "this process's own build is removed");
});

test("two processes creating the cluster for the first time at once both end up on the same server", { timeout: 180_000 }, async (t) => {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-pg-first-"));
  const root = path.join(parent, "postgres");
  t.after(async () => {
    await stopServer(root, { binaries }).catch(() => {});
    await fsp.rm(parent, { recursive: true, force: true });
  });
  const script = [
    "const m = await import(process.env.RB_MODULE);",
    "const binaries = await m.postgresBinaries();",
    "const { created } = await m.ensureCluster(process.env.RB_ROOT, { binaries });",
    "const { port } = await m.startServer(process.env.RB_ROOT, { binaries });",
    "const client = await m.connect(process.env.RB_ROOT);",
    "await client.query('select 1');",
    "await client.end();",
    "process.stdout.write(JSON.stringify({ created, port }));",
  ].join("\n");
  const outcomes = await Promise.all([0, 1].map(() => new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      windowsHide: true, env: { ...process.env, RB_MODULE: moduleUrl, RB_ROOT: root }, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.once("close", (code) => resolve({ code, out, err }));
  })));
  for (const outcome of outcomes) assert.equal(outcome.code, 0, outcome.err);
  const results = outcomes.map((outcome) => JSON.parse(outcome.out));
  assert.equal(results.filter((result) => result.created).length, 1, "exactly one process created it: " + JSON.stringify(results));
  assert.equal(new Set(results.map((result) => result.port)).size, 1, "both use the same server");
  assert.equal(await postmasterCount(root), 1, "one server runs for the cluster");
  assert.deepEqual(await fsp.readdir(parent), ["postgres"], "no half-built cluster is left beside it");
  assert.deepEqual(await query(root, "select 1 as one"), [{ one: 1 }]);
});

test("a cluster whose builder died is cleared; one still being built is left alone", { timeout: 120_000 }, async (t) => {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-pg-abandoned-"));
  const root = path.join(parent, "postgres");
  t.after(() => fsp.rm(parent, { recursive: true, force: true }));
  const ended = spawn(process.execPath, ["-e", ""], { windowsHide: true, stdio: "ignore" });
  await new Promise((resolve) => ended.once("close", resolve));
  const abandoned = root + ".creating-" + ended.pid + "-a";
  const inProgress = root + ".creating-" + process.pid + "-b";
  await fsp.mkdir(path.join(abandoned, "data"), { recursive: true });
  await fsp.writeFile(path.join(abandoned, "data", "half"), "");
  await fsp.mkdir(inProgress);
  assert.equal((await ensureCluster(root, { binaries })).created, true);
  assert.deepEqual((await fsp.readdir(parent)).sort(), ["postgres", path.basename(inProgress)].sort());
});

// A stand-in for a server that takes connections and never answers, or answers the login and then
// never answers a query.
async function silentServer(t, { answerLogin }) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    // Reading is what lets the stand-in see the client hang up.
    socket.resume();
    if (answerLogin) {
      // AuthenticationOk, then ReadyForQuery: the login is over and the client is connected.
      socket.once("data", () => socket.write(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49])));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(resolve);
  }));
  return { port: server.address().port, sockets };
}

test("a start whose connection or readiness query never answers ends at its deadline and leaves the server running", { timeout: 120_000 }, async (t) => {
  const root = await cluster(t);
  await startServer(root, { binaries });
  const pidFile = path.join(clusterPaths(root).data, "postmaster.pid");
  const original = await fsp.readFile(pidFile, "utf8");
  for (const answerLogin of [false, true]) {
    const silent = await silentServer(t, { answerLogin });
    // The running server is found where its postmaster.pid says it listens; point that at the stand-in,
    // and put it back before anything else happens, so the server can still be stopped.
    const lines = original.split("\n");
    lines[3] = String(silent.port);
    await fsp.writeFile(pidFile, lines.join("\n"));
    const began = Date.now();
    let outcome;
    try {
      outcome = await startServer(root, { binaries, timeoutSeconds: 1 }).then(() => null, (error) => error);
    } finally {
      await fsp.writeFile(pidFile, original);
    }
    const took = Date.now() - began;
    const what = answerLogin ? "a silent query" : "a silent connection";
    assert.match(String(outcome?.message), /did not become ready in time: no answer within the deadline/, what);
    assert.ok(took < 4_000, what + " held the start for " + took + " ms");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(silent.sockets.size, 0, what + ": the attempt's connection was closed");
    assert.equal(await serverRunning(root, { binaries }), true, what + ": the server was not killed");
  }
});

test("Bridge's data home is outside every project, per platform, and can be moved by setting", () => {
  assert.equal(bridgeDataHome({ env: { REVIEW_BRIDGE_DATA_HOME: "relative-home" } }), path.resolve("relative-home"));
  assert.equal(bridgeDataHome({ env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, platform: "win32", home: "C:\\Users\\a" }),
    path.join("C:\\Users\\a\\AppData\\Local", "ReviewBridge"));
  assert.equal(bridgeDataHome({ env: {}, platform: "darwin", home: "/Users/a" }), path.join("/Users/a", "Library", "Application Support", "ReviewBridge"));
  assert.equal(bridgeDataHome({ env: { XDG_DATA_HOME: "/x" }, platform: "linux", home: "/home/a" }), path.join("/x", "review-bridge"));
  assert.equal(bridgeDataHome({ env: {}, platform: "linux", home: "/home/a" }), path.join("/home/a", ".local", "share", "review-bridge"));
});

test("the password file can be read only by its owner", { skip: process.platform === "win32" && "file modes do not apply on Windows; the folder sits under the user's own profile" }, async (t) => {
  const root = await cluster(t);
  assert.equal((await fsp.stat(clusterPaths(root).secret)).mode & 0o077, 0);
});
