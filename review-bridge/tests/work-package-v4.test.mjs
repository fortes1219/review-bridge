import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readJson, writeJson } from "../service/records/fileStore.mjs";
import { getBridgePaths } from "../utils/paths.mjs";
import { readRun } from "../service/records/runStore.mjs";
import { authorizeV4WorkPackage, createV4WorkPackagePlan, FORBIDDEN_PATHS } from "../features/workOrder/workPackage.mjs";
import { createWorkspaceBaseline, createWorkspaceDelta, matchesForbiddenPath } from "../features/workOrder/workspaceEvidence.mjs";

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.resolve(bridgeRoot, "..");

async function runtime(t) {
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-wp-v4-"));
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  const paths = getBridgePaths(repoRoot, bridgeRoot);
  await writeJson(paths.bridgeConfigPath, {
    schema_version: 4, state_contract: "v4", active_runs: "derive_from_run_projections",
    gate_a: { profile_id: "node-backend", rules: [{ command: "npm test", package_script: "test" }] },
  });
  await fsp.writeFile(path.join(repoRoot, "package.json"), JSON.stringify({ name: "wp", scripts: { test: "node -e \"process.exit(0)\"" } }));
  await writeJson(paths.policyOverridePath, { schema_version: 4 });
  await fsp.copyFile(path.join(packageRoot, "project-templates", "rules.md"), path.join(paths.configRoot, "rules.md"));
  await fsp.mkdir(path.join(repoRoot, "src", "game"), { recursive: true });
  await fsp.writeFile(path.join(repoRoot, "src", "game", "farm.js"), "// farm\n");
  await fsp.writeFile(path.join(repoRoot, "src", "index.js"), "// index\n");
  await fsp.writeFile(path.join(repoRoot, "README.md"), "# demo\n");
  await fsp.writeFile(path.join(repoRoot, "package-lock.json"), "{}\n");
  return { repoRoot, paths };
}

function order({ references = "" } = {}) {
  return `<!-- rb:name -->
牧場
<!-- rb:work -->
做一個牧場
<!-- rb:acceptance -->
- 看得到牧場
<!-- rb:references -->
${references}
`;
}

async function plan(runtime, { task, allowedPaths, id = "wp-" + Math.random().toString(16).slice(2, 8) } = {}) {
  const taskFile = path.join(runtime.paths.privateRoot, id + ".md");
  await fsp.writeFile(taskFile, task);
  return await createV4WorkPackagePlan({
    paths: runtime.paths,
    taskFile,
    owner: "Fortes",
    workPackage: id,
    breakpoint: "return after review",
    changeTypes: "code",
    allowedPaths,
    maxCalls: 1,
    maxMinutes: 5,
    outPath: path.join(runtime.paths.privateRoot, id + ".plan.json"),
  });
}

test("T6 default scope is everything minus the fixed forbidden list", async (t) => {
  const r = await runtime(t);
  const created = await plan(r, { task: order() });
  assert.deepEqual(created.scope.allowed_paths, ["**"]);
  assert.deepEqual(created.scope.forbidden_paths, [...FORBIDDEN_PATHS]);
  assert.equal(created.scope.source, "default");
  assert.equal(created.work_order.name, "牧場");
  for (const forbidden of [".git/config", ".env", ".env.local", "deploy/key.pem", "package-lock.json", "a/b/package-lock.json",
    ".github/workflows/ci.yml", "Dockerfile", "Dockerfile.dev", "infra/main.tf", ".review-bridge/x", ".claude/settings.json"]) {
    assert.equal(matchesForbiddenPath(forbidden, FORBIDDEN_PATHS), true, forbidden);
  }
  for (const allowed of ["src/index.js", "docs/env.md", "README.md", "package.json", "src/lockfile.js"]) {
    assert.equal(matchesForbiddenPath(allowed, FORBIDDEN_PATHS), false, allowed);
  }
});

test("T7 reference paths narrow the scope; free-text references do not", async (t) => {
  const r = await runtime(t);
  const created = await plan(r, { task: order({ references: "- src/game/\n- 照首頁的做法\nREADME.md" }) });
  assert.deepEqual(created.scope.allowed_paths, ["README.md", "src/game"]);
  assert.equal(created.scope.source, "references");
  assert.deepEqual(created.references.map((entry) => entry.path), ["src/game", "README.md"]);
  assert.equal(created.references[0].files.length, 1);
  assert.match(created.references[0].files[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(created.references[1].bytes, 7);
});

test("T8 an explicit --allow-paths must exist, stay out of the forbidden list, and stay inside the references", async (t) => {
  const r = await runtime(t);
  const explicit = await plan(r, { task: order({ references: "src/" }), allowedPaths: "src/game/farm.js" });
  assert.deepEqual(explicit.scope.allowed_paths, ["src/game/farm.js"]);
  assert.equal(explicit.scope.source, "explicit");
  await assert.rejects(plan(r, { task: order(), allowedPaths: "src/missing.js" }), /允許路徑不存在/);
  await assert.rejects(plan(r, { task: order(), allowedPaths: "package-lock.json" }), /禁改清單/);
  await assert.rejects(plan(r, { task: order({ references: "src/game/" }), allowedPaths: "README.md" }), /不在參考資料的範圍內/);
  // Legacy inline task without markers still needs an explicit scope.
  await assert.rejects(createV4WorkPackagePlan({
    paths: r.paths, task: "plain task", owner: "o", workPackage: "legacy-1", breakpoint: "b", changeTypes: "code",
    maxCalls: 1, maxMinutes: 5, outPath: path.join(r.paths.privateRoot, "legacy.plan.json"),
  }), /allowed path is required/);
});

test("T9 the plan seals the rules digest and every reference hash; a changed reference changes the sha", async (t) => {
  const r = await runtime(t);
  const first = await plan(r, { task: order({ references: "src/game/farm.js" }), id: "seal-a" });
  assert.equal(first.rules.path, ".claude/review-bridge/rules.md");
  assert.match(first.rules.sha256, /^[0-9a-f]{64}$/);
  assert.match(first.rules.text, /規則摘要/);
  await fsp.writeFile(path.join(r.repoRoot, "src", "game", "farm.js"), "// farm v2\n");
  const second = await plan(r, { task: order({ references: "src/game/farm.js" }), id: "seal-b" });
  assert.notEqual(first.references[0].sha256, second.references[0].sha256);
  const firstDigestInput = { ...first, plan_sha256: undefined, proposed_run_id: 0, proposed_session_id: 0, created_at: 0, work_package_id: 0, authorization_expires_at: 0 };
  const secondDigestInput = { ...second, plan_sha256: undefined, proposed_run_id: 0, proposed_session_id: 0, created_at: 0, work_package_id: 0, authorization_expires_at: 0 };
  assert.notDeepEqual(firstDigestInput, secondDigestInput);
});

test("T10 authorize fails closed when a reference or rules.md changed after the plan was built", async (t) => {
  const r = await runtime(t);
  const sealed = await plan(r, { task: order({ references: "src/game/farm.js" }), id: "stale-ref" });
  await fsp.writeFile(path.join(r.repoRoot, "src", "game", "farm.js"), "// changed after approval\n");
  await assert.rejects(authorizeV4WorkPackage({ paths: r.paths, planPath: sealed.plan_path, approval: sealed.plan_sha256, executionMode: "fake_cli" }),
    /批准後 src\/game\/farm\.js 變了，重新建 plan/);
  const sealedRules = await plan(r, { task: order(), id: "stale-rules" });
  await fsp.appendFile(path.join(r.paths.configRoot, "rules.md"), "\n再加一條。\n");
  await assert.rejects(authorizeV4WorkPackage({ paths: r.paths, planPath: sealedRules.plan_path, approval: sealedRules.plan_sha256, executionMode: "fake_cli" }),
    /批准後 \.claude\/review-bridge\/rules\.md 變了/);
});

test("T11 a missing, empty or oversized rules.md stops work-plan", async (t) => {
  const r = await runtime(t);
  const rules = path.join(r.paths.configRoot, "rules.md");
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
  const started = await authorizeV4WorkPackage({ paths: r.paths, planPath: a.plan_path, approval: a.plan_sha256, executionMode: "fake_cli", authorizedVia: "approve_flag" });
  assert.equal(started.authorization.authorized_by, os.userInfo().username);
  assert.equal(started.authorization.authorized_via, "approve_flag");
  assert.notEqual(started.authorization.authorized_by, "Fortes-typed-into-the-plan");
  const run = await readRun(r.paths, started.run.run_id);
  assert.equal(run.authorized_by, os.userInfo().username);
  assert.equal(run.authorized_via, "approve_flag");
  const b = await plan(r, { task: order({ references: "src/game/farm.js" }), id: "auth-b" });
  const viaYes = await authorizeV4WorkPackage({ paths: r.paths, planPath: b.plan_path, approval: b.plan_sha256, executionMode: "fake_cli", authorizedVia: "yes_flag" });
  assert.equal(viaYes.authorization.authorized_via, "yes_flag");
  assert.equal((await readJson(path.join(r.paths.authorizationsDir, viaYes.authorization.authorization_id + ".json"))).authorized_via, "yes_flag");
});

test("T13 the workspace delta flags a forbidden path as a scope violation even inside the allowed scope", async (t) => {
  const r = await runtime(t);
  const baseline = await createWorkspaceBaseline({ paths: r.paths, planSha256: "f".repeat(64), allowedPaths: ["**"], forbiddenPaths: [...FORBIDDEN_PATHS] });
  await fsp.writeFile(path.join(r.repoRoot, "package-lock.json"), "{\"changed\":true}\n");
  await fsp.writeFile(path.join(r.repoRoot, "src", "index.js"), "// edited\n");
  await fsp.writeFile(path.join(r.repoRoot, ".env"), "SECRET=1\n");
  const delta = await createWorkspaceDelta({ paths: r.paths, baselinePath: baseline.baseline_path, deltaId: "t13" });
  assert.deepEqual(delta.scope_violations, [".env", "package-lock.json"]);
  assert.ok(delta.changed_paths.includes("src/index.js"));
});
