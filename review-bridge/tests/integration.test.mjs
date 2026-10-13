import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runBoundedResume } from "../core/bounded-resume.mjs";
import { dispatchCommand } from "../core/commands.mjs";
import { inspectDoctor } from "../core/doctor.mjs";
import { createFakeAdapter } from "../core/fake-adapter.mjs";
import { parseReviewGate } from "../core/gate.mjs";
import { acquireLock, readJson, writeJson, writeText } from "../core/io.mjs";
import { getBridgePaths } from "../core/paths.mjs";
import { validateWriterPolicy } from "../core/policy.mjs";
import {
  detectMarker,
  enqueueReview,
  hasPendingMessageHash,
  queueStatus,
  validateHookPayload,
} from "../core/queue.mjs";
import { runReviewWorker } from "../core/review.mjs";
import {
  authorizeWorkPackage,
  cancelWorkPackage,
  createWorkPackagePlan,
  workPackageStatus,
} from "../core/work-package.mjs";
import { createWorkspaceBaseline } from "../core/workspace-evidence.mjs";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const bridgeRoot = path.resolve(testRoot, "..");
const fakeCodex = path.join(testRoot, "fixtures", "fake-codex.mjs");
const fakeClaude = path.join(testRoot, "fixtures", "fake-claude.mjs");

function makeControl(maxCalls = 1) {
  return {
    schema_version: 2,
    authorization_status: "active",
    mode: "bounded_standing_correction",
    dispatch_transport: "claude_cli_resume_same_session",
    active_claude_session: "session-test-1",
    iteration: 0,
    codex_policy: {
      classification_profile: "test-profile-v1",
      default_review_level: "STANDARD",
      allowed_review_levels: ["LIGHT", "STANDARD", "FULL", "SECURITY", "FINAL_CLOSURE"],
      effort_by_level: {
        LIGHT: "low",
        STANDARD: "medium",
        FULL: "high",
        SECURITY: "high",
        FINAL_CLOSURE: "high",
      },
    },
    token_policy: {
      claude_mode: "writer_only",
      claude_effort: "low",
      claude_disallowed_tools: ["Agent"],
      independent_semantic_reviewer: "Codex",
      claude_self_review: "one_local_consistency_pass",
      full_reconstruction_on_correction: false,
      full_reconstruction_requires_human: true,
      max_claude_calls_per_resume: maxCalls,
      max_claude_minutes_per_call: 1,
    },
  };
}

test("writer policy requires the generic human-owner reconstruction gate", () => {
  const control = makeControl(1);
  delete control.token_policy.full_reconstruction_requires_human;
  assert.throws(
    () => validateWriterPolicy(control, 1, 1),
    /active writer-only bounded authorization/,
  );
});

test("R1 legacy work-plan accepts multiline task files with tabs and backticks", async () => {
  const runtime = await makeRuntime();
  try {
    runtime.control.authorization_status = "consumed";
    await writeJson(runtime.paths.controlPath, runtime.control);
    const task = "# Work\n\nUpdate `README.md`.\n\tKeep this indented note.";
    const taskFile = path.join(runtime.paths.privateRoot, "work-packages", "r1-legacy.md");
    const outPath = path.join(runtime.paths.queueRoot, "r1-legacy.plan.json");
    await writeText(taskFile, task);
    const plan = await createWorkPackagePlan({
      paths: runtime.paths,
      control: runtime.control,
      taskFile,
      owner: "RC2 Test Owner",
      workPackage: "r1-legacy",
      breakpoint: "return after review",
      changeTypes: "docs",
      allowedPaths: "README.md",
      maxCalls: 1,
      maxMinutes: 1,
      outPath,
    });
    assert.equal(plan.task, task);
  } finally {
    await runtime.cleanup();
  }
});

function makeClassificationProfile() {
  return {
    schema_version: 1,
    profile_id: "test-profile-v1",
    rules: [
      {
        level: "FINAL_CLOSURE",
        reason: "final closure review",
        any: ["final closure"],
      },
      {
        level: "SECURITY",
        reason: "security review",
        any: ["auth", "permission"],
      },
      {
        level: "FULL",
        reason: "full review",
        any: ["cross-contract"],
      },
      {
        level: "LIGHT",
        reason: "light review",
        any: ["typo"],
        none: ["contract", "security"],
      },
    ],
  };
}

function makeAdapter(gates = "PASS") {
  const sequence = Array.isArray(gates) ? gates : [gates];
  let codexCalls = 0;
  let claudeCalls = 0;
  const invocations = [];
  return {
    invocations,
    async resolveExecutable() {
      return process.execPath;
    },
    buildInvocation(kind, executable, args) {
      const fixture = kind === "codex" ? fakeCodex : fakeClaude;
      const gate = sequence[Math.min(codexCalls, sequence.length - 1)];
      if (kind === "codex") codexCalls += 1;
      else claudeCalls += 1;
      invocations.push({ kind, args: [...args] });
      return {
        command: executable,
        args: [fixture, ...args],
        env: {
          ...process.env,
          FAKE_CODEX_GATE: gate,
          FAKE_CLAUDE_CALL: String(claudeCalls),
        },
      };
    },
    async notify() {},
  };
}

async function makeRuntime(maxCalls = 1) {
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-test-"));
  const paths = getBridgePaths(repoRoot, bridgeRoot);
  const control = makeControl(maxCalls);
  await fsp.mkdir(paths.queueRoot, { recursive: true });
  await fsp.writeFile(path.join(repoRoot, "README.md"), "# Runtime fixture\n", "utf8");
  control.authorized_scope = { change_types: ["docs"], allowed_paths: ["README.md"] };
  control.workspace_evidence = await createWorkspaceBaseline({
    paths,
    planSha256: "f".repeat(64),
    allowedPaths: control.authorized_scope.allowed_paths,
  });
  await writeJson(paths.controlPath, control);
  await writeJson(paths.classificationProfilePath, makeClassificationProfile());
  return {
    repoRoot,
    paths,
    control,
    async cleanup() {
      await fsp.rm(repoRoot, { recursive: true, force: true });
    },
  };
}

async function captureStdout(callback) {
  const original = process.stdout.write;
  const chunks = [];
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const result = await callback();
    return { result, output: chunks.join("") };
  } finally {
    process.stdout.write = original;
  }
}

test("marker detection supports explicit, legacy, and localized handoff forms", () => {
  assert.equal(detectMarker("CODEX_REVIEW_REQUIRED: true").explicit, true);
  assert.equal(detectMarker("[Claude -> Codex report]\nreview complete").legacy, true);
  assert.equal(
    detectMarker("\u53efhandoff\u7d66codex:\n\u5be9\u67e5\u56de\u5831").handoff,
    true,
  );
});

test("Stop hook payload schema requires every controller field", () => {
  assert.deepEqual(validateHookPayload({
    cwd: "C:/repo",
    last_assistant_message: "report",
    stop_hook_active: false,
  }), {
    valid: false,
    invalid_fields: ["session_id"],
  });
  assert.equal(validateHookPayload({
    session_id: "session-test-1",
    cwd: "C:/repo",
    last_assistant_message: "report",
    stop_hook_active: false,
  }).valid, true);
});

test("classification profile is project-owned and recorded in queue metadata", async () => {
  const runtime = await makeRuntime();
  try {
    const result = await enqueueReview({
      payload: {
        session_id: "session-test-1",
        cwd: runtime.repoRoot,
        stop_hook_active: false,
        last_assistant_message: "auth boundary\nCODEX_REVIEW_REQUIRED: true",
      },
      paths: runtime.paths,
      control: runtime.control,
      validateOnly: true,
    });
    assert.equal(result.review_level, "SECURITY");
    assert.equal(result.classification_profile, "test-profile-v1");
  } finally {
    await runtime.cleanup();
  }
});

test("hook-first duplicate is accepted only while the matching job is pending", async () => {
  const runtime = await makeRuntime();
  try {
    const payload = {
      session_id: "session-test-1",
      cwd: runtime.repoRoot,
      last_assistant_message: "CODEX_REVIEW_REQUIRED: true\nhook-first duplicate",
      stop_hook_active: false,
    };
    const first = await enqueueReview({ payload, paths: runtime.paths, control: runtime.control });
    assert.equal(first.accepted, true);
    assert.equal(first.duplicate, false);
    const duplicate = await enqueueReview({ payload, paths: runtime.paths, control: runtime.control });
    assert.equal(duplicate.accepted, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal(await hasPendingMessageHash(runtime.paths, duplicate.message_hash), true);

    await runReviewWorker({
      paths: runtime.paths,
      control: runtime.control,
      adapter: makeAdapter("PASS"),
      dryRun: true,
      noNotification: true,
    });
    assert.equal(await hasPendingMessageHash(runtime.paths, duplicate.message_hash), false);
  } finally {
    await runtime.cleanup();
  }
});

test("project-owned review prompt overrides the packaged generic prompt", async () => {
  const runtime = await makeRuntime();
  try {
    const customPrompt = "PROJECT REVIEW {{REPORT_PATH}}\n";
    await writeText(runtime.paths.reviewPromptOverridePath, customPrompt);
    const job = await enqueueReview({
      payload: {
        session_id: "session-test-1",
        cwd: runtime.repoRoot,
        last_assistant_message: "CODEX_REVIEW_REQUIRED: true\nproject prompt test",
        stop_hook_active: false,
      },
      paths: runtime.paths,
      control: runtime.control,
    });
    assert.equal(job.accepted, true);
    await runReviewWorker({
      paths: runtime.paths,
      control: runtime.control,
      adapter: makeAdapter("PASS"),
      dryRun: true,
      noNotification: true,
    });
    const rendered = await fsp.readFile(
      path.join(runtime.paths.reviewsRoot, job.job.job_id + "-review-prompt.md"),
      "utf8",
    );
    assert.match(rendered, /^PROJECT REVIEW /);
  } finally {
    await runtime.cleanup();
  }
});

test("doctor reports authorization, queue, profile, and lock health without changing state", async () => {
  const runtime = await makeRuntime();
  try {
    const result = await inspectDoctor({
      paths: runtime.paths,
      adapter: { target: "test-x64", id: "test-adapter" },
      manifest: { commands: ["enqueue", "review", "bounded-resume"] },
      nodeVersion: "test-node",
    });
    assert.equal(result.authorization.status, "active");
    assert.equal(result.classification.valid, true);
    assert.deepEqual(result.queue, { pending: 0, running: 0, done: 0, failed: 0 });
    assert.equal(result.locks.worker.status, "clear");
    assert.equal(result.bounded_resume_ready, true);

    runtime.control.authorization_status = "consumed";
    await writeJson(runtime.paths.controlPath, runtime.control);
    const consumed = await inspectDoctor({
      paths: runtime.paths,
      adapter: { target: "test-x64", id: "test-adapter" },
      manifest: { commands: [] },
    });
    assert.equal(consumed.bounded_resume_ready, false);
    assert.match(consumed.warnings.join("\n"), /authorization is not active/);
    assert.deepEqual(consumed.legacy_warnings, []);
  } finally {
    await runtime.cleanup();
  }
});

test("JSON reader accepts a UTF-8 BOM", async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-bom-"));
  const file = path.join(directory, "control.json");
  await fsp.writeFile(file, "\uFEFF{\"ok\":true}\n", "utf8");
  assert.deepEqual(await readJson(file), { ok: true });
  await fsp.rm(directory, { recursive: true, force: true });
});

test("review gate parser rejects missing and duplicate machine-readable gates", () => {
  assert.deepEqual(
    parseReviewGate("HARD_STOP_REQUIRED: false\nREVIEW_GATE: PASS\n"),
    { review_gate: "PASS", hard_stop_required: false },
  );
  assert.throws(
    () => parseReviewGate([
      "HARD_STOP_REQUIRED: false",
      "REVIEW_GATE: PASS",
      "HARD_STOP_REQUIRED: true",
      "REVIEW_GATE: FAIL",
    ].join("\n")),
    /exactly one REVIEW_GATE line/,
  );
  assert.throws(
    () => parseReviewGate("review completed without gates"),
    /exactly one REVIEW_GATE line/,
  );
});

test("queue worker deduplicates and writes durable review artifacts", async () => {
  const runtime = await makeRuntime();
  try {
    const payload = {
      session_id: "session-test-1",
      cwd: runtime.repoRoot,
      stop_hook_active: false,
      last_assistant_message: [
        "[Claude -> Codex report]",
        "focused correction report",
        "CODEX_REVIEW_REQUIRED: true",
      ].join("\n"),
    };
    const first = await enqueueReview({
      payload,
      paths: runtime.paths,
      control: runtime.control,
    });
    const second = await enqueueReview({
      payload,
      paths: runtime.paths,
      control: runtime.control,
    });
    assert.equal(first.accepted, true);
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);

    await runReviewWorker({
      paths: runtime.paths,
      control: runtime.control,
      adapter: makeAdapter("PASS"),
      noNotification: true,
    });
    const status = await queueStatus(runtime.paths);
    assert.equal(status.pending, 0);
    assert.equal(status.running, 0);
    assert.equal(status.done, 1);
    assert.equal(status.failed, 0);
    const latest = await fsp.readFile(runtime.paths.latestPath, "utf8");
    const review = await fsp.readFile(latest.trim(), "utf8");
    assert.match(review, /REVIEW_GATE: PASS/);
  } finally {
    await runtime.cleanup();
  }
});

test("manual payload mode returns nonzero and records only field names for invalid shape", async () => {
  const runtime = await makeRuntime();
  try {
    const payloadPath = path.join(runtime.paths.queueRoot, "invalid-payload.json");
    await writeJson(payloadPath, {
      cwd: runtime.repoRoot,
      stop_hook_active: false,
      last_assistant_message: "CODEX_REVIEW_REQUIRED: true",
    });
    const exitCode = await dispatchCommand({
      command: "enqueue",
      args: ["--payload", payloadPath, "--no-start"],
      repoRoot: runtime.repoRoot,
      bridgeRoot,
      adapter: makeAdapter("PASS"),
    });
    assert.equal(exitCode, 2);
    // T0-02: hook warnings are lines in today's day file, not a separate log.
    const archiveFiles = await fsp.readdir(runtime.paths.archiveDir);
    assert.equal(archiveFiles.length, 1);
    const log = await fsp.readFile(path.join(runtime.paths.archiveDir, archiveFiles[0]), "utf8");
    assert.match(log, /"type":"hook_error"/);
    assert.match(log, /reason=invalid_payload fields=session_id/);
    assert.doesNotMatch(log, /CODEX_REVIEW_REQUIRED/);
    assert.equal(await fsp.stat(path.join(runtime.paths.queueRoot, "hook-errors.log")).catch(() => null), null);
  } finally {
    await runtime.cleanup();
  }
});

test("bounded resume keeps the Claude session and reaches PASS in one call", async () => {
  const runtime = await makeRuntime();
  try {
    const promptPath = path.join(runtime.paths.queueRoot, "authorized-prompt.txt");
    await writeText(promptPath, "Fix only finding H-1.\n");
    const exitCode = await runBoundedResume({
      paths: runtime.paths,
      control: runtime.control,
      adapter: makeAdapter("PASS"),
      promptPath,
      maxCalls: 1,
      maxMinutes: 1,
    });
    assert.equal(exitCode, 0);
    const state = await readJson(runtime.paths.boundedStatePath);
    assert.equal(state.status, "pass");
    assert.equal(state.session_id, "session-test-1");
    assert.equal((await queueStatus(runtime.paths)).done, 1);
  } finally {
    await runtime.cleanup();
  }
});

test("bounded resume performs one named correction and then reaches PASS", async () => {
  const runtime = await makeRuntime(2);
  try {
    const promptPath = path.join(runtime.paths.queueRoot, "authorized-prompt.txt");
    await writeText(promptPath, "Fix only finding H-1.\n");
    const exitCode = await runBoundedResume({
      paths: runtime.paths,
      control: runtime.control,
      adapter: makeAdapter(["FAIL", "PASS"]),
      promptPath,
      maxCalls: 2,
      maxMinutes: 1,
    });
    assert.equal(exitCode, 0);
    const state = await readJson(runtime.paths.boundedStatePath);
    assert.equal(state.status, "pass");
    assert.equal(state.call, 2);
    assert.equal((await queueStatus(runtime.paths)).done, 2);
    const storedControl = await readJson(runtime.paths.controlPath);
    assert.equal(storedControl.iteration, 1);
    assert.equal(storedControl.authorization_status, "consumed");
    assert.equal(storedControl.closed_reason, "review_pass");
  } finally {
    await runtime.cleanup();
  }
});

test("malformed Codex gates fail closed and release the controller lock", async () => {
  const runtime = await makeRuntime();
  try {
    const promptPath = path.join(runtime.paths.queueRoot, "authorized-prompt.txt");
    await writeText(promptPath, "Fix only finding H-1.\n");
    await assert.rejects(
      runBoundedResume({
        paths: runtime.paths,
        control: runtime.control,
        adapter: makeAdapter("MALFORMED"),
        promptPath,
        maxCalls: 1,
        maxMinutes: 1,
      }),
      /exactly one REVIEW_GATE line/,
    );
    const state = await readJson(runtime.paths.boundedStatePath);
    assert.equal(state.status, "malformed_review_gate");
    const storedControl = await readJson(runtime.paths.controlPath);
    assert.equal(storedControl.authorization_status, "consumed");
    assert.equal(storedControl.closed_reason, "malformed_review_gate");
    const release = await acquireLock(runtime.paths.boundedLockPath);
    await release();
  } finally {
    await runtime.cleanup();
  }
});

test("generic controller failure replaces stale bounded state", async () => {
  const runtime = await makeRuntime();
  try {
    const repeatedReport = [
      "[Claude -> Codex report]",
      "focused correction report call 1",
      "CODEX_REVIEW_REQUIRED: true",
    ].join("\n");
    await enqueueReview({
      payload: {
        session_id: "session-test-1",
        cwd: runtime.repoRoot,
        last_assistant_message: repeatedReport,
        stop_hook_active: false,
      },
      paths: runtime.paths,
      control: runtime.control,
    });
    await runReviewWorker({
      paths: runtime.paths,
      control: runtime.control,
      adapter: makeAdapter("PASS"),
      dryRun: true,
      noNotification: true,
    });
    await writeJson(runtime.paths.boundedStatePath, {
      status: "pass",
      session_id: "older-session",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const promptPath = path.join(runtime.paths.queueRoot, "authorized-prompt.txt");
    await writeText(promptPath, "Fix only finding H-1.\n");

    await assert.rejects(
      runBoundedResume({
        paths: runtime.paths,
        control: runtime.control,
        adapter: makeAdapter("PASS"),
        promptPath,
        maxCalls: 1,
        maxMinutes: 1,
      }),
      /did not create a new review job/,
    );
    const state = await readJson(runtime.paths.boundedStatePath);
    assert.equal(state.status, "controller_failure");
    assert.equal(state.session_id, "session-test-1");
    const storedControl = await readJson(runtime.paths.controlPath);
    assert.equal(storedControl.authorization_status, "consumed");
    assert.equal(storedControl.closed_reason, "controller_failure");
  } finally {
    await runtime.cleanup();
  }
});

test("consumed standing authorization cannot be replayed", async () => {
  const runtime = await makeRuntime();
  try {
    runtime.control.authorization_status = "consumed";
    await writeJson(runtime.paths.controlPath, runtime.control);
    const promptPath = path.join(runtime.paths.queueRoot, "authorized-prompt.txt");
    await writeText(promptPath, "Fix only finding H-1.\n");
    await assert.rejects(
      runBoundedResume({
        paths: runtime.paths,
        control: runtime.control,
        adapter: makeAdapter("PASS"),
        promptPath,
        maxCalls: 1,
        maxMinutes: 1,
      }),
      /authorization is consumed/,
    );
  } finally {
    await runtime.cleanup();
  }
});

test("queue rejects inactive authorization and the wrong Claude session", async () => {
  const runtime = await makeRuntime();
  try {
    runtime.control.authorization_status = "inactive";
    let result = await enqueueReview({
      payload: {
        session_id: "session-test-1",
        cwd: runtime.repoRoot,
        last_assistant_message: "CODEX_REVIEW_REQUIRED: true",
        stop_hook_active: false,
      },
      paths: runtime.paths,
      control: runtime.control,
    });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, "authorization_inactive");

    runtime.control.authorization_status = "active";
    result = await enqueueReview({
      payload: {
        session_id: "another-session",
        cwd: runtime.repoRoot,
        last_assistant_message: "CODEX_REVIEW_REQUIRED: true",
        stop_hook_active: false,
      },
      paths: runtime.paths,
      control: runtime.control,
    });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, "session_mismatch");
  } finally {
    await runtime.cleanup();
  }
});

test("a human-approved work plan starts a fresh Claude session and reaches PASS", async () => {
  const runtime = await makeRuntime();
  try {
    runtime.control.authorization_status = "inactive";
    runtime.control.closed_reason = "installer_seed";
    runtime.control.active_claude_session = null;
    await writeJson(runtime.paths.controlPath, runtime.control);
    const taskPath = path.join(runtime.paths.privateRoot, "work-packages", "first-task.md");
    const planPath = path.join(runtime.paths.queueRoot, "first-work-plan.json");
    await writeText(taskPath, "Update README.md only and do not commit.\n");
    const plan = await createWorkPackagePlan({
      paths: runtime.paths,
      control: runtime.control,
      taskFile: taskPath,
      owner: "Human Owner",
      workPackage: "trial-001",
      breakpoint: "return after Codex review",
      changeTypes: "docs",
      allowedPaths: "README.md",
      maxCalls: 1,
      maxMinutes: 1,
      outPath: planPath,
    });
    assert.equal((await readJson(runtime.paths.controlPath)).authorization_status, "inactive");

    const authorization = await authorizeWorkPackage({
      paths: runtime.paths,
      planPath,
      approval: plan.plan_sha256,
    });
    const adapter = makeAdapter("PASS");
    const exitCode = await runBoundedResume({
      paths: runtime.paths,
      control: authorization.control,
      adapter,
      promptPath: authorization.promptPath,
      maxCalls: 1,
      maxMinutes: 1,
      startNewSession: true,
    });
    assert.equal(exitCode, 0);
    const firstClaude = adapter.invocations.find((entry) => entry.kind === "claude");
    assert.ok(firstClaude.args.includes("--session-id"));
    assert.ok(!firstClaude.args.includes("--resume"));
    const status = await workPackageStatus(runtime.paths);
    assert.equal(status.work_package, "trial-001");
    assert.equal(status.authorization_status, "consumed");
    assert.equal(status.closed_reason, "review_pass");
    assert.equal(status.latest_state.status, "pass");
    const doneJob = await readJson((await fsp.readdir(runtime.paths.doneDir)).map(
      (name) => path.join(runtime.paths.doneDir, name),
    )[0]);
    assert.equal(doneJob.authorization.work_package, "trial-001");
    assert.deepEqual(doneJob.authorization.scope.allowed_paths, ["README.md"]);
  } finally {
    await runtime.cleanup();
  }
});

test("a work package plan becomes stale when CONTROL changes", async () => {
  const runtime = await makeRuntime();
  try {
    runtime.control.authorization_status = "inactive";
    runtime.control.active_claude_session = null;
    await writeJson(runtime.paths.controlPath, runtime.control);
    const planPath = path.join(runtime.paths.queueRoot, "stale-plan.json");
    const plan = await createWorkPackagePlan({
      paths: runtime.paths,
      control: runtime.control,
      task: "Update README.md only.",
      owner: "Human Owner",
      workPackage: "trial-stale",
      breakpoint: "return after review",
      changeTypes: "docs",
      allowedPaths: "README.md",
      maxCalls: 1,
      maxMinutes: 1,
      outPath: planPath,
    });
    runtime.control.closed_reason = "changed_after_plan";
    await writeJson(runtime.paths.controlPath, runtime.control);
    await assert.rejects(
      authorizeWorkPackage({ paths: runtime.paths, planPath, approval: plan.plan_sha256 }),
      /plan is stale because CONTROL changed/,
    );
  } finally {
    await runtime.cleanup();
  }
});

test("a human can cancel an authorized work package before execution", async () => {
  const runtime = await makeRuntime();
  try {
    runtime.control.authorization_status = "inactive";
    runtime.control.active_claude_session = null;
    await writeJson(runtime.paths.controlPath, runtime.control);
    const planPath = path.join(runtime.paths.queueRoot, "cancel-plan.json");
    const plan = await createWorkPackagePlan({
      paths: runtime.paths,
      control: runtime.control,
      task: "Update README.md only.",
      owner: "Human Owner",
      workPackage: "trial-cancel",
      breakpoint: "return after review",
      changeTypes: "docs",
      allowedPaths: "README.md",
      maxCalls: 1,
      maxMinutes: 1,
      outPath: planPath,
    });
    await authorizeWorkPackage({ paths: runtime.paths, planPath, approval: plan.plan_sha256 });
    await cancelWorkPackage({ paths: runtime.paths, reason: "cancelled_by_test_owner" });
    const status = await workPackageStatus(runtime.paths);
    assert.equal(status.authorization_status, "consumed");
    assert.equal(status.closed_reason, "cancelled_by_test_owner");
    assert.equal(status.latest_state.status, "cancelled");
  } finally {
    await runtime.cleanup();
  }
});

test("work-plan and work-start CLI commands complete the first work package", async () => {
  const runtime = await makeRuntime();
  try {
    runtime.control.authorization_status = "inactive";
    runtime.control.active_claude_session = null;
    await writeJson(runtime.paths.controlPath, runtime.control);
    const planPath = path.join(runtime.paths.queueRoot, "cli-first-plan.json");
    const planned = await captureStdout(() => dispatchCommand({
      command: "work-plan",
      args: [
        "--task", "Update README.md only.",
        "--owner", "Human Owner",
        "--work-package", "cli-trial-001",
        "--breakpoint", "return after review",
        "--change-types", "docs",
        "--allow-paths", "README.md",
        "--max-claude-calls", "1",
        "--max-claude-minutes", "1",
        "--out", planPath,
      ],
      repoRoot: runtime.repoRoot,
      bridgeRoot,
      adapter: makeAdapter("PASS"),
    }));
    assert.equal(planned.result, 0);
    const summary = JSON.parse(planned.output);
    assert.equal(summary.valid, true);
    assert.equal(summary.work_package, "cli-trial-001");
    assert.equal(summary.scope.allowed_paths[0], "README.md");

    const started = await captureStdout(() => dispatchCommand({
      command: "work-start",
      args: ["--plan", planPath, "--approve", summary.plan_sha256, "--fake-cli", "--fake-scenario", "PASS", "--json"],
      repoRoot: runtime.repoRoot,
      bridgeRoot,
      adapter: makeAdapter("PASS"),
    }));
    assert.equal(started.result, 0);
    const status = JSON.parse(started.output);
    assert.equal(status.authorization_status, "consumed");
    assert.equal(status.execution_mode, "fake_cli");
    assert.equal(status.latest_state.status, "pass");
  } finally {
    await runtime.cleanup();
  }
});

test("public fake adapter covers PASS, FAIL-to-PASS, HARD STOP, and RATE LIMIT", async (t) => {
  const cases = [
    { scenario: "PASS", expectedExit: 0, expectedStatus: "pass", expectedCall: 1 },
    { scenario: "FAIL_THEN_PASS", expectedExit: 0, expectedStatus: "pass", expectedCall: 2 },
    { scenario: "HARD_STOP", expectedExit: 0, expectedStatus: "hard_stop", expectedCall: 1 },
    { scenario: "RATE_LIMIT", expectedExit: 75, expectedStatus: "rate_limited", expectedCall: 1 },
  ];
  for (const entry of cases) {
    await t.test(entry.scenario, async () => {
      const runtime = await makeRuntime(2);
      try {
        runtime.control.authorization_status = "inactive";
        runtime.control.active_claude_session = null;
        await writeJson(runtime.paths.controlPath, runtime.control);
        const planPath = path.join(runtime.paths.queueRoot, entry.scenario.toLowerCase() + "-plan.json");
        const plan = await createWorkPackagePlan({
          paths: runtime.paths,
          control: runtime.control,
          task: "Update README.md only.",
          owner: "Human Owner",
          workPackage: "fake-" + entry.scenario.toLowerCase().replaceAll("_", "-"),
          breakpoint: "return after review",
          changeTypes: "docs",
          allowedPaths: "README.md",
          maxCalls: 2,
          maxMinutes: 1,
          outPath: planPath,
        });
        const authorization = await authorizeWorkPackage({
          paths: runtime.paths,
          planPath,
          approval: plan.plan_sha256,
          executionMode: "fake_cli",
        });
        const exitCode = await runBoundedResume({
          paths: runtime.paths,
          control: authorization.control,
          adapter: createFakeAdapter(bridgeRoot, entry.scenario),
          promptPath: authorization.promptPath,
          maxCalls: 2,
          maxMinutes: 1,
          startNewSession: true,
        });
        assert.equal(exitCode, entry.expectedExit);
        const status = await workPackageStatus(runtime.paths);
        assert.equal(status.execution_mode, "fake_cli");
        assert.equal(status.latest_state.status, entry.expectedStatus);
        assert.equal(status.latest_state.call, entry.expectedCall);
        assert.equal(status.authorization_status, "consumed");
      } finally {
        await runtime.cleanup();
      }
    });
  }
});
