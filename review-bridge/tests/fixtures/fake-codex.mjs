import fsp from "node:fs/promises";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString("utf8");
const outputIndex = process.argv.indexOf("--output-last-message");
if (outputIndex < 0 || !process.argv[outputIndex + 1]) {
  process.stderr.write("missing --output-last-message\n");
  process.exit(2);
}
if (!prompt.includes("Claude")) {
  process.stderr.write("review prompt did not reach fake Codex\n");
  process.exit(3);
}
const gate = process.env.FAKE_CODEX_GATE || "PASS";
const body = gate === "MALFORMED"
  ? "review completed without controller gate lines\n"
  : [
      "# Fake Codex Review",
      "",
      "HARD_STOP_REQUIRED: " + (gate === "HARD_STOP" ? "true" : "false"),
      "REVIEW_GATE: " + (gate === "PASS" ? "PASS" : "FAIL"),
      "",
    ].join("\n");
await fsp.writeFile(process.argv[outputIndex + 1], body, "utf8");
process.stdout.write("fake codex completed\n");

