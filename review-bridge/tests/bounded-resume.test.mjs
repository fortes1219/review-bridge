import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runBoundedResume } from "../features/workOrder/writerLoop.mjs";
import { readIoEvents } from "../service/records/ioEvents.mjs";
import { fileExists, readJson, writeJson } from "../service/records/fileStore.mjs";
import { getBridgePaths } from "../utils/paths.mjs";
import { createRunRuntimeState, readRun } from "../service/records/runStore.mjs";
import {
  authorizeV4WorkPackage,
  createV4WorkPackagePlan,
  v4WorkPackageStatus,
} from "../features/workOrder/workPackage.mjs";

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CODEX_LIMIT_STDERR = "tool output\nERROR: You’ve hit your usage limit. Upgrade to Pro "
  + "(https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more "
  + "credits or try again at Oct 10th, 2026 1:00 AM.\ntokens used\n65,580\n";

const STALE_JOB_ID = "20000101T000000000Z-0000000000000000";

const fakeClaudeSource = `
import fsp from "node:fs/promises";
import path from "node:path";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const args = process.argv;
const at = args.indexOf("--session-id") >= 0 ? args.indexOf("--session-id") : args.indexOf("--resume");
const session = args[at + 1];
const mode = process.env.T_CLAUDE;
if (process.env.T_ARGS_OUT) await fsp.writeFile(process.env.T_ARGS_OUT, JSON.stringify(args.slice(2)));
// T0-05: a v4 run asks for a schema; the typed answer is built from the injected task.input.
const call = Number(/"call": (\\d+)/.exec(prompt)?.[1] || 1);
const handoffAt = prompt.indexOf("=== HANDOFF ===");
const addressed = handoffAt >= 0 ? [...prompt.slice(handoffAt).matchAll(/"id": "(F\\d+)"/g)].map((m) => m[1]) : [];
const writerResult = process.env.T_WRITER === "malformed" ? { event: "writer.result" } : {
  event: "writer.result", work_order: "s2-04-fixture", call, status: process.env.T_WRITER === "blocked" ? "blocked" : "done",
  changed: [{ path: "README.md", action: "modified", summary: "fake edit" }], verification: [], unverified: [],
  needs_human: process.env.T_WRITER === "needs_human" ? [{ question: "which?", options: ["a", "b"] }] : [],
  addressed_findings: [...new Set(addressed)],
};
const typed = args.includes("--json-schema") ? { structured_output: writerResult } : {};
const ok = { session_id: session, is_error: false, result: "report\\nCODEX_REVIEW_REQUIRED: true", ...typed };
if (mode === "stream") {
  const tokens = Number(process.env.T_TOKENS || 1000);
  const lines = [
    { type: "system", subtype: "init", session_id: session },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "README.md" } }] } },
    { type: "result", subtype: "success", session_id: session, is_error: false, num_turns: 2, total_cost_usd: 0.01,
      usage: { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: tokens, output_tokens: 3 },
      modelUsage: { "fake-opus": { inputTokens: 1, cacheCreationInputTokens: 2, cacheReadInputTokens: tokens, outputTokens: 3 } },
      result: "report\\nCODEX_REVIEW_REQUIRED: true", ...typed },
  ];
  for (const line of lines) process.stdout.write(JSON.stringify(line) + "\\n");
  process.exit(0);
}
if (mode === "stdout_limit") {
  process.stdout.write(JSON.stringify({ session_id: session, is_error: true, result: "Claude AI usage limit reached|1760000000" }));
  process.exit(1);
}
if (mode === "stderr_limit") {
  process.stderr.write("You've hit your session limit \\u00b7 resets 3pm (Asia/Taipei)\\n");
  process.exit(1);
}
if (mode === "stderr_credential") {
  process.stderr.write("You've hit your session limit \\u00b7 resets 3pm (Credential/EXAMPLE)\\n");
  process.exit(1);
}
if (mode === "stderr_generic") {
  process.stdout.write("not json");
  process.stderr.write("Error: unexpected internal failure\\n");
  process.exit(1);
}
if (process.env.T_STALE_JOB) {
  // An unrelated job queued while the writer runs; it sorts first and fails policy validation.
  await fsp.mkdir(path.dirname(process.env.T_STALE_JOB), { recursive: true });
  await fsp.writeFile(process.env.T_STALE_JOB, JSON.stringify({ job_id: "${STALE_JOB_ID}" }));
}
process.stdout.write(JSON.stringify(ok));
`;

const fakeCodexSource = `
import fsp from "node:fs/promises";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const mode = process.env.T_CODEX;
if (mode === "limit") {
  process.stderr.write(${JSON.stringify(CODEX_LIMIT_STDERR)});
  process.exit(1);
}
if (mode === "generic") {
  process.stderr.write("ERROR: stream disconnected before completion\\n");
  process.exit(1);
}
const out = process.argv[process.argv.indexOf("--output-last-message") + 1];
if (process.argv.includes("--output-schema")) {
  // T0-05: typed verdict; the stream is left empty so reviewer usage falls back to parse_error.
  const call = Number(/"call": (\\d+)/.exec(prompt)?.[1] || 1);
  const finding = { id: "F1", severity: "HIGH", path: "README.md", line: 1, reach: "r", claim: "c", evidence: "e", fix: "f", acceptance_ref: null };
  const verdict = mode === "malformed" ? { event: "review.result", gate: "MAYBE" } : {
    event: "review.result", work_order: "s2-04-fixture", call,
    gate: mode === "fail" ? "FAIL" : "PASS", hard_stop: false, hard_stop_reason: null,
    findings: mode === "fail" ? [finding] : [], verified: [], not_run: [],
  };
  await fsp.writeFile(out, JSON.stringify(verdict));
  if (process.env.T_CODEX_TOKENS) {
    process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: Number(process.env.T_CODEX_TOKENS), cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1 } }) + "\\n");
  }
  process.exit(0);
}
await fsp.writeFile(out, "HARD_STOP_REQUIRED: false\\nREVIEW_GATE: " + (mode === "fail" ? "FAIL" : "PASS") + "\\n");
`;

async function makeRuntime(t, override = { schema_version: 4 }) {
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-bounded-"));
  // T0-05 D2.5: anything written inside the repo outside README.md is a scope violation, so the
  // fake CLIs and their argument dump live next to the repo, not in it.
  const toolsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-bounded-tools-"));
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  t.after(() => fsp.rm(toolsRoot, { recursive: true, force: true }));
  const paths = getBridgePaths(repoRoot, bridgeRoot);
  await writeJson(paths.bridgeConfigPath, {
    schema_version: 4, state_contract: "v4", active_runs: "derive_from_run_projections",
    gate_a: { profile_id: "node-backend", rules: [{ command: "npm test", package_script: "test" }] },
  });
  await writeJson(paths.policyOverridePath, override);
  await fsp.writeFile(path.join(repoRoot, "README.md"), "# fixture\n", "utf8");
  // T0-06: a real `npm test` entry point; it exits with FAKE_GATE_EXIT (default 0) and prints a marker line.
  await fsp.writeFile(path.join(repoRoot, "package.json"), JSON.stringify({ name: "bounded-fixture", scripts: { test: "node -e \"console.log('GATE-A-RAN');process.exit(Number(process.env.FAKE_GATE_EXIT||0))\"" } }), "utf8");
  const claude = path.join(toolsRoot, "fake-claude.mjs");
  const codex = path.join(toolsRoot, "fake-codex.mjs");
  await fsp.writeFile(claude, fakeClaudeSource, "utf8");
  await fsp.writeFile(codex, fakeCodexSource, "utf8");
  return { repoRoot, toolsRoot, paths, claude, codex };
}

async function start(t, { claudeMode = "ok", codexMode = "pass", maxCalls = 1, staleJob = false, override, tokens = 0, writer = "", codexTokens = 0, changeTypes = "docs", gateExit = 0, reviewPrompt = null } = {}) {
  const runtime = await makeRuntime(t, override);
  if (reviewPrompt !== null) {
    await fsp.mkdir(path.dirname(runtime.paths.reviewPromptOverridePath), { recursive: true });
    await fsp.writeFile(runtime.paths.reviewPromptOverridePath, reviewPrompt, "utf8");
  }
  const argsOut = path.join(runtime.toolsRoot, "claude-args.json");
  const planPath = path.join(runtime.paths.queueRoot, "plan.json");
  const plan = await createV4WorkPackagePlan({
    paths: runtime.paths,
    task: "Update README.md only.",
    owner: "Human Owner",
    workPackage: "s2-04-fixture",
    breakpoint: "return after review",
    changeTypes,
    allowedPaths: "README.md",
    maxCalls,
    maxMinutes: 1,
    outPath: planPath,
  });
  const authorization = await authorizeV4WorkPackage({
    paths: runtime.paths, planPath, approval: plan.plan_sha256, executionMode: "fake_cli",
  });
  const adapter = {
    async resolveExecutable() { return process.execPath; },
    buildInvocation(kind, executable, args) {
      return {
        command: executable,
        args: [kind === "claude" ? runtime.claude : runtime.codex, ...args],
        env: {
          ...process.env,
          T_CLAUDE: claudeMode,
          T_CODEX: codexMode,
          T_ARGS_OUT: kind === "claude" ? argsOut : "",
          T_STALE_JOB: staleJob ? path.join(runtime.paths.pendingDir, STALE_JOB_ID + ".json") : "",
          T_TOKENS: tokens ? String(tokens) : "",
          T_WRITER: writer,
          T_CODEX_TOKENS: codexTokens ? String(codexTokens) : "",
          FAKE_GATE_EXIT: String(gateExit),
        },
      };
    },
    async notify() {},
  };
  const runId = authorization.run.run_id;
  let exitCode;
  let error = null;
  // Gate A runs through the real shell with the controller's environment, not the adapter's.
  const previousGateExit = process.env.FAKE_GATE_EXIT;
  process.env.FAKE_GATE_EXIT = String(gateExit);
  try {
    exitCode = await runBoundedResume({
      paths: runtime.paths,
      control: authorization.control,
      adapter,
      promptPath: authorization.promptPath,
      maxCalls,
      maxMinutes: 1,
      startNewSession: true,
      runtimeState: createRunRuntimeState(runtime.paths, runId),
    });
  } catch (caught) {
    error = caught;
  } finally {
    if (previousGateExit === undefined) delete process.env.FAKE_GATE_EXIT;
    else process.env.FAKE_GATE_EXIT = previousGateExit;
  }
  const status = await v4WorkPackageStatus(runtime.paths, runId);
  const claudeArgs = await fileExists(argsOut) ? JSON.parse(await fsp.readFile(argsOut, "utf8")) : null;
  return { runtime, exitCode, error, status, claudeArgs, run: await readRun(runtime.paths, runId) };
}

test("reviewer usage limit ends rate_limited as reviewer provider_usage_limit, not controller_failure", async (t) => {
  const { exitCode, error, status, run } = await start(t, { codexMode: "limit" });
  assert.equal(error, null);
  assert.equal(exitCode, 75);
  assert.equal(run.status, "rate_limited");
  assert.equal(status.closed_reason, "rate_limited");
  assert.equal(status.latest_state.status, "rate_limited");
  assert.deepEqual(
    [status.stop_reason.role, status.stop_reason.provider, status.stop_reason.phase, status.stop_reason.reason],
    ["reviewer", "codex", "review", "provider_usage_limit"],
  );
  assert.equal(status.stop_reason.reset_hint, "Oct 10th, 2026 1:00 AM");
  assert.equal(status.stop_reason.exit_code, 1);
  assert.match(status.latest_state.resume_limitation, /not re-run/);
  assert.equal(JSON.stringify(status).includes("chatgpt.com"), false);
  const record = await readJson(status.stop_reason.record_path);
  assert.match(await fsp.readFile(record.evidence.stderr_path, "utf8"), /hit your usage limit/);
  assert.equal(await fileExists(status.latest_state.failed_review_job_path), true);
  const writer = JSON.parse(await fsp.readFile(status.latest_state.claude_stdout_path, "utf8"));
  assert.equal(writer.structured_output.event, "writer.result");
});

test("a project-owned review prompt replaces the packaged one for the reviewer", async (t) => {
  const { runtime, exitCode, error, status } = await start(t, { reviewPrompt: "PROJECT REVIEW {{REVIEW_INPUT}}\n" });
  assert.equal(error, null);
  assert.equal(exitCode, 0);
  const jobId = path.basename(status.latest_state.review_path).replace(/-codex-review\.md$/, "");
  const rendered = await fsp.readFile(path.join(runtime.paths.reviewsRoot, jobId + "-review-prompt.md"), "utf8");
  assert.match(rendered, /^PROJECT REVIEW /);
  assert.equal(rendered.includes("{{REVIEW_INPUT}}"), false);
});

test("an unrelated pending job is left alone: a bounded run reviews only its own job", async (t) => {
  const { runtime, exitCode, error, status, run } = await start(t, { staleJob: true });
  assert.equal(error, null);
  assert.equal(exitCode, 0);
  assert.notEqual(run.status, "rate_limited");
  assert.equal(status.latest_state.status, "pass");
  assert.equal(status.latest_state.failed_review_job_path, undefined);
  assert.equal(status.stop_reason?.reason === "provider_usage_limit", false);
  // T0-05: the stale job is neither reviewed nor failed by this run; it stays pending for its owner.
  assert.equal(await fileExists(path.join(runtime.paths.pendingDir, STALE_JOB_ID + ".json")), true);
  assert.equal(await fileExists(path.join(runtime.paths.failedDir, STALE_JOB_ID + ".json")), false);
  assert.equal(path.basename(status.latest_state.review_path).startsWith(STALE_JOB_ID), false);
});

test("credential-shaped reset text never reaches work-status", async (t) => {
  const { exitCode, status } = await start(t, { claudeMode: "stderr_credential" });
  assert.equal(exitCode, 75);
  assert.equal(status.latest_state.status, "rate_limited");
  assert.equal(status.stop_reason.reason, "provider_usage_limit");
  assert.equal(status.stop_reason.reset_hint, null);
  assert.equal(JSON.stringify(status).includes("Credential"), false);
});

test("generic reviewer failure is reviewer_failed provider_error without a reset hint", async (t) => {
  const { exitCode, status } = await start(t, { codexMode: "generic" });
  assert.equal(exitCode, 1);
  assert.equal(status.latest_state.status, "reviewer_failed");
  assert.equal(status.stop_reason.reason, "provider_error");
  assert.equal(status.stop_reason.reset_hint, null);
});

test("Claude stdout quota is writer provider_usage_limit without guessed reset", async (t) => {
  const { exitCode, status } = await start(t, { claudeMode: "stdout_limit" });
  assert.equal(exitCode, 75);
  assert.equal(status.latest_state.status, "rate_limited");
  assert.equal(status.stop_reason.role, "writer");
  assert.equal(status.stop_reason.provider, "claude");
  assert.equal(status.stop_reason.reason, "provider_usage_limit");
  assert.equal(status.stop_reason.reset_hint, null);
  assert.equal(JSON.stringify(status).includes("Claude AI usage limit"), false);
});

test("Claude stderr quota with absent JSON stdout is still writer provider_usage_limit", async (t) => {
  const { exitCode, status } = await start(t, { claudeMode: "stderr_limit" });
  assert.equal(exitCode, 75);
  assert.equal(status.latest_state.claude_json_valid, false);
  assert.equal(status.stop_reason.reason, "provider_usage_limit");
  assert.equal(status.stop_reason.reset_hint, "3pm (Asia/Taipei)");
});

test("generic Claude failure with invalid JSON is claude_failed provider_error", async (t) => {
  const { exitCode, error, status } = await start(t, { claudeMode: "stderr_generic" });
  assert.equal(error, null);
  assert.equal(exitCode, 1);
  assert.equal(status.latest_state.status, "claude_failed");
  assert.equal(status.stop_reason.reason, "provider_error");
  assert.equal(status.closed_reason, "claude_failed");
});

test("plan call budget exhaustion is labeled as the work package budget", async (t) => {
  const { exitCode, status } = await start(t, { codexMode: "fail", maxCalls: 1 });
  assert.equal(exitCode, 76);
  assert.equal(status.closed_reason, "call_budget_exhausted");
  assert.equal(status.latest_state.status, "call_budget_exhausted");
  assert.equal(status.stop_reason.reason, "work_package_call_budget");
  assert.equal(status.stop_reason.provider, "review-bridge");
  assert.equal(status.stop_reason.reset_hint, null);
});

test("writer invocation passes the default --model opus and the bounded state records it", async (t) => {
  const { exitCode, status, claudeArgs } = await start(t);
  assert.equal(exitCode, 0);
  assert.equal(claudeArgs[claudeArgs.indexOf("--model") + 1], "opus");
  assert.equal(status.latest_state.writer_model, "opus");
});

test("the writer may start sub-agents by default; a project override can still disallow Agent", async (t) => {
  const open = await start(t);
  assert.equal(open.exitCode, 0);
  assert.equal(open.claudeArgs.includes("--disallowedTools"), false);
  const closed = await start(t, { override: { schema_version: 4, writer: { disallowed_tools: ["Agent"] } } });
  assert.equal(closed.exitCode, 0);
  assert.equal(closed.claudeArgs[closed.claudeArgs.indexOf("--disallowedTools") + 1], "Agent");
});

test("project override sets the writer model; failure states record it too", async (t) => {
  const override = { schema_version: 4, writer: { model: "claude-opus-5-5" } };
  const passed = await start(t, { override });
  assert.equal(passed.claudeArgs[passed.claudeArgs.indexOf("--model") + 1], "claude-opus-5-5");
  assert.equal(passed.status.latest_state.writer_model, "claude-opus-5-5");
  const failed = await start(t, { override, claudeMode: "stderr_generic" });
  assert.equal(failed.status.latest_state.status, "claude_failed");
  assert.equal(failed.status.latest_state.writer_model, "claude-opus-5-5");
});

test("a malformed writer model override is refused", async (t) => {
  const runtime = await makeRuntime(t, { schema_version: 4, writer: { model: "opus --dangerously" } });
  await assert.rejects(createV4WorkPackagePlan({
    paths: runtime.paths,
    task: "Update README.md only.",
    owner: "Human Owner",
    workPackage: "s2-06-fixture",
    breakpoint: "return after review",
    changeTypes: "docs",
    allowedPaths: "README.md",
    maxCalls: 1,
    maxMinutes: 1,
    outPath: path.join(runtime.paths.queueRoot, "plan.json"),
  }), /writer model is invalid/);
});

test("P4 stream output: task.input, read and usage are recorded; the result file stays a single JSON; args carry the limits", async (t) => {
  const { runtime, exitCode, error, status, run } = await start(t, { claudeMode: "stream" });
  assert.equal(error, null);
  assert.equal(exitCode, 0);
  assert.equal(run.status, "pass");
  const events = await readIoEvents(runtime.paths, run.run_id);
  assert.deepEqual(events.map((event) => event.event), ["task.input", "read", "usage", "writer.result", "gate_a_result", "review.input", "usage", "review.result"]);
  assert.equal(events[0].work_order, "s2-04-fixture");
  assert.equal(events[1].path, "README.md");
  assert.equal(events[1].outside_list, null); // legacy inline task: no read list, nothing to compare against
  assert.equal(events[2].tokens.cache_read, 1000);
  assert.equal(events[4].kind, "not_applicable"); // docs-only: Gate A is recorded, nothing runs
  assert.equal(events[6].role, "reviewer");
  assert.equal(events[6].parse_error, true); // this inline fake prints no --json stream and no trailer
  const writer = JSON.parse(await fsp.readFile(status.latest_state.claude_stdout_path, "utf8"));
  assert.equal(writer.type, "result");
  assert.equal(writer.structured_output.event, "writer.result");
  const args = JSON.parse(await fsp.readFile(path.join(runtime.toolsRoot, "claude-args.json"), "utf8"));
  assert.ok(args.includes("--session-id"));
  assert.ok(!args.includes("--resume"));
  assert.equal(args[args.indexOf("--max-turns") + 1], "20");
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.ok(args.includes("--verbose"));
  assert.equal(JSON.parse(args[args.indexOf("--json-schema") + 1]).title, "writer.result");
});

test("Q2 a writer.result that misses fields ends malformed_writer_result with exit 79 and no review", async (t) => {
  const { runtime, exitCode, error, status, run } = await start(t, { claudeMode: "stream", writer: "malformed" });
  assert.equal(error, null);
  assert.equal(exitCode, 79);
  assert.equal(run.status, "malformed_writer_result");
  assert.ok(status.latest_state.errors.some((line) => /missing call/.test(line)));
  const events = await readIoEvents(runtime.paths, run.run_id);
  assert.equal(events.at(-1).event, "stop");
  assert.equal(events.at(-1).status, "malformed_event");
  assert.equal(events.some((event) => event.event === "review.input"), false);
});

test("Q3 needs_human or a non-done status ends needs_human with exit 0 and no review", async (t) => {
  for (const writer of ["needs_human", "blocked"]) {
    const { runtime, exitCode, error, status, run } = await start(t, { claudeMode: "stream", writer });
    assert.equal(error, null);
    assert.equal(exitCode, 0);
    assert.equal(run.status, "needs_human");
    assert.equal(status.closed_reason, "needs_human");
    assert.equal(status.latest_state.writer_status, writer === "blocked" ? "blocked" : "done");
    const events = await readIoEvents(runtime.paths, run.run_id);
    assert.equal(events.at(-1).status, "needs_human");
    assert.equal(events.some((event) => event.event === "review.input"), false);
  }
});

test("Q5 a review.result that breaks the schema ends malformed_review_result with exit 79", async (t) => {
  const { runtime, exitCode, error, run, status } = await start(t, { claudeMode: "stream", codexMode: "malformed" });
  assert.equal(error, null);
  assert.equal(exitCode, 79);
  assert.equal(run.status, "malformed_review_result");
  assert.ok(status.latest_state.errors.length > 0);
  const events = await readIoEvents(runtime.paths, run.run_id);
  assert.equal(events.at(-1).status, "malformed_event");
  assert.equal(events.at(-1).role, "reviewer");
});

test("Q7 a finding that survives one correction is a loop: hard_stop, no third writer call", async (t) => {
  const { runtime, exitCode, error, run, status } = await start(t, { claudeMode: "stream", codexMode: "fail", maxCalls: 2 });
  assert.equal(error, null);
  assert.equal(exitCode, 0);
  assert.equal(run.status, "hard_stop");
  assert.equal(status.latest_state.call, 2);
  assert.equal(status.latest_state.hard_stop_reason, "needs_human_decision");
  const events = await readIoEvents(runtime.paths, run.run_id);
  assert.equal(events.filter((event) => event.event === "task.input").length, 2);
  const handoff = events.find((event) => event.event === "handoff");
  assert.equal(handoff.open_findings[0].id, "F1");
  assert.equal(handoff.open_findings[0].claim, "c");
  const recheck = events.find((event) => event.event === "recheck");
  assert.deepEqual(recheck.unresolved, ["F1"]);
  assert.equal(events.at(-1).detail_ref, "loop:F1");
  const secondWriter = events.filter((event) => event.event === "writer.result")[1];
  assert.deepEqual(secondWriter.addressed_findings, ["F1"]);
});

test("Q8 reviewer usage from the --json stream counts against the per-call ceiling", async (t) => {
  const { runtime, exitCode, error, run, status } = await start(t, { claudeMode: "stream", codexTokens: 2_000_000 });
  assert.equal(error, null);
  assert.equal(exitCode, 76);
  assert.equal(run.status, "token_limit");
  assert.equal(status.latest_state.token_limit_role, "reviewer");
  const events = await readIoEvents(runtime.paths, run.run_id);
  const reviewer = events.find((event) => event.event === "usage" && event.role === "reviewer");
  assert.equal(reviewer.source, "cli_json");
  assert.equal(reviewer.tokens.input, 2_000_000);
  assert.equal(events.at(-1).status, "token_limit");
  assert.equal(events.at(-1).role, "reviewer");
});

test("P5 a call over max_tokens_per_call ends token_limit with exit 76, no review, no second call", async (t) => {
  const { runtime, exitCode, error, status, run } = await start(t, { claudeMode: "stream", tokens: 2_000_000, maxCalls: 2, codexMode: "fail" });
  assert.equal(error, null);
  assert.equal(exitCode, 76);
  assert.equal(run.status, "token_limit");
  assert.equal(status.latest_state.token_limit, "per_call");
  assert.equal(status.latest_state.tokens_this_call, 2_000_006);
  const events = await readIoEvents(runtime.paths, run.run_id);
  assert.equal(events.filter((event) => event.event === "usage").length, 1);
  assert.equal(events.at(-1).event, "stop");
  assert.equal(events.at(-1).status, "token_limit");
});

test("P5b the per-run ceiling adds up across calls and the second call rotates the session", async (t) => {
  const { runtime, exitCode, error, run, status } = await start(t, {
    claudeMode: "stream", tokens: 1000, maxCalls: 2, codexMode: "fail",
    override: { schema_version: 4, limits: { max_tokens_per_run: 1500 } },
  });
  assert.equal(error, null);
  assert.equal(exitCode, 76);
  assert.equal(run.status, "token_limit");
  assert.equal(status.latest_state.token_limit, "per_run");
  assert.equal(status.latest_state.tokens_this_run, 2012);
  assert.equal(run.claude_session_ids.length, 2);
  assert.notEqual(run.claude_session_ids[0], run.claude_session_ids[1]);
  assert.equal(run.claude_session_id, run.claude_session_ids[1]);
  const events = await readIoEvents(runtime.paths, run.run_id);
  assert.equal(events.filter((event) => event.event === "handoff").length, 1);
  const handoff = events.find((event) => event.event === "handoff");
  assert.equal(handoff.reason, "correction");
  assert.equal(handoff.from.calls_used, 1);
});

test("P6 a project override may lower max_turns but never raise it", async (t) => {
  const { runtime, error } = await start(t, { claudeMode: "stream", override: { schema_version: 4, limits: { max_turns: 5 } } });
  assert.equal(error, null);
  const args = JSON.parse(await fsp.readFile(path.join(runtime.toolsRoot, "claude-args.json"), "utf8"));
  assert.equal(args[args.indexOf("--max-turns") + 1], "5");
  await assert.rejects(start(t, { override: { schema_version: 4, limits: { max_turns: 50 } } }), /only tighten limit: max_turns/);
  await assert.rejects(start(t, { override: { schema_version: 4, limits: { max_tokens_per_call: 9_000_000 } } }), /only tighten limit: max_tokens_per_call/);
});

test("R5 Gate A runs after the writer and before the review; its result reaches review.input and the run", async (t) => {
  const { runtime, exitCode, error, run } = await start(t, { claudeMode: "stream", changeTypes: "code" });
  assert.equal(error, null);
  assert.equal(exitCode, 0);
  assert.equal(run.status, "pass");
  assert.equal(run.gate_a_passed, true);
  const events = await readIoEvents(runtime.paths, run.run_id);
  const kinds = events.map((event) => event.event);
  assert.ok(kinds.indexOf("writer.result") < kinds.indexOf("gate_a_result"));
  assert.ok(kinds.indexOf("gate_a_result") < kinds.indexOf("review.input"));
  const gate = events.find((event) => event.event === "gate_a_result");
  assert.equal(gate.command, "npm test");
  assert.equal(gate.exit_code, 0);
  assert.equal(gate.passed, true);
  assert.match(gate.stdout_tail, /GATE-A-RAN/);
  const reviewInput = events.find((event) => event.event === "review.input");
  assert.equal(reviewInput.gate_a_result.command, "npm test");
  assert.equal(reviewInput.gate_a_result.exit_code, 0);
  assert.equal(events.find((event) => event.event === "task.input").gate_a.label, "跑現有測試：npm test");
});

test("R5b docs-only work records not_applicable and runs nothing", async (t) => {
  const { runtime, exitCode, run } = await start(t, { claudeMode: "stream" });
  assert.equal(exitCode, 0);
  assert.equal(run.gate_a_passed, null);
  const gate = (await readIoEvents(runtime.paths, run.run_id)).find((event) => event.event === "gate_a_result");
  assert.equal(gate.kind, "not_applicable");
  assert.equal(gate.label, "不跑測試（純文件）");
});

test("R6 a failed Gate A skips the review and goes back to the writer as fix.input; the budget still ends the run", async (t) => {
  const { runtime, exitCode, error, run, status } = await start(t, { claudeMode: "stream", changeTypes: "code", gateExit: 3, maxCalls: 1 });
  assert.equal(error, null);
  assert.equal(exitCode, 76);
  assert.equal(run.status, "call_budget_exhausted");
  assert.equal(status.latest_state.gate_a_passed, false);
  assert.equal(status.latest_state.gate_a_exit_code, 3);
  const events = await readIoEvents(runtime.paths, run.run_id);
  assert.equal(events.some((event) => event.event === "review.input"), false);
  assert.equal(events.some((event) => event.event === "review.result"), false);
  assert.equal(events.find((event) => event.event === "gate_a_result").passed, false);
});

test("R6b the second writer call gets the Gate A result in its handoff, not a finding", async (t) => {
  const { runtime, error, run } = await start(t, { claudeMode: "stream", changeTypes: "code", gateExit: 3, maxCalls: 2 });
  assert.equal(error, null);
  const events = await readIoEvents(runtime.paths, run.run_id);
  const fix = events.find((event) => event.event === "fix.input");
  assert.equal(fix.reason, "gate_a_failed");
  assert.equal(fix.call, 2);
  assert.equal(fix.gate_a_result.exit_code, 3);
  const handoff = events.find((event) => event.event === "handoff");
  assert.equal(handoff.reason, "gate_a_failed");
  assert.equal(handoff.gate_a_result.command, "npm test");
  assert.deepEqual(handoff.open_findings, []);
  assert.match(handoff.next, /現有測試失敗/);
  assert.equal(events.filter((event) => event.event === "task.input").length, 2);
});

test("R7 two Gate A failures on an unchanged delta are a loop: hard_stop, no third writer call", async (t) => {
  const { runtime, exitCode, error, run, status } = await start(t, { claudeMode: "stream", changeTypes: "code", gateExit: 1, maxCalls: 2 });
  assert.equal(error, null);
  assert.equal(exitCode, 0);
  assert.equal(run.status, "hard_stop");
  assert.equal(status.latest_state.hard_stop_reason, "needs_human_decision");
  const events = await readIoEvents(runtime.paths, run.run_id);
  assert.equal(events.filter((event) => event.event === "task.input").length, 2);
  assert.equal(events.at(-1).detail_ref, "gate_a_loop");
  assert.equal(events.some((event) => event.event === "review.input"), false);
});

test("R9 Gate A passed but the reviewer failed: correction_pending with gate_a_passed still true", async (t) => {
  const { runtime, exitCode, run, status } = await start(t, { claudeMode: "stream", changeTypes: "code", codexMode: "fail", maxCalls: 1 });
  assert.equal(exitCode, 76);
  assert.equal(status.latest_state.gate_a_passed, true);
  assert.equal(status.latest_state.review_gate, "FAIL");
  assert.equal(run.gate_a_passed, true);
  const events = await readIoEvents(runtime.paths, run.run_id);
  assert.equal(events.find((event) => event.event === "review.result").gate, "FAIL");
});
