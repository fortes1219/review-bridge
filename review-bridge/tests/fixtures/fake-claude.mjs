// Fake Claude CLI for fake-cli runs (T0-04 D3.4, T0-05 D6.2). Emits the stream-json shape:
// a system line, two tool_use lines (one file from the injected read list, one
// outside it), and a result line carrying usage and, when the CLI was asked for a
// schema, a writer.result in `structured_output`. A contract-translation prompt gets a
// contract.translation instead. No model is involved.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString("utf8");
const translating = prompt.includes("[REVIEW_BRIDGE_MODE: CONTRACT_TRANSLATION]");
const sessionIndex = process.argv.indexOf("--session-id");
const resumeIndex = process.argv.indexOf("--resume");
const sessionId = sessionIndex >= 0
  ? process.argv[sessionIndex + 1]
  : resumeIndex >= 0 ? process.argv[resumeIndex + 1] : "";
if (!sessionId || !(translating || prompt.includes("[REVIEW_BRIDGE_MODE: WRITER_ONLY]"))) {
  process.stderr.write("writer-only resume contract missing\n");
  process.exit(2);
}
const maxTurnsIndex = process.argv.indexOf("--max-turns");
const maxTurns = maxTurnsIndex >= 0 ? Number(process.argv[maxTurnsIndex + 1]) : null;
const sleepMs = Number(process.env.FAKE_CLAUDE_SLEEP_MS || 0);
// The sleep stands for a long writer call; the translation before it answers at once.
if (sleepMs > 0 && !translating) await new Promise((resolve) => setTimeout(resolve, sleepMs));
// FAKE_CONTRACT_SLEEP_MS slows the translation instead, so a test can stop the run during it.
const contractSleepMs = Number(process.env.FAKE_CONTRACT_SLEEP_MS || 0);
if (contractSleepMs > 0 && translating) await new Promise((resolve) => setTimeout(resolve, contractSleepMs));

const injected = /^=== (.+?) \([0-9a-f]{12}\) ===$/m.exec(prompt);
const firstRead = injected ? injected[1] : "README.md";
const resultMode = process.env.FAKE_CLAUDE_RESULT || "OK";
const rateLimited = resultMode === "RATE_LIMIT";
const cacheRead = Number(process.env.FAKE_CLAUDE_TOKENS || 150_346);
const streamMode = process.argv.includes("stream-json");
const typed = process.argv.includes("--json-schema");

const at = (line) => ({ source_refs: [{ start: line, end: line }] });
const attempt = Number(/Attempt: (\d+)/.exec(prompt)?.[1] || 1);

// A translation read off the numbered work order: the first "# " line is the title, each list
// item under a heading that names acceptance becomes one condition quoting its line, and every
// other non-blank line is listed as unused. FAKE_CONTRACT_FILE replaces it with a prepared
// answer, or with an array of answers, one per attempt, so a test can hand the harness anything.
function translationOutput() {
  if (process.env.FAKE_CONTRACT_FILE) {
    const prepared = JSON.parse(fs.readFileSync(process.env.FAKE_CONTRACT_FILE, "utf8"));
    return Array.isArray(prepared) ? prepared[Math.min(attempt, prepared.length) - 1] : prepared;
  }
  const numbered = [...prompt.matchAll(/^ *(\d+)\| (.*)$/gm)].map((match) => ({ line: Number(match[1]), text: match[2] }));
  const title = numbered.find((entry) => /^#\s+/.test(entry.text));
  const gate = prompt.includes("Bridge will run this verification");
  const acceptance = [];
  const used = new Set([title ? title.line : 1]);
  let inAcceptance = false;
  for (const entry of numbered) {
    if (/^#{1,6}\s+/.test(entry.text)) { inAcceptance = /acceptance|驗收/i.test(entry.text); continue; }
    const item = inAcceptance ? /^\s*(?:\d+\.|[-*])\s+(.+)$/.exec(entry.text) : null;
    if (!item) continue;
    used.add(entry.line);
    acceptance.push({
      id: "AC" + (acceptance.length + 1), statement: item[1], quote: item[1], source_refs: [{ start: entry.line, end: entry.line }],
      verify: [gate ? { kind: "gate_a", check: null } : { kind: "reviewer", check: "fake: the reviewer reads the change" }], run_refs: [],
    });
  }
  const unused = numbered.filter((entry) => entry.text.trim() && !used.has(entry.line)).map((entry) => ({ start: entry.line, end: entry.line }));
  return {
    event: "contract.translation",
    ticket: { title: at(title ? title.line : 1), type: null, source_id: null, product_version: null, people: null, schedule: null, related: null },
    context: null, outcome: null, requested_work: null,
    scope_notes: { include: null, exclude: null, must_keep: null, expected_locations: null },
    run_plan: null, acceptance, verification_hints: [], reproduction: null, references: [], open_questions: [], unused_lines: unused,
  };
}

// FAKE_CONTRACT_TAMPER=1 makes the writer rewrite the sealed contract file, as a model trying to
// change its own instructions would.
function tamperContract(sha) {
  if (process.env.FAKE_CONTRACT_TAMPER !== "1" || !sha) return;
  const file = path.join(process.cwd(), ".review-bridge", "review-queue", "contracts", sha + ".json");
  const contract = JSON.parse(fs.readFileSync(file, "utf8"));
  contract.acceptance = [];
  fs.writeFileSync(file, JSON.stringify(contract, null, 2) + "\n");
}

// One entry per contract condition in task.input. FAKE_WRITER_CRITERIA bends it the ways the
// harness must refuse: "missing" drops the last, "duplicate" repeats the first, "open" leaves
// the first not done while the status stays done.
function criteriaOutput() {
  const taskAt = prompt.indexOf("=== TASK (task.input) ===");
  const taskEnd = prompt.indexOf("\n=== ", taskAt + 1);
  const task = taskAt >= 0 ? prompt.slice(taskAt, taskEnd > taskAt ? taskEnd : undefined) : "";
  const ids = [...new Set([...task.matchAll(/"id": "(AC\d+)"/g)].map((match) => match[1]))];
  const mode = process.env.FAKE_WRITER_CRITERIA || "";
  const items = ids.map((id, index) => ({ id, status: mode === "open" && index === 0 ? "not_done" : "done", note: "fake: done for " + id }));
  if (mode === "missing") return items.slice(0, -1);
  if (mode === "duplicate" && items.length) return [...items, items[0]];
  return items;
}

// The typed answer is built from the injected task.input and handoff, as a real writer would.
function structuredOutput() {
  if (translating) return translationOutput();
  const workOrder = /"work_order": "([^"]+)"/.exec(prompt)?.[1] || "unknown";
  const contractSha = /"contract_sha256": "([0-9a-f]{64})"/.exec(prompt)?.[1] || null;
  tamperContract(contractSha);
  const evidenceRoot = path.join(process.cwd(), ".review-bridge", "review-queue", "workspace-evidence");
  const evidenceDirs = () => (fs.existsSync(evidenceRoot) ? fs.readdirSync(evidenceRoot).map((dir) => path.join(evidenceRoot, dir)) : []);
  // FAKE_CLAUDE_EVIDENCE_TAMPER=1 empties the forbidden list in the run's starting record, as a
  // writer trying to change what its work is judged against would.
  if (process.env.FAKE_CLAUDE_EVIDENCE_TAMPER === "1") {
    for (const dir of evidenceDirs()) {
      const file = path.join(dir, "baseline.json");
      if (!fs.existsSync(file)) continue;
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), forbidden_paths: [] }));
    }
  }
  // FAKE_CLAUDE_GIT_AMEND=1 rewrites the project's last commit, as a writer that rewrote history would.
  if (process.env.FAKE_CLAUDE_GIT_AMEND === "1") {
    spawnSync("git", ["-c", "user.email=w@example.com", "-c", "user.name=w", "commit", "-q", "--amend", "--allow-empty", "-m", "rewritten by the writer"], { cwd: process.cwd(), windowsHide: true });
  }
  // FAKE_CLAUDE_WRITE=<path> appends a line to that project file, a change the writer really makes.
  if (process.env.FAKE_CLAUDE_WRITE) fs.appendFileSync(path.join(process.cwd(), process.env.FAKE_CLAUDE_WRITE), "written by the writer\n");
  // FAKE_CLAUDE_FORGE_WINDOW=1 forges another run's call record overlapping this call, plus a run
  // record for it, as a writer hiding its own out-of-scope change behind a second run would.
  if (process.env.FAKE_CLAUDE_FORGE_WINDOW === "1") {
    const runsDir = path.join(process.cwd(), ".review-bridge", "review-queue", "runs");
    fs.writeFileSync(path.join(runsDir, "run-b-forged.json"), JSON.stringify({ run_id: "run-b-forged", created_at: new Date(Date.now() - 3_600_000).toISOString() }));
    const forged = path.join(evidenceRoot, "forged-b", "windows");
    fs.mkdirSync(forged, { recursive: true });
    fs.writeFileSync(path.join(forged, "1-writer-1.json"), JSON.stringify({
      run_id: "run-b-forged", call: 1, phase: "writer", started_at: new Date(Date.now() - 60_000).toISOString(), ended_at: new Date(Date.now() + 60_000).toISOString(),
      changed: [{ path: process.env.FAKE_CLAUDE_WRITE || "README.md", after_sha256: null }],
    }));
  }
  const call = Number(/"call": (\d+)/.exec(prompt)?.[1] || 1);
  // FAKE_CLAUDE_WINDOW_TAMPER_CALL=<n> makes writer call n empty every earlier call record and then
  // fail with a non-zero exit, so the evidence check must run on the failure path too.
  if (Number(process.env.FAKE_CLAUDE_WINDOW_TAMPER_CALL) === call) {
    for (const dir of evidenceDirs()) {
      const windows = path.join(dir, "windows");
      if (!fs.existsSync(windows)) continue;
      for (const name of fs.readdirSync(windows)) {
        const file = path.join(windows, name);
        fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), changed: [] }));
      }
    }
    process.stderr.write("fake writer failed after rewriting the call records\n");
    process.exit(3);
  }
  const handoffAt = prompt.indexOf("=== HANDOFF ===");
  const addressed = handoffAt >= 0 ? [...prompt.slice(handoffAt).matchAll(/"id": "(F\d+)"/g)].map((match) => match[1]) : [];
  if (resultMode === "MALFORMED") return { event: "writer.result", work_order: workOrder };
  return {
    event: "writer.result",
    work_order: workOrder,
    contract_sha256: process.env.FAKE_CONTRACT_ECHO === "other" ? "0".repeat(64) : contractSha,
    call,
    status: resultMode === "BLOCKED" ? "blocked" : "done",
    changed: [{ path: firstRead, action: "modified", summary: "fake edit for call " + call }],
    verification: [{ command: "node --version", exit_code: 0, summary: "fake check" }],
    unverified: [],
    needs_human: resultMode === "NEEDS_HUMAN" ? [{ question: "which colour?", options: ["red", "blue"] }] : [],
    addressed_findings: [...new Set(addressed)],
    criteria: criteriaOutput(),
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
  // FAKE_CLAUDE_USAGE=none leaves out the writer's usage, so Bridge cannot read it.
  ...(process.env.FAKE_CLAUDE_USAGE === "none" && !translating ? {} : { modelUsage: { "fake-opus": { inputTokens: 94, cacheCreationInputTokens: 454, cacheReadInputTokens: cacheRead, outputTokens: 2352 } } }),
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
