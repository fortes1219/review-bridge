import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  acquireLock,
  appendIoEvent,
  classifyProviderFailure,
  consumeRun,
  ensureDir,
  fileExists,
  killProcessTree,
  listJson,
  parseJson,
  readEvidenceTail,
  readIoEvents,
  readJson,
  readRun,
  runProcess,
  tokenTotal,
  usageTotalForRun,
  writeFailureRecord,
  writeJson,
  writeJsonAtomic,
  writeText,
} from "../../service/index.mjs";
import { assertUnder } from "../../utils/pathGuard.mjs";
import { timestampId } from "../../utils/dates.mjs";
import { enqueueReview, hasPendingMessageHash } from "./reviewQueue.mjs";
import { runReviewWorker } from "./review.mjs";
import {
  buildHandoff,
  buildReadList,
  buildTaskInput,
  composeWriterPrompt,
  isInReadList,
  parseClaudeStream,
  ReferenceChangedError,
  partialUsageFromStream,
  usageFromResult,
  verifyAndLoadReferences,
} from "./writerPrompt.mjs";
import {
  loadSchema,
  MALFORMED_EXIT_CODE,
  recheckFindings,
  unknownAddressedFindings,
  validateReviewResult,
  validateWriterResult,
  WRITER_RESULT_SCHEMA,
  writerResultFromClaudeResult,
} from "./typedResults.mjs";
import { runGateA, sameDelta } from "./gateA.mjs";
import { createWorkspaceDelta } from "./workspaceEvidence.mjs";
import { validateWriterPolicy } from "../../policy/policyChecks.mjs";
import { classificationProfileFromSnapshot } from "../../policy/policyRules.mjs";
import { budgetStop, controllerError, failureSummary } from "./budget.mjs";

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

function sameAuthorization(current, expected) {
  return current.authorization_status === "active"
    && current.active_claude_session === expected.active_claude_session
    && String(current.authorization_plan_sha256 || "")
      === String(expected.authorization_plan_sha256 || "");
}

async function consumeAuthorization(paths, expected, reason, gate = null) {
  await expected.v4_runtime_state.consume(reason, gate);
}

async function loadLiveControl(paths, runtimeState) {
  return await runtimeState.loadControl();
}

export const DEFAULT_WRITER_MODEL = "opus";

// The policy snapshot pins the model; a snapshot without one uses the package default.
export function writerModelFor(control) {
  return control?.v4?.policy_snapshot?.effective_policy?.writer?.model || DEFAULT_WRITER_MODEL;
}

async function writeBoundedState(paths, runtimeState, state) {
  return await runtimeState.recordState(state);
}

// T0-04 D4.1: ceilings come from the policy snapshot; missing ones use the package defaults.
export const DEFAULT_LIMITS = Object.freeze({ max_turns: 20, max_tokens_per_call: 1_500_000, max_tokens_per_run: 4_000_000, max_output_chars: 4_000 });
function effectiveLimits(control) {
  const limits = control?.v4?.policy_snapshot?.effective_policy?.limits || {};
  return {
    max_turns: limits.max_turns ?? DEFAULT_LIMITS.max_turns,
    max_tokens_per_call: limits.max_tokens_per_call ?? DEFAULT_LIMITS.max_tokens_per_call,
    max_tokens_per_run: limits.max_tokens_per_run ?? DEFAULT_LIMITS.max_tokens_per_run,
    max_output_chars: DEFAULT_LIMITS.max_output_chars,
  };
}

async function recordIo(paths, runId, event) {
  if (!runId) return null;
  return await appendIoEvent(paths, runId, event);
}

function processFile(paths, runId) {
  return path.join(paths.runLocksDir, runId + ".process.json");
}

async function recordProcess(paths, runId, record) {
  if (!runId) return;
  await ensureDir(paths.runLocksDir);
  await writeJsonAtomic(processFile(paths, runId), { ...record, started_at: new Date().toISOString() });
}

async function clearProcess(paths, runId) {
  if (!runId) return;
  await fsp.rm(processFile(paths, runId), { force: true });
}

async function readRunStatus(paths, runId) {
  if (!runId) return null;
  return (await readRun(paths, runId).catch(() => null))?.status || null;
}

async function changedFilesForJob(paths, jobId) {
  const job = await readJson(path.join(paths.doneDir, jobId + ".json")).catch(() => null);
  const deltaPath = job?.workspace_evidence?.delta_path;
  if (!deltaPath) return [];
  const delta = await readJson(deltaPath).catch(() => null);
  return (delta?.changed_files || []).map((entry) => ({ path: entry.path, change: entry.change }));
}

const ACTIVE_RUN_STATUSES = new Set(["running", "review_pending", "correction_pending", "interrupted"]);

// T0-04 D5.2: mark the run stopped first so the writer loop sees it, then kill the process tree.
export async function stopRun(paths, runId) {
  const run = await readRun(paths, runId).catch(() => null);
  if (!run) return { exitCode: 1, line: "沒有這條", reason: "unknown" };
  if (!ACTIVE_RUN_STATUSES.has(run.status)) return { exitCode: 1, line: "已經結束：" + run.status, reason: "terminal" };
  const record = await readJson(processFile(paths, runId)).catch(() => null);
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { await consumeRun(paths, runId, "stopped", null); lastError = null; break; } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 300)); }
  }
  if (lastError) throw lastError;
  const killed = record?.pid ? await killProcessTree(record.pid) : { killed: false, reason: "no_process" };
  await appendIoEvent(paths, runId, {
    event: "stop", status: "stopped", role: record?.role || null, provider: record?.provider || null,
    detail_ref: record ? "pid:" + record.pid + ":" + killed.reason : "no_process",
  });
  await fsp.rm(processFile(paths, runId), { force: true });
  return { exitCode: 0, line: "已停止 " + runId, reason: killed.reason };
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
    disallowed_tools: [...(control.token_policy?.claude_disallowed_tools || [])],
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
  runtimeState,
}) {
  control.v4_runtime_state = runtimeState;
  const invocationStartedAt = Date.now();
  const validation = await validateBoundedResume({
    paths, control, adapter, promptPath, maxCalls, maxMinutes,
  });
  const release = await acquireLock(paths.boundedLockPath);
  try {
    const claude = await adapter.resolveExecutable("claude");
    let sessionId = validation.session_id;
    const writerModel = validation.model;
    let currentControl = control;
    let lastFindings = [];
    let lastGate = null;
    let lastChangedFiles = [];
    let lastGateAResult = null;
    let lastGateADelta = null;
    let handoffReason = "correction";
    const writerSchemaArg = JSON.stringify(await loadSchema(WRITER_RESULT_SCHEMA));

    for (let call = 1; call <= maxCalls; call += 1) {
      currentControl = await loadLiveControl(paths, runtimeState);
      currentControl.v4_runtime_state = runtimeState;
      if (!sameAuthorization(currentControl, control)) {
        throw new Error("Work package authorization is no longer active.");
      }
      const stamp = timestampId();
      const stdoutPath = path.join(paths.queueRoot, stamp + "-claude.stdout.json");
      const streamPath = path.join(paths.queueRoot, stamp + "-claude.stream.jsonl");
      const stderrPath = path.join(paths.queueRoot, stamp + "-claude.stderr.log");
      const payloadPath = path.join(paths.queueRoot, stamp + "-stop-payload.json");
      const effectivePromptPath = path.join(paths.queueRoot, stamp + "-writer-only-prompt.txt");
      const workPackage = currentControl.v4.work_package;
      const runId = runtimeState.runId;
      const limits = effectiveLimits(currentControl);
      // D2.1: every call is a fresh session; the run records the rotation.
      if (call > 1) {
        sessionId = randomUUID();
        await runtimeState.rotateSession(sessionId);
        control.active_claude_session = sessionId;
        currentControl = await loadLiveControl(paths, runtimeState);
        currentControl.v4_runtime_state = runtimeState;
      }
      let references;
      try {
        references = await verifyAndLoadReferences(paths, workPackage);
      } catch (error) {
        if (!(error instanceof ReferenceChangedError)) throw error;
        await writeBoundedState(paths, runtimeState, {
          writer_model: writerModel, status: "reference_changed", session_id: sessionId, call,
          updated_at: new Date().toISOString(), changed_path: error.path, error: error.message,
        });
        await recordIo(paths, runId, { event: "stop", status: "reference_changed", role: "controller", provider: null, detail_ref: error.path });
        await consumeAuthorization(paths, control, "reference_changed");
        return 78;
      }
      const readList = buildReadList({ references, findings: lastFindings });
      const taskInput = buildTaskInput({ workPackage, call, readList, limits });
      const handoff = call > 1 ? buildHandoff({
        workPackage, call, reason: handoffReason, ioEvents: await readIoEvents(paths, runId),
        openFindings: lastFindings, lastGate, changedFiles: lastChangedFiles, readList,
        gateAResult: handoffReason === "gate_a_failed" ? lastGateAResult : null,
      }) : null;
      if (handoff) await recordIo(paths, runId, handoff);
      const effectivePrompt = composeWriterPrompt({
        workPackage, control: currentControl, runId, call, taskInput, references, handoff,
        rulesText: workPackage.rules?.text || "",
      });
      await recordIo(paths, runId, {
        ...taskInput,
        injected: references.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes, inlined: file.text !== null })),
      });
      await writeText(effectivePromptPath, effectivePrompt);

      const claudeArgs = [
        "-p",
        "--session-id", sessionId,
        "--permission-mode", "auto",
        // Sub-agents are allowed for implementation; a project override can still disallow tools.
        ...(validation.disallowed_tools.length ? ["--disallowedTools", validation.disallowed_tools.join(",")] : []),
        "--model", writerModel,
        "--effort", "low",
        "--max-turns", String(limits.max_turns),
        "--output-format", "stream-json",
        "--verbose",
        // T0-05 D1.1: the CLI is asked for a writer.result-shaped answer.
        "--json-schema", writerSchemaArg,
      ];
      const invocation = adapter.buildInvocation("claude", claude, claudeArgs);
      const callStartedAt = Date.now();
      const processResult = await runProcess({
        invocation,
        cwd: paths.repoRoot,
        input: effectivePrompt,
        stdoutPath: streamPath,
        stderrPath,
        timeoutMs: maxMinutes * 60_000,
        onSpawn: (pid) => recordProcess(paths, runId, { pid, role: "writer", provider: "claude", call }),
      });
      await clearProcess(paths, runId);
      // D3.3: the final result object keeps the legacy single-JSON file for everything downstream.
      const stream = parseClaudeStream(await fsp.readFile(streamPath, "utf8").catch(() => ""));
      // Tokens spent by a call with no final result still count; the record says it is partial.
      if (!stream.result || processResult.timedOut) {
        await recordIo(paths, runId, partialUsageFromStream(stream.streamUsage, { call, durationMs: Date.now() - callStartedAt }));
      }
      // D5.3: stopped from outside; nothing more is classified (the spent tokens above are accounting).
      if ((await readRunStatus(paths, runId)) === "stopped") return 130;
      if (stream.result) await writeJson(stdoutPath, stream.result);
      for (const read of stream.reads) {
        await recordIo(paths, runId, {
          event: "read", call, ...read,
          ...(read.path ? { outside_list: readList.length ? !isInReadList(read.path, readList) : null } : {}),
        });
      }
      if (stream.result && !processResult.timedOut) {
        const usage = usageFromResult(stream.result, { call, durationMs: Date.now() - callStartedAt });
        await recordIo(paths, runId, usage);
        const callTotal = tokenTotal(usage.tokens);
        const runTotal = await usageTotalForRun(paths, runId);
        if (callTotal > limits.max_tokens_per_call || runTotal > limits.max_tokens_per_run) {
          const which = callTotal > limits.max_tokens_per_call ? "per_call" : "per_run";
          await writeBoundedState(paths, runtimeState, {
            writer_model: writerModel, status: "token_limit", session_id: sessionId, call, updated_at: new Date().toISOString(),
            token_limit: which, tokens_this_call: callTotal, tokens_this_run: runTotal, claude_stdout_path: stdoutPath,
          });
          await recordIo(paths, runId, {
            event: "stop", status: "token_limit", role: "writer", provider: "claude",
            detail_ref: which + ":" + (which === "per_call" ? callTotal : runTotal),
          });
          await consumeAuthorization(paths, control, "token_limit");
          return 76;
        }
        if (stream.result.subtype === "error_max_turns") {
          await recordIo(paths, runId, { event: "stop", status: "max_turns", role: "writer", provider: "claude", detail_ref: String(limits.max_turns) });
        }
      }
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
      // T0-05 D1: the typed answer is checked by the harness; prose is never read.
      const writerResult = writerResultFromClaudeResult(claudeResult);
      const writerCheck = await validateWriterResult(writerResult, { workOrder: workPackage.work_package_id, call });
      if (!writerCheck.ok) {
        await writeBoundedState(paths, runtimeState, {
          writer_model: writerModel, status: "malformed_writer_result", session_id: sessionId, call,
          updated_at: new Date().toISOString(), errors: writerCheck.errors.slice(0, 20), claude_stdout_path: stdoutPath,
        });
        await recordIo(paths, runId, { event: "stop", status: "malformed_event", role: "writer", provider: "claude", detail_ref: writerCheck.errors[0] || "writer.result" });
        await consumeAuthorization(paths, control, "malformed_writer_result");
        return MALFORMED_EXIT_CODE;
      }
      await recordIo(paths, runId, { ...writerResult, unknown_addressed_findings: unknownAddressedFindings(writerResult, lastFindings) });
      if (writerResult.needs_human.length || writerResult.status !== "done") {
        // D1.4: the writer asked for a decision or declared itself blocked; no review, back to the owner.
        await writeBoundedState(paths, runtimeState, {
          writer_model: writerModel, status: "needs_human", session_id: sessionId, call, updated_at: new Date().toISOString(),
          writer_status: writerResult.status, needs_human: writerResult.needs_human, claude_stdout_path: stdoutPath,
        });
        await recordIo(paths, runId, { event: "stop", status: "needs_human", role: "writer", provider: "claude", detail_ref: writerResult.status });
        await consumeAuthorization(paths, control, "needs_human");
        return 0;
      }
      // T0-06 G3: the sealed verification runs after the writer and before any review.
      let gateAResult = null;
      if (workPackage.gate_a) {
        gateAResult = await runGateA({
          paths, gateA: workPackage.gate_a,
          stdoutPath: path.join(paths.queueRoot, stamp + "-gate-a.stdout.log"),
          stderrPath: path.join(paths.queueRoot, stamp + "-gate-a.stderr.log"),
          timeoutMs: limits.gate_a_minutes * 60_000,
          onSpawn: (pid) => recordProcess(paths, runId, { pid, role: "controller", provider: "gate_a", call }),
        });
        await clearProcess(paths, runId);
        if ((await readRunStatus(paths, runId)) === "stopped") return 130;
        await recordIo(paths, runId, { ...gateAResult, call });
        if (gateAResult.kind === "command" && !gateAResult.passed) {
          // G3.5: the controller's result goes back to the writer as fix.input; no reviewer call.
          const delta = currentControl.workspace_evidence?.baseline_path
            ? await createWorkspaceDelta({ paths, baselinePath: currentControl.workspace_evidence.baseline_path, deltaId: "gate-a-" + stamp })
            : null;
          const changed = delta ? (await readJson(delta.delta_path)).changed_files : [];
          lastChangedFiles = changed.map((entry) => ({ path: entry.path, change: entry.change, after_sha256: entry.after_sha256 }));
          const gateState = {
            writer_model: writerModel, status: "gate_a_failed", session_id: sessionId, call, updated_at: new Date().toISOString(),
            gate_a_passed: false, gate_a_command: gateAResult.command, gate_a_exit_code: gateAResult.exit_code, gate_a_timed_out: gateAResult.timed_out,
            claude_stdout_path: stdoutPath,
          };
          // G3.6: the same command failing twice on an unchanged delta means nothing was fixed.
          if (lastGateAResult && lastGateADelta && sameDelta(lastGateADelta, lastChangedFiles)) {
            const stopGate = { review_gate: "FAIL", hard_stop_required: true, hard_stop_reason: "needs_human_decision" };
            await writeBoundedState(paths, runtimeState, { ...gateState, status: "hard_stop", ...stopGate });
            await recordIo(paths, runId, { event: "stop", status: "hard_stop", role: "controller", provider: null, detail_ref: "gate_a_loop" });
            await consumeAuthorization(paths, control, "review_hard_stop", stopGate);
            return 0;
          }
          lastGateAResult = gateAResult;
          lastGateADelta = lastChangedFiles;
          handoffReason = "gate_a_failed";
          lastFindings = [];
          await writeBoundedState(paths, runtimeState, gateState);
          if (call >= maxCalls) {
            await writeBoundedState(paths, runtimeState, {
              ...gateState, status: "call_budget_exhausted", failure: failureSummary(budgetStop({ phase: "correction", maxCalls })),
            });
            await consumeAuthorization(paths, control, "call_budget_exhausted");
            return 76;
          }
          await recordIo(paths, runId, {
            event: "fix.input", work_order: workPackage.work_package_id, call: call + 1, reason: "gate_a_failed",
            gate_a_result: { command: gateAResult.command, exit_code: gateAResult.exit_code, timed_out: gateAResult.timed_out, stdout_tail: gateAResult.stdout_tail, stderr_tail: gateAResult.stderr_tail },
            read_list: buildReadList({ deltaPaths: lastChangedFiles.map((entry) => entry.path) }),
            limits: { max_turns: limits.max_turns, max_output_chars: limits.max_output_chars },
          });
          await runtimeState.incrementIteration();
          continue;
        }
        handoffReason = "correction";
      }
      currentControl = await loadLiveControl(paths, runtimeState);
      currentControl.v4_runtime_state = runtimeState;
      if (!sameAuthorization(currentControl, control)) {
        throw new Error("Work package authorization was cancelled before review enqueue.");
      }

      const payload = {
        session_id: sessionId,
        cwd: paths.repoRoot,
        stop_hook_active: false,
        last_assistant_message: JSON.stringify(writerResult),
      };
      await writeJson(payloadPath, payload);
      const enqueued = await enqueueReview({
        payload,
        paths,
        control: currentControl,
        classificationProfile: classificationProfileFromSnapshot(currentControl.v4.policy_snapshot),
        writerResult,
        call,
        openFindings: lastFindings,
        gateAResult,
      });
      const hookQueuedDuplicate = enqueued.accepted
        && enqueued.duplicate
        && await hasPendingMessageHash(paths, enqueued.message_hash);
      if (!enqueued.accepted || (enqueued.duplicate && !hookQueuedDuplicate)) {
        throw new Error("Bounded correction did not create a new review job.");
      }
      const ownJobId = await enqueuedJobId(paths, enqueued);
      const reviewOutcomes = await runReviewWorker({
        paths, control: currentControl, adapter, noNotification: true, only: ownJobId,
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
      lastChangedFiles = await changedFilesForJob(paths, ownJobId);
      // T0-05 D3: the typed verdict is checked against the fixed rules; prose is not read.
      let reviewResult = null;
      try { reviewResult = parseJson(review); } catch { reviewResult = null; }
      // A controller-decided verdict (D2.5) is the harness's own; only a reviewer's answer is checked.
      const check = ownOutcome.controller_decided ? { ok: true, errors: [] } : await validateReviewResult(reviewResult, {
        workOrder: workPackage.work_package_id, call, repoRoot: paths.repoRoot,
        previousFindings: lastFindings, deltaPaths: call > 1 ? lastChangedFiles.map((entry) => entry.path) : null,
      });
      if (!check.ok) {
        await writeBoundedState(paths, runtimeState, {
          writer_model: writerModel, status: "malformed_review_result", session_id: sessionId, call,
          updated_at: new Date().toISOString(), errors: check.errors.slice(0, 20), review_path: latestReviewPath, claude_stdout_path: stdoutPath,
        });
        await recordIo(paths, runId, { event: "stop", status: "malformed_event", role: "reviewer", provider: "codex", detail_ref: check.errors[0] || "review.result" });
        await consumeAuthorization(paths, control, "malformed_review_result");
        return MALFORMED_EXIT_CODE;
      }
      await recordIo(paths, runId, { ...reviewResult });
      // D5.3: the reviewer's call is measured against the same ceilings as the writer's.
      if (ownOutcome.usage && !ownOutcome.controller_decided) {
        const callTotal = tokenTotal(ownOutcome.usage.tokens);
        const runTotal = await usageTotalForRun(paths, runId);
        if (callTotal > limits.max_tokens_per_call || runTotal > limits.max_tokens_per_run) {
          const which = callTotal > limits.max_tokens_per_call ? "per_call" : "per_run";
          await writeBoundedState(paths, runtimeState, {
            writer_model: writerModel, status: "token_limit", session_id: sessionId, call, updated_at: new Date().toISOString(),
            token_limit: which, token_limit_role: "reviewer", tokens_this_call: callTotal, tokens_this_run: runTotal,
            review_path: latestReviewPath, claude_stdout_path: stdoutPath,
          });
          await recordIo(paths, runId, {
            event: "stop", status: "token_limit", role: "reviewer", provider: "codex",
            detail_ref: which + ":" + (which === "per_call" ? callTotal : runTotal),
          });
          await consumeAuthorization(paths, control, "token_limit");
          return 76;
        }
      }
      // D4.3 / D4.4: ids that survive a correction are unresolved; one survival on FAIL is a loop.
      const recheck = call > 1 ? recheckFindings(lastFindings, reviewResult.findings) : null;
      if (recheck) await recordIo(paths, runId, { event: "recheck", call, ...recheck });
      const loop = recheck && reviewResult.gate === "FAIL" && recheck.unresolved.length ? recheck.unresolved[0] : null;
      const gate = {
        review_gate: reviewResult.gate,
        hard_stop_required: reviewResult.hard_stop || Boolean(loop),
        hard_stop_reason: loop ? "needs_human_decision" : reviewResult.hard_stop_reason,
        findings: reviewResult.findings.length,
      };
      if (loop) {
        await recordIo(paths, runId, { event: "stop", status: "hard_stop", role: "controller", provider: null, detail_ref: "loop:" + loop });
      }
      lastFindings = reviewResult.findings;
      lastGate = reviewResult.gate;
      await writeBoundedState(paths, runtimeState, {
        writer_model: writerModel,
        status: gate.review_gate === "PASS"
          ? "pass"
          : gate.hard_stop_required ? "hard_stop" : "correction_required",
        session_id: sessionId,
        call,
        updated_at: new Date().toISOString(),
        // G3.7: PASS is both halves; the gate half is recorded beside the reviewer's.
        ...(gateAResult ? { gate_a_passed: gateAResult.kind === "command" ? gateAResult.passed : null } : {}),
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
          ...(gateAResult ? { gate_a_passed: gateAResult.kind === "command" ? gateAResult.passed : null } : {}),
          ...gate,
          review_path: latestReviewPath,
          claude_stdout_path: stdoutPath,
          failure: failureSummary(budgetStop({ phase: "correction", maxCalls })),
        });
        await consumeAuthorization(paths, control, "call_budget_exhausted", gate);
        return 76;
      }

      currentControl = await loadLiveControl(paths, runtimeState);
      currentControl.v4_runtime_state = runtimeState;
      if (!sameAuthorization(currentControl, control)) {
        throw new Error("Work package authorization was cancelled before correction.");
      }
      await runtimeState.incrementIteration();
    }
    await consumeAuthorization(paths, control, "call_budget_exhausted");
    return 76;
  } catch (error) {
    if ((await readRunStatus(paths, runtimeState.runId)) === "stopped") return 130;
    const currentState = await runtimeState.getState().catch(() => null);
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
