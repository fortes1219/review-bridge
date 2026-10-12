import fsp from "node:fs/promises";
import path from "node:path";
import {
  acquireLock,
  assertUnder,
  fileExists,
  listJson,
  parseJson,
  readJson,
  timestampId,
  writeJson,
  writeJsonAtomic,
  writeText,
} from "./io.mjs";
import { enqueueReview, hasPendingMessageHash } from "./queue.mjs";
import { runReviewWorker } from "./review.mjs";
import { parseReviewGate } from "./gate.mjs";
import { runProcess } from "./process.mjs";
import { validateWriterPolicy } from "./policy.mjs";
import { classificationProfileFromSnapshot } from "./policy-v4.mjs";
import {
  budgetStop,
  classifyProviderFailure,
  controllerError,
  failureSummary,
  readEvidenceTail,
  writeFailureRecord,
} from "./provider-failure.mjs";

const REVIEW_RESUME_LIMITATION = "Review-only resume is not implemented; the writer output is preserved "
  + "and is not re-run. Continuing requires a new human-owner authorization.";

// The exact job this bounded run enqueued; a hook may have queued the same message first.
async function enqueuedJobId(paths, enqueued) {
  if (!enqueued.duplicate) {
    const jobId = enqueued.job?.job_id;
    if (!jobId) throw new Error("Enqueued review job has no job ID.");
    return jobId;
  }
  const suffix = "-" + enqueued.message_hash + ".json";
  const matches = (await listJson(paths.pendingDir)).filter((file) => path.basename(file).endsWith(suffix));
  if (matches.length !== 1) throw new Error("Pending review job for this run is missing or ambiguous.");
  return path.basename(matches[0], ".json");
}

function writerPrefix(control) {
  const scope = control.authorized_scope || {};
  return [
    "[REVIEW_BRIDGE_MODE: WRITER_ONLY]",
    "",
    "This mode is injected by the local bounded review controller.",
    "Claude is the writer only. Codex is the only independent semantic reviewer.",
    "Human-authorized work package: " + String(control.work_package || ""),
    "Allowed change types: " + (scope.change_types || []).join(", "),
    "Allowed workspace paths: " + (scope.allowed_paths || []).join(", "),
    "Human breakpoint: " + String(control.breakpoint || ""),
    "Do not edit outside the allowed paths or perform an unapproved change type.",
    "Do not invoke Agent, subagents, fresh reviewers, ultrareview, or any equivalent reviewer.",
    "Do not perform full reconstruction, broad negative-space review, or repeat a completed review task.",
    "Read only the task, specified canonical sections, direct dependencies, and unavoidable minimal propagation.",
    "After writing, perform one bounded local consistency pass over changed sections and the actual workspace delta.",
    "Stop if full reconstruction, a new human-owner decision, scope expansion, or another work package is required.",
    "Return a concise delta report of at most 80 lines, ending exactly with CODEX_REVIEW_REQUIRED: true.",
    "",
  ].join("\n");
}

function sameAuthorization(current, expected) {
  return current.authorization_status === "active"
    && current.active_claude_session === expected.active_claude_session
    && String(current.authorization_plan_sha256 || "")
      === String(expected.authorization_plan_sha256 || "");
}

async function consumeAuthorization(paths, expected, reason, gate = null) {
  if (expected.v4_runtime_state) {
    await expected.v4_runtime_state.consume(reason, gate);
    return;
  }
  const control = await readJson(paths.controlPath);
  if (!sameAuthorization(control, expected)) return;
  control.authorization_status = "consumed";
  control.closed_at = new Date().toISOString();
  control.closed_by_breakpoint = String(control.breakpoint || "");
  control.closed_reason = reason;
  if (gate) {
    control.closed_review_gate = gate.review_gate;
    control.closed_hard_stop_required = gate.hard_stop_required;
  }
  await writeJsonAtomic(paths.controlPath, control);
}

async function loadLiveControl(paths, runtimeState) {
  return runtimeState ? await runtimeState.loadControl() : await readJson(paths.controlPath);
}

export const DEFAULT_WRITER_MODEL = "opus";

// The policy snapshot pins the model for v4 runs; legacy controls use the package default.
export function writerModelFor(control) {
  return control?.v4?.policy_snapshot?.effective_policy?.writer?.model || DEFAULT_WRITER_MODEL;
}

async function writeBoundedState(paths, runtimeState, state) {
  if (runtimeState) return await runtimeState.recordState(state);
  return await writeJson(paths.boundedStatePath, state);
}

export async function validateBoundedResume({
  paths,
  control,
  adapter,
  promptPath,
  maxCalls,
  maxMinutes,
}) {
  validateWriterPolicy(control, maxCalls, maxMinutes);
  const resolvedPrompt = assertUnder(path.resolve(promptPath), paths.privateRoot, "Bounded prompt");
  if (!(await fileExists(resolvedPrompt))) throw new Error("Prompt file is missing.");
  const pending = await listJson(paths.pendingDir);
  const running = await listJson(paths.runningDir);
  if (pending.length || running.length) throw new Error("Review queue must be idle before bounded resume.");
  await adapter.resolveExecutable("claude");
  return {
    valid: true,
    session_id: String(control.active_claude_session),
    transport: control.dispatch_transport,
    disallowed_tools: ["Agent"],
    mode: "writer_only",
    model: writerModelFor(control),
    effort: "low",
    max_claude_calls: maxCalls,
    max_claude_minutes_per_call: maxMinutes,
    prompt_path: resolvedPrompt,
  };
}

export async function runBoundedResume({
  paths,
  control,
  adapter,
  promptPath,
  maxCalls,
  maxMinutes,
  startNewSession = false,
  runtimeState = null,
}) {
  if (runtimeState) control.v4_runtime_state = runtimeState;
  const invocationStartedAt = Date.now();
  const validation = await validateBoundedResume({
    paths, control, adapter, promptPath, maxCalls, maxMinutes,
  });
  const release = await acquireLock(paths.boundedLockPath);
  try {
    const claude = await adapter.resolveExecutable("claude");
    const sessionId = validation.session_id;
    const writerModel = validation.model;
    let currentPromptPath = validation.prompt_path;
    let currentControl = control;

    for (let call = 1; call <= maxCalls; call += 1) {
      currentControl = await loadLiveControl(paths, runtimeState);
      if (runtimeState) currentControl.v4_runtime_state = runtimeState;
      if (!sameAuthorization(currentControl, control)) {
        throw new Error("Work package authorization is no longer active.");
      }
      const stamp = timestampId();
      const stdoutPath = path.join(paths.queueRoot, stamp + "-claude.stdout.json");
      const stderrPath = path.join(paths.queueRoot, stamp + "-claude.stderr.log");
      const payloadPath = path.join(paths.queueRoot, stamp + "-stop-payload.json");
      const effectivePromptPath = path.join(paths.queueRoot, stamp + "-writer-only-prompt.txt");
      const requested = await fsp.readFile(currentPromptPath, "utf8");
      const effectivePrompt = writerPrefix(currentControl) + requested;
      await writeText(effectivePromptPath, effectivePrompt);

      const claudeArgs = [
        "-p",
        startNewSession && call === 1 ? "--session-id" : "--resume", sessionId,
        "--permission-mode", "auto",
        "--disallowedTools", "Agent",
        "--model", writerModel,
        "--effort", "low",
        "--output-format", "json",
      ];
      const invocation = adapter.buildInvocation("claude", claude, claudeArgs);
      const processResult = await runProcess({
        invocation,
        cwd: paths.repoRoot,
        input: effectivePrompt,
        stdoutPath,
        stderrPath,
        timeoutMs: maxMinutes * 60_000,
      });
      if (processResult.timedOut) {
        const timeout = await writeFailureRecord(paths, paths.queueRoot, stamp + "-claude", classifyProviderFailure({
          role: "writer", provider: "claude", phase: "write", exitCode: processResult.exitCode, timedOut: true,
        }), { stdout_path: stdoutPath, stderr_path: stderrPath });
        await writeBoundedState(paths, runtimeState, {
          writer_model: writerModel,
          status: "claude_timeout",
          failure: failureSummary(timeout.record, timeout.record_path),
          session_id: sessionId,
          call,
          updated_at: new Date().toISOString(),
          max_minutes: maxMinutes,
          stdout_path: stdoutPath,
          stderr_path: stderrPath,
        });
        await consumeAuthorization(paths, control, "claude_timeout");
        return 77;
      }
      let claudeResult = null;
      if (await fileExists(stdoutPath) && (await fsp.stat(stdoutPath)).size > 0) {
        try {
          claudeResult = parseJson(await fsp.readFile(stdoutPath, "utf8"));
        } catch {
          claudeResult = null;
        }
      }
      if (claudeResult && String(claudeResult.session_id) !== sessionId) {
        throw new Error("Claude session drift detected.");
      }
      const resultText = String(claudeResult?.result || "");
      if (!claudeResult || claudeResult.is_error === true || processResult.exitCode !== 0) {
        const classified = classifyProviderFailure({
          role: "writer",
          provider: "claude",
          phase: "write",
          exitCode: processResult.exitCode,
          texts: [
            resultText,
            await readEvidenceTail(stderrPath),
            claudeResult ? "" : await readEvidenceTail(stdoutPath),
          ],
        });
        const written = await writeFailureRecord(paths, paths.queueRoot, stamp + "-claude", classified, {
          stdout_path: stdoutPath,
          stderr_path: stderrPath,
        });
        const limited = classified.reason === "provider_usage_limit";
        await writeBoundedState(paths, runtimeState, {
          writer_model: writerModel,
          status: limited ? "rate_limited" : "claude_failed",
          session_id: sessionId,
          call,
          updated_at: new Date().toISOString(),
          claude_exit_code: processResult.exitCode,
          claude_json_valid: Boolean(claudeResult),
          failure: failureSummary(classified, written.record_path),
          stdout_path: stdoutPath,
          stderr_path: stderrPath,
        });
        await consumeAuthorization(paths, control, limited ? "rate_limited" : "claude_failed");
        return limited ? 75 : 1;
      }
      if (!/^\s*CODEX_REVIEW_REQUIRED\s*:\s*true\s*$/im.test(resultText)) {
        throw new Error("Claude result is missing CODEX_REVIEW_REQUIRED: true.");
      }
      currentControl = await loadLiveControl(paths, runtimeState);
      if (runtimeState) currentControl.v4_runtime_state = runtimeState;
      if (!sameAuthorization(currentControl, control)) {
        throw new Error("Work package authorization was cancelled before review enqueue.");
      }

      const payload = {
        session_id: sessionId,
        cwd: paths.repoRoot,
        stop_hook_active: false,
        last_assistant_message: resultText,
      };
      await writeJson(payloadPath, payload);
      const enqueued = await enqueueReview({
        payload,
        paths,
        control: currentControl,
        classificationProfile: currentControl.v4
          ? classificationProfileFromSnapshot(currentControl.v4.policy_snapshot)
          : null,
      });
      const hookQueuedDuplicate = enqueued.accepted
        && enqueued.duplicate
        && await hasPendingMessageHash(paths, enqueued.message_hash);
      if (!enqueued.accepted || (enqueued.duplicate && !hookQueuedDuplicate)) {
        throw new Error("Bounded correction did not create a new review job.");
      }
      const ownJobId = await enqueuedJobId(paths, enqueued);
      const reviewOutcomes = await runReviewWorker({
        paths, control: currentControl, adapter, noNotification: true,
      });
      // Other pending jobs may run in the same worker pass; only this run's job is attributed here.
      const ownOutcomes = (reviewOutcomes || []).filter((outcome) => outcome.job_id === ownJobId);
      if (ownOutcomes.length !== 1) {
        throw new Error("Review worker returned no unambiguous outcome for job " + ownJobId + ".");
      }
      const [ownOutcome] = ownOutcomes;
      if (ownOutcome.status === "failed") {
        const failedReview = ownOutcome;
        const failure = failedReview.provider_failure || controllerError({ phase: "review" });
        const status = failure.reason === "provider_usage_limit" ? "rate_limited"
          : failure.reason === "controller_error" ? "controller_failure" : "reviewer_failed";
        await writeBoundedState(paths, runtimeState, {
          status,
          session_id: sessionId,
          call,
          updated_at: new Date().toISOString(),
          failure: failureSummary(failure, failedReview.provider_failure?.record_path || null),
          failed_review_job_id: failedReview.job_id,
          failed_review_job_path: failedReview.job_path,
          review_error_path: failedReview.error_path,
          claude_stdout_path: stdoutPath,
          claude_stderr_path: stderrPath,
          resume_limitation: REVIEW_RESUME_LIMITATION,
        });
        await consumeAuthorization(paths, control, status);
        return status === "rate_limited" ? 75 : 1;
      }
      if (ownOutcome.status !== "done" || !ownOutcome.result_path) {
        throw new Error("Review job " + ownJobId + " did not complete.");
      }
      const latestReviewPath = ownOutcome.result_path;
      assertUnder(latestReviewPath, paths.reviewsRoot, "Latest review");
      if (!(await fileExists(latestReviewPath))) throw new Error("Codex review result is missing.");
      const review = await fsp.readFile(latestReviewPath, "utf8");
      let gate;
      try {
        gate = parseReviewGate(review);
      } catch (error) {
        await writeBoundedState(paths, runtimeState, {
          writer_model: writerModel,
          status: "malformed_review_gate",
          session_id: sessionId,
          call,
          updated_at: new Date().toISOString(),
          review_path: latestReviewPath,
          claude_stdout_path: stdoutPath,
          error: error.message,
        });
        await consumeAuthorization(paths, control, "malformed_review_gate");
        throw error;
      }
      await writeBoundedState(paths, runtimeState, {
        writer_model: writerModel,
        status: gate.review_gate === "PASS"
          ? "pass"
          : gate.hard_stop_required ? "hard_stop" : "correction_required",
        session_id: sessionId,
        call,
        updated_at: new Date().toISOString(),
        ...gate,
        review_path: latestReviewPath,
        claude_stdout_path: stdoutPath,
      });
      if (gate.review_gate === "PASS" || gate.hard_stop_required) {
        await consumeAuthorization(
          paths,
          control,
          gate.review_gate === "PASS" ? "review_pass" : "review_hard_stop",
          gate,
        );
        return 0;
      }
      if (call >= maxCalls) {
        await writeBoundedState(paths, runtimeState, {
          writer_model: writerModel,
          status: "call_budget_exhausted",
          session_id: sessionId,
          call,
          updated_at: new Date().toISOString(),
          ...gate,
          review_path: latestReviewPath,
          claude_stdout_path: stdoutPath,
          failure: failureSummary(budgetStop({ phase: "correction", maxCalls })),
        });
        await consumeAuthorization(paths, control, "call_budget_exhausted", gate);
        return 76;
      }

      const nextPromptPath = path.join(paths.queueRoot, stamp + "-bounded-correction.txt");
      await writeText(nextPromptPath, [
        "[AUTO-BOUNDED-CORRECTION]",
        "",
        "Continue in the same Claude session. Codex review failed without a human-owner hard stop.",
        "Read the authoritative review at: " + latestReviewPath,
        "",
        "Fix only the named findings and unavoidable propagation within the current work package.",
        "The controller will inject REVIEW_BRIDGE_MODE: WRITER_ONLY again on the next call.",
        "Keep all CONTROL hard stops and repository boundaries.",
        "Return one concise delta report ending exactly with:",
        "CODEX_REVIEW_REQUIRED: true",
      ].join("\n") + "\n");
      currentPromptPath = nextPromptPath;
      currentControl = await loadLiveControl(paths, runtimeState);
      if (runtimeState) currentControl.v4_runtime_state = runtimeState;
      if (!sameAuthorization(currentControl, control)) {
        throw new Error("Work package authorization was cancelled before correction.");
      }
      if (runtimeState) await runtimeState.incrementIteration();
      else {
        currentControl.iteration = Number(currentControl.iteration || 0) + 1;
        await writeJsonAtomic(paths.controlPath, currentControl);
      }
    }
    await consumeAuthorization(paths, control, "call_budget_exhausted");
    return 76;
  } catch (error) {
    let currentState = runtimeState ? await runtimeState.getState().catch(() => null) : null;
    if (!runtimeState && await fileExists(paths.boundedStatePath)) {
      currentState = await readJson(paths.boundedStatePath).catch(() => null);
    }
    const stateBelongsToThisInvocation = currentState?.session_id === validation.session_id
      && Number.isFinite(Date.parse(currentState?.updated_at))
      && Date.parse(currentState.updated_at) >= invocationStartedAt;
    const liveControl = await loadLiveControl(paths, runtimeState).catch(() => null);
    const authorizationStillActive = liveControl && sameAuthorization(liveControl, control);
    if (!stateBelongsToThisInvocation && authorizationStillActive) {
      await writeBoundedState(paths, runtimeState, {
        status: "controller_failure",
        writer_model: validation.model,
        session_id: validation.session_id,
        updated_at: new Date().toISOString(),
        error: error.message,
        failure: failureSummary(controllerError({ phase: "controller" })),
      });
    }
    await consumeAuthorization(paths, control, "controller_failure");
    throw error;
  } finally {
    await release();
  }
}
