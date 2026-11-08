// Codex as a role: how one call is made and how its output is read. A session that only reads goes
// through `codex exec`, which starts no sub-agents, and a session that writes through
// `codex app-server` (codexAppServer.mjs says why). Other modules ask through agentCli/calls.mjs.
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";

import { runCodexAppServerTurn, writerUsageFromThreads } from "./codexAppServer.mjs";
import { runProcess } from "./process.mjs";
import { codexDiagnosticTrailer, readEvidenceTail } from "./providerFailure.mjs";
import { parseReviewerUsage } from "./usage.mjs";

const normalizePath = (value) => String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");

// How many distinct errors a stream keeps: one of nothing but errors stays this long.
const MAX_STREAM_FAILURES = 20;

// D5.1 / D5.2: `codex exec --json` prints one event per line; usage and commands are taken from it.
// So are its errors, which 0.166 writes there and not to stderr (exec/src/event_processor_with_jsonl_output.rs):
// only these two event types, never an item, so words a tool printed are not read as Codex's own.
// "Reconnecting..." is an error event too, and only says it is trying again.
export function parseCodexJsonl(text) {
  let usage = null;
  let threadId = null;
  const commands = [];
  const failures = [];
  const noteFailure = (message) => {
    if (typeof message === "string" && message && !/^Reconnecting\.\.\./.test(message) && !failures.includes(message) && failures.length < MAX_STREAM_FAILURES) failures.push(message);
  };
  let unparsable = 0;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { unparsable += 1; continue; }
    if (record?.type === "thread.started" && record.thread_id) threadId = String(record.thread_id);
    if (record?.type === "turn.completed" && record.usage && typeof record.usage === "object") usage = record.usage;
    if (record?.type === "error") noteFailure(record.message);
    if (record?.type === "turn.failed") noteFailure(record.error?.message);
    if (record?.type === "item.completed" && record.item?.type === "command_execution" && record.item.command) {
      commands.push(String(record.item.command).slice(0, 200));
    }
  }
  return { usage, thread_id: threadId, commands, failures, unparsable_lines: unparsable };
}

// A path the command names, when one can be read off mechanically; otherwise null.
export function pathFromCommand(command) {
  const match = /(?:^|\s)((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8})(?=\s|$|['"])/.exec(String(command || "").replace(/^(?:bash|sh)\s+-lc\s+/, "").replace(/^['"]|['"]$/g, ""));
  return match ? normalizePath(match[1]) : null;
}

// The four token fields codex-cli 0.162 was verified to put in turn.completed.usage (2026-10-13).
export const CODEX_USAGE_FIELDS = Object.freeze(["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens"]);

export function reviewerUsageEvent({ usage, trailerTokens, call, durationMs }) {
  const number = (value) => (Number.isFinite(value) ? value : 0);
  const base = { event: "usage", role: "reviewer", provider: "codex", call, turns: null, duration_ms: durationMs };
  if (usage) {
    // Codex's input_tokens is the total; cached_input_tokens and cache_write_input_tokens are
    // parts of it (OpenAI usage shape; field names verified against codex-cli 0.162 on 2026-10-13).
    // The parts are split out so the ceiling total counts each token once. Parts larger than the
    // total are a data anomaly: recorded as such, never silently floored.
    const total = number(usage.input_tokens);
    const cached = number(usage.cached_input_tokens);
    const cacheWrite = number(usage.cache_write_input_tokens);
    const plain = total - cached - cacheWrite;
    // Codex 2026-10-14: an empty or partial usage object is unknown, never zero.
    const missing = CODEX_USAGE_FIELDS.filter((field) => !Number.isFinite(usage[field]));
    return {
      ...base,
      ...(missing.length ? { parse_error: true, missing } : {}),
      tokens: {
        input: Math.max(0, plain),
        cache_write: cacheWrite,
        cache_read: cached,
        output: number(usage.output_tokens),
      },
      ...(plain < 0 ? { anomaly: "cache_parts_exceed_input_tokens", raw_usage: usage } : {}),
      cost_usd: null,
      source: "cli_json",
    };
  }
  if (Number.isFinite(trailerTokens)) {
    return { ...base, tokens: { input: trailerTokens, cache_write: 0, cache_read: 0, output: 0 }, cost_usd: null, source: "cli_trailer" };
  }
  return { ...base, tokens: { input: 0, cache_write: 0, cache_read: 0, output: 0 }, cost_usd: null, source: null, parse_error: true };
}

// The person's own connectors go into no session Bridge starts (Owner 2026-11-05). These two feature
// flags take ChatGPT's apps and installed plugins away. A server in the person's config.toml stays:
// `-c mcp_servers={}` merges and removes nothing (measured with `codex mcp list`, 0.166.0), so each is
// named and turned off (mcpOffArgs), from the list the plan sealed.
export const NO_CONNECTORS_ARGS = Object.freeze(["--disable", "apps", "--disable", "plugins"]);
export const mcpOffArgs = (names = []) => names.flatMap((name) => ["-c", "mcp_servers." + name + ".enabled=false"]);

// Bridge's own graph server (T0-GRAPH-01), defined for this call only: `-c` takes a dotted path and a
// TOML value (codex-rs config_override.rs), the stdio server's keys are `command` and `args`, and
// `enabled_tools` registers only the listed tools (config mcp_types.rs). A JSON string or array of
// strings is also a TOML one.
export const graphServerArgs = (graph) => (graph ? [
  "-c", "mcp_servers." + graph.name + ".command=" + JSON.stringify(graph.command),
  "-c", "mcp_servers." + graph.name + ".args=" + JSON.stringify(graph.args),
  "-c", "mcp_servers." + graph.name + ".enabled_tools=" + JSON.stringify(graph.tools),
] : []);

// The MCP servers a session of Bridge's would load. Calls no model and starts no server. A name that
// cannot be put in a config path cannot be turned off, so it is an error like an unreadable list.
export async function listCodexMcpServers(adapter) {
  const executable = await adapter.resolveExecutable("codex");
  const invocation = adapter.buildInvocation("codex", executable, [...NO_CONNECTORS_ARGS, "mcp", "list", "--json"]);
  const result = spawnSync(invocation.command, invocation.args, { env: invocation.env, encoding: "utf8", windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw new Error(result.error.message + ".");
  if (result.status !== 0) throw new Error("it exited with " + result.status + ".");
  let servers;
  try { servers = JSON.parse(result.stdout); } catch { throw new Error("its answer is not JSON."); }
  if (!Array.isArray(servers)) throw new Error("its answer is not a list.");
  for (const server of servers) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(server?.name))) throw new Error("the server " + JSON.stringify(server?.name) + " has a name Bridge cannot turn off by name.");
  }
  return servers.map((server) => ({ name: server.name, enabled: server.enabled !== false }));
}

const commandRead = (command) => {
  const found = pathFromCommand(command);
  return { tool: "command", command, ...(found ? { path: found } : {}) };
};

// `codex exec` has no switch that removes every tool, so a session with no business reading files
// still gets the read-only sandbox: it can write nothing, and it can read the project.
async function callExec({ adapter, role, call, prompt, schemaPath, model, effort, cwd, mcpOff = [], graph = null, stdoutPath, stderrPath, answerPath, timeoutMs, onSpawn }) {
  const executable = await adapter.resolveExecutable("codex");
  const args = [
    ...NO_CONNECTORS_ARGS,
    ...mcpOffArgs(mcpOff),
    ...graphServerArgs(graph),
    "--ask-for-approval", "never",
    "-c", "model_reasoning_effort=\"" + effort + "\"",
    // A model of null leaves the choice to the CLI.
    ...(model ? ["--model", model] : []),
    // A project without Git still gets a contract and a review (Owner 2026-10-17); Codex otherwise
    // refuses any folder that is not a trusted Git repository. The session stays read-only.
    "exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--cd", cwd,
    "--output-schema", schemaPath, "--json", "--output-last-message", answerPath, "-",
  ];
  const startedAt = Date.now();
  const processResult = await runProcess({
    invocation: adapter.buildInvocation("codex", executable, args), cwd, input: prompt, stdoutPath, stderrPath, timeoutMs, onSpawn,
  });
  const durationMs = Date.now() - startedAt;
  const stream = parseCodexJsonl(await fsp.readFile(stdoutPath, "utf8").catch(() => ""));
  const stderr = await readEvidenceTail(stderrPath);
  const timedOut = Boolean(processResult.timedOut);
  const text = await fsp.readFile(answerPath, "utf8").catch(() => "");
  let answer = null;
  try { answer = text.trim() ? JSON.parse(text) : null; } catch { answer = null; }
  return {
    provider: "codex",
    exitCode: processResult.exitCode,
    timedOut,
    complete: !timedOut,
    failed: timedOut || processResult.exitCode !== 0 || !text.trim(),
    answer,
    // The JSONL stream first; the stderr trailer is the fallback.
    usage: {
      ...reviewerUsageEvent({ usage: stream.usage, trailerTokens: parseReviewerUsage(stderr).tokens_used, call, durationMs }),
      role,
      ...(stream.thread_id ? { session_id: stream.thread_id } : {}),
    },
    reads: stream.commands.map(commandRead),
    finalRecord: null,
    reportedSession: null,
    maxTurnsReached: false,
    // Exec gives no code: its events carry only a message.
    failureCode: null,
    failureTexts: async () => [...stream.failures, codexDiagnosticTrailer(stderr)],
  };
}

// The commands a writer's thread ran, from the events the app server sent.
async function commandsOf(eventsPath) {
  const commands = [];
  for (const line of (await fsp.readFile(eventsPath, "utf8").catch(() => "")).split(/\r?\n/)) {
    if (!line.includes("commandExecution")) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const item = message?.params?.item;
    if (message?.method === "item/completed" && item?.type === "commandExecution" && item.command) commands.push(String(item.command).slice(0, 200));
  }
  return commands;
}

// The writer: a thread whose sandbox writes to the workspace only and asks nobody. The app server
// takes the model and the effort in its requests; it has no -m, and `-c` would only say the same.
async function callWriter({ adapter, role, call, prompt, schemaPath, model, effort, cwd, mcpOff = [], graph = null, stdoutPath, stderrPath, answerPath, timeoutMs, onSpawn }) {
  const executable = await adapter.resolveExecutable("codex");
  const startedAt = Date.now();
  const result = await runCodexAppServerTurn({
    invocation: adapter.buildInvocation("codex", executable, [...NO_CONNECTORS_ARGS, ...mcpOffArgs(mcpOff), ...graphServerArgs(graph), "app-server"]),
    cwd,
    prompt,
    // A model of null leaves the choice to the CLI.
    thread: { approvalPolicy: "never", sandbox: "workspace-write", ...(model ? { model } : {}) },
    effort,
    outputSchema: JSON.parse(await fsp.readFile(schemaPath, "utf8")),
    timeoutMs,
    eventsPath: stdoutPath,
    stderrPath,
    onSpawn,
  });
  const durationMs = Date.now() - startedAt;
  const completed = result.status === "completed";
  let answer = null;
  try { answer = completed ? JSON.parse(result.finalMessage) : null; } catch { answer = null; }
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) answer = null;
  if (answer && answerPath) await fsp.writeFile(answerPath, JSON.stringify(answer, null, 2) + "\n", "utf8");
  const threadId = result.summary.threads[0]?.id ?? null;
  return {
    provider: "codex",
    exitCode: completed ? 0 : 1,
    timedOut: result.status === "timed_out",
    complete: completed,
    failed: !completed,
    answer,
    usage: { ...writerUsageFromThreads(result.summary, { call, durationMs }), role, ...(threadId ? { session_id: threadId } : {}) },
    reads: (await commandsOf(stdoutPath)).map(commandRead),
    finalRecord: { thread_id: threadId, status: result.status, final_message: result.finalMessage },
    reportedSession: null,
    maxTurnsReached: false,
    failureCode: result.errorCode,
    failureTexts: async () => [...result.errors, result.error?.message || "", codexDiagnosticTrailer(await readEvidenceTail(stderrPath))],
  };
}

// One call, as Claude's: `access` is what the session may do (none, read or write).
export async function callCodex({ access, maxTurns: _maxTurns, disallowedTools: _disallowedTools, sessionId: _sessionId, mcp: _mcp, ...request }) {
  return access === "write" ? await callWriter(request) : await callExec(request);
}
