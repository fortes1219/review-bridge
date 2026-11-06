// Keeps the person's database out of these tests (see the fixture).
import "./fixtures/isolatedDataHome.mjs";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readJson, writeJson } from "../service/records/fileStore.mjs";
import { getBridgePaths } from "../utils/paths.mjs";
import {
  classifyProviderFailure,
  codexDiagnosticTrailer,
  failureReasons,
} from "../service/agentCli/providerFailure.mjs";
import { parseClaudeStream } from "../service/agentCli/claude.mjs";
import { parseCodexJsonl } from "../service/agentCli/codex.mjs";
import { budgetStop } from "../features/workOrder/budget.mjs";
import { runReviewWorker } from "../features/workOrder/review.mjs";

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The project's id names its state and logs (RC3-FIX-02); a project built by hand gets one.
async function withProjectId(paths) {
  await fsp.mkdir(paths.privateRoot, { recursive: true });
  await fsp.writeFile(paths.bridgeConfigPath, JSON.stringify({ schema_version: 4, project_id: randomUUID() }));
}

// Observed s2-03 Codex reviewer stderr shape (fake replay; no model call).
export const CODEX_LIMIT_STDERR = [
  "review-bridge/ui/watch.css replacement=0 backspace=0 bytes=669",
  "",
  "ERROR: You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit "
    + "https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 10th, 2026 1:00 AM.",
  "tokens used",
  "65,580",
  "",
].join("\n");

function codex(texts, extra = {}) {
  return classifyProviderFailure({
    role: "reviewer", provider: "codex", phase: "review", exitCode: 1, texts: texts.map(codexDiagnosticTrailer), ...extra,
  });
}

function claude(texts, extra = {}) {
  return classifyProviderFailure({ role: "writer", provider: "claude", phase: "write", exitCode: 1, texts, ...extra });
}

test("observed Codex usage limit is reviewer provider_usage_limit with the CLI-supplied reset hint", () => {
  const failure = codex([CODEX_LIMIT_STDERR]);
  assert.equal(failure.role, "reviewer");
  assert.equal(failure.provider, "codex");
  assert.equal(failure.reason, "provider_usage_limit");
  assert.equal(failure.reset_hint, "Oct 10th, 2026 1:00 AM");
  assert.equal(failure.reset_hint_source, "cli_text");
  assert.equal(failure.exit_code, 1);
});

test("Codex limit wording echoed from tool output is not a provider limit", () => {
  const echoed = "  18:     ? \"usage limit reached; resets soon\"\nrate limited reviewer text\n";
  const failure = codex([echoed]);
  assert.equal(failure.reason, "provider_error");
  assert.equal(failure.reset_hint, null);
});

test("echoed ERROR-prefixed quota text before other output is not a Codex diagnostic", () => {
  const echoed = "exec: cat fixture.txt\nERROR: You've hit your usage limit. try again at 1:00 AM.\n"
    + "fixture continues\nERROR: stream disconnected before completion\ntokens used\n12\n";
  const failure = codex([echoed]);
  assert.equal(failure.reason, "provider_error");
  assert.equal(failure.reset_hint, null);
});

test("reset hints that are not a date/time shape are dropped", () => {
  const failure = claude(["You've hit your session limit \u00b7 resets with credential EXAMPLE"]);
  assert.equal(failure.reason, "provider_usage_limit");
  assert.equal(failure.reset_hint, null);
  assert.equal(claude(["usage limit reached; resets soon"]).reset_hint, null);
});

test("credential-shaped or unknown timezone text after a reset time yields no reset hint", () => {
  for (const text of [
    "You've hit your session limit · resets 3pm (Credential/EXAMPLE)",
    "You've hit your session limit · resets 3pm (Credential)",
    "You've hit your session limit · resets 3pm (Etc/Bogus)",
    "You've hit your session limit · resets 13pm (UTC)",
  ]) {
    const failure = claude([text]);
    assert.equal(failure.reason, "provider_usage_limit");
    assert.equal(failure.reset_hint, null);
    assert.equal(JSON.stringify(failure).includes("Credential"), false);
  }
});

test("credential-shaped month tokens yield no reset hint and never reach the record", () => {
  for (const token of ["Jancredential", "Octtoken", "Septsecret"]) {
    const failure = claude(["You've hit your session limit · resets " + token + " 3, 2026 3pm"]);
    assert.equal(failure.reason, "provider_usage_limit");
    assert.equal(failure.reset_hint, null);
    assert.equal(failure.reset_hint_source, null);
    assert.equal(JSON.stringify(failure).includes(token), false);
  }
  for (const hint of ["Jan 3, 2026 3pm", "January 3, 2026 3pm", "Sept 3rd, 2026 3:00 PM (UTC)"]) {
    assert.equal(claude(["You've hit your session limit · resets " + hint]).reset_hint, hint);
  }
});

test("explicit valid reset times with a known timezone or offset are kept", () => {
  for (const hint of ["3pm (Asia/Taipei)", "3:30 PM (UTC)", "3pm (UTC+8)", "3pm"]) {
    assert.equal(claude(["You've hit your session limit · resets " + hint]).reset_hint, hint);
  }
});

test("Codex limit without a reset phrase records no reset hint", () => {
  const failure = codex(["ERROR: You've hit your usage limit.\n"]);
  assert.equal(failure.reason, "provider_usage_limit");
  assert.equal(failure.reset_hint, null);
  assert.equal(failure.reset_hint_source, null);
});

test("Claude stdout and stderr quota variants are writer provider_usage_limit", () => {
  const stdoutVariant = claude(["Claude AI usage limit reached|1760000000"]);
  assert.equal(stdoutVariant.reason, "provider_usage_limit");
  assert.equal(stdoutVariant.reset_hint, null);
  const sessionVariant = claude(["", "You've hit your session limit · resets 3pm (Asia/Taipei)\n"]);
  assert.equal(sessionVariant.reason, "provider_usage_limit");
  assert.equal(sessionVariant.reset_hint, "3pm (Asia/Taipei)");
  assert.equal(sessionVariant.role, "writer");
});

test("generic CLI failures and timeouts are not quota failures", () => {
  assert.equal(claude(["", "Error: spawn EPERM\n"]).reason, "provider_error");
  assert.equal(claude(["not json at all"]).reason, "provider_error");
  assert.equal(claude(["usage: claude [options]"]).reason, "provider_error");
  assert.equal(codex(["ERROR: stream disconnected before completion\n"]).reason, "provider_error");
  const timeout = claude(["You've hit your usage limit"], { timedOut: true });
  assert.equal(timeout.reason, "timeout");
  assert.equal(timeout.reset_hint, null);
});

test("the CLI's typed error says signed out or out of usage; only those two codes of each", () => {
  for (const code of ["authentication_failed", "oauth_org_not_allowed", "unauthorized"]) assert.equal(claude([""], { code }).reason, "provider_signed_out", code);
  for (const code of ["rate_limit", "billing_error", "usageLimitExceeded"]) assert.equal(claude([""], { code }).reason, "provider_usage_limit", code);
  for (const code of ["overloaded", "invalid_request", "model_not_found", "server_error", "unknown", "max_output_tokens", "serverOverloaded", "contextWindowExceeded", null]) {
    assert.equal(claude([""], { code }).reason, "provider_error", String(code));
  }
  // With words beside the code the reset time is still read from them.
  assert.equal(claude(["You've hit your session limit · resets 3pm (UTC)"], { code: "rate_limit" }).reset_hint, "3pm (UTC)");
});

test("signed out in words: a whole line of the CLI's own, never a phrase in other text", () => {
  for (const text of [
    "Not logged in · Please run /login",
    "Login expired · Please run /login",
    "OAuth token revoked · Please run /login",
    "Invalid API key · Fix external API key",
    "Invalid auth token · Fix external auth token",
    "API Error: 401 Invalid API key · Please run /login",
    "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.",
    "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
    "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.",
    "Your access token could not be refreshed. Please log out and sign in again.",
    "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.",
  ]) assert.equal(claude([text]).reason, "provider_signed_out", text);
  // Echoed in a JSON line of a stream, or quoted in a sentence: not the CLI saying it.
  assert.equal(claude(['{"type":"assistant","text":"Not logged in · Please run /login"}']).reason, "provider_error");
  assert.equal(claude(["the docs say: Not logged in · Please run /login"]).reason, "provider_error");
});

test("a moment's trouble is not signed out and not out of quota, whatever comes with it", () => {
  const refreshing = "Could not refresh your login because another Claude Code process is refreshing it (or exited mid-refresh) · Try again in a minute";
  assert.equal(claude([refreshing]).reason, "provider_error");
  assert.equal(claude([refreshing], { code: "authentication_failed" }).reason, "provider_error");
  assert.equal(codex([], { texts: ["Reconnecting... 2/5 (stream disconnected before completion)"] }).reason, "provider_error");
});

test("the usage limit sentences of both CLIs' sources", () => {
  for (const text of [
    "You've hit your monthly spend limit.",
    "You've reached your Fable limit.",
    "You're out of usage credits",
    "Your org is out of usage · add funds to continue",
    "Your workspace is out of credits. Add credits to continue",
    "You’ve hit your monthly spend limit.",
  ]) assert.equal(claude([text]).reason, "provider_usage_limit", text);
});

test("Claude's typed error is read from the session's latest assistant line, not a sub-agent's and not an earlier one", () => {
  const line = (fields) => JSON.stringify({ type: "assistant", parent_tool_use_id: null, message: { id: "m", content: [{ type: "text", text: "said" }] }, ...fields });
  assert.deepEqual(parseClaudeStream([line({ error: "authentication_failed" }), JSON.stringify({ type: "result", is_error: true })].join("\n")).apiError, { code: "authentication_failed", text: "said" });
  assert.equal(parseClaudeStream([line({ error: "rate_limit" }), line({})].join("\n")).apiError, null, "it went on after that one");
  assert.equal(parseClaudeStream([line({ error: "authentication_failed", parent_tool_use_id: "t1" }), line({})].join("\n")).apiError, null, "a sub-agent's is not the session's");
  assert.deepEqual(parseClaudeStream([line({ error: "rate_limit" }), line({ error: "authentication_failed", parent_tool_use_id: "t1" })].join("\n")).apiError, { code: "rate_limit", text: "said" }, "nor does it clear the session's");
});

test("codex exec's errors are read from its own two event types in stdout; reconnecting and tool output are not", () => {
  const stream = [
    { type: "error", message: "Reconnecting... 1/5 (stream disconnected)" },
    { type: "item.completed", item: { type: "command_execution", aggregated_output: "You've hit your usage limit" } },
    { type: "error", message: "You've hit your usage limit." },
    { type: "turn.failed", error: { message: "You've hit your usage limit." } },
    { type: "turn.failed", error: { message: "Your access token could not be refreshed. Please log out and sign in again." } },
  ].map((event) => JSON.stringify(event)).join("\n");
  assert.deepEqual(parseCodexJsonl(stream).failures, ["You've hit your usage limit.", "Your access token could not be refreshed. Please log out and sign in again."]);
  assert.deepEqual(parseCodexJsonl(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "rate limit exceeded" } })).failures, []);
});

test("plan call budget stop is a controller reason, never a provider quota", () => {
  const stop = budgetStop({ phase: "correction", maxCalls: 2 });
  assert.equal(stop.reason, "work_package_call_budget");
  assert.equal(stop.provider, "review-bridge");
  assert.equal(stop.role, "controller");
  assert.equal(stop.reset_hint, null);
  assert.ok(failureReasons.includes(stop.reason));
});

// The worker on one queued job, with a Codex whose answer is this script.
async function reviewedBy(t, script) {
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-provider-failure-"));
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  const paths = getBridgePaths(repoRoot, bridgeRoot, { privateRootName: ".review-bridge" });
  await withProjectId(paths);
  const fakeCodex = path.join(repoRoot, "fake-codex.mjs");
  await fsp.writeFile(fakeCodex, script.join("\n"), "utf8");
  await fsp.mkdir(paths.pendingDir, { recursive: true });
  const deltaPath = path.join(paths.evidenceRoot, "e1", "delta-1.json");
  await fsp.mkdir(path.dirname(deltaPath), { recursive: true });
  await writeJson(deltaPath, { schema_version: 2, mode: "none", start_point: "unknown", scope_status: "unverified", commits_since_start: [], changed_files: [], scope_violations: [], scope_unverified: [] });
  await writeJson(path.join(paths.pendingDir, "job-1.json"), {
    priority: "medium", reasoning_effort: "medium", session_id: "session-1", authorization: { plan_sha256: "a".repeat(64) },
    workspace_evidence: { mode: "none", delta_path: deltaPath, scope_violations: [] }, last_assistant_message: "report\nCODEX_REVIEW_REQUIRED: true",
  });
  const [outcome] = await runReviewWorker({
    paths, noNotification: true,
    control: { active_writer_session: "session-1", authorization_plan_sha256: "a".repeat(64), reviewer_policy: { priority: "medium", model: null, effort: "medium" } },
    adapter: { async resolveExecutable() { return process.execPath; }, buildInvocation(kind, executable) { return { command: executable, args: [fakeCodex] }; }, async notify() {} },
  });
  return outcome;
}

// What 0.166 prints with --json (exec/src/event_processor_with_jsonl_output.rs), with nothing on stderr.
const codexStdout = (...events) => [
  "for await (const _ of process.stdin) {}",
  ...events.map((event) => "process.stdout.write(" + JSON.stringify(JSON.stringify(event) + "\n") + ");"),
  "process.exit(1);",
];

test("a reviewer out of quota under codex exec --json is a usage limit, though its stderr is empty", async (t) => {
  const outcome = await reviewedBy(t, codexStdout(
    { type: "thread.started", thread_id: "t" },
    { type: "error", message: "You've hit your usage limit. Try again later." },
    { type: "turn.failed", error: { message: "You've hit your usage limit. Try again later." } },
  ));
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.provider_failure.reason, "provider_usage_limit");
});

test("a reviewer whose login ended under codex exec --json says signed out; one still reconnecting when it failed does not", async (t) => {
  const signedOut = await reviewedBy(t, codexStdout({ type: "turn.failed", error: { message: "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again." } }));
  assert.equal(signedOut.provider_failure.reason, "provider_signed_out");
  const reconnecting = await reviewedBy(t, codexStdout({ type: "error", message: "Reconnecting... 5/5 (stream disconnected before completion)" }));
  assert.equal(reconnecting.provider_failure.reason, "provider_error");
});

test("review worker preserves the failed job and links a private typed failure record", async () => {
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-provider-failure-"));
  try {
    const paths = getBridgePaths(repoRoot, bridgeRoot, { privateRootName: ".review-bridge" });
    await withProjectId(paths);
    const fakeCodex = path.join(repoRoot, "fake-codex-limit.mjs");
    await fsp.writeFile(fakeCodex, [
      "for await (const _ of process.stdin) {}",
      "process.stderr.write(" + JSON.stringify(CODEX_LIMIT_STDERR) + ");",
      "process.exit(1);",
    ].join("\n"), "utf8");
    const control = {
      active_writer_session: "session-1",
      authorization_plan_sha256: "a".repeat(64),
      reviewer_policy: { priority: "medium", model: null, effort: "medium" },
    };
    await fsp.mkdir(paths.pendingDir, { recursive: true });
    // Every queued job carries its change list; this one is from a project without Git.
    const deltaPath = path.join(paths.evidenceRoot, "e1", "delta-1.json");
    await fsp.mkdir(path.dirname(deltaPath), { recursive: true });
    await writeJson(deltaPath, {
      schema_version: 2, mode: "none", start_point: "unknown", scope_status: "unverified",
      commits_since_start: [], changed_files: [], scope_violations: [], scope_unverified: [],
    });
    await writeJson(path.join(paths.pendingDir, "job-1.json"), {
      priority: "medium",
      reasoning_effort: "medium",
      session_id: "session-1",
      authorization: { plan_sha256: "a".repeat(64) },
      workspace_evidence: { mode: "none", delta_path: deltaPath, scope_violations: [] },
      last_assistant_message: "Claude report\nCODEX_REVIEW_REQUIRED: true",
    });
    const adapter = {
      async resolveExecutable() { return process.execPath; },
      buildInvocation(kind, executable) { return { command: executable, args: [fakeCodex] }; },
      async notify() {},
    };
    const outcomes = await runReviewWorker({ paths, control, adapter, noNotification: true });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].status, "failed");
    assert.equal(outcomes[0].provider_failure.reason, "provider_usage_limit");
    const failedJob = await readJson(path.join(paths.failedDir, "job-1.json"));
    assert.equal(failedJob.status, "failed");
    assert.equal(failedJob.provider_failure.role, "reviewer");
    assert.equal(outcomes[0].job_path, path.join(paths.failedDir, "job-1.json"));
    const record = await readJson(outcomes[0].provider_failure.record_path);
    assert.equal(record.reason, "provider_usage_limit");
    assert.equal(record.evidence.stderr_path, path.join(paths.reviewsRoot, "job-1-reviewer.stderr.log"));
    assert.match(await fsp.readFile(record.evidence.stderr_path, "utf8"), /hit your usage limit/);
    assert.equal(JSON.stringify(record).includes("chatgpt.com"), false);
  } finally {
    await fsp.rm(repoRoot, { recursive: true, force: true });
  }
});
