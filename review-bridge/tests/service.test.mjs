// Keeps the person's database out of these tests (see the fixture).
import { stopPage } from "./fixtures/isolatedDataHome.mjs";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getBridgePaths } from "../utils/paths.mjs";
import { checkService } from "../features/setupCheck/pageService.mjs";

const runtimeSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// A minimal neutral layout: a bridge.json with roles and a watch block; the runtime is Bridge's own.
async function workspace(t, watch) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-service-"));
  const runtime = runtimeSource;
  await fsp.mkdir(path.join(root, ".review-bridge"), { recursive: true });
  await fsp.writeFile(path.join(root, ".review-bridge", "bridge.json"), JSON.stringify({
    schema_version: 4,
    project_id: randomUUID(),
    roles: { writer: { provider_id: "claude" }, reviewer: { provider_id: "codex" } },
    watch,
  }));
  const bridge = (...args) => spawnSync(process.execPath, [path.join(runtime, "bootstrap.mjs"), ...args], {
    cwd: root, encoding: "utf8", windowsHide: true,
  });
  t.after(async () => {
    await stopPage(root);
    await fsp.rm(root, { recursive: true, force: true });
  });
  const paths = getBridgePaths(root, runtime, { privateRootName: ".review-bridge" });
  // The page keeps its session in the project's state, outside the project.
  await fsp.mkdir(paths.stateRoot, { recursive: true });
  return { root, bridge, privateRoot: paths.stateRoot, paths };
}

// up's first line is the database's; the page's lines follow.
function withoutDatabaseLine(stdout) {
  const lines = stdout.trim().split(/\r?\n/);
  assert.match(lines[0], /^Database running \(port \d+\)\.$/);
  return lines.slice(1);
}

async function deadPid() {
  const child = spawnSync(process.execPath, ["-e", ""], { windowsHide: true });
  return child.pid;
}

async function writeSession(privateRoot, session) {
  await fsp.writeFile(path.join(privateRoot, "watch-session.json"), JSON.stringify({
    pid: process.pid, port: 1, url: "http://localhost:1/", service_id: "0".repeat(32), started_at: new Date().toISOString(), ...session,
  }));
}

test("up starts once, ps reports it, down stops it and removes the pid file", async (t) => {
  const port = await freePort();
  const { bridge, privateRoot } = await workspace(t, { port, strict_port: false });
  const url = `http://localhost:${port}/`;

  const notRunning = bridge("ps");
  assert.equal(notRunning.status, 1);
  assert.equal(notRunning.stdout.trim(), "Bridge is not running. Run: npx review-bridge up");

  const up = bridge("up", "--fake-cli");
  assert.equal(up.status, 0, up.stderr);
  // RC3-DOWN-01: up starts the database first and says so; this project has no locale, so the database's
  // and the page's lines are English alike.
  assert.deepEqual(withoutDatabaseLine(up.stdout), ["Page: " + url]);
  assert.equal((await fsp.readFile(path.join(privateRoot, "watch-url.txt"), "utf8")).trim(), url);
  // C1 + C3: the watch process recorded itself and /api/status echoes the same identity.
  const session = JSON.parse(await fsp.readFile(path.join(privateRoot, "watch-session.json"), "utf8"));
  assert.deepEqual(Object.keys(session).sort(), ["pid", "port", "service_id", "started_at", "url"]);
  assert.equal(session.url, url);
  assert.equal(session.port, port);
  assert.ok(Number.isInteger(session.pid));
  assert.match(session.service_id, /^[0-9a-f]{32}$/);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  const status = await (await fetch(url + "api/status")).json();
  assert.equal(status.service_id, session.service_id);
  assert.equal(status.pid, session.pid);
  assert.equal(status.port, port);

  const again = bridge("up", "--fake-cli");
  assert.equal(again.status, 0);
  assert.deepEqual(withoutDatabaseLine(again.stdout), ["Already running: " + url]);
  assert.equal(JSON.parse(await fsp.readFile(path.join(privateRoot, "watch-session.json"), "utf8")).pid, session.pid);

  const ps = bridge("ps");
  assert.equal(ps.status, 0);
  // The page's address only; no count (a hard-coded 0 used to follow it).
  assert.deepEqual(ps.stdout.trim().split(/\r?\n/), [url]);

  // status: the page, the database's line, then the runs from the database, listed and not totalled (as
  // gh run list); nothing counted from the page service's folders.
  const running = bridge("status");
  assert.equal(running.status, 0, running.stderr);
  const statusLines = running.stdout.trim().split(/\r?\n/);
  assert.deepEqual(statusLines.slice(0, 3), [
    "Page: " + url,
    "Database: running",
    "Work: none yet. Put a work order in .review-bridge/work-packages/ and run: npx review-bridge start <file>",
  ]);
  assert.equal(statusLines.some((line) => /^Review queue:/.test(line)), false, running.stdout);

  // RC3-DOWN-01: down stops the page and then the database, as docker compose down does.
  const down = bridge("down");
  assert.equal(down.status, 0, down.stderr);
  assert.deepEqual(down.stdout.trim().split(/\r?\n/), ["Page stopped.", "Database stopped."]);
  assert.equal(await fsp.stat(path.join(privateRoot, "watch-session.json")).catch(() => null), null);
  const after = bridge("ps");
  assert.equal(after.status, 1);
  assert.equal(after.stdout.trim(), "Bridge is not running. Run: npx review-bridge up");
  // status only looks: a stopped database is said to be stopped and is not started to answer
  // (the down below finds it still not running).
  const stopped = bridge("status");
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.deepEqual(stopped.stdout.trim().split(/\r?\n/), [
    "Page: not running; start it with npx review-bridge up",
    "Database: stopped; npx review-bridge up starts it, and so does the next start.",
  ]);
  // B7: nothing is left to stop, which is not a failure.
  const downAgain = bridge("down");
  assert.equal(downAgain.status, 0, downAgain.stderr);
  assert.deepEqual(downAgain.stdout.trim().split(/\r?\n/), ["Page was not running.", "Database was not running."]);
});

test("occupied port moves the service to the next port and writes the real URL file", async (t) => {
  const port = await freePort();
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(port, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const { bridge, privateRoot } = await workspace(t, { port, strict_port: false });

  const up = bridge("up", "--fake-cli");
  assert.equal(up.status, 0, up.stderr);
  const url = (await fsp.readFile(path.join(privateRoot, "watch-url.txt"), "utf8")).trim();
  const bumped = Number(new URL(url).port);
  assert.ok(bumped > port && bumped <= port + 20);
  const lines = withoutDatabaseLine(up.stdout);
  assert.match(lines[0], new RegExp(`^${port} 被.*占用，改用 http://localhost:${bumped}/$`));
  assert.equal(lines.at(-1), "Page: " + url);
});

test("strict_port refuses an occupied port with a clear line and leaves nothing running", async (t) => {
  const port = await freePort();
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(port, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const { bridge, privateRoot } = await workspace(t, { port, strict_port: true });

  const up = bridge("up", "--fake-cli");
  assert.equal(up.status, 2);
  assert.match(withoutDatabaseLine(up.stdout).join("\n"), new RegExp(`^Bridge did not start: .*port ${port} 被占用，watch.strict_port 為 true`));
  assert.equal(await fsp.stat(path.join(privateRoot, "watch-session.json")).catch(() => null), null);
  assert.equal(bridge("ps").status, 1);
});

test("T2 stale session with a dead pid: ps says not running and up restarts the service", async (t) => {
  const port = await freePort();
  const { bridge, privateRoot, paths } = await workspace(t, { port, strict_port: false });
  await writeSession(privateRoot, { pid: await deadPid(), port, url: `http://localhost:${port}/` });
  assert.equal((await checkService(paths)).reason, "pid_dead");
  assert.equal(bridge("ps").status, 1);

  const up = bridge("up", "--fake-cli");
  assert.equal(up.status, 0, up.stderr);
  assert.deepEqual(withoutDatabaseLine(up.stdout), ["Page: " + `http://localhost:${port}/`]);
  const check = await checkService(paths);
  assert.equal(check.reason, "running");
  assert.ok(check.session.pid !== process.pid);
});

test("T3 a foreign server answering 200 on the recorded port is wrong_service, not running", async (t) => {
  const port = await freePort();
  const foreign = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  await new Promise((resolve) => foreign.listen(port, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => foreign.close(resolve)));
  const { bridge, privateRoot, paths } = await workspace(t, { port, strict_port: false });
  await writeSession(privateRoot, { pid: process.pid, port, url: `http://localhost:${port}/` });

  assert.equal((await checkService(paths)).reason, "wrong_service");
  const ps = bridge("ps");
  assert.equal(ps.status, 1);
  assert.equal(ps.stdout.trim(), "Bridge is not running. Run: npx review-bridge up");
});

test("T4 a session pointing at a port nobody listens on is unreachable; a malformed record is no_session", async (t) => {
  const port = await freePort();
  const { bridge, privateRoot, paths } = await workspace(t, { port, strict_port: false });
  await writeSession(privateRoot, { pid: process.pid, port, url: `http://localhost:${port}/` });
  assert.equal((await checkService(paths)).reason, "unreachable");
  assert.equal(bridge("ps").status, 1);
  const malformed = await workspace(t, { port: await freePort(), strict_port: false });
  await fsp.writeFile(path.join(malformed.privateRoot, "watch-session.json"), "{not json");
  assert.equal((await checkService(malformed.paths)).reason, "no_session");
});

test("wherever the runtime sits, it keeps no state beside itself: a copy in a provider folder writes nothing there", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-provider-folder-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, ".claude", "tools", "review-bridge");
  await fsp.cp(runtimeSource, runtime, { recursive: true });
  const result = spawnSync(process.execPath, [path.join(runtime, "bootstrap.mjs"), "status"], {
    cwd: root, encoding: "utf8", windowsHide: true,
  });
  // status needs no settings and only reads; the copy in .claude/ gains nothing and no state appears.
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await fsp.readdir(path.join(root, ".claude")), ["tools"]);
  assert.deepEqual(await fsp.readdir(path.join(root, ".claude", "tools")), ["review-bridge"]);
  assert.equal(await fsp.stat(path.join(root, ".review-bridge")).catch(() => null), null);
});
