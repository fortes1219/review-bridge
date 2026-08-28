const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString("utf8");
const resumeIndex = process.argv.indexOf("--resume");
const sessionIndex = process.argv.indexOf("--session-id");
const sessionId = resumeIndex >= 0
  ? process.argv[resumeIndex + 1]
  : sessionIndex >= 0 ? process.argv[sessionIndex + 1] : "";
if (!sessionId || !prompt.includes("[REVIEW_BRIDGE_MODE: WRITER_ONLY]")) {
  process.stderr.write("writer-only resume contract missing\n");
  process.exit(2);
}
const rateLimited = process.env.FAKE_CLAUDE_RESULT === "RATE_LIMIT";
const result = {
  session_id: sessionId,
  is_error: rateLimited,
  result: rateLimited
    ? "usage limit reached; resets soon"
    : [
        "[Claude -> Codex report]",
        "focused correction report call " + (process.env.FAKE_CLAUDE_CALL || "1"),
        "CODEX_REVIEW_REQUIRED: true",
      ].join("\n"),
};
process.stdout.write(JSON.stringify(result));
