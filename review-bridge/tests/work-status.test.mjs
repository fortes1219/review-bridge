import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getBridgePaths } from "../utils/paths.mjs";
import { loadOrCreatePolicySnapshot } from "../service/records/policySnapshots.mjs";
import {
  claimStartAuthorization,
  createAuthorization,
  createImmutableWorkPackage,
} from "../service/records/runStore.mjs";
import {
  createWorkPackagePlan,
  workPackageStatus,
} from "../features/workOrder/workPackage.mjs";

const sourceBridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cleanupRoots = new Set();

test.after(async () => {
  await Promise.all([...cleanupRoots].map((root) => fsp.rm(root, { recursive: true, force: true })));
});

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function makeRuntime(prefix) {
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupRoots.add(repoRoot);
  const bridgeRoot = path.join(repoRoot, ".runtime");
  await fsp.mkdir(path.join(bridgeRoot, "config"), { recursive: true });
  await fsp.copyFile(
    path.join(sourceBridgeRoot, "config", "default-policy.json"),
    path.join(bridgeRoot, "config", "default-policy.json"),
  );
  const paths = getBridgePaths(repoRoot, bridgeRoot, { privateRootName: ".review-bridge" });
  await writeJson(paths.bridgeConfigPath, { schema_version: 4, roles: { writer: { provider_id: "claude" }, reviewer: { provider_id: "codex" } } });
  await writeJson(paths.policyOverridePath, { schema_version: 4 });
  return { repoRoot, bridgeRoot, paths };
}

async function startRun(runtime, { workPackageId, runId, timestamp }) {
  const clock = () => Date.parse(timestamp);
  const { snapshot } = await loadOrCreatePolicySnapshot(runtime.paths);
  const workPackage = await createImmutableWorkPackage(runtime.paths, {
    work_package_id: workPackageId,
    task: "Exercise status ordering.",
    acceptance_criteria: ["status is observable"],
    scope: { change_types: ["tests"], allowed_paths: ["fixture.txt"] },
    budget: { max_claude_calls: 1, max_claude_minutes_per_call: 1 },
    breakpoint: "return to owner",
  }, clock);
  const authorization = await createAuthorization(runtime.paths, {
    authorizedBy: "RC2 Test Owner",
    workPackageSha256: workPackage.record.content_sha256,
    policySha256: snapshot.effective_policy_sha256,
    ttlSeconds: 3600,
  }, clock);
  return await claimStartAuthorization(runtime.paths, authorization.authorization_id, {
    runId,
    sessionId: "session-" + runId,
    executionMode: "fake_cli",
    workspaceEvidence: { test: true },
    clock,
  });
}

test("R1 multiline task files allow newline, tab, and backticks", async () => {
  const runtime = await makeRuntime("review-bridge-r1-");
  const task = [
    "# Work",
    "",
    "Update the `README.md` example.",
    "\tKeep this indented acceptance note.",
  ].join("\n");
  const taskFile = path.join(runtime.paths.privateRoot, "work-packages", "r1.md");
  const outPath = path.join(runtime.paths.queueRoot, "r1.plan.json");
  // A work-order file seals the installed rules and checks that an explicit path exists.
  await fsp.copyFile(path.join(sourceBridgeRoot, "..", "project-templates", "rules.md"), path.join(runtime.paths.configRoot, "rules.md"));
  await fsp.writeFile(path.join(runtime.repoRoot, "README.md"), "# demo\n");
  await fsp.mkdir(path.dirname(taskFile), { recursive: true });
  await fsp.writeFile(taskFile, task, "utf8");
  const plan = await createWorkPackagePlan({
    paths: runtime.paths,
    taskFile,
    owner: "RC2 Test Owner",
    workPackage: "r1-multiline",
    breakpoint: "return after review",
    changeTypes: "docs",
    allowedPaths: "README.md",
    maxCalls: 1,
    maxMinutes: 1,
    outPath,
  });
  assert.equal(plan.task, task);
  assert.equal(typeof plan.plan_sha256, "string");
});

test("R3 work-status selects updated_at newest and lists every run", async () => {
  const runtime = await makeRuntime("review-bridge-r3-");
  await startRun(runtime, {
    workPackageId: "older-package",
    runId: "z-older-run",
    timestamp: "2026-08-28T00:00:00.000Z",
  });
  await startRun(runtime, {
    workPackageId: "newer-package",
    runId: "a-newer-run",
    timestamp: "2026-08-28T01:00:00.000Z",
  });
  const status = await workPackageStatus(runtime.paths);
  assert.equal(status.run_id, "a-newer-run");
  assert.deepEqual(status.runs.map((run) => run.run_id), ["a-newer-run", "z-older-run"]);
  assert.deepEqual(Object.keys(status.runs[0]).sort(), ["run_id", "status", "updated_at", "work_package"]);
});
