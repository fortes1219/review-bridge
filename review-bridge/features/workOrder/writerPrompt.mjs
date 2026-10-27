// Writer prompt composition (T0-04 D1/D2). Everything the model sees comes from the
// sealed work package and the run's own records. No "go read" instructions: the
// files the writer may need are verified against the plan and injected here.
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

export const WRITER_MODE_HEADER = "[REVIEW_BRIDGE_MODE: WRITER_ONLY]";
export const MAX_INJECTED_FILE_BYTES = 64 * 1024;
export const MAX_HANDOFF_CHARS = 4_000;
export const MAX_PROGRESS_LINES = 10;
export const MAX_PROGRESS_LINE_CHARS = 120;
export const MAX_NEXT_CHARS = 200;

export class ReferenceChangedError extends Error {
  constructor(relativePath) {
    super("批准後 " + relativePath + " 變了，重新建 plan");
    this.name = "ReferenceChangedError";
    this.path = relativePath;
  }
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// Every file the plan sealed, flattened: directories were already expanded at plan time.
export function sealedReferenceFiles(workPackage) {
  const files = [];
  for (const entry of workPackage?.references || []) {
    if (Array.isArray(entry.files)) for (const file of entry.files) files.push({ path: file.path, sha256: file.sha256, bytes: file.bytes });
    else if (entry.path && entry.sha256) files.push({ path: entry.path, sha256: entry.sha256, bytes: entry.bytes });
  }
  return files;
}

// D1.5: re-hash each sealed file; any difference stops the call before the model runs.
export async function verifyAndLoadReferences(paths, workPackage) {
  const loaded = [];
  for (const file of sealedReferenceFiles(workPackage)) {
    const absolute = path.resolve(paths.repoRoot, ...file.path.split("/"));
    const buffer = await fsp.readFile(absolute).catch(() => null);
    if (!buffer || sha256(buffer) !== file.sha256) throw new ReferenceChangedError(file.path);
    loaded.push({
      path: file.path,
      sha256: file.sha256,
      bytes: buffer.length,
      text: buffer.length <= MAX_INJECTED_FILE_BYTES ? buffer.toString("utf8") : null,
      lines: buffer.toString("utf8").split("\n").length,
    });
  }
  return loaded;
}

// T0-05 D4.1: the read list is built from typed findings (`path`, `line`), never from prose.
export function buildReadList({ references = [], findings = [], deltaPaths = [] } = {}) {
  const list = references.map((file) => ({ path: file.path, why: "reference" }));
  for (const relative of deltaPaths) list.push({ path: relative, why: "delta" });
  for (const finding of findings) {
    const line = Number(finding.line) || 1;
    list.push({ path: finding.path, lines: [Math.max(1, line - 20), line + 20], why: finding.id || "finding" });
  }
  return list;
}

export function isInReadList(relativePath, readList) {
  const candidate = String(relativePath || "").replaceAll("\\", "/").replace(/^\.\//, "");
  return readList.some((entry) => candidate === entry.path || candidate.startsWith(entry.path + "/"));
}

// A work-order run hands the writer the whole sealed contract; the legacy inline path, the task text.
function workOf(workPackage, contract) {
  if (!contract) return { work: workPackage.task };
  return { contract_sha256: contract.sha256, contract: contract.contract };
}

export function buildTaskInput({ workPackage, call, readList, limits, contract = null }) {
  return {
    event: "task.input",
    work_order: workPackage.work_package_id,
    call,
    ...workOf(workPackage, contract),
    scope: {
      allowed_paths: workPackage.scope.allowed_paths,
      forbidden_paths: workPackage.scope.forbidden_paths || [],
    },
    ...(readList.length ? { read_list: readList } : {}),
    // T0-06: the sealed verification, shown so the writer knows what will be run after it.
    ...(workPackage.test ? { test: { kind: workPackage.test.kind, label: workPackage.test.label } } : {}),
    limits: { max_turns: limits.max_turns, max_output_chars: limits.max_output_chars },
    output_schema: "writer.result",
  };
}

function clip(text, max) {
  const value = String(text || "");
  return value.length <= max ? value : value.slice(0, max - 1) + "…";
}

const SEVERITY_ORDER = { HIGH: 3, MEDIUM: 2, LOW: 1 };

// D2: the Controller writes the handoff from records; the model never writes it.
// T0-05 D4.1: `open_findings` are the typed findings of the last review.result.
export function buildHandoff({ workPackage, call, reason, ioEvents = [], openFindings = [], lastGate = null, changedFiles = [], readList = [], testResult = null, contract = null }) {
  const progress = [];
  for (const event of ioEvents) {
    if (event.event === "usage" && event.role === "writer") {
      progress.push(clip("第 " + event.call + " 次呼叫：" + event.turns + " 輪，" + (event.tokens?.cache_read ?? 0) + " cache read", MAX_PROGRESS_LINE_CHARS));
    } else if (event.event === "review.result") {
      progress.push(clip("第 " + event.call + " 次審查：" + event.gate + "，" + (event.findings || []).length + " 條 findings", MAX_PROGRESS_LINE_CHARS));
    } else if (event.event === "test_result" && event.kind === "command") {
      progress.push(clip("第 " + event.call + " 次驗收：" + (event.passed ? "現有測試通過" : "現有測試失敗，exit " + event.exit_code + (event.timed_out ? "（逾時）" : "")), MAX_PROGRESS_LINE_CHARS));
    } else if (event.event === "stop") {
      progress.push(clip("停點：" + event.status, MAX_PROGRESS_LINE_CHARS));
    }
  }
  if (lastGate) progress.push(clip("上次審查：" + String(lastGate).toUpperCase(), MAX_PROGRESS_LINE_CHARS));
  const findings = [...openFindings]
    .sort((a, b) => (SEVERITY_ORDER[b.severity] || 0) - (SEVERITY_ORDER[a.severity] || 0))
    .map(({ id, severity, path: findingPath, line, reach, claim, evidence, fix, acceptance_ref }) => ({ id, severity, path: findingPath, line, reach, claim, evidence, fix, acceptance_ref }));
  const handoff = {
    event: "handoff",
    work_order: workPackage.work_package_id,
    reason,
    from: { role: "writer", provider: "claude", calls_used: call - 1 },
    // The contract itself is in task.input on every call; the handoff names which one.
    ...(contract ? { contract_sha256: contract.sha256 } : { work: workPackage.task }),
    scope: {
      allowed_paths: workPackage.scope.allowed_paths,
      forbidden_paths: workPackage.scope.forbidden_paths || [],
    },
    progress: progress.slice(-MAX_PROGRESS_LINES),
    open_findings: findings,
    // T0-06 G3.5: failed tests travel as the controller's result, never as a finding.
    ...(testResult ? { test_result: { command: testResult.command, exit_code: testResult.exit_code, timed_out: testResult.timed_out, stdout_tail: clip(testResult.stdout_tail, 1200), stderr_tail: clip(testResult.stderr_tail, 1200) } } : {}),
    workspace: { mode: "snapshot", changed: changedFiles.map((entry) => ({ path: entry.path, change: entry.change })) },
    read_list: readList,
    next: clip(reason === "test_failed" ? "現有測試失敗（見 test_result），修到它通過，維持範圍；做完回 writer.result。" : "修正上列 findings，維持範圍；做完回 writer.result，addressed_findings 列出處理過的 id。", MAX_NEXT_CHARS),
  };
  // D2.3 / T0-05 D4.2: trim the changed-file list first (the delta is on disk anyway), then
  // findings from LOW upward, then old progress lines; the work and the contract hash are never cut.
  const size = () => JSON.stringify(handoff).length;
  while (size() > MAX_HANDOFF_CHARS && handoff.workspace.changed.length > 0) handoff.workspace.changed.pop();
  while (size() > MAX_HANDOFF_CHARS && handoff.open_findings.length > 0) handoff.open_findings.pop();
  while (size() > MAX_HANDOFF_CHARS && handoff.progress.length > 0) handoff.progress.shift();
  return handoff;
}

// D1.2: fixed order. Header, rules, task.input, injected files, handoff.
export function composeWriterPrompt({ workPackage, control, runId, call, taskInput, references, handoff = null, rulesText, contract = null }) {
  const scope = workPackage.scope;
  const header = [
    WRITER_MODE_HEADER,
    "",
    "Injected by the local Review Bridge controller. You are the writer only; the independent reviewer is the only reviewer.",
    "Work package: " + workPackage.work_package_id,
    "Run: " + runId + "  Call: " + call,
    "Allowed workspace paths: " + (scope.allowed_paths || []).join(", "),
    "Forbidden paths: " + (scope.forbidden_paths || []).join(", "),
    "Human breakpoint: " + String(control?.breakpoint || workPackage.breakpoint || ""),
    "Limits: max_turns=" + taskInput.limits.max_turns + ", max_output_chars=" + taskInput.limits.max_output_chars,
    "You may hand separate parts of this work to sub-agents in parallel; they share this scope and budget, and you integrate their work into the one result.",
    "After integrating, make one bounded local consistency pass over what changed. That pass is not a review: neither you nor a sub-agent acts as the reviewer; the independent reviewer is started by the controller.",
    "Do not stage, commit, push, deploy or release.",
    ...(contract ? [
      "Contract: " + contract.sha256 + ". It is the work order as sealed when the human started the work; it is read-only.",
      "Answer with this contract_sha256. If the contract looks wrong, ask through needs_human; never edit it or work from another version.",
      "In criteria, report every acceptance condition of the contract by its id, once each: done or not_done, with a short note on how. status is done only if every condition is done.",
    ] : ["There is no contract for this task; leave criteria empty."]),
    "The files you need are included below; nothing else needs to be opened unless the task cannot be completed without it.",
    "Your final answer must be one writer.result object that matches the JSON schema given to the CLI; no prose outside it.",
    "Set needs_human when a decision only the owner can make is missing; set status to blocked or out_of_scope instead of guessing.",
    "",
  ];
  const rules = ["=== RULES (rules.md) ===", String(rulesText || "").trim(), ""];
  const task = ["=== TASK (task.input) ===", JSON.stringify(taskInput, null, 2), ""];
  const files = [];
  for (const file of references) {
    files.push("=== " + file.path + " (" + file.sha256.slice(0, 12) + ") ===");
    files.push(file.text === null ? "[" + file.bytes + " bytes, " + file.lines + " lines; too large to inline]" : file.text);
    files.push("");
  }
  const tail = handoff ? ["=== HANDOFF ===", JSON.stringify(handoff, null, 2), ""] : [];
  return [...header, ...rules, ...task, ...files, ...tail].join("\n");
}

// D3.2: one JSON object per line from `--output-format stream-json`; a single JSON
// object (legacy `--output-format json`, fakes) is accepted as the result alone.
export function parseClaudeStream(text) {
  const source = String(text || "");
  const reads = [];
  let result = null;
  let unparsable = 0;
  // Per-message usage, kept for a call that ends without a final result (stopped, timed out).
  // The CLI repeats an assistant message once per content block, so a message id counts once.
  const messageUsage = new Map();
  const trimmed = source.trim();
  if (trimmed.startsWith("{") && !trimmed.includes("\n{")) {
    const streamUsage = { messages: 0, subagent_messages: 0, tokens: emptyTokens() };
    try { return { result: JSON.parse(trimmed), reads, streamUsage, unparsable_lines: 0 }; } catch { return { result: null, reads, streamUsage, unparsable_lines: 1 }; }
  }
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { unparsable += 1; continue; }
    if (record?.type === "result") { result = record; continue; }
    if (record?.type === "assistant") {
      const subagent = Boolean(record.parent_tool_use_id);
      if (record.message?.usage && !messageUsage.has(record.message.id ?? messageUsage.size)) {
        messageUsage.set(record.message.id ?? messageUsage.size, { subagent, usage: record.message.usage });
      }
      const content = record.message?.content;
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type !== "tool_use") continue;
        const name = String(block.name || "");
        const input = block.input || {};
        if (["Read", "Grep", "Glob", "Bash"].includes(name)) {
          reads.push({
            tool: name,
            ...(input.file_path ? { path: String(input.file_path) } : {}),
            ...(input.pattern ? { pattern: String(input.pattern) } : {}),
            ...(input.path ? { path: String(input.path) } : {}),
            ...(input.command ? { command: String(input.command).slice(0, 200) } : {}),
            ...(subagent ? { subagent: true } : {}),
          });
        }
      }
    }
  }
  const streamUsage = { messages: messageUsage.size, subagent_messages: 0, tokens: emptyTokens() };
  for (const { subagent, usage } of messageUsage.values()) {
    if (subagent) streamUsage.subagent_messages += 1;
    streamUsage.tokens.input += finite(usage.input_tokens);
    streamUsage.tokens.cache_write += finite(usage.cache_creation_input_tokens);
    streamUsage.tokens.cache_read += finite(usage.cache_read_input_tokens);
    streamUsage.tokens.output += finite(usage.output_tokens);
  }
  return { result, reads, streamUsage, unparsable_lines: unparsable };
}

function emptyTokens() {
  return { input: 0, cache_write: 0, cache_read: 0, output: 0 };
}

function finite(value) {
  return Number.isFinite(value) ? value : 0;
}

// The four token fields Claude Code 2.1.280 was verified to put in result.usage (2026-10-13).
// Measured 2026-10-17 on CLI 2.1.280: `usage` covers only the main model's last turn, while
// `modelUsage` covers the whole call, every model, sub-agents included. With background sub-agents
// the CLI emits more than one result; the last one carries the cumulative total.
export const MODEL_USAGE_FIELDS = Object.freeze(["inputTokens", "cacheCreationInputTokens", "cacheReadInputTokens", "outputTokens"]);

export function usageFromResult(result, { call, durationMs }) {
  const models = result?.modelUsage && typeof result.modelUsage === "object" ? Object.entries(result.modelUsage) : [];
  // Codex 2026-10-14: a missing or non-numeric field is unknown, never zero.
  const missing = models.length
    ? models.flatMap(([model, usage]) => MODEL_USAGE_FIELDS.filter((field) => !Number.isFinite(usage?.[field])).map((field) => model + "." + field))
    : ["modelUsage"];
  const sum = (field) => models.reduce((total, [, usage]) => total + finite(usage?.[field]), 0);
  return {
    event: "usage",
    role: "writer",
    provider: "claude",
    call,
    turns: finite(result?.num_turns),
    duration_ms: durationMs,
    tokens: {
      input: sum("inputTokens"),
      cache_write: sum("cacheCreationInputTokens"),
      cache_read: sum("cacheReadInputTokens"),
      output: sum("outputTokens"),
    },
    models: models.map(([model]) => model),
    cost_usd: Number.isFinite(result?.total_cost_usd) ? result.total_cost_usd : null,
    source: "cli_model_usage",
    ...(missing.length ? { parse_error: true, missing } : {}),
  };
}

// A call that ended without a final result (stopped, timed out, crashed): what the stream showed
// is spent and is recorded, but it is a lower bound, so the record is marked partial and the
// token table treats it as incomplete.
export function partialUsageFromStream(streamUsage, { call, durationMs }) {
  return {
    event: "usage",
    role: "writer",
    provider: "claude",
    call,
    duration_ms: durationMs,
    tokens: { ...(streamUsage?.tokens || emptyTokens()) },
    messages: streamUsage?.messages || 0,
    subagent_messages: streamUsage?.subagent_messages || 0,
    cost_usd: null,
    source: "cli_stream_messages",
    partial: true,
    parse_error: true,
    missing: ["final_result"],
  };
}
