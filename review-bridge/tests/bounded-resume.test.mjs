// Keeps the person's database out of these tests (see the fixture).
import "./fixtures/isolatedDataHome.mjs";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runBoundedResume } from "../features/workOrder/writerLoop.mjs";
import { deliverOutcome } from "../features/workOrder/delivery.mjs";
import { readIoEvents } from "../service/records/ioEvents.mjs";
import { fileExists, readJson, writeJson } from "../service/records/fileStore.mjs";
import { getBridgePaths } from "../utils/paths.mjs";
import { createRunRuntimeState, readRun } from "../service/records/runStore.mjs";
import {
  authorizeWorkPackage,
  createWorkPackagePlan,
  workPackageStatus,
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
// T0-05: a run asks for a schema; the typed answer is built from the injected task.input.
const call = Number(/"call": (\\d+)/.exec(prompt)?.[1] || 1);
const handoffAt = prompt.indexOf("=== HANDOFF ===");
const addressed = handoffAt >= 0 ? [...prompt.slice(handoffAt).matchAll(/"id": "(F\\d+)"/g)].map((m) => m[1]) : [];
const writerResult = process.env.T_WRITER === "malformed" ? { event: "writer.result" } : {
  event: "writer.result", work_order: "s2-04-fixture", contract_sha256: null, call, status: process.env.T_WRITER === "blocked" ? "blocked" : "done",
  changed: [{ path: "README.md", action: "modified", summary: "fake edit" }], verification: [], unverified: [],
  needs_human: process.env.T_WRITER === "needs_human" ? [{ question: "which?", options: ["a", "b"] }] : [],
  addressed_findings: [...new Set(addressed)], criteria: [],
};
const typed = args.includes("--json-schema") ? { structured_output: writerResult } : {};
// Real CLIs always report usage, and Bridge stops when it cannot read it, so the fake reports it.
const ok = { session_id: session, is_error: false, result: "report\\nCODEX_REVIEW_REQUIRED: true", num_turns: 2,
  modelUsage: { "fake-opus": { inputTokens: 1, cacheCreationInputTokens: 2, cacheReadInputTokens: 1000, outputTokens: 3 } }, ...typed };
if (mode === "stream") {
  // T_TOKENS is what the call read back from the cache, which the writer's budget does not count;
  // T_INPUT_TOKENS is what it read new, which it does (Owner 2026-11-08).
  const tokens = Number(process.env.T_TOKENS || 1000);
  const input = Number(process.env.T_INPUT_TOKENS || 1);
  const lines = [
    { type: "system", subtype: "init", session_id: session },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "README.md" } }] } },
    { type: "result", subtype: "success", session_id: session, is_error: false, num_turns: 2, total_cost_usd: 0.01,
      usage: { input_tokens: input, cache_creation_input_tokens: 2, cache_read_input_tokens: tokens, output_tokens: 3 },
      modelUsage: { "fake-opus": { inputTokens: input, cacheCreationInputTokens: 2, cacheReadInputTokens: tokens, outputTokens: 3 } },
      result: "report\\nCODEX_REVIEW_REQUIRED: true", ...typed },
  ];
  for (const line of lines) process.stdout.write(JSON.stringify(line) + "\\n");
  process.exit(0);
}
if (mode === "stdout_limit") {
  process.stdout.write(JSON.stringify({ session_id: session, is_error: true, result: "Claude AI usage limit reached|1760000000" }));
  process.exit(1);
}
if (mode === "model_text_limit") {
  // The model's own words mention a limit; the CLI did not mark an error and stderr is clean.
  process.stdout.write(JSON.stringify({ session_id: session, is_error: false, result: "The API answered 429 Too Many Requests, rate limit exceeded, so I stopped." }));
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
    event: "review.result", work_order: "s2-04-fixture", contract_sha256: null, call,
    gate: mode === "fail" ? "FAIL" : "PASS", hard_stop: false, hard_stop_reason: null,
    findings: mode === "fail" ? [finding] : [], verified: [], not_run: [], verdicts: [],
  };
  await fsp.writeFile(out, JSON.stringify(verdict));
  if (process.env.T_CODEX_TOKENS !== "none") {
    process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: Number(process.env.T_CODEX_TOKENS || 0), cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1 } }) + "\\n");
  }
  process.exit(0);
}
await fsp.writeFile(out, "HARD_STOP_REQUIRED: false\\nREVIEW_GATE: " + (mode === "fail" ? "FAIL" : "PASS") + "\\n");
`;

// withTests: the project's rules give the test command (npm test); without, its tests are not configured.
async function makeRuntime(t, override = { schema_version: 5 }, { git = false, withTests = false } = {}) {
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-bounded-"));
  // T0-05 D2.5: anything written inside the repo outside README.md is a scope violation, so the
  // fake CLIs and their argument dump live next to the repo, not in it.
  const toolsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-bounded-tools-"));
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  t.after(() => fsp.rm(toolsRoot, { recursive: true, force: true }));
  const paths = getBridgePaths(repoRoot, bridgeRoot, { privateRootName: ".review-bridge" });
  await writeJson(paths.bridgeConfigPath, { project_id: randomUUID(),
    schema_version: 4, active_runs: "derive_from_run_projections",
    roles: { writer: { provider_id: "claude" }, reviewer: { provider_id: "codex" } },
    test: { profile_id: "node-backend", rules: withTests ? [{ command: "npm test", package_script: "test" }] : [] },
  });
  await writeJson(paths.policyOverridePath, override);
  await fsp.writeFile(path.join(repoRoot, "README.md"), "# fixture\n", "utf8");
  // T0-06: a real `npm test` entry point; it exits with FAKE_GATE_EXIT (default 0) and prints a marker line.
  await fsp.writeFile(path.join(repoRoot, "package.json"), JSON.stringify({ name: "bounded-fixture", scripts: { test: "node -e \"console.log('GATE-A-RAN');process.exit(Number(process.env.FAKE_GATE_EXIT||0))\"" } }), "utf8");
  // With git, the work proof comes from Git; Bridge's own folder is excluded as the installer does.
  if (git) {
    const run = (...args) => spawnSync("git", args, { cwd: repoRoot, windowsHide: true });
    run("init", "-q");
    await fsp.appendFile(path.join(repoRoot, ".git", "info", "exclude"), "\n/.review-bridge/\n");
    run("add", "-A");
    run("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "fixture");
  }
  const claude = path.join(toolsRoot, "fake-claude.mjs");
  const codex = path.join(toolsRoot, "fake-codex.mjs");
  await fsp.writeFile(claude, fakeClaudeSource, "utf8");
  await fsp.writeFile(codex, fakeCodexSource, "utf8");
  return { repoRoot, toolsRoot, paths, claude, codex };
}

async function start(t, { claudeMode = "ok", codexMode = "pass", maxCalls = 1, staleJob = false, override, tokens = 0, inputTokens = 0, writer = "", codexTokens = 0, withTests = false, gateExit = 0, reviewPrompt = null, git = false, beforeResume = null, beforeReview = null } = {}) {
  const runtime = await makeRuntime(t, override, { git, withTests });
  if (reviewPrompt !== null) {
    await fsp.mkdir(path.dirname(runtime.paths.reviewPromptOverridePath), { recursive: true });
    await fsp.writeFile(runtime.paths.reviewPromptOverridePath, reviewPrompt, "utf8");
  }
  const argsOut = path.join(runtime.toolsRoot, "claude-args.json");
  const planPath = path.join(runtime.paths.privateRoot, "plan.json");
  const plan = await createWorkPackagePlan({
    listCodexMcp: async () => [],
    paths: runtime.paths,
    task: "Update README.md only.",
    owner: "Human Owner",
    workPackage: "s2-04-fixture",
    breakpoint: "return after review",
    allowedPaths: "README.md",
    rounds: maxCalls,
    callTimeout: 60_000,
    outPath: planPath,
  });
  const authorization = await authorizeWorkPackage({
    paths: runtime.paths, planPath, approval: plan.plan_sha256, executionMode: "fake_cli",
  });
  const adapter = {
    // The review resolves its CLI after the job and its change list are queued, before it reads them.
    async resolveExecutable(kind) {
      if (kind === "codex" && beforeReview) await beforeReview(runtime);
      return process.execPath;
    },
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
          T_INPUT_TOKENS: inputTokens ? String(inputTokens) : "",
          T_WRITER: writer,
          T_CODEX_TOKENS: codexTokens ? String(codexTokens) : "",
          FAKE_GATE_EXIT: String(gateExit),
        },
      };
    },
    async notify() {},
  };
  const runId = authorization.run.run_id;
  if (beforeResume) await beforeResume(runtime, authorization);
  let exitCode;
  let error = null;
  // The tests run through the real shell with the controller's environment, not the adapter's.
  const previousGateExit = process.env.FAKE_GATE_EXIT;
  process.env.FAKE_GATE_EXIT = String(gateExit);
  try {
    exitCode = await runBoundedResume({
      paths: runtime.paths,
      control: authorization.control,
      adapter,
      promptPath: authorization.promptPath,
      rounds: maxCalls,
      callTimeout: 60_000,
      startNewSession: true,
      runtimeState: createRunRuntimeState(runtime.paths, runId),
      workLock: authorization.workLock,
    });
  } catch (caught) {
    error = caught;
  } finally {
    if (previousGateExit === undefined) delete process.env.FAKE_GATE_EXIT;
    else process.env.FAKE_GATE_EXIT = previousGateExit;
  }
  const status = await workPackageStatus(runtime.paths, runId);
  const claudeArgs = await fileExists(argsOut) ? JSON.parse(await fsp.readFile(argsOut, "utf8")) : null;
  return { runtime, exitCode, error, status, claudeArgs, run: await readRun(runtime.paths, runId) };
}

// The change list the review is queued with, as Bridge wrote it.
async function deltaFiles(paths) {
  const found = [];
  for (const dir of await fsp.readdir(paths.evidenceRoot)) {
    for (const name of await fsp.readdir(path.join(paths.evidenceRoot, dir))) {
      if (/^delta-.*\.json$/.test(name)) found.push(path.join(paths.evidenceRoot, dir, name));
    }
  }
  return found;
}

test("a change list that is deleted or broken before the review stops the run as evidence_unavailable; nothing is reviewed", async (t) => {
  for (const [label, spoil] of [
    ["deleted", (file) => fsp.rm(file)],
    ["not JSON", (file) => fsp.writeFile(file, "{not json", "utf8")],
  ]) {
    for (const git of [true, false]) {
      let spoiled = [];
      const { exitCode, error, run, runtime } = await start(t, { git, beforeReview: async ({ paths }) => {
        spoiled = await deltaFiles(paths);
        for (const file of spoiled) await spoil(file);
      } });
      const at = label + (git ? " with Git" : " without Git");
      assert.equal(error, null, at);
      assert.equal(spoiled.length, 1, at);
      assert.equal(exitCode, 69, at);
      assert.deepEqual([run.status, run.conclusion, run.closed_reason], ["completed", "failure", "evidence_unavailable"], at);
      const events = await readIoEvents(runtime.paths, run.run_id);
      assert.ok(events.some((event) => event.event === "stop" && event.status === "evidence_unavailable" && event.detail_ref === "delta"), at);
      assert.equal(events.some((event) => event.event === "review.input" || event.event === "review.result"), false, at);
      const delivery = await deliverOutcome({ paths: runtime.paths, runId: run.run_id, notify: false });
      assert.equal(delivery.closed_reason, "evidence_unavailable", at);
      const result = await fsp.readFile(path.join(runtime.paths.runLogDir(run.run_id), run.run_id + ".result.md"), "utf8");
      assert.match(result, /The change evidence could not be read|改動證據讀不到/, at);
    }
  }
});

test("reviewer usage limit ends rate_limited as reviewer provider_usage_limit, not controller_failure", async (t) => {
  const { exitCode, error, status, run } = await start(t, { codexMode: "limit" });
  assert.equal(error, null);
  assert.equal(exitCode, 75);
  assert.equal(run.closed_reason, "rate_limited");
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
  const writer = JSON.parse(await fsp.readFile(status.latest_state.writer_stdout_path, "utf8"));
  assert.equal(writer.structured_output.event, "writer.result");
});

test("a project-owned review prompt replaces the packaged one for the reviewer", async (t) => {
  const { runtime, exitCode, error, status } = await start(t, { reviewPrompt: "PROJECT REVIEW {{REVIEW_INPUT}}\n" });
  assert.equal(error, null);
  assert.equal(exitCode, 0);
  const jobId = path.basename(status.latest_state.review_path).replace(/-reviewer-review\.md$/, "");
  const rendered = await fsp.readFile(path.join(runtime.paths.reviewsRoot, jobId + "-review-prompt.md"), "utf8");
  assert.match(rendered, /^PROJECT REVIEW /);
  assert.equal(rendered.includes("{{REVIEW_INPUT}}"), false);
});

test("an unrelated pending job is left alone: a bounded run reviews only its own job", async (t) => {
  const { runtime, exitCode, error, status, run } = await start(t, { staleJob: true });
  assert.equal(error, null);
  assert.equal(exitCode, 0);
  assert.notEqual(run.closed_reason, "rate_limited");
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

test("a writer whose own result text talks about a rate limit, with clean stderr and a failed exit, is provider_error, not a quota stop", async (t) => {
  const { exitCode, status } = await start(t, { claudeMode: "model_text_limit" });
  assert.equal(exitCode, 1);
  assert.equal(status.latest_state.status, "writer_failed");
  assert.equal(status.stop_reason.reason, "provider_error");
  assert.equal(status.closed_reason, "writer_failed");
});

test("Claude stderr quota with absent JSON stdout is still writer provider_usage_limit", async (t) => {
  const { exitCode, status } = await start(t, { claudeMode: "stderr_limit" });
  assert.equal(exitCode, 75);
  assert.equal(status.latest_state.writer_json_valid, false);
  assert.equal(status.stop_reason.reason, "provider_usage_limit");
  assert.equal(status.stop_reason.reset_hint, "3pm (Asia/Taipei)");
});

test("generic Claude failure with invalid JSON is writer_failed provider_error", async (t) => {
  const { exitCode, error, status } = await start(t, { claudeMode: "stderr_generic" });
  assert.equal(error, null);
  assert.equal(exitCode, 1);
  assert.equal(status.latest_state.status, "writer_failed");
  assert.equal(status.stop_reason.reason, "provider_error");
  assert.equal(status.closed_reason, "writer_failed");
});

test("plan call budget exhaustion is labeled as the work package budget", async (t) => {
  const { exitCode, status } = await start(t, { codexMode: "fail", maxCalls: 1 });
  assert.equal(exitCode, 76);
  assert.equal(status.closed_reason, "rounds_exhausted");
  assert.equal(status.latest_state.status, "rounds_exhausted");
  assert.equal(status.stop_reason.reason, "work_package_call_budget");
  assert.equal(status.stop_reason.provider, "review-bridge");
  assert.equal(status.stop_reason.reset_hint, null);
});

test("with no model set the writer's CLI is given no --model, and the bounded state says so", async (t) => {
  const { exitCode, status, claudeArgs } = await start(t);
  assert.equal(exitCode, 0);
  assert.equal(claudeArgs.includes("--model"), false);
  assert.equal(status.latest_state.writer_model, null);
});

test("the writer's MCP servers are the project's own .mcp.json or none, never the person's", async (t) => {
  const without = await start(t);
  assert.equal(without.exitCode, 0);
  assert.ok(without.claudeArgs.includes("--strict-mcp-config"));
  assert.equal(without.claudeArgs.includes("--mcp-config"), false);
  const withFile = await start(t, { beforeResume: async (runtime) => fsp.writeFile(path.join(runtime.paths.repoRoot, ".mcp.json"), "{\"mcpServers\":{}}\n") });
  assert.ok(withFile.claudeArgs.includes("--strict-mcp-config"));
  assert.equal(withFile.claudeArgs[withFile.claudeArgs.indexOf("--mcp-config") + 1], ".mcp.json");
});

test("the writer may start sub-agents by default; a project override can still disallow Agent", async (t) => {
  const open = await start(t);
  assert.equal(open.exitCode, 0);
  assert.equal(open.claudeArgs.includes("--disallowedTools"), false);
  const closed = await start(t, { override: { schema_version: 5, writer: { disallowed_tools: ["Agent"] } } });
  assert.equal(closed.exitCode, 0);
  assert.equal(closed.claudeArgs[closed.claudeArgs.indexOf("--disallowedTools") + 1], "Agent");
});

test("project override sets the writer model; failure states record it too", async (t) => {
  const override = { schema_version: 5, priority: { writer: { medium: { model: "claude-opus-5-5" } } } };
  const passed = await start(t, { override });
  assert.equal(passed.claudeArgs[passed.claudeArgs.indexOf("--model") + 1], "claude-opus-5-5");
  assert.equal(passed.status.latest_state.writer_model, "claude-opus-5-5");
  const failed = await start(t, { override, claudeMode: "stderr_generic" });
  assert.equal(failed.status.latest_state.status, "writer_failed");
  assert.equal(failed.status.latest_state.writer_model, "claude-opus-5-5");
});

test("a malformed writer model override is refused", async (t) => {
  const runtime = await makeRuntime(t, { schema_version: 5, priority: { writer: { medium: { model: "opus --dangerously" } } } });
  await assert.rejects(createWorkPackagePlan({
    listCodexMcp: async () => [],
    paths: runtime.paths,
    task: "Update README.md only.",
    owner: "Human Owner",
    workPackage: "s2-06-fixture",
    breakpoint: "return after review",
    allowedPaths: "README.md",
    rounds: 1,
    callTimeout: 60_000,
    outPath: path.join(runtime.paths.privateRoot, "plan.json"),
  }), /writer model for medium is invalid/);
});

test("P4 stream output: task.input, read and usage are recorded; the result file stays a single JSON; args carry the limits", async (t) => {
  const { runtime, exitCode, error, status, run } = await start(t, { claudeMode: "stream" });
  assert.equal(error, null);
  assert.equal(exitCode, 0);
  assert.equal(run.conclusion, "success");
  const events = await readIoEvents(runtime.paths, run.run_id);
  assert.deepEqual(events.map((event) => event.event), ["task.input", "read", "usage", "writer.result", "test_result", "review.input", "usage", "review.result"]);
  assert.equal(events[0].work_order, "s2-04-fixture");
  assert.equal(events[1].path, "README.md");
  assert.equal(events[1].outside_list, null); // legacy inline task: no read list, nothing to compare against
  assert.equal(events[2].tokens.cache_read, 1000);
  assert.equal(events[4].kind, "not_configured"); // no test rule: the tests are recorded as not configured, nothing runs
  assert.equal(events[6].role, "reviewer");
  assert.equal(events[6].source, "cli_json"); // the inline fake reports usage, as a real CLI does
  const writer = JSON.parse(await fsp.readFile(status.latest_state.writer_stdout_path, "utf8"));
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
  assert.equal(run.closed_reason, "malformed_writer_result");
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
    assert.equal(run.closed_reason, "needs_human");
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
  assert.equal(run.closed_reason, "malformed_review_result");
  assert.ok(status.latest_state.errors.length > 0);
  const events = await readIoEvents(runtime.paths, run.run_id);
  assert.equal(events.at(-1).status, "malformed_event");
  assert.equal(events.at(-1).role, "reviewer");
});

test("Q7 a finding that survives one correction is a loop: hard_stop, no third writer call", async (t) => {
  const { runtime, exitCode, error, run, status } = await start(t, { claudeMode: "stream", codexMode: "fail", maxCalls: 2 });
  assert.equal(error, null);
  assert.equal(exitCode, 0);
  assert.equal(run.conclusion, "action_required");
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

// The budget is the writer's (Owner 2026-11-08, replacing T0-05 D5.3's one ceiling for both roles): the
// reviewer's usage is recorded as read and stops nothing, however large.
test("Q8 reviewer usage from the --json stream is recorded and counts against no budget", async (t) => {
  const { runtime, exitCode, error, run, status } = await start(t, { claudeMode: "stream", codexTokens: 2_000_000 });
  assert.equal(error, null);
  assert.equal(exitCode, 0);
  assert.equal(run.conclusion, "success");
  assert.equal(status.latest_state.token_limit, undefined);
  const events = await readIoEvents(runtime.paths, run.run_id);
  const reviewer = events.find((event) => event.event === "usage" && event.role === "reviewer");
  assert.equal(reviewer.source, "cli_json");
  assert.equal(reviewer.tokens.input, 2_000_000);
  assert.equal(events.some((event) => event.event === "stop" && event.status === "token_limit"), false);
});

// What a writer call read new, wrote to the cache and wrote out is its budget's: 2_000_000 + 2 + 3 here.
test("P5 a call over tokens_per_call ends token_limit with exit 76, no review, no second call", async (t) => {
  const { runtime, exitCode, error, status, run } = await start(t, { claudeMode: "stream", inputTokens: 2_000_000, maxCalls: 2, codexMode: "fail" });
  assert.equal(error, null);
  assert.equal(exitCode, 76);
  assert.equal(run.closed_reason, "token_limit");
  assert.equal(status.latest_state.token_limit, "per_call");
  assert.equal(status.latest_state.tokens_this_call, 2_000_005);
  const events = await readIoEvents(runtime.paths, run.run_id);
  assert.equal(events.filter((event) => event.event === "usage").length, 1);
  assert.equal(events.at(-1).event, "stop");
  assert.equal(events.at(-1).status, "token_limit");
});

// A writer carrying a long context reads most of it back from the cache: none of that is the budget's,
// so a call of 2_000_000 cache reads stays under tokens_per_call and is recorded apart.
test("P5c cache reads are recorded but spend none of the writer's budget", async (t) => {
  const { runtime, exitCode, error, run } = await start(t, { claudeMode: "stream", tokens: 2_000_000 });
  assert.equal(error, null);
  assert.equal(exitCode, 0);
  assert.equal(run.conclusion, "success");
  const writer = (await readIoEvents(runtime.paths, run.run_id)).find((event) => event.event === "usage" && event.role === "writer");
  assert.equal(writer.tokens.cache_read, 2_000_000);
});

test("P5b the per-run ceiling adds up across calls and the second call rotates the session", async (t) => {
  const { runtime, exitCode, error, run, status } = await start(t, {
    claudeMode: "stream", inputTokens: 1000, maxCalls: 2, codexMode: "fail",
    override: { schema_version: 5, limits: { tokens: 1500 } },
  });
  assert.equal(error, null);
  assert.equal(exitCode, 76);
  assert.equal(run.closed_reason, "token_limit");
  assert.equal(status.latest_state.token_limit, "per_run");
  assert.equal(status.latest_state.tokens_this_run, 2010); // two writer calls of 1000 + 2 + 3; the reviewer's spend none of it
  assert.equal(run.writer_session_ids.length, 2);
  assert.notEqual(run.writer_session_ids[0], run.writer_session_ids[1]);
  assert.equal(run.writer_session_id, run.writer_session_ids[1]);
  const events = await readIoEvents(runtime.paths, run.run_id);
  assert.equal(events.filter((event) => event.event === "handoff").length, 1);
  const handoff = events.find((event) => event.event === "handoff");
  assert.equal(handoff.reason, "correction");
  assert.equal(handoff.from.calls_used, 1);
});

test("P6 a project override may lower max_turns but never raise it", async (t) => {
  const { runtime, error } = await start(t, { claudeMode: "stream", override: { schema_version: 5, limits: { max_turns: 5 } } });
  assert.equal(error, null);
  const args = JSON.parse(await fsp.readFile(path.join(runtime.toolsRoot, "claude-args.json"), "utf8"));
  assert.equal(args[args.indexOf("--max-turns") + 1], "5");
  await assert.rejects(start(t, { override: { schema_version: 5, limits: { max_turns: 50 } } }), /only tighten limit: max_turns/);
  await assert.rejects(start(t, { override: { schema_version: 5, limits: { tokens_per_call: 9_000_000 } } }), /only tighten limit: tokens_per_call/);
});

test("R5 the tests run after the writer and before the review; its result reaches review.input and the run", async (t) => {
  const { runtime, exitCode, error, run } = await start(t, { claudeMode: "stream", withTests: true });
  assert.equal(error, null);
  assert.equal(exitCode, 0);
  assert.equal(run.conclusion, "success");
  assert.equal(run.test_passed, true);
  const events = await readIoEvents(runtime.paths, run.run_id);
  const kinds = events.map((event) => event.event);
  assert.ok(kinds.indexOf("writer.result") < kinds.indexOf("test_result"));
  assert.ok(kinds.indexOf("test_result") < kinds.indexOf("review.input"));
  const gate = events.find((event) => event.event === "test_result");
  assert.equal(gate.command, "npm test");
  assert.equal(gate.exit_code, 0);
  assert.equal(gate.passed, true);
  assert.match(gate.stdout_tail, /GATE-A-RAN/);
  const reviewInput = events.find((event) => event.event === "review.input");
  assert.equal(reviewInput.test_result.command, "npm test");
  assert.equal(reviewInput.test_result.exit_code, 0);
  assert.equal(events.find((event) => event.event === "task.input").test.label, "跑現有測試：npm test");
});

test("R5b a project whose rules give no test command records not_configured, runs nothing, and still works", async (t) => {
  const { runtime, exitCode, run } = await start(t, { claudeMode: "stream" });
  assert.equal(exitCode, 0);
  assert.equal(run.conclusion, "success");
  assert.equal(run.test_passed, null);
  const gate = (await readIoEvents(runtime.paths, run.run_id)).find((event) => event.event === "test_result");
  assert.equal(gate.kind, "not_configured");
  assert.equal(gate.label, "沒有設定測試");
});

test("R6 failed tests skip the review and goes back to the writer as fix.input; the budget still ends the run", async (t) => {
  const { runtime, exitCode, error, run, status } = await start(t, { claudeMode: "stream", withTests: true, gateExit: 3, maxCalls: 1 });
  assert.equal(error, null);
  assert.equal(exitCode, 76);
  assert.equal(run.closed_reason, "rounds_exhausted");
  assert.equal(status.latest_state.test_passed, false);
  assert.equal(status.latest_state.test_exit_code, 3);
  const events = await readIoEvents(runtime.paths, run.run_id);
  assert.equal(events.some((event) => event.event === "review.input"), false);
  assert.equal(events.some((event) => event.event === "review.result"), false);
  assert.equal(events.find((event) => event.event === "test_result").passed, false);
});

test("R6b the second writer call gets the test result in its handoff, not a finding", async (t) => {
  const { runtime, error, run } = await start(t, { claudeMode: "stream", withTests: true, gateExit: 3, maxCalls: 2 });
  assert.equal(error, null);
  const events = await readIoEvents(runtime.paths, run.run_id);
  const fix = events.find((event) => event.event === "fix.input");
  assert.equal(fix.reason, "test_failed");
  assert.equal(fix.call, 2);
  assert.equal(fix.test_result.exit_code, 3);
  const handoff = events.find((event) => event.event === "handoff");
  assert.equal(handoff.reason, "test_failed");
  assert.equal(handoff.test_result.command, "npm test");
  assert.deepEqual(handoff.open_findings, []);
  assert.match(handoff.next, /現有測試失敗/);
  assert.equal(events.filter((event) => event.event === "task.input").length, 2);
});

test("R7 two test failures on an unchanged delta are a loop: hard_stop, no third writer call", async (t) => {
  const { runtime, exitCode, error, run, status } = await start(t, { claudeMode: "stream", withTests: true, gateExit: 1, maxCalls: 2, git: true });
  assert.equal(error, null);
  assert.equal(exitCode, 0);
  assert.equal(run.conclusion, "action_required");
  assert.equal(status.latest_state.hard_stop_reason, "needs_human_decision");
  const events = await readIoEvents(runtime.paths, run.run_id);
  assert.equal(events.filter((event) => event.event === "task.input").length, 2);
  assert.equal(events.at(-1).detail_ref, "test_loop");
  assert.equal(events.some((event) => event.event === "review.input"), false);
});

// Without Git there is no list of changes, so two failures in a row cannot be shown to be "nothing
// changed"; the call budget ends the run instead of a loop verdict.
test("R7b without Git two test failures are not called a loop; the budget ends the run", async (t) => {
  const { runtime, exitCode, error, run } = await start(t, { claudeMode: "stream", withTests: true, gateExit: 1, maxCalls: 2 });
  assert.equal(error, null);
  assert.equal(exitCode, 76);
  assert.equal(run.closed_reason, "rounds_exhausted");
  const events = await readIoEvents(runtime.paths, run.run_id);
  assert.equal(events.some((event) => event.detail_ref === "test_loop"), false);
});

test("R9 the tests passed but the reviewer failed: correction_pending with test_passed still true", async (t) => {
  const { runtime, exitCode, run, status } = await start(t, { claudeMode: "stream", withTests: true, codexMode: "fail", maxCalls: 1 });
  assert.equal(exitCode, 76);
  assert.equal(status.latest_state.test_passed, true);
  assert.equal(status.latest_state.review_gate, "FAIL");
  assert.equal(run.test_passed, true);
  const events = await readIoEvents(runtime.paths, run.run_id);
  assert.equal(events.find((event) => event.event === "review.result").gate, "FAIL");
});

// Codex review round 3: a controller that was interrupted lost its in-memory seal. Resuming a run
// whose earlier calls left records must stop before any model call, not spend a writer call first.
test("resuming a run whose earlier calls left work-proof records stops before any model call", async (t) => {
  const { exitCode, error, run, claudeArgs, runtime } = await start(t, {
    git: true,
    beforeResume: async (rt, authorization) => {
      // A record a first, interrupted round left behind, as the controller writes it.
      const windows = path.join(path.dirname(authorization.control.workspace_evidence.baseline_path), "windows");
      await fsp.mkdir(windows, { recursive: true });
      await fsp.writeFile(path.join(windows, "1-writer-1.json"), JSON.stringify({ run_id: authorization.run.run_id, call: 1, phase: "writer", started_at: new Date().toISOString(), ended_at: new Date().toISOString(), changed: [] }));
    },
  });
  assert.equal(error, null);
  assert.equal(exitCode, 0);
  assert.equal(run.closed_reason, "evidence_unconfirmable");
  assert.equal(claudeArgs, null, "no writer call was started");
  const events = await readIoEvents(runtime.paths, run.run_id);
  assert.equal(events.some((event) => event.event === "task.input"), false);
});
