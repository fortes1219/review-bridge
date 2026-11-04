// Fake Codex CLI (T0-05 D6.3). With `--output-schema` it answers a review.result built
// from the packet in the prompt and prints the `--json` event stream; without it, the
// legacy two gate lines. No model is involved.
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getBridgePaths } from "../../utils/paths.mjs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString("utf8");
const outputIndex = process.argv.indexOf("--output-last-message");
if (outputIndex < 0 || !process.argv[outputIndex + 1]) {
  process.stderr.write("missing --output-last-message\n");
  process.exit(2);
}
const usageEvents = (tokens) => [
  { type: "thread.started", thread_id: "fake-thread" },
  { type: "turn.started" },
  { type: "turn.completed", usage: { input_tokens: tokens, cached_input_tokens: Math.floor(tokens / 2), cache_write_input_tokens: 0, output_tokens: 410, reasoning_output_tokens: 0 } },
];

// The contract check: every condition judged faithful unless FAKE_CONTRACT_CHECK asks for one
// of the other outcomes the harness must handle. "_first" outcomes apply to attempt 1 only.
if (prompt.includes("[REVIEW_BRIDGE_MODE: CONTRACT_CHECK]")) {
  const mode = process.env.FAKE_CONTRACT_CHECK || "faithful";
  const attempt = Number(/Attempt: (\d+)/.exec(prompt)?.[1] || 1);
  const sha256 = /^Candidate: ([0-9a-f]{64})$/m.exec(prompt)?.[1] || "0".repeat(64);
  const open = prompt.indexOf("=== CANDIDATE CONDITIONS ===");
  const close = prompt.indexOf("=== END CANDIDATE CONDITIONS ===");
  const conditions = JSON.parse(prompt.slice(open + "=== CANDIDATE CONDITIONS ===".length, close));
  const wrong = mode === "unfaithful_always" || (mode === "unfaithful_first" && attempt === 1);
  const ids = conditions.map((item) => item.id);
  const answer = {
    event: "contract.check",
    candidate_sha256: sha256,
    acceptance: (mode === "skip_ac" ? ids.slice(0, -1) : ids).map((id, index) => ({
      id, faithful: !(wrong && index === 0), note: wrong && index === 0 ? "says more than its lines" : null,
    })),
    missing: mode === "missing_first" && attempt === 1 ? [{ source_refs: [{ start: 1, end: 1 }], note: "fake: a stated requirement was left out" }] : [],
    ambiguities: mode === "ambiguous" ? [{ question: "Which page should show the farm?", source_refs: [] }] : [],
    cannot_confirm: mode === "cannot_confirm",
    cannot_confirm_reason: mode === "cannot_confirm" ? "fake: the work order refers to a design not given" : null,
  };
  await fsp.writeFile(process.argv[outputIndex + 1], JSON.stringify(answer, null, 2), "utf8");
  // FAKE_CONTRACT_CHECK_USAGE=none leaves out turn.completed, so Bridge cannot read the usage.
  const events = usageEvents(Number(process.env.FAKE_CODEX_TOKENS || 12_000));
  for (const event of process.env.FAKE_CONTRACT_CHECK_USAGE === "none" ? events.slice(0, 2) : events) process.stdout.write(JSON.stringify(event) + "\n");
  process.exit(0);
}

if (!prompt.includes("You are the independent reviewer")) {
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
// FAKE_CODEX_SLEEP_MS keeps a review running, so a test can stop the run while it reads.
const reviewSleepMs = Number(process.env.FAKE_CODEX_SLEEP_MS || 0);
if (reviewSleepMs > 0) await new Promise((resolve) => setTimeout(resolve, reviewSleepMs));
// FAKE_CODEX_TOUCH=1 changes a project file while the review runs (a real reviewer is read-only;
// this stands for anything else changing the work meanwhile).
if (process.env.FAKE_CODEX_TOUCH === "1") await fsp.appendFile("README.md", "changed during the review\n");
// FAKE_CODEX_WINDOW_TAMPER=1 empties every call record and then fails the review, so the evidence
// check must run on the reviewer's failure path too.
if (process.env.FAKE_CODEX_WINDOW_TAMPER === "1") {
  const { readdir, readFile, writeFile } = fsp;
  const root = path.join(getBridgePaths(process.cwd(), path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."), { privateRootName: ".review-bridge" }).stateRoot, "workspace-evidence");
  for (const dir of await readdir(root).catch(() => [])) {
    for (const name of await readdir(root + "/" + dir + "/windows").catch(() => [])) {
      const file = root + "/" + dir + "/windows/" + name;
      await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), changed: [] }));
    }
  }
  process.stderr.write("fake reviewer failed after rewriting the call records\n");
  process.exit(2);
}
const openIds = (input.open_findings || []).map((finding) => finding.id);
const keep = process.env.FAKE_CODEX_KEEP || "";

function finding(id, severity, path) {
  return {
    id, severity, path, line: 1,
    reach: "fake call path", claim: "fake defect " + id, evidence: "fake evidence", fix: "fake fix", acceptance_ref: conditionIds[0] || null,
  };
}

// One verdict per contract condition in review.input. FAKE_CODEX_VERDICT picks the outcome Bridge
// must handle: "cannot_verify" or "fail_under_pass" on the first condition, "missing" drops the
// last, "no_evidence" passes the first with no evidence. A FAIL gate fails the first condition.
const conditionIds = (input.contract?.acceptance || []).map((item) => item.id);
function verdictsOutput() {
  const mode = process.env.FAKE_CODEX_VERDICT || "";
  const failing = gate === "FAIL" || gate === "HARD_STOP";
  const items = conditionIds.map((id, index) => {
    if (index === 0 && (failing || mode === "fail_under_pass")) return { id, verdict: "fail", evidence: "fake: blocked by the first finding" };
    if (index === 0 && mode === "cannot_verify") return { id, verdict: "cannot_verify", evidence: "fake: needs a browser to see it" };
    if (index === 0 && mode === "no_evidence") return { id, verdict: "pass", evidence: "" };
    return { id, verdict: "pass", evidence: "fake: read the delta and the test output for " + id };
  });
  return mode === "missing" ? items.slice(0, -1) : items;
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
      contract_sha256: process.env.FAKE_CODEX_CONTRACT === "other" ? "0".repeat(64) : input.contract_sha256 ?? null,
      call: input.call || 1,
      gate: gate === "PASS" || gate === "PASS_WITH_HIGH" ? "PASS" : "FAIL",
      hard_stop: gate === "HARD_STOP",
      hard_stop_reason: gate === "HARD_STOP" ? "needs_human_decision" : null,
      findings: gate === "FAIL_EMPTY" ? [] : findings,
      verified: ["fake: read the delta"],
      not_run: ["fake: project tests"],
      verdicts: verdictsOutput(),
    };
await fsp.writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");

const tokens = Number(process.env.FAKE_CODEX_TOKENS || 59_990);
const events = [
  { type: "thread.started", thread_id: "fake-thread" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "item_0", type: "command_execution", command: "bash -lc 'cat " + deltaPath + "'", exit_code: 0, status: "completed" } },
  { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "review.result submitted" } },
  { type: "turn.completed", usage: { input_tokens: tokens, cached_input_tokens: Math.floor(tokens / 2), cache_write_input_tokens: 0, output_tokens: 410, reasoning_output_tokens: 0 } },
];
// FAKE_CODEX_USAGE=none leaves out the review's usage, so Bridge cannot read it.
for (const event of process.env.FAKE_CODEX_USAGE === "none" ? events.slice(0, -1) : events) process.stdout.write(JSON.stringify(event) + "\n");
