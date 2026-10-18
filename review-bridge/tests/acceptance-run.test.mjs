import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readIoEvents } from "../service/records/ioEvents.mjs";
import { readJson } from "../service/records/fileStore.mjs";
import { getBridgePaths } from "../utils/paths.mjs";

const runtimeSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.resolve(runtimeSource, "..");

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
  ], { cwd: packageRoot, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(init.status, 0, init.stderr);
  const runtime = path.join(root, ".review-bridge", "tools", "review-bridge");
  const bridge = (args, env = {}) => spawnSync(process.execPath, [path.join(runtime, "bootstrap.mjs"), ...args], {
    cwd: root, encoding: "utf8", windowsHide: true, env: { ...process.env, ...env },
  });
  t.after(async () => {
    bridge(["down"]);
    await fsp.rm(root, { recursive: true, force: true });
  });
  return { root, bridge, git, paths: getBridgePaths(root, runtime, { privateRootName: ".review-bridge" }) };
}

const ORDER = "# Work order: greeting\n\n## Work\nPrint a greeting.\n\n## Acceptance\n- The greeting is printed.\n- The output ends with a newline.\n";

async function run(rt, name, { env = {}, changeTypes = "code", allowPaths = null, scenario = "PASS", maxCalls = 1 } = {}) {
  const order = ".review-bridge/work-packages/" + name + ".md";
  await fsp.writeFile(path.join(rt.root, order), ORDER);
  const planArg = ".review-bridge/review-queue/" + name + ".plan.json";
  const planned = rt.bridge(["work-plan", "--task-file", order, "--owner", "Fortes", "--work-package", name, "--breakpoint", "return after review",
    "--change-types", changeTypes, ...(allowPaths ? ["--allow-paths", allowPaths] : []), "--max-claude-calls", String(maxCalls), "--max-claude-minutes", "2", "--out", planArg]);
  assert.equal(planned.status, 0, planned.stderr);
  const plan = await readJson(path.join(rt.root, planArg));
  const started = rt.bridge(["work-start", "--plan", planArg, "--approve", plan.plan_sha256, "--fake-cli", "--fake-scenario", scenario, "--json"], env);
  const record = await readJson(path.join(rt.paths.runsDir, plan.proposed_run_id + ".json"));
  const events = await readIoEvents(rt.paths, plan.proposed_run_id);
  const result = await fsp.readFile(path.join(rt.root, ".review-bridge", "work-packages", name + ".result.md"), "utf8").catch(() => "");
  return { exit: started.status, record, events, result };
}

test("every sealed condition is reported, judged and proven before the work is delivered, and the result lists each one", async (t) => {
  const rt = await install(t);
  const { exit, record, events, result } = await run(rt, "proven");
  assert.equal(exit, 0);
  assert.equal(record.status, "pass");
  const writer = events.find((event) => event.event === "writer.result");
  assert.deepEqual(writer.criteria.map((item) => [item.id, item.status]), [["AC1", "done"], ["AC2", "done"]]);
  const review = events.find((event) => event.event === "review.result");
  assert.deepEqual(review.verdicts.map((item) => [item.id, item.verdict]), [["AC1", "pass"], ["AC2", "pass"]]);
  const decided = events.find((event) => event.event === "acceptance");
  assert.equal(decided.decision, "proven");
  assert.deepEqual(decided.rows.map((row) => [row.id, row.gate_a, row.result]), [["AC1", "passed", "proven"], ["AC2", "passed", "proven"]]);
  // No Git in this project: the work proof is unknown, and the result says so.
  assert.equal(events.find((event) => event.event === "gate_a_result").work_version.kind, "unknown");
  assert.match(result, /## Acceptance\n- AC1 proven: The greeting is printed\. \(reviewer: pass; Gate A: passed; evidence: fake: /);
  assert.match(result, /Version checked: unknown \(no Git\)/);
});

test("in a Git project the Gate A result and the review are tied to the same commit and changes", async (t) => {
  const rt = await install(t, { withGit: true });
  const { exit, record, events, result } = await run(rt, "versioned");
  assert.equal(exit, 0, JSON.stringify(record.last_state));
  assert.equal(record.status, "pass");
  const tested = events.find((event) => event.event === "gate_a_result").work_version;
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
  assert.equal(record.status, "acceptance_unverified");
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
    ["writer-open", { FAKE_WRITER_CRITERIA: "open" }, "malformed_writer_result", "$.status: done while AC1 is not done"],
    ["review-missing", { FAKE_CODEX_VERDICT: "missing" }, "malformed_review_result", "$.verdicts: missing AC2"],
    ["review-contradiction", { FAKE_CODEX_VERDICT: "fail_under_pass" }, "malformed_review_result", "$.gate: PASS while a condition fails"],
    ["review-no-evidence", { FAKE_CODEX_VERDICT: "no_evidence" }, "malformed_review_result", "$.verdicts[0].evidence: say what shows it"],
  ];
  for (const [name, env, status, error] of cases) {
    const { exit, record } = await run(rt, name, { env });
    assert.equal(exit, 79, name);
    assert.equal(record.status, status, name);
    assert.ok(record.last_state.errors.includes(error), name + ": " + JSON.stringify(record.last_state.errors));
  }
});

test("usage Bridge cannot read stops the run at the writer and at the reviewer, instead of counting as zero", async (t) => {
  const rt = await install(t);
  const writer = await run(rt, "writer-usage", { env: { FAKE_CLAUDE_USAGE: "none" } });
  assert.equal(writer.exit, 76);
  assert.equal(writer.record.status, "usage_unknown");
  assert.equal(writer.events.some((event) => event.event === "gate_a_result" || event.event === "review.input"), false);
  assert.match(writer.result, /could not read how many tokens the writer call used/);
  const reviewer = await run(rt, "reviewer-usage", { env: { FAKE_CODEX_USAGE: "none" } });
  assert.equal(reviewer.exit, 76);
  assert.equal(reviewer.record.status, "usage_unknown");
  assert.equal(reviewer.record.last_state.token_limit_role, "reviewer");
  assert.equal(reviewer.events.some((event) => event.event === "acceptance"), false);
});

test("docs-only work runs no tests: Gate A is not applicable and each condition rests on the reviewer", async (t) => {
  const rt = await install(t);
  const { exit, record, events, result } = await run(rt, "docs", { changeTypes: "docs" });
  assert.equal(exit, 0, JSON.stringify(record.last_state));
  assert.equal(record.status, "pass");
  assert.equal(events.find((event) => event.event === "gate_a_result").kind, "not_applicable");
  assert.deepEqual(events.find((event) => event.event === "acceptance").rows.map((row) => [row.gate_a, row.result]), [["not_used", "proven"], ["not_used", "proven"]]);
  assert.match(result, /No tests run \(docs only\)/);
  assert.match(result, /Gate A: not used/);
});

test("a writer that rewrites the Git history stops the run before Gate A or review; the human decides", async (t) => {
  const rt = await install(t, { withGit: true });
  const { exit, record, events, result } = await run(rt, "rewritten", { env: { FAKE_CLAUDE_GIT_AMEND: "1" } });
  assert.equal(exit, 0);
  assert.equal(record.status, "start_point_lost");
  assert.equal(events.some((event) => event.event === "gate_a_result" || event.event === "review.input"), false);
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
  assert.equal(record.status, "evidence_changed");
  assert.match(record.last_state.error, /^writer:.*starting record/);
  assert.equal(events.some((event) => event.event === "gate_a_result" || event.event === "review.input"), false);
  assert.match(result, /work-proof record Bridge had sealed was changed/);
  // A later delivery in another process can only compare with the run record; it says so.
  assert.match(result, /work-proof records changed or no longer match what Bridge kept/);
});

test("Gate A that switches the branch stops the run before the review", async (t) => {
  const rt = await install(t, { withGit: true });
  await fsp.writeFile(path.join(rt.root, "gate.js"), "require('node:child_process').spawnSync('git', ['checkout', '-q', '-b', 'moved'], { stdio: 'ignore' });\n");
  const manifest = JSON.parse(await fsp.readFile(path.join(rt.root, "package.json"), "utf8"));
  await fsp.writeFile(path.join(rt.root, "package.json"), JSON.stringify({ ...manifest, scripts: { test: "node gate.js" } }));
  rt.git("add", "-A");
  rt.git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "gate that switches");
  const { exit, record, events } = await run(rt, "gate-switch");
  assert.equal(exit, 0, JSON.stringify(record.last_state));
  assert.equal(record.status, "start_point_lost");
  assert.match(record.last_state.error, /^git_start:gate_a/);
  assert.equal(events.some((event) => event.event === "review.input"), false);
});

test("work that changes while the reviewer reads it stops the run; the verdicts are not counted", async (t) => {
  const rt = await install(t, { withGit: true });
  const { exit, record, events } = await run(rt, "moving", { env: { FAKE_CODEX_TOUCH: "1" } });
  assert.equal(exit, 0, JSON.stringify(record.last_state));
  assert.equal(record.status, "version_changed");
  assert.notEqual(record.last_state.review_version.fingerprint, record.last_state.version_after_review.fingerprint);
  assert.equal(events.some((event) => event.event === "acceptance"), false);
});

// Codex review round 3 of the work proof. Each test was run against the code before its fix and failed.

test("an out-of-scope change hidden behind a forged overlapping record of an existing run is never delivered as passed", async (t) => {
  const rt = await install(t, { withGit: true });
  const { exit, record, events } = await run(rt, "forged", { allowPaths: "src", env: { FAKE_CLAUDE_WRITE: "README.md", FAKE_CLAUDE_FORGE_WINDOW: "1" } });
  assert.notEqual(record.status, "pass", JSON.stringify(record.last_state));
  assert.equal(record.status, "scope_unverified");
  assert.equal(exit, 0);
  const proof = events.find((event) => event.event === "review.input").work_proof;
  assert.deepEqual(proof.scope_unverified, ["README.md"]);
});

test("a failing writer call that rewrote an earlier call record ends as evidence_changed, and the result uses no unchecked record", async (t) => {
  const rt = await install(t, { withGit: true });
  const { record, result } = await run(rt, "rewrites-records", { scenario: "FAIL_THEN_PASS", maxCalls: 2, env: { FAKE_CLAUDE_WRITE: "src/app.js", FAKE_CLAUDE_WINDOW_TAMPER_CALL: "2" } });
  assert.equal(record.status, "evidence_changed", JSON.stringify(record.last_state));
  assert.match(record.last_state.error, /^writer:.*call record/);
  assert.match(result, /No work proof: the run's work-proof records changed/);
  // No changed-file line comes from the unchecked records (a reviewer finding may still name the file).
  assert.doesNotMatch(result, /^- src\/app\.js（/m);
});

test("a failing review that rewrote a call record ends as evidence_changed, not as a reviewer failure", async (t) => {
  const rt = await install(t, { withGit: true });
  const { record } = await run(rt, "review-rewrites", { env: { FAKE_CLAUDE_WRITE: "src/app.js", FAKE_CODEX_WINDOW_TAMPER: "1" } });
  assert.equal(record.status, "evidence_changed", JSON.stringify(record.last_state));
  assert.match(record.last_state.error, /^review:.*call record/);
});
