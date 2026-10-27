// Keeps the person's database out of these tests (see the fixture).
import "./fixtures/isolatedDataHome.mjs";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { evaluateRule, TestError, NOT_APPLICABLE_LABEL, recheckTest, runTest, sameDelta, selectTest } from "../features/workOrder/test.mjs";
import { readJson, writeJson } from "../service/records/fileStore.mjs";
import { getBridgePaths } from "../utils/paths.mjs";
import { mergePolicy } from "../policy/policyRules.mjs";
import { authorizeWorkPackage, createWorkPackagePlan } from "../features/workOrder/workPackage.mjs";

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.resolve(bridgeRoot, "..");

const NODE_RULES = [{ command: "npm test", package_script: "test" }];

async function workspace(t, { bridge = { test: { profile_id: "node-backend", rules: NODE_RULES } }, manifest = { name: "x", scripts: { test: "node -e \"process.exit(0)\"" } } } = {}) {
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-test-"));
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  const paths = getBridgePaths(repoRoot, bridgeRoot, { privateRootName: ".review-bridge" });
  await writeJson(paths.bridgeConfigPath, { schema_version: 4, active_runs: "derive_from_run_projections", roles: { writer: { provider_id: "claude" }, reviewer: { provider_id: "codex" } }, ...bridge });
  await writeJson(paths.policyOverridePath, { schema_version: 5 });
  await fsp.copyFile(path.join(packageRoot, "project-templates", "rules.md"), path.join(paths.configRoot, "rules.md"));
  if (manifest) await fsp.writeFile(path.join(repoRoot, "package.json"), JSON.stringify(manifest));
  await fsp.writeFile(path.join(repoRoot, "README.md"), "# demo\n");
  await fsp.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fsp.writeFile(path.join(repoRoot, "src", "a.js"), "// a\n");
  return { repoRoot, paths };
}

function order() {
  return "# Work order: farm\n\n## Work\nBuild a small farm.\n\n## Acceptance\n- The farm is visible.\n\n## References\n- src/a.js\n";
}

async function plan({ paths, repoRoot }, { changeTypes = "code", id = "gate-" + Math.random().toString(16).slice(2, 8) } = {}) {
  const taskFile = path.join(paths.privateRoot, id + ".md");
  await fsp.writeFile(taskFile, order());
  return await createWorkPackagePlan({
    paths, taskFile, owner: "Fortes", workPackage: id, breakpoint: "return after review", changeTypes,
    rounds: 1, callTimeout: 300_000, outPath: path.join(paths.privateRoot, id + ".plan.json"),
  });
}

test("G1 a rule is a file check: files_any, files_none, root globs, package script and platform", async (t) => {
  const { repoRoot } = await workspace(t);
  await fsp.writeFile(path.join(repoRoot, "Cargo.toml"), "[package]\n");
  await fsp.writeFile(path.join(repoRoot, "demo.csproj"), "<Project/>\n");
  assert.equal((await evaluateRule(repoRoot, { command: "cargo test --workspace", files_any: ["Cargo.toml"] })).ok, true);
  assert.deepEqual((await evaluateRule(repoRoot, { command: "go test ./...", files_any: ["go.mod"] })).reasons, ["沒有 go.mod"]);
  assert.equal((await evaluateRule(repoRoot, { command: "dotnet test", root_globs_any: ["*.sln", "*.csproj"] })).evidence[0], "demo.csproj");
  assert.deepEqual((await evaluateRule(repoRoot, { command: "mvn test", files_any: ["Cargo.toml"], files_none: ["README.md"] })).reasons, ["有 README.md，另一條優先"]);
  assert.deepEqual((await evaluateRule(repoRoot, { command: "./mvnw test", files_any: ["Cargo.toml"], platforms: ["darwin", "linux"] }, "win32")).reasons, ["只用於 darwin/linux"]);
  assert.deepEqual((await evaluateRule(repoRoot, { command: "npm test", package_script: "test" })).evidence, ["package.json scripts.test"]);
  await fsp.writeFile(path.join(repoRoot, "package.json"), JSON.stringify({ scripts: { test: "echo \"Error: no test specified\" && exit 1" } }));
  assert.deepEqual((await evaluateRule(repoRoot, { command: "npm test", package_script: "test" })).reasons, ["scripts.test 還是 npm 的預設占位"]);
  await fsp.writeFile(path.join(repoRoot, "package.json"), "{}");
  assert.deepEqual((await evaluateRule(repoRoot, { command: "npm test", package_script: "test" })).reasons, ["package.json 沒有 scripts.test"]);
});

test("R1 the plan seals the first matching rule and the plain summary names it", async (t) => {
  const ws = await workspace(t);
  const planned = await plan(ws);
  assert.equal(planned.test.kind, "command");
  assert.equal(planned.test.command, "npm test");
  assert.equal(planned.test.label, "跑現有測試：npm test");
  assert.equal(planned.test.source, "profile:node-backend");
  assert.deepEqual(planned.test.evidence, ["package.json scripts.test"]);
  const stored = await readJson(planned.plan_path);
  assert.deepEqual(stored.test, planned.test);
});

test("R2 docs-only work seals not_applicable even when a rule would match", async (t) => {
  const ws = await workspace(t);
  const planned = await plan(ws, { changeTypes: "docs" });
  assert.deepEqual(planned.test, { kind: "not_applicable", command: null, label: NOT_APPLICABLE_LABEL });
  assert.equal(planned.test.label, "不跑測試（純文件）");
});

test("R3 code work without any matching rule is refused and nothing is written", async (t) => {
  const ws = await workspace(t, { manifest: { name: "x" } });
  await assert.rejects(plan(ws, { id: "refused" }), (error) => {
    assert.ok(error instanceof TestError);
    assert.equal(error.reason, "no_test");
    assert.deepEqual(error.checked, [{ command: "npm test", reasons: ["package.json 沒有 scripts.test"] }]);
    assert.match(error.plain(), /沒找到 profile 核准的測試入口/);
    assert.match(error.plain(), /npm test：package\.json 沒有 scripts\.test/);
    return true;
  });
  assert.equal(await fsp.stat(path.join(ws.paths.privateRoot, "refused.plan.json")).catch(() => null), null);
  // tests, config and the rest are not docs either.
  await assert.rejects(plan(ws, { changeTypes: "docs,tests" }), TestError);
  // An install without any rules is the same refusal.
  const bare = await workspace(t, { bridge: {} });
  await assert.rejects(plan(bare), (error) => error instanceof TestError && error.checked.length === 0);
});

test("R4 approval re-checks the sealed entry point; removing it refuses the start", async (t) => {
  const ws = await workspace(t);
  const planned = await plan(ws);
  await fsp.writeFile(path.join(ws.repoRoot, "package.json"), JSON.stringify({ name: "x" }));
  assert.equal((await recheckTest(ws.repoRoot, planned.test)).ok, false);
  await assert.rejects(authorizeWorkPackage({ paths: ws.paths, planPath: planned.plan_path, approval: planned.plan_sha256, executionMode: "fake_cli" }), /測試入口變了/);
});

test("R8 the sealed command runs through the shell with a timeout; over time is a failure; the minutes limit only tightens", async (t) => {
  const ws = await workspace(t);
  const rule = { kind: "command", command: "node -e \"console.log('ok-out');process.exit(0)\"", label: "x" };
  const ok = await runTest({ paths: ws.paths, test: rule, stdoutPath: path.join(ws.paths.queueRoot, "ok.out"), stderrPath: path.join(ws.paths.queueRoot, "ok.err"), timeoutMs: 60_000 });
  assert.equal(ok.passed, true);
  assert.equal(ok.exit_code, 0);
  assert.match(ok.stdout_tail, /ok-out/);
  const failing = { kind: "command", command: "node -e \"console.error('boom');process.exit(4)\"", label: "x" };
  const bad = await runTest({ paths: ws.paths, test: failing, stdoutPath: path.join(ws.paths.queueRoot, "bad.out"), stderrPath: path.join(ws.paths.queueRoot, "bad.err"), timeoutMs: 60_000 });
  assert.equal(bad.passed, false);
  assert.equal(bad.exit_code, 4);
  assert.match(bad.stderr_tail, /boom/);
  const slow = { kind: "command", command: "node -e \"setTimeout(()=>{},20000)\"", label: "x" };
  const late = await runTest({ paths: ws.paths, test: slow, stdoutPath: path.join(ws.paths.queueRoot, "slow.out"), stderrPath: path.join(ws.paths.queueRoot, "slow.err"), timeoutMs: 500 });
  assert.equal(late.timed_out, true);
  assert.equal(late.passed, false);
  const none = await runTest({ paths: ws.paths, test: { kind: "not_applicable" }, stdoutPath: "", stderrPath: "", timeoutMs: 1 });
  assert.equal(none.kind, "not_applicable");
  const defaults = await readJson(path.join(bridgeRoot, "config", "default-policy.json"));
  assert.equal(defaults.limits.test_timeout, 600_000);
  assert.equal(mergePolicy(defaults, { schema_version: 5, limits: { test_timeout: 120_000 } }).limits.test_timeout, 120_000);
  assert.throws(() => mergePolicy(defaults, { schema_version: 5, limits: { test_timeout: 1_800_000 } }), /only tighten limit: test_timeout/);
});

test("G3.6 an unchanged delta is detected by path and hash, not by count", () => {
  const a = [{ path: "src/a.js", after_sha256: "1" }, { path: "src/b.js", after_sha256: "2" }];
  assert.equal(sameDelta(a, [...a].reverse()), true);
  assert.equal(sameDelta(a, [{ path: "src/a.js", after_sha256: "1" }, { path: "src/b.js", after_sha256: "3" }]), false);
  assert.equal(sameDelta([], []), true);
});

test("selectTest honours rule order and reports every rule it passed over", async (t) => {
  const ws = await workspace(t, { bridge: { test: { profile_id: "java-backend", rules: [
    { command: ".\\mvnw.cmd test", files_any: ["mvnw.cmd"], platform: "win32" },
    { command: "mvn test", files_any: ["pom.xml"], files_none: ["mvnw", "mvnw.cmd"] },
  ] } } });
  await fsp.writeFile(path.join(ws.repoRoot, "pom.xml"), "<project/>");
  const bridgeConfig = await readJson(ws.paths.bridgeConfigPath);
  const picked = await selectTest({ repoRoot: ws.repoRoot, bridgeConfig, changeTypes: ["code"], platform: "linux" });
  assert.equal(picked.command, "mvn test");
  await fsp.writeFile(path.join(ws.repoRoot, "mvnw.cmd"), "");
  const wrapper = await selectTest({ repoRoot: ws.repoRoot, bridgeConfig, changeTypes: ["code"], platform: "win32" });
  assert.equal(wrapper.command, ".\\mvnw.cmd test");
  await assert.rejects(selectTest({ repoRoot: ws.repoRoot, bridgeConfig, changeTypes: ["code"], platform: "linux" }), (error) => {
    assert.deepEqual(error.checked.map((entry) => entry.command), [".\\mvnw.cmd test", "mvn test"]);
    return true;
  });
});

test("R8b a timeout terminates the whole tree while the shell is alive: a delayed grandchild never writes its file", async (t) => {
  const ws = await workspace(t);
  // slow-child.cjs: spawns a grandchild that writes late.txt after 2 s, then idles for 15 s.
  await fsp.writeFile(path.join(ws.repoRoot, "slow-child.cjs"), [
    "const { spawn } = require('child_process');",
    "spawn(process.execPath, ['-e', \"setTimeout(() => require('fs').writeFileSync('late.txt', 'late'), 2000)\"], { stdio: 'ignore', cwd: process.cwd() });",
    "setTimeout(() => {}, 15000);",
  ].join("\n"));
  const rule = { kind: "command", command: "node slow-child.cjs", label: "x" };
  const startedAt = Date.now();
  const result = await runTest({ paths: ws.paths, test: rule, stdoutPath: path.join(ws.paths.queueRoot, "tree.out"), stderrPath: path.join(ws.paths.queueRoot, "tree.err"), timeoutMs: 500 });
  assert.equal(result.timed_out, true);
  assert.equal(result.passed, false);
  assert.ok(Date.now() - startedAt < 12_000, "the timeout returned before the parent's own 15 s idle");
  // runProcess waited for the kill: the result says the tree was gone before it returned.
  assert.equal(result.tree_kill.killed, true);
  assert.equal(result.tree_kill.scope, process.platform === "win32" ? "tree" : "group");
  await new Promise((resolve) => setTimeout(resolve, 3_500));
  assert.equal(await fsp.stat(path.join(ws.repoRoot, "late.txt")).catch(() => null), null, "the grandchild outlived the timeout");
});

test("the tail is only the last 4 KB of a large log, read from the end", async (t) => {
  const ws = await workspace(t);
  await fsp.writeFile(path.join(ws.repoRoot, "big.cjs"), "process.stdout.write('x'.repeat(200000) + '\\nLAST-LINE\\n');");
  const rule = { kind: "command", command: "node big.cjs", label: "x" };
  const result = await runTest({ paths: ws.paths, test: rule, stdoutPath: path.join(ws.paths.queueRoot, "big.out"), stderrPath: path.join(ws.paths.queueRoot, "big.err"), timeoutMs: 60_000 });
  assert.equal(result.passed, true);
  assert.ok(result.stdout_tail.length <= 4 * 1024);
  assert.match(result.stdout_tail, /LAST-LINE/);
  assert.equal((await fsp.stat(path.join(ws.paths.queueRoot, "big.out"))).size > 200_000, true);
});

test("a failed taskkill is reported as a failed tree kill, never as a cleared tree", { skip: process.platform !== "win32" }, async () => {
  const { spawn } = await import("node:child_process");
  const { killProcessTree } = await import("../service/agentCli/process.mjs");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], { stdio: "ignore", windowsHide: true });
  try {
    const result = await killProcessTree(child.pid, { taskkill: "taskkill-that-does-not-exist.exe", waitMs: 500 });
    assert.equal(result.killed, false);
    assert.match(result.reason, /^taskkill_failed:/);
    assert.equal(result.scope, "pid");
  } finally {
    try { child.kill("SIGKILL"); } catch {}
  }
});
