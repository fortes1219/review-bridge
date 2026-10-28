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
  checkTranslation,
  CHECK_MODE_HEADER,
  composeCheckPrompt,
  composeTranslationPrompt,
  CONTRACT_MODE_HEADER,
  ContractChangedError,
  contractPath,
  decideCheck,
  loadContract,
  sealContract,
  workOrderQuestions,
} from "../features/workOrder/contract.mjs";
import { parseWorkOrder } from "../features/workOrder/workOrderFormat.mjs";
import { canonical, digest } from "../utils/digest.mjs";
import { getBridgePaths } from "../utils/paths.mjs";

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE = { kind: "command", command: "npm test" };
const NO_GATE = { kind: "not_configured", command: null };

const TEXT = [
  "# Work order: farm",                                              // 1
  "",                                                                // 2
  "A note before any block.",                                        // 3
  "",                                                                // 4
  "<!-- bridge:requested_work -->",                                  // 5
  "## Work",                                                         // 6
  "Build a small farm.",                                             // 7
  "",                                                                // 8
  "Keep it green.",                                                  // 9
  "",                                                                // 10
  "<!-- bridge:scope_notes.exclude -->",                             // 11
  "## Not this time",                                                // 12
  "- Payment work.",                                                 // 13
  "",                                                                // 14
  "<!-- bridge:acceptance -->",                                      // 15
  "## Acceptance",                                                   // 16
  "1. Trees and a barn show; the cart drives with the arrow keys.",  // 17
  "2. The cart stops at the barn.",                                  // 18
].join("\n");
const format = parseWorkOrder(TEXT);
const { lines } = format;

const criterion = (id, statement, quote, line, verify = [{ kind: "test", check: null }]) => ({
  id, statement, quote, source_refs: [{ start: line, end: line }], verify,
});
function translation(acceptance = [
  criterion("AC1", "Trees and a barn are shown.", "Trees and a barn show", 17, [{ kind: "reviewer", check: "the screen shows trees and a barn" }]),
  criterion("AC2", "The cart drives with the arrow keys.", "the cart drives with the arrow keys", 17),
  criterion("AC3", "The cart stops at the barn.", "The cart stops at the barn.", 18),
]) {
  return { event: "contract.translation", acceptance };
}

const check = (value, rule = GATE) => checkTranslation(value, { lines, format, test: rule });
const workPackage = { work_package_id: "farm-1", task: TEXT, task_file: ".review-bridge/work-packages/farm.md" };
const translator = { role: "writer", provider: "claude", model: "opus", attempt: 1 };
const checker = { role: "reviewer", provider: "codex" };
const build = (value = translation()) => buildContract({ workPackage, lines, format, translation: value, translator, checker });

test("Bridge fills every field from its block, as written; headings and markers go nowhere, text outside the blocks is unused", () => {
  const contract = build();
  assert.deepEqual(contract.requested_work, { text: "Build a small farm.\n\nKeep it green.", source_refs: [{ start: 7, end: 9 }] });
  assert.deepEqual(contract.scope_notes, { include: null, exclude: { text: "- Payment work.", source_refs: [{ start: 13, end: 13 }] }, must_keep: null, expected_locations: null });
  assert.deepEqual(contract.ticket, { title: { text: "Work order: farm", source_refs: [{ start: 1, end: 1 }] }, source_id: null, priority: null, effort: null, budget: null });
  assert.deepEqual(contract.unused_lines, [{ text: "A note before any block.", source_refs: [{ start: 3, end: 3 }] }]);
  assert.deepEqual([contract.context, contract.run_plan, contract.reproduction, contract.verification_hints, contract.references, contract.open_questions], [null, null, null, [], [], []]);
  assert.equal(contract.schema_version, 2);
  assert.equal(contract.event, undefined);
  assert.deepEqual(contract.checked_by, checker);
});

test("one source line may give several conditions; each quotes its own lines verbatim", async () => {
  assert.deepEqual(await check(translation()), { ok: true, problems: [] });
  const items = translation().acceptance;
  const invented = await check(translation([criterion("AC1", "The farm has a pond.", "a pond", 17), ...items.slice(1).map((item, index) => ({ ...item, id: "AC" + (index + 2) }))]));
  assert.deepEqual(invented.problems, ["$.acceptance[0].quote: not found verbatim in its source lines"]);
  // Spacing differences do not matter; words do.
  const spaced = await check(translation([{ ...items[0], quote: "Trees  and a\tbarn show" }, ...items.slice(1)]));
  assert.equal(spaced.ok, true);
});

test("a condition points inside one acceptance block, and every line of that block belongs to a condition", async () => {
  const items = translation().acceptance;
  const outside = await check(translation([{ ...items[0], source_refs: [{ start: 7, end: 7 }] }, ...items.slice(1)]));
  assert.deepEqual(outside.problems, ["$.acceptance[0].source_refs: not inside one acceptance block"]);
  const pastEnd = await check(translation([...items.slice(0, 2), { ...items[2], source_refs: [{ start: 18, end: 99 }] }]));
  assert.deepEqual(pastEnd.problems, ["$.acceptance[2].source_refs: not inside one acceptance block", "line 18 belongs to no condition"]);
  const backwards = await check(translation([...items.slice(0, 2), { ...items[2], source_refs: [{ start: 18, end: 17 }] }]));
  assert.deepEqual(backwards.problems, ["$.acceptance[2].source_refs[0]: start is after end", "line 18 belongs to no condition"]);
  // A dropped condition cannot vanish: its line is left over.
  const dropped = await check(translation(items.slice(0, 2)));
  assert.deepEqual(dropped.problems, ["line 18 belongs to no condition"]);
  const skipped = await check(translation([items[0], items[1], { ...items[2], id: "AC4" }]));
  assert.deepEqual(skipped.problems, ["$.acceptance[2].id: expected AC3"]);
});

test("the translation writes conditions only: no field text, command, path, budget, role or run", async () => {
  const items = translation().acceptance;
  const command = await check(translation([{ ...items[0], verify: [{ kind: "test", check: null, command: "rm -rf /" }] }, ...items.slice(1)]));
  assert.deepEqual(command.problems, ["$.acceptance[0].verify[0]: unexpected command"]);
  const fields = await check({ ...translation(), context: { text: "invented background", source_refs: [{ start: 7, end: 7 }] }, allowed_paths: ["**"], budget: { rounds: 99 } });
  assert.deepEqual(fields.problems, ["$: unexpected context", "$: unexpected allowed_paths", "$: unexpected budget"]);
  const runs = await check(translation([{ ...items[0], run_refs: ["RUN A"] }, ...items.slice(1)]));
  assert.deepEqual(runs.problems, ["$.acceptance[0]: unexpected run_refs"]);
  const noGate = await check(translation(), NO_GATE);
  assert.deepEqual(noGate.problems, ["$.acceptance[1].verify[0]: Bridge runs no verification command for this work", "$.acceptance[2].verify[0]: Bridge runs no verification command for this work"]);
  const vague = await check(translation([{ ...items[0], verify: [{ kind: "reviewer", check: null }] }, ...items.slice(1)]));
  assert.deepEqual(vague.problems, ["$.acceptance[0].verify[0].check: say what the reviewer checks"]);
});

test("an open question or a work order with nothing to check stops before any model call", () => {
  assert.deepEqual(workOrderQuestions(format), []);
  const asked = parseWorkOrder(TEXT + "\n\n<!-- bridge:open_questions -->\n## Open questions\nWhich barn colour?\nHow many trees?");
  assert.deepEqual(workOrderQuestions(asked), ["Which barn colour?", "How many trees?"]);
  for (const none of ["無", "none", "None", ""]) {
    assert.deepEqual(workOrderQuestions(parseWorkOrder(TEXT + "\n\n<!-- bridge:open_questions -->\n## Open questions\n" + none)), [], JSON.stringify(none));
  }
  const empty = parseWorkOrder("# farm\n\n<!-- bridge:requested_work -->\nBuild it.\n\n<!-- bridge:acceptance -->\n## Acceptance\n");
  assert.deepEqual(workOrderQuestions(empty), ["The work order states no result that can be checked."]);
  assert.deepEqual(workOrderQuestions(parseWorkOrder("# farm\n\n<!-- bridge:requested_work -->\nBuild it.")), ["The work order states no result that can be checked."]);
});

test("the prompts show only the acceptance blocks with the work order's own line numbers, in the work order's language", () => {
  const prompt = composeTranslationPrompt({ workPackageId: "farm-1", lines, format, test: GATE, attempt: 2, feedback: ["AC1 does not match its lines"] });
  assert.equal(prompt.split("\n")[0], CONTRACT_MODE_HEADER);
  assert.match(prompt, /^--- acceptance ---\n17\| 1\. Trees and a barn show/m);
  assert.doesNotMatch(prompt, /Build a small farm|Payment work|A note before/);
  assert.match(prompt, /in the language the work order itself is written in/);
  assert.doesNotMatch(prompt, /BCP 47/);
  assert.match(prompt, /Attempt: 2/);
  assert.match(prompt, /- AC1 does not match its lines/);
  assert.match(composeTranslationPrompt({ workPackageId: "farm-1", lines, format, test: NO_GATE }), /Bridge runs no verification command/);
  const candidate = build();
  const checkPrompt = composeCheckPrompt({ workPackageId: "farm-1", lines, format, candidate, sha256: digest(candidate), attempt: 1 });
  assert.equal(checkPrompt.split("\n")[0], CHECK_MODE_HEADER);
  assert.match(checkPrompt, new RegExp("Candidate: " + digest(candidate)));
  assert.match(checkPrompt, /^18\| 2\. The cart stops at the barn\./m);
  assert.match(checkPrompt, /=== CANDIDATE CONDITIONS ===\n\[\n  \{\n    "id": "AC1"/);
  assert.doesNotMatch(checkPrompt, /"unused_lines"|Payment work/);
  assert.match(checkPrompt, /in the language the work order itself is written in/);
});

test("Bridge decides from every condition the reviewer judged: a mistake is redone, an ambiguity goes to the human, doubt stops", async () => {
  const candidate = build();
  const sha256 = digest(candidate);
  const answer = (overrides = {}) => ({
    event: "contract.check", candidate_sha256: sha256,
    acceptance: ["AC1", "AC2", "AC3"].map((id) => ({ id, faithful: true, note: null })),
    missing: [], ambiguities: [], cannot_confirm: false, cannot_confirm_reason: null, ...overrides,
  });
  const decide = (value) => decideCheck(value, { candidate, sha256 });
  assert.equal((await decide(answer())).decision, "pass");
  const wrong = await decide(answer({ acceptance: [{ id: "AC1", faithful: false, note: "adds a barn colour" }, { id: "AC2", faithful: true, note: null }, { id: "AC3", faithful: true, note: null }] }));
  assert.deepEqual(wrong, { decision: "retranslate", problems: [], feedback: ["AC1 does not match its lines: adds a barn colour"], questions: [] });
  const missing = await decide(answer({ missing: [{ source_refs: [{ start: 17, end: 17 }], note: "the barn itself" }] }));
  assert.deepEqual(missing.feedback, ["missing condition at lines 17-17: the barn itself"]);
  const unclear = await decide(answer({ ambiguities: [{ question: "Which page?", source_refs: [] }] }));
  assert.deepEqual(unclear, { decision: "needs_human", problems: [], feedback: [], questions: ["Which page?"] });
  assert.equal((await decide(answer({ cannot_confirm: true, cannot_confirm_reason: "design not given" }))).decision, "unconfirmed");
  // A reviewer that skips a condition, judges another hash, or answers off-schema has not confirmed anything.
  assert.deepEqual((await decide(answer({ acceptance: answer().acceptance.slice(0, 2) }))).problems, ["$.acceptance: must judge exactly AC1, AC2, AC3"]);
  assert.deepEqual((await decide(answer({ candidate_sha256: "0".repeat(64) }))).problems, ["$.candidate_sha256: expected " + sha256]);
  assert.equal((await decide(answer({ fields: [] }))).decision, "unconfirmed");
  assert.equal((await decide({ event: "contract.check", verdict: "PASS" })).decision, "unconfirmed");
});

test("a sealed contract matches its schema, is stored once under its hash, and any change is caught on the next read", async (t) => {
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-contract-"));
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  const paths = getBridgePaths(repoRoot, bridgeRoot, { privateRootName: ".review-bridge" });
  const contract = build();
  const sealed = await sealContract(paths, contract);
  assert.equal(sealed.sha256, digest(contract));
  assert.equal(sealed.contract.source.lines[16], lines[16]);
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

test("a contract an older Bridge sealed is refused by name, and the person is told to clean", async (t) => {
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-contract-old-"));
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  const paths = getBridgePaths(repoRoot, bridgeRoot, { privateRootName: ".review-bridge" });
  const old = { ...build(), schema_version: 1 };
  await fsp.mkdir(paths.contractsDir, { recursive: true });
  await fsp.writeFile(contractPath(paths, digest(old)), JSON.stringify(old));
  await assert.rejects(loadContract(paths, digest(old)), (error) => error instanceof ContractChangedError && /made by an older Bridge and is not read again; run: review-bridge clean/.test(error.message));
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

// The canonical walk used to call itself; the expected values were recorded from that version, so
// the stack-based walk is held to the same output, character for character.
test("a nested value has the same canonical form and hash as before the walk used a stack", () => {
  const nested = { zeta: [{ b: 2, a: { y: [3, { d: null, c: "é" }], x: true } }, "s"], alpha: { 10: 1, 2: 2, beta: { gamma: { delta: [] } } }, "": 0 };
  assert.equal(JSON.stringify(canonical(nested)), "{\"\":0,\"alpha\":{\"2\":2,\"10\":1,\"beta\":{\"gamma\":{\"delta\":[]}}},\"zeta\":[{\"a\":{\"x\":true,\"y\":[3,{\"c\":\"é\",\"d\":null}]},\"b\":2},\"s\"]}");
  assert.equal(digest(nested), "02519f8dccbcf7ae92c12a39b9403f5525a77586986fc3a7ce3c44b9895ca0b8");
});
