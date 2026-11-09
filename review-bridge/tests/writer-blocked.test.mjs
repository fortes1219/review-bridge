// A writer that could not run the tests where it is (Codex's sandbox on Windows: spawn EPERM) is not a
// stopped run. Bridge runs them itself and they decide; the result says what each side knows. Canary,
// 2026-11-05: a run ended "blocked" with a Why of one line, on a project already holding those files.
import { dataHome, queryRecords, stopPage } from "./fixtures/isolatedDataHome.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { composeWriterPrompt } from "../features/workOrder/writerPrompt.mjs";
import { readJson } from "../service/records/fileStore.mjs";
import { latestResultCopy } from "./fixtures/resultCopies.mjs";

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

const ORDER = "# Work order: farm\n\n<!-- bridge:requested_work -->\nBuild a small farm.\n\n<!-- bridge:acceptance -->\n- The farm is visible.\n- The tests pass.\n";
const git = (root, ...args) => spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf8", windowsHide: true });

// A Git project. With `tests`, its package.json gives Bridge a test command, so the conditions lean on it.
async function project(t, { tests = true, testExit = 0 } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-blocked-"));
  await fsp.writeFile(path.join(root, "README.md"), "# demo\n");
  if (tests) await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "blocked-demo", dependencies: { express: "4.0.0" }, scripts: { test: "node -e \"process.exit(" + testExit + ")\"" } }));
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "start");
  const init = spawnSync(process.execPath, [
    path.join(packageRoot, "bridge.mjs"), "init", "--target", root, "--writer", "codex", "--reviewer", "codex", "--yes", "--fake-cli", "--port", String(await freePort()),
  ], { cwd: packageRoot, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, REVIEW_BRIDGE_DATA_HOME: dataHome } });
  assert.equal(init.status, 0, init.stderr);
  const callLog = path.join(root, ".git", "calls.jsonl");
  const bridge = (args, env = {}) => spawnSync(process.execPath, [path.join(runtimeSource, "bootstrap.mjs"), ...args], { cwd: root, encoding: "utf8", windowsHide: true, env: { ...process.env, FAKE_CALL_LOG: callLog, ...env } });
  t.after(async () => {
    await stopPage(root);
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });
  const run = async (env) => {
    const order = ".review-bridge/work-packages/farm.md";
    await fsp.writeFile(path.join(root, order), ORDER);
    const planPath = path.join(root, ".review-bridge", "farm.plan.json");
    const planned = bridge(["work-plan", order, "--fake-cli", "--breakpoint", "after the review", "--rounds", "1", "--call-timeout", "120000", "--out", planPath]);
    assert.equal(planned.status, 0, planned.stderr);
    const plan = await readJson(planPath);
    const started = bridge(["work-start", "--plan", planPath, "--approve", plan.plan_sha256, "--fake-cli", "--json"], env);
    const modes = (await fsp.readFile(callLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line).mode);
    const [row] = await queryRecords("select conclusion, closed_reason from runs where run_id = $1", [plan.proposed_run_id]);
    return { started, modes, row, plan, result: await latestResultCopy(root, "farm") };
  };
  return { root, run };
}

const COULD_NOT_RUN = { FAKE_WRITER_STATUS: "blocked", FAKE_WRITER_CRITERIA: "open", FAKE_WRITER_UNVERIFIED: "npm test: spawn EPERM in the sandbox" };

// Code cannot tell which conditions the tests show (Owner 2026-11-08, choice A): in a project whose tests
// Bridge runs, a writer blocked on any condition and asking nothing goes on to the tests and the review.
test("blocked on a condition it could not check, asking nothing, where Bridge runs the tests: the tests and the reviewer judge the work, and it is delivered", { timeout: 180_000 }, async (t) => {
  const { run } = await project(t);
  const { started, modes, row } = await run(COULD_NOT_RUN);
  assert.equal(started.status, 0, started.stderr + started.stdout);
  assert.deepEqual(modes, ["writer", "review"], "the review is reached");
  assert.deepEqual(row, { conclusion: "success", closed_reason: "review_pass" });
});

test("the tests really do decide: a blocked writer whose tests fail is not delivered, and nothing reviews it", { timeout: 180_000 }, async (t) => {
  const { run } = await project(t, { testExit: 1 });
  const { modes, row } = await run(COULD_NOT_RUN);
  assert.deepEqual(modes, ["writer"], "failed tests skip the review");
  assert.notEqual(row.conclusion, "success");
  assert.equal(row.closed_reason, "rounds_exhausted");
});

// No condition is the tests' to decide any more, so "done" with one not done is a contradiction even where
// Bridge runs the tests; the writer who could not run them says so in unverified and stays done.
test("status done with a condition not done is refused even where Bridge runs the tests", { timeout: 180_000 }, async (t) => {
  const { run } = await project(t);
  const { started, modes, row, result } = await run({ FAKE_WRITER_CRITERIA: "open", FAKE_WRITER_UNVERIFIED: "could not run the tests here" });
  assert.equal(started.status, 79, started.stderr + started.stdout);
  assert.deepEqual(modes, ["writer"]);
  assert.equal(row.closed_reason, "malformed_writer_result");
  assert.match(result, /\$\.status: done while AC1 is not done/);
});

test("blocked and asking the person stops, and says it: the Why has the writer's words, the changes three lists", { timeout: 180_000 }, async (t) => {
  const { root, run } = await project(t);
  // Left in the tree by someone else, before this run: not this run's change.
  await fsp.writeFile(path.join(root, "left-behind.txt"), "from before\n");
  await fsp.appendFile(path.join(root, "README.md"), "edited before the run\n");
  const { modes, row, result } = await run({ ...COULD_NOT_RUN, FAKE_WRITER_ASKS: "1" });
  assert.deepEqual(modes, ["writer"], "no review");
  assert.equal(row.closed_reason, "needs_human");
  assert.match(result, /Writer reported status: blocked/);
  assert.match(result, /What the writer says it could not check:\n- npm test: spawn EPERM in the sandbox/);
  assert.match(result, /The writer on each condition \(its own word, not a finding\):\n- AC1 not_done: fake: done for AC1\n- AC2 done: fake: done for AC2/);
  const section = result.slice(result.indexOf("## Files changed"), result.indexOf("## Tokens"));
  assert.match(section, /Work proof from Git/);
  assert.match(section, /No files were changed\./, "Git's answer: nothing since the start");
  assert.match(section, /### What the writer says it changed \(not checked against Git\)\n- README\.md/, "the writer's claim, marked as one");
  assert.match(section, /### Already uncommitted when the run started\n- README\.md\n- left-behind\.txt/);
  assert.doesNotMatch(section, /\.review-bridge\//, "Bridge's own folder is not the person's uncommitted work");
});

test("blocked with no test to decide it stops as before", { timeout: 180_000 }, async (t) => {
  const { run } = await project(t, { tests: false });
  const { modes, row, result } = await run(COULD_NOT_RUN);
  assert.deepEqual(modes, ["writer"]);
  assert.equal(row.closed_reason, "needs_human");
  assert.match(result, /npm test: spawn EPERM in the sandbox/);
});

test("status done with a condition only the reviewer can judge still not done is refused", { timeout: 180_000 }, async (t) => {
  const { run } = await project(t, { tests: false });
  const { started, modes, row, result } = await run({ FAKE_WRITER_CRITERIA: "open" });
  assert.equal(started.status, 79, started.stderr + started.stdout);
  assert.deepEqual(modes, ["writer"]);
  assert.equal(row.closed_reason, "malformed_writer_result");
  assert.match(result, /\$\.status: done while AC1 is not done/);
});

test("the prompt says who runs the tests only when Bridge will, whichever provider writes", () => {
  const compose = (testRule) => composeWriterPrompt({
    workPackage: { work_package_id: "w", scope: { allowed_paths: ["**"], forbidden_paths: [] }, breakpoint: "b", test: testRule },
    control: {}, runId: "r", call: 1, taskInput: { limits: { max_turns: 1, max_output_chars: 1 } }, references: [], rulesText: "", contract: { sha256: "0".repeat(64), contract: {} },
  });
  const withTests = compose({ kind: "command", command: "npm test" });
  assert.match(withTests, /Bridge itself runs the project's tests \(npm test\) outside your sandbox/);
  assert.match(withTests, /That they cannot run where you are is not a reason to be blocked: write that in unverified and keep status done\./);
  // The writer is not asked to run the tests: Bridge runs them, and the writer's run would be no evidence (Fortes 2026-11-09).
  assert.doesNotMatch(withTests, /Run them if you can/);
  // Every condition, with tests or without: none is set apart as the tests'.
  for (const prompt of [withTests, compose({ kind: "not_configured" })]) {
    assert.match(prompt, /status is done only if every condition is done\./);
    assert.doesNotMatch(prompt, /apart from the ones the project's tests decide/);
  }
  assert.doesNotMatch(compose({ kind: "not_configured" }), /Bridge itself runs/);
});
