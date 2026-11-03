// Keeps the person's database out of these tests (see the fixture).
import "./fixtures/isolatedDataHome.mjs";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertLoopbackBind, findPortOwner, portBumpNotice, startWatchServer, TOKEN_HEADER } from "../features/setupCheck/watchServer.mjs";

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "ui");

function fakeService() {
  const state = { runs: 0, statusCalls: 0, inFlight: false, release: null };
  return {
    state,
    async status() {
      state.statusCalls += 1;
      return { roles: { writer: "claude", reviewer: "codex" }, checks: {}, native_ready: false, probe_available: true };
    },
    async run() {
      state.runs += 1;
      state.inFlight = true;
      if (state.release === null) await new Promise((resolve) => { state.release = resolve; });
      state.inFlight = false;
      return { proven: "unknown", reason: "no_write_attempt", cli_launches: 1 };
    },
    isInFlight: () => state.inFlight,
  };
}

function request(watch, { method = "GET", pathname = "/", headers = {}, body } = {}) {
  const { port } = new URL(watch.url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: pathname, headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function validHeaders(watch, overrides = {}) {
  const origin = watch.url.replace(/\/$/, "");
  return {
    Host: new URL(watch.url).host,
    Origin: origin,
    "Content-Type": "application/json",
    [TOKEN_HEADER]: watch.token,
    ...overrides,
  };
}

const probeBody = (id = "0123456789abcdef-0001") => JSON.stringify({ confirm: "one_model_call", request_id: id });

async function open(t) {
  const service = fakeService();
  const watch = await startWatchServer({ service, uiRoot });
  t.after(() => { service.state.release?.(); return watch.close(); });
  return { service, watch };
}

test("watch refuses remote binds", async () => {
  for (const host of ["0.0.0.0", "::", "192.168.1.10", "localhost"]) {
    assert.throws(() => assertLoopbackBind(host));
    await assert.rejects(startWatchServer({ service: fakeService(), uiRoot, host }));
  }
});

test("page and status load without a model call and show the cost notice", async (t) => {
  const { service, watch } = await open(t);
  const host = new URL(watch.url).host;
  const page = await request(watch, { headers: { Host: host } });
  assert.equal(page.status, 200);
  assert.match(page.body, /確認 reviewer 無法寫入（最多啟動一次 reviewer CLI，可能消耗模型額度）/);
  assert.match(page.body, /每次按下最多啟動一次 reviewer CLI；可能消耗模型額度，實際模型請求次數與 token 無法預先保證；不會自動重試。/);
  assert.ok(page.body.includes(watch.token));
  assert.equal(page.headers["access-control-allow-origin"], undefined);
  assert.equal(page.headers["set-cookie"], undefined);
  const status = await request(watch, { pathname: "/api/status", headers: { Host: host } });
  assert.equal(status.status, 200);
  assert.equal(JSON.parse(status.body).native_ready, false);
  assert.equal(service.state.runs, 0);
  const getProbe = await request(watch, { pathname: "/api/reviewer-probe", headers: { Host: host } });
  assert.equal(getProbe.status, 405);
  assert.equal(service.state.runs, 0);
});

test("foreign host, origin, token, and content type are rejected before any model call", async (t) => {
  const { service, watch } = await open(t);
  const cases = [
    [{ Host: "evil.example:80" }, 421],
    [{ Host: "localhost:" + (Number(new URL(watch.url).port) + 1) }, 421],
    [{ Host: "127.0.0.1:" + new URL(watch.url).port }, 403],
    [{ Origin: "http://evil.example" }, 403],
    [{ Origin: "http://127.0.0.1" }, 403],
    [{ Origin: undefined }, 403],
    [{ [TOKEN_HEADER]: "wrong" }, 403],
    [{ [TOKEN_HEADER]: undefined }, 403],
    [{ "Content-Type": "text/plain" }, 415],
    [{ "Content-Type": "application/x-www-form-urlencoded" }, 415],
  ];
  for (const [override, expected] of cases) {
    const headers = validHeaders(watch, override);
    for (const key of Object.keys(headers)) if (headers[key] === undefined) delete headers[key];
    const response = await request(watch, { method: "POST", pathname: "/api/reviewer-probe", headers, body: probeBody() });
    assert.equal(response.status, expected, JSON.stringify(override));
    assert.equal(response.headers["access-control-allow-origin"], undefined);
  }
  const preflight = await request(watch, { method: "OPTIONS", pathname: "/api/reviewer-probe", headers: validHeaders(watch) });
  assert.equal(preflight.status, 405);
  const unconfirmed = await request(watch, { method: "POST", pathname: "/api/reviewer-probe", headers: validHeaders(watch),
    body: JSON.stringify({ request_id: "0123456789abcdef-0002" }) });
  assert.equal(unconfirmed.status, 400);
  assert.equal(service.state.runs, 0);
});

test("valid request runs once; in-flight and replayed clicks are rejected", async (t) => {
  const { service, watch } = await open(t);
  const first = request(watch, { method: "POST", pathname: "/api/reviewer-probe", headers: validHeaders(watch), body: probeBody("0123456789abcdef-0003") });
  while (!service.state.inFlight) await new Promise((resolve) => setTimeout(resolve, 5));
  const concurrent = await request(watch, { method: "POST", pathname: "/api/reviewer-probe", headers: validHeaders(watch), body: probeBody("0123456789abcdef-0004") });
  assert.equal(concurrent.status, 409);
  assert.equal(JSON.parse(concurrent.body).error, "in_flight");
  service.state.release();
  const done = await first;
  assert.equal(done.status, 200);
  assert.equal(JSON.parse(done.body).result.reason, "no_write_attempt");
  const replay = await request(watch, { method: "POST", pathname: "/api/reviewer-probe", headers: validHeaders(watch), body: probeBody("0123456789abcdef-0003") });
  assert.equal(replay.status, 409);
  assert.equal(JSON.parse(replay.body).error, "replayed_request");
  assert.equal(service.state.runs, 1);
});

test("unsupported reviewer is rejected by the service without a model call", async (t) => {
  const service = fakeService();
  service.run = async () => { const error = new Error("unsupported"); error.code = "unsupported_reviewer"; throw error; };
  const watch = await startWatchServer({ service, uiRoot });
  t.after(() => watch.close());
  const response = await request(watch, { method: "POST", pathname: "/api/reviewer-probe", headers: validHeaders(watch), body: probeBody("0123456789abcdef-0005") });
  assert.equal(response.status, 409);
  assert.equal(JSON.parse(response.body).error, "unsupported_reviewer");
  assert.equal(service.state.runs, 0);
});

test("page states that proof is watch-session only and not human authorization", async (t) => {
  const { watch } = await open(t);
  const page = await request(watch, { headers: { Host: new URL(watch.url).host } });
  assert.match(page.body, /只保存在這次執行中的 watch 程式記憶體/);
  assert.match(page.body, /不代表人類授權/);
});

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function occupy(port) {
  const blocker = net.createServer();
  await new Promise((resolve, reject) => { blocker.once("error", reject); blocker.listen(port, "127.0.0.1", resolve); });
  return blocker;
}

test("configured port is honoured and the URL uses the localhost form", async (t) => {
  const port = await freePort();
  const watch = await startWatchServer({ service: fakeService(), uiRoot, port });
  t.after(() => watch.close());
  assert.equal(watch.url, `http://localhost:${port}/`);
  assert.equal(watch.port, port);
  assert.equal(watch.bumped, false);
});

test("T5 /api/status carries the service identity the session record is checked against", async (t) => {
  const port = await freePort();
  const serviceId = "ab".repeat(16);
  const watch = await startWatchServer({ service: fakeService(), uiRoot, port, serviceId });
  t.after(() => watch.close());
  assert.equal(watch.serviceId, serviceId);
  const status = await request(watch, { pathname: "/api/status", headers: { Host: `localhost:${port}` } });
  assert.equal(status.status, 200);
  const body = JSON.parse(status.body);
  assert.equal(body.service_id, serviceId);
  assert.equal(body.pid, process.pid);
  assert.equal(body.port, port);
  const generated = await startWatchServer({ service: fakeService(), uiRoot });
  t.after(() => generated.close());
  assert.match(generated.serviceId, /^[0-9a-f]{32}$/);
  await assert.rejects(startWatchServer({ service: fakeService(), uiRoot, serviceId: "short" }), /service id/);
});


test("occupied port bumps to the next free one unless strict", async (t) => {
  const port = await freePort();
  const blocker = await occupy(port);
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const watch = await startWatchServer({ service: fakeService(), uiRoot, port });
  t.after(() => watch.close());
  assert.equal(watch.bumped, true);
  assert.equal(watch.requestedPort, port);
  assert.ok(watch.port > port);
  assert.equal(watch.url, `http://localhost:${watch.port}/`);
  await assert.rejects(startWatchServer({ service: fakeService(), uiRoot, port, strictPort: true }),
    (error) => error.code === "port_in_use" && /strict_port/.test(error.message));
});

// No limit of its own, as Vite and the database: past the 20 it used to give up after.
test("with the start port and the 20 above it taken, the page takes the 22nd", async (t) => {
  let start;
  let blockers;
  // A run of 22 free ports in a row, found by taking them; the last one is let go again.
  for (let attempt = 0; attempt < 20 && !blockers; attempt += 1) {
    start = 20000 + Math.floor(Math.random() * 40000);
    const taken = [];
    try {
      for (let offset = 0; offset < 22; offset += 1) taken.push(await occupy(start + offset));
      await new Promise((resolve) => taken.pop().close(resolve));
      blockers = taken;
    } catch {
      await Promise.all(taken.map((blocker) => new Promise((resolve) => blocker.close(resolve))));
    }
  }
  assert.ok(blockers, "no run of 22 free ports was found");
  t.after(() => Promise.all(blockers.map((blocker) => new Promise((resolve) => blocker.close(resolve)))));
  const watch = await startWatchServer({ service: fakeService(), uiRoot, port: start });
  t.after(() => watch.close());
  assert.equal(watch.port, start + 21);
  assert.equal(watch.bumped, true);
});

test("Host localhost and 127.0.0.1 are both accepted; the probe origin must match the Host used", async (t) => {
  const { service, watch } = await open(t);
  const { port } = new URL(watch.url);
  for (const host of ["localhost:" + port, "127.0.0.1:" + port]) {
    const page = await request(watch, { headers: { Host: host } });
    assert.equal(page.status, 200, host);
  }
  const viaLoopback = request(watch, { method: "POST", pathname: "/api/reviewer-probe",
    headers: validHeaders(watch, { Host: "127.0.0.1:" + port, Origin: "http://127.0.0.1:" + port }),
    body: probeBody("0123456789abcdef-0006") });
  while (!service.state.inFlight) await new Promise((resolve) => setTimeout(resolve, 5));
  service.state.release();
  assert.equal((await viaLoopback).status, 200);
  assert.equal(service.state.runs, 1);
});

test("bump notice names the occupier when known and omits it otherwise", () => {
  assert.equal(portBumpNotice(9100, "http://localhost:9101/", "node.exe"), "9100 被 node.exe 占用，改用 http://localhost:9101/");
  assert.equal(portBumpNotice(9100, "http://localhost:9101/", null), "9100 被占用，改用 http://localhost:9101/");
  assert.equal(findPortOwner(9100, "linux"), null);
});

test("T0-11 E1 probe_not_started is a 409 the page may call 'no model used'; any other failure is a 500 probe_failed", async (t) => {
  const service = fakeService();
  service.run = async () => { const error = new Error("no temp folder"); error.code = "probe_not_started"; throw error; };
  const watch = await startWatchServer({ service, uiRoot });
  t.after(() => watch.close());
  const notStarted = await request(watch, { method: "POST", pathname: "/api/reviewer-probe", headers: validHeaders(watch), body: probeBody("0123456789abcdef-0101") });
  assert.equal(notStarted.status, 409);
  assert.equal(JSON.parse(notStarted.body).error, "probe_not_started");
  service.run = async () => { throw new Error("something after the call"); };
  const failed = await request(watch, { method: "POST", pathname: "/api/reviewer-probe", headers: validHeaders(watch), body: probeBody("0123456789abcdef-0102") });
  assert.equal(failed.status, 500);
  assert.equal(JSON.parse(failed.body).error, "probe_failed");
});

test("a platform whose adapter is not verified is refused by the service without a model call", async (t) => {
  const service = fakeService();
  service.run = async () => { const error = new Error("not verified"); error.code = "adapter_not_verified"; throw error; };
  const watch = await startWatchServer({ service, uiRoot });
  t.after(() => watch.close());
  const response = await request(watch, { method: "POST", pathname: "/api/reviewer-probe", headers: validHeaders(watch), body: probeBody("0123456789abcdef-0201") });
  assert.equal(response.status, 409);
  assert.equal(JSON.parse(response.body).error, "adapter_not_verified");
  assert.equal(service.state.runs, 0);
});
