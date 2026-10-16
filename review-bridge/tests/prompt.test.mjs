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
  return { repoRoot, paths: getBridgePaths(repoRoot, bridgeRoot) };
}

function workPackage() {
  return {
    work_package_id: "farm-1",
    task: "ignored when work_order is present",
    breakpoint: "return after review",
    scope: { change_types: ["code"], allowed_paths: ["src/game"], forbidden_paths: [".git/**", ".env"] },
    work_order: { name: "牧場", work: "做一個牧場", acceptance: ["看得到牧場", "農車會動"], references: [] },
    rules: { path: ".review-bridge/review-bridge/rules.md", sha256: "0".repeat(64), text: "# 規則\n不 commit。" },
    references: [{ path: "src/game", files: [
      { path: "src/game/farm.js", sha256: sha("// farm\n"), bytes: 8 },
      { path: "src/game/big.js", sha256: sha("x".repeat(70 * 1024)), bytes: 70 * 1024 },
    ] }],
  };
}

test("P1 the prompt is composed only from the sealed package: header, rules, task.input, injected files; no go-read", async (t) => {
  const { paths } = await workspace(t);
  const pkg = workPackage();
  const references = await verifyAndLoadReferences(paths, pkg);
  assert.equal(references.length, 2);
  assert.equal(references[0].text, "// farm\n");
  assert.equal(references[1].text, null); // over 64 KiB: path and size only
  const readList = buildReadList({ references });
  const taskInput = buildTaskInput({ workPackage: pkg, call: 1, readList, limits: { max_turns: 20, max_output_chars: 4000 } });
  const prompt = composeWriterPrompt({ workPackage: pkg, control: { breakpoint: "return after review" }, runId: "run-1", call: 1, taskInput, references, rulesText: pkg.rules.text });
  const lines = prompt.split("\n");
  assert.equal(lines[0], "[REVIEW_BRIDGE_MODE: WRITER_ONLY]");
  assert.ok(prompt.indexOf("=== RULES") < prompt.indexOf("=== TASK"));
  assert.ok(prompt.indexOf("=== TASK") < prompt.indexOf("=== src/game/farm.js (" + sha("// farm\n").slice(0, 12) + ") ==="));
  assert.match(prompt, /不 commit。/);
  assert.match(prompt, /"work": "做一個牧場"/);
  assert.match(prompt, /"acceptance": \[\n\s+"看得到牧場",\n\s+"農車會動"\n\s+\]/);
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
  const handoff = buildHandoff({ workPackage: pkg, call: 2, reason: "correction", ioEvents, openFindings, lastGate: "FAIL", changedFiles: changed, readList });
  assert.equal(handoff.event, "handoff");
  assert.equal(handoff.from.calls_used, 1);
  assert.equal(handoff.work, "做一個牧場");
  assert.deepEqual(handoff.acceptance, ["看得到牧場", "農車會動"]);
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
    JSON.stringify({ type: "result", subtype: "success", session_id: "s", num_turns: 4, usage: { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 }, total_cost_usd: 0.1, result: "ok" }),
  ].join("\n");
  const parsed = parseClaudeStream(stream);
  assert.equal(parsed.unparsable_lines, 1);
  assert.deepEqual(parsed.reads, [{ tool: "Read", path: "src/game/farm.js" }, { tool: "Grep", pattern: "farm", path: "src" }]);
  assert.equal(parsed.result.num_turns, 4);
  const usage = usageFromResult(parsed.result, { call: 1, durationMs: 50 });
  assert.deepEqual(usage.tokens, { input: 1, cache_write: 3, cache_read: 2, output: 4 });
  assert.equal(usage.source, "cli_json");
  const legacy = parseClaudeStream(JSON.stringify({ session_id: "s", is_error: false, result: "r" }));
  assert.equal(legacy.result.result, "r");
  assert.deepEqual(legacy.reads, []);
  assert.equal(parseClaudeStream("not json at all").result, null);
});
