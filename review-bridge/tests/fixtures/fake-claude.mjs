// Fake Claude CLI for fake-cli runs (T0-04 D3.4, T0-05 D6.2). Emits the stream-json shape:
// a system line, two tool_use lines (one file from the injected read list, one
// outside it), and a result line carrying usage and, when the CLI was asked for a
// schema, the role's answer in `structured_output`. A session in the reviewer's seat must carry the
// reviewer's read-only flags, or this CLI refuses it. No model is involved.
import { checkAnswer, logCall, modeOf, reviewAnswer, reviewInput, reviewWork, translationAnswer, writerAnswer } from "./fakeAnswers.mjs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString("utf8");
const mode = modeOf(prompt);
const translating = mode === "translation";
const reviewing = mode === "check" || mode === "review";
const flag = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const sessionId = flag("--session-id") ?? flag("--resume") ?? (reviewing || mode === "probe" ? "fake-claude-" + process.pid : "");
logCall("claude", mode, { session_id: sessionId });
if (reviewing && (flag("--permission-mode") !== "plan" || flag("--tools") !== "Read,Grep,Glob" || !process.argv.includes("--strict-mcp-config"))) {
  process.stderr.write("the reviewer's session must be read-only\n");
  process.exit(2);
}
if (!sessionId || !mode) {
  process.stderr.write("writer-only resume contract missing\n");
  process.exit(2);
}
const maxTurns = flag("--max-turns") === null ? null : Number(flag("--max-turns"));
const sleepMs = Number(process.env.FAKE_CLAUDE_SLEEP_MS || 0);
// The sleep stands for a long writer call; the translation before it answers at once.
if (sleepMs > 0 && mode === "writer") await new Promise((resolve) => setTimeout(resolve, sleepMs));
// FAKE_CONTRACT_SLEEP_MS slows the translation instead, so a test can stop the run during it.
const contractSleepMs = Number(process.env.FAKE_CONTRACT_SLEEP_MS || 0);
if (contractSleepMs > 0 && translating) await new Promise((resolve) => setTimeout(resolve, contractSleepMs));
if (mode === "review") await reviewWork();

const injected = /^=== (.+?) \([0-9a-f]{12}\) ===$/m.exec(prompt);
const firstRead = mode === "review" ? reviewInput(prompt).delta?.[0]?.path || "README.md" : injected ? injected[1] : "README.md";
const resultMode = process.env.FAKE_CLAUDE_RESULT || "OK";
const rateLimited = resultMode === "RATE_LIMIT";
const cacheRead = Number(process.env.FAKE_CLAUDE_TOKENS || 150_346);
const streamMode = process.argv.includes("stream-json");
const typed = process.argv.includes("--json-schema");

const answers = { translation: translationAnswer, check: checkAnswer, review: reviewAnswer, writer: writerAnswer };

// FAKE_CLAUDE_EXTRA_TOOLS=<a,b> are tools no flag took away, as a connector --strict-mcp-config left
// would be. FAKE_CLAUDE_NO_INIT=1 leaves the init event out.
const extraTools = (process.env.FAKE_CLAUDE_EXTRA_TOOLS || "").split(",").filter(Boolean);
const lines = [
  ...(process.env.FAKE_CLAUDE_NO_INIT === "1" ? [] : [{
    type: "system", subtype: "init", session_id: sessionId, model: flag("--model") || "fake", permissionMode: flag("--permission-mode") || "default",
    tools: [...(flag("--tools") === null ? ["Bash", "Edit", "Read", "Write"] : flag("--tools").split(",").filter(Boolean)), ...extraTools], ...(maxTurns ? { max_turns: maxTurns } : {}),
  }]),
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
  // FAKE_CLAUDE_USAGE=none leaves out the writer's usage, so Bridge cannot read it.
  ...(process.env.FAKE_CLAUDE_USAGE === "none" && !translating ? {} : { modelUsage: { "fake-opus": { inputTokens: 94, cacheCreationInputTokens: 454, cacheReadInputTokens: cacheRead, outputTokens: 2352 } } }),
  result: rateLimited
    ? "usage limit reached; resets soon"
    : typed
      ? mode + " submitted"
      : [
          "[writer report]",
          "focused correction report call " + (process.env.FAKE_CLAUDE_CALL || "1"),
          "REVIEW_REQUIRED: true",
        ].join("\n"),
  ...(typed && !rateLimited ? { structured_output: answers[mode](prompt) } : {}),
};
if (streamMode) {
  for (const line of lines) process.stdout.write(JSON.stringify(line) + "\n");
  process.stdout.write(JSON.stringify(result) + "\n");
} else {
  process.stdout.write(JSON.stringify({ session_id: result.session_id, is_error: result.is_error, result: result.result, usage: result.usage, num_turns: result.num_turns }));
}
