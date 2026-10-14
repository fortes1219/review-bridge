import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { dispatchCommand } from "../core/commands.mjs";
import { writeJson } from "../core/io.mjs";
import { getBridgePaths } from "../core/paths.mjs";
import { assertNativeAllowed, checkReviewerProof, NATIVE_MODEL_COMMANDS, nativeGateDecision } from "../core/native-gate.mjs";
import { writeServiceSession } from "../core/service.mjs";

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tty = { stdinIsTTY: true, stdoutIsTTY: true };

test("G1 native work-start is allowed only without --approve/--yes at an interactive terminal", () => {
  assert.deepEqual(nativeGateDecision({ command: "work-start", args: ["--plan", "p"], ...tty }), { allowed: true, mode: "native_terminal" });
  for (const flag of ["--approve", "--yes"]) {
    const decision = nativeGateDecision({ command: "work-start", args: ["--plan", "p", flag, "x"], ...tty });
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, "flag_confirmation");
    assert.match(decision.message, /^Native execution is unavailable with --approve or --yes/);
  }
  for (const io of [{ stdinIsTTY: false, stdoutIsTTY: true }, { stdinIsTTY: true, stdoutIsTTY: false }, { stdinIsTTY: false, stdoutIsTTY: false }]) {
    const decision = nativeGateDecision({ command: "work-start", args: ["--plan", "p"], ...io });
    assert.equal(decision.allowed, false, JSON.stringify(io));
    assert.equal(decision.reason, "not_a_terminal");
  }
});

test("G1 every other model entry point is closed in native mode, even at a terminal", () => {
  for (const command of NATIVE_MODEL_COMMANDS.filter((name) => name !== "work-start")) {
    const decision = nativeGateDecision({ command, args: [], ...tty });
    assert.equal(decision.allowed, false, command);
    assert.equal(decision.reason, "entry_point");
    assert.match(decision.message, new RegExp("for " + command + ": only work-start"));
  }
  assert.deepEqual([...NATIVE_MODEL_COMMANDS].sort(), ["bounded-resume", "enqueue", "review", "work-start"]);
});

test("G1 fake mode and model-free commands are unchanged", () => {
  for (const command of NATIVE_MODEL_COMMANDS) {
    assert.equal(nativeGateDecision({ command, args: ["--fake-cli", "--approve", "x", "--yes"] }).allowed, true, command);
  }
  for (const command of ["work-plan", "work-status", "work-cancel", "stop", "prune", "rm", "ps", "up", "down"]) {
    assert.equal(nativeGateDecision({ command, args: [] }).allowed, true, command);
  }
  assert.throws(() => assertNativeAllowed({ command: "review", args: [] }), (error) => error.nativeGate === "entry_point");
});

test("G3 dispatchCommand refuses native work-start on its own, without bootstrap, and creates no authorization", async (t) => {
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-native-gate-"));
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  const paths = getBridgePaths(repoRoot, bridgeRoot);
  await writeJson(paths.bridgeConfigPath, { schema_version: 4, state_contract: "v4", active_runs: "derive_from_run_projections" });
  const adapter = { id: "test", async resolveExecutable() { return process.execPath; }, buildInvocation() {}, async notify() {} };
  await assert.rejects(
    dispatchCommand({ command: "work-start", args: ["--plan", "x", "--approve", "x"], repoRoot, bridgeRoot, adapter }),
    /with --approve or --yes/,
  );
  await assert.rejects(
    dispatchCommand({ command: "work-start", args: ["--plan", "x", "--yes"], repoRoot, bridgeRoot, adapter }),
    /with --approve or --yes/,
  );
  // The test runner's stdin is not a terminal, so the plain form is refused here too.
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    await assert.rejects(
      dispatchCommand({ command: "work-start", args: ["--plan", "x"], repoRoot, bridgeRoot, adapter }),
      /must run at an interactive terminal/,
    );
  }
  const authorizations = await fsp.readdir(paths.authorizationsDir).catch(() => []);
  assert.deepEqual(authorizations, []);
});

// A minimal page service: answers /api/status with the identity fields and a given proof state.
async function pageService(t, paths, { state, proven, serviceId = "a".repeat(32), answerId = serviceId }) {
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, reviewer_readonly_proven: proven, reviewer_readonly: { state }, service_id: answerId, pid: process.pid }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  await writeServiceSession(paths, { pid: process.pid, port, url: "http://127.0.0.1:" + port + "/", service_id: serviceId, started_at: new Date().toISOString() });
}

async function v4Paths(t) {
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-native-proof-"));
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  const paths = getBridgePaths(repoRoot, bridgeRoot);
  await writeJson(paths.bridgeConfigPath, { schema_version: 4, state_contract: "v4", active_runs: "derive_from_run_projections" });
  return { repoRoot, paths };
}

test("G4 the reviewer proof comes only from the running page service with a matching identity", async (t) => {
  const none = await v4Paths(t);
  assert.deepEqual(await checkReviewerProof(none.paths).then(({ ok, reason, detail }) => ({ ok, reason, detail })), { ok: false, reason: "watch_not_running", detail: "no_session" });
  for (const [state, proven] of [["not_run", "not_run"], ["stale", false], ["failed", false], ["unknown", false]]) {
    const rt = await v4Paths(t);
    await pageService(t, rt.paths, { state, proven });
    const result = await checkReviewerProof(rt.paths);
    assert.equal(result.ok, false, state);
    assert.equal(result.reason, "reviewer_not_proven");
    assert.equal(result.detail, state);
  }
  // A look-alike on the port with another service id is not the Bridge page.
  const imposter = await v4Paths(t);
  await pageService(t, imposter.paths, { state: "proven", proven: true, answerId: "b".repeat(32) });
  assert.deepEqual((({ ok, reason, detail }) => ({ ok, reason, detail }))(await checkReviewerProof(imposter.paths)), { ok: false, reason: "watch_not_running", detail: "wrong_service" });
  // A Boolean without the proven state (or the reverse) is not a proof.
  const half = await v4Paths(t);
  await pageService(t, half.paths, { state: "not_run", proven: true });
  assert.equal((await checkReviewerProof(half.paths)).ok, false);
  const proven = await v4Paths(t);
  await pageService(t, proven.paths, { state: "proven", proven: true });
  assert.equal((await checkReviewerProof(proven.paths)).ok, true);
});

test("G5 at an interactive terminal, native work-start still refuses until the page reports the proof", async (t) => {
  const rt = await v4Paths(t);
  const adapter = { id: "test", async resolveExecutable() { return process.execPath; }, buildInvocation() {}, async notify() {} };
  const saved = { stdin: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"), stdout: Object.getOwnPropertyDescriptor(process.stdout, "isTTY") };
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  try {
    await assert.rejects(
      dispatchCommand({ command: "work-start", args: ["--plan", "x"], repoRoot: rt.repoRoot, bridgeRoot, adapter }),
      /Bridge page service is not running/,
    );
    await pageService(t, rt.paths, { state: "not_run", proven: "not_run" });
    await assert.rejects(
      dispatchCommand({ command: "work-start", args: ["--plan", "x"], repoRoot: rt.repoRoot, bridgeRoot, adapter }),
      /reviewer read-only check has not passed .*state: not_run/,
    );
  } finally {
    for (const [stream, descriptor] of [[process.stdin, saved.stdin], [process.stdout, saved.stdout]]) {
      if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
      else delete stream.isTTY;
    }
  }
  assert.deepEqual(await fsp.readdir(rt.paths.authorizationsDir).catch(() => []), []);
});
