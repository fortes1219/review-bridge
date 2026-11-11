import "./fixtures/isolatedDataHome.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { acquireLease, leaseFiles, openLeaseReader } from "../features/setupCheck/pageLease.mjs";
import { openDatabase } from "../service/database/index.mjs";
import { closeLifeline, connectPage, currentRelease, launchPage, observePage, serviceFiles, serviceStatus, stopPage, waitForOwnerExit, ownerExitProbe } from "../features/setupCheck/pageService.mjs";
import { getBridgePaths } from "../utils/paths.mjs";

// RC3.1-PAGE-03: the page service as supabase/cli's stack owner (c75aea2, packages/stack/
// src/HostProcess.integration.test.ts). Every test starts real page-service processes with real
// listeners; the situations are made by the test itself, and every wait is on something observable: the
// readiness report, or finding the page service. Ports are the ones the services bind (0) and report.
const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeRoot = path.resolve(here, "..");
const bootstrapPath = path.join(bridgeRoot, "bootstrap.mjs");
const fixtureOwner = path.join(here, "fixtures", "page-owner-fixture.mjs");
const FAKE = ["--fake-cli"];

async function project(t, { roles = { writer: "claude", reviewer: "codex" } } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-page-"));
  await fsp.mkdir(path.join(root, ".review-bridge"), { recursive: true });
  await fsp.writeFile(path.join(root, ".review-bridge", "bridge.json"), JSON.stringify({
    schema_version: 4, project_id: randomUUID(), active_runs: "derive_from_run_projections",
    roles: { writer: { provider_id: roles.writer }, reviewer: { provider_id: roles.reviewer } },
    watch: { port: 0 },
  }));
  const paths = getBridgePaths(root, bridgeRoot, { privateRootName: ".review-bridge" });
  const started = new Set();
  owned.set(paths, started);
  t.after(async () => {
    await stopPage(paths).catch(() => {});
    // Only what this test started, by its pid, never by name (an orphan a mutant leaves: three page services
    // where one is found, or one that kept running without its lease).
    for (const pid of started) {
      if (!alive(pid)) continue;
      try { process.kill(pid, "SIGKILL"); } catch {}
      await waitForOwnerExit(pid, ownerExitProbe()).catch(() => {});
    }
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  return { root, paths };
}

// The pids each test's project started, for its clean-up.
const owned = new Map();
function own(paths, pid) {
  if (Number.isInteger(pid) && pid > 0) owned.get(paths)?.add(pid);
  return pid;
}

// launchPage, keeping the pid of the page service it reached for the clean-up.
async function launch(paths, options) {
  const launched = await launchPage(paths, options);
  own(paths, launched.endpoint.pid);
  return launched;
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
};

function request(port, method, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: requestPath, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

// A listener that accepts and never answers, counting the connections it gets.
async function silentListener(t) {
  let connections = 0;
  const sockets = new Set();
  const server = net.createServer((socket) => { connections += 1; sockets.add(socket); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }));
  return { port: server.address().port, connections: () => connections };
}

// Whether the project's lease is held, as a command asks it: from pg_locks, never by taking it.
async function held(paths) {
  const reader = await openLeaseReader();
  if (!reader) return false;
  try {
    return await reader.held(JSON.parse(await fsp.readFile(paths.bridgeConfigPath, "utf8")).project_id);
  } finally {
    await reader.close();
  }
}

// The file's text once it exists, by a watch on its folder: subscribed before it is looked for.
function fileWritten(file) {
  return new Promise((resolve, reject) => {
    const watcher = fs.watch(path.dirname(file));
    const look = () => fsp.readFile(file, "utf8").then((text) => {
      if (!text) return;
      watcher.close();
      resolve(text);
    }, () => {});
    watcher.on("change", look);
    watcher.on("error", reject);
    look();
  });
}

async function writeStaleRecord(paths, port) {
  const { directory, record } = leaseFiles(paths);
  await fsp.mkdir(directory, { recursive: true });
  const project = JSON.parse(await fsp.readFile(paths.bridgeConfigPath, "utf8")).project_id;
  await fsp.writeFile(record, JSON.stringify({
    schema_version: 1, pid: process.pid, port, page_port: port, url: "http://localhost:" + port + "/", release: "stale",
    secret: "stale", project_id: project, lifetime: "detached", started_at: new Date().toISOString(),
  }));
}

test("starts exactly one page service for concurrent launches and attaches the others", { timeout: 120_000 }, async (t) => {
  const { paths } = await project(t);
  // The database the lease lives in is up before the three launches, as supabase/cli saves the stack's
  // state before its three concurrent launchers (HostProcess.integration.test.ts:310-340) and as `up` opens
  // the database before it starts the page service (setupCheck/commands.mjs). Several processes starting
  // one new database at once is another contract: on Windows a loser's `pg_ctl start` can wait 30 s on the
  // -l file the winner's server holds (pg_ctl.c:521-554, port/open.c:110-137), which belongs to the
  // database-start work, not to this test.
  await openDatabase();
  // Every launch settles before anything is asserted, so each pid is kept for the clean-up first.
  const settled = await Promise.allSettled([1, 2, 3].map(() => launch(paths, { bootstrapPath, ownerArgs: FAKE })));
  // A launch that failed is said with the end of the page service's log, before the clean-up removes it
  // (supabase/cli AGENTS.md:179: subprocess diagnostics).
  const failures = await Promise.all(settled.filter((outcome) => outcome.status === "rejected").map(async ({ reason }) => {
    const log = /\(log: (.+?)\)/.exec(reason.message)?.[1];
    const tail = log ? (await fsp.readFile(log, "utf8").catch(() => "")).split(/\r?\n/).slice(-30).join("\n") : "";
    return reason.message + "\n" + tail;
  }));
  assert.deepEqual(settled.map((outcome) => outcome.status), ["fulfilled", "fulfilled", "fulfilled"], failures.join("\n----\n"));
  const launched = settled.map((outcome) => outcome.value);
  assert.equal(new Set(launched.map(({ endpoint }) => endpoint.pid)).size, 1);
  assert.equal(new Set(launched.map(({ endpoint }) => endpoint.port)).size, 1);
});

test("relaunches after shutdown while a foreign listener holds the previous control port; control requests need the secret", { timeout: 120_000 }, async (t) => {
  const { paths } = await project(t);
  const first = await launch(paths, { bootstrapPath, ownerArgs: FAKE });
  const old = first.endpoint;
  assert.equal((await connectPage(paths)).endpoint.pid, old.pid);
  assert.equal(await request(old.port, "GET", "/identity"), 401, "identity requires the secret");
  assert.equal(await request(old.port, "POST", "/shutdown"), 401, "shutdown requires the secret");
  assert.deepEqual(await stopPage(paths), { stopped: true });
  assert.equal(alive(old.pid), false);
  const foreign = http.createServer((req, res) => res.writeHead(200).end("{}"));
  await new Promise((resolve) => foreign.listen(old.port, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { foreign.closeAllConnections(); foreign.close(() => resolve()); }));
  const relaunched = await launch(paths, { bootstrapPath, ownerArgs: FAKE });
  assert.notEqual(relaunched.endpoint.pid, old.pid);
  assert.notEqual(relaunched.endpoint.port, old.port);
  assert.deepEqual((await connectPage(paths)).endpoint, relaunched.endpoint);
});

// The lease held and the record still the one a page service left before it, naming a port where
// something else answers: a page service still starting, not "not running" (HostProcess.ts:200-241).
test("a record naming another process while the lease is held is a page service still starting, found once it publishes", { timeout: 60_000 }, async (t) => {
  const { paths } = await project(t);
  await openDatabase();
  const lease = await acquireLease(paths, JSON.parse(await fsp.readFile(paths.bridgeConfigPath, "utf8")).project_id);
  t.after(() => lease.release());
  let asked;
  const reachedStale = new Promise((resolve) => { asked = resolve; });
  const listen = async (handler) => {
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    return server.address().port;
  };
  const foreign = await listen((req, res) => { asked(); res.writeHead(200, { "Content-Type": "application/json" }).end("{}"); });
  const projectId = JSON.parse(await fsp.readFile(paths.bridgeConfigPath, "utf8")).project_id;
  await lease.publishRecord({ project_id: projectId, pid: process.pid, port: foreign, release: "stale", url: "http://localhost:1/", page_port: 1, secret: "stale", lifetime: "detached", started_at: new Date().toISOString() });
  const finding = connectPage(paths);
  await reachedStale;
  const secret = randomUUID();
  let identity = null;
  const control = await listen((req, res) => {
    if (req.headers.authorization !== "Bearer " + secret) return res.writeHead(401).end();
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(identity));
  });
  identity = { project_id: projectId, pid: process.pid, port: control, release: await currentRelease(bridgeRoot), url: "http://localhost:1/", page_port: 1 };
  await lease.publishRecord({ ...identity, secret, lifetime: "detached", started_at: new Date().toISOString() });
  assert.equal((await finding).endpoint.port, control);
});

test("ignores a stale record once no process holds the lease", { timeout: 120_000 }, async (t) => {
  const { paths } = await project(t);
  const unresponsive = await silentListener(t);
  await writeStaleRecord(paths, unresponsive.port);
  assert.equal((await observePage(paths)).running, false);
  const launched = await launch(paths, { bootstrapPath, ownerArgs: FAKE });
  assert.notEqual(launched.endpoint.port, unresponsive.port);
  assert.equal(unresponsive.connections(), 0);
});

test("status reads a free lease without a request to the recorded endpoint", { timeout: 60_000 }, async (t) => {
  const { paths } = await project(t);
  const unresponsive = await silentListener(t);
  await writeStaleRecord(paths, unresponsive.port);
  const said = [];
  const shown = await serviceStatus({ paths, out: { write: (text) => said.push(text) } });
  assert.equal(shown.exitCode, 1);
  assert.equal(shown.reason, "not_running");
  assert.equal(unresponsive.connections(), 0);
});

test("a page service that exits before it reports ready is said so, and leaves no process", { timeout: 60_000 }, async (t) => {
  const { paths } = await project(t);
  await assert.rejects(launch(paths, { bootstrapPath: fixtureOwner, ownerArgs: ["--fixture-mode", "exit-early"] }),
    /The Bridge page service failed to start: The page service exited before reporting it is ready \(log: /);
  const pid = Number(await fsp.readFile(path.join(paths.privateRoot, "fixture-owner.pid"), "utf8"));
  await waitForOwnerExit(pid, ownerExitProbe());
  assert.equal(await held(paths), false);
});

// As supabase/cli HostProcess.integration.test.ts:555-577: a failure the page service reports is said with
// its reason and where its log is, never with the log's lines.
test("a startup failure the page service reports is said with its reason and its log's place, not the log", { timeout: 60_000 }, async (t) => {
  const { paths } = await project(t);
  await assert.rejects(launch(paths, { bootstrapPath: fixtureOwner, ownerArgs: ["--fixture-mode", "report-error"] }), (error) => {
    assert.match(error.message, /owner startup failed/);
    assert.match(error.message, /\(log: /);
    assert.doesNotMatch(error.message, /fixture-owner-diagnostic/);
    return true;
  });
  own(paths, Number(await fsp.readFile(path.join(paths.privateRoot, "fixture-owner.pid"), "utf8")));
});

test("a page service of another release is refused with down; down still stops it", { timeout: 60_000 }, async (t) => {
  const { paths } = await project(t);
  const launched = await launch(paths, { bootstrapPath: fixtureOwner, ownerArgs: ["--fixture-mode", "other-release"] });
  await assert.rejects(connectPage(paths), (error) => {
    assert.equal(error.reason, "release-mismatch");
    assert.match(error.message, /is release 0\.0\.0-other\+fixture, but this command is release .+ Run: .+ down, then run this again\./);
    return true;
  });
  assert.deepEqual(await stopPage(paths), { stopped: true });
  assert.equal(alive(launched.endpoint.pid), false);
  assert.equal(await held(paths), false);
});

test("an older release's record with its process alive is neither running nor absent: it is said with its pid", { timeout: 60_000 }, async (t) => {
  const { paths } = await project(t);
  const older = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: "ignore" });
  t.after(() => { try { older.kill(); } catch {} });
  await fsp.mkdir(path.dirname(serviceFiles(paths).sessionPath), { recursive: true });
  await fsp.writeFile(serviceFiles(paths).sessionPath, JSON.stringify({ pid: older.pid, port: 1, url: "http://localhost:1/", service_id: "0".repeat(32), started_at: new Date().toISOString() }));
  const seen = await observePage(paths);
  assert.deepEqual([seen.running, seen.reason, seen.pid], [false, "older_release", older.pid]);
  await assert.rejects(connectPage(paths), (error) => error.reason === "older-release" && error.message.includes("pid " + older.pid));
  // It does not prove itself a page service the way its release did, so down leaves the process alone.
  assert.deepEqual(await stopPage(paths), { stopped: false });
  assert.equal(alive(older.pid), true);
});

test("a page service started for a terminal shuts itself down when its stdin ends", { timeout: 120_000 }, async (t) => {
  const { paths } = await project(t);
  const launched = await launch(paths, { bootstrapPath, ownerArgs: FAKE, lifetime: "session" });
  assert.equal(launched.attached, false);
  await closeLifeline(launched.child);
  assert.equal(alive(launched.endpoint.pid), false);
  assert.equal(await held(paths), false, "the lease is let go");
  assert.equal(await fsp.stat(leaseFiles(paths).record).catch(() => null), null, "the record is withdrawn");
});

// Lost ownership (ARCHITECTURE.md:495): the database session that is the lease is terminated from another
// session. The page service stops on its own and leaves the record untouched: once the lease is lost it is
// not its to withdraw, a record without its lease means nothing (Lease.ts:55), and the next page service's
// publish renames over it (Lease.ts:219-221).
test("a page service whose database session is terminated shuts itself down and leaves its record to the next one", { timeout: 120_000 }, async (t) => {
  const { paths } = await project(t);
  const launched = await launch(paths, { bootstrapPath, ownerArgs: FAKE });
  const { record } = leaseFiles(paths);
  const before = await fsp.readFile(record, "utf8");
  const projectId = JSON.parse(await fsp.readFile(paths.bridgeConfigPath, "utf8")).project_id;
  const database = await openDatabase();
  const { rows } = await database.query(
    "select pg_terminate_backend(pid) as ended from pg_locks where locktype = 'advisory' and granted and objsubid = 2"
    + " and classid = hashtext($1)::oid and objid = hashtext($2)::oid", ["review-bridge.page-service", projectId]);
  assert.deepEqual(rows.map((row) => row.ended), [true]);
  await waitForOwnerExit(launched.endpoint.pid, ownerExitProbe());
  assert.equal(await held(paths), false);
  assert.equal(await fsp.readFile(record, "utf8").catch(() => null), before, "the record is left as it was");
  await assert.rejects(connectPage(paths), (error) => error.reason === "not-running");
  const next = await launch(paths, { bootstrapPath, ownerArgs: FAKE });
  assert.equal(JSON.parse(await fsp.readFile(record, "utf8")).pid, next.endpoint.pid);
});

test("page services of two projects run at once without blocking each other", { timeout: 120_000 }, async (t) => {
  const one = await project(t);
  const two = await project(t);
  const [first, second] = await Promise.all([one, two].map(({ paths }) => launch(paths, { bootstrapPath, ownerArgs: FAKE })));
  assert.notEqual(first.endpoint.pid, second.endpoint.pid);
  assert.equal((await connectPage(one.paths)).endpoint.pid, first.endpoint.pid);
  assert.equal((await connectPage(two.paths)).endpoint.pid, second.endpoint.pid);
});

// A page service ended without a shutdown (que README.md:11: a dead holder's lock is available at once).
test("a page service ended without a shutdown is found not running, and up starts another", { timeout: 120_000 }, async (t) => {
  const { paths } = await project(t);
  const first = await launch(paths, { bootstrapPath, ownerArgs: FAKE });
  process.kill(first.endpoint.pid, "SIGKILL");
  await waitForOwnerExit(first.endpoint.pid, ownerExitProbe());
  await assert.rejects(connectPage(paths), (error) => error.reason === "not-running");
  const second = await launch(paths, { bootstrapPath, ownerArgs: FAKE });
  assert.notEqual(second.endpoint.pid, first.endpoint.pid);
});

// A reviewer CLI that answers the readiness questions and then, asked for the check, starts a child of
// its own and never ends: the shutdown must cancel it and see both gone. A script is a CLI only where a
// shebang runs it.
test("a shutdown during a reviewer check cancels it, and the page service ends after the processes it started", { timeout: 120_000, skip: process.platform === "win32" && "a script cannot stand in for a CLI executable on Windows" }, async (t) => {
  const { root, paths } = await project(t, { roles: { writer: "claude", reviewer: "claude" } });
  const markers = path.join(root, "cli-pids");
  const cli = path.join(root, "fake-claude");
  await fsp.writeFile(cli, "#!" + process.execPath + "\n" + [
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "if (args[0] === '--version') { console.log('2.1.0 (Claude Code)'); process.exit(0); }",
    "if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }",
    "const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "fs.writeFileSync(" + JSON.stringify(markers) + ", process.pid + ' ' + child.pid);",
    "setInterval(() => {}, 1000);",
  ].join("\n"), { mode: 0o755 });
  const previous = process.env.CLAUDE_REVIEW_CLI;
  process.env.CLAUDE_REVIEW_CLI = cli;
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_REVIEW_CLI; else process.env.CLAUDE_REVIEW_CLI = previous; });
  const launched = await launch(paths, { bootstrapPath });
  const page = await fetch(launched.url);
  const token = /name="review-bridge-session" content="([0-9a-f]{64})"/.exec(await page.text())[1];
  const origin = new URL(launched.url).origin;
  const check = fetch(origin + "/api/reviewer-probe", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, "x-review-bridge-token": token },
    body: JSON.stringify({ confirm: "one_model_call", request_id: randomUUID() }),
  }).then((response) => response.status, () => null);
  // Observable: the CLI wrote its own pid and its child's.
  const pids = (await fileWritten(markers)).split(" ").map(Number);
  for (const pid of pids) own(paths, pid);
  assert.deepEqual(await stopPage(paths), { stopped: true });
  assert.equal(alive(pids[0]), false, "the reviewer CLI is gone");
  assert.equal(alive(pids[1]), false, "the process it started is gone");
  assert.equal(alive(launched.endpoint.pid), false);
  await check;
});
