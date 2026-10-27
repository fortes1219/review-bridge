// Keeps the person's database out of these tests (see the fixture).
import "./fixtures/isolatedDataHome.mjs";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildContract,
  CHECKED_FIELDS,
  CONTRACT_CHECK_SCHEMA,
  checkTranslation,
  CHECK_MODE_HEADER,
  composeCheckPrompt,
  composeTranslationPrompt,
  CONTRACT_MODE_HEADER,
  ContractChangedError,
  contractPath,
  decideCheck,
  loadContract,
  numberedLines,
  sealContract,
} from "../features/workOrder/contract.mjs";
import { canonical, digest } from "../utils/digest.mjs";
import { getBridgePaths } from "../utils/paths.mjs";

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE = { kind: "command", command: "npm test" };
const NO_GATE = { kind: "not_applicable", command: null };

const LINES = [
  "# Work order: farm",          // 1
  "",                            // 2
  "## Work",                     // 3
  "Build a small farm.",         // 4
  "",                            // 5
  "## Acceptance",               // 6
  "1. Trees and a barn show; the cart drives with the arrow keys.", // 7
  "2. The cart stops at the barn.", // 8
];

const at = (start, end = start) => ({ source_refs: [{ start, end }] });
const criterion = (id, statement, quote, line, verify = [{ kind: "test", check: null }], runRefs = []) => ({
  id, statement, quote, source_refs: [{ start: line, end: line }], verify, run_refs: runRefs,
});

function translation(overrides = {}) {
  return {
    event: "contract.translation",
    ticket: { title: at(1), type: null, source_id: null, product_version: null, people: null, schedule: null, related: null },
    context: null,
    outcome: null,
    requested_work: at(4),
    scope_notes: { include: null, exclude: null, must_keep: null, expected_locations: null },
    run_plan: null,
    acceptance: [
      criterion("AC1", "Trees and a barn are shown.", "Trees and a barn show", 7, [{ kind: "reviewer", check: "the screen shows trees and a barn" }]),
      criterion("AC2", "The cart drives with the arrow keys.", "the cart drives with the arrow keys", 7),
      criterion("AC3", "The cart stops at the barn.", "The cart stops at the barn.", 8),
    ],
    verification_hints: [],
    reproduction: null,
    references: [],
    open_questions: [],
    unused_lines: [{ start: 3, end: 3 }, { start: 6, end: 6 }],
    ...overrides,
  };
}

const check = (value, rule = GATE) => checkTranslation(value, { lines: LINES, test: rule });
const workPackage = { work_package_id: "farm-1", task: LINES.join("\n"), task_file: ".review-bridge/work-packages/farm.md" };
const translator = { role: "writer", provider: "claude", model: "opus", attempt: 1 };
const checker = { role: "reviewer", provider: "codex" };

test("one source line may give several conditions; line numbers locate, they are not condition numbers", async () => {
  assert.deepEqual(await check(translation()), { ok: true, problems: [], questions: [] });
});

test("a condition must quote its own lines verbatim; a quote from nowhere or from other lines is refused", async () => {
  const invented = await check(translation({ acceptance: [criterion("AC1", "The farm has a pond.", "a pond", 7), ...translation().acceptance.slice(1).map((item, index) => ({ ...item, id: "AC" + (index + 2) }))] }));
  assert.deepEqual(invented.problems, ["$.acceptance[0].quote: not found verbatim in its source lines"]);
  const elsewhere = await check(translation({ acceptance: [criterion("AC1", "x", "Build a small farm.", 8), ...translation().acceptance.slice(1).map((item, index) => ({ ...item, id: "AC" + (index + 2) }))] }));
  assert.deepEqual(elsewhere.problems, ["$.acceptance[0].quote: not found verbatim in its source lines"]);
  // Spacing differences do not matter; words do.
  const spaced = await check(translation({ acceptance: [criterion("AC1", "x", "Trees  and a\tbarn show", 7, [{ kind: "reviewer", check: "c" }]), ...translation().acceptance.slice(1).map((item, index) => ({ ...item, id: "AC" + (index + 2) }))] }));
  assert.equal(spaced.ok, true);
});

test("every non-blank line is used or listed as unused, never both and never forgotten", async () => {
  const forgotten = await check(translation({ unused_lines: [{ start: 3, end: 3 }] }));
  assert.deepEqual(forgotten.problems, ["line 6 is neither used nor listed in unused_lines"]);
  const both = await check(translation({ unused_lines: [{ start: 3, end: 4 }, { start: 6, end: 6 }] }));
  assert.deepEqual(both.problems, ["line 4 is both used and listed in unused_lines"]);
  // A dropped acceptance line cannot vanish: it has to be listed, where the reviewer reads it.
  const dropped = await check(translation({ acceptance: translation().acceptance.slice(0, 2), unused_lines: [{ start: 3, end: 3 }, { start: 6, end: 6 }, { start: 8, end: 8 }] }));
  assert.equal(dropped.ok, true);
});

test("a translation may only point at lines that exist, in order, and number its conditions AC1, AC2, ...", async () => {
  const pastEnd = await check(translation({ requested_work: at(4, 99) }));
  assert.deepEqual(pastEnd.problems, ["$.requested_work.source_refs[0]: line 99 is past the last line 8"]);
  const backwards = await check(translation({ requested_work: at(5, 4) }));
  assert.deepEqual(backwards.problems, ["$.requested_work.source_refs[0]: start is after end"]);
  const items = translation().acceptance;
  const skipped = await check(translation({ acceptance: [items[0], items[1], { ...items[2], id: "AC4" }] }));
  assert.deepEqual(skipped.problems, ["$.acceptance[2].id: expected AC3"]);
  // Parts carry line ranges only; a model cannot write their text.
  const written = await check(translation({ context: { text: "invented background", source_refs: [{ start: 4, end: 4 }] } }));
  assert.deepEqual(written.problems, ["$.context: unexpected text"]);
});

test("the translation cannot choose a command, a path, a budget or a role", async () => {
  const items = translation().acceptance;
  const command = await check(translation({ acceptance: [{ ...items[0], verify: [{ kind: "test", check: null, command: "rm -rf /" }] }, items[1], items[2]] }));
  assert.deepEqual(command.problems, ["$.acceptance[0].verify[0]: unexpected command"]);
  const scope = await check({ ...translation(), allowed_paths: ["**"], budget: { calls: 99 } });
  assert.deepEqual(scope.problems, ["$: unexpected allowed_paths", "$: unexpected budget"]);
  const noGate = await check(translation(), NO_GATE);
  assert.deepEqual(noGate.problems, ["$.acceptance[1].verify[0]: Bridge runs no verification command for this work", "$.acceptance[2].verify[0]: Bridge runs no verification command for this work"]);
  const vague = await check(translation({ acceptance: [{ ...items[0], verify: [{ kind: "reviewer", check: null }] }, items[1], items[2]] }));
  assert.deepEqual(vague.problems, ["$.acceptance[0].verify[0].check: say what the reviewer checks"]);
});

const RUN_LINES = ["# farm", "### RUN A: trees", "plant trees", "### RUN B: cart", "add a cart", "## Acceptance", "- trees and cart"];
const runCheck = (runPlan, acceptance) => checkTranslation(translation({
  requested_work: null, run_plan: runPlan, acceptance, unused_lines: [{ start: 6, end: 6 }],
}), { lines: RUN_LINES, test: GATE });
const run = (name, start, end, dependsOn = [], quote = null) => ({ name, depends_on: dependsOn, depends_on_quote: quote, source_refs: [{ start, end }] });

test("runs come only from the work order's own run plan: names appear in their lines, dependencies exist and do not loop", async () => {
  const both = criterion("AC1", "Trees and cart work together.", "trees and cart", 7, undefined, ["RUN A", "RUN B"]);
  assert.deepEqual(await runCheck({ runs: [run("RUN A", 2, 3), run("RUN B", 4, 5)] }, [both]), { ok: true, problems: [], questions: [] });
  const looped = await checkTranslation(translation({
    requested_work: null, run_plan: { runs: [run("RUN A", 1, 2, ["RUN B"], "after RUN B"), run("RUN B", 3, 4, ["RUN A"], "after RUN A")] },
    acceptance: [criterion("AC1", "x", "both", 5, undefined, ["RUN A"])], unused_lines: [],
  }), { lines: ["### RUN A", "after RUN B", "### RUN B", "after RUN A", "both"], test: GATE });
  assert.deepEqual(looped.problems, ["$.run_plan: dependency cycle RUN A -> RUN B -> RUN A"]);
  const invented = await runCheck({ runs: [run("RUN A", 2, 3), run("RUN C", 4, 5)] }, [criterion("AC1", "x", "trees and cart", 7, undefined, ["RUN A"])]);
  assert.deepEqual(invented.problems, ["$.run_plan.runs[1].name: \"RUN C\" does not appear in its lines"]);
  const stray = await check(translation({ acceptance: [{ ...translation().acceptance[0], run_refs: ["RUN A"] }, ...translation().acceptance.slice(1)] }));
  assert.deepEqual(stray.problems, ["$.acceptance[0].run_refs: there is no run_plan"]);
});

test("an open question or a work order with nothing to check stops before any work", async () => {
  const asked = await check(translation({ open_questions: [{ question: "Which barn colour?", source_refs: [{ start: 7, end: 7 }] }] }));
  assert.deepEqual(asked, { ok: true, problems: [], questions: ["Which barn colour?"] });
  const empty = await check(translation({ acceptance: [], unused_lines: [{ start: 3, end: 3 }, { start: 6, end: 8 }] }));
  assert.deepEqual(empty.questions, ["The work order states no result that can be checked."]);
});

test("Bridge copies the referenced lines into the contract; the model wrote only conditions and questions", () => {
  const contract = buildContract({ workPackage, lines: LINES, translation: translation(), translator, checker });
  assert.deepEqual(contract.requested_work, { text: "Build a small farm.", source_refs: [{ start: 4, end: 4 }] });
  assert.equal(contract.ticket.title.text, "# Work order: farm");
  assert.equal(contract.ticket.type, null);
  assert.deepEqual(contract.unused_lines.map((entry) => entry.text), ["## Work", "## Acceptance"]);
  assert.equal(contract.acceptance[1].statement, "The cart drives with the arrow keys.");
  assert.equal(contract.event, undefined);
  assert.deepEqual(contract.checked_by, checker);
});

test("the prompts number every line, name the output language, and the check shows the full text and the candidate", () => {
  const lines = numberedLines(LINES.join("\n") + "\n");
  assert.equal(lines.length, 8);
  const prompt = composeTranslationPrompt({ workPackageId: "farm-1", lines, test: GATE, locale: "ja", attempt: 2, feedback: ["AC1 does not match its lines"] });
  assert.equal(prompt.split("\n")[0], CONTRACT_MODE_HEADER);
  assert.match(prompt, /^7\| 1\. Trees and a barn show/m);
  assert.match(prompt, /BCP 47 tag "ja"/);
  assert.match(prompt, /Attempt: 2/);
  assert.match(prompt, /- AC1 does not match its lines/);
  assert.match(composeTranslationPrompt({ workPackageId: "farm-1", lines, test: NO_GATE, locale: "en" }), /Bridge runs no verification command/);
  const candidate = buildContract({ workPackage, lines: LINES, translation: translation(), translator, checker });
  const checkPrompt = composeCheckPrompt({ workPackageId: "farm-1", lines, candidate, sha256: digest(candidate), locale: "en", attempt: 1 });
  assert.equal(checkPrompt.split("\n")[0], CHECK_MODE_HEADER);
  assert.match(checkPrompt, new RegExp("Candidate: " + digest(candidate)));
  assert.match(checkPrompt, /^8\| 2\. The cart stops at the barn\./m);
  assert.match(checkPrompt, /"unused_lines"/);
});

test("Bridge decides from every condition the reviewer judged: a mistake is redone, an ambiguity goes to the human, doubt stops", async () => {
  const candidate = buildContract({ workPackage, lines: LINES, translation: translation(), translator, checker });
  const sha256 = digest(candidate);
  const answer = (overrides = {}) => ({
    event: "contract.check", candidate_sha256: sha256,
    fields: CHECKED_FIELDS.map((field) => ({ field, faithful: true, note: null })),
    acceptance: ["AC1", "AC2", "AC3"].map((id) => ({ id, faithful: true, note: null })),
    missing: [], ambiguities: [], cannot_confirm: false, cannot_confirm_reason: null, ...overrides,
  });
  const decide = (value) => decideCheck(value, { candidate, sha256 });
  assert.equal((await decide(answer())).decision, "pass");
  const wrong = await decide(answer({ acceptance: [{ id: "AC1", faithful: false, note: "adds a barn colour" }, { id: "AC2", faithful: true, note: null }, { id: "AC3", faithful: true, note: null }] }));
  assert.deepEqual(wrong, { decision: "retranslate", problems: [], feedback: ["AC1 does not match its lines: adds a barn colour"], questions: [] });
  const missing = await decide(answer({ missing: [{ source_refs: [{ start: 4, end: 4 }], note: "the farm itself" }] }));
  assert.deepEqual(missing.feedback, ["missing requirement at lines 4-4: the farm itself"]);
  const unclear = await decide(answer({ ambiguities: [{ question: "Which page?", source_refs: [] }] }));
  assert.deepEqual(unclear, { decision: "needs_human", problems: [], feedback: [], questions: ["Which page?"] });
  assert.equal((await decide(answer({ cannot_confirm: true, cannot_confirm_reason: "design not given" }))).decision, "unconfirmed");
  // A reviewer that skips a condition, judges another hash, or answers off-schema has not confirmed anything.
  assert.deepEqual((await decide(answer({ acceptance: answer().acceptance.slice(0, 2) }))).problems, ["$.acceptance: must judge exactly AC1, AC2, AC3"]);
  assert.deepEqual((await decide(answer({ candidate_sha256: "0".repeat(64) }))).problems, ["$.candidate_sha256: expected " + sha256]);
  assert.equal((await decide({ event: "contract.check", verdict: "PASS" })).decision, "unconfirmed");
});

test("a sealed contract matches its schema, is stored once under its hash, and any change is caught on the next read", async (t) => {
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-contract-"));
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  const paths = getBridgePaths(repoRoot, bridgeRoot, { privateRootName: ".review-bridge" });
  const contract = buildContract({ workPackage, lines: LINES, translation: translation(), translator, checker });
  const sealed = await sealContract(paths, contract);
  assert.equal(sealed.sha256, digest(contract));
  assert.equal(sealed.contract.source.lines[6], LINES[6]);
  assert.deepEqual(await loadContract(paths, sealed.sha256), contract);
  assert.equal((await sealContract(paths, contract)).sha256, sealed.sha256);
  await assert.rejects(sealContract(paths, { ...contract, allowed_paths: ["**"] }), /does not match its schema: \$: unexpected allowed_paths/);
  const file = contractPath(paths, sealed.sha256);
  const edited = JSON.parse(await fsp.readFile(file, "utf8"));
  edited.acceptance.pop();
  await fsp.writeFile(file, JSON.stringify(edited));
  await assert.rejects(loadContract(paths, sealed.sha256), (error) => error instanceof ContractChangedError && /changed after it was sealed/.test(error.message));
  await fsp.rm(file);
  await assert.rejects(loadContract(paths, sealed.sha256), /is missing/);
  assert.throws(() => contractPath(paths, "../escape"), /Contract hash is invalid/);
});

// Codex review 2026-10-18, round 2: each reproduction is a boundary the harness must hold.

test("an exclusion copied into include passes the code checks, so the reviewer must judge every field and Bridge acts on it", async () => {
  const lines = ["# farm", "## Scope", "- Includes: the farm page", "- Excludes: payment work", "## Acceptance", "- The farm page loads."];
  const moved = translation({
    requested_work: null,
    scope_notes: { include: { source_refs: [{ start: 3, end: 4 }] }, exclude: null, must_keep: null, expected_locations: null },
    acceptance: [criterion("AC1", "The farm page loads.", "The farm page loads.", 6)],
    unused_lines: [{ start: 2, end: 2 }, { start: 5, end: 5 }],
  });
  // Code cannot tell an inclusion from an exclusion; every line is used and every quote is verbatim.
  assert.equal((await checkTranslation(moved, { lines, test: GATE })).ok, true);
  const candidate = buildContract({ workPackage: { ...workPackage, task: lines.join("\n") }, lines, translation: moved, translator, checker });
  const sha256 = digest(candidate);
  const judged = (field, faithful, note) => CHECKED_FIELDS.map((name) => ({ field: name, faithful: name === field ? faithful : true, note: name === field ? note : null }));
  const answer = (fields) => ({ event: "contract.check", candidate_sha256: sha256, fields, acceptance: [{ id: "AC1", faithful: true, note: null }], missing: [], ambiguities: [], cannot_confirm: false, cannot_confirm_reason: null });
  const flagged = await decideCheck(answer(judged("scope_notes.include", false, "Excludes was copied as an inclusion")), { candidate, sha256 });
  assert.deepEqual(flagged.feedback, ["scope_notes.include does not match the work order: Excludes was copied as an inclusion"]);
  assert.equal(flagged.decision, "retranslate");
  // An empty field is a claim too; a reviewer that leaves one unjudged has not confirmed the contract.
  const skipped = await decideCheck(answer(judged("scope_notes.exclude", true, null).filter((item) => item.field !== "scope_notes.exclude")), { candidate, sha256 });
  assert.equal(skipped.decision, "unconfirmed");
  assert.deepEqual(skipped.problems, ["$.fields: must judge exactly " + CHECKED_FIELDS.join(", ")]);
});

test("the check schema lists exactly the fields Bridge requires the reviewer to judge", async () => {
  const schema = JSON.parse(await fsp.readFile(CONTRACT_CHECK_SCHEMA, "utf8"));
  assert.deepEqual(schema.properties.fields.items.properties.field.enum, [...CHECKED_FIELDS]);
});

test("a run arrangement must come from the work order: no added dependency, no single-run plan, no condition outside the runs", async () => {
  const lines = ["# farm", "### RUN A: trees", "- Depends on: none", "### RUN B: cart", "- Depends on: none", "## Acceptance", "- trees and cart"];
  const plan = (runB) => ({ runs: [run("RUN A", 2, 3, [], "Depends on: none"), runB] });
  const withPlan = (runPlan, runRefs = ["RUN A", "RUN B"]) => checkTranslation(translation({
    requested_work: null, run_plan: runPlan, acceptance: [criterion("AC1", "x", "trees and cart", 7, undefined, runRefs)], unused_lines: [{ start: 6, end: 6 }],
  }), { lines, test: GATE });
  assert.equal((await withPlan(plan(run("RUN B", 4, 5, [], "Depends on: none")))).ok, true);
  // Both runs say "none"; a model that adds "RUN B depends on RUN A" has no line to quote for it.
  const added = await withPlan(plan(run("RUN B", 4, 5, ["RUN A"], null)));
  assert.deepEqual(added.problems, ["$.run_plan.runs[1].depends_on_quote: a dependency needs the line that states it"]);
  const misquoted = await withPlan(plan(run("RUN B", 4, 5, ["RUN A"], "Depends on: none")));
  assert.deepEqual(misquoted.problems, ["$.run_plan.runs[1].depends_on_quote: does not name RUN A"]);
  const borrowed = await withPlan(plan(run("RUN B", 4, 5, ["RUN A"], "### RUN A: trees")));
  assert.deepEqual(borrowed.problems, ["$.run_plan.runs[1].depends_on_quote: not found verbatim in the run's own lines"]);
  // One mention of "RUN A" in a single piece of work is not a run plan.
  const single = await withPlan({ runs: [run("RUN A", 2, 3, [], null)] }, ["RUN A"]);
  assert.deepEqual(single.problems, ["$.run_plan.runs: fewer than 2 items"]);
  // With a plan, every condition belongs to at least one run.
  const orphan = await withPlan(plan(run("RUN B", 4, 5, [], null)), []);
  assert.deepEqual(orphan.problems, ["$.acceptance[0].run_refs: name the runs this condition belongs to"]);
  const shared = await withPlan({ runs: [run("RUN A", 2, 4, [], null), run("RUN B", 4, 5, [], null)] });
  assert.deepEqual(shared.problems, ["$.run_plan.runs[1].source_refs: line 4 also belongs to RUN A"]);
});

test("a stop between two contract calls is honoured before the next call starts", async (t) => {
  const { establishContract } = await import("../features/workOrder/translation.mjs");
  const { createFakeAdapter } = await import("../service/agentCli/fakeAdapter.mjs");
  const { readIoEvents } = await import("../service/records/ioEvents.mjs");
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-contract-stop-"));
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  const paths = getBridgePaths(repoRoot, bridgeRoot, { privateRootName: ".review-bridge" });
  const steps = { translate: { role: "writer", provider: "claude", model: "opus" }, check: { role: "reviewer", provider: "codex" }, max_attempts: 2, call_timeout: 60_000 };
  const limits = { tokens_per_call: 10_000_000, tokens: 10_000_000 };
  let calls = 0;
  // Not stopped before the translation; stopped by the time the check would start.
  const isStopped = async () => (calls++ > 0);
  const result = await establishContract({
    paths, runId: "run-stop-between-calls", workPackage: { ...workPackage, test: GATE, contract_steps: steps },
    adapter: createFakeAdapter(bridgeRoot, "PASS"), limits, effort: "low", translateEffort: "low", executionMode: "fake_cli", isStopped, onSpawn: async () => {},
  });
  assert.equal(result.status, "stopped");
  const events = await readIoEvents(paths, "run-stop-between-calls");
  assert.deepEqual(events.filter((event) => event.event === "usage").map((event) => event.role), ["translator"]);
  assert.equal(events.some((event) => event.event === "contract.check"), false);
});

// Codex review 2026-10-18, round 3: a stop that lands after the check before a call but before
// the call has recorded its pid. The call must find the stop once it has its pid and kill itself.
test("a stop between the pre-call check and the pid record kills the call that just started", { timeout: 30_000 }, async (t) => {
  const { establishContract } = await import("../features/workOrder/translation.mjs");
  const { createFakeAdapter } = await import("../service/agentCli/fakeAdapter.mjs");
  const { readIoEvents } = await import("../service/records/ioEvents.mjs");
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-contract-race-"));
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  const previous = process.env.FAKE_CONTRACT_SLEEP_MS;
  process.env.FAKE_CONTRACT_SLEEP_MS = "20000";
  t.after(() => { if (previous === undefined) delete process.env.FAKE_CONTRACT_SLEEP_MS; else process.env.FAKE_CONTRACT_SLEEP_MS = previous; });
  const paths = getBridgePaths(repoRoot, bridgeRoot, { privateRootName: ".review-bridge" });
  const steps = { translate: { role: "writer", provider: "claude", model: "opus" }, check: { role: "reviewer", provider: "codex" }, max_attempts: 2, call_timeout: 60_000 };
  const seen = [];
  // Running at the check before the call; stopped by the time the call has its pid.
  const isStopped = async () => seen.push("status") > 1;
  const recorded = [];
  const startedAt = Date.now();
  const result = await establishContract({
    paths, runId: "run-stop-race-0001", workPackage: { ...workPackage, test: GATE, contract_steps: steps },
    adapter: createFakeAdapter(bridgeRoot, "PASS"), limits: { tokens_per_call: 1e7, tokens: 1e7 }, effort: "low", translateEffort: "low",
    executionMode: "fake_cli", isStopped, onSpawn: async (pid, role) => { recorded.push(role); },
  });
  assert.equal(result.status, "stopped");
  // The 20-second translation was killed, not waited for, and no check call followed.
  assert.ok(Date.now() - startedAt < 15_000, "the started call was not killed");
  assert.deepEqual(recorded, ["translator"]);
  const events = await readIoEvents(paths, "run-stop-race-0001");
  assert.deepEqual(events.filter((event) => event.event === "usage").map((event) => [event.role, event.partial === true]), [["translator", true]]);
  assert.equal(events.some((event) => event.event === "contract.check"), false);
});

// The walks below used to call themselves; the expected values were recorded from that version,
// so the stack-based walks are held to the same output, character for character.
test("a nested value has the same canonical form and hash as before the walk used a stack", () => {
  const nested = { zeta: [{ b: 2, a: { y: [3, { d: null, c: "é" }], x: true } }, "s"], alpha: { 10: 1, 2: 2, beta: { gamma: { delta: [] } } }, "": 0 };
  assert.equal(JSON.stringify(canonical(nested)), "{\"\":0,\"alpha\":{\"2\":2,\"10\":1,\"beta\":{\"gamma\":{\"delta\":[]}}},\"zeta\":[{\"a\":{\"x\":true,\"y\":[3,{\"c\":\"é\",\"d\":null}]},\"b\":2},\"s\"]}");
  assert.equal(digest(nested), "02519f8dccbcf7ae92c12a39b9403f5525a77586986fc3a7ce3c44b9895ca0b8");
});

test("line references are checked in document order, however deep they sit", async () => {
  const pastEnd = await check(translation({
    ticket: { ...translation().ticket, title: at(1, 90) },
    scope_notes: { include: at(4, 91), exclude: null, must_keep: null, expected_locations: null },
    run_plan: { runs: [run("RUN A", 2, 94), run("RUN B", 4, 95)] },
    acceptance: translation().acceptance.map((item, index) => (index === 1 ? { ...item, source_refs: [{ start: 7, end: 7 }, { start: 8, end: 92 }] } : item)),
    references: [at(3), at(5, 93)],
    unused_lines: [{ start: 3, end: 96 }],
  }));
  assert.deepEqual(pastEnd.problems, [
    "$.ticket.title.source_refs[0]: line 90 is past the last line 8",
    "$.scope_notes.include.source_refs[0]: line 91 is past the last line 8",
    "$.run_plan.runs[0].source_refs[0]: line 94 is past the last line 8",
    "$.run_plan.runs[1].source_refs[0]: line 95 is past the last line 8",
    "$.acceptance[1].source_refs[1]: line 92 is past the last line 8",
    "$.references[1].source_refs[0]: line 93 is past the last line 8",
    "$.unused_lines[0]: line 96 is past the last line 8",
  ]);
});

test("dependency cycles are found in the same order as before the walk used a stack", async () => {
  const lines = ["### RUN A: after RUN B", "### RUN B: after RUN C", "### RUN C: after RUN A and RUN D", "### RUN D: after RUN D", "### RUN E: after RUN A", "- all runs"];
  const looped = await checkTranslation(translation({
    requested_work: null,
    run_plan: { runs: [run("RUN A", 1, 1, ["RUN B"], "after RUN B"), run("RUN B", 2, 2, ["RUN C"], "after RUN C"), run("RUN C", 3, 3, ["RUN A", "RUN D"], "after RUN A and RUN D"), run("RUN D", 4, 4, ["RUN D"], "after RUN D"), run("RUN E", 5, 5, ["RUN A"], "after RUN A")] },
    acceptance: [criterion("AC1", "All runs work.", "all runs", 6, undefined, ["RUN A"])],
    unused_lines: [],
  }), { lines, test: GATE });
  assert.deepEqual(looped.problems, [
    "$.run_plan: dependency cycle RUN A -> RUN B -> RUN C -> RUN A",
    "$.run_plan: dependency cycle RUN D -> RUN D",
  ]);
});

test("a contract built from nested parts is the same text as before the copy used a stack", () => {
  const contract = buildContract({ workPackage, lines: LINES, translator, checker, translation: translation({
    scope_notes: { include: at(4), exclude: null, must_keep: at(7, 8), expected_locations: null },
    references: [at(3), { source_refs: [{ start: 7, end: 7 }, { start: 8, end: 8 }] }],
  }) });
  assert.equal(JSON.stringify(contract), "{\"schema\":\"review-bridge.contract\",\"schema_version\":1,\"work_package_id\":\"farm-1\",\"source\":{\"path\":\".review-bridge/work-packages/farm.md\",\"sha256\":\"dcd82ed2d1b7ddea9a5475608bfb2c2ccbc531d19d5f30c6b489925eb5a89b8a\",\"lines\":[\"# Work order: farm\",\"\",\"## Work\",\"Build a small farm.\",\"\",\"## Acceptance\",\"1. Trees and a barn show; the cart drives with the arrow keys.\",\"2. The cart stops at the barn.\"]},\"translated_by\":{\"role\":\"writer\",\"provider\":\"claude\",\"model\":\"opus\",\"attempt\":1},\"checked_by\":{\"role\":\"reviewer\",\"provider\":\"codex\"},\"ticket\":{\"title\":{\"text\":\"# Work order: farm\",\"source_refs\":[{\"start\":1,\"end\":1}]},\"type\":null,\"source_id\":null,\"product_version\":null,\"people\":null,\"schedule\":null,\"related\":null},\"context\":null,\"outcome\":null,\"requested_work\":{\"text\":\"Build a small farm.\",\"source_refs\":[{\"start\":4,\"end\":4}]},\"scope_notes\":{\"include\":{\"text\":\"Build a small farm.\",\"source_refs\":[{\"start\":4,\"end\":4}]},\"exclude\":null,\"must_keep\":{\"text\":\"1. Trees and a barn show; the cart drives with the arrow keys.\\n2. The cart stops at the barn.\",\"source_refs\":[{\"start\":7,\"end\":8}]},\"expected_locations\":null},\"acceptance\":[{\"id\":\"AC1\",\"statement\":\"Trees and a barn are shown.\",\"quote\":\"Trees and a barn show\",\"source_refs\":[{\"start\":7,\"end\":7}],\"verify\":[{\"kind\":\"reviewer\",\"check\":\"the screen shows trees and a barn\"}],\"run_refs\":[]},{\"id\":\"AC2\",\"statement\":\"The cart drives with the arrow keys.\",\"quote\":\"the cart drives with the arrow keys\",\"source_refs\":[{\"start\":7,\"end\":7}],\"verify\":[{\"kind\":\"test\",\"check\":null}],\"run_refs\":[]},{\"id\":\"AC3\",\"statement\":\"The cart stops at the barn.\",\"quote\":\"The cart stops at the barn.\",\"source_refs\":[{\"start\":8,\"end\":8}],\"verify\":[{\"kind\":\"test\",\"check\":null}],\"run_refs\":[]}],\"verification_hints\":[],\"reproduction\":null,\"references\":[{\"text\":\"## Work\",\"source_refs\":[{\"start\":3,\"end\":3}]},{\"text\":\"1. Trees and a barn show; the cart drives with the arrow keys.\\n2. The cart stops at the barn.\",\"source_refs\":[{\"start\":7,\"end\":7},{\"start\":8,\"end\":8}]}],\"open_questions\":[],\"run_plan\":null,\"unused_lines\":[{\"text\":\"## Work\",\"source_refs\":[{\"start\":3,\"end\":3}]},{\"text\":\"## Acceptance\",\"source_refs\":[{\"start\":6,\"end\":6}]}]}");
});
