// Keeps the person's database out of these tests (see the fixture).
import "./fixtures/isolatedDataHome.mjs";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { dispatchCommand } from "../router/index.mjs";
import { cancelWork } from "../features/workOrder/commands.mjs";
import { appendIoEvent, readIoEvents } from "../service/records/ioEvents.mjs";
import { createTranslator, resolveLocale } from "../features/workOrder/i18n.mjs";
import { readJson, writeJson } from "../service/records/fileStore.mjs";
import { getBridgePaths } from "../utils/paths.mjs";
import { afterIdentity, latestResultCopy, nextSecond, resultCopies } from "./fixtures/resultCopies.mjs";
import { loadOrCreatePolicySnapshot } from "../service/records/policySnapshots.mjs";
import { composeSections, deliverOutcome, deliverPendingRuns, renderResult, resultKey, RESULT_MAX_BYTES, stdoutLines, tokenRows } from "../features/workOrder/delivery.mjs";
import { mergeRun } from "../features/records/retention.mjs";
import { CLOSED_REASONS, consumeRun, readRun, recordRunState, withRunLock } from "../service/records/runStore.mjs";
import { authorizeWorkPackage, createWorkPackagePlan } from "../features/workOrder/workPackage.mjs";

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.resolve(bridgeRoot, "..");

// These checks read the Chinese pack; English is the product default (see S6).
async function runtime(t, { locale = "zh-TW" } = {}) {
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-result-"));
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  const paths = getBridgePaths(repoRoot, bridgeRoot, { privateRootName: ".review-bridge" });
  await writeJson(paths.bridgeConfigPath, { project_id: randomUUID(),
    schema_version: 4, active_runs: "derive_from_run_projections",
    roles: { writer: { provider_id: "claude" }, reviewer: { provider_id: "codex" } },
    ...(locale ? { locale } : {}),
    test: { profile_id: "node-backend", rules: [{ command: "npm test", package_script: "test" }] },
  });
  await writeJson(paths.policyOverridePath, { schema_version: 5 });
  await fsp.copyFile(path.join(packageRoot, "project-templates", "rules.md"), paths.rulesPath);
  await fsp.mkdir(path.join(paths.privateRoot, "work-packages"), { recursive: true });
  await fsp.writeFile(path.join(repoRoot, "README.md"), "# demo\n");
  await fsp.writeFile(path.join(repoRoot, "package.json"), JSON.stringify({ name: "r", scripts: { test: "node -e \"process.exit(0)\"" } }));
  return { repoRoot, paths };
}

const ORDER = "# Work order: farm\n\n<!-- bridge:requested_work -->\n## Work\nBuild a small farm.\n\n<!-- bridge:acceptance -->\n## Acceptance\n- The farm is visible.\n\n<!-- bridge:references -->\n## References\n- README.md\n";

// A real run brought to `status` the way the state machine does it, with typed events behind it.
async function terminalRun(rt, status, { state = null, gate = null, events = [], task = null, id = "wo-" + Math.random().toString(16).slice(2, 8), breakpoint = "return after review", allowedPaths = null } = {}) {
  const taskFile = path.join(rt.paths.privateRoot, "work-packages", id + ".md");
  if (!task) await fsp.writeFile(taskFile, ORDER);
  const plan = await createWorkPackagePlan({
    listCodexMcp: async () => [],
    paths: rt.paths, ...(task ? { task } : { taskFile }), owner: "Fortes", workPackage: id, breakpoint,
    ...(task || allowedPaths ? { allowedPaths: allowedPaths || "README.md" } : {}), rounds: 2, callTimeout: 60_000, outPath: path.join(rt.paths.privateRoot, id + "-" + Math.random().toString(16).slice(2, 6) + ".plan.json"),
  });
  const authorization = await authorizeWorkPackage({ paths: rt.paths, planPath: plan.plan_path, approval: plan.plan_sha256, executionMode: "fake_cli" });
  const runId = authorization.run.run_id;
  for (const event of events) await appendIoEvent(rt.paths, runId, event);
  if (state) await recordRunState(rt.paths, runId, { call: 1, updated_at: new Date().toISOString(), ...state });
  await consumeRun(rt.paths, runId, status, gate);
  return { runId, plan, taskFile: task ? null : taskFile };
}

const usage = (role, call, cacheRead) => ({ event: "usage", role, provider: role === "writer" ? "claude" : "codex", call, turns: 3, duration_ms: 10, tokens: { input: 10, cache_write: 20, cache_read: cacheRead, output: 5 }, cost_usd: role === "writer" ? 0.5 : null, source: "cli_json" });
// The next step by closed reason; every other one that is not a success says only "start it again".
const NEXT_LINE = Object.freeze({
  rate_limited: "等額度恢復後再 start 一次。", token_limit: "等額度恢復後再 start 一次。",
  review_hard_stop: "照上面 Why 段的發現改工單或程式，再 start 一次。", rounds_exhausted: "照上面 Why 段的發現改工單或程式，再 start 一次。",
  acceptance_unverified: "照上面 Why 段的發現改工單或程式，再 start 一次。",
  run_timeout: "把工單拆小，或把 budget.run_timeout 調大，再 start 一次。", writer_timeout: "把工單拆小，或把 budget.run_timeout 調大，再 start 一次。",
});
const finding = (id) => ({ id, severity: "HIGH", path: "README.md", line: 1, reach: "r", claim: "claim " + id, evidence: "e", fix: "fix " + id, acceptance_ref: 1 });

async function projectionEvents(rt, runId) {
  const text = await fsp.readFile(path.join(rt.paths.eventsDir, runId + ".jsonl"), "utf8");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("S1 every closed reason delivers once: two files, the right title, three sections, one run_delivered event", async (t) => {
  const rt = await runtime(t);
  const tr = await createTranslator("zh-TW");
  const cases = {
    review_pass: { gate: { review_gate: "PASS", hard_stop_required: false }, events: [{ event: "test_result", kind: "command", command: "npm test", exit_code: 0, passed: true, call: 1 }, { event: "review.result", call: 1, gate: "PASS", hard_stop: false, hard_stop_reason: null, findings: [], verified: ["read the delta"], not_run: ["ui"] }] },
    rounds_exhausted: { state: { status: "rounds_exhausted", review_gate: "FAIL" }, events: [{ event: "task.input", call: 1 }, { event: "review.result", call: 1, gate: "FAIL", hard_stop: false, hard_stop_reason: null, findings: [finding("F1")], verified: [], not_run: [] }] },
    review_hard_stop: { gate: { review_gate: "FAIL", hard_stop_required: true, hard_stop_reason: "release_action" }, state: { status: "hard_stop", hard_stop_reason: "release_action" } },
    runtime_policy_identity_changed: { gate: { review_gate: "FAIL", hard_stop_required: true } },
    superseded: {}, database_unavailable: {},
    needs_human: { state: { status: "needs_human", writer_status: "blocked" }, events: [{ event: "writer.result", call: 1, status: "blocked", needs_human: [{ question: "which colour?", options: ["red", "blue"] }] }] },
    token_limit: { state: { status: "token_limit", token_limit: "per_call", token_limit_role: "writer", tokens_this_call: 2_000_006 } },
    rate_limited: { state: { status: "rate_limited", failure: { role: "reviewer", provider: "codex", reason: "provider_usage_limit", reset_hint: "Oct 10th, 2026 1:00 AM" } } },
    stopped: { events: [{ event: "stop", status: "stopped", role: "writer", provider: "claude", detail_ref: "pid:1:killed" }] },
    cancelled: {},
    policy_failure: {},
    writer_failed: { state: { status: "writer_failed", stderr_path: "C:/x/err.log", failure: { role: "writer", provider: "claude", reason: "provider_error" } } },
    reviewer_failed: {}, writer_timeout: {}, controller_failure: {}, reference_changed: {}, malformed_writer_result: {}, malformed_review_result: {},
    contract_rejected: { state: { status: "contract_rejected", contract_problems: ["$.acceptance[0].id: expected AC1"] } },
    contract_changed: {},
    usage_unknown: { state: { status: "usage_unknown", token_limit_role: "writer" } },
    acceptance_unverified: { state: { status: "acceptance_unverified", review_gate: "PASS" } },
    start_point_lost: { state: { status: "start_point_lost" } },
    evidence_changed: { state: { status: "evidence_changed", error: "writer:the run's starting record" } },
    version_changed: { state: { status: "version_changed" } },
    evidence_unconfirmable: { state: { status: "evidence_unconfirmable" } },
    scope_unverified: { state: { status: "scope_unverified", scope_unverified: ["README.md"] } },
    run_timeout: {},
    evidence_unavailable: { events: [{ event: "stop", status: "evidence_unavailable", role: "controller", provider: null, detail_ref: "delta" }] },
  };
  assert.equal(Object.keys(cases).length, CLOSED_REASONS.length, "every closed reason has a case");
  for (const status of CLOSED_REASONS) {
    const spec = cases[status];
    assert.ok(spec, "missing case for " + status);
    const { runId, taskFile } = await terminalRun(rt, status, { state: spec.state, gate: spec.gate, events: [usage("writer", 1, 1000), ...(spec.events || [])] });
    const delivery = await deliverOutcome({ paths: rt.paths, runId, notify: false });
    assert.equal(delivery.already, false, status);
    const closed = await readRun(rt.paths, runId);
    assert.equal(closed.status, "completed", status);
    assert.equal(delivery.conclusion, closed.conclusion, status);
    assert.equal(delivery.closed_reason, status);
    const runCopy = await fsp.readFile(path.join(rt.paths.runLogDir(runId), runId + ".result.md"), "utf8");
    const title = afterIdentity(runCopy).split("\n")[0];
    assert.equal(title, "# " + tr(resultKey(tr, "outcome", closed)) + (title.includes("（") ? title.slice(title.indexOf("（")) : ""), status);
    // The person's copy is the run's result as it is, in results/<work order>/, never beside the work order.
    assert.equal(await fsp.readFile(delivery.latest_path, "utf8"), runCopy, status);
    assert.equal(path.dirname(path.dirname(delivery.latest_path)), rt.paths.resultsDir, status);
    assert.equal(await fsp.stat(taskFile.replace(/\.md$/, ".result.md")).catch(() => null), null, status);
    for (const heading of ["## 為什麼", "## 下一步", "## 改了哪些檔", "## token"]) assert.ok(runCopy.includes(heading), status + " " + heading);
    // Whatever stopped it, the next step is one line in plain words, picked by the closed reason, with
    // no command in it (Owner 2026-11-04).
    const next = /## 下一步\n([\s\S]*?)\n\n## /.exec(runCopy)[1];
    // A writer that stopped for the person: the answer goes in the work order, named by its file name.
    const expected = status === "needs_human" ? "在 " + path.basename(taskFile) + " 寫清楚上面 writer 問的或卡住的地方（或改掉它做不到的條件），存檔後再 start 一次。" : NEXT_LINE[status] || "再 start 一次。";
    if (closed.conclusion !== "success") assert.equal(next, expected, status);
    assert.doesNotMatch(next, /plan|批准|node |review-bridge|\//, status);
    const delivered = (await projectionEvents(rt, runId)).filter((event) => event.type === "run_delivered");
    assert.equal(delivered.length, 1, status);
    const run = await readRun(rt.paths, runId);
    assert.equal(run.result_sha256.length, 64);
    // A second delivery is a no-op: no new event, no rewrite.
    const again = await deliverOutcome({ paths: rt.paths, runId, notify: false });
    assert.equal(again.already, true);
    assert.equal((await projectionEvents(rt, runId)).filter((event) => event.type === "run_delivered").length, 1);
  }
});

test("S1b / S2 / S3 the why section is built from typed fields: findings, gate failure, questions, limits, quota", async (t) => {
  const rt = await runtime(t);
  const once = await terminalRun(rt, "rounds_exhausted", { state: { status: "rounds_exhausted", review_gate: "FAIL" }, events: [{ event: "task.input", call: 1 }, { event: "review.result", call: 1, gate: "FAIL", hard_stop: false, hard_stop_reason: null, findings: [finding("F1"), finding("F2")], verified: [], not_run: [] }] });
  const onceText = await fsp.readFile((await deliverOutcome({ paths: rt.paths, runId: once.runId, notify: false })).result_path, "utf8");
  assert.doesNotMatch(onceText, /自動修過/);
  assert.match(onceText, /- F1（HIGH）README\.md:1：claim F1　→ fix F1/);
  assert.match(onceText, /- F2（HIGH）/);
  const twice = await terminalRun(rt, "rounds_exhausted", { state: { status: "rounds_exhausted", call: 2, test_passed: false, test_exit_code: 3 }, events: [{ event: "task.input", call: 1 }, { event: "task.input", call: 2 }, { event: "test_result", kind: "command", command: "npm test", exit_code: 3, timed_out: false, passed: false, call: 2, stderr_tail: "a\nb\nAssertionError: boom\n" }] });
  const twiceText = await fsp.readFile((await deliverOutcome({ paths: rt.paths, runId: twice.runId, notify: false })).result_path, "utf8");
  assert.match(afterIdentity(twiceText), /^# 需修正（Bridge 已自動修過 1 次）/);
  assert.match(twiceText, /現有測試沒過：npm test，exit 3/);
  assert.match(twiceText, /AssertionError: boom/);
  const human = await terminalRun(rt, "needs_human", { state: { status: "needs_human" }, events: [{ event: "writer.result", call: 1, status: "done", needs_human: [{ question: "which colour?", options: ["red", "blue"] }] }] });
  const humanText = await fsp.readFile((await deliverOutcome({ paths: rt.paths, runId: human.runId, notify: false })).result_path, "utf8");
  assert.match(afterIdentity(humanText), /^# 要你決定/);
  assert.match(humanText, /which colour\?（選項：red \/ blue）/);
  const limit = await terminalRun(rt, "token_limit", { state: { status: "token_limit", token_limit: "per_run", token_limit_role: "reviewer", tokens_this_run: 4_000_100 } });
  const limitText = await fsp.readFile((await deliverOutcome({ paths: rt.paths, runId: limit.runId, notify: false })).result_path, "utf8");
  assert.match(afterIdentity(limitText), /^# 超過 token 上限/);
  assert.match(limitText, /reviewer 超過 整條 run token 上限：上限 4000000，實際 4000100/);
  assert.doesNotMatch(limitText, /供應商額度/);
  const quota = await terminalRun(rt, "rate_limited", { state: { status: "rate_limited", failure: { role: "writer", provider: "claude", reason: "provider_usage_limit", reset_hint: "3pm" } } });
  const quotaText = await fsp.readFile((await deliverOutcome({ paths: rt.paths, runId: quota.runId, notify: false })).result_path, "utf8");
  assert.match(afterIdentity(quotaText), /^# 供應商額度用完/);
  assert.match(quotaText, /writer（claude）的供應商額度用完/);
  assert.match(quotaText, /恢復時間：3pm/);
  assert.doesNotMatch(quotaText, /token 上限/);
});

test("S4 the token table comes only from usage events; a role without usage shows unknown", async (t) => {
  const rt = await runtime(t);
  const { runId } = await terminalRun(rt, "pass", { gate: { review_gate: "PASS", hard_stop_required: false }, events: [usage("writer", 1, 1000), usage("writer", 2, 3000), { event: "usage", role: "reviewer", call: 1, parse_error: true, tokens: { input: 0, cache_write: 0, cache_read: 0, output: 0 } }] });
  const rows = tokenRows(await readIoEvents(rt.paths, runId));
  assert.deepEqual(rows.writer, { calls: 2, unreadable: 0, complete: true, input: 20, cache_read: 4000, cache_write: 40, output: 10, total: 4070, cost_usd: 1 });
  assert.deepEqual(rows.reviewer, { calls: 1, unreadable: 1, complete: false });
  const text = await fsp.readFile((await deliverOutcome({ paths: rt.paths, runId, notify: false })).result_path, "utf8");
  assert.match(text, /\| writer \| 2 \| 20 \| 4000 \| 40 \| 10 \| 4070 \| 1\.0000 USD \|/);
  assert.match(text, /\| reviewer \| 1（1 次讀不到） \| 未知 \| 未知 /);
  assert.doesNotMatch(text, /系統提示/);
});

test("S5 a delivered result names the gate honestly and never claims the features were verified", async (t) => {
  const rt = await runtime(t);
  const tested = await terminalRun(rt, "pass", { gate: { review_gate: "PASS", hard_stop_required: false }, events: [{ event: "test_result", kind: "command", command: "npm test", exit_code: 0, passed: true, call: 1 }] });
  const testedText = await fsp.readFile((await deliverOutcome({ paths: rt.paths, runId: tested.runId, notify: false })).result_path, "utf8");
  assert.match(testedText, /現有測試通過：npm test/);
  assert.doesNotMatch(testedText, /功能驗過|全部驗過/);
  assert.doesNotMatch(testedText, /work-plan/); // delivered has no rebuild command
  // A project whose rules give no test command says so, whatever the outcome.
  const untested = await terminalRun(rt, "pass", { gate: { review_gate: "PASS", hard_stop_required: false }, events: [{ event: "test_result", kind: "not_configured", call: 1 }] });
  const untestedText = await fsp.readFile((await deliverOutcome({ paths: rt.paths, runId: untested.runId, notify: false })).result_path, "utf8");
  assert.match(untestedText, /測試：這個專案沒有設定測試/);
  assert.doesNotMatch(untestedText, /現有測試通過/);
  const timedOut = await terminalRun(rt, "run_timeout", { events: [{ event: "test_result", kind: "not_configured", call: 1 }] });
  const timedOutText = await fsp.readFile((await deliverOutcome({ paths: rt.paths, runId: timedOut.runId, notify: false })).result_path, "utf8");
  assert.match(afterIdentity(timedOutText), /^# 逾時/);
  assert.match(timedOutText, /這次執行到了時間上限（run_timeout，21600000 毫秒）/);
  assert.match(timedOutText, /測試：這個專案沒有設定測試/);
});

test("S1d three concurrent deliveries all return, one file and one run_delivered event; a crash before the event is repaired", async (t) => {
  const rt = await runtime(t);
  const { runId } = await terminalRun(rt, "stopped", { events: [{ event: "stop", status: "stopped", role: "writer", provider: "claude", detail_ref: "pid:1:killed" }] });
  const results = await Promise.all([1, 2, 3].map(() => deliverOutcome({ paths: rt.paths, runId, notify: false })));
  assert.equal(results.filter((result) => result.already === false).length, 1);
  assert.ok(results.every((result) => result.result_path === results[0].result_path));
  assert.equal((await projectionEvents(rt, runId)).filter((event) => event.type === "run_delivered").length, 1);
  // Crash simulation: the files were written but the run_delivered event never landed, so the
  // projection is rolled back to the event before it (what reconcile would rebuild after a crash).
  const crashed = await terminalRun(rt, "stopped", { events: [{ event: "stop", status: "stopped", role: "writer", provider: "claude", detail_ref: "pid:1:killed" }] });
  const first = await deliverOutcome({ paths: rt.paths, runId: crashed.runId, notify: false });
  const content = await fsp.readFile(first.result_path, "utf8");
  const run = await readRun(rt.paths, crashed.runId);
  const eventsFile = path.join(rt.paths.eventsDir, crashed.runId + ".jsonl");
  const kept = (await fsp.readFile(eventsFile, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.type !== "run_delivered");
  await fsp.writeFile(eventsFile, kept.map((event) => JSON.stringify(event)).join("\n") + "\n");
  await writeJson(path.join(rt.paths.runsDir, crashed.runId + ".json"), kept.at(-1).projection);
  const second = await deliverOutcome({ paths: rt.paths, runId: crashed.runId, notify: false });
  assert.equal(second.already, false);
  assert.equal(await fsp.readFile(second.result_path, "utf8"), content);
  assert.equal((await readRun(rt.paths, crashed.runId)).result_sha256, run.result_sha256);
});

test("S1f a held run lock is retried; a lock that never frees is reported as delivery_skipped and repaired by prune", async (t) => {
  const rt = await runtime(t);
  const { runId } = await terminalRun(rt, "cancelled");
  const { snapshot } = await loadOrCreatePolicySnapshot(rt.paths);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const holder = withRunLock(rt.paths, runId, snapshot.effective_policy, () => held);
  await new Promise((resolve) => setTimeout(resolve, 100));
  setTimeout(() => release(), 600);
  const delivery = await deliverOutcome({ paths: rt.paths, runId, notify: false, retry: { attempts: 40, delayMs: 50 } });
  await holder;
  assert.equal(delivery.already, false);
  assert.equal(delivery.conclusion, "cancelled");
  // Never freed within the retry window.
  const second = await terminalRun(rt, "cancelled");
  let release2;
  const held2 = new Promise((resolve) => { release2 = resolve; });
  const holder2 = withRunLock(rt.paths, second.runId, snapshot.effective_policy, () => held2);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const skipped = await deliverOutcome({ paths: rt.paths, runId: second.runId, notify: false, retry: { attempts: 3, delayMs: 50 } });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, "lock_held");
  assert.equal((await readIoEvents(rt.paths, second.runId)).at(-1).event, "delivery_skipped");
  assert.equal(stdoutLines(skipped).length, 1);
  release2();
  await holder2;
  const repaired = await deliverPendingRuns(rt.paths);
  assert.deepEqual(repaired, [{ run_id: second.runId, conclusion: "cancelled", closed_reason: "cancelled" }]);
  assert.equal((await readRun(rt.paths, second.runId)).result_sha256.length, 64);
});

test("S4c a result over 64 KB is trimmed in the fixed order and keeps its headings; the archive holds the full text", async (t) => {
  const rt = await runtime(t);
  const tr = await createTranslator("zh-TW");
  const run = { run_id: "run-x", status: "completed", conclusion: "action_required", closed_reason: "rounds_exhausted", closed_at: "2026-10-14T00:00:00.000Z", last_state: { status: "rounds_exhausted", review_gate: "FAIL", call: 2 } };
  const events = [{ event: "task.input", call: 1 }, { event: "review.result", call: 1, sequence: 5, gate: "FAIL", findings: Array.from({ length: 60 }, (_, i) => finding("F" + (i + 1))), verified: [], not_run: [] }];
  const delta = { changed_files: Array.from({ length: 3000 }, (_, i) => ({ path: "src/very/long/path/to/file-" + i + ".js", change: "modified" })), scope_violations: [] };
  const sections = composeSections({ t: tr, run, workPackage: { work_package_id: "wo", budget: { rounds: 2 }, scope: {} }, plan: null, events, delta });
  const full = renderResult({ t: tr, sections, commands: null, runId: "run-x", latest: false });
  assert.ok(Buffer.byteLength(full, "utf8") <= RESULT_MAX_BYTES);
  assert.match(full, /還有 \d+ 個檔，見日檔事件/);
  assert.match(full, /還有 40 條，見日檔事件/);
  for (const heading of ["## 為什麼", "## 下一步", "## 改了哪些檔", "## token"]) assert.ok(full.includes(heading));
  // The archive keeps the per-run file whole.
  const { runId } = await terminalRun(rt, "cancelled");
  const delivered = await deliverOutcome({ paths: rt.paths, runId, notify: false });
  const text = await fsp.readFile(delivered.result_path, "utf8");
  const merged = await mergeRun(rt.paths, runId);
  const lines = (await fsp.readFile(merged.archive_file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const artifact = lines.find((line) => line.type === "artifact" && line.kind === "result");
  assert.equal(artifact.text, text);
  // The run's own copy is in its log folder, which stays until the run is past the window (RC3-FIX-02).
  assert.ok(await fsp.stat(delivered.result_path));
});

test("S6 the language pack drives every string; unknown locales fall back; missing keys return the key", async (t) => {
  const en = await runtime(t, { locale: "en" });
  assert.equal(await resolveLocale(en.paths), "en");
  const { runId } = await terminalRun(en, "pass", { gate: { review_gate: "PASS", hard_stop_required: false }, events: [{ event: "test_result", kind: "command", command: "npm test", exit_code: 0, passed: true, call: 1 }] });
  const delivery = await deliverOutcome({ paths: en.paths, runId, notify: false });
  const text = await fsp.readFile(delivery.result_path, "utf8");
  assert.match(afterIdentity(text), /^# Delivered/);
  assert.match(text, /## Why/);
  assert.match(text, /Existing tests passed: npm test/);
  assert.match(text, /## Next step/);
  assert.match(text, /\| writer \| /);
  // No zh-TW pack string leaks through.
  assert.doesNotMatch(text, /為什麼|下一步|已交付|改了哪些檔|未知/);
  assert.deepEqual(stdoutLines(delivery)[0].startsWith("Delivered: "), true);
  // English is the default: no locale and an unknown one both land there.
  const unset = await runtime(t, { locale: null });
  assert.equal(await resolveLocale(unset.paths), "en");
  const odd = await runtime(t, { locale: "xx-YY" });
  assert.equal(await resolveLocale(odd.paths), "en");
  const tr = await createTranslator("zh-TW");
  assert.equal(tr("no.such.key"), "no.such.key");
  assert.equal(tr("stdout.file", { path: "p" }), "結果檔：p");
});

test("S8 task_file is sealed; each run's copy is results/<work order>/<work order> <local date> <hh-mm-ss> <conclusion>.md, inline tasks are named by their id", async (t) => {
  const rt = await runtime(t);
  // Without the database the work order's file name comes from the run's plan.
  const two = (number) => String(number).padStart(2, "0");
  const copyOf = async (runId, name) => {
    const run = await readRun(rt.paths, runId);
    const at = new Date(run.closed_at);
    return path.join(rt.paths.resultsDir, name, name + " " + at.getFullYear() + "-" + two(at.getMonth() + 1) + "-" + two(at.getDate()) + " "
      + two(at.getHours()) + "-" + two(at.getMinutes()) + "-" + two(at.getSeconds()) + " " + run.conclusion + ".md");
  };
  const first = await terminalRun(rt, "cancelled", { id: "farm" });
  assert.equal(first.plan.task_file, ".review-bridge/work-packages/farm.md");
  const d1 = await deliverOutcome({ paths: rt.paths, runId: first.runId, notify: false });
  assert.equal(d1.latest_path, await copyOf(first.runId, "farm"));
  assert.equal(d1.result_path, path.join(rt.paths.runLogDir(first.runId), first.runId + ".result.md"));
  // The same work order run again: a copy of its own; the first one is left as it was.
  const firstText = await fsp.readFile(d1.latest_path, "utf8");
  await nextSecond();
  const second = await terminalRun(rt, "cancelled", { id: "farm" });
  const d2 = await deliverOutcome({ paths: rt.paths, runId: second.runId, notify: false });
  assert.equal(d2.latest_path, await copyOf(second.runId, "farm"));
  assert.notEqual(d2.latest_path, d1.latest_path);
  assert.equal(await fsp.readFile(d1.latest_path, "utf8"), firstText);
  assert.ok(await fsp.stat(d1.result_path));
  assert.ok(await fsp.stat(d2.result_path));
  assert.deepEqual((await fsp.readdir(path.join(rt.paths.privateRoot, "work-packages"))).filter((name) => name.endsWith(".result.md")), []);
  const inline = await terminalRun(rt, "cancelled", { task: "Update README.md only.", id: "inline-1" });
  assert.equal(inline.plan.task_file, null);
  const d3 = await deliverOutcome({ paths: rt.paths, runId: inline.runId, notify: false });
  assert.equal(d3.latest_path, await copyOf(inline.runId, "inline-1"));
  assert.doesNotMatch(await fsp.readFile(d3.result_path, "utf8"), /work-plan/); // no task file, no command
  assert.match(await fsp.readFile(d3.result_path, "utf8"), /## 下一步\n再 start 一次。\n/);
  // A name already holding another run's result is never written over; the delivery stops instead.
  await nextSecond();
  const taken = await terminalRun(rt, "cancelled", { id: "farm" });
  const occupied = await copyOf(taken.runId, "farm");
  await fsp.writeFile(occupied, "another run's result\n");
  await assert.rejects(deliverOutcome({ paths: rt.paths, runId: taken.runId, notify: false }), /is already another run's result; it was not written over/);
  assert.equal(await fsp.readFile(occupied, "utf8"), "another run's result\n");
});

test("C1 a result carries no command to paste, whatever its scope (RC3-FIX-02)", async (t) => {
  const rt = await runtime(t);
  for (const options of [{ id: "scoped", allowedPaths: "README.md" }, { id: "refs" }]) {
    const run = await terminalRun(rt, "cancelled", options);
    const text = await fsp.readFile((await deliverOutcome({ paths: rt.paths, runId: run.runId, notify: false })).result_path, "utf8");
    assert.doesNotMatch(text, /bootstrap\.mjs|work-plan --|--allow-paths/, options.id);
  }
});

test("C3 the 64 KB cap holds for any list size: out-of-scope files, changed files, long why sections", async (t) => {
  const tr = await createTranslator("zh-TW");
  const run = { run_id: "run-big", status: "completed", conclusion: "action_required", closed_reason: "needs_human", closed_at: "2026-10-14T00:00:00.000Z", last_state: { status: "hard_stop", hard_stop_reason: "scope_expansion", call: 1 } };
  const events = [
    { event: "task.input", call: 1 },
    { event: "writer.result", call: 1, status: "done", needs_human: Array.from({ length: 800 }, (_, i) => ({ question: "q".repeat(200) + i, options: Array.from({ length: 30 }, () => "o".repeat(40)) })) },
    { event: "review.result", call: 1, sequence: 9, gate: "FAIL", hard_stop: true, hard_stop_reason: "scope_expansion", findings: Array.from({ length: 300 }, (_, i) => ({ ...finding("F" + (i + 1)), claim: "c".repeat(200), fix: "f".repeat(200) })), verified: [], not_run: [] },
  ];
  const files = (prefix, count) => Array.from({ length: count }, (_, i) => ({ path: prefix + "/deep/path/segment/file-" + i + ".js", change: "modified" }));
  const delta = { changed_files: [...files("src", 5000), ...files("outside", 5000)], scope_violations: files("outside", 5000).map((entry) => entry.path) };
  const sections = composeSections({ t: tr, run, workPackage: { work_package_id: "wo", budget: { rounds: 2 }, scope: {} }, plan: null, events, delta });
  const text = renderResult({ t: tr, sections, commands: { powershell: "node --% x", sh: "node 'x'" } });
  assert.ok(Buffer.byteLength(text, "utf8") <= RESULT_MAX_BYTES, "bytes " + Buffer.byteLength(text, "utf8"));
  for (const heading of ["## 為什麼", "## 下一步", "## 改了哪些檔", "## token"]) assert.ok(text.includes(heading), heading);
  assert.match(text, /^# 要你決定/m);
  assert.match(text, /內容過長，只留重點/);
});

test("C4 every run of one work order keeps its own copy, whatever the delivery order", async (t) => {
  const rt = await runtime(t);
  const older = await terminalRun(rt, "cancelled", { id: "order" });
  await nextSecond();
  const newer = await terminalRun(rt, "cancelled", { id: "order" });
  const n = await deliverOutcome({ paths: rt.paths, runId: newer.runId, notify: false });
  const o = await deliverOutcome({ paths: rt.paths, runId: older.runId, notify: false });
  assert.deepEqual([n.latest_written, o.latest_written], [true, true]);
  assert.deepEqual(await resultCopies(rt.repoRoot, "order"), [o.latest_path, n.latest_path], "named by when each run closed, oldest first");
  for (const delivered of [o, n]) assert.equal(await fsp.readFile(delivered.latest_path, "utf8"), await fsp.readFile(delivered.result_path, "utf8"));
  assert.equal(stdoutLines(o)[1].endsWith(path.basename(o.latest_path)), true);
  // Concurrent deliveries of two runs of one work order: two copies, neither in the other's way.
  const a = await terminalRun(rt, "cancelled", { id: "race" });
  await nextSecond();
  const b = await terminalRun(rt, "cancelled", { id: "race" });
  const [db, da] = await Promise.all([deliverOutcome({ paths: rt.paths, runId: b.runId, notify: false }), deliverOutcome({ paths: rt.paths, runId: a.runId, notify: false })]);
  assert.deepEqual(await resultCopies(rt.repoRoot, "race"), [da.latest_path, db.latest_path]);
  for (const delivered of [da, db]) assert.equal(await fsp.readFile(delivered.latest_path, "utf8"), await fsp.readFile(delivered.result_path, "utf8"));
});

test("C5 a delivery made more than a minute after the run ended says when its changed list was computed", async (t) => {
  const rt = await runtime(t);
  const late = await terminalRun(rt, "cancelled");
  const closed = Date.parse((await readRun(rt.paths, late.runId)).closed_at);
  const text = await fsp.readFile((await deliverOutcome({ paths: rt.paths, runId: late.runId, notify: false, now: () => closed + 3 * 86_400_000 })).result_path, "utf8");
  assert.match(text, /這份清單是 \S+ 算的，晚於 run 結束/);
  const prompt = await terminalRun(rt, "cancelled");
  const promptText = await fsp.readFile((await deliverOutcome({ paths: rt.paths, runId: prompt.runId, notify: false })).result_path, "utf8");
  assert.doesNotMatch(promptText, /晚於 run 結束/);
});

test("C6 work-cancel delivers on the spot", async (t) => {
  const rt = await runtime(t);
  const taskFile = path.join(rt.paths.privateRoot, "work-packages", "cancel.md");
  await fsp.writeFile(taskFile, ORDER);
  const plan = await createWorkPackagePlan({
    listCodexMcp: async () => [],
    paths: rt.paths, taskFile, owner: "Fortes", workPackage: "cancel-1", breakpoint: "b",
    rounds: 1, callTimeout: 60_000, outPath: path.join(rt.paths.privateRoot, "cancel-1.plan.json"),
  });
  const authorization = await authorizeWorkPackage({ paths: rt.paths, planPath: plan.plan_path, approval: plan.plan_sha256, executionMode: "fake_cli" });
  const original = process.stdout.write;
  process.stdout.write = () => true;
  let exitCode;
  try {
    exitCode = await cancelWork({ paths: rt.paths, options: {}, adapter: { id: "test", async resolveExecutable() { return process.execPath; }, buildInvocation() {}, async notify() {} } });
  } finally {
    process.stdout.write = original;
  }
  assert.equal(exitCode, 0);
  const run = await readRun(rt.paths, authorization.run.run_id);
  assert.equal(run.closed_reason, "cancelled");
  assert.equal(run.result_sha256.length, 64);
  assert.match(afterIdentity(await latestResultCopy(rt.repoRoot, "cancel")), /^# 已取消\n/);
});

test("C7 a token row is a full sum or unknown: one unreadable or missing usage makes the whole row unknown", () => {
  const ok = (role, call) => usage(role, call, 100);
  const bad = (role, call) => ({ event: "usage", role, call, parse_error: true, tokens: { input: 0, cache_write: 0, cache_read: 0, output: 0 } });
  // One readable and one unreadable writer call: not a partial sum.
  let rows = tokenRows([{ event: "task.input", call: 1 }, ok("writer", 1), { event: "task.input", call: 2 }, bad("writer", 2)]);
  assert.deepEqual(rows.writer, { calls: 2, unreadable: 1, complete: false });
  // Two writer calls, one usage event (the other call timed out and left none).
  rows = tokenRows([{ event: "task.input", call: 1 }, ok("writer", 1), { event: "task.input", call: 2 }]);
  assert.deepEqual(rows.writer, { calls: 2, unreadable: 1, complete: false });
  // A review the controller decided itself (scope violation) never called the reviewer: not missing.
  rows = tokenRows([
    { event: "task.input", call: 1 }, ok("writer", 1),
    { event: "review.input", call: 1 }, { event: "review.result", call: 1, source: "controller", findings: [] },
  ]);
  assert.equal(rows.writer.complete, true);
  assert.deepEqual(rows.reviewer, { calls: 0, unreadable: 0, complete: true, input: 0, cache_read: 0, cache_write: 0, output: 0, total: 0, cost_usd: null });
  // A real review without usage is missing.
  rows = tokenRows([{ event: "review.input", call: 1 }, { event: "review.result", call: 1, findings: [] }]);
  assert.deepEqual(rows.reviewer, { calls: 1, unreadable: 1, complete: false });
  // The stdout line follows the same rule.
  const line = stdoutLines({ t: (key, vars = {}) => key + JSON.stringify(vars), title: "x", line: "y", latest_path: "p", tokens: rows })[2];
  assert.match(line, /"reviewer":"result\.tokens\.unknown/);
});

test("C8 rm on a run whose delivery fails still removes it, marks the day file and says why", async (t) => {
  const rt = await runtime(t);
  const { runId } = await terminalRun(rt, "cancelled");
  // Break delivery: the sealed work package record is gone.
  await fsp.rm(rt.paths.workPackagesDir, { recursive: true, force: true });
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  let exitCode;
  try {
    exitCode = await dispatchCommand({ privateRootName: ".review-bridge", command: "rm", args: [runId], repoRoot: rt.repoRoot, bridgeRoot, adapter: { id: "test", async notify() {} } });
  } finally {
    process.stdout.write = original;
  }
  const output = chunks.join("");
  assert.equal(exitCode, 0);
  assert.match(output, new RegExp("已移除 " + runId));
  assert.match(output, /結果沒交付成功：.+，已標記未交付後移除/);
  assert.equal(await fsp.stat(path.join(rt.paths.runsDir, runId + ".json")).catch(() => null), null);
  const archiveDir = rt.paths.archiveDir;
  const lines = [];
  for (const file of await fsp.readdir(archiveDir)) {
    for (const line of (await fsp.readFile(path.join(archiveDir, file), "utf8")).split("\n").filter(Boolean)) lines.push(JSON.parse(line));
  }
  const runLine = lines.find((line) => line.type === "run" && line.run_id === runId);
  assert.equal(runLine.undelivered, true);
  // A run whose delivery works is removed with its result and no warning.
  const good = await terminalRun(rt, "cancelled");
  const goodChunks = [];
  process.stdout.write = (chunk) => { goodChunks.push(String(chunk)); return true; };
  try {
    await dispatchCommand({ privateRootName: ".review-bridge", command: "rm", args: [good.runId], repoRoot: rt.repoRoot, bridgeRoot, adapter: { id: "test", async notify() {} } });
  } finally {
    process.stdout.write = original;
  }
  assert.doesNotMatch(goodChunks.join(""), /沒交付成功/);
});

test("C9 rm on an already archived run without a result still warns and leaves a removed-undelivered line", async (t) => {
  const rt = await runtime(t);
  const { runId } = await terminalRun(rt, "cancelled");
  // Folded earlier without a result (as prune does past the window).
  await mergeRun(rt.paths, runId, { undelivered: true });
  assert.ok((await readRun(rt.paths, runId)).archived_at);
  await fsp.rm(rt.paths.workPackagesDir, { recursive: true, force: true });
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    await dispatchCommand({ privateRootName: ".review-bridge", command: "rm", args: [runId], repoRoot: rt.repoRoot, bridgeRoot, adapter: { id: "test", async notify() {} } });
  } finally {
    process.stdout.write = original;
  }
  assert.match(chunks.join(""), /結果沒交付成功：.+，已標記未交付後移除/);
  const lines = [];
  for (const file of await fsp.readdir(rt.paths.archiveDir)) {
    for (const line of (await fsp.readFile(path.join(rt.paths.archiveDir, file), "utf8")).split("\n").filter(Boolean)) lines.push(JSON.parse(line));
  }
  assert.ok(lines.some((line) => line.type === "removed" && line.run_id === runId && line.undelivered === true));
});

test("C10 a run lock released between a failed create and the read is a free lock, never ENOENT", async (t) => {
  const rt = await runtime(t);
  const { snapshot } = await loadOrCreatePolicySnapshot(rt.paths);
  await fsp.mkdir(rt.paths.runLocksDir, { recursive: true });
  const runId = "race-run-0001";
  const lockPath = path.join(rt.paths.runLocksDir, runId + ".json");
  const outcomes = { acquired: 0, held: 0 };
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const now = new Date().toISOString();
    await fsp.writeFile(lockPath, JSON.stringify({ schema_version: 4, run_id: runId, lock_nonce: "other-" + attempt, pid: process.pid, acquired_at: now, heartbeat_at: now }));
    const releaser = new Promise((resolve) => setImmediate(() => fsp.rm(lockPath, { force: true }).then(resolve)));
    try {
      await withRunLock(rt.paths, runId, snapshot.effective_policy, async () => {});
      outcomes.acquired += 1;
    } catch (error) {
      assert.match(String(error.message), /already held/, "unexpected error: " + error.message);
      outcomes.held += 1;
    }
    await releaser;
    await fsp.rm(lockPath, { force: true });
  }
  assert.equal(outcomes.acquired + outcomes.held, 300);
});
