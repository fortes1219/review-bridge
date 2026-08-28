import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getBridgePaths } from "../review-bridge/core/paths.mjs";
import { loadOrCreatePolicySnapshot } from "../review-bridge/core/policy-v4.mjs";
import {
  claimStartAuthorization,
  createAuthorization,
  createImmutableWorkPackage,
} from "../review-bridge/core/state-v4.mjs";
import {
  createV4WorkPackagePlan,
  v4WorkPackageStatus,
} from "../review-bridge/core/work-package-v4.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(packageRoot, "installer", "install.mjs");
const cleanupRoots = new Set();

test.after(async () => {
  await Promise.all([...cleanupRoots].map((root) => fsp.rm(root, { recursive: true, force: true })));
});

function runInstaller(args) {
  return spawnSync(process.execPath, [installer, ...args], {
    cwd: packageRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

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
    path.join(packageRoot, "review-bridge", "config", "default-policy.json"),
    path.join(bridgeRoot, "config", "default-policy.json"),
  );
  const paths = getBridgePaths(repoRoot, bridgeRoot);
  await writeJson(paths.bridgeConfigPath, { schema_version: 4, state_contract: "v4" });
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
  await fsp.mkdir(path.dirname(taskFile), { recursive: true });
  await fsp.writeFile(taskFile, task, "utf8");
  const plan = await createV4WorkPackagePlan({
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
  const status = await v4WorkPackageStatus(runtime.paths);
  assert.equal(status.run_id, "a-newer-run");
  assert.deepEqual(status.runs.map((run) => run.run_id), ["a-newer-run", "z-older-run"]);
  assert.deepEqual(Object.keys(status.runs[0]).sort(), ["run_id", "status", "updated_at", "work_package"]);
});

test("R4 preflight blocker is one readable line unless --json is requested", async () => {
  const target = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-r4-"));
  cleanupRoots.add(target);
  await writeJson(path.join(target, "package.json"), {
    private: true,
    dependencies: { vue: "latest" },
    devDependencies: { vite: "latest", typescript: "latest" },
  });
  spawnSync("git", ["init"], { cwd: target, stdio: "ignore" });
  await fsp.writeFile(path.join(target, ".gitignore"), "dist/\n", "utf8");
  const out = path.join(target, "preflight.plan.json");
  const result = runInstaller([
    "plan", "--target", target, "--profile", "vue-frontend", "--fake-cli", "--out", out,
  ]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim().split(/\r?\n/).length, 1);
  assert.match(result.stderr, /Add `.claude\/` to .gitignore and re-run init\./);
  assert.equal((JSON.parse(await fsp.readFile(out, "utf8"))).findings[0].severity, "BLOCKER");

  await fsp.writeFile(path.join(target, ".gitignore"), ".claude/\n", "utf8");
  const readyOut = path.join(target, "ready.plan.json");
  const ready = runInstaller([
    "plan", "--target", target, "--profile", "vue-frontend", "--fake-cli", "--out", readyOut,
  ]);
  assert.equal(ready.status, 0, ready.stderr);
  assert.equal(ready.stdout.trim().split(/\r?\n/).length, 1);
  assert.match(ready.stdout, /^Plan ready: [a-f0-9]{64}\./);
  assert.equal(ready.stdout.includes("{"), false);
});

test("R6 verify exposes installed verification errors", async () => {
  const target = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-r6-errors-"));
  const backup = target + "-backups";
  cleanupRoots.add(target);
  cleanupRoots.add(backup);
  await writeJson(path.join(target, "package.json"), {
    private: true,
    dependencies: { vue: "latest" },
    devDependencies: { vite: "latest", typescript: "latest" },
  });
  const planPath = path.join(target, "install.plan.json");
  const planned = runInstaller([
    "plan", "--target", target, "--profile", "vue-frontend", "--fake-cli", "--json",
    "--backup-root", backup, "--out", planPath,
  ]);
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout);
  const applied = runInstaller([
    "apply", "--target", target, "--plan", planPath, "--approve", plan.plan_sha256,
  ]);
  assert.equal(applied.status, 0, applied.stderr);
  await fsp.appendFile(path.join(target, ".claude", "tools", "review-bridge", "core", "doctor.mjs"), "\n// test mutation\n");
  const verified = runInstaller(["verify", "--target", target, "--fake-cli"]);
  assert.equal(verified.status, 2);
  assert.match(verified.stderr, /modified owned file:.*doctor\.mjs/i);
});

const manifest = JSON.parse(await fsp.readFile(path.join(packageRoot, "review-bridge", "manifest.json"), "utf8"));
const targetDefinition = manifest.adapters?.[process.platform + "-" + process.arch];
const unavailable = ["claude", "codex"].filter((command) => {
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  return result.error || result.status !== 0;
});
const nativeSkipReason = !targetDefinition || !["active", "candidate"].includes(targetDefinition.status)
  ? `native adapter is ${targetDefinition?.status || "unsupported"} on ${process.platform}-${process.arch}`
  : unavailable.length
    ? `native CLI unavailable: ${unavailable.join(", ")}`
    : false;

test("R6 native installer verification skips with an explicit reason when CLIs are unavailable", {
  skip: nativeSkipReason,
}, async () => {
  const target = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-r6-native-"));
  const backup = target + "-backups";
  cleanupRoots.add(target);
  cleanupRoots.add(backup);
  await writeJson(path.join(target, "package.json"), {
    private: true,
    dependencies: { vue: "latest" },
    devDependencies: { vite: "latest", typescript: "latest" },
  });
  const planPath = path.join(target, "install.plan.json");
  const planned = runInstaller([
    "plan", "--target", target, "--profile", "vue-frontend", "--json",
    "--backup-root", backup, "--out", planPath,
  ]);
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout);
  const applied = runInstaller([
    "apply", "--target", target, "--plan", planPath, "--approve", plan.plan_sha256,
  ]);
  assert.equal(applied.status, 0, applied.stderr);
  const verified = runInstaller(["verify", "--target", target]);
  assert.equal(verified.status, 0, verified.stderr);
});
