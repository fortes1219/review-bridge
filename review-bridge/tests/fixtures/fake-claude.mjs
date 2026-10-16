// Fake Claude CLI for fake-cli runs (T0-04 D3.4, T0-05 D6.2). Emits the stream-json shape:
// a system line, two tool_use lines (one file from the injected read list, one
// outside it), and a result line carrying usage and, when the CLI was asked for a
// schema, a writer.result in `structured_output`. No model is involved.
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString("utf8");
const sessionIndex = process.argv.indexOf("--session-id");
const resumeIndex = process.argv.indexOf("--resume");
const sessionId = sessionIndex >= 0
  ? process.argv[sessionIndex + 1]
  : resumeIndex >= 0 ? process.argv[resumeIndex + 1] : "";
if (!sessionId || !prompt.includes("[REVIEW_BRIDGE_MODE: WRITER_ONLY]")) {
  process.stderr.write("writer-only resume contract missing\n");
  process.exit(2);
}
const maxTurnsIndex = process.argv.indexOf("--max-turns");
const maxTurns = maxTurnsIndex >= 0 ? Number(process.argv[maxTurnsIndex + 1]) : null;
const sleepMs = Number(process.env.FAKE_CLAUDE_SLEEP_MS || 0);
if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));

const injected = /^=== (.+?) \([0-9a-f]{12}\) ===$/m.exec(prompt);
const firstRead = injected ? injected[1] : "README.md";
const resultMode = process.env.FAKE_CLAUDE_RESULT || "OK";
const rateLimited = resultMode === "RATE_LIMIT";
const cacheRead = Number(process.env.FAKE_CLAUDE_TOKENS || 150_346);
const streamMode = process.argv.includes("stream-json");
const typed = process.argv.includes("--json-schema");

// The typed answer is built from the injected task.input and handoff, as a real writer would.
function structuredOutput() {
  const workOrder = /"work_order": "([^"]+)"/.exec(prompt)?.[1] || "unknown";
  const call = Number(/"call": (\d+)/.exec(prompt)?.[1] || 1);
  const handoffAt = prompt.indexOf("=== HANDOFF ===");
  const addressed = handoffAt >= 0 ? [...prompt.slice(handoffAt).matchAll(/"id": "(F\d+)"/g)].map((match) => match[1]) : [];
  if (resultMode === "MALFORMED") return { event: "writer.result", work_order: workOrder };
  return {
    event: "writer.result",
    work_order: workOrder,
    call,
    status: resultMode === "BLOCKED" ? "blocked" : "done",
    changed: [{ path: firstRead, action: "modified", summary: "fake edit for call " + call }],
    verification: [{ command: "node --version", exit_code: 0, summary: "fake check" }],
    unverified: [],
    needs_human: resultMode === "NEEDS_HUMAN" ? [{ question: "which colour?", options: ["red", "blue"] }] : [],
    addressed_findings: [...new Set(addressed)],
  };
}

const lines = [
  { type: "system", subtype: "init", session_id: sessionId, model: "fake", ...(maxTurns ? { max_turns: maxTurns } : {}) },
  { type: "assistant", session_id: sessionId, message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: firstRead } }] } },
  { type: "assistant", session_id: sessionId, message: { content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: ".review-bridge/review-bridge/bridge.json" } }] } },
];
const result = {
  type: "result",
  subtype: rateLimited ? "error_during_execution" : "success",
  session_id: sessionId,
  is_error: rateLimited,
  num_turns: 3,
  duration_ms: 1200,
  total_cost_usd: 0.42,
  usage: { input_tokens: 94, cache_creation_input_tokens: 454, cache_read_input_tokens: cacheRead, output_tokens: 2352 },
  modelUsage: { "fake-opus": { inputTokens: 94, cacheCreationInputTokens: 454, cacheReadInputTokens: cacheRead, outputTokens: 2352 } },
  result: rateLimited
    ? "usage limit reached; resets soon"
    : typed
      ? "writer.result submitted"
      : [
          "[Claude -> Codex report]",
          "focused correction report call " + (process.env.FAKE_CLAUDE_CALL || "1"),
          "CODEX_REVIEW_REQUIRED: true",
        ].join("\n"),
  ...(typed && !rateLimited ? { structured_output: structuredOutput() } : {}),
};
if (streamMode) {
  for (const line of lines) process.stdout.write(JSON.stringify(line) + "\n");
  process.stdout.write(JSON.stringify(result) + "\n");
} else {
  process.stdout.write(JSON.stringify({ session_id: result.session_id, is_error: result.is_error, result: result.result, usage: result.usage, num_turns: result.num_turns }));
}
