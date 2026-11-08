// What the fake CLIs answer, whichever of them is in the role: a role's answer does not depend on
// the provider filling it. Every behaviour a test can bend through the environment is here. No model.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getBridgePaths } from "../../utils/paths.mjs";

// The project's state, outside the project, found the way Bridge finds it: a writer that tampers
// with Bridge's records reaches them there.
const stateRoot = () => getBridgePaths(process.cwd(), path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."), { privateRootName: ".review-bridge" }).stateRoot;

export function modeOf(prompt) {
  if (prompt.includes("[REVIEW_BRIDGE_MODE: WRITER_ONLY]")) return "writer";
  if (prompt.includes("You are the independent reviewer")) return "review";
  if (prompt.includes("sandbox self-test")) return "probe";
  return null;
}

// FAKE_CALL_LOG=<file>: one line per call, so a test can see which CLI each step really reached.
export function logCall(cli, mode, details = {}) {
  if (process.env.FAKE_CALL_LOG) fs.appendFileSync(process.env.FAKE_CALL_LOG, JSON.stringify({ cli, mode, args: process.argv.slice(2), ...details }) + "\n");
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// FAKE_CONTRACT_TAMPER=1 makes the writer rewrite the sealed contract file, as a model trying to
// change its own instructions would.
function tamperContract(sha) {
  if (process.env.FAKE_CONTRACT_TAMPER !== "1" || !sha) return;
  const file = path.join(stateRoot(), "contracts", sha + ".json");
  const contract = JSON.parse(fs.readFileSync(file, "utf8"));
  contract.acceptance = [];
  fs.writeFileSync(file, JSON.stringify(contract, null, 2) + "\n");
}

// One entry per contract condition in task.input. FAKE_WRITER_CRITERIA bends it the ways the
// harness must refuse: "missing" drops the last, "duplicate" repeats the first, "open" leaves
// the first not done while the status stays done.
function criteriaOutput(prompt) {
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
export function writerAnswer(prompt) {
  const injected = /^=== (.+?) \([0-9a-f]{12}\) ===$/m.exec(prompt);
  const firstRead = injected ? injected[1] : "README.md";
  const resultMode = process.env.FAKE_CLAUDE_RESULT || "OK";
  const workOrder = /"work_order": "([^"]+)"/.exec(prompt)?.[1] || "unknown";
  const contractSha = /"contract_sha256": "([0-9a-f]{64})"/.exec(prompt)?.[1] || null;
  tamperContract(contractSha);
  const evidenceRoot = path.join(stateRoot(), "workspace-evidence");
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
    const runsDir = path.join(stateRoot(), "runs");
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
    // FAKE_WRITER_STATUS and FAKE_WRITER_UNVERIFIED: the writer's own report, as a writer that could not check something gives it.
    status: process.env.FAKE_WRITER_STATUS || (resultMode === "BLOCKED" ? "blocked" : "done"),
    changed: [{ path: firstRead, action: "modified", summary: "fake edit for call " + call }],
    verification: [{ command: "node --version", exit_code: 0, summary: "fake check" }],
    unverified: process.env.FAKE_WRITER_UNVERIFIED ? [process.env.FAKE_WRITER_UNVERIFIED] : [],
    needs_human: resultMode === "NEEDS_HUMAN" || process.env.FAKE_WRITER_ASKS === "1" ? [{ question: "which colour?", options: ["red", "blue"] }] : [],
    addressed_findings: [...new Set(addressed)],
    criteria: criteriaOutput(prompt),
  };
}

export function reviewInput(prompt) {
  const open = prompt.indexOf("=== review.input ===");
  const close = prompt.indexOf("=== end review.input ===");
  return open >= 0 && close > open ? JSON.parse(prompt.slice(open + "=== review.input ===".length, close)) : {};
}

// What a review does while it runs, and the file its answer lands on. Failing exits here.
export async function reviewWork() {
  // FAKE_CODEX_SLEEP_MS keeps a review running, so a test can stop the run while it reads.
  const reviewSleepMs = Number(process.env.FAKE_CODEX_SLEEP_MS || 0);
  if (reviewSleepMs > 0) await pause(reviewSleepMs);
  // FAKE_CODEX_TOUCH=1 changes a project file while the review runs (a real reviewer is read-only;
  // this stands for anything else changing the work meanwhile).
  if (process.env.FAKE_CODEX_TOUCH === "1") fs.appendFileSync("README.md", "changed during the review\n");
  // FAKE_CODEX_WINDOW_TAMPER=1 empties every call record and then fails the review, so the evidence
  // check must run on the reviewer's failure path too.
  if (process.env.FAKE_CODEX_WINDOW_TAMPER === "1") {
    const root = path.join(stateRoot(), "workspace-evidence");
    for (const dir of fs.existsSync(root) ? fs.readdirSync(root) : []) {
      const windows = path.join(root, dir, "windows");
      for (const name of fs.existsSync(windows) ? fs.readdirSync(windows) : []) {
        const file = path.join(windows, name);
        fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), changed: [] }));
      }
    }
    process.stderr.write("fake reviewer failed after rewriting the call records\n");
    process.exit(2);
  }
}

// FAKE_ON_<what>=<text>: this behaviour only for a work order whose text carries <text>, so one work
// order of a directory can differ from the others.
export const fakeOn = (prompt, what) => Boolean(process.env["FAKE_ON_" + what]) && prompt.includes(process.env["FAKE_ON_" + what]);

export function reviewAnswer(prompt) {
  const input = reviewInput(prompt);
  // FAKE_ON_REVIEW_FAIL: the reviewer fails this one work order.
  const gate = fakeOn(prompt, "REVIEW_FAIL") ? "FAIL" : process.env.FAKE_CODEX_GATE || "PASS";
  const deltaPath = input.delta?.[0]?.path || input.read_list?.[0]?.path || "README.md";
  const openIds = (input.open_findings || []).map((finding) => finding.id);
  const keep = process.env.FAKE_CODEX_KEEP || "";
  const conditionIds = (input.contract?.acceptance || []).map((item) => item.id);
  const finding = (id, severity, file) => ({
    id, severity, path: file, line: 1,
    reach: "fake call path", claim: "fake defect " + id, evidence: "fake evidence", fix: "fake fix", acceptance_ref: conditionIds[0] || null,
  });
  // One verdict per contract condition in review.input. FAKE_CODEX_VERDICT picks the outcome Bridge
  // must handle: "cannot_verify" or "fail_under_pass" on the first condition, "missing" drops the
  // last, "no_evidence" passes the first with no evidence. A FAIL gate fails the first condition.
  const verdictsOutput = () => {
    const mode = process.env.FAKE_CODEX_VERDICT || "";
    const failing = gate === "FAIL" || gate === "HARD_STOP";
    const items = conditionIds.map((id, index) => {
      if (index === 0 && (failing || mode === "fail_under_pass")) return { id, verdict: "fail", evidence: "fake: blocked by the first finding" };
      if (index === 0 && mode === "cannot_verify") return { id, verdict: "cannot_verify", evidence: "fake: needs a browser to see it" };
      if (index === 0 && mode === "no_evidence") return { id, verdict: "pass", evidence: "" };
      return { id, verdict: "pass", evidence: "fake: read the delta and the test output for " + id };
    });
    return mode === "missing" ? items.slice(0, -1) : items;
  };
  let findings = [];
  if (gate === "FAIL" || gate === "HARD_STOP") {
    // A kept id survives the correction; otherwise the next free id lands on a delta file.
    if (keep && openIds.includes(keep)) findings = [finding(keep, "HIGH", input.open_findings.find((entry) => entry.id === keep).path)];
    else findings = [finding("F" + (openIds.length + 1), "HIGH", deltaPath)];
  } else if (gate === "PASS_WITH_HIGH") {
    findings = [finding("F9", "HIGH", deltaPath)];
  }
  if (gate === "MALFORMED") return { event: "review.result", gate: "MAYBE" };
  // PASS_HARD_STOP: a PASS that asks for a hard stop, which the review's rules forbid (run f645ccf5).
  // PASS_HARD_STOP_ONCE: only until Bridge asks again with what was wrong (previous_answer_problems).
  const passStop = gate === "PASS_HARD_STOP" || (gate === "PASS_HARD_STOP_ONCE" && !input.previous_answer_problems);
  const passing = gate === "PASS" || gate === "PASS_WITH_HIGH" || gate === "PASS_HARD_STOP" || gate === "PASS_HARD_STOP_ONCE";
  return {
    event: "review.result",
    work_order: input.work_order || "unknown",
    contract_sha256: process.env.FAKE_CODEX_CONTRACT === "other" ? "0".repeat(64) : input.contract_sha256 ?? null,
    call: input.call || 1,
    gate: passing ? "PASS" : "FAIL",
    hard_stop: gate === "HARD_STOP" || passStop,
    hard_stop_reason: gate === "HARD_STOP" || passStop ? "needs_human_decision" : null,
    findings: gate === "FAIL_EMPTY" ? [] : findings,
    verified: ["fake: read the delta"],
    not_run: ["fake: project tests"],
    verdicts: verdictsOutput(),
  };
}
