import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runBoundedResume } from "../core/bounded-resume.mjs";
import { fileExists, readJson, writeJson } from "../core/io.mjs";
import { getBridgePaths } from "../core/paths.mjs";
import { createRunRuntimeState, readRun } from "../core/state-v4.mjs";
import {
  authorizeV4WorkPackage,
  createV4WorkPackagePlan,
  v4WorkPackageStatus,
} from "../core/work-package-v4.mjs";

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CODEX_LIMIT_STDERR = "tool output\nERROR: You’ve hit your usage limit. Upgrade to Pro "
  + "(https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more "
  + "credits or try again at Oct 10th, 2026 1:00 AM.\ntokens used\n65,580\n";

const STALE_JOB_ID = "20000101T000000000Z-0000000000000000";

const fakeClaudeSource = `
import fsp from "node:fs/promises";
import path from "node:path";
for await (const _ of process.stdin) {}
const args = process.argv;
const at = args.indexOf("--session-id") >= 0 ? args.indexOf("--session-id") : args.indexOf("--resume");
const session = args[at + 1];
const mode = process.env.T_CLAUDE;
if (process.env.T_ARGS_OUT) await fsp.writeFile(process.env.T_ARGS_OUT, JSON.stringify(args.slice(2)));
const ok = { session_id: session, is_error: false, result: "report\\nCODEX_REVIEW_REQUIRED: true" };
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
for await (const _ of process.stdin) {}
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
await fsp.writeFile(out, "HARD_STOP_REQUIRED: false\\nREVIEW_GATE: " + (mode === "fail" ? "FAIL" : "PASS") + "\\n");
`;

async function makeRuntime(t, override = { schema_version: 4 }) {
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-bounded-"));
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  const paths = getBridgePaths(repoRoot, bridgeRoot);
  await writeJson(paths.bridgeConfigPath, {
    schema_version: 4, state_contract: "v4", active_runs: "derive_from_run_projections",
  });
  await writeJson(paths.policyOverridePath, override);
  await fsp.writeFile(path.join(repoRoot, "README.md"), "# fixture\n", "utf8");
  const claude = path.join(repoRoot, "fake-claude.mjs");
  const codex = path.join(repoRoot, "fake-codex.mjs");
  await fsp.writeFile(claude, fakeClaudeSource, "utf8");
  await fsp.writeFile(codex, fakeCodexSource, "utf8");
  return { repoRoot, paths, claude, codex };
}

async function start(t, { claudeMode = "ok", codexMode = "pass", maxCalls = 1, staleJob = false, override } = {}) {
  const runtime = await makeRuntime(t, override);
  const argsOut = path.join(runtime.repoRoot, "claude-args.json");
  const planPath = path.join(runtime.paths.queueRoot, "plan.json");
  const plan = await createV4WorkPackagePlan({
    paths: runtime.paths,
    task: "Update README.md only.",
    owner: "Human Owner",
    workPackage: "s2-04-fixture",
    breakpoint: "return after review",
    changeTypes: "docs",
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
        },
      };
    },
    async notify() {},
  };
  const runId = authorization.run.run_id;
  let exitCode;
  let error = null;
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
  assert.match(writer.result, /CODEX_REVIEW_REQUIRED: true/);
});

test("an unrelated pending job failure is not attributed to this run", async (t) => {
  const { runtime, exitCode, error, status, run } = await start(t, { staleJob: true });
  assert.equal(error, null);
  assert.equal(exitCode, 0);
  assert.notEqual(run.status, "rate_limited");
  assert.equal(status.latest_state.status, "pass");
  assert.equal(status.latest_state.failed_review_job_path, undefined);
  assert.equal(status.stop_reason?.reason === "provider_usage_limit", false);
  assert.equal(await fileExists(path.join(runtime.paths.failedDir, STALE_JOB_ID + ".json")), true);
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
