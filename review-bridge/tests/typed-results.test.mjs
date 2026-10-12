import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { enqueueReview } from "../core/queue.mjs";
import {
  controllerScopeResult,
  parseCodexJsonl,
  pathFromCommand,
  recheckFindings,
  reviewerUsageEvent,
  validateReviewResult,
  validateWriterResult,
  writerClaimMismatch,
  writerResultFromClaudeResult,
} from "../core/typed-results.mjs";

function writerResult(overrides = {}) {
  return {
    event: "writer.result", work_order: "wo-1", call: 1, status: "done",
    changed: [{ path: "src/a.js", action: "modified", summary: "x" }],
    verification: [{ command: "npm test", exit_code: 0, summary: "ok" }],
    unverified: [], needs_human: [], addressed_findings: [],
    ...overrides,
  };
}

function finding(id, overrides = {}) {
  return { id, severity: "HIGH", path: "src/a.js", line: 3, reach: "r", claim: "c", evidence: "e", fix: "f", acceptance_ref: null, ...overrides };
}

function reviewResult(overrides = {}) {
  return { event: "review.result", work_order: "wo-1", call: 1, gate: "FAIL", hard_stop: false, hard_stop_reason: null, findings: [finding("F1")], verified: [], not_run: [], ...overrides };
}

async function workspace(t) {
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-typed-"));
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  await fsp.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fsp.writeFile(path.join(repoRoot, "src", "a.js"), "a\n");
  await fsp.writeFile(path.join(repoRoot, "src", "b.js"), "b\n");
  return repoRoot;
}

test("Q1 writer.result: the schema and the call identity are checked, nothing else", async () => {
  assert.equal((await validateWriterResult(writerResult(), { workOrder: "wo-1", call: 1 })).ok, true);
  const wrongCall = await validateWriterResult(writerResult({ call: 2 }), { workOrder: "wo-1", call: 1 });
  assert.deepEqual(wrongCall.errors, ["$.call: expected 1"]);
  const missing = await validateWriterResult({ event: "writer.result", work_order: "wo-1" }, { workOrder: "wo-1", call: 1 });
  assert.ok(missing.errors.includes("$: missing call"));
  const extra = await validateWriterResult(writerResult({ notes: "prose" }), { workOrder: "wo-1", call: 1 });
  assert.deepEqual(extra.errors, ["$: unexpected notes"]);
  const long = await validateWriterResult(writerResult({ unverified: ["x".repeat(121)] }), { workOrder: "wo-1", call: 1 });
  assert.match(long.errors[0], /unverified\[0\]: longer than 120/);
  assert.equal((await validateWriterResult(null, { workOrder: "wo-1", call: 1 })).ok, false);
  assert.equal((await validateWriterResult(writerResult({ addressed_findings: ["H-1"] }), { workOrder: "wo-1", call: 1 })).ok, false);
});

test("Q1b the typed answer comes only from structured_output; a result text that is the object is not accepted", () => {
  assert.equal(writerResultFromClaudeResult({ structured_output: writerResult(), result: "ignored" }).event, "writer.result");
  assert.equal(writerResultFromClaudeResult({ result: JSON.stringify(writerResult()) }), null);
  assert.equal(writerResultFromClaudeResult({ result: "prose\nCODEX_REVIEW_REQUIRED: true" }), null);
  assert.equal(writerResultFromClaudeResult({ structured_output: [1] }), null);
  assert.equal(writerResultFromClaudeResult(null), null);
});

test("Q1c the writer's claims are compared with the delta in both directions", () => {
  const mismatch = writerClaimMismatch(writerResult({ changed: [{ path: "src/a.js", action: "modified", summary: "" }, { path: "./src/c.js", action: "added", summary: "" }] }),
    [{ path: "src/a.js", change: "modified" }, { path: "src/b.js", change: "modified" }]);
  assert.deepEqual(mismatch, { claimed_not_in_delta: ["src/c.js"], delta_not_claimed: ["src/b.js"] });
});

test("Q5 review.result: schema, FAIL needs a finding, PASS carries no HIGH, paths must exist, hard_stop needs a reason", async (t) => {
  const repoRoot = await workspace(t);
  const base = { workOrder: "wo-1", call: 1, repoRoot };
  assert.equal((await validateReviewResult(reviewResult(), base)).ok, true);
  assert.deepEqual((await validateReviewResult(reviewResult({ findings: [] }), base)).errors, ["$.findings: FAIL needs at least one finding"]);
  assert.deepEqual((await validateReviewResult(reviewResult({ gate: "PASS" }), base)).errors, ["$.findings: PASS cannot carry a HIGH finding"]);
  assert.equal((await validateReviewResult(reviewResult({ gate: "PASS", findings: [finding("F1", { severity: "MEDIUM" })] }), base)).ok, true);
  assert.deepEqual((await validateReviewResult(reviewResult({ hard_stop: true }), base)).errors, ["$.hard_stop_reason: required when hard_stop is true"]);
  assert.deepEqual((await validateReviewResult(reviewResult({ hard_stop_reason: "release_action" }), base)).errors, ["$.hard_stop_reason: must be null when hard_stop is false"]);
  // A PASS that also asks for a hard stop is a contradiction, never a pass.
  const passStop = await validateReviewResult(reviewResult({ gate: "PASS", findings: [], hard_stop: true, hard_stop_reason: "release_action" }), base);
  assert.deepEqual(passStop.errors, ["$.hard_stop: PASS cannot request a hard stop"]);
  assert.match((await validateReviewResult(reviewResult({ findings: [finding("F1", { path: "src/none.js" })] }), base)).errors[0], /not in workspace/);
  // The path must be a relative file inside the workspace: no `..`, no absolute, no directory.
  const escaped = path.basename(repoRoot) + "/../" + path.basename(repoRoot) + "/src/a.js";
  for (const [bad, reason] of [
    ["../" + escaped, /escapes/], [repoRoot.replaceAll("\\", "/") + "/src/a.js", /not a relative path/], ["src", /not a file/],
    ["/src/a.js", /not a relative path/], ["src/./a.js", /not normalized/], ["./src/a.js", /not normalized/], ["src\\a.js", /not normalized/], ["src/a.js/.", /not normalized/],
  ]) {
    assert.match((await validateReviewResult(reviewResult({ findings: [finding("F1", { path: bad })] }), base)).errors[0], reason, bad);
  }
  assert.match((await validateReviewResult(reviewResult({ findings: [finding("F1"), finding("F1")] }), base)).errors[0], /duplicate F1/);
  assert.match((await validateReviewResult(reviewResult({ gate: "MAYBE" }), base)).errors[0], /gate: must be one of/);
  assert.match((await validateReviewResult(reviewResult({ findings: [finding("F1", { line: 0 })] }), base)).errors[0], /line: below 1/);
  assert.equal((await validateReviewResult("REVIEW_GATE: PASS", base)).ok, false);
  // D4.3: on a recheck a new id must land on a delta file; a surviving id may stay where it was.
  const recheck = { ...base, call: 2, previousFindings: [finding("F1", { path: "src/b.js" })], deltaPaths: ["src/a.js"] };
  assert.equal((await validateReviewResult(reviewResult({ call: 2, findings: [finding("F1", { path: "src/b.js" })] }), recheck)).ok, true);
  assert.match((await validateReviewResult(reviewResult({ call: 2, findings: [finding("F2", { path: "src/b.js" })] }), recheck)).errors[0], /outside the delta/);
});

test("Q6 scope violations become a controller-decided hard stop with HIGH findings", () => {
  const result = controllerScopeResult({ workOrder: "wo-1", call: 1, scopeViolations: [".env", "lib/x.js"] });
  assert.equal(result.gate, "FAIL");
  assert.equal(result.hard_stop, true);
  assert.equal(result.hard_stop_reason, "scope_expansion");
  assert.deepEqual(result.findings.map((entry) => [entry.id, entry.severity, entry.path, entry.source]), [["F1", "HIGH", ".env", "controller"], ["F2", "HIGH", "lib/x.js", "controller"]]);
});

test("Q7 recheck: ids missing are resolved, ids present are unresolved, the rest are new", () => {
  const previous = [finding("F1"), finding("F2")];
  const current = [finding("F2"), finding("F3")];
  assert.deepEqual(recheckFindings(previous, current), { resolved: ["F1"], unresolved: ["F2"], new: ["F3"] });
  assert.deepEqual(recheckFindings([], current), { resolved: [], unresolved: [], new: ["F2", "F3"] });
});

test("Q8 the codex --json stream gives usage and commands; cached tokens are not counted twice", () => {
  const text = [
    JSON.stringify({ type: "thread.started", thread_id: "t" }),
    "not json",
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "bash -lc 'sed -n 1,40p src/a.js'" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "x" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 } }),
  ].join("\n");
  const stream = parseCodexJsonl(text);
  assert.equal(stream.unparsable_lines, 1);
  assert.deepEqual(stream.commands, ["bash -lc 'sed -n 1,40p src/a.js'"]);
  assert.equal(pathFromCommand(stream.commands[0]), "src/a.js");
  assert.equal(pathFromCommand("bash -lc 'ls -la'"), null);
  const usage = reviewerUsageEvent({ usage: stream.usage, trailerTokens: 9, call: 1, durationMs: 5 });
  assert.deepEqual(usage.tokens, { input: 600, cache_write: 0, cache_read: 400, output: 50 });
  assert.equal(usage.source, "cli_json");
  // The real codex-cli 0.162 shape (2026-10-13 sample), with a non-zero cache write added.
  // Both cache parts sit inside input_tokens, so plain input is the remainder and the total is counted once.
  const real = reviewerUsageEvent({ usage: { input_tokens: 15573, cached_input_tokens: 12544, output_tokens: 5, cache_write_input_tokens: 700, reasoning_output_tokens: 0 }, call: 1, durationMs: 5 });
  assert.deepEqual(real.tokens, { input: 2329, cache_write: 700, cache_read: 12544, output: 5 });
  assert.equal(real.anomaly, undefined);
  // Parts larger than the total are recorded as an anomaly, not floored in silence.
  const odd = reviewerUsageEvent({ usage: { input_tokens: 100, cached_input_tokens: 90, cache_write_input_tokens: 20, output_tokens: 1 }, call: 1, durationMs: 5 });
  assert.deepEqual(odd.tokens, { input: 0, cache_write: 20, cache_read: 90, output: 1 });
  assert.equal(odd.anomaly, "cache_parts_exceed_input_tokens");
  assert.equal(odd.raw_usage.input_tokens, 100);
  const trailer = reviewerUsageEvent({ usage: null, trailerTokens: 65580, call: 1, durationMs: 5 });
  assert.equal(trailer.source, "cli_trailer");
  assert.equal(trailer.tokens.input, 65580);
  assert.equal(reviewerUsageEvent({ usage: null, trailerTokens: undefined, call: 1, durationMs: 5 }).parse_error, true);
});

test("Q10 a Stop-hook message during a v4 run is not a submission: harness_driven, no job", async (t) => {
  const repoRoot = await workspace(t);
  const control = { authorization_status: "active", active_claude_session: "s-1", v4: { run_id: "run-1" } };
  const payload = { session_id: "s-1", cwd: repoRoot, stop_hook_active: false, last_assistant_message: "CODEX_REVIEW_REQUIRED: true\nreport" };
  const result = await enqueueReview({ payload, paths: { repoRoot }, control });
  assert.deepEqual(result, { accepted: false, reason: "harness_driven" });
});
