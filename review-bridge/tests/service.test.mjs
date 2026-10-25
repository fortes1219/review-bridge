// Keeps the person's database out of these tests (see the fixture).
import "./fixtures/isolatedDataHome.mjs";
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
  await fsp.mkdir(path.join(root, ".review-bridge", "review-bridge"), { recursive: true });
  await fsp.writeFile(path.join(root, ".review-bridge", "review-bridge", "bridge.json"), JSON.stringify({
    schema_version: 4,
    roles: { writer: { provider_id: "claude" }, reviewer: { provider_id: "codex" } },
    watch,
  }));
  const bridge = (...args) => spawnSync(process.execPath, [path.join(runtime, "bootstrap.mjs"), ...args], {
    cwd: root, encoding: "utf8", windowsHide: true,
  });
  t.after(async () => {
    bridge("down");
    await fsp.rm(root, { recursive: true, force: true });
  });
  const paths = getBridgePaths(root, runtime, { privateRootName: ".review-bridge" });
  return { root, bridge, privateRoot: path.join(root, ".review-bridge"), paths };
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
  assert.equal(notRunning.stdout.trim(), "Bridge 沒在跑，執行 review-bridge up");

  const up = bridge("up", "--fake-cli");
  assert.equal(up.status, 0, up.stderr);
  assert.equal(up.stdout.trim(), "網頁：" + url);
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
  assert.equal(again.stdout.trim(), "已在跑：" + url);
  assert.equal(JSON.parse(await fsp.readFile(path.join(privateRoot, "watch-session.json"), "utf8")).pid, session.pid);

  const ps = bridge("ps");
  assert.equal(ps.status, 0);
  assert.deepEqual(ps.stdout.trim().split(/\r?\n/), [url, "進行中 0"]);

  const down = bridge("down");
  assert.equal(down.status, 0);
  assert.equal(await fsp.stat(path.join(privateRoot, "watch-session.json")).catch(() => null), null);
  const after = bridge("ps");
  assert.equal(after.status, 1);
  assert.equal(after.stdout.trim(), "Bridge 沒在跑，執行 review-bridge up");
  // B7
  const downAgain = bridge("down");
  assert.equal(downAgain.status, 1);
  assert.equal(downAgain.stdout.trim(), "Bridge 沒在跑");
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
  const lines = up.stdout.trim().split(/\r?\n/);
  assert.match(lines[0], new RegExp(`^${port} 被.*占用，改用 http://localhost:${bumped}/$`));
  assert.equal(lines.at(-1), "網頁：" + url);
});

test("strict_port refuses an occupied port with a clear line and leaves nothing running", async (t) => {
  const port = await freePort();
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(port, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const { bridge, privateRoot } = await workspace(t, { port, strict_port: true });

  const up = bridge("up", "--fake-cli");
  assert.equal(up.status, 2);
  assert.match(up.stdout, new RegExp(`^Bridge 沒有啟動：.*port ${port} 被占用，watch.strict_port 為 true`));
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
  assert.equal(up.stdout.trim(), "網頁：" + `http://localhost:${port}/`);
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
  assert.equal(ps.stdout.trim(), "Bridge 沒在跑，執行 review-bridge up");
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
