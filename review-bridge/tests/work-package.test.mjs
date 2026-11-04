// Keeps the person's database out of these tests (see the fixture).
import "./fixtures/isolatedDataHome.mjs";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readJson, writeJson } from "../service/records/fileStore.mjs";
import { getBridgePaths } from "../utils/paths.mjs";
import { spawn, spawnSync } from "node:child_process";

import { consumeRun, readRun } from "../service/records/runStore.mjs";
import { isPidAlive } from "../service/agentCli/process.mjs";
import { recordProcessOrKill, runMustStop } from "../features/workOrder/writerLoop.mjs";
import { authorizeWorkPackage, createWorkPackagePlan, FORBIDDEN_PATHS } from "../features/workOrder/workPackage.mjs";
import { createWorkspaceBaseline, createWorkspaceDelta, matchesForbiddenPath, recordWindow, snapshotWorkspace } from "../features/workOrder/workspaceEvidence.mjs";
import { headCommit, isGitWorkTree } from "../features/workOrder/gitWorkspace.mjs";

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.resolve(bridgeRoot, "..");

async function runtime(t) {
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-wp-"));
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  const paths = getBridgePaths(repoRoot, bridgeRoot, { privateRootName: ".review-bridge" });
  await writeJson(paths.bridgeConfigPath, { project_id: randomUUID(),
    schema_version: 4, active_runs: "derive_from_run_projections",
    roles: { writer: { provider_id: "claude" }, reviewer: { provider_id: "codex" } },
    test: { profile_id: "node-backend", rules: [{ command: "npm test", package_script: "test" }] },
  });
  await fsp.writeFile(path.join(repoRoot, "package.json"), JSON.stringify({ name: "wp", scripts: { test: "node -e \"process.exit(0)\"" } }));
  await writeJson(paths.policyOverridePath, { schema_version: 5 });
  await fsp.copyFile(path.join(packageRoot, "project-templates", "rules.md"), paths.rulesPath);
  await fsp.mkdir(path.join(repoRoot, "src", "game"), { recursive: true });
  await fsp.writeFile(path.join(repoRoot, "src", "game", "farm.js"), "// farm\n");
  await fsp.writeFile(path.join(repoRoot, "src", "index.js"), "// index\n");
  await fsp.writeFile(path.join(repoRoot, "README.md"), "# demo\n");
  await fsp.writeFile(path.join(repoRoot, "package-lock.json"), "{}\n");
  return { repoRoot, paths };
}

// A work order in the human template's shape; any headings and any language would do.
function order({ references = "" } = {}) {
  return `# Work order: farm

## Work

Build a small farm.

## Acceptance

- The farm is visible.

## References, attachments and dependencies (optional)

${references}
`;
}

async function plan(runtime, { task, allowedPaths, id = "wp-" + Math.random().toString(16).slice(2, 8) } = {}) {
  const taskFile = path.join(runtime.paths.privateRoot, id + ".md");
  await fsp.writeFile(taskFile, task);
  return await createWorkPackagePlan({
    paths: runtime.paths,
    taskFile,
    owner: "Fortes",
    workPackage: id,
    breakpoint: "return after review",
    allowedPaths,
    rounds: 1,
    callTimeout: 300_000,
    outPath: path.join(runtime.paths.privateRoot, id + ".plan.json"),
  });
}

test("T6 default scope is everything minus the fixed forbidden list", async (t) => {
  const r = await runtime(t);
  const created = await plan(r, { task: order() });
  assert.deepEqual(created.scope.allowed_paths, ["**"]);
  assert.deepEqual(created.scope.forbidden_paths, [...FORBIDDEN_PATHS]);
  assert.equal(created.scope.source, "default");
  // The work order is sealed as text; it becomes a contract only after the human starts the work.
  assert.match(created.task_file, /\.md$/);
  assert.equal(created.work_order, undefined);
  for (const forbidden of [".git/config", ".env", ".env.local", "deploy/key.pem", "package-lock.json", "a/b/package-lock.json",
    ".github/workflows/ci.yml", "Dockerfile", "Dockerfile.dev", "infra/main.tf", ".review-bridge/x", ".claude/settings.json"]) {
    assert.equal(matchesForbiddenPath(forbidden, FORBIDDEN_PATHS), true, forbidden);
  }
  for (const allowed of ["src/index.js", "docs/env.md", "README.md", "package.json", "src/lockfile.js"]) {
    assert.equal(matchesForbiddenPath(allowed, FORBIDDEN_PATHS), false, allowed);
  }
});

test("T6b the forbidden list ignores case, as Git does on Windows: .ENV and dockerfile are forbidden", () => {
  for (const forbidden of [".ENV", ".Env.Local", "Dockerfile", "dockerfile", "DOCKERFILE.dev", "deploy/KEY.PEM", ".GitHub/workflows/ci.yml"]) {
    assert.equal(matchesForbiddenPath(forbidden, FORBIDDEN_PATHS), true, forbidden);
  }
  assert.equal(matchesForbiddenPath("docs/ENV.md", FORBIDDEN_PATHS), false);
});

test("T7 paths written in a work order are context: they neither narrow the scope nor get sealed", async (t) => {
  const r = await runtime(t);
  const created = await plan(r, { task: order({ references: "- src/game/\n- 照首頁的做法\nREADME.md" }) });
  assert.deepEqual(created.scope.allowed_paths, ["**"]);
  assert.equal(created.scope.source, "default");
  assert.equal(created.references, undefined);
});

test("T8 an explicit --allow-paths must exist and stay out of the forbidden list", async (t) => {
  const r = await runtime(t);
  const explicit = await plan(r, { task: order({ references: "src/" }), allowedPaths: "src/game/farm.js" });
  assert.deepEqual(explicit.scope.allowed_paths, ["src/game/farm.js"]);
  assert.equal(explicit.scope.source, "explicit");
  await assert.rejects(plan(r, { task: order(), allowedPaths: "src/missing.js" }), /允許路徑不存在/);
  await assert.rejects(plan(r, { task: order(), allowedPaths: "package-lock.json" }), /禁改清單/);
  // A path the work order mentions does not limit what --allow-paths may name.
  const outside = await plan(r, { task: order({ references: "src/game/" }), allowedPaths: "README.md" });
  assert.deepEqual(outside.scope.allowed_paths, ["README.md"]);
  // Legacy inline task without markers still needs an explicit scope.
  await assert.rejects(createWorkPackagePlan({
    paths: r.paths, task: "plain task", owner: "o", workPackage: "legacy-1", breakpoint: "b",
    rounds: 1, callTimeout: 300_000, outPath: path.join(r.paths.privateRoot, "legacy.plan.json"),
  }), /allowed path is required/);
});

test("T9 the plan seals the rules digest and the work-order text; a changed work order changes the sha", async (t) => {
  const r = await runtime(t);
  const first = await plan(r, { task: order({ references: "src/game/farm.js" }), id: "seal-a" });
  assert.equal(first.rules.path, ".review-bridge/rules.md");
  assert.match(first.rules.sha256, /^[0-9a-f]{64}$/);
  assert.match(first.rules.text, /規則摘要/);
  const second = await plan(r, { task: order({ references: "src/game/farm.js\n- one more line" }), id: "seal-b" });
  assert.notEqual(first.task_sha256, second.task_sha256);
  const firstDigestInput = { ...first, plan_sha256: undefined, proposed_run_id: 0, proposed_session_id: 0, created_at: 0, work_package_id: 0, authorization_expires_at: 0 };
  const secondDigestInput = { ...second, plan_sha256: undefined, proposed_run_id: 0, proposed_session_id: 0, created_at: 0, work_package_id: 0, authorization_expires_at: 0 };
  assert.notDeepEqual(firstDigestInput, secondDigestInput);
});

test("T10 authorize fails closed when the work order or rules.md changed after the plan was built", async (t) => {
  const r = await runtime(t);
  const sealed = await plan(r, { task: order(), id: "stale-order" });
  // A file the work order mentions may change freely; it is context, not part of the seal.
  await fsp.writeFile(path.join(r.repoRoot, "src", "game", "farm.js"), "// changed after the plan\n");
  await fsp.appendFile(path.join(r.paths.privateRoot, "stale-order.md"), "- One more acceptance line.\n");
  await assert.rejects(authorizeWorkPackage({ paths: r.paths, planPath: sealed.plan_path, approval: sealed.plan_sha256, executionMode: "fake_cli" }),
    /The work order \.review-bridge\/stale-order\.md changed after the plan was built\. Build a new plan\./);
  const sealedRules = await plan(r, { task: order(), id: "stale-rules" });
  await fsp.appendFile(r.paths.rulesPath, "\n再加一條。\n");
  await assert.rejects(authorizeWorkPackage({ paths: r.paths, planPath: sealedRules.plan_path, approval: sealedRules.plan_sha256, executionMode: "fake_cli" }),
    /批准後 \.review-bridge\/rules\.md 變了/);
});

test("T11 a missing, empty or oversized rules.md stops work-plan", async (t) => {
  const r = await runtime(t);
  const rules = r.paths.rulesPath;
  await fsp.rm(rules);
  await assert.rejects(plan(r, { task: order() }), /規則摘要檔不見了/);
  await fsp.writeFile(rules, "   \n");
  await assert.rejects(plan(r, { task: order() }), /規則摘要檔是空的/);
  await fsp.writeFile(rules, "x".repeat(4001));
  await assert.rejects(plan(r, { task: order() }), /超過 4000 字/);
});

test("T12 authorized_by is the OS user and authorized_via records how work-start was answered", async (t) => {
  const r = await runtime(t);
  const a = await plan(r, { task: order({ references: "src/game/farm.js" }), id: "auth-a" });
  const started = await authorizeWorkPackage({ paths: r.paths, planPath: a.plan_path, approval: a.plan_sha256, executionMode: "fake_cli", authorizedVia: "approve_flag" });
  assert.equal(started.authorization.authorized_by, os.userInfo().username);
  assert.equal(started.authorization.authorized_via, "approve_flag");
  assert.notEqual(started.authorization.authorized_by, "Fortes-typed-into-the-plan");
  const run = await readRun(r.paths, started.run.run_id);
  assert.equal(run.authorized_by, os.userInfo().username);
  assert.equal(run.authorized_via, "approve_flag");
  const b = await plan(r, { task: order({ references: "src/game/farm.js" }), id: "auth-b" });
  const viaYes = await authorizeWorkPackage({ paths: r.paths, planPath: b.plan_path, approval: b.plan_sha256, executionMode: "fake_cli", authorizedVia: "yes_flag" });
  assert.equal(viaYes.authorization.authorized_via, "yes_flag");
  assert.equal((await readJson(path.join(r.paths.authorizationsDir, viaYes.authorization.authorization_id + ".json"))).authorized_via, "yes_flag");
});

test("T13 the workspace delta flags a forbidden path as a scope violation even inside the allowed scope", async (t) => {
  const r = await runtime(t);
  const git = (...args) => spawnSync("git", args, { cwd: r.repoRoot, windowsHide: true });
  git("init", "-q");
  await fsp.appendFile(path.join(r.repoRoot, ".git", "info", "exclude"), "\n/.review-bridge/\n");
  git("add", "-A");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "fixture");
  const baseline = await createWorkspaceBaseline({ paths: r.paths, planSha256: "f".repeat(64), runId: "run-t13", allowedPaths: ["**"], forbiddenPaths: [...FORBIDDEN_PATHS] });
  // The edits happen during one of the run's own calls, so they are the run's.
  const before = await snapshotWorkspace(r.paths, baseline.baseline_path);
  await fsp.writeFile(path.join(r.repoRoot, "package-lock.json"), "{\"changed\":true}\n");
  await fsp.writeFile(path.join(r.repoRoot, "src", "index.js"), "// edited\n");
  await fsp.writeFile(path.join(r.repoRoot, ".env"), "SECRET=1\n");
  await recordWindow(r.paths, baseline.baseline_path, { runId: "run-t13", call: 1, phase: "writer", before });
  const delta = await createWorkspaceDelta({ paths: r.paths, baselinePath: baseline.baseline_path, deltaId: "t13" });
  assert.deepEqual(delta.scope_violations, [".env", "package-lock.json"]);
  assert.ok(delta.changed_paths.includes("src/index.js"));
});

// The calling side of the stop protocol for writer and test processes: a process that starts
// around a stop (the stop command may already have looked for a pid) is killed once it is recorded.
test("a writer or test process recorded after its run was stopped is killed; one in a running run is left alone", { timeout: 30_000 }, async (t) => {
  const r = await runtime(t);
  const sleeper = () => spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { windowsHide: true, stdio: "ignore" });
  const waitExit = (child) => new Promise((resolve) => child.once("exit", resolve));
  const running = await plan(r, { task: order(), id: "proc-running" });
  const live = await authorizeWorkPackage({ paths: r.paths, planPath: running.plan_path, approval: running.plan_sha256, executionMode: "fake_cli" });
  const kept = sleeper();
  t.after(() => { try { kept.kill(); } catch {} });
  await recordProcessOrKill(r.paths, live.run.run_id, { pid: kept.pid, role: "writer", provider: "claude", call: 1 });
  assert.equal(isPidAlive(kept.pid), true);
  await consumeRun(r.paths, live.run.run_id, "cancelled", null);
  const stopping = await plan(r, { task: order(), id: "proc-stopped" });
  const stopped = await authorizeWorkPackage({ paths: r.paths, planPath: stopping.plan_path, approval: stopping.plan_sha256, executionMode: "fake_cli" });
  await consumeRun(r.paths, stopped.run.run_id, "stopped", null);
  const late = sleeper();
  const exited = waitExit(late);
  await recordProcessOrKill(r.paths, stopped.run.run_id, { pid: late.pid, role: "writer", provider: "claude", call: 1 });
  await exited;
  assert.equal(isPidAlive(late.pid), false);
});

// The status check fails closed: a run whose record cannot be read is treated as stopped.
test("a process whose run record cannot be read is killed; the stop check never reads an unknown status as running", { timeout: 30_000 }, async (t) => {
  const r = await runtime(t);
  const running = await plan(r, { task: order(), id: "proc-known" });
  const live = await authorizeWorkPackage({ paths: r.paths, planPath: running.plan_path, approval: running.plan_sha256, executionMode: "fake_cli" });
  assert.equal(await runMustStop(r.paths, live.run.run_id), false);
  assert.equal(await runMustStop(r.paths, "run-without-record-0001"), true);
  // A run file that does not parse (a torn write, a disk error) makes the status unreadable.
  await fsp.writeFile(path.join(r.paths.runsDir, live.run.run_id + ".json"), "{\"torn\":");
  assert.equal(await runMustStop(r.paths, live.run.run_id), true);
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { windowsHide: true, stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  await recordProcessOrKill(r.paths, live.run.run_id, { pid: child.pid, role: "writer", provider: "claude", call: 1 });
  await exited;
  assert.equal(isPidAlive(child.pid), false);
});

// RC3-FIX-01: a Git call that fails says what Git said (dubious ownership, a broken .git), not only
// that Git could not tell.
test("a failing Git call carries Git's own error text", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rb-git-said-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const nowhere = path.join(root, "nowhere");
  await fsp.writeFile(path.join(root, ".git"), "gitdir: " + nowhere + "\n");
  const said = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, encoding: "utf8" }).stderr.trim();
  assert.match(said, /^fatal: /);
  assert.throws(() => isGitWorkTree(root), (error) => error.message.startsWith("Git could not tell whether " + root + " is a Git work tree. Git said: ")
    && error.message.endsWith(said));
  assert.throws(() => headCommit(root), (error) => /^Git could not tell the current commit\. Git said: fatal: /.test(error.message));
});
