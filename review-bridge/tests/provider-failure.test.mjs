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

test("plan call budget stop is a controller reason, never a provider quota", () => {
  const stop = budgetStop({ phase: "correction", maxCalls: 2 });
  assert.equal(stop.reason, "work_package_call_budget");
  assert.equal(stop.provider, "review-bridge");
  assert.equal(stop.role, "controller");
  assert.equal(stop.reset_hint, null);
  assert.ok(failureReasons.includes(stop.reason));
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
