// Fake Codex CLI (T0-05 D6.3). `exec` answers in the file named by --output-last-message and prints
// the `--json` event stream; `app-server` speaks the writer's protocol over stdin and stdout. Without
// a schema, the legacy two gate lines. Whichever role it is in, the answer comes from fakeAnswers.mjs.
// No model is involved.
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import readline from "node:readline";

import { checkAnswer, logCall, modeOf, reviewAnswer, reviewInput, reviewWork, translationAnswer, writerAnswer } from "./fakeAnswers.mjs";

const rateLimited = (process.env.FAKE_CLAUDE_RESULT || "OK") === "RATE_LIMIT";

// `mcp list --json`: FAKE_CODEX_MCP_LIST is the answer, or "fail" for a list that cannot be read.
if (process.argv.includes("mcp") && process.argv.includes("list")) {
  if (process.env.FAKE_CODEX_MCP_LIST === "fail") {
    process.stderr.write("config.toml could not be read\n");
    process.exit(1);
  }
  process.stdout.write((process.env.FAKE_CODEX_MCP_LIST || "[]") + "\n");
  process.exit(0);
}

// The writer's server: one thread with one turn, as codexAppServer.mjs drives it.
async function appServer() {
  const threadId = "fake-thread-" + randomUUID();
  const turnId = "fake-turn-" + randomUUID();
  let threadParams = null;
  const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
  const notify = (method, params) => send({ method, params });
  // Stay alive like the real server until the client ends it.
  setInterval(() => {}, 1_000);
  for await (const line of readline.createInterface({ input: process.stdin })) {
    const message = JSON.parse(line);
    if (message.method === "initialize") send({ id: message.id, result: {} });
    if (message.method === "thread/start") {
      threadParams = message.params;
      send({ id: message.id, result: { thread: { id: threadId }, model: message.params.model ?? "fake-codex-default" } });
    }
    if (message.method === "turn/interrupt") send({ id: message.id, result: {} });
    if (message.method !== "turn/start") continue;
    const prompt = message.params.input.map((item) => item.text).join("\n");
    logCall("codex", modeOf(prompt), { session_id: threadId, thread: threadParams, effort: message.params.effort ?? null, schema: Boolean(message.params.outputSchema) });
    send({ id: message.id, result: { turn: { id: turnId } } });
    notify("turn/started", { threadId, turn: { id: turnId } });
    const sleepMs = Number(process.env.FAKE_CLAUDE_SLEEP_MS || 0);
    if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
    // FAKE_CODEX_STDERR=<bytes> writes that much to stderr first: a server nobody reads would stall here.
    const flood = Number(process.env.FAKE_CODEX_STDERR || 0);
    if (flood > 0) await new Promise((resolve) => process.stderr.write("x".repeat(flood) + "\n", resolve));
    if (rateLimited) {
      notify("error", { threadId, turnId, willRetry: false, error: { message: "You've hit your usage limit. Try again later." } });
      notify("turn/completed", { threadId, turn: { id: turnId, status: "failed", error: { message: "You've hit your usage limit. Try again later." } } });
      continue;
    }
    const answer = writerAnswer(prompt);
    notify("item/completed", { threadId, item: { type: "commandExecution", id: "item_0", command: "cat " + (answer.changed?.[0]?.path || "README.md") } });
    notify("item/completed", { threadId, item: { type: "agentMessage", id: "item_1", text: JSON.stringify(answer) } });
    const tokens = Number(process.env.FAKE_CLAUDE_TOKENS || 150_346);
    // FAKE_CLAUDE_USAGE=none leaves out the writer's usage, so Bridge cannot read it.
    if (process.env.FAKE_CLAUDE_USAGE !== "none") {
      notify("thread/tokenUsage/updated", { threadId, tokenUsage: { total: { inputTokens: tokens, cachedInputTokens: Math.floor(tokens / 2), outputTokens: 2352, totalTokens: tokens + 2352 } } });
    }
    notify("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
  }
  process.exit(0);
}
if (process.argv.includes("app-server")) await appServer();

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString("utf8");
const outputIndex = process.argv.indexOf("--output-last-message");
if (outputIndex < 0 || !process.argv[outputIndex + 1]) {
  process.stderr.write("missing --output-last-message\n");
  process.exit(2);
}
const outputPath = process.argv[outputIndex + 1];
const threadId = "fake-thread-" + randomUUID();
const mode = modeOf(prompt);
logCall("codex", mode, { session_id: threadId });
if (process.argv[process.argv.indexOf("--sandbox") + 1] !== "read-only") {
  process.stderr.write("this session must be read-only\n");
  process.exit(2);
}
const usageEvents = (tokens) => [
  { type: "thread.started", thread_id: threadId },
  { type: "turn.started" },
  { type: "turn.completed", usage: { input_tokens: tokens, cached_input_tokens: Math.floor(tokens / 2), cache_write_input_tokens: 0, output_tokens: 410, reasoning_output_tokens: 0 } },
];

if (mode === "translation") {
  if (rateLimited) {
    process.stderr.write("ERROR: You've hit your usage limit. Try again later.\n");
    process.exit(1);
  }
  await fsp.writeFile(outputPath, JSON.stringify(translationAnswer(prompt), null, 2), "utf8");
  for (const event of usageEvents(Number(process.env.FAKE_CODEX_TOKENS || 12_000))) process.stdout.write(JSON.stringify(event) + "\n");
  process.exit(0);
}

if (mode === "check") {
  await fsp.writeFile(outputPath, JSON.stringify(checkAnswer(prompt), null, 2), "utf8");
  // FAKE_CONTRACT_CHECK_USAGE=none leaves out turn.completed, so Bridge cannot read the usage.
  const events = usageEvents(Number(process.env.FAKE_CODEX_TOKENS || 12_000));
  for (const event of process.env.FAKE_CONTRACT_CHECK_USAGE === "none" ? events.slice(0, 2) : events) process.stdout.write(JSON.stringify(event) + "\n");
  process.exit(0);
}

if (mode !== "review") {
  process.stderr.write("review prompt did not reach fake Codex\n");
  process.exit(3);
}
const gate = process.env.FAKE_CODEX_GATE || "PASS";
const typed = process.argv.includes("--output-schema");

if (!typed) {
  const body = gate === "MALFORMED"
    ? "review completed without controller gate lines\n"
    : [
        "# Fake Codex Review",
        "",
        "HARD_STOP_REQUIRED: " + (gate === "HARD_STOP" ? "true" : "false"),
        "REVIEW_GATE: " + (gate === "PASS" ? "PASS" : "FAIL"),
        "",
      ].join("\n");
  await fsp.writeFile(outputPath, body, "utf8");
  process.stdout.write("fake codex completed\n");
  process.exit(0);
}

await reviewWork();
const deltaPath = reviewInput(prompt).delta?.[0]?.path || reviewInput(prompt).read_list?.[0]?.path || "README.md";
await fsp.writeFile(outputPath, JSON.stringify(reviewAnswer(prompt), null, 2), "utf8");

const tokens = Number(process.env.FAKE_CODEX_TOKENS || 59_990);
const events = [
  { type: "thread.started", thread_id: threadId },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "item_0", type: "command_execution", command: "bash -lc 'cat " + deltaPath + "'", exit_code: 0, status: "completed" } },
  { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "review.result submitted" } },
  { type: "turn.completed", usage: { input_tokens: tokens, cached_input_tokens: Math.floor(tokens / 2), cache_write_input_tokens: 0, output_tokens: 410, reasoning_output_tokens: 0 } },
];
// FAKE_CODEX_USAGE=none leaves out the review's usage, so Bridge cannot read it.
for (const event of process.env.FAKE_CODEX_USAGE === "none" ? events.slice(0, -1) : events) process.stdout.write(JSON.stringify(event) + "\n");
