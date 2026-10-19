import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadContract } from "../features/workOrder/contract.mjs";
import { workOrderChange } from "../features/workOrder/delivery.mjs";
import { processFile, startLockFile, workLockFile } from "../features/workOrder/processRecords.mjs";
import { workLockReleased, workOrderIdentity } from "../features/workOrder/workPackage.mjs";
import { unsupportedContractStep } from "../features/workOrder/translation.mjs";
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
async function install(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-contract-run-"));
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "contract-demo", dependencies: { express: "4.0.0" }, scripts: { test: "node -e \"process.exit(0)\"" } }));
  await fsp.writeFile(path.join(root, "README.md"), "# demo\n");
  const init = spawnSync(process.execPath, [
    path.join(packageRoot, "bridge.mjs"), "init", "--target", root, "--writer", "claude", "--reviewer", "codex", "--yes", "--fake-cli", "--port", String(await freePort()),
  ], { cwd: packageRoot, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(init.status, 0, init.stderr);
  const runtime = path.join(root, ".review-bridge", "tools", "review-bridge");
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
  "--breakpoint", "return after review", "--change-types", "code", "--max-claude-calls", "1", "--max-claude-minutes", "2", "--out", planArg];

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

function start(rt, { plan, planArg }, env = {}) {
  return rt.bridge(["work-start", "--plan", planArg, "--approve", plan.plan_sha256, "--fake-cli", "--json"], env);
}

const runOf = async (rt, work) => await readJson(path.join(rt.paths.runsDir, work.plan.proposed_run_id + ".json"));
const eventsOf = async (rt, work) => await readIoEvents(rt.paths, work.plan.proposed_run_id);
const resultOf = async (rt, name) => await fsp.readFile(path.join(rt.root, ".review-bridge", "work-packages", name + ".result.md"), "utf8");

// A prepared translation (or one per attempt) for the fake CLI to return, as if the model wrote it.
async function translationFile(rt, value) {
  const file = path.join(rt.root, "translation-" + Math.random().toString(16).slice(2, 8) + ".json");
  await fsp.writeFile(file, JSON.stringify(value));
  return file;
}

const at = (start, end = start) => ({ source_refs: [{ start, end }] });
const translation = (overrides) => ({
  event: "contract.translation",
  ticket: { title: at(1), type: null, source_id: null, product_version: null, people: null, schedule: null, related: null },
  context: null, outcome: null, requested_work: at(4),
  scope_notes: { include: null, exclude: null, must_keep: null, expected_locations: null },
  run_plan: null, acceptance: [], verification_hints: [], reproduction: null, references: [], open_questions: [],
  unused_lines: [{ start: 3, end: 3 }, { start: 6, end: 6 }],
  ...overrides,
});
const visible = { id: "AC1", statement: "The farm is visible.", quote: "The farm is visible.", source_refs: [{ start: 7, end: 7 }], verify: [{ kind: "gate_a", check: null }], run_refs: [] };

const SINGLE = "# Work order: farm\n\n## Work\nBuild a small farm.\n\n## Acceptance\n- The farm is visible.\n";

const MULTI = [
  "# Work order: farm",               // 1
  "",                                  // 2
  "## Work",                           // 3
  "Trees, then a cart.",               // 4
  "",                                  // 5
  "## Run plan",                       // 6
  "- Mode: multiple runs",             // 7
  "",                                  // 8
  "### RUN A: trees",                  // 9
  "- Work: plant trees",               // 10
  "- Acceptance: trees show",          // 11
  "- Depends on: none",                // 12
  "",                                  // 13
  "### RUN B: cart",                   // 14
  "- Work: add a cart",                // 15
  "- Acceptance: the cart drives",     // 16
  "- Depends on: RUN A",               // 17
  "",                                  // 18
  "## Acceptance",                     // 19
  "1. Trees show and the cart drives with the arrow keys.", // 20
].join("\n") + "\n";

test("the plan names the contract calls before the work, and the human approves them with it", async (t) => {
  const rt = await install(t);
  const work = await planWork(rt, "farm", SINGLE);
  assert.deepEqual(work.plan.contract_steps, {
    translate: { role: "writer", provider: "claude", model: work.plan.contract_steps.translate.model },
    check: { role: "reviewer", provider: "codex" },
    max_attempts: 2,
    minutes_per_call: 2,
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
  assert.equal(run.status, "pass");
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
  assert.equal(passed.status, "pass");
  const checks = (await eventsOf(rt, redone)).filter((event) => event.event === "contract.check");
  assert.deepEqual(checks.map((event) => event.decision), ["retranslate", "pass"]);
  assert.equal((await loadContract(rt.paths, passed.contract_sha256)).translated_by.attempt, 2);
  const prompts = (await fsp.readdir(rt.paths.queueRoot)).filter((name) => name.endsWith("-contract-prompt.txt")).sort();
  assert.match(await fsp.readFile(path.join(rt.paths.queueRoot, prompts.at(-1)), "utf8"), /- AC1 does not match its lines: says more than its lines/);
  const exhausted = await planWork(rt, "exhausted", SINGLE);
  assert.equal(start(rt, exhausted, { FAKE_CONTRACT_CHECK: "unfaithful_always" }).status, 79);
  const rejected = await runOf(rt, exhausted);
  assert.equal(rejected.status, "contract_rejected");
  assert.equal(rejected.contract_sha256, undefined);
  assert.equal((await eventsOf(rt, exhausted)).some((event) => event.event === "task.input"), false);
});

test("an ambiguity in the work order goes to the human; a reviewer that cannot confirm, or skips a condition, stops the run", async (t) => {
  const rt = await install(t);
  const unclear = await planWork(rt, "unclear", SINGLE);
  assert.equal(start(rt, unclear, { FAKE_CONTRACT_CHECK: "ambiguous" }).status, 0);
  assert.equal((await runOf(rt, unclear)).status, "needs_human");
  assert.match(await resultOf(rt, "unclear"), /- Which page should show the farm\?/);
  const doubtful = await planWork(rt, "doubtful", SINGLE);
  assert.equal(start(rt, doubtful, { FAKE_CONTRACT_CHECK: "cannot_confirm" }).status, 0);
  const unconfirmed = await runOf(rt, doubtful);
  assert.equal(unconfirmed.status, "contract_unconfirmed");
  assert.equal(unconfirmed.contract_sha256, undefined);
  assert.match(await resultOf(rt, "doubtful"), /could not confirm that the contract matches the work order[\s\S]*- fake: the work order refers to a design not given/);
  const partial = await planWork(rt, "partial", SINGLE + "- The cart moves.\n");
  assert.equal(start(rt, partial, { FAKE_CONTRACT_CHECK: "skip_ac" }).status, 0);
  assert.equal((await runOf(rt, partial)).status, "contract_unconfirmed");
  assert.deepEqual((await runOf(rt, partial)).last_state.contract_problems, ["$.acceptance: must judge exactly AC1, AC2"]);
});

test("a wrong field is redone; a reviewer that leaves a field unjudged stops the run; unreadable usage stops before the writer", async (t) => {
  const rt = await install(t);
  const redone = await planWork(rt, "field", SINGLE);
  assert.equal(start(rt, redone, { FAKE_CONTRACT_CHECK: "field_unfaithful_first" }).status, 0);
  assert.equal((await runOf(rt, redone)).status, "pass");
  const checks = (await eventsOf(rt, redone)).filter((event) => event.event === "contract.check");
  assert.deepEqual(checks.map((event) => event.decision), ["retranslate", "pass"]);
  assert.deepEqual(checks[0].feedback, ["scope_notes.include does not match the work order: an exclusion was copied as an inclusion"]);
  const skipped = await planWork(rt, "skipped", SINGLE);
  assert.equal(start(rt, skipped, { FAKE_CONTRACT_CHECK: "skip_field" }).status, 0);
  const unconfirmed = await runOf(rt, skipped);
  assert.equal(unconfirmed.status, "contract_unconfirmed");
  assert.match(unconfirmed.last_state.contract_problems[0], /^\$\.fields: must judge exactly ticket, /);
  const unknown = await planWork(rt, "unknown", SINGLE);
  assert.equal(start(rt, unknown, { FAKE_CONTRACT_CHECK_USAGE: "none" }).status, 76);
  const stopped = await runOf(rt, unknown);
  assert.equal(stopped.status, "usage_unknown");
  assert.equal(stopped.contract_sha256, undefined);
  assert.equal((await eventsOf(rt, unknown)).some((event) => event.event === "task.input"), false);
  assert.match(await resultOf(rt, "unknown"), /could not read how many tokens the contract check call used/);
});

test("a work order with two runs keeps its run plan as data; one source line gives three conditions; Bridge still starts one run", async (t) => {
  const rt = await install(t);
  const work = await planWork(rt, "multi", MULTI);
  const gate = [{ kind: "gate_a", check: null }];
  const file = await translationFile(rt, translation({
    run_plan: { runs: [
      { name: "RUN A", depends_on: [], depends_on_quote: "Depends on: none", source_refs: [{ start: 9, end: 12 }] },
      { name: "RUN B", depends_on: ["RUN A"], depends_on_quote: "Depends on: RUN A", source_refs: [{ start: 14, end: 17 }] },
    ] },
    acceptance: [
      { id: "AC1", statement: "Trees show.", quote: "Trees show", source_refs: [{ start: 20, end: 20 }], verify: [{ kind: "reviewer", check: "trees are on screen" }], run_refs: ["RUN A"] },
      { id: "AC2", statement: "The cart drives with the arrow keys.", quote: "the cart drives with the arrow keys", source_refs: [{ start: 20, end: 20 }], verify: gate, run_refs: ["RUN B"] },
      { id: "AC3", statement: "Both work together.", quote: "Trees show and the cart drives", source_refs: [{ start: 20, end: 20 }], verify: gate, run_refs: ["RUN A", "RUN B"] },
    ],
    unused_lines: [{ start: 3, end: 3 }, { start: 6, end: 7 }, { start: 19, end: 19 }],
  }));
  const started = start(rt, work, { FAKE_CONTRACT_FILE: file });
  assert.equal(started.status, 0, started.stderr + started.stdout);
  const run = await runOf(rt, work);
  assert.equal(run.status, "pass");
  const contract = await loadContract(rt.paths, run.contract_sha256);
  assert.deepEqual(contract.run_plan.runs.map((entry) => [entry.name, entry.depends_on]), [["RUN A", []], ["RUN B", ["RUN A"]]]);
  assert.equal(contract.run_plan.runs[1].text, "### RUN B: cart\n- Work: add a cart\n- Acceptance: the cart drives\n- Depends on: RUN A");
  assert.deepEqual(contract.acceptance.map((entry) => entry.id), ["AC1", "AC2", "AC3"]);
  assert.ok(contract.acceptance.every((entry) => entry.source_refs[0].start === 20));
  // This step only records the human's run plan; starting one Bridge run per RUN is not built yet.
  assert.deepEqual(await fsp.readdir(rt.paths.runsDir), [work.plan.proposed_run_id + ".json"]);
});

test("a writer that rewrites the sealed contract ends the run as contract_changed, before any review", async (t) => {
  const rt = await install(t);
  const work = await planWork(rt, "tamper", SINGLE);
  assert.equal(start(rt, work, { FAKE_CONTRACT_TAMPER: "1" }).status, 78);
  const run = await runOf(rt, work);
  assert.equal(run.status, "contract_changed");
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
  assert.equal(writerRun.status, "malformed_writer_result");
  assert.ok(writerRun.last_state.errors.includes("$.contract_sha256: expected " + writerRun.contract_sha256));
  const reviewer = await planWork(rt, "echo-reviewer", SINGLE);
  assert.equal(start(rt, reviewer, { FAKE_CODEX_CONTRACT: "other" }).status, 79);
  assert.equal((await runOf(rt, reviewer)).status, "malformed_review_result");
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
  assert.equal(firstRun.status, "pass");
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
  assert.equal((await runOf(rt, first)).status, "running");
  assert.equal(alive(old.record.pid), true);

  // A stop of the old version that cannot be confirmed refuses the new start; nothing of it is made.
  const second = await planWork(rt, "farm", edited);
  await fsp.writeFile(old.recordPath, JSON.stringify({ ...old.record, pid: UNKILLABLE }));
  const refused = start(rt, second);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, new RegExp("could not be stopped: run " + first.plan.proposed_run_id));
  assert.equal(await fsp.stat(path.join(rt.paths.runsDir, second.plan.proposed_run_id + ".json")).then(() => true, () => false), false);

  // Starting again retries the stop; the new version runs only once the old one is gone.
  await fsp.writeFile(old.recordPath, JSON.stringify(old.record));
  const started = start(rt, second);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(alive(old.record.pid), false);
  await old.exit;
  const oldRun = await runOf(rt, first);
  assert.equal(oldRun.status, "stopped");
  assert.equal(oldRun.closed_reason, "superseded");
  const oldStop = (await eventsOf(rt, first)).find((event) => event.event === "stop" && event.status === "stopped");
  assert.equal(oldStop.superseded_by, second.plan.proposed_run_id);
  const newEvents = await eventsOf(rt, second);
  assert.ok(oldStop.occurred_at <= newEvents[0].occurred_at, "the new version started before the old one was stopped");
  // The new version has its own contract and verdicts; the old run left none of its records in it.
  const newRun = await runOf(rt, second);
  assert.equal(newRun.status, "pass");
  assert.notEqual(newRun.contract_sha256, oldRun.contract_sha256);
  assert.equal((await loadContract(rt.paths, newRun.contract_sha256)).acceptance.length, 2);
  assert.ok(newEvents.every((event) => event.run_id === second.plan.proposed_run_id));
  assert.equal((await eventsOf(rt, first)).some((event) => event.event === "review.result"), false);
  // The old authorization cannot start anything again.
  assert.notEqual(start(rt, first).status, 0);
  // The old run's own result says why it stopped.
  const oldResult = await fsp.readFile(path.join(rt.paths.queueRoot, first.plan.proposed_run_id + ".result.md"), "utf8");
  // Whichever side delivered first, the new run is named; it is never left out.
  assert.match(oldResult, new RegExp("started again as a new version: run " + second.plan.proposed_run_id + "[. ]"));
});

test("the new version waits for the old work-start to let go of its run, and refuses if it does not", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-lock-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const paths = getBridgePaths(root, runtimeSource, { privateRootName: ".review-bridge" });
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

// An editor that saves by renaming gives the work order file a new identity. A start that sees its
// work order replaced while it runs cannot be sure no other start holds another lock for it, so it
// fails and leaves no run working. The start is held in its wait for the old version to close.
test("a work order file replaced while a start runs fails that start and leaves no run working", async (t) => {
  const rt = await install(t);
  const first = await planWork(rt, "farm", SINGLE);
  const old = await startSleeping(rt, first);
  t.after(() => { try { process.kill(old.record.pid); } catch {} });
  old.child.kill("SIGKILL");
  await old.exit;
  const edited = SINGLE + "- The cart is red.\n";
  const second = await planWork(rt, "farm", edited);
  // The old version's work-start seems to be closing for a while: the new start waits for it.
  const closing = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], { windowsHide: true, stdio: "ignore" });
  t.after(() => { try { closing.kill(); } catch {} });
  await fsp.writeFile(workLockFile(rt.paths, first.plan.proposed_run_id), JSON.stringify({ pid: closing.pid }));
  const child = spawn(process.execPath, [rt.bootstrap, "work-start", "--plan", second.planArg, "--approve", second.plan.plan_sha256, "--fake-cli", "--json"], {
    cwd: rt.root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = new Promise((resolve) => child.once("close", resolve));
  // Once the old run is stopped for this start, the start is in its wait: replace the work order
  // file with the same text, as a save by renaming would.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && (await runOf(rt, first)).superseded_by !== second.plan.proposed_run_id) await pause(100);
  assert.equal((await runOf(rt, first)).superseded_by, second.plan.proposed_run_id, "the new start never stopped the old version");
  const before = await workOrderIdentity(rt.paths, second.plan.task_file);
  const file = path.join(rt.root, second.order);
  await fsp.writeFile(file + ".tmp", edited);
  await fsp.rename(file + ".tmp", file);
  assert.notEqual(await workOrderIdentity(rt.paths, second.plan.task_file), before, "the rename did not give the file a new identity");
  closing.kill();
  assert.notEqual(await exit, 0);
  assert.match(stderr, /was replaced while this start ran; Bridge cannot be sure no other start holds it/);
  // Nothing of this start is left working: its run, if made, is closed.
  const run = await runOf(rt, second).catch(() => null);
  if (run) {
    assert.equal(run.status, "controller_failure");
    assert.ok(run.closed_at);
  }
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
  assert.equal((await runOf(rt, second)).status, "pass");
  // The old version's work-start is gone, so the new start delivered it.
  const oldRun = await runOf(rt, first);
  assert.equal(oldRun.closed_reason, "superseded");
  assert.equal(oldRun.outcome, "stopped");
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
  const lockFile = startLockFile(rt.paths, await workOrderIdentity(rt.paths, first.plan.task_file));
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
  assert.equal((await runOf(rt, first)).status, "pass");
});

test("a second start of an unchanged work order that is already running is refused, and the running one goes on", async (t) => {
  const rt = await install(t);
  const first = await planWork(rt, "farm", SINGLE);
  const second = await planWork(rt, "farm", SINGLE);
  // The first run exists and its start has let go of the start lock.
  const old = await startSleeping(rt, first);
  t.after(() => { try { process.kill(old.record.pid); } catch {} });
  const refused = start(rt, second);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, new RegExp("already running unchanged as run " + first.plan.proposed_run_id + "; nothing was created"));
  await assert.rejects(runOf(rt, second));
  assert.equal((await runOf(rt, first)).status, "running");
  assert.equal(alive(old.record.pid), true);
  // The start card says the start will be refused, not that it will stop the run.
  const card = spawnSync(process.execPath, [rt.bootstrap, "work-start", "--plan", second.planArg, "--fake-cli"], {
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
  assert.equal(runs[winner].status, "pass");
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
  const identity = await workOrderIdentity(rt.paths, lower.plan.task_file);
  assert.equal(await workOrderIdentity(rt.paths, upper.plan.task_file), identity);
  // Started at the same moment under the two spellings: exactly one run.
  const exits = await startTogether(rt, [lower, upper]);
  const runs = await Promise.all([lower, upper].map((work) => runOf(rt, work).catch(() => null)));
  assert.equal(runs.filter(Boolean).length, 1, exits.map((exit) => exit.stderr).join(" | "));
  assert.equal(runs.find(Boolean).status, "pass");
  assert.match(exits[runs.findIndex((run) => !run)].stderr, /nothing was created/);
  // One spelling running, the other refused: the running one goes on.
  const running = await planWork(rt, "farm", SINGLE);
  const other = await planWork(rt, "FARM", SINGLE);
  const old = await startSleeping(rt, running);
  t.after(() => { try { process.kill(old.record.pid); } catch {} });
  const refused = start(rt, other);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, new RegExp("already running unchanged as run " + running.plan.proposed_run_id));
  assert.equal((await runOf(rt, running)).status, "running");
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
  assert.notEqual(await workOrderIdentity(rt.paths, lower.plan.task_file), await workOrderIdentity(rt.paths, upper.plan.task_file));
  const exits = await startTogether(rt, [lower, upper]);
  for (const [index, work] of [lower, upper].entries()) {
    assert.equal(exits[index].code, 0, exits[index].stderr);
    const run = await runOf(rt, work);
    assert.equal(run.status, "pass");
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
  assert.equal((await runOf(rt, first)).status, "running");
  assert.equal(alive(old.record.pid), true);
  // Another work order's start works beside it, to the end, and leaves this one running.
  const other = await planWork(rt, "barn", SINGLE);
  const otherStart = start(rt, other);
  assert.equal(otherStart.status, 0, otherStart.stderr);
  assert.equal((await runOf(rt, other)).status, "pass");
  assert.equal((await runOf(rt, first)).status, "running");
  assert.equal(alive(old.record.pid), true);
  const stopped = rt.bridge(["stop", first.plan.proposed_run_id]);
  assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
  await old.exit;
});

test("an open question from the translation stops the work before the writer and is shown to the human", async (t) => {
  const rt = await install(t);
  const work = await planWork(rt, "asked", SINGLE);
  const file = await translationFile(rt, translation({
    acceptance: [visible], open_questions: [{ question: "Which page shows the farm?", source_refs: [{ start: 4, end: 4 }] }],
  }));
  assert.equal(start(rt, work, { FAKE_CONTRACT_FILE: file }).status, 0);
  const run = await runOf(rt, work);
  assert.equal(run.status, "needs_human");
  assert.equal(run.contract_sha256, undefined);
  assert.equal((await eventsOf(rt, work)).some((event) => event.event === "task.input"), false);
  assert.match(await resultOf(rt, "asked"), /- Which page shows the farm\?/);
});

test("a translation that points past the text is refused, tried again, and nothing is sealed", async (t) => {
  const rt = await install(t);
  const work = await planWork(rt, "bad", SINGLE);
  const file = await translationFile(rt, translation({ context: at(40), acceptance: [visible] }));
  assert.equal(start(rt, work, { FAKE_CONTRACT_FILE: file }).status, 79);
  const run = await runOf(rt, work);
  assert.equal(run.status, "contract_rejected");
  assert.deepEqual(run.last_state.contract_problems, ["$.context.source_refs[0]: line 40 is past the last line 7"]);
  assert.equal((await eventsOf(rt, work)).filter((event) => event.event === "contract.translation").length, 2);
  assert.deepEqual(await fsp.readdir(rt.paths.contractsDir).catch(() => []), []);
  assert.match(await resultOf(rt, "bad"), /line 40 is past the last line 7/);
});
