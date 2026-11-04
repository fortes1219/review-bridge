// Keeps the person's database out of these tests (see the fixture).
import { dataHome, queryRecords } from "./fixtures/isolatedDataHome.mjs";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadContract } from "../features/workOrder/contract.mjs";
import { workOrderChange } from "../features/workOrder/delivery.mjs";
import { processFile, startLockFile, workLockFile } from "../features/workOrder/processRecords.mjs";
import { workLockReleased, workOrderLocation } from "../features/workOrder/workPackage.mjs";
import { unsupportedContractStep } from "../features/workOrder/translation.mjs";
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
async function install(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-contract-run-"));
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "contract-demo", dependencies: { express: "4.0.0" }, scripts: { test: "node -e \"process.exit(0)\"" } }));
  await fsp.writeFile(path.join(root, "README.md"), "# demo\n");
  const init = spawnSync(process.execPath, [
    path.join(packageRoot, "bridge.mjs"), "init", "--target", root, "--writer", "claude", "--reviewer", "codex", "--yes", "--fake-cli", "--port", String(await freePort()),
  ], { cwd: packageRoot, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, REVIEW_BRIDGE_DATA_HOME: dataHome } });
  assert.equal(init.status, 0, init.stderr);
  const runtime = runtimeSource;
  const bootstrap = path.join(runtime, "bootstrap.mjs");
  const bridge = (args, env = {}) => spawnSync(process.execPath, [bootstrap, ...args], {
    cwd: root, encoding: "utf8", windowsHide: true, env: { ...process.env, ...env },
  });
  t.after(async () => {
    bridge(["down"]);
    await fsp.rm(root, { recursive: true, force: true });
  });
  return { root, bootstrap, bridge, paths: getBridgePaths(root, runtime, { privateRootName: ".review-bridge" }) };
}

const planArgs = (order, name, planArg) => ["work-plan", "--task-file", order, "--owner", "Fortes", "--work-package", name,
  "--breakpoint", "return after review", "--rounds", "1", "--call-timeout", "120000", "--out", planArg];

async function planWork(rt, name, text) {
  const order = ".review-bridge/work-packages/" + name + ".md";
  await fsp.writeFile(path.join(rt.root, order), text);
  const planArg = ".review-bridge/review-queue/" + name + "-" + Math.random().toString(16).slice(2, 8) + ".plan.json";
  const planned = rt.bridge(planArgs(order, name, planArg));
  assert.equal(planned.status, 0, planned.stderr);
  return { plan: await readJson(path.join(rt.root, planArg)), planArg, order };
}

// A plan for a work order at a given path, with its own work package id.
async function planAt(rt, order, id, text) {
  await fsp.writeFile(path.join(rt.root, order), text);
  const planArg = ".review-bridge/review-queue/" + id + "-" + Math.random().toString(16).slice(2, 8) + ".plan.json";
  const planned = rt.bridge(planArgs(order, id, planArg));
  assert.equal(planned.status, 0, planned.stderr);
  return { plan: await readJson(path.join(rt.root, planArg)), planArg, order };
}

async function planOf(rt, name, text) {
  return await planWork(rt, name, text);
}

function start(rt, { plan, planArg }, env = {}) {
  return rt.bridge(["work-start", "--plan", planArg, "--approve", plan.plan_sha256, "--fake-cli", "--json"], env);
}

const runOf = async (rt, work) => await readJson(path.join(rt.paths.runsDir, work.plan.proposed_run_id + ".json"));
const eventsOf = async (rt, work) => await readIoEvents(rt.paths, work.plan.proposed_run_id);
const resultOf = async (rt, name) => await latestResultCopy(rt.root, name);

// A prepared translation (or one per attempt) for the fake CLI to return, as if the model wrote it.
async function translationFile(rt, value) {
  const file = path.join(rt.root, "translation-" + Math.random().toString(16).slice(2, 8) + ".json");
  await fsp.writeFile(file, JSON.stringify(value));
  return file;
}

// What the model writes: the conditions only; Bridge fills every other field from the blocks.
const translation = (acceptance) => ({ event: "contract.translation", acceptance });
const visible = { id: "AC1", statement: "The farm is visible.", quote: "The farm is visible.", source_refs: [{ start: 9, end: 9 }], verify: [{ kind: "test", check: null }] };

const SINGLE = [
  "# Work order: farm",                // 1
  "",                                  // 2
  "<!-- bridge:requested_work -->",    // 3
  "## Work",                           // 4
  "Build a small farm.",               // 5
  "",                                  // 6
  "<!-- bridge:acceptance -->",        // 7
  "## Acceptance",                     // 8
  "- The farm is visible.",            // 9
].join("\n") + "\n";

const MULTI = [
  "# Work order: farm",                // 1
  "",                                  // 2
  "<!-- bridge:requested_work -->",    // 3
  "## Work",                           // 4
  "Trees, then a cart.",               // 5
  "",                                  // 6
  "<!-- bridge:run_plan -->",          // 7
  "## Run plan",                       // 8
  "### RUN A",                         // 9
  "Plant trees.",                      // 10
  "- effort: low",                     // 11
  "- acceptance:",                     // 12
  "  - Trees show.",                   // 13
  "",                                  // 14
  "### RUN B",                         // 15
  "Add a cart.",                       // 16
  "- depends_on: RUN A",               // 17
  "- budget: { rounds: 1 }",           // 18
  "- acceptance:",                     // 19
  "  - The cart drives.",              // 20
  "",                                  // 21
  "<!-- bridge:acceptance -->",        // 22
  "## Acceptance",                     // 23
  "1. Trees show and the cart drives with the arrow keys.", // 24
].join("\n") + "\n";

test("the plan names the contract calls before the work, and the human approves them with it", async (t) => {
  const rt = await install(t);
  const work = await planWork(rt, "farm", SINGLE);
  assert.deepEqual(work.plan.contract_steps, {
    translate: { role: "writer", provider: "claude", model: work.plan.contract_steps.translate.model },
    check: { role: "reviewer", provider: "codex" },
    max_attempts: 2,
    call_timeout: 120_000,
  });
  const plain = rt.bridge([...planArgs(work.order, "farm-plain", ".review-bridge/review-queue/farm-plain.plan.json"), "--plain"]);
  assert.match(plain.stdout, /Before the work: up to 2 work-order translation\(s\) by the writer \(claude\) and 2 check\(s\) by the reviewer \(codex\), 2 minute\(s\) per call/);
  // The plan records the configured reviewer as it is; a native run refuses one it cannot call yet.
  const configPath = rt.paths.bridgeConfigPath;
  const config = await readJson(configPath);
  await fsp.writeFile(configPath, JSON.stringify({ ...config, roles: { ...config.roles, reviewer: { provider_id: "claude" } } }));
  const other = await planWork(rt, "farm-other", SINGLE);
  assert.deepEqual(other.plan.contract_steps.check, { role: "reviewer", provider: "claude" });
  assert.equal(unsupportedContractStep(other.plan.contract_steps), "The reviewer role is claude; only codex can check a translation in this version.");
  assert.equal(unsupportedContractStep(work.plan.contract_steps), null);
});

test("the reviewer checks the translation in its own call before the writer starts; the run then works from the sealed contract", async (t) => {
  const rt = await install(t);
  const work = await planWork(rt, "farm", SINGLE);
  const started = start(rt, work);
  assert.equal(started.status, 0, started.stderr + started.stdout);
  const run = await runOf(rt, work);
  assert.equal(run.conclusion, "success");
  const events = await eventsOf(rt, work);
  const kinds = events.map((event) => event.event);
  assert.deepEqual(kinds.slice(0, 5), ["usage", "contract.translation", "usage", "contract.check", "contract.sealed"]);
  assert.deepEqual([events[0].role, events[2].role], ["translator", "contract_checker"]);
  assert.equal(events[3].decision, "pass");
  assert.ok(kinds.indexOf("contract.sealed") < kinds.indexOf("task.input"));
  const contract = await loadContract(rt.paths, run.contract_sha256);
  assert.deepEqual(contract.checked_by, { role: "reviewer", provider: "codex" });
  assert.equal(contract.translated_by.attempt, 1);
  assert.match(await resultOf(rt, "farm"), /\| contract check \| 1 \|/);
});

test("a translation the reviewer finds wrong is redone, not sent to the human; a second wrong one ends the run", async (t) => {
  const rt = await install(t);
  const redone = await planWork(rt, "redone", SINGLE);
  assert.equal(start(rt, redone, { FAKE_CONTRACT_CHECK: "unfaithful_first" }).status, 0);
  const passed = await runOf(rt, redone);
  assert.equal(passed.conclusion, "success");
  const checks = (await eventsOf(rt, redone)).filter((event) => event.event === "contract.check");
  assert.deepEqual(checks.map((event) => event.decision), ["retranslate", "pass"]);
  assert.equal((await loadContract(rt.paths, passed.contract_sha256)).translated_by.attempt, 2);
  const prompts = (await fsp.readdir(rt.paths.runLogDir(passed.run_id))).filter((name) => name.endsWith("-contract-prompt.txt")).sort();
  assert.match(await fsp.readFile(path.join(rt.paths.runLogDir(passed.run_id), prompts.at(-1)), "utf8"), /- AC1 does not match its lines: says more than its lines/);
  const exhausted = await planWork(rt, "exhausted", SINGLE);
  assert.equal(start(rt, exhausted, { FAKE_CONTRACT_CHECK: "unfaithful_always" }).status, 79);
  const rejected = await runOf(rt, exhausted);
  assert.equal(rejected.closed_reason, "contract_rejected");
  assert.equal(rejected.contract_sha256, undefined);
  assert.equal((await eventsOf(rt, exhausted)).some((event) => event.event === "task.input"), false);
});

test("an ambiguity in the work order goes to the human; a reviewer that cannot confirm, or skips a condition, stops the run", async (t) => {
  const rt = await install(t);
  const unclear = await planWork(rt, "unclear", SINGLE);
  assert.equal(start(rt, unclear, { FAKE_CONTRACT_CHECK: "ambiguous" }).status, 0);
  assert.equal((await runOf(rt, unclear)).closed_reason, "needs_human");
  assert.match(await resultOf(rt, "unclear"), /- Which page should show the farm\?/);
  const doubtful = await planWork(rt, "doubtful", SINGLE);
  assert.equal(start(rt, doubtful, { FAKE_CONTRACT_CHECK: "cannot_confirm" }).status, 0);
  const unconfirmed = await runOf(rt, doubtful);
  assert.equal(unconfirmed.closed_reason, "contract_unconfirmed");
  assert.equal(unconfirmed.contract_sha256, undefined);
  assert.match(await resultOf(rt, "doubtful"), /could not confirm that the contract matches the work order[\s\S]*- fake: the work order refers to a design not given/);
  const partial = await planWork(rt, "partial", SINGLE + "- The cart moves.\n");
  assert.equal(start(rt, partial, { FAKE_CONTRACT_CHECK: "skip_ac" }).status, 0);
  assert.equal((await runOf(rt, partial)).closed_reason, "contract_unconfirmed");
  assert.deepEqual((await runOf(rt, partial)).last_state.contract_problems, ["$.acceptance: must judge exactly AC1, AC2"]);
});

test("a condition the reviewer finds missing is redone; unreadable usage stops before the writer", async (t) => {
  const rt = await install(t);
  const redone = await planWork(rt, "missing", SINGLE);
  assert.equal(start(rt, redone, { FAKE_CONTRACT_CHECK: "missing_first" }).status, 0);
  assert.equal((await runOf(rt, redone)).conclusion, "success");
  const checks = (await eventsOf(rt, redone)).filter((event) => event.event === "contract.check");
  assert.deepEqual(checks.map((event) => event.decision), ["retranslate", "pass"]);
  assert.deepEqual(checks[0].feedback, ["missing condition at lines 1-1: fake: a stated requirement was left out"]);
  const unknown = await planWork(rt, "unknown", SINGLE);
  assert.equal(start(rt, unknown, { FAKE_CONTRACT_CHECK_USAGE: "none" }).status, 76);
  const stopped = await runOf(rt, unknown);
  assert.equal(stopped.closed_reason, "usage_unknown");
  assert.equal(stopped.contract_sha256, undefined);
  assert.equal((await eventsOf(rt, unknown)).some((event) => event.event === "task.input"), false);
  assert.match(await resultOf(rt, "unknown"), /could not read how many tokens the contract check call used/);
});

test("a work order with two runs keeps its run plan as data; one source line gives three conditions; Bridge still starts one run", async (t) => {
  const rt = await install(t);
  const work = await planWork(rt, "multi", MULTI);
  const gate = [{ kind: "test", check: null }];
  const file = await translationFile(rt, translation([
    { id: "AC1", statement: "Trees show.", quote: "Trees show.", source_refs: [{ start: 13, end: 13 }], verify: [{ kind: "reviewer", check: "trees are on screen" }] },
    { id: "AC2", statement: "The cart drives.", quote: "The cart drives.", source_refs: [{ start: 20, end: 20 }], verify: gate },
    { id: "AC3", statement: "Trees show.", quote: "Trees show", source_refs: [{ start: 24, end: 24 }], verify: [{ kind: "reviewer", check: "trees are on screen" }] },
    { id: "AC4", statement: "The cart drives with the arrow keys.", quote: "the cart drives with the arrow keys", source_refs: [{ start: 24, end: 24 }], verify: gate },
    { id: "AC5", statement: "Both work together.", quote: "Trees show and the cart drives", source_refs: [{ start: 24, end: 24 }], verify: gate },
  ]));
  const started = start(rt, work, { FAKE_CONTRACT_FILE: file });
  assert.equal(started.status, 0, started.stderr + started.stdout);
  const run = await runOf(rt, work);
  assert.equal(run.conclusion, "success");
  const contract = await loadContract(rt.paths, run.contract_sha256);
  // Bridge filled the runs from the block: names, work text, dependencies, effort and budget.
  assert.deepEqual(contract.run_plan.runs.map((entry) => [entry.name, entry.text, entry.depends_on, entry.depends_on_quote, entry.effort, entry.budget]), [
    ["RUN A", "Plant trees.", [], null, "low", null],
    ["RUN B", "Add a cart.", ["RUN A"], "- depends_on: RUN A", null, { rounds: 1 }],
  ]);
  // A run's own conditions belong to it; the work order's acceptance block belongs to no run.
  assert.deepEqual(contract.acceptance.map((entry) => [entry.id, entry.run_refs]), [["AC1", ["RUN A"]], ["AC2", ["RUN B"]], ["AC3", []], ["AC4", []], ["AC5", []]]);
  assert.ok(contract.acceptance.slice(2).every((entry) => entry.source_refs[0].start === 24));
  // This step only records the human's run plan; starting one Bridge run per RUN is not built yet.
  assert.deepEqual(await fsp.readdir(rt.paths.runsDir), [work.plan.proposed_run_id + ".json"]);
});

test("a writer that rewrites the sealed contract ends the run as contract_changed, before any review", async (t) => {
  const rt = await install(t);
  const work = await planWork(rt, "tamper", SINGLE);
  assert.equal(start(rt, work, { FAKE_CONTRACT_TAMPER: "1" }).status, 78);
  const run = await runOf(rt, work);
  assert.equal(run.closed_reason, "contract_changed");
  await assert.rejects(loadContract(rt.paths, run.contract_sha256), /changed after it was sealed/);
  const kinds = (await eventsOf(rt, work)).map((event) => event.event);
  assert.equal(kinds.includes("review.input"), false);
  assert.equal(kinds.includes("writer.result"), false);
});

test("an answer that names another contract is refused, from the writer and from the reviewer", async (t) => {
  const rt = await install(t);
  const writer = await planWork(rt, "echo-writer", SINGLE);
  assert.equal(start(rt, writer, { FAKE_CONTRACT_ECHO: "other" }).status, 79);
  const writerRun = await runOf(rt, writer);
  assert.equal(writerRun.closed_reason, "malformed_writer_result");
  assert.ok(writerRun.last_state.errors.includes("$.contract_sha256: expected " + writerRun.contract_sha256));
  const reviewer = await planWork(rt, "echo-reviewer", SINGLE);
  assert.equal(start(rt, reviewer, { FAKE_CODEX_CONTRACT: "other" }).status, 79);
  assert.equal((await runOf(rt, reviewer)).closed_reason, "malformed_review_result");
});

test("editing the work order never changes a running contract; only starting again makes a new version, and the old one stays", async (t) => {
  const rt = await install(t);
  const first = await planWork(rt, "farm", SINGLE);
  // The writer sleeps after the contract is sealed; the human edits the work order meanwhile.
  const child = spawn(process.execPath, [rt.bootstrap, "work-start", "--plan", first.planArg, "--approve", first.plan.plan_sha256, "--fake-cli", "--json"], {
    cwd: rt.root, windowsHide: true, env: { ...process.env, FAKE_CLAUDE_SLEEP_MS: "2500" }, stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = new Promise((resolve) => child.once("close", resolve));
  const deadline = Date.now() + 20_000;
  let sealed = null;
  while (!sealed && Date.now() < deadline) {
    sealed = (await readIoEvents(rt.paths, first.plan.proposed_run_id).catch(() => [])).find((event) => event.event === "contract.sealed");
    if (!sealed) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(sealed, "the contract was never sealed");
  const edited = SINGLE + "- The cart is red.\n";
  await fsp.writeFile(path.join(rt.root, first.order), edited);
  assert.equal(await exit, 0);
  const firstRun = await runOf(rt, first);
  assert.equal(firstRun.conclusion, "success");
  // The result marks the edit and says it was not used; the work was judged on the sealed text.
  const firstResult = await resultOf(rt, "farm");
  assert.match(firstResult, /## Work order changed after the start/);
  assert.match(firstResult, /judged the work against the version sealed at the start/);
  assert.match(firstResult, /^\+ - The cart is red\.$/m);
  assert.doesNotMatch(firstResult, /^\+ - The farm is visible\.$/m);
  const firstContract = await loadContract(rt.paths, sealed.contract_sha256);
  assert.equal(firstContract.acceptance.length, 1);
  assert.equal(firstContract.source.lines.includes("- The cart is red."), false);
  // A plan built before the edit no longer matches the work order and is refused.
  const stale = await planWork(rt, "farm-stale", SINGLE);
  await fsp.writeFile(path.join(rt.root, stale.order), edited);
  const refused = start(rt, stale);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr + refused.stdout, /changed after the plan was built/);
  // Starting again from the edited work order seals a second contract; the first is untouched.
  const second = await planWork(rt, "farm", edited);
  assert.equal(start(rt, second).status, 0);
  const secondRun = await runOf(rt, second);
  assert.notEqual(secondRun.contract_sha256, firstRun.contract_sha256);
  assert.equal((await loadContract(rt.paths, secondRun.contract_sha256)).acceptance.length, 2);
  assert.deepEqual(await loadContract(rt.paths, firstRun.contract_sha256), firstContract);
  // The second run was judged on the text it sealed, so its result has no change section.
  assert.doesNotMatch(await resultOf(rt, "farm"), /Work order changed after the start/);
});

test("a work order file that is gone, or reads the same apart from outer blank lines, is reported as such", () => {
  assert.deepEqual(workOrderChange("# A\n- one\n", "\n# A\n- one\n\n"), null);
  assert.deepEqual(workOrderChange("# A\n- one\n", null), { missing: true });
  const change = workOrderChange("# A\n- one\n- two\n", "# A\n- two\n- three\n```js\n");
  assert.deepEqual(change.removed, ["- one"]);
  assert.deepEqual(change.added, ["- three", "```js"]);
  // A fence inside the work order cannot close the block that shows the change.
  assert.ok(change.fence.length > 3 && /^`+$/.test(change.fence));
});

const UNKILLABLE = process.platform === "win32" ? 4 : 1;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The old version's writer sleeps; returns once its pid is recorded.
async function startSleeping(rt, work) {
  const child = spawn(process.execPath, [rt.bootstrap, "work-start", "--plan", work.planArg, "--approve", work.plan.plan_sha256, "--fake-cli", "--json"], {
    cwd: rt.root, windowsHide: true, env: { ...process.env, FAKE_CLAUDE_SLEEP_MS: "60000" }, stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = new Promise((resolve) => child.once("close", resolve));
  const recordPath = processFile(rt.paths, work.plan.proposed_run_id);
  const deadline = Date.now() + 30_000;
  let record = null;
  while (record?.role !== "writer" && Date.now() < deadline) {
    record = await readJson(recordPath).catch(() => null);
    if (record?.role !== "writer") await pause(100);
  }
  assert.equal(record?.role, "writer", "the old version's writer never started");
  return { child, exit, record, recordPath };
}

test("starting an edited work order again stops the running version first, and nothing of it is carried over", async (t) => {
  const rt = await install(t);
  const first = await planWork(rt, "farm", SINGLE);
  const old = await startSleeping(rt, first);
  t.after(() => { try { process.kill(old.record.pid); } catch {} });
  const edited = SINGLE + "- The cart is red.\n";
  // Saving the work order stops nothing.
  await fsp.writeFile(path.join(rt.root, first.order), edited);
  await pause(1000);
  assert.equal((await runOf(rt, first)).status, "in_progress");
  assert.equal(alive(old.record.pid), true);

  // A stop of the old version that cannot be confirmed refuses the new start; nothing of it is made.
  const second = await planWork(rt, "farm", edited);
  await fsp.writeFile(old.recordPath, JSON.stringify({ ...old.record, pid: UNKILLABLE }));
  const refused = start(rt, second);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, new RegExp("could not be stopped: run " + first.plan.proposed_run_id));
  assert.equal(await fsp.stat(path.join(rt.paths.runsDir, second.plan.proposed_run_id + ".json")).then(() => true, () => false), false);
  // The old version stopped is stopped, though the new one did not start (GitHub Actions'
  // cancel-in-progress); its kill is not confirmed, so the next start tries it again.
  const stoppedOld = await runOf(rt, first);
  assert.deepEqual([stoppedOld.status, stoppedOld.closed_reason], ["completed", "superseded"]);
  // Recorded when it happened; the link to a run that does not exist is not.
  const oldRow = async () => (await queryRecords("select status, closed_reason, superseded_by from runs where run_id = $1", [first.plan.proposed_run_id]))[0];
  assert.deepEqual(await oldRow(), { status: "completed", closed_reason: "superseded", superseded_by: null });

  // Starting again retries the stop; the new version runs only once the old one is gone.
  await fsp.writeFile(old.recordPath, JSON.stringify(old.record));
  const started = start(rt, second);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(alive(old.record.pid), false);
  await old.exit;
  const oldRun = await runOf(rt, first);
  assert.equal(oldRun.conclusion, "cancelled");
  assert.equal(oldRun.closed_reason, "superseded");
  const oldStop = (await eventsOf(rt, first)).find((event) => event.event === "stop" && event.status === "stopped");
  assert.equal(oldStop.superseded_by, second.plan.proposed_run_id);
  // The start that happened links it, in its own transaction.
  assert.deepEqual(await oldRow(), { status: "completed", closed_reason: "superseded", superseded_by: second.plan.proposed_run_id });
  const newEvents = await eventsOf(rt, second);
  assert.ok(oldStop.occurred_at <= newEvents[0].occurred_at, "the new version started before the old one was stopped");
  // The new version has its own contract and verdicts; the old run left none of its records in it.
  const newRun = await runOf(rt, second);
  assert.equal(newRun.conclusion, "success");
  assert.notEqual(newRun.contract_sha256, oldRun.contract_sha256);
  assert.equal((await loadContract(rt.paths, newRun.contract_sha256)).acceptance.length, 2);
  assert.ok(newEvents.every((event) => event.run_id === second.plan.proposed_run_id));
  assert.equal((await eventsOf(rt, first)).some((event) => event.event === "review.result"), false);
  // The old authorization cannot start anything again.
  assert.notEqual(start(rt, first).status, 0);
  // The old run's own result says why it stopped.
  const oldResult = await fsp.readFile(path.join(rt.paths.runLogDir(first.plan.proposed_run_id), first.plan.proposed_run_id + ".result.md"), "utf8");
  // Whichever side delivered first, the new run is named; it is never left out.
  assert.match(oldResult, new RegExp("started again as a new version: run " + second.plan.proposed_run_id + "[. ]"));
});

// The test above stops the old version before any review, so "nothing of it is carried over" holds
// there trivially. Here the old version was already judged (its first review failed, with a finding)
// and was in its correction call: none of that verdict, finding or correction reaches the new version.
test("an old version's verdict and finding are not carried into the new version", async (t) => {
  const rt = await install(t);
  const order = ".review-bridge/work-packages/farm.md";
  await fsp.writeFile(path.join(rt.root, order), SINGLE);
  const planArg = ".review-bridge/review-queue/farm-two-calls.plan.json";
  const twoCalls = planArgs(order, "farm", planArg).map((arg, index, all) => (all[index - 1] === "--rounds" ? "2" : arg));
  const planned = rt.bridge(twoCalls);
  assert.equal(planned.status, 0, planned.stderr);
  const first = { plan: await readJson(path.join(rt.root, planArg)), planArg, order };
  const child = spawn(process.execPath, [rt.bootstrap, "work-start", "--plan", planArg, "--approve", first.plan.plan_sha256, "--fake-cli", "--fake-scenario", "FAIL_THEN_PASS", "--json"], {
    cwd: rt.root, windowsHide: true, env: { ...process.env, FAKE_CLAUDE_SLEEP_MS: "4000" }, stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = new Promise((resolve) => child.once("close", resolve));
  t.after(() => { try { child.kill(); } catch {} });
  // Wait until the old version was judged FAIL and its correction call is running.
  const deadline = Date.now() + 60_000;
  let record = null;
  while (Date.now() < deadline) {
    const judged = (await eventsOf(rt, first).catch(() => [])).some((event) => event.event === "review.result" && event.gate === "FAIL");
    record = await readJson(processFile(rt.paths, first.plan.proposed_run_id)).catch(() => null);
    if (judged && record?.role === "writer" && record.call === 2) break;
    await pause(100);
  }
  assert.equal(record?.call, 2, "the old version never reached its correction call");
  t.after(() => { try { process.kill(record.pid); } catch {} });
  const oldReview = (await eventsOf(rt, first)).find((event) => event.event === "review.result");
  const oldClaim = oldReview.findings[0].claim;
  assert.match(oldClaim, /fake defect/, "the old version really has a finding to carry");
  const second = await planWork(rt, "farm", SINGLE + "- The cart is red.\n");
  const started = start(rt, second);
  assert.equal(started.status, 0, started.stderr);
  await exit;
  assert.equal((await runOf(rt, first)).closed_reason, "superseded");
  // The new version has exactly its own review, a PASS with no findings, and no correction.
  const newEvents = await eventsOf(rt, second);
  const reviews = newEvents.filter((event) => event.event === "review.result");
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].gate, "PASS");
  assert.deepEqual(reviews[0].findings, []);
  assert.equal(newEvents.some((event) => event.event === "fix.input"), false);
  assert.equal(JSON.stringify(newEvents).includes(oldClaim), false, "the old finding reached the new version's records");
  assert.ok(newEvents.find((event) => event.event === "acceptance").rows.every((row) => row.result === "proven"));
  const newResult = await fsp.readFile(path.join(rt.paths.runLogDir(second.plan.proposed_run_id), second.plan.proposed_run_id + ".result.md"), "utf8");
  assert.match(newResult, /# Delivered/);
  assert.equal(newResult.includes(oldClaim), false, "the old finding reached the new version's result");
});

test("the new version waits for the old work-start to let go of its run, and refuses if it does not", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-lock-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const paths = getBridgePaths(root, runtimeSource, { privateRootName: ".review-bridge" });
  await fsp.mkdir(paths.privateRoot, { recursive: true });
  await fsp.writeFile(paths.bridgeConfigPath, JSON.stringify({ schema_version: 4, project_id: randomUUID() }));
  const oldRun = "6b1f0c2e-8d4a-4f7b-9c3e-2a5d7e9f1b40";
  const lockFile = workLockFile(paths, oldRun);
  await fsp.mkdir(path.dirname(lockFile), { recursive: true });
  assert.equal(await workLockReleased(paths, oldRun, { timeoutMs: 0 }), true);
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { windowsHide: true, stdio: "ignore" });
  t.after(() => { try { sleeper.kill(); } catch {} });
  await fsp.writeFile(lockFile, JSON.stringify({ pid: sleeper.pid }));
  assert.equal(await workLockReleased(paths, oldRun, { timeoutMs: 600 }), false);
  // Another run's lock is not this run's: it holds nothing back.
  assert.equal(await workLockReleased(paths, "7c2a1d3f-9e5b-4a8c-8d4f-3b6e8a0c2d51", { timeoutMs: 0 }), true);
  // The holder exits while the new version waits: the wait ends and the start may go on.
  const waiting = workLockReleased(paths, oldRun, { timeoutMs: 10_000 });
  await pause(400);
  sleeper.kill();
  assert.equal(await waiting, true);
  // A lock left by a process that is gone does not hold the project.
  assert.equal(await workLockReleased(paths, oldRun, { timeoutMs: 0 }), true);
});

// Decision A: a work order is a place. A save by renaming gives the file a new id but keeps its
// place, so it is an edit, not another work order. Here it happens while a start runs: that start
// goes on with the plan it sealed, a second start of the new text meanwhile is refused by the same
// start lock, and only the person's later retry replaces the running version. Saving changes nothing
// already authorized. The first start is held in its wait for the old version's work-start to close.
const savedByRenaming = async (file, text) => {
  await fsp.writeFile(file + ".tmp", text);
  await fsp.rename(file + ".tmp", file);
};

test("a save by renaming while a start runs keeps the place: that start goes on, a second is refused, a retry replaces it", async (t) => {
  const rt = await install(t);
  const zero = await planWork(rt, "farm", SINGLE);
  const old = await startSleeping(rt, zero);
  t.after(() => { try { process.kill(old.record.pid); } catch {} });
  old.child.kill("SIGKILL");
  await old.exit;
  const one = SINGLE + "- The cart is red.\n";
  const first = await planWork(rt, "farm", one);
  const closing = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], { windowsHide: true, stdio: "ignore" });
  t.after(() => { try { closing.kill(); } catch {} });
  await fsp.writeFile(workLockFile(rt.paths, zero.plan.proposed_run_id), JSON.stringify({ pid: closing.pid }));
  const child = spawn(process.execPath, [rt.bootstrap, "work-start", "--plan", first.planArg, "--approve", first.plan.plan_sha256, "--fake-cli", "--json"], {
    cwd: rt.root, windowsHide: true, env: { ...process.env, FAKE_CLAUDE_SLEEP_MS: "60000" }, stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = new Promise((resolve) => child.once("close", resolve));
  t.after(() => { try { child.kill(); } catch {} });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && (await runOf(rt, zero)).superseded_by !== first.plan.proposed_run_id) await pause(100);
  assert.equal((await runOf(rt, zero)).superseded_by, first.plan.proposed_run_id, "the first start never reached its wait");
  // The person saves a new text by renaming: a new file id, the same place.
  const file = path.join(rt.root, first.order);
  const placeBefore = await workOrderLocation(rt.paths, first.plan.task_file);
  const idBefore = (await fsp.stat(file, { bigint: true })).ino;
  const two = one + "- The barn is blue.\n";
  await savedByRenaming(file, two);
  assert.notEqual((await fsp.stat(file, { bigint: true })).ino, idBefore, "the rename did not give the file a new id");
  assert.equal(await workOrderLocation(rt.paths, first.plan.task_file), placeBefore);
  // A start of the new text meanwhile is refused by the same start lock; nothing of it is made.
  const second = { ...(await planOf(rt, "farm", two)) };
  const refused = start(rt, second);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Another start of .* is in progress; nothing was created/);
  await assert.rejects(runOf(rt, second));
  // The first start goes on with the text it sealed.
  closing.kill();
  const deadlineRun = Date.now() + 30_000;
  let record = null;
  while (Date.now() < deadlineRun && record?.role !== "writer") {
    record = await readJson(processFile(rt.paths, first.plan.proposed_run_id)).catch(() => null);
    if (record?.role !== "writer") await pause(100);
  }
  assert.equal(record?.role, "writer", "the first start never got to work");
  t.after(() => { try { process.kill(record.pid); } catch {} });
  const firstRun = await runOf(rt, first);
  assert.equal(firstRun.status, "in_progress");
  assert.equal((await loadContract(rt.paths, firstRun.contract_sha256)).acceptance.length, 2, "the first start uses the text it sealed");
  // Only the person's retry replaces it.
  const retried = start(rt, second);
  assert.equal(retried.status, 0, retried.stderr);
  await exit;
  assert.equal((await runOf(rt, first)).closed_reason, "superseded");
  const secondRun = await runOf(rt, second);
  assert.equal(secondRun.conclusion, "success");
  assert.equal((await loadContract(rt.paths, secondRun.contract_sha256)).acceptance.length, 3);
});

test("between two starts a save by renaming keeps the place: the same text is refused, a new text replaces the run", async (t) => {
  const rt = await install(t);
  const first = await planWork(rt, "farm", SINGLE);
  const old = await startSleeping(rt, first);
  t.after(() => { try { process.kill(old.record.pid); } catch {} });
  const file = path.join(rt.root, first.order);
  const place = await workOrderLocation(rt.paths, first.plan.task_file);
  const idBefore = (await fsp.stat(file, { bigint: true })).ino;
  // Saved again with the same text, by renaming: the running run is not an older version.
  await savedByRenaming(file, SINGLE);
  assert.notEqual((await fsp.stat(file, { bigint: true })).ino, idBefore);
  assert.equal(await workOrderLocation(rt.paths, first.plan.task_file), place);
  const same = await planOf(rt, "farm", SINGLE);
  const refused = start(rt, same);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, new RegExp("already running unchanged as run " + first.plan.proposed_run_id));
  assert.equal((await runOf(rt, first)).status, "in_progress");
  assert.equal(alive(old.record.pid), true);
  // Saved with a new text, by renaming: the new start replaces the running version.
  const edited = SINGLE + "- The cart is red.\n";
  await savedByRenaming(file, edited);
  const changed = await planOf(rt, "farm", edited);
  const started = start(rt, changed);
  assert.equal(started.status, 0, started.stderr);
  await old.exit;
  assert.equal((await runOf(rt, first)).closed_reason, "superseded");
  assert.equal((await runOf(rt, changed)).conclusion, "success");
});

test("two hard links to one file in one folder are two places, so two work orders", async (t) => {
  const rt = await install(t);
  const first = await planWork(rt, "farm", SINGLE);
  const linked = ".review-bridge/work-packages/farm-link.md";
  await fsp.link(path.join(rt.root, first.order), path.join(rt.root, linked));
  assert.equal((await fsp.stat(path.join(rt.root, first.order), { bigint: true })).ino, (await fsp.stat(path.join(rt.root, linked), { bigint: true })).ino);
  const second = await planAt(rt, linked, "farm-link", SINGLE);
  assert.notEqual(await workOrderLocation(rt.paths, first.plan.task_file), await workOrderLocation(rt.paths, second.plan.task_file));
  const old = await startSleeping(rt, first);
  t.after(() => { try { process.kill(old.record.pid); } catch {} });
  // The other link is another work order: it neither waits for, nor stops, nor is refused by the first.
  const started = start(rt, second);
  assert.equal(started.status, 0, started.stderr);
  assert.equal((await runOf(rt, second)).conclusion, "success");
  assert.equal((await runOf(rt, first)).status, "in_progress");
  assert.equal(alive(old.record.pid), true);
  const stopped = rt.bridge(["stop", first.plan.proposed_run_id]);
  assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
  await old.exit;
});

test("a place that cannot be told apart, or a file system without file ids, refuses rather than guesses", async () => {
  const paths = { repoRoot: path.resolve("repo") };
  const file = (ino) => ({ isFile: () => true, ino, dev: 7n });
  const folder = { isFile: () => false, ino: 3n, dev: 7n };
  const seams = (files, names) => ({
    stat: async (target) => {
      if (path.basename(target) === "w") return folder;
      if (files[path.basename(target)]) return files[path.basename(target)];
      const error = new Error("absent");
      error.code = "ENOENT";
      throw error;
    },
    readdir: async () => names,
  });
  // A file system that gives no file id.
  await assert.rejects(workOrderLocation(paths, "w/farm.md", seams({ "farm.md": file(0n) }, ["farm.md"])), /gives no file id/);
  // No entry has the spelled name and two match it ignoring case: neither is picked.
  await assert.rejects(workOrderLocation(paths, "w/FARM.md", seams({ "FARM.md": file(5n), "farm.md": file(5n), "Farm.md": file(6n) }, ["farm.md", "Farm.md"])), /cannot be told apart/);
  // The one entry that matches ignoring case is not the file the path reaches.
  await assert.rejects(workOrderLocation(paths, "w/FARM.md", seams({ "FARM.md": file(5n), "farm.md": file(9n) }, ["farm.md"])), /cannot be told apart/);
  // The place is the folder and the entry's own name, whichever spelling reaches it.
  assert.equal(await workOrderLocation(paths, "w/FARM.md", seams({ "FARM.md": file(5n), "farm.md": file(5n) }, ["farm.md"])), "7:3:farm.md");
  assert.equal(await workOrderLocation(paths, "w/gone.md", seams({}, [])), null);
});

test("the new version starts only after the old work-start has let go of its run", async (t) => {
  const rt = await install(t);
  const first = await planWork(rt, "farm", SINGLE);
  const old = await startSleeping(rt, first);
  t.after(() => { try { process.kill(old.record.pid); } catch {} });
  // The old work-start dies without closing; a process that holds the project for a few seconds
  // stands in for one still closing.
  old.child.kill("SIGKILL");
  await old.exit;
  const second = await planWork(rt, "farm", SINGLE + "- The cart is red.\n");
  const closing = spawn(process.execPath, ["-e", "setTimeout(() => {}, 4000)"], { windowsHide: true, stdio: "ignore" });
  t.after(() => { try { closing.kill(); } catch {} });
  await fsp.writeFile(workLockFile(rt.paths, first.plan.proposed_run_id), JSON.stringify({ pid: closing.pid }));
  const started = start(rt, second);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(alive(old.record.pid), false);
  assert.equal((await runOf(rt, second)).conclusion, "success");
  // The old version's work-start is gone, so the new start delivered it.
  const oldRun = await runOf(rt, first);
  assert.equal(oldRun.closed_reason, "superseded");
  assert.equal(oldRun.result_sha256.length, 64);
});

// Codex review: two plans of one unchanged work order started together must leave one run, not two,
// and the later start must not stop the earlier one. Each order of arrival is fixed here.
test("a second start of a work order while the first is still starting is refused and creates nothing", async (t) => {
  const rt = await install(t);
  const first = await planWork(rt, "farm", SINGLE);
  const second = await planWork(rt, "farm", SINGLE);
  // The first start is in progress: it holds the work order's start lock.
  const starting = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { windowsHide: true, stdio: "ignore" });
  t.after(() => { try { starting.kill(); } catch {} });
  const lockFile = startLockFile(rt.paths, await workOrderLocation(rt.paths, first.plan.task_file));
  await fsp.mkdir(path.dirname(lockFile), { recursive: true });
  await fsp.writeFile(lockFile, JSON.stringify({ pid: starting.pid }));
  const refused = start(rt, second);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, new RegExp("Another start of " + first.plan.task_file.replace(/[.]/g, "\\.") + " is in progress; nothing was created"));
  await assert.rejects(runOf(rt, second));
  // Once that start is done, the first plan starts as usual.
  starting.kill();
  await pause(500);
  const started = start(rt, first);
  assert.equal(started.status, 0, started.stderr);
  assert.equal((await runOf(rt, first)).conclusion, "success");
});

test("a second start of an unchanged work order that is already running is refused, and the running one goes on", async (t) => {
  const rt = await install(t);
  const first = await planWork(rt, "farm", SINGLE);
  const second = await planWork(rt, "farm", SINGLE);
  // The first run exists and its start has let go of the start lock.
  const old = await startSleeping(rt, first);
  t.after(() => { try { process.kill(old.record.pid); } catch {} });
  // The second card was made before the file became the first's work order (step 4: the records
  // know a work order by its id): it is out of date, and refused before anything is touched.
  const stale = start(rt, second);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /This card was made before \.review-bridge\/work-packages\/farm\.md became work order [0-9a-f-]{36}; nothing was created/);
  await assert.rejects(runOf(rt, second));
  // A card made now names that work order; its start is refused because the same text is running.
  const current = await planWork(rt, "farm", SINGLE);
  const refused = start(rt, current);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, new RegExp("already running unchanged as run " + first.plan.proposed_run_id + "; nothing was created"));
  await assert.rejects(runOf(rt, current));
  assert.equal((await runOf(rt, first)).status, "in_progress");
  assert.equal(alive(old.record.pid), true);
  // The start card says the start will be refused, not that it will stop the run.
  const card = spawnSync(process.execPath, [rt.bootstrap, "work-start", "--plan", current.planArg, "--fake-cli"], {
    cwd: rt.root, encoding: "utf8", windowsHide: true, input: "n\n",
  });
  assert.match(card.stdout, new RegExp("already running unchanged as run " + first.plan.proposed_run_id + "; this start will be refused"));
  assert.doesNotMatch(card.stdout, /Starting stops the version/);
  const stopped = rt.bridge(["stop", first.plan.proposed_run_id]);
  assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
  await old.exit;
});

test("two plans of one unchanged work order started at the same moment leave exactly one run", async (t) => {
  const rt = await install(t);
  const works = [await planWork(rt, "farm", SINGLE), await planWork(rt, "farm", SINGLE)];
  const exits = await Promise.all(works.map((work) => new Promise((resolve) => {
    const child = spawn(process.execPath, [rt.bootstrap, "work-start", "--plan", work.planArg, "--approve", work.plan.plan_sha256, "--fake-cli", "--json"], {
      cwd: rt.root, windowsHide: true, env: { ...process.env, FAKE_CLAUDE_SLEEP_MS: "3000" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("close", (code) => resolve({ code, stderr }));
  })));
  const runs = await Promise.all(works.map((work) => runOf(rt, work).catch(() => null)));
  assert.equal(runs.filter(Boolean).length, 1, "runs: " + JSON.stringify(runs.map((run) => run?.status ?? null)) + " " + exits.map((exit) => exit.stderr).join(" | "));
  const winner = runs.findIndex(Boolean);
  assert.equal(exits[winner].code, 0, exits[winner].stderr);
  assert.equal(runs[winner].conclusion, "success");
  assert.notEqual(runs[winner].closed_reason, "superseded");
  assert.notEqual(exits[1 - winner].code, 0);
  assert.match(exits[1 - winner].stderr, /nothing was created/);
});

// Owner 2026-10-19: a work order is known by its file as the file system identifies it, not by the
// spelling of its path. These run on whichever kinds of file system this machine can give; a kind it
// cannot give is skipped and named, never taken as passed. macOS needs its own run on a Mac.
async function ignoresCase(folder) {
  const probe = path.join(folder, "case-probe.md");
  await fsp.writeFile(probe, "x");
  const seen = await fsp.access(path.join(folder, "CASE-PROBE.md")).then(() => true, () => false);
  await fsp.rm(probe);
  return seen;
}

// A folder whose names keep case: native on such file systems, or made so on NTFS (per-folder case
// sensitivity). Null when this machine cannot give one.
async function caseKeepingFolder(rt, name) {
  const folder = path.join(rt.root, ".review-bridge", "work-packages", name);
  await fsp.mkdir(folder, { recursive: true });
  if (process.platform === "win32") spawnSync("fsutil.exe", ["file", "setCaseSensitiveInfo", folder, "enable"], { windowsHide: true, encoding: "utf8" });
  return (await ignoresCase(folder)) ? null : folder;
}

function startTogether(rt, works) {
  return Promise.all(works.map((work) => new Promise((resolve) => {
    const child = spawn(process.execPath, [rt.bootstrap, "work-start", "--plan", work.planArg, "--approve", work.plan.plan_sha256, "--fake-cli", "--json"], {
      cwd: rt.root, windowsHide: true, env: { ...process.env, FAKE_CLAUDE_SLEEP_MS: "3000" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("close", (code) => resolve({ code, stderr }));
  })));
}

test("where names ignore case, farm.md and FARM.md are one work order: one start lock, one run", async (t) => {
  const rt = await install(t);
  if (!(await ignoresCase(path.join(rt.root, ".review-bridge", "work-packages")))) return t.skip("this file system keeps case in names");
  const lower = await planWork(rt, "farm", SINGLE);
  const upper = await planWork(rt, "FARM", SINGLE);
  const location = await workOrderLocation(rt.paths, lower.plan.task_file);
  assert.equal(await workOrderLocation(rt.paths, upper.plan.task_file), location);
  // Started at the same moment under the two spellings: exactly one run.
  const exits = await startTogether(rt, [lower, upper]);
  const runs = await Promise.all([lower, upper].map((work) => runOf(rt, work).catch(() => null)));
  assert.equal(runs.filter(Boolean).length, 1, exits.map((exit) => exit.stderr).join(" | "));
  assert.equal(runs.find(Boolean).conclusion, "success");
  assert.match(exits[runs.findIndex((run) => !run)].stderr, /nothing was created/);
  // One spelling running, the other refused: the running one goes on.
  const running = await planWork(rt, "farm", SINGLE);
  const other = await planWork(rt, "FARM", SINGLE);
  const old = await startSleeping(rt, running);
  t.after(() => { try { process.kill(old.record.pid); } catch {} });
  const refused = start(rt, other);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, new RegExp("already running unchanged as run " + running.plan.proposed_run_id));
  assert.equal((await runOf(rt, running)).status, "in_progress");
  const stopped = rt.bridge(["stop", running.plan.proposed_run_id]);
  assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
  await old.exit;
});

test("where names keep case and both files exist, farm.md and FARM.md are two work orders and both run", async (t) => {
  const rt = await install(t);
  const folder = await caseKeepingFolder(rt, "kept-case");
  if (!folder) return t.skip("this machine cannot give a folder whose names keep case");
  const lower = await planAt(rt, ".review-bridge/work-packages/kept-case/farm.md", "farm-lower", SINGLE);
  const upper = await planAt(rt, ".review-bridge/work-packages/kept-case/FARM.md", "farm-upper", SINGLE);
  assert.deepEqual((await fsp.readdir(folder)).filter((name) => name.endsWith(".md")).sort(), ["FARM.md", "farm.md"]);
  assert.notEqual(await workOrderLocation(rt.paths, lower.plan.task_file), await workOrderLocation(rt.paths, upper.plan.task_file));
  const exits = await startTogether(rt, [lower, upper]);
  for (const [index, work] of [lower, upper].entries()) {
    assert.equal(exits[index].code, 0, exits[index].stderr);
    const run = await runOf(rt, work);
    assert.equal(run.conclusion, "success");
    assert.notEqual(run.closed_reason, "superseded");
  }
});

test("the start card names the running version it will stop, and answering no leaves it running", async (t) => {
  const rt = await install(t);
  const first = await planWork(rt, "farm", SINGLE);
  const old = await startSleeping(rt, first);
  t.after(() => { try { process.kill(old.record.pid); } catch {} });
  const second = await planWork(rt, "farm", SINGLE + "- The cart is red.\n");
  const declined = spawnSync(process.execPath, [rt.bootstrap, "work-start", "--plan", second.planArg, "--fake-cli"], {
    cwd: rt.root, encoding: "utf8", windowsHide: true, input: "n\n",
  });
  assert.notEqual(declined.status, 0);
  assert.match(declined.stdout, new RegExp("Starting stops the version still running from this work order: run " + first.plan.proposed_run_id));
  assert.equal((await runOf(rt, first)).status, "in_progress");
  assert.equal(alive(old.record.pid), true);
  // Another work order's start works beside it, to the end, and leaves this one running.
  const other = await planWork(rt, "barn", SINGLE);
  const otherStart = start(rt, other);
  assert.equal(otherStart.status, 0, otherStart.stderr);
  assert.equal((await runOf(rt, other)).conclusion, "success");
  assert.equal((await runOf(rt, first)).status, "in_progress");
  assert.equal(alive(old.record.pid), true);
  const stopped = rt.bridge(["stop", first.plan.proposed_run_id]);
  assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
  await old.exit;
});

test("an open question in the work order stops the work before any model call and is shown to the human; \"none\" starts it", async (t) => {
  const rt = await install(t);
  const work = await planWork(rt, "asked", SINGLE + "\n<!-- bridge:open_questions -->\n## Open questions\nWhich page shows the farm?\n");
  assert.equal(start(rt, work).status, 0);
  const run = await runOf(rt, work);
  assert.equal(run.closed_reason, "needs_human");
  assert.equal(run.contract_sha256, undefined);
  // The question is the work order's own: no translation or check was paid for.
  assert.equal((await eventsOf(rt, work)).some((event) => ["usage", "contract.translation", "task.input"].includes(event.event)), false);
  assert.match(await resultOf(rt, "asked"), /- Which page shows the farm\?/);
  for (const none of ["無", "none"]) {
    const answered = await planWork(rt, "answered", SINGLE + "\n<!-- bridge:open_questions -->\n## Open questions\n" + none + "\n");
    assert.equal(start(rt, answered).status, 0);
    assert.equal((await runOf(rt, answered)).conclusion, "success", none);
  }
});

test("a condition that points outside its acceptance block is refused, tried again, and nothing is sealed", async (t) => {
  const rt = await install(t);
  const work = await planWork(rt, "bad", SINGLE);
  const file = await translationFile(rt, translation([{ ...visible, source_refs: [{ start: 5, end: 9 }] }]));
  assert.equal(start(rt, work, { FAKE_CONTRACT_FILE: file }).status, 79);
  const run = await runOf(rt, work);
  assert.equal(run.closed_reason, "contract_rejected");
  assert.deepEqual(run.last_state.contract_problems, ["$.acceptance[0].source_refs: not inside one acceptance block", "line 9 belongs to no condition"]);
  assert.equal((await eventsOf(rt, work)).filter((event) => event.event === "contract.translation").length, 2);
  assert.deepEqual(await fsp.readdir(rt.paths.contractsDir).catch(() => []), []);
  assert.match(await resultOf(rt, "bad"), /not inside one acceptance block/);
});

// The work-order format, end to end (Owner 2026-10-27): frontmatter is data, every field comes from
// its own marked block, and the model only cuts the acceptance blocks into conditions.
const CHINESE_ORDER = [
  "---",
  "priority: high",
  "effort: high",
  "budget:",
  "  tokens: 2000000",
  "  tokens_per_call: 1000000",
  "  call_timeout: 600000",
  "  test_timeout: 300000",
  "  run_timeout: 7200000",
  "  rounds: 1",
  "source_id: SHOP-412",
  "---",
  "# 結帳頁套用折扣碼後總額沒有重算",
  "",
  "這行在任何區塊之外。",
  "",
  "<!-- bridge:context -->",
  "## 背景",
  "折扣碼輸入後 API 有回 200，但畫面上的總額還是原價。",
  "",
  "<!-- bridge:outcome -->",
  "## 期待的結果",
  "套用折扣後，使用者馬上看到正確的總額。",
  "",
  "<!-- bridge:requested_work -->",
  "## 要做的事",
  "修正 CheckoutSummary 的總額計算，折扣套用後要重新觸發。",
  "",
  "<!-- bridge:run_plan -->",
  "## 執行計畫",
  "### 計算",
  "修正總額的計算。",
  "- effort: medium",
  "- acceptance:",
  "  - 折扣後總額正確。",
  "",
  "### 畫面",
  "總額變動時重新渲染。",
  "- depends_on: 計算",
  "- budget: { rounds: 1 }",
  "- acceptance:",
  "  - 總額欄位在 1 秒內更新。",
  "",
  "<!-- bridge:scope_notes.include -->",
  "## 包含",
  "結帳頁的總額欄位。",
  "",
  "<!-- bridge:scope_notes.exclude -->",
  "## 不包含",
  "折扣碼的後端驗證。",
  "",
  "<!-- bridge:scope_notes.must_keep -->",
  "## 必須維持",
  "沒有折扣時的總額不變。",
  "",
  "<!-- bridge:scope_notes.expected_locations -->",
  "## 可能會動到的位置",
  "src/checkout/CheckoutSummary.vue",
  "",
  "<!-- bridge:acceptance -->",
  "## 驗收",
  "1. 套用有效折扣碼後，總額欄位在 1 秒內顯示折扣後金額。",
  "2. 折扣碼無效時總額不變，並顯示錯誤訊息。",
  "",
  "<!-- bridge:verification_hints -->",
  "## 驗證提示",
  "用折扣碼 SAVE10 試一次。",
  "",
  "<!-- bridge:reproduction.environment -->",
  "## 環境",
  "Chrome 130，Windows 11。",
  "",
  "<!-- bridge:reproduction.steps -->",
  "## 重現步驟",
  "1. 加一件商品到購物車。",
  "2. 輸入折扣碼 SAVE10。",
  "",
  "<!-- bridge:reproduction.actual -->",
  "## 實際結果",
  "總額還是原價。",
  "",
  "<!-- bridge:reproduction.expected -->",
  "## 預期結果",
  "總額扣掉 10%。",
  "",
  "<!-- bridge:reproduction.frequency -->",
  "## 頻率",
  "每次都會。",
  "",
  "<!-- bridge:references -->",
  "## 參考",
  "- docs/checkout.md",
  "",
  "<!-- bridge:open_questions -->",
  "## 待決問題",
  "無",
].join("\n") + "\n";

// Each marked block's lines in a work order: from its marker to the line before the next one.
function blockRanges(text) {
  const lines = text.split("\n");
  const markers = lines.map((line, index) => [/^<!-- bridge:(\S+) -->$/.exec(line)?.[1], index + 1]).filter(([key]) => key);
  return new Map(markers.map(([key, line], index) => [key, { start: line, end: (markers[index + 1]?.[1] ?? lines.length + 1) - 1 }]));
}
const within = (refs, range) => refs.length > 0 && refs.every((ref) => ref.start >= range.start && ref.end <= range.end);

test("a Chinese work order with frontmatter, a two-run plan and all 17 blocks: every field from its own block, the plan from the work order", async (t) => {
  const rt = await install(t);
  const order = ".review-bridge/work-packages/checkout.md";
  await fsp.writeFile(path.join(rt.root, order), CHINESE_ORDER);
  const planArg = ".review-bridge/review-queue/checkout.plan.json";
  const planned = rt.bridge(["work-plan", order, "--breakpoint", "return after review", "--out", planArg]);
  assert.equal(planned.status, 0, planned.stderr);
  const plan = await readJson(path.join(rt.root, planArg));
  // The values the run uses, each with the layer it came from.
  assert.deepEqual([plan.priority, plan.priority_source, plan.effort, plan.effort_source], ["high", "work_order", "high", "work_order"]);
  assert.deepEqual(plan.writer, { model: "opus", effort: "high" });
  assert.deepEqual(plan.reviewer, { model: null, effort: "high" }, "the reviewer's effort is the priority table's, never the work order's");
  assert.deepEqual(plan.budget, { tokens: 2_000_000, tokens_per_call: 1_000_000, call_timeout: 600_000, test_timeout: 300_000, run_timeout: 7_200_000, rounds: 1 });
  assert.ok(Object.values(plan.budget_source).every((source) => source === "work_order"));
  assert.equal(plan.contract_steps.call_timeout, 600_000);
  // A flag given at the terminal comes first.
  const flagged = rt.bridge(["work-plan", order, "--breakpoint", "return after review", "--call-timeout", "120000", "--out", ".review-bridge/review-queue/checkout-flag.plan.json"]);
  assert.equal(flagged.status, 0, flagged.stderr);
  const flaggedPlan = await readJson(path.join(rt.root, ".review-bridge", "review-queue", "checkout-flag.plan.json"));
  assert.deepEqual([flaggedPlan.budget.call_timeout, flaggedPlan.budget_source.call_timeout, flaggedPlan.budget_source.rounds], [120_000, "cli", "work_order"]);

  const started = start(rt, { plan, planArg });
  assert.equal(started.status, 0, started.stderr + started.stdout);
  const run = await readJson(path.join(rt.paths.runsDir, plan.proposed_run_id + ".json"));
  assert.equal(run.conclusion, "success");
  const { consumed_rounds: _consumed, ...runBudget } = run.budget;
  assert.deepEqual(runBudget, plan.budget, "the run keeps the six settled values");
  assert.equal(Date.parse(run.timeout_at) - Date.parse(run.created_at), 7_200_000);
  const contract = await loadContract(rt.paths, run.contract_sha256);
  const blocks = blockRanges(CHINESE_ORDER);
  assert.equal(blocks.size, 17);
  const parts = {
    context: contract.context, outcome: contract.outcome, requested_work: contract.requested_work,
    "scope_notes.include": contract.scope_notes.include, "scope_notes.exclude": contract.scope_notes.exclude,
    "scope_notes.must_keep": contract.scope_notes.must_keep, "scope_notes.expected_locations": contract.scope_notes.expected_locations,
    verification_hints: contract.verification_hints[0], references: contract.references[0],
    "reproduction.environment": contract.reproduction.environment, "reproduction.steps": contract.reproduction.steps,
    "reproduction.actual": contract.reproduction.actual, "reproduction.expected": contract.reproduction.expected, "reproduction.frequency": contract.reproduction.frequency,
  };
  for (const [key, part] of Object.entries(parts)) assert.ok(within(part.source_refs, blocks.get(key)), key + " " + JSON.stringify(part.source_refs));
  // The text is the block's content as written; its ## heading is not part of it.
  assert.equal(contract.context.text, "折扣碼輸入後 API 有回 200，但畫面上的總額還是原價。");
  assert.equal(contract.reproduction.steps.text, "1. 加一件商品到購物車。\n2. 輸入折扣碼 SAVE10。");
  for (const runPart of contract.run_plan.runs) assert.ok(within(runPart.source_refs, blocks.get("run_plan")), runPart.name);
  assert.deepEqual(contract.run_plan.runs.map((entry) => [entry.name, entry.text, entry.depends_on, entry.effort, entry.budget]), [
    ["計算", "修正總額的計算。", [], "medium", null],
    ["畫面", "總額變動時重新渲染。", ["計算"], null, { rounds: 1 }],
  ]);
  // The work order's own conditions belong to no run; each run's list belongs to its run.
  assert.deepEqual(contract.acceptance.map((entry) => [entry.id, entry.statement, entry.run_refs]), [
    ["AC1", "套用有效折扣碼後，總額欄位在 1 秒內顯示折扣後金額。", []],
    ["AC2", "折扣碼無效時總額不變，並顯示錯誤訊息。", []],
    ["AC3", "折扣後總額正確。", ["計算"]],
    ["AC4", "總額欄位在 1 秒內更新。", ["畫面"]],
  ]);
  for (const condition of contract.acceptance.slice(0, 2)) assert.ok(within(condition.source_refs, blocks.get("acceptance")), condition.id);
  for (const condition of contract.acceptance.slice(2)) assert.ok(within(condition.source_refs, blocks.get("run_plan")), condition.id);
  // The ticket keeps the work order's own values, not the settled ones.
  assert.deepEqual(contract.ticket, {
    title: { text: "結帳頁套用折扣碼後總額沒有重算", source_refs: [{ start: 13, end: 13 }] },
    source_id: { text: "SHOP-412", source_refs: [{ start: 11, end: 11 }] },
    priority: "high", effort: "high",
    budget: { tokens: 2_000_000, tokens_per_call: 1_000_000, call_timeout: 600_000, test_timeout: 300_000, run_timeout: 7_200_000, rounds: 1 },
  });
  assert.deepEqual(contract.open_questions, []);
  assert.deepEqual(contract.unused_lines, [{ text: "這行在任何區塊之外。", source_refs: [{ start: 15, end: 15 }] }]);
});

test("a work order that breaks the format, or asks for more than the policy allows, is refused with its lines and records nothing", async (t) => {
  const rt = await install(t);
  const body = "# Farm\n\n<!-- bridge:requested_work -->\nBuild a farm.\n\n<!-- bridge:acceptance -->\n- The farm shows.\n";
  const cases = [
    ["unknown-key", "---\nowner: me\n---\n" + body, /line 2: unknown key owner/],
    ["bad-priority", "---\npriority: soon\n---\n" + body, /line 2: priority must be one of low, medium, high, urgent/],
    ["over-limit", "---\nbudget:\n  rounds: 9\n---\n" + body, /line 3: budget\.rounds is 9, over the policy limit 2/],
    ["repeated-block", body + "\n<!-- bridge:acceptance -->\n- Again.\n", /line 9: block acceptance is already marked at line 6/],
    ["unknown-block", body + "\n<!-- bridge:extensions -->\nmore\n", /line 9: unknown block key extensions/],
  ];
  for (const [name, text, message] of cases) {
    const order = ".review-bridge/work-packages/" + name + ".md";
    await fsp.writeFile(path.join(rt.root, order), text);
    const refused = rt.bridge(["start", order, "--fake-cli"]);
    assert.notEqual(refused.status, 0, name);
    assert.match(refused.stderr, message, name + ": " + refused.stderr);
    // A plan is written in the log folder of the run it proposes; there is none.
    assert.deepEqual((await fsp.readdir(rt.paths.logRoot, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory()), [], name + ": no plan");
  }
  assert.deepEqual((await fsp.readdir(rt.paths.runsDir).catch(() => [])).filter((entry) => entry.endsWith(".json")), [], "nothing started");
});

test("a run that reaches its run_timeout is closed as timed out; the writer call is cut at the deadline, not after its own limit", async (t) => {
  const rt = await install(t);
  const timed = await planWork(rt, "timed", "---\nbudget:\n  run_timeout: 5000\n---\n" + SINGLE);
  assert.equal(timed.plan.budget.run_timeout, 5000);
  const startedAt = Date.now();
  const started = start(rt, timed, { FAKE_CLAUDE_SLEEP_MS: "60000" });
  assert.ok(Date.now() - startedAt < 40_000, "the run was not cut at its deadline");
  assert.equal(started.status, 130, started.stderr + started.stdout);
  const run = await runOf(rt, timed);
  assert.deepEqual([run.status, run.conclusion, run.closed_reason], ["completed", "timed_out", "run_timeout"]);
  assert.equal(Date.parse(run.timeout_at) - Date.parse(run.created_at), 5000);
  const result = await resultOf(rt, "timed");
  assert.match(result, /^# Timed out/m);
  assert.match(result, /reached its time limit \(run_timeout, 5000 ms\)/);
});
