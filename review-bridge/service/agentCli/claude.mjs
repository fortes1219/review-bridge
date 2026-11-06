// Claude Code as a role: how one call is made and how its stream is read. Every other module asks
// for a call through agentCli/calls.mjs and gets the same answer back, as Vitest's coverage providers
// sit behind one interface and are named only in the config.
import fsp from "node:fs/promises";
import path from "node:path";

import { runProcess } from "./process.mjs";
import { readEvidenceTail } from "./providerFailure.mjs";

const finite = (value) => (Number.isFinite(value) ? value : 0);
const emptyTokens = () => ({ input: 0, cache_write: 0, cache_read: 0, output: 0 });

const assistantText = (record) => (Array.isArray(record.message?.content) ? record.message.content : [])
  .filter((block) => block?.type === "text").map((block) => String(block.text || "")).join("\n");

// D3.2: one JSON object per line from `--output-format stream-json`; a single JSON
// object (legacy `--output-format json`, fakes) is accepted as the result alone.
export function parseClaudeStream(text) {
  const source = String(text || "");
  const reads = [];
  let result = null;
  let init = null;
  let unparsable = 0;
  // The CLI's own typed error on the session's latest assistant line, with the words it came with.
  let apiError = null;
  // Per-message usage, kept for a call that ends without a final result (stopped, timed out).
  // The CLI repeats an assistant message once per content block, so a message id counts once.
  const messageUsage = new Map();
  const trimmed = source.trim();
  if (trimmed.startsWith("{") && !trimmed.includes("\n{")) {
    const streamUsage = { messages: 0, subagent_messages: 0, tokens: emptyTokens() };
    try { return { result: JSON.parse(trimmed), init, reads, streamUsage, unparsable_lines: 0 }; } catch { return { result: null, init, reads, streamUsage, unparsable_lines: 1 }; }
  }
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { unparsable += 1; continue; }
    if (record?.type === "result") { result = record; continue; }
    if (record?.type === "system" && record.subtype === "init") { init = record; continue; }
    if (record?.type === "assistant") {
      const subagent = Boolean(record.parent_tool_use_id);
      if (!subagent) apiError = record.error ? { code: String(record.error), text: assistantText(record) } : null;
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
  return { result, init, reads, streamUsage, apiError, unparsable_lines: unparsable };
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

// A role's tools, as Owner set them on 2026-11-04 and 2026-11-05. `--tools` names the only built-in
// tools there are and `--strict-mcp-config` drops the MCP servers, which `--tools` does not touch: a
// real session under `--tools ""` still held 19 of them (Google Drive's trash_file among them). The
// person's own connectors go into no session Bridge starts (Owner 2026-11-05).
export const READ_ONLY_TOOLS = Object.freeze(["Read", "Grep", "Glob"]);
export const READ_ONLY_ARGS = Object.freeze([
  "--permission-mode", "plan",
  "--tools", READ_ONLY_TOOLS.join(","),
  "--disallowedTools", "Write,Edit,NotebookEdit,Bash,PowerShell",
  "--strict-mcp-config",
]);
const PROJECT_MCP_CONFIG = ".mcp.json";

// The servers a project's .mcp.json defines; none when it has no such file. One that cannot be read
// is an error, never "none".
export async function projectMcpServers(cwd) {
  const text = await fsp.readFile(path.join(cwd, PROJECT_MCP_CONFIG), "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (text === null) return {};
  let config;
  try { config = JSON.parse(text); } catch { throw new Error("This project's .mcp.json is not JSON."); }
  return config?.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {};
}

// The allowed servers only, as the one string --mcp-config takes: the file as a whole may hold others.
export async function mcpConfigFor(cwd, names) {
  const servers = await projectMcpServers(cwd);
  const absent = names.filter((name) => !servers[name]);
  if (absent.length) throw new Error("This project's .mcp.json no longer defines " + absent.join(", ") + ".");
  return JSON.stringify({ mcpServers: Object.fromEntries(names.map((name) => [name, servers[name]])) });
}

// The reviewer's flags, plus the servers the policy lets through. --strict-mcp-config stays: only these
// load. In print mode nobody can answer a prompt, so a let-through server is allowed by name too.
export function readOnlyArgs({ mcpConfig = null, mcp = [] } = {}) {
  return [...READ_ONLY_ARGS, ...(mcpConfig ? ["--mcp-config", mcpConfig, "--allowedTools", mcp.map((name) => "mcp__" + name).join(",")] : [])];
}

const ACCESS_ARGS = Object.freeze({
  none: () => ["--tools", "", "--strict-mcp-config"],
  read: (_disallowedTools, _projectMcp, readOnly) => [...readOnlyArgs(readOnly), "--no-session-persistence"],
  // Sub-agents are allowed for implementation; a project override can still disallow tools. The MCP
  // servers a writer has are the project's own, from its .mcp.json, which --strict-mcp-config would
  // otherwise drop along with the person's.
  write: (disallowedTools, projectMcp) => [
    "--permission-mode", "auto",
    ...(disallowedTools.length ? ["--disallowedTools", disallowedTools.join(",")] : []),
    "--strict-mcp-config",
    ...(projectMcp ? ["--mcp-config", PROJECT_MCP_CONFIG] : []),
  ],
});

// One call: `access` is what the session may do (none, read or write). The session id is the
// caller's where it has one. The answer is written to `answerPath`, like Codex's last message.
export async function callClaude({
  adapter, access, role, call = 0, prompt, schemaPath, model = null, effort, cwd, sessionId = null, maxTurns = null, disallowedTools = [], mcp = [],
  stdoutPath, stderrPath, answerPath = null, timeoutMs, onSpawn,
}) {
  const executable = await adapter.resolveExecutable("claude");
  const projectMcp = access === "write" && Boolean(await fsp.stat(path.join(cwd, PROJECT_MCP_CONFIG)).then((stat) => stat.isFile(), () => false));
  const args = [
    "-p",
    ...(sessionId ? ["--session-id", sessionId] : []),
    ...ACCESS_ARGS[access](disallowedTools, projectMcp, { mcp, mcpConfig: access === "read" && mcp.length ? await mcpConfigFor(cwd, mcp) : null }),
    // A model of null leaves the choice to the CLI.
    ...(model ? ["--model", model] : []),
    "--effort", effort,
    ...(maxTurns ? ["--max-turns", String(maxTurns)] : []),
    "--output-format", "stream-json",
    "--verbose",
    "--json-schema", JSON.stringify(JSON.parse(await fsp.readFile(schemaPath, "utf8"))),
  ];
  const startedAt = Date.now();
  const processResult = await runProcess({
    invocation: adapter.buildInvocation("claude", executable, args), cwd, input: prompt, stdoutPath, stderrPath, timeoutMs, onSpawn,
  });
  const durationMs = Date.now() - startedAt;
  const stream = parseClaudeStream(await fsp.readFile(stdoutPath, "utf8").catch(() => ""));
  const timedOut = Boolean(processResult.timedOut);
  const complete = Boolean(stream.result) && !timedOut;
  const failed = !complete || stream.result.is_error === true || processResult.exitCode !== 0;
  const output = stream.result?.structured_output;
  const answer = !failed && output && typeof output === "object" && !Array.isArray(output) ? output : null;
  if (answer && answerPath) await fsp.writeFile(answerPath, JSON.stringify(answer, null, 2) + "\n", "utf8");
  const reportedSession = stream.result?.session_id === undefined ? null : String(stream.result.session_id);
  return {
    provider: "claude",
    exitCode: processResult.exitCode,
    timedOut,
    complete,
    failed,
    answer,
    usage: {
      ...(complete ? usageFromResult(stream.result, { call, durationMs }) : partialUsageFromStream(stream.streamUsage, { call, durationMs })),
      role,
      ...(reportedSession ? { session_id: reportedSession } : {}),
    },
    reads: stream.reads,
    finalRecord: stream.result,
    reportedSession,
    maxTurnsReached: stream.result?.subtype === "error_max_turns",
    // The MCP tools its own init event says the session held; null when the stream shows no list.
    mcpToolsHeld: Array.isArray(stream.init?.tools) ? stream.init.tools.filter((tool) => String(tool).startsWith("mcp__")) : null,
    failureCode: stream.apiError?.code ?? null,
    // The CLI marks its own error with is_error; only then is `result` its message (a usage limit is
    // reported there). Otherwise `result` is the model's text and is not read.
    failureTexts: async () => [
      stream.apiError?.text || "",
      stream.result?.is_error === true ? String(stream.result.result || "") : "",
      await readEvidenceTail(stderrPath),
      stream.result ? "" : await readEvidenceTail(stdoutPath),
    ],
  };
}
