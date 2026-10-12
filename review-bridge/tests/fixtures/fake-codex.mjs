// Fake Codex CLI (T0-05 D6.3). With `--output-schema` it answers a review.result built
// from the packet in the prompt and prints the `--json` event stream; without it, the
// legacy two gate lines. No model is involved.
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
const typed = process.argv.includes("--output-schema");
const outputPath = process.argv[outputIndex + 1];

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

const open = prompt.indexOf("=== review.input ===");
const close = prompt.indexOf("=== end review.input ===");
const input = open >= 0 && close > open ? JSON.parse(prompt.slice(open + "=== review.input ===".length, close)) : {};
const deltaPath = input.delta?.[0]?.path || input.read_list?.[0]?.path || "README.md";
const openIds = (input.open_findings || []).map((finding) => finding.id);
const keep = process.env.FAKE_CODEX_KEEP || "";

function finding(id, severity, path) {
  return {
    id, severity, path, line: 1,
    reach: "fake call path", claim: "fake defect " + id, evidence: "fake evidence", fix: "fake fix", acceptance_ref: 1,
  };
}

let findings = [];
if (gate === "FAIL" || gate === "HARD_STOP") {
  // A kept id survives the correction; otherwise the next free id lands on a delta file.
  if (keep && openIds.includes(keep)) findings = [finding(keep, "HIGH", input.open_findings.find((entry) => entry.id === keep).path)];
  else findings = [finding("F" + (openIds.length + 1), "HIGH", deltaPath)];
} else if (gate === "PASS_WITH_HIGH") {
  findings = [finding("F9", "HIGH", deltaPath)];
}

const result = gate === "MALFORMED"
  ? { event: "review.result", gate: "MAYBE" }
  : {
      event: "review.result",
      work_order: input.work_order || "unknown",
      call: input.call || 1,
      gate: gate === "PASS" || gate === "PASS_WITH_HIGH" ? "PASS" : "FAIL",
      hard_stop: gate === "HARD_STOP",
      hard_stop_reason: gate === "HARD_STOP" ? "needs_human_decision" : null,
      findings: gate === "FAIL_EMPTY" ? [] : findings,
      verified: ["fake: read the delta"],
      not_run: ["fake: project tests"],
    };
await fsp.writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");

const tokens = Number(process.env.FAKE_CODEX_TOKENS || 59_990);
const events = [
  { type: "thread.started", thread_id: "fake-thread" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "item_0", type: "command_execution", command: "bash -lc 'cat " + deltaPath + "'", exit_code: 0, status: "completed" } },
  { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "review.result submitted" } },
  { type: "turn.completed", usage: { input_tokens: tokens, cached_input_tokens: Math.floor(tokens / 2), output_tokens: 410 } },
];
for (const event of events) process.stdout.write(JSON.stringify(event) + "\n");
