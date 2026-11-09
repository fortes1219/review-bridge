// Keeps the person's database out of these tests (see the fixture).
import { dataHome } from "./fixtures/isolatedDataHome.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readIoEvents } from "../service/records/ioEvents.mjs";
import { readJson } from "../service/records/fileStore.mjs";
import { getBridgePaths } from "../utils/paths.mjs";
import { latestResultCopy } from "./fixtures/resultCopies.mjs";

const runtimeSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.resolve(runtimeSource, "..");
// init saves the default roles in the data home; keep it out of the real user profile.

async function freePort() {
  const net = await import("node:net");
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// A neutral install made by the real init in fake mode; every model call below is the fake CLI.
async function install(t, { withGit = false } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-acceptance-"));
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "acceptance-demo", dependencies: { express: "4.0.0" }, scripts: { test: "node -e \"process.exit(0)\"" } }));
  await fsp.writeFile(path.join(root, "README.md"), "# demo\n");
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  await fsp.mkdir(path.join(root, "src"), { recursive: true });
  await fsp.writeFile(path.join(root, "src", "app.js"), "// app\n");
  if (withGit) {
    git("init", "-q");
    git("add", "-A");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "start");
  }
  const init = spawnSync(process.execPath, [
    path.join(packageRoot, "bridge.mjs"), "init", "--target", root, "--writer", "claude", "--reviewer", "codex", "--yes", "--fake-cli", "--port", String(await freePort()),
  ], { cwd: packageRoot, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, REVIEW_BRIDGE_DATA_HOME: dataHome } });
  assert.equal(init.status, 0, init.stderr);
  const runtime = runtimeSource;
  const bridge = (args, env = {}) => spawnSync(process.execPath, [path.join(runtime, "bootstrap.mjs"), ...args], {
    cwd: root, encoding: "utf8", windowsHide: true, env: { ...process.env, ...env },
  });
  t.after(async () => {
    bridge(["down"]);
    await fsp.rm(root, { recursive: true, force: true });
  });
  return { root, bridge, git, paths: getBridgePaths(root, runtime, { privateRootName: ".review-bridge" }) };
}

const ORDER = "# Work order: greeting\n\n<!-- bridge:requested_work -->\n## Work\nPrint a greeting.\n\n<!-- bridge:acceptance -->\n## Acceptance\n- The greeting is printed.\n- The output ends with a newline.\n";

async function run(rt, name, { env = {}, allowPaths = null, scenario = "PASS", maxCalls = 1 } = {}) {
  const order = ".review-bridge/work-packages/" + name + ".md";
  await fsp.writeFile(path.join(rt.root, order), ORDER);
  const planArg = ".review-bridge/review-queue/" + name + ".plan.json";
  const planned = rt.bridge(["work-plan", "--fake-cli", "--task-file", order, "--owner", "Fortes", "--work-package", name, "--breakpoint", "return after review",
    ...(allowPaths ? ["--allow-paths", allowPaths] : []), "--rounds", String(maxCalls), "--call-timeout", "120000", "--out", planArg]);
  assert.equal(planned.status, 0, planned.stderr);
  const plan = await readJson(path.join(rt.root, planArg));
  const started = rt.bridge(["work-start", "--plan", planArg, "--approve", plan.plan_sha256, "--fake-cli", "--fake-scenario", scenario, "--json"], env);
  const record = await readJson(path.join(rt.paths.runsDir, plan.proposed_run_id + ".json"));
  const events = await readIoEvents(rt.paths, plan.proposed_run_id);
  const result = await latestResultCopy(rt.root, name);
  return { exit: started.status, record, events, result };
}

test("every sealed condition is reported, judged and proven before the work is delivered, and the result lists each one", async (t) => {
  const rt = await install(t);
  const { exit, record, events, result } = await run(rt, "proven");
  assert.equal(exit, 0);
  assert.equal(record.conclusion, "success");
  const writer = events.find((event) => event.event === "writer.result");
  assert.deepEqual(writer.criteria.map((item) => [item.id, item.status]), [["AC1", "done"], ["AC2", "done"]]);
  const review = events.find((event) => event.event === "review.result");
  assert.deepEqual(review.verdicts.map((item) => [item.id, item.verdict]), [["AC1", "pass"], ["AC2", "pass"]]);
  const decided = events.find((event) => event.event === "acceptance");
  assert.equal(decided.decision, "proven");
  // Each condition is the reviewer's verdict and its evidence; the tests are not a column of it (they ran on
  // the version the reviewer read), and no condition carries a way to verify it of its own (RC3-COST-01).
  assert.deepEqual(decided.rows.map((row) => [row.id, row.result]), [["AC1", "proven"], ["AC2", "proven"]]);
  assert.ok(decided.rows.every((row) => !("test" in row)), JSON.stringify(decided.rows));
  // No Git in this project: the work proof is unknown, and the result says so.
  assert.equal(events.find((event) => event.event === "test_result").work_version.kind, "unknown");
  assert.match(result, /## Acceptance\n- AC1 proven: The greeting is printed\. \(reviewer: pass; evidence: fake: /);
  assert.match(result, /Version checked: unknown \(no Git\)/);
});

test("in a Git project the test result and the review are tied to the same commit and changes", async (t) => {
  const rt = await install(t, { withGit: true });
  const { exit, record, events, result } = await run(rt, "versioned");
  assert.equal(exit, 0, JSON.stringify(record.last_state));
  assert.equal(record.conclusion, "success");
  const tested = events.find((event) => event.event === "test_result").work_version;
  const decided = events.find((event) => event.event === "acceptance");
  assert.equal(tested.kind, "git");
  assert.equal(decided.review_version.fingerprint, tested.fingerprint);
  assert.match(result, new RegExp("Checked on commit " + tested.head.slice(0, 12)));
  // Bridge only read Git: the project's own history and index were left alone.
  assert.equal(rt.git("log", "--oneline").stdout.trim().split("\n").length, 1);
  assert.equal(rt.git("diff", "--cached", "--name-only").stdout.trim(), "");
});

test("a condition the reviewer cannot verify is not delivered as passed; the human gets each condition's state", async (t) => {
  const rt = await install(t);
  const { exit, record, events, result } = await run(rt, "unverified", { env: { FAKE_CODEX_VERDICT: "cannot_verify" } });
  assert.equal(exit, 0);
  assert.equal(record.closed_reason, "acceptance_unverified");
  assert.equal(events.find((event) => event.event === "review.result").gate, "PASS");
  assert.deepEqual(events.find((event) => event.event === "acceptance").rows.map((row) => row.result), ["unknown", "proven"]);
  assert.match(result, /^# Your decision needed/m);
  assert.match(result, /- AC1 unknown: The greeting is printed\. \(reviewer: cannot_verify;/);
  assert.match(result, /not every condition was shown to hold/);
});

test("answers that skip, repeat or contradict a condition are refused, from the writer and from the reviewer", async (t) => {
  const rt = await install(t);
  const cases = [
    ["writer-missing", { FAKE_WRITER_CRITERIA: "missing" }, "malformed_writer_result", "$.criteria: missing AC2"],
    ["writer-duplicate", { FAKE_WRITER_CRITERIA: "duplicate" }, "malformed_writer_result", "$.criteria[2].id: duplicate AC1"],
    ["review-missing", { FAKE_CODEX_VERDICT: "missing" }, "malformed_review_result", "$.verdicts: missing AC2"],
    ["review-contradiction", { FAKE_CODEX_VERDICT: "fail_under_pass" }, "malformed_review_result", "$.gate: PASS while a condition fails"],
    ["review-no-evidence", { FAKE_CODEX_VERDICT: "no_evidence" }, "malformed_review_result", "$.verdicts[0].evidence: say what shows it"],
  ];
  for (const [name, env, status, error] of cases) {
    const { exit, record } = await run(rt, name, { env });
    assert.equal(exit, 79, name);
    assert.equal(record.closed_reason, status, name);
    assert.ok(record.last_state.errors.includes(error), name + ": " + JSON.stringify(record.last_state.errors));
  }
});

// Run f645ccf5 (2026-11-09): a reviewer answered PASS with a hard stop, which the review's rules forbid,
// and the run ended at once. An answer that breaks the rules is asked for once more with what was wrong;
// only the second one that breaks them ends the run.
test("a review that breaks the review's rules is asked for again with what was wrong; a second such answer ends the run", async (t) => {
  const rt = await install(t);
  const once = await run(rt, "pass-stop-once", { env: { FAKE_CODEX_VERDICT: "pass_hard_stop_once" } });
  assert.equal(once.exit, 0, JSON.stringify(once.record.last_state));
  assert.equal(once.record.conclusion, "success");
  const inputs = once.events.filter((event) => event.event === "review.input");
  assert.equal(inputs.length, 2, "asked twice for the one call");
  assert.equal(inputs[0].previous_answer_problems, undefined);
  assert.deepEqual(inputs[1].previous_answer_problems, ["$.hard_stop: PASS cannot request a hard stop"]);
  const twice = await run(rt, "pass-stop-twice", { env: { FAKE_CODEX_VERDICT: "pass_hard_stop" } });
  assert.equal(twice.exit, 79);
  assert.equal(twice.record.closed_reason, "malformed_review_result");
  assert.equal(twice.events.filter((event) => event.event === "review.input").length, 2, "one more ask, not more");
  assert.ok(twice.record.last_state.errors.includes("$.hard_stop: PASS cannot request a hard stop"));
});

// The budget is the writer's (Owner 2026-11-08): a writer call whose usage cannot be read stops the run,
// since the budget cannot be kept without it; the reviewer's usage is recorded and counts against no
// budget, so an unreadable one is shown as unknown and the work goes on.
test("writer usage Bridge cannot read stops the run instead of counting as zero; the reviewer's is recorded as unknown and stops nothing", async (t) => {
  const rt = await install(t);
  const writer = await run(rt, "writer-usage", { env: { FAKE_CLAUDE_USAGE: "none" } });
  assert.equal(writer.exit, 76);
  assert.equal(writer.record.closed_reason, "usage_unknown");
  assert.equal(writer.events.some((event) => event.event === "test_result" || event.event === "review.input"), false);
  assert.match(writer.result, /could not read how many tokens the writer call used/);
  const reviewer = await run(rt, "reviewer-usage", { env: { FAKE_CODEX_USAGE: "none" } });
  assert.equal(reviewer.exit, 0, JSON.stringify(reviewer.record.last_state));
  assert.equal(reviewer.record.conclusion, "success");
  assert.equal(reviewer.events.some((event) => event.event === "stop" && event.status === "usage_unknown"), false);
  const usage = reviewer.events.find((event) => event.event === "usage" && event.role === "reviewer");
  assert.equal(usage.parse_error, true, JSON.stringify(usage));
  assert.match(reviewer.result, /^\| reviewer \| 1 \(1 unreadable\) \| unknown \|/m);
});

test("a project whose rules give no test command still runs: its tests are not configured and each condition rests on the reviewer", async (t) => {
  const rt = await install(t);
  // The profile's rule needs a test script; without one no rule gives a command.
  await fsp.writeFile(path.join(rt.root, "package.json"), JSON.stringify({ name: "acceptance-demo", dependencies: { express: "4.0.0" } }));
  const { exit, record, events, result } = await run(rt, "untested");
  assert.equal(exit, 0, JSON.stringify(record.last_state));
  assert.equal(record.conclusion, "success");
  assert.equal(events.find((event) => event.event === "test_result").kind, "not_configured");
  assert.deepEqual(events.find((event) => event.event === "acceptance").rows.map((row) => row.result), ["proven", "proven"]);
  assert.match(result, /Tests: not configured for this project/);
  // The conditions rest on the reviewer's verdicts; no condition line speaks of tests.
  assert.match(result, /- AC1 proven: The greeting is printed\. \(reviewer: pass; evidence: /);
  assert.doesNotMatch(result, /tests: not used/);
});

test("a writer that rewrites the Git history stops the run before the tests or review; the human decides", async (t) => {
  const rt = await install(t, { withGit: true });
  const { exit, record, events, result } = await run(rt, "rewritten", { env: { FAKE_CLAUDE_GIT_AMEND: "1" } });
  assert.equal(exit, 0);
  assert.equal(record.closed_reason, "start_point_lost");
  assert.equal(events.some((event) => event.event === "test_result" || event.event === "review.input"), false);
  assert.match(result, /^# Your decision needed/m);
  assert.match(result, /history was rewritten or the branch switched/);
});

test("without Git the result says there is no work proof instead of claiming nothing changed", async (t) => {
  const rt = await install(t);
  const { result } = await run(rt, "no-proof");
  assert.match(result, /No work proof: this project has no Git/);
  assert.doesNotMatch(result, /No files were changed\./);
});

// Codex review round 2 of the work proof, end to end.

test("a writer that rewrites the run's starting record is caught after its call and the run stops", async (t) => {
  const rt = await install(t, { withGit: true });
  const { exit, record, events, result } = await run(rt, "tampered", { env: { FAKE_CLAUDE_EVIDENCE_TAMPER: "1" } });
  assert.equal(exit, 0);
  assert.equal(record.closed_reason, "evidence_changed");
  assert.match(record.last_state.error, /^writer:.*starting record/);
  assert.equal(events.some((event) => event.event === "test_result" || event.event === "review.input"), false);
  assert.match(result, /work-proof record Bridge had sealed was changed/);
  // A later delivery in another process can only compare with the run record; it says so.
  assert.match(result, /work-proof records changed or no longer match what Bridge kept/);
});

test("tests that switch the branch stops the run before the review", async (t) => {
  const rt = await install(t, { withGit: true });
  await fsp.writeFile(path.join(rt.root, "gate.js"), "require('node:child_process').spawnSync('git', ['checkout', '-q', '-b', 'moved'], { stdio: 'ignore' });\n");
  const manifest = JSON.parse(await fsp.readFile(path.join(rt.root, "package.json"), "utf8"));
  await fsp.writeFile(path.join(rt.root, "package.json"), JSON.stringify({ ...manifest, scripts: { test: "node gate.js" } }));
  rt.git("add", "-A");
  rt.git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "gate that switches");
  const { exit, record, events } = await run(rt, "gate-switch");
  assert.equal(exit, 0, JSON.stringify(record.last_state));
  assert.equal(record.closed_reason, "start_point_lost");
  assert.match(record.last_state.error, /^git_start:test/);
  assert.equal(events.some((event) => event.event === "review.input"), false);
});

// Decision 2026-10-19: what the tests ran on must be what the reviewer reads. Here the tests themselves leaves
// a change behind, the way another run working in the same folder would between the two.
test("a project that changes after the tests ran on it stops the run before any review, and the result says why", async (t) => {
  const rt = await install(t, { withGit: true });
  await fsp.writeFile(path.join(rt.root, "gate.js"), "require('node:fs').appendFileSync('README.md', 'changed beside the run\\n');\n");
  const manifest = JSON.parse(await fsp.readFile(path.join(rt.root, "package.json"), "utf8"));
  await fsp.writeFile(path.join(rt.root, "package.json"), JSON.stringify({ ...manifest, scripts: { test: "node gate.js" } }));
  rt.git("add", "-A");
  rt.git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "gate that leaves a change");
  const { exit, record, events, result } = await run(rt, "after-gate");
  assert.equal(exit, 0, JSON.stringify(record.last_state));
  assert.equal(record.closed_reason, "version_changed");
  assert.equal(record.last_state.changed_after, "test");
  assert.notEqual(record.last_state.tested_version.fingerprint, record.last_state.review_version.fingerprint);
  // No review is paid for, and no condition is passed.
  assert.equal(events.some((event) => event.event === "review.input"), false);
  assert.equal(events.some((event) => event.event === "acceptance"), false);
  assert.match(result, /changed after the tests ran on it and before the reviewer read it/);
  assert.match(result, /Another run working in this folder, or a person, may have changed files/);
});

// Decision 2026-10-17: runs of different work orders work side by side in one folder.
test("two work orders started at the same time both run, side by side, and neither leaves a run behind", async (t) => {
  const rt = await install(t, { withGit: true });
  const plans = [];
  for (const name of ["north", "south"]) {
    const order = ".review-bridge/work-packages/" + name + ".md";
    await fsp.writeFile(path.join(rt.root, order), ORDER);
    const planArg = ".review-bridge/review-queue/" + name + ".plan.json";
    const planned = rt.bridge(["work-plan", "--fake-cli", "--task-file", order, "--owner", "Fortes", "--work-package", name, "--breakpoint", "return after review",
      "--rounds", "1", "--call-timeout", "120000", "--out", planArg]);
    assert.equal(planned.status, 0, planned.stderr);
    plans.push({ name, planArg, plan: await readJson(path.join(rt.root, planArg)) });
  }
  const bootstrap = path.join(runtimeSource, "bootstrap.mjs");
  const exits = await Promise.all(plans.map(({ planArg, plan }) => new Promise((resolve) => {
    const child = spawn(process.execPath, [bootstrap, "work-start", "--plan", planArg, "--approve", plan.plan_sha256, "--fake-cli", "--json"], {
      cwd: rt.root, windowsHide: true, env: { ...process.env, FAKE_CLAUDE_SLEEP_MS: "2500", FAKE_CODEX_SLEEP_MS: "1500" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("close", (code) => resolve({ code, stderr }));
  })));
  for (const [index, { code, stderr }] of exits.entries()) assert.equal(code, 0, plans[index].name + ": " + stderr);
  const records = await Promise.all(plans.map(({ plan }) => readJson(path.join(rt.paths.runsDir, plan.proposed_run_id + ".json"))));
  for (const record of records) {
    assert.equal(record.conclusion, "success", JSON.stringify(record.last_state));
    assert.equal(record.closed_reason === "superseded", false);
  }
  // Each writer started before the other one finished: they worked at the same time, not in turn.
  const [north, south] = await Promise.all(plans.map(({ plan }) => readIoEvents(rt.paths, plan.proposed_run_id)));
  const at = (events, name) => events.find((event) => event.event === name).occurred_at;
  assert.ok(at(north, "task.input") < at(south, "writer.result") && at(south, "task.input") < at(north, "writer.result"), "the two writers did not overlap");
  // And the two reviews ran at the same time too: no project-wide review lock holds one back.
  assert.ok(at(north, "review.input") < at(south, "review.result") && at(south, "review.input") < at(north, "review.result"), "the two reviews did not overlap");
  // Nothing is left running, and each work order has its own result.
  const active = (await Promise.all((await fsp.readdir(rt.paths.runsDir)).filter((file) => file.endsWith(".json"))
    .map((file) => readJson(path.join(rt.paths.runsDir, file))))).filter((run) => ["running", "review_pending", "correction_pending", "interrupted"].includes(run.status));
  assert.deepEqual(active, []);
  for (const { name } of plans) assert.match(await latestResultCopy(rt.root, name), /# Delivered/);
});

test("work that changes while the reviewer reads it stops the run; the verdicts are not counted", async (t) => {
  const rt = await install(t, { withGit: true });
  const { exit, record, events, result } = await run(rt, "moving", { env: { FAKE_CODEX_TOUCH: "1" } });
  assert.equal(exit, 0, JSON.stringify(record.last_state));
  assert.equal(record.closed_reason, "version_changed");
  assert.notEqual(record.last_state.review_version.fingerprint, record.last_state.version_after_review.fingerprint);
  assert.equal(events.some((event) => event.event === "acceptance"), false);
  // The result says the change came during the review, not after the tests, and who may have made it.
  assert.equal(record.last_state.changed_after, "review_start");
  assert.match(result, /changed while the reviewer was reading it/);
  assert.doesNotMatch(result, /changed after the tests ran on it/);
  assert.match(result, /Another run working in this folder, or a person, may have changed files/);
});

// Codex review round 3 of the work proof. Each test was run against the code before its fix and failed.

test("an out-of-scope change hidden behind a forged overlapping record of an existing run is never delivered as passed", async (t) => {
  const rt = await install(t, { withGit: true });
  const { exit, record, events } = await run(rt, "forged", { allowPaths: "src", env: { FAKE_CLAUDE_WRITE: "README.md", FAKE_CLAUDE_FORGE_WINDOW: "1" } });
  assert.notEqual(record.conclusion, "success", JSON.stringify(record.last_state));
  assert.equal(record.closed_reason, "scope_unverified");
  assert.equal(exit, 0);
  const proof = events.find((event) => event.event === "review.input").work_proof;
  assert.deepEqual(proof.scope_unverified, ["README.md"]);
});

test("a failing writer call that rewrote an earlier call record ends as evidence_changed, and the result uses no unchecked record", async (t) => {
  const rt = await install(t, { withGit: true });
  const { record, result } = await run(rt, "rewrites-records", { scenario: "FAIL_THEN_PASS", maxCalls: 2, env: { FAKE_CLAUDE_WRITE: "src/app.js", FAKE_CLAUDE_WINDOW_TAMPER_CALL: "2" } });
  assert.equal(record.closed_reason, "evidence_changed", JSON.stringify(record.last_state));
  assert.match(record.last_state.error, /^writer:.*call record/);
  assert.match(result, /No work proof: the run's work-proof records changed/);
  // No changed-file line comes from the unchecked records (a reviewer finding may still name the file).
  assert.doesNotMatch(result, /^- src\/app\.js（/m);
});

test("a failing review that rewrote a call record ends as evidence_changed, not as a reviewer failure", async (t) => {
  const rt = await install(t, { withGit: true });
  const { record } = await run(rt, "review-rewrites", { env: { FAKE_CLAUDE_WRITE: "src/app.js", FAKE_CODEX_WINDOW_TAMPER: "1" } });
  assert.equal(record.closed_reason, "evidence_changed", JSON.stringify(record.last_state));
  assert.match(record.last_state.error, /^review:.*call record/);
});
