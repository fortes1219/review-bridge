import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAdapterForInspection, resolveAdapterModule, selectAdapter, targetKey, UNSUPPORTED_ADAPTER } from "../router/platform.mjs";
import * as darwinAdapter from "../platforms/darwin-arm64/adapter.mjs";

const manifest = {
  schema_version: 2,
  adapters: {
    "win32-x64": {
      id: "win32-node",
      module: "./platforms/win32-x64/adapter.mjs",
      status: "active",
    },
    "darwin-arm64": {
      id: "darwin-arm64-node",
      module: "./platforms/darwin-arm64/adapter.mjs",
      status: "candidate",
    },
    "linux-x64": {
      id: "linux-x64-node",
      module: "./platforms/linux-x64/adapter.mjs",
      status: "experimental",
    },
  },
};

test("builds a stable target key", () => {
  assert.equal(targetKey("win32", "x64"), "win32-x64");
});

test("selects the active Windows adapter", () => {
  const selected = selectAdapter(manifest, "win32", "x64");
  assert.equal(selected.target, "win32-x64");
  assert.equal(selected.id, "win32-node");
});

test("selects the Darwin candidate adapter without claiming native verification", () => {
  const selected = selectAdapter(manifest, "darwin", "arm64");
  assert.equal(selected.target, "darwin-arm64");
  assert.equal(selected.status, "candidate");
});

test("fails closed for an unavailable target", () => {
  assert.throws(
    () => selectAdapter(manifest, "linux", "x64"),
    /No active review bridge adapter for linux-x64/,
  );
});

test("rejects adapter paths outside the bridge root", () => {
  assert.throws(
    () => resolveAdapterModule("C:\\repo\\bridge", "../../outside.mjs"),
    /escaped the review bridge root/,
  );
});

test("darwin-arm64 adapter satisfies the contract with explicit CLI paths", async () => {
  const previousCodex = process.env.CODEX_REVIEW_CLI;
  const previousClaude = process.env.CLAUDE_REVIEW_CLI;
  process.env.CODEX_REVIEW_CLI = process.execPath;
  process.env.CLAUDE_REVIEW_CLI = process.execPath;
  try {
    assert.equal(await darwinAdapter.resolveExecutable("codex"), process.execPath);
    assert.equal(await darwinAdapter.resolveExecutable("claude"), process.execPath);
    assert.deepEqual(
      darwinAdapter.buildInvocation("codex", process.execPath, ["--version"]),
      { command: process.execPath, args: ["--version"], env: process.env },
    );
    assert.equal(typeof darwinAdapter.notify, "function");
  } finally {
    if (previousCodex === undefined) delete process.env.CODEX_REVIEW_CLI;
    else process.env.CODEX_REVIEW_CLI = previousCodex;
    if (previousClaude === undefined) delete process.env.CLAUDE_REVIEW_CLI;
    else process.env.CLAUDE_REVIEW_CLI = previousClaude;
  }
});

// RC3-LINUX-00: the page and the checks that call no model run on any defined platform; only an
// adapter the manifest marks active or candidate is eligible to call a model.
test("the adapter for model-free checks: any defined platform, eligible only by the manifest's status", async () => {
  const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const linux = loadAdapterForInspection(manifest, "linux", "x64", { bridgeRoot });
  assert.deepEqual([linux.target, linux.status, linux.eligible], ["linux-x64", "experimental", false]);
  assert.equal(loadAdapterForInspection(manifest, "win32", "x64", { bridgeRoot }).eligible, true);
  assert.equal(loadAdapterForInspection(manifest, "darwin", "arm64", { bridgeRoot }).eligible, true);
  // A definition cannot make itself eligible.
  const claims = { ...manifest, adapters: { ...manifest.adapters, "linux-x64": { ...manifest.adapters["linux-x64"], eligible: true } } };
  assert.equal(loadAdapterForInspection(claims, "linux", "x64", { bridgeRoot }).eligible, false);
  // No definition, or a module that is not there: null, never an error.
  assert.equal(loadAdapterForInspection(manifest, "linux", "arm64", { bridgeRoot }), null);
  const gone = { ...manifest, adapters: { "linux-x64": { ...manifest.adapters["linux-x64"], module: "./platforms/nowhere/adapter.mjs" } } };
  assert.equal(loadAdapterForInspection(gone, "linux", "x64", { bridgeRoot }), null);
  await assert.rejects(UNSUPPORTED_ADAPTER.resolveExecutable("codex"));
  assert.throws(() => UNSUPPORTED_ADAPTER.buildInvocation("codex", "codex", []));
  // Model commands still take only an active or candidate adapter.
  assert.throws(() => selectAdapter(manifest, "linux", "x64"), /No active review bridge adapter for linux-x64/);
});
