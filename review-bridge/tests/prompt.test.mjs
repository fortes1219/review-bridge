// Keeps the person's database out of these tests (see the fixture).
import "./fixtures/isolatedDataHome.mjs";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getBridgePaths } from "../utils/paths.mjs";
import {
  buildHandoff,
  buildReadList,
  buildTaskInput,
  composeWriterPrompt,
  isInReadList,
  MAX_HANDOFF_CHARS,
  parseClaudeStream,
  ReferenceChangedError,
  partialUsageFromStream,
  usageFromResult,
  verifyAndLoadReferences,
} from "../features/workOrder/writerPrompt.mjs";

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createHash } = await import("node:crypto");
const sha = (text) => createHash("sha256").update(text).digest("hex");

async function workspace(t) {
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-prompt-"));
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  await fsp.mkdir(path.join(repoRoot, "src", "game"), { recursive: true });
  await fsp.writeFile(path.join(repoRoot, "src", "game", "farm.js"), "// farm\n");
  await fsp.writeFile(path.join(repoRoot, "src", "game", "big.js"), "x".repeat(70 * 1024));
  return { repoRoot, paths: getBridgePaths(repoRoot, bridgeRoot, { privateRootName: ".review-bridge" }) };
}

function workPackage() {
  return {
    work_package_id: "farm-1",
    task: "# 牧場\n做一個牧場",
    task_file: ".review-bridge/work-packages/farm.md",
    breakpoint: "return after review",
    scope: { allowed_paths: ["src/game"], forbidden_paths: [".git/**", ".env"] },
    rules: { path: ".review-bridge/review-bridge/rules.md", sha256: "0".repeat(64), text: "# 規則\n不 commit。" },
    references: [{ path: "src/game", files: [
      { path: "src/game/farm.js", sha256: sha("// farm\n"), bytes: 8 },
      { path: "src/game/big.js", sha256: sha("x".repeat(70 * 1024)), bytes: 70 * 1024 },
    ] }],
  };
}

// The sealed contract as the writer loop hands it on: the hash and the whole object.
const contract = {
  sha256: "c".repeat(64),
  contract: {
    schema: "review-bridge.contract",
    acceptance: [
      { id: "AC1", statement: "看得到牧場", source_refs: [{ start: 2, end: 2 }], verify: [{ kind: "reviewer", check: "畫面" }], run_refs: [] },
      { id: "AC2", statement: "農車會動", source_refs: [{ start: 2, end: 2 }], verify: [{ kind: "test", check: null }], run_refs: [] },
    ],
  },
};

test("P1 the prompt is composed only from the sealed package: header, rules, task.input, injected files; no go-read", async (t) => {
  const { paths } = await workspace(t);
  const pkg = workPackage();
  const references = await verifyAndLoadReferences(paths, pkg);
  assert.equal(references.length, 2);
  assert.equal(references[0].text, "// farm\n");
  assert.equal(references[1].text, null); // over 64 KiB: path and size only
  const readList = buildReadList({ references });
  const taskInput = buildTaskInput({ workPackage: pkg, call: 1, readList, limits: { max_turns: 20, max_output_chars: 4000 }, contract });
  const prompt = composeWriterPrompt({ workPackage: pkg, control: { breakpoint: "return after review" }, runId: "run-1", call: 1, taskInput, references, rulesText: pkg.rules.text, contract });
  const lines = prompt.split("\n");
  assert.equal(lines[0], "[REVIEW_BRIDGE_MODE: WRITER_ONLY]");
  // Sub-agents may implement; the policy's one local consistency pass stays, and it is not a review.
  assert.match(prompt, /hand separate parts of this work to sub-agents in parallel/);
  assert.match(prompt, /one bounded local consistency pass/);
  assert.match(prompt, /That pass is not a review/);
  assert.match(prompt, /Do not stage, commit, push, deploy or release\./);
  assert.ok(prompt.indexOf("=== RULES") < prompt.indexOf("=== TASK"));
  assert.ok(prompt.indexOf("=== TASK") < prompt.indexOf("=== src/game/farm.js (" + sha("// farm\n").slice(0, 12) + ") ==="));
  assert.match(prompt, /不 commit。/);
  // The writer gets the whole contract and its hash, and is told the contract is read-only.
  assert.equal(taskInput.contract_sha256, contract.sha256);
  assert.deepEqual(taskInput.contract, contract.contract);
  assert.equal(taskInput.work, undefined);
  assert.match(prompt, /"statement": "看得到牧場"/);
  assert.match(prompt, new RegExp("Contract: " + contract.sha256 + "\\. .*read-only"));
  assert.match(prompt, /Answer with this contract_sha256/);
  // Without a contract (the legacy inline task) the writer gets the task text instead.
  const inline = buildTaskInput({ workPackage: { ...pkg, task_file: undefined }, call: 1, readList: [], limits: { max_turns: 20, max_output_chars: 4000 } });
  assert.equal(inline.work, pkg.task);
  assert.equal(inline.contract, undefined);
  assert.match(prompt, /"max_turns": 20/);
  assert.match(prompt, /71680 bytes, 1 lines; too large to inline/);
  assert.doesNotMatch(prompt, /Read first|Read only the task|go read|請先讀/i);
  assert.doesNotMatch(prompt, /CODEX_REVIEW_REQUIRED/);
  assert.match(prompt, /one writer\.result object/);
  assert.equal(taskInput.output_schema, "writer.result");
  assert.equal(taskInput.read_list.length, 2);
  assert.equal(isInReadList("src/game/farm.js", readList), true);
  assert.equal(isInReadList("package.json", readList), false);
});

test("P2 a sealed file that changed after approval is refused before any model call", async (t) => {
  const { repoRoot, paths } = await workspace(t);
  await fsp.writeFile(path.join(repoRoot, "src", "game", "farm.js"), "// changed\n");
  await assert.rejects(verifyAndLoadReferences(paths, workPackage()), (error) => {
    assert.ok(error instanceof ReferenceChangedError);
    assert.equal(error.path, "src/game/farm.js");
    assert.match(error.message, /批准後 src\/game\/farm\.js 變了/);
    return true;
  });
  await fsp.rm(path.join(repoRoot, "src", "game", "farm.js"));
  await assert.rejects(verifyAndLoadReferences(paths, workPackage()), ReferenceChangedError);
});

test("P3 the handoff is built from records, carries typed findings sorted by severity, and stays under 4,000 chars", () => {
  const pkg = workPackage();
  const finding = (id, severity, filePath, line) => ({
    id, severity, path: filePath, line, reach: "r".repeat(100), claim: "c".repeat(100), evidence: "e".repeat(100), fix: "f".repeat(100), acceptance_ref: 1, extra: "dropped",
  });
  const openFindings = [
    finding("F1", "LOW", "service.mjs", 48), finding("F2", "HIGH", "src/game/farm.js", 12), finding("F3", "MEDIUM", "src/game/farm.js", 40),
    ...Array.from({ length: 12 }, (_, index) => finding("F" + (index + 4), "LOW", "src/game/x.js", index + 1)),
  ];
  const ioEvents = [
    ...Array.from({ length: 14 }, (_, index) => ({ event: "usage", role: "writer", call: index + 1, turns: 5, tokens: { cache_read: 1000 * index } })),
    { event: "review.result", call: 1, gate: "FAIL", findings: openFindings },
  ];
  const changed = Array.from({ length: 300 }, (_, index) => ({ path: "src/game/file-" + index + ".js", change: "modified" }));
  const readList = buildReadList({ references: [{ path: "src/game/farm.js" }], findings: openFindings.slice(0, 3) });
  const handoff = buildHandoff({ workPackage: pkg, call: 2, reason: "correction", ioEvents, openFindings, lastGate: "FAIL", changedFiles: changed, readList, contract });
  assert.equal(handoff.event, "handoff");
  assert.equal(handoff.from.calls_used, 1);
  // The contract itself rides in task.input; the handoff names which one.
  assert.equal(handoff.contract_sha256, contract.sha256);
  assert.equal(handoff.work, undefined);
  assert.ok(handoff.progress.length <= 10);
  assert.equal(handoff.progress.at(-1), "上次審查：FAIL");
  assert.ok(handoff.progress.includes("第 1 次審查：FAIL，15 條 findings"));
  // Severity order, typed fields only, LOW trimmed first; HIGH and MEDIUM survive the cut.
  assert.deepEqual(handoff.open_findings.slice(0, 2).map((entry) => entry.id), ["F2", "F3"]);
  assert.equal(handoff.open_findings[0].extra, undefined);
  assert.ok(handoff.open_findings.length < openFindings.length);
  assert.ok(handoff.open_findings.every((entry) => entry.severity !== "LOW" || handoff.open_findings.length > 2));
  assert.ok(JSON.stringify(handoff).length <= MAX_HANDOFF_CHARS);
  assert.match(handoff.next, /writer\.result/);
  const findingEntry = readList.find((entry) => entry.why === "F2");
  assert.deepEqual(findingEntry.lines, [1, 32]);
  assert.deepEqual(readList.find((entry) => entry.why === "F1").lines, [28, 68]);
});

test("P4a stream-json is parsed line by line; a single JSON object is accepted as the result", () => {
  const stream = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "src/game/farm.js" } }] } }),
    "garbage line",
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "thinking" }, { type: "tool_use", name: "Grep", input: { pattern: "farm", path: "src" } }] } }),
    JSON.stringify({ type: "result", subtype: "success", session_id: "s", num_turns: 4, usage: { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 }, modelUsage: { "m": { inputTokens: 1, cacheReadInputTokens: 2, cacheCreationInputTokens: 3, outputTokens: 4 } }, total_cost_usd: 0.1, result: "ok" }),
  ].join("\n");
  const parsed = parseClaudeStream(stream);
  assert.equal(parsed.unparsable_lines, 1);
  assert.deepEqual(parsed.reads, [{ tool: "Read", path: "src/game/farm.js" }, { tool: "Grep", pattern: "farm", path: "src" }]);
  assert.equal(parsed.result.num_turns, 4);
  const usage = usageFromResult(parsed.result, { call: 1, durationMs: 50 });
  assert.deepEqual(usage.tokens, { input: 1, cache_write: 3, cache_read: 2, output: 4 });
  assert.equal(usage.source, "cli_model_usage");
  const legacy = parseClaudeStream(JSON.stringify({ session_id: "s", is_error: false, result: "r" }));
  assert.equal(legacy.result.result, "r");
  assert.deepEqual(legacy.reads, []);
  assert.equal(parseClaudeStream("not json at all").result, null);
});

// The final result of a real CLI 2.1.280 call (2026-10-17) whose main model started one
// sub-agent: `usage` (17,993) is only the last turn; `modelUsage` (64,242) is the whole call.
test("P4c writer usage is the final result's modelUsage, which includes sub-agents; usage alone is the last turn", () => {
  const measured = {
    type: "result", num_turns: 1, total_cost_usd: 0.05518155,
    usage: { input_tokens: 10, cache_creation_input_tokens: 408, cache_read_input_tokens: 17528, output_tokens: 47 },
    modelUsage: { "claude-haiku-4-5-20251001": { inputTokens: 980, cacheCreationInputTokens: 28229, cacheReadInputTokens: 34633, outputTokens: 400 } },
  };
  const usage = usageFromResult(measured, { call: 1, durationMs: 1 });
  assert.deepEqual(usage.tokens, { input: 980, cache_write: 28229, cache_read: 34633, output: 400 });
  assert.equal(Object.values(usage.tokens).reduce((a, b) => a + b, 0), 64242);
  assert.deepEqual(usage.models, ["claude-haiku-4-5-20251001"]);
  assert.equal(usage.parse_error, undefined);
  // Two models in one call are added together.
  const two = usageFromResult({ modelUsage: {
    a: { inputTokens: 1, cacheCreationInputTokens: 2, cacheReadInputTokens: 3, outputTokens: 4 },
    b: { inputTokens: 10, cacheCreationInputTokens: 20, cacheReadInputTokens: 30, outputTokens: 40 },
  } }, { call: 1, durationMs: 1 });
  assert.deepEqual(two.tokens, { input: 11, cache_write: 22, cache_read: 33, output: 44 });
});

test("P4d a call with no final result keeps the stream's per-message usage as a partial record", () => {
  const message = (id, usage, parent = null) => JSON.stringify({ type: "assistant", ...(parent ? { parent_tool_use_id: parent } : {}), message: { id, usage, content: [] } });
  const stream = [
    message("m1", { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 }),
    // The CLI repeats a message once per content block; it counts once.
    message("m1", { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 }),
    message("s1", { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 }, "toolu_1"),
  ].join("\n");
  const parsed = parseClaudeStream(stream);
  assert.equal(parsed.result, null);
  assert.deepEqual(parsed.streamUsage, { messages: 2, subagent_messages: 1, tokens: { input: 11, cache_write: 2, cache_read: 3, output: 9 } });
  const partial = partialUsageFromStream(parsed.streamUsage, { call: 2, durationMs: 5 });
  assert.equal(partial.partial, true);
  assert.equal(partial.parse_error, true);
  assert.deepEqual(partial.missing, ["final_result"]);
  assert.deepEqual(partial.tokens, { input: 11, cache_write: 2, cache_read: 3, output: 9 });
});
