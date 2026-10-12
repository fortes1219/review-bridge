import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runtimeSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// A minimal neutral layout: the copied runtime plus a v4 bridge.json with roles and a watch block.
async function workspace(t, watch) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-service-"));
  const runtime = path.join(root, ".review-bridge", "tools", "review-bridge");
  await fsp.cp(runtimeSource, runtime, { recursive: true });
  await fsp.mkdir(path.join(root, ".review-bridge", "review-bridge"), { recursive: true });
  await fsp.writeFile(path.join(root, ".review-bridge", "review-bridge", "bridge.json"), JSON.stringify({
    schema_version: 4,
    state_contract: "v4",
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
  return { root, bridge, privateRoot: path.join(root, ".review-bridge") };
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
  const session = JSON.parse(await fsp.readFile(path.join(privateRoot, "watch-session.json"), "utf8"));
  assert.equal(session.url, url);
  assert.ok(Number.isInteger(session.pid));
  const page = await fetch(url);
  assert.equal(page.status, 200);

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
