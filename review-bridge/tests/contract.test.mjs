// Keeps the person's database out of these tests (see the fixture).
import "./fixtures/isolatedDataHome.mjs";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildContract, ContractChangedError, contractPath, loadContract, missingFields, sealContract } from "../features/workOrder/contract.mjs";
import { createTranslator } from "../features/workOrder/i18n.mjs";
import { formLines, writeBackBlocks } from "../features/workOrder/workOrderForm.mjs";
import { conditionsOf, formProblems, parseWorkOrder } from "../features/workOrder/workOrderFormat.mjs";
import { canonical, digest } from "../utils/digest.mjs";
import { getBridgePaths } from "../utils/paths.mjs";

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.resolve(bridgeRoot, "..");

// The project's id names its state and logs (RC3-FIX-02); a project built by hand gets one.
async function withProjectId(paths) {
  await fsp.mkdir(paths.privateRoot, { recursive: true });
  await fsp.writeFile(paths.bridgeConfigPath, JSON.stringify({ schema_version: 4, project_id: randomUUID() }));
}

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
  "   It does not drive through it.",                                // 19
].join("\n");
const format = parseWorkOrder(TEXT);
const workPackage = { work_package_id: "farm-1", task: TEXT, task_file: ".review-bridge/work-packages/farm.md" };
const build = (from = format) => buildContract({ workPackage, format: from });

test("Bridge fills every field from its block, as written; headings and markers go nowhere, text outside the blocks is unused", () => {
  const contract = build();
  assert.deepEqual(contract.requested_work, { text: "Build a small farm.\n\nKeep it green.", source_refs: [{ start: 7, end: 9 }] });
  assert.deepEqual(contract.scope_notes, { include: null, exclude: { text: "- Payment work.", source_refs: [{ start: 13, end: 13 }] }, must_keep: null, expected_locations: null });
  assert.deepEqual(contract.ticket, { title: { text: "Work order: farm", source_refs: [{ start: 1, end: 1 }] }, source_id: null, priority: null, effort: null, budget: null });
  assert.deepEqual(contract.unused_lines, [{ text: "A note before any block.", source_refs: [{ start: 3, end: 3 }] }]);
  assert.deepEqual([contract.context, contract.run_plan, contract.reproduction, contract.verification_hints, contract.references], [null, null, null, [], []]);
  assert.equal(contract.schema_version, 4);
  // No model made it, so nothing names one.
  for (const key of ["translated_by", "checked_by", "clarifications", "assumptions", "open_questions"]) assert.equal(key in contract, false, key);
});

test("the acceptance list is cut into conditions the way Markdown cuts a list: one per item, the lines under it included", () => {
  assert.deepEqual(build().acceptance, [
    { id: "AC1", statement: "Trees and a barn show; the cart drives with the arrow keys.", source_refs: [{ start: 17, end: 17 }], run_refs: [] },
    { id: "AC2", statement: "The cart stops at the barn.\nIt does not drive through it.", source_refs: [{ start: 18, end: 19 }], run_refs: [] },
  ]);
  const nested = parseWorkOrder([
    "<!-- bridge:requested_work -->", "Build it.", "",
    "<!-- bridge:acceptance -->", "## Done when", "- The page loads.", "  - on a phone", "  - on a laptop", "", "* The menu opens.", "+ The footer shows.",
  ].join("\n"));
  assert.deepEqual(conditionsOf(nested).conditions.map((condition) => [condition.statement, condition.source_refs]), [
    ["The page loads.\n- on a phone\n- on a laptop", [{ start: 6, end: 8 }]],
    ["The menu opens.", [{ start: 10, end: 10 }]],
    ["The footer shows.", [{ start: 11, end: 11 }]],
  ]);
  assert.equal(formProblems(nested).ok, true);
});

test("a run's own list, indented under - acceptance:, is cut the same way and belongs to that run", () => {
  const planned = parseWorkOrder([
    "<!-- bridge:run_plan -->",
    "### Barn", "Build the barn.", "- acceptance:", "    - The barn stands.", "    - It has a door.",
    "### Cart", "Build the cart.", "- acceptance:", "    1. The cart drives.",
  ].join("\n"));
  const problems = formProblems(planned);
  assert.equal(problems.ok, true, JSON.stringify(problems));
  assert.deepEqual(buildContract({ workPackage, format: planned }).acceptance.map((item) => [item.id, item.statement, item.run_refs]), [
    ["AC1", "The barn stands.", ["Barn"]], ["AC2", "It has a door.", ["Barn"]], ["AC3", "The cart drives.", ["Cart"]],
  ]);
});

test("what a work order must say: what to do and an acceptance list; a missing one is named, and a deleted marker is one Bridge writes back", () => {
  const oneSentence = formProblems(parseWorkOrder("Make the farm page greener."));
  assert.deepEqual([oneSentence.ok, oneSentence.missing, oneSentence.unmarked], [false, ["requested_work", "acceptance"], ["requested_work", "acceptance"]]);
  const emptyList = formProblems(parseWorkOrder("<!-- bridge:requested_work -->\nBuild it.\n\n<!-- bridge:acceptance -->\n## Acceptance\n"));
  assert.deepEqual([emptyList.missing, emptyList.unmarked], [["acceptance"], []], "the marker is there: nothing to write back, only to fill in");
  const noWork = formProblems(parseWorkOrder("<!-- bridge:acceptance -->\n- It works."));
  assert.deepEqual(noWork.missing, ["requested_work"]);
  const question = formProblems(parseWorkOrder("<!-- bridge:requested_work -->\nBuild it.\n<!-- bridge:acceptance -->\n- It works.\n<!-- bridge:open_questions -->\nWhich colour?"));
  assert.deepEqual([question.ok, question.questions], [false, [{ line: 6, question: "Which colour?" }]]);
});

test("\"一、\" and \"（1）\" are no list markers: those lines are loose, and the refusal tells how to write a list", async () => {
  const chinese = parseWorkOrder(["<!-- bridge:requested_work -->", "做一個農場頁。", "", "<!-- bridge:acceptance -->", "## 驗收", "一、樹和穀倉出現", "（1）車子用方向鍵開"].join("\n"));
  const problems = formProblems(chinese);
  assert.deepEqual([problems.ok, problems.missing, problems.loose], [false, [], [6, 7]]);
  const t = await createTranslator("zh-TW");
  const said = formLines(t, problems, { file: "work-packages/farm.md", again: "review-bridge start work-packages/farm.md" }).join("\n");
  assert.match(said, /第 6 行不是驗收清單的一條：每條用「- 」開頭/);
  assert.match(said, /補好後再執行：review-bridge start work-packages\/farm\.md/);
});

test("the templates init gives are work orders that can start as they are", async () => {
  for (const name of ["work-package.md", "work-package.zh-TW.md"]) {
    const text = await fsp.readFile(path.join(packageRoot, "project-templates", name), "utf8");
    const problems = formProblems(parseWorkOrder(text.trim()));
    assert.equal(problems.ok, true, name + ": " + JSON.stringify(problems));
    assert.equal(conditionsOf(parseWorkOrder(text.trim())).conditions.length, 2, name);
  }
});

test("a deleted required block comes back as its marker and heading at the end of the file; nothing before it changes", async (t) => {
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-form-"));
  t.after(() => fsp.rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, "farm.md");
  const before = "# 農場\r\n\r\n<!-- bridge:requested_work -->\r\n做一個農場頁。";
  await fsp.writeFile(file, before);
  const translator = await createTranslator("zh-TW");
  const form = formProblems(parseWorkOrder(before));
  assert.deepEqual(await writeBackBlocks(translator, file, form.unmarked), ["acceptance"]);
  const after = await fsp.readFile(file, "utf8");
  assert.equal(after.slice(0, before.length), before);
  assert.equal(after.slice(before.length), "\r\n\r\n<!-- bridge:acceptance -->\r\n## 驗收\r\n");
  // Still empty, so still refused, with nothing more written back.
  assert.deepEqual(formProblems(parseWorkOrder(after)).unmarked, []);
  await fsp.appendFile(file, "- 樹和穀倉出現\r\n");
  assert.equal(formProblems(parseWorkOrder(await fsp.readFile(file, "utf8"))).ok, true);
});

test("the writer's lock: a contract without what to do or without a condition is not taken, whoever made it", () => {
  const contract = build();
  assert.deepEqual(missingFields(contract), []);
  assert.deepEqual(missingFields({ ...contract, acceptance: [] }), ["acceptance"]);
  assert.deepEqual(missingFields({ ...contract, requested_work: null }), ["requested_work"]);
  assert.deepEqual(missingFields({ ...contract, requested_work: null, run_plan: { runs: [{ name: "Barn" }] } }), []);
});

test("a sealed contract matches its schema, is stored once under its hash, and any change is caught on the next read", async (t) => {
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-contract-"));
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  const paths = getBridgePaths(repoRoot, bridgeRoot, { privateRootName: ".review-bridge" });
  await withProjectId(paths);
  const contract = build();
  const sealed = await sealContract(paths, contract);
  assert.equal(sealed.sha256, digest(contract));
  assert.equal(sealed.contract.source.lines[16], format.lines[16]);
  assert.deepEqual(await loadContract(paths, sealed.sha256), contract);
  assert.equal((await sealContract(paths, contract)).sha256, sealed.sha256);
  // The same text is the same contract: cutting it again costs nothing and changes nothing.
  assert.equal(digest(build(parseWorkOrder(TEXT))), sealed.sha256);
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
  await withProjectId(paths);
  const old = { ...build(), schema_version: 3 };
  await fsp.mkdir(paths.contractsDir, { recursive: true });
  await fsp.writeFile(contractPath(paths, digest(old)), JSON.stringify(old));
  await assert.rejects(loadContract(paths, digest(old)), (error) => error instanceof ContractChangedError && /made by an older Bridge and is not read again; run: npx review-bridge clean/.test(error.message));
});

// The canonical walk used to call itself; the expected values were recorded from that version, so
// the stack-based walk is held to the same output, character for character.
test("a nested value has the same canonical form and hash as before the walk used a stack", () => {
  const nested = { zeta: [{ b: 2, a: { y: [3, { d: null, c: "é" }], x: true } }, "s"], alpha: { 10: 1, 2: 2, beta: { gamma: { delta: [] } } }, "": 0 };
  assert.equal(JSON.stringify(canonical(nested)), "{\"\":0,\"alpha\":{\"2\":2,\"10\":1,\"beta\":{\"gamma\":{\"delta\":[]}}},\"zeta\":[{\"a\":{\"x\":true,\"y\":[3,{\"c\":\"é\",\"d\":null}]},\"b\":2},\"s\"]}");
  assert.equal(digest(nested), "02519f8dccbcf7ae92c12a39b9403f5525a77586986fc3a7ce3c44b9895ca0b8");
});
