import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  acquireLock,
  appendIoEvent,
  classifyProviderFailure,
  fileExists,
  isActiveRun,
  isPidAlive,
  isStoppedRun,
  killProcessTree,
  listJson,
  parseJson,
  readEvidenceTail,
  readIoEvents,
  readJson,
  readRun,
  RunEndedError,
  runProcess,
  STOP_REASONS,
  stopRunRecord,
  DatabaseUnavailableError,
  tokenTotal,
  usageTotalForRun,
  writeFailureRecord,
  writeJson,
  writeText,
} from "../../service/index.mjs";
import { assertUnder } from "../../utils/pathGuard.mjs";
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
import { runTest, sameDelta } from "./test.mjs";
import { createWorkspaceDelta, EvidenceChangedError, EvidenceUnavailableError, recordWindow, sealEvidence, snapshotWorkspace, startPointStatus, verifySealedEvidence } from "./workspaceEvidence.mjs";
import { validateWriterPolicy } from "../../policy/policyChecks.mjs";
import { priorityChoice } from "../../policy/policyRules.mjs";
import { budgetStop, controllerError, failureSummary } from "./budget.mjs";
import { acceptanceRows, decideAcceptance, sameVersion, workVersion } from "./acceptance.mjs";
import { ContractChangedError, loadContract } from "./contract.mjs";
import { establishContract } from "./translation.mjs";
import { callStamp, callTimeLeft, clearProcess, killConfirmed, processFile, recordProcess, recordProcessOrKill, runMustStop, runStopped, workLockFile } from "./processRecords.mjs";

export { recordProcessOrKill, runMustStop } from "./processRecords.mjs";

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
    && current.active_writer_session === expected.active_writer_session
    && String(current.authorization_plan_sha256 || "")
      === String(expected.authorization_plan_sha256 || "");
}

async function consumeAuthorization(paths, expected, reason, gate = null) {
  await expected.runtime_state.consume(reason, gate);
}

async function loadLiveControl(paths, runtimeState) {
  return await runtimeState.loadControl();
}

export const DEFAULT_WRITER_MODEL = "opus";

// The plan settled the writer's model from the work order's priority; a run from before that uses
// the policy's default priority, and a snapshot without a priority table the package default.
export function writerModelFor(control) {
  const workPackage = control?.run?.work_package;
  if (workPackage?.priority) return workPackage.writer.model;
  const policy = control?.run?.policy_snapshot?.effective_policy;
  return policy?.priority ? priorityChoice(policy).writer.model : DEFAULT_WRITER_MODEL;
}

async function writeBoundedState(paths, runtimeState, state) {
  return await runtimeState.recordState(state);
}

// A writer or test call runs between two snapshots of the work, so its changes can be tied to it
// (workspaceEvidence.mjs); each window's hash joins the controller's in-memory seal. Without Git,
// or without a baseline, the call just runs.
async function inWindow(paths, baselinePath, sealed, meta, work) {
  const before = baselinePath ? await snapshotWorkspace(paths, baselinePath) : null;
  const result = await work();
  if (!before) return result;
  const recorded = await recordWindow(paths, baselinePath, { ...meta, before });
  sealed.windows.set(path.resolve(recorded.file), recorded.sha256);
  return result;
}

// A resumed run whose earlier calls left records: the controller that sealed them is gone, so they
// cannot be confirmed. No model call starts; the human decides (this is not a claim of tampering).
async function unconfirmableEvidenceStop({ paths, runtimeState, control, writerModel, sessionId }) {
  const baselinePath = control.workspace_evidence?.baseline_path;
  if (!baselinePath) return null;
  const earlier = await listJson(path.join(path.dirname(baselinePath), "windows")).catch(() => []);
  if (!earlier.length) return null;
  await writeBoundedState(paths, runtimeState, {
    writer_model: writerModel, status: "evidence_unconfirmable", session_id: sessionId, call: 0, updated_at: new Date().toISOString(),
    earlier_call_records: earlier.length,
  });
  await recordIo(paths, runtimeState.runId, { event: "stop", status: "evidence_unconfirmable", role: "controller", provider: null, detail_ref: "resume" });
  await consumeAuthorization(paths, control, "evidence_unconfirmable");
  return 0;
}

// After every untrusted call (writer, tests, reviewer): the work-proof records must still be the
// ones this controller sealed, and the Git start must still exist. Either failing stops the run
// for the human. Without Git there is nothing to check.
async function proofStop({ paths, runtimeState, control, baselinePath, sealed, state, after }) {
  if (!baselinePath) return null;
  let status = null;
  let detail = null;
  try {
    const baseline = await verifySealedEvidence(paths, baselinePath, sealed);
    if (baseline.mode === "git" && (await startPointStatus(paths, baselinePath)) === "lost") { status = "start_point_lost"; detail = "git_start:" + after; }
  } catch (error) {
    if (!(error instanceof EvidenceChangedError)) throw error;
    status = "evidence_changed";
    detail = after + ":" + error.message;
  }
  if (!status) return null;
  await writeBoundedState(paths, runtimeState, { ...state, status, updated_at: new Date().toISOString(), error: detail });
  await recordIo(paths, runtimeState.runId, { event: "stop", status, role: "controller", provider: null, detail_ref: detail });
  await consumeAuthorization(paths, control, status);
  return 0;
}

// Exit code shared with reference_changed: an input sealed at start no longer matches.
const SEALED_INPUT_CHANGED_EXIT_CODE = 78;

// Every boundary reads the contract through the hash the run recorded; a missing or changed
// file ends the run instead of letting any model work from another version.
async function checkedContract({ paths, runtimeState, control, contractSha256, state }) {
  if (!contractSha256) return { contract: null, exitCode: null };
  try {
    return { contract: { sha256: contractSha256, contract: await loadContract(paths, contractSha256) }, exitCode: null };
  } catch (error) {
    if (!(error instanceof ContractChangedError)) throw error;
    await writeBoundedState(paths, runtimeState, { ...state, status: "contract_changed", updated_at: new Date().toISOString(), error: error.message });
    await recordIo(paths, runtimeState.runId, { event: "stop", status: "contract_changed", role: "controller", provider: null, detail_ref: contractSha256 });
    await consumeAuthorization(paths, control, "contract_changed");
    return { contract: null, exitCode: SEALED_INPUT_CHANGED_EXIT_CODE };
  }
}

// A stop before the work exits with the code the writer's or reviewer's own stop of that kind uses;
// one that needs the human (an unclear work order, an unconfirmed check) exits 0 like needs_human.
// sysexits' EX_UNAVAILABLE: something the run needs is gone (the database, the change list).
const UNAVAILABLE_EXIT = 69;

const CONTRACT_EXIT_CODES = Object.freeze({
  needs_human: 0, contract_unconfirmed: 0, writer_failed: 1, reviewer_failed: 1, policy_failure: 1, rate_limited: 75, token_limit: 76, usage_unknown: 76,
  // The status could not be read when a stop check failed closed; the run is closed as stopped.
  stopped: 130,
  writer_timeout: 77, contract_rejected: MALFORMED_EXIT_CODE,
});

// A work-order run gets its contract once, before the writer's first call; a resumed run keeps it.
async function sealedContractFor({ paths, runtimeState, control, adapter, writerModel, sessionId, onStep, onContractSealed }) {
  const workPackage = control.run.work_package;
  if (!workPackage.task_file) return { sha256: null, exitCode: null };
  if (control.run.contract_sha256) return { sha256: control.run.contract_sha256, exitCode: null };
  if (!workPackage.contract_steps) throw new Error("The work package names no contract steps; build a new plan.");
  const runId = runtimeState.runId;
  onStep("Writer (" + workPackage.contract_steps.translate.provider + ") turns the work order into a contract; reviewer ("
    + workPackage.contract_steps.check.provider + ") checks it");
  const translated = await establishContract({
    paths, runId, workPackage, adapter, limits: effectiveLimits(control), executionMode: control.execution_mode,
    isStopped: () => runMustStop(paths, runId),
    effort: control.reviewer_policy?.effort || "medium",
    model: control.reviewer_policy?.model ?? null,
    translateEffort: control.token_policy.writer_effort,
    onSpawn: (pid, role, provider) => recordProcess(paths, runId, { pid, role, provider, call: 0 }),
  });
  await clearProcess(paths, runId);
  if (await runStopped(paths, runId)) return { sha256: null, exitCode: 130 };
  if (translated.status === "sealed") {
    await runtimeState.recordContract(translated.sha256);
    if (onContractSealed) await onContractSealed(translated.sha256);
    onStep("Contract sealed");
    return { sha256: translated.sha256, exitCode: null };
  }
  const { status, detail, problems = [], questions = [], failure = null, ...ceiling } = translated;
  await writeBoundedState(paths, runtimeState, {
    writer_model: writerModel, status, session_id: sessionId, call: 0, updated_at: new Date().toISOString(),
    contract_problems: problems, contract_questions: questions, ...(failure ? { failure } : {}), ...ceiling,
  });
  await recordIo(paths, runId, { event: "stop", status, role: "controller", provider: null, detail_ref: "contract:" + detail });
  await consumeAuthorization(paths, control, status);
  return { sha256: null, exitCode: CONTRACT_EXIT_CODES[status] };
}

// T0-04 D4.1: the token and test ceilings are the run's budget, which the plan settled from the
// work order and the policy; max_turns comes from the policy snapshot. Missing ones use the package
// defaults. test_timeout was missing here until RC3-BLOCKER-00, which left the tests with no limit.
export const DEFAULT_LIMITS = Object.freeze({ max_turns: 20, tokens_per_call: 1_500_000, tokens: 4_000_000, max_output_chars: 4_000, test_timeout: 600_000 });
export function effectiveLimits(control) {
  const limits = control?.run?.policy_snapshot?.effective_policy?.limits || {};
  const budget = control?.run?.work_package?.budget || {};
  return {
    max_turns: limits.max_turns ?? DEFAULT_LIMITS.max_turns,
    tokens_per_call: budget.tokens_per_call ?? limits.tokens_per_call ?? DEFAULT_LIMITS.tokens_per_call,
    tokens: budget.tokens ?? limits.tokens ?? DEFAULT_LIMITS.tokens,
    max_output_chars: DEFAULT_LIMITS.max_output_chars,
    test_timeout: budget.test_timeout ?? limits.test_timeout ?? DEFAULT_LIMITS.test_timeout,
  };
}

async function recordIo(paths, runId, event) {
  if (!runId) return null;
  return await appendIoEvent(paths, runId, event);
}

async function changedFilesForJob(paths, jobId) {
  const job = await readJson(path.join(paths.doneDir, jobId + ".json")).catch(() => null);
  const deltaPath = job?.workspace_evidence?.delta_path;
  if (!deltaPath) return [];
  const delta = await readJson(deltaPath).catch(() => null);
  return (delta?.changed_files || []).map((entry) => ({ path: entry.path, change: entry.change }));
}

// A killed process tree can take a moment to go; give it up to three seconds before calling it alive.
async function stillAlive(pid) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    if (!isPidAlive(pid)) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return isPidAlive(pid);
}

async function unresolvedProcess(paths, runId) {
  return Boolean((await readJson(processFile(paths, runId)).catch(() => null))?.pid);
}

// T0-04 D5.2: mark the run stopped first so the writer loop sees it, then kill the process tree.
// `supersededBy` is the run of a new version of the same work order that this stop makes room for.
export async function stopRun(paths, runId, { kill = killProcessTree, supersededBy = null } = {}) {
  const run = await readRun(paths, runId).catch(() => null);
  if (!run) return { exitCode: 1, line: "沒有這條", reason: "unknown" };
  // A stopped run that still has a pid record is a stop whose kill was not confirmed: retry the
  // kill without writing the stop again.
  const retry = isStoppedRun(run) && await unresolvedProcess(paths, runId);
  if (!retry) {
    if (!isActiveRun(run)) return { exitCode: 1, line: "已經結束：" + run.closed_reason, reason: "terminal" };
    // The early read above cannot see a PASS written just after it; the locked write decides.
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await stopRunRecord(paths, runId, { closedReason: supersededBy ? "superseded" : "stopped", supersededBy });
        lastError = null;
        break;
      } catch (error) {
        if (error instanceof RunEndedError) {
          if (STOP_REASONS.includes(error.reason) && await unresolvedProcess(paths, runId)) { lastError = null; break; }
          return { exitCode: 1, line: "已經結束：" + error.reason, reason: "terminal" };
        }
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    if (lastError) throw lastError;
  }
  // Read the pid only after the run is marked stopped. A call records its pid and then reads the
  // status (recordProcessOrKill), so whichever side comes second sees the other: either this
  // read finds the pid, or the call finds the run stopped and kills its own process.
  const record = await readJson(processFile(paths, runId)).catch(() => null);
  const killed = record?.pid ? await kill(record.pid) : { killed: false, reason: "no_process" };
  // A kill that is not confirmed, or a process that outlives it, is reported and its record kept
  // for another stop; no "stopped" result is delivered while any of it may still be working.
  if (record?.pid && (!killConfirmed(killed) || await stillAlive(record.pid))) {
    await appendIoEvent(paths, runId, { event: "stop", status: "stop_incomplete", role: record.role || null, provider: record.provider || null, detail_ref: "pid:" + record.pid + ":" + killed.reason });
    return { exitCode: 2, line: "停止未完成：pid " + record.pid + " 仍在執行，請再執行一次 stop", reason: "kill_failed" };
  }
  await appendIoEvent(paths, runId, {
    event: "stop", status: "stopped", role: record?.role || null, provider: record?.provider || null,
    detail_ref: record ? "pid:" + record.pid + ":" + killed.reason : "no_process",
    ...(supersededBy ? { superseded_by: supersededBy } : {}),
  });
  await fsp.rm(processFile(paths, runId), { force: true });
  return { exitCode: 0, line: "已停止 " + runId, reason: killed.reason };
}

export async function validateBoundedResume({
  paths,
  control,
  adapter,
  promptPath,
  rounds,
  callTimeout,
}) {
  validateWriterPolicy(control, rounds, callTimeout);
  const resolvedPrompt = assertUnder(path.resolve(promptPath), paths.privateRoot, "Bounded prompt");
  if (!(await fileExists(resolvedPrompt))) throw new Error("Prompt file is missing.");
  // Only this run's own review jobs hold it back; other runs' reviews go on beside it. A job that
  // moved between listing and reading is skipped; one that cannot be read counts as this run's.
  const runId = control.run?.run_id || null;
  for (const file of [...await listJson(paths.pendingDir), ...await listJson(paths.runningDir)]) {
    let owner;
    try {
      owner = (await readJson(file)).authorization?.run_id ?? null;
    } catch (error) {
      if (error.code === "ENOENT") continue;
      owner = runId;
    }
    if (owner === runId) throw new Error("This run's review queue must be idle before bounded resume.");
  }
  await adapter.resolveExecutable("claude");
  return {
    valid: true,
    session_id: String(control.active_writer_session),
    transport: control.dispatch_transport,
    disallowed_tools: [...(control.token_policy?.writer_disallowed_tools || [])],
    mode: "writer_only",
    model: writerModelFor(control),
    effort: control.token_policy.writer_effort,
    rounds,
    call_timeout: callTimeout,
    prompt_path: resolvedPrompt,
  };
}

export async function runBoundedResume({
  paths,
  control,
  adapter,
  promptPath,
  rounds,
  callTimeout,
  startNewSession = false,
  runtimeState,
  workLock = null,
  // One line per step for the person watching (start); the run's records do not depend on it.
  onStep = () => {},
  // The sealed contract's SHA-256, as soon as it is sealed (start records it in the database).
  onContractSealed = null,
}) {
  control.runtime_state = runtimeState;
  const invocationStartedAt = Date.now();
  // The run's own work lock: taken by work-start before the run existed, or here on a resume. Other
  // runs hold their own and work side by side (decision 2026-10-17).
  const release = workLock || await acquireLock(workLockFile(paths, runtimeState.runId));
  let validation = null;
  try {
    // Inside the try: a run that fails its checks is closed, never left running.
    validation = await validateBoundedResume({
      paths, control, adapter, promptPath, rounds, callTimeout,
    });
    const claude = await adapter.resolveExecutable("claude");
    let sessionId = validation.session_id;
    const writerModel = validation.model;
    let currentControl = control;
    let lastFindings = [];
    let lastGate = null;
    let lastChangedFiles = [];
    let lastTestResult = null;
    let lastTestDelta = null;
    let handoffReason = "correction";
    const writerSchemaArg = JSON.stringify(await loadSchema(WRITER_RESULT_SCHEMA));
    const unconfirmable = await unconfirmableEvidenceStop({ paths, runtimeState, control, writerModel, sessionId });
    if (unconfirmable !== null) return unconfirmable;
    const sealed = await sealedContractFor({ paths, runtimeState, control, adapter, writerModel, sessionId, onStep, onContractSealed });
    if (sealed.exitCode !== null) return sealed.exitCode;
    const contractSha256 = sealed.sha256;
    // The work-proof seal: the baseline hash as authorized, and every window this controller writes.
    const evidenceSeal = sealEvidence(control.workspace_evidence?.baseline_sha256);

    for (let call = 1; call <= rounds; call += 1) {
      currentControl = await loadLiveControl(paths, runtimeState);
      currentControl.runtime_state = runtimeState;
      if (!sameAuthorization(currentControl, control)) {
        throw new Error("Work package authorization is no longer active.");
      }
      const stamp = callStamp(runtimeState.runId);
      const stdoutPath = path.join(paths.queueRoot, stamp + "-writer.stdout.json");
      const streamPath = path.join(paths.queueRoot, stamp + "-writer.stream.jsonl");
      const stderrPath = path.join(paths.queueRoot, stamp + "-writer.stderr.log");
      const payloadPath = path.join(paths.queueRoot, stamp + "-stop-payload.json");
      const effectivePromptPath = path.join(paths.queueRoot, stamp + "-writer-only-prompt.txt");
      const workPackage = currentControl.run.work_package;
      const runId = runtimeState.runId;
      const limits = effectiveLimits(currentControl);
      // D2.1: every call is a fresh session; the run records the rotation.
      if (call > 1) {
        sessionId = randomUUID();
        await runtimeState.rotateSession(sessionId);
        control.active_writer_session = sessionId;
        currentControl = await loadLiveControl(paths, runtimeState);
        currentControl.runtime_state = runtimeState;
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
      const boundaryState = { writer_model: writerModel, session_id: sessionId, call };
      const beforeCall = await checkedContract({ paths, runtimeState, control, contractSha256, state: boundaryState });
      if (beforeCall.exitCode !== null) return beforeCall.exitCode;
      const contract = beforeCall.contract;
      const readList = buildReadList({ references, findings: lastFindings });
      const taskInput = buildTaskInput({ workPackage, call, readList, limits, contract });
      const handoff = call > 1 ? buildHandoff({
        workPackage, call, reason: handoffReason, ioEvents: await readIoEvents(paths, runId),
        openFindings: lastFindings, lastGate, changedFiles: lastChangedFiles, readList,
        testResult: handoffReason === "test_failed" ? lastTestResult : null, contract,
      }) : null;
      if (handoff) await recordIo(paths, runId, handoff);
      const effectivePrompt = composeWriterPrompt({
        workPackage, control: currentControl, runId, call, taskInput, references, handoff,
        rulesText: workPackage.rules?.text || "", contract,
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
        // A model of null leaves the choice to the CLI.
        ...(writerModel ? ["--model", writerModel] : []),
        "--effort", validation.effort,
        "--max-turns", String(limits.max_turns),
        "--output-format", "stream-json",
        "--verbose",
        // T0-05 D1.1: the CLI is asked for a writer.result-shaped answer.
        "--json-schema", writerSchemaArg,
      ];
      const invocation = adapter.buildInvocation("claude", claude, claudeArgs);
      // The call's own limit, cut to what is left of the run's time; nothing is left: no call.
      const writerTimeout = await callTimeLeft(paths, runId, callTimeout);
      if (writerTimeout === null) return 130;
      onStep("Writer working (call " + call + " of " + rounds + ")");
      const callStartedAt = Date.now();
      const baselinePath = currentControl.workspace_evidence?.baseline_path || null;
      const processResult = await inWindow(paths, baselinePath, evidenceSeal, { runId, call, phase: "writer" }, () => runProcess({
        invocation,
        cwd: paths.repoRoot,
        input: effectivePrompt,
        stdoutPath: streamPath,
        stderrPath,
        timeoutMs: writerTimeout,
        onSpawn: (pid) => recordProcessOrKill(paths, runId, { pid, role: "writer", provider: "claude", call }),
      }));
      await clearProcess(paths, runId);
      // Checked at the call's common exit, before any success or failure path returns: a call that
      // rewrites a record and then fails is still caught. A rebase, amend, reset or branch switch
      // since the start leaves nothing sound to compare against; the human decides.
      const proofState = { writer_model: writerModel, session_id: sessionId, call, writer_stdout_path: stdoutPath };
      const afterWriterProof = await proofStop({ paths, runtimeState, control, baselinePath, sealed: evidenceSeal, state: proofState, after: "writer" });
      if (afterWriterProof !== null) return afterWriterProof;
      // D3.3: the final result object keeps the legacy single-JSON file for everything downstream.
      const stream = parseClaudeStream(await fsp.readFile(streamPath, "utf8").catch(() => ""));
      // Tokens spent by a call with no final result still count; the record says it is partial.
      if (!stream.result || processResult.timedOut) {
        await recordIo(paths, runId, partialUsageFromStream(stream.streamUsage, { call, durationMs: Date.now() - callStartedAt }));
      }
      // D5.3: stopped from outside; nothing more is classified (the spent tokens above are accounting).
      if (await runStopped(paths, runId)) return 130;
      if (stream.result) await writeJson(stdoutPath, stream.result);
      for (const read of stream.reads) {
        await recordIo(paths, runId, {
          event: "read", call, ...read,
          ...(read.path ? { outside_list: readList.length ? !isInReadList(read.path, readList) : null } : {}),
        });
      }
      let writerUsage = null;
      if (stream.result && !processResult.timedOut) {
        const usage = usageFromResult(stream.result, { call, durationMs: Date.now() - callStartedAt });
        writerUsage = usage;
        await recordIo(paths, runId, usage);
        const callTotal = tokenTotal(usage.tokens);
        const runTotal = await usageTotalForRun(paths, runId);
        if (callTotal > limits.tokens_per_call || runTotal > limits.tokens) {
          const which = callTotal > limits.tokens_per_call ? "per_call" : "per_run";
          await writeBoundedState(paths, runtimeState, {
            writer_model: writerModel, status: "token_limit", session_id: sessionId, call, updated_at: new Date().toISOString(),
            token_limit: which, tokens_this_call: callTotal, tokens_this_run: runTotal, writer_stdout_path: stdoutPath,
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
        const timeout = await writeFailureRecord(paths, paths.queueRoot, stamp + "-writer", classifyProviderFailure({
          role: "writer", provider: "claude", phase: "write", exitCode: processResult.exitCode, timedOut: true,
        }), { stdout_path: stdoutPath, stderr_path: stderrPath });
        await writeBoundedState(paths, runtimeState, {
          writer_model: writerModel,
          status: "writer_timeout",
          failure: failureSummary(timeout.record, timeout.record_path),
          session_id: sessionId,
          call,
          updated_at: new Date().toISOString(),
          call_timeout: callTimeout,
          stdout_path: stdoutPath,
          stderr_path: stderrPath,
        });
        await consumeAuthorization(paths, control, "writer_timeout");
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
        throw new Error("Writer session drift detected.");
      }
      if (!claudeResult || claudeResult.is_error === true || processResult.exitCode !== 0) {
        const classified = classifyProviderFailure({
          role: "writer",
          provider: "claude",
          phase: "write",
          exitCode: processResult.exitCode,
          texts: [
            // The CLI marks its own error with is_error; only then is `result` its message (a usage
            // limit is reported there). Otherwise `result` is the model's text and is not read.
            claudeResult?.is_error === true ? String(claudeResult.result || "") : "",
            await readEvidenceTail(stderrPath),
            claudeResult ? "" : await readEvidenceTail(stdoutPath),
          ],
        });
        const written = await writeFailureRecord(paths, paths.queueRoot, stamp + "-writer", classified, {
          stdout_path: stdoutPath,
          stderr_path: stderrPath,
        });
        const limited = classified.reason === "provider_usage_limit";
        await writeBoundedState(paths, runtimeState, {
          writer_model: writerModel,
          status: limited ? "rate_limited" : "writer_failed",
          session_id: sessionId,
          call,
          updated_at: new Date().toISOString(),
          writer_exit_code: processResult.exitCode,
          writer_json_valid: Boolean(claudeResult),
          failure: failureSummary(classified, written.record_path),
          stdout_path: stdoutPath,
          stderr_path: stderrPath,
        });
        await consumeAuthorization(paths, control, limited ? "rate_limited" : "writer_failed");
        return limited ? 75 : 1;
      }
      // Usage Bridge cannot read cannot be shown to stay under the ceilings; no further call starts.
      if (!writerUsage || writerUsage.parse_error) {
        await writeBoundedState(paths, runtimeState, {
          writer_model: writerModel, status: "usage_unknown", session_id: sessionId, call, updated_at: new Date().toISOString(),
          token_limit_role: "writer", missing: writerUsage?.missing || [], writer_stdout_path: stdoutPath,
        });
        await recordIo(paths, runId, { event: "stop", status: "usage_unknown", role: "writer", provider: "claude", detail_ref: "usage" });
        await consumeAuthorization(paths, control, "usage_unknown");
        return 76;
      }
      // The writer ran with write access; the contract must still be the one it was given.
      const afterWriter = await checkedContract({ paths, runtimeState, control, contractSha256, state: boundaryState });
      if (afterWriter.exitCode !== null) return afterWriter.exitCode;
      // T0-05 D1: the typed answer is checked by the harness; prose is never read.
      const writerResult = writerResultFromClaudeResult(claudeResult);
      const writerCheck = await validateWriterResult(writerResult, { workOrder: workPackage.work_package_id, call, contractSha256, contract: afterWriter.contract?.contract || null });
      if (!writerCheck.ok) {
        await writeBoundedState(paths, runtimeState, {
          writer_model: writerModel, status: "malformed_writer_result", session_id: sessionId, call,
          updated_at: new Date().toISOString(), errors: writerCheck.errors.slice(0, 20), writer_stdout_path: stdoutPath,
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
          writer_status: writerResult.status, needs_human: writerResult.needs_human, writer_stdout_path: stdoutPath,
        });
        await recordIo(paths, runId, { event: "stop", status: "needs_human", role: "writer", provider: "claude", detail_ref: writerResult.status });
        await consumeAuthorization(paths, control, "needs_human");
        return 0;
      }
      // T0-06 G3: the sealed verification runs after the writer and before any review.
      let testResult = null;
      if (workPackage.test) {
        // The version the tests run on is recorded with their result, so a condition proven by them can
        // be tied to the version the reviewer later reads.
        const testedVersion = await workVersion(paths.repoRoot);
        const testTimeout = workPackage.test.kind === "command" ? await callTimeLeft(paths, runId, limits.test_timeout) : limits.test_timeout;
        if (testTimeout === null) return 130;
        onStep(workPackage.test.kind === "command" ? "Tests: running " + workPackage.test.command : "Tests: not configured for this project");
        testResult ={ ...(await inWindow(paths, baselinePath, evidenceSeal, { runId, call, phase: "test" }, () => runTest({
          paths, test: workPackage.test,
          stdoutPath: path.join(paths.queueRoot, stamp + "-test.stdout.log"),
          stderrPath: path.join(paths.queueRoot, stamp + "-test.stderr.log"),
          timeoutMs: testTimeout,
          onSpawn: (pid) => recordProcessOrKill(paths, runId, { pid, role: "controller", provider: "test", call }),
        }))), work_version: testedVersion };
        await clearProcess(paths, runId);
        if (await runStopped(paths, runId)) return 130;
        await recordIo(paths, runId, { ...testResult, call });
        if (testResult.kind === "command") onStep("Tests " + (testResult.passed ? "passed" : "failed"));
        const afterGateProof = await proofStop({ paths, runtimeState, control, baselinePath, sealed: evidenceSeal, state: proofState, after: "test" });
        if (afterGateProof !== null) return afterGateProof;
        if (testResult.kind === "command" && !testResult.passed) {
          // G3.5: the controller's result goes back to the writer as fix.input; no reviewer call.
          const delta = currentControl.workspace_evidence?.baseline_path
            ? await createWorkspaceDelta({ paths, baselinePath: currentControl.workspace_evidence.baseline_path, deltaId: "test-" + stamp, sealed: evidenceSeal })
            : null;
          const changed = delta ? (await readJson(delta.delta_path)).changed_files : [];
          // Without Git there is no list of changes, so "nothing changed between two failures" cannot be shown.
          const comparable = delta?.mode === "git";
          lastChangedFiles = changed.map((entry) => ({ path: entry.path, change: entry.change, after_sha256: entry.after_sha256 }));
          const gateState = {
            writer_model: writerModel, status: "test_failed", session_id: sessionId, call, updated_at: new Date().toISOString(),
            test_passed: false, test_command: testResult.command, test_exit_code: testResult.exit_code, test_timed_out: testResult.timed_out,
            writer_stdout_path: stdoutPath,
          };
          // G3.6: the same command failing twice on an unchanged delta means nothing was fixed.
          if (comparable && lastTestResult && lastTestDelta && sameDelta(lastTestDelta, lastChangedFiles)) {
            const stopGate = { review_gate: "FAIL", hard_stop_required: true, hard_stop_reason: "needs_human_decision" };
            await writeBoundedState(paths, runtimeState, { ...gateState, status: "hard_stop", ...stopGate });
            await recordIo(paths, runId, { event: "stop", status: "hard_stop", role: "controller", provider: null, detail_ref: "test_loop" });
            await consumeAuthorization(paths, control, "review_hard_stop", stopGate);
            return 0;
          }
          lastTestResult = testResult;
          lastTestDelta = comparable ? lastChangedFiles : null;
          handoffReason = "test_failed";
          lastFindings = [];
          await writeBoundedState(paths, runtimeState, gateState);
          if (call >= rounds) {
            await writeBoundedState(paths, runtimeState, {
              ...gateState, status: "rounds_exhausted", failure: failureSummary(budgetStop({ phase: "correction", maxCalls: rounds })),
            });
            await consumeAuthorization(paths, control, "rounds_exhausted");
            return 76;
          }
          await recordIo(paths, runId, {
            event: "fix.input", work_order: workPackage.work_package_id, call: call + 1, reason: "test_failed",
            test_result: { command: testResult.command, exit_code: testResult.exit_code, timed_out: testResult.timed_out, stdout_tail: testResult.stdout_tail, stderr_tail: testResult.stderr_tail },
            read_list: buildReadList({ deltaPaths: lastChangedFiles.map((entry) => entry.path) }),
            limits: { max_turns: limits.max_turns, max_output_chars: limits.max_output_chars },
          });
          await runtimeState.incrementIteration();
          continue;
        }
        handoffReason = "correction";
      }
      currentControl = await loadLiveControl(paths, runtimeState);
      currentControl.runtime_state = runtimeState;
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
      // The version the reviewer will read; a test result for another version proves nothing here.
      const reviewVersion = await workVersion(paths.repoRoot);
      // Decision 2026-10-19: what the tests ran on must be what the reviewer reads. A project that changed
      // since the tests, whoever changed it (another run in this folder, or a person), stops here, before
      // a review is paid for.
      if (testResult?.kind === "command" && testResult.work_version?.kind === "git" && !sameVersion(testResult.work_version, reviewVersion)) {
        await writeBoundedState(paths, runtimeState, { ...proofState, status: "version_changed", changed_after: "test", updated_at: new Date().toISOString(), tested_version: testResult.work_version, review_version: reviewVersion });
        await recordIo(paths, runId, { event: "stop", status: "version_changed", role: "controller", provider: null, detail_ref: "test" });
        await consumeAuthorization(paths, control, "version_changed");
        return 0;
      }
      const enqueued = await enqueueReview({
        payload,
        paths,
        control: currentControl,
        writerResult,
        call,
        openFindings: lastFindings,
        testResult,
        workVersion: reviewVersion,
        sealedEvidence: evidenceSeal,
      });
      const hookQueuedDuplicate = enqueued.accepted
        && enqueued.duplicate
        && await hasPendingMessageHash(paths, enqueued.message_hash);
      if (!enqueued.accepted || (enqueued.duplicate && !hookQueuedDuplicate)) {
        throw new Error("Bounded correction did not create a new review job.");
      }
      const ownJobId = await enqueuedJobId(paths, enqueued);
      onStep("Reviewer checking the work");
      const reviewOutcomes = await runReviewWorker({
        paths, control: currentControl, adapter, noNotification: true, only: ownJobId,
      });
      // Other pending jobs may run in the same worker pass; only this run's job is attributed here.
      const ownOutcomes = (reviewOutcomes || []).filter((outcome) => outcome.job_id === ownJobId);
      if (ownOutcomes.length !== 1) {
        throw new Error("Review worker returned no unambiguous outcome for job " + ownJobId + ".");
      }
      const [ownOutcome] = ownOutcomes;
      // Stopped during the review: the killed review's output is not taken, and nothing is recorded.
      if (ownOutcome.status === "stopped" || await runStopped(paths, runId)) return 130;
      const afterReviewProof = await proofStop({ paths, runtimeState, control, baselinePath, sealed: evidenceSeal, state: proofState, after: "review" });
      if (afterReviewProof !== null) return afterReviewProof;
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
          writer_stdout_path: stdoutPath,
          writer_stderr_path: stderrPath,
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
      if (!(await fileExists(latestReviewPath))) throw new Error("Reviewer result is missing.");
      const afterReview = await checkedContract({ paths, runtimeState, control, contractSha256, state: boundaryState });
      if (afterReview.exitCode !== null) return afterReview.exitCode;
      // The reviewer judged the version recorded before the review; if the work changed meanwhile,
      // its verdicts do not belong to any version Bridge can name.
      const versionAfterReview = await workVersion(paths.repoRoot);
      if (reviewVersion.kind === "git" && !sameVersion(reviewVersion, versionAfterReview)) {
        await writeBoundedState(paths, runtimeState, { ...proofState, status: "version_changed", changed_after: "review_start", updated_at: new Date().toISOString(), review_version: reviewVersion, version_after_review: versionAfterReview });
        await recordIo(paths, runId, { event: "stop", status: "version_changed", role: "controller", provider: null, detail_ref: "review" });
        await consumeAuthorization(paths, control, "version_changed");
        return 0;
      }
      const review = await fsp.readFile(latestReviewPath, "utf8");
      lastChangedFiles = await changedFilesForJob(paths, ownJobId);
      // T0-05 D3: the typed verdict is checked against the fixed rules; prose is not read.
      let reviewResult = null;
      try { reviewResult = parseJson(review); } catch { reviewResult = null; }
      // A controller-decided verdict (D2.5) is the harness's own; only a reviewer's answer is checked.
      const check = ownOutcome.controller_decided ? { ok: true, errors: [] } : await validateReviewResult(reviewResult, {
        workOrder: workPackage.work_package_id, call, repoRoot: paths.repoRoot,
        previousFindings: lastFindings, deltaPaths: call > 1 ? lastChangedFiles.map((entry) => entry.path) : null, contractSha256,
        contract: afterReview.contract?.contract || null,
      });
      if (!check.ok) {
        await writeBoundedState(paths, runtimeState, {
          writer_model: writerModel, status: "malformed_review_result", session_id: sessionId, call,
          updated_at: new Date().toISOString(), errors: check.errors.slice(0, 20), review_path: latestReviewPath, writer_stdout_path: stdoutPath,
        });
        await recordIo(paths, runId, { event: "stop", status: "malformed_event", role: "reviewer", provider: "codex", detail_ref: check.errors[0] || "review.result" });
        await consumeAuthorization(paths, control, "malformed_review_result");
        return MALFORMED_EXIT_CODE;
      }
      await recordIo(paths, runId, { ...reviewResult });
      // A reviewer call whose usage cannot be read cannot be shown to stay under the ceilings.
      if (!ownOutcome.controller_decided && (!ownOutcome.usage || ownOutcome.usage.parse_error)) {
        await writeBoundedState(paths, runtimeState, {
          writer_model: writerModel, status: "usage_unknown", session_id: sessionId, call, updated_at: new Date().toISOString(),
          token_limit_role: "reviewer", missing: ownOutcome.usage?.missing || [], review_path: latestReviewPath, writer_stdout_path: stdoutPath,
        });
        await recordIo(paths, runId, { event: "stop", status: "usage_unknown", role: "reviewer", provider: "codex", detail_ref: "usage" });
        await consumeAuthorization(paths, control, "usage_unknown");
        return 76;
      }
      // D5.3: the reviewer's call is measured against the same ceilings as the writer's.
      if (ownOutcome.usage && !ownOutcome.controller_decided) {
        const callTotal = tokenTotal(ownOutcome.usage.tokens);
        const runTotal = await usageTotalForRun(paths, runId);
        if (callTotal > limits.tokens_per_call || runTotal > limits.tokens) {
          const which = callTotal > limits.tokens_per_call ? "per_call" : "per_run";
          await writeBoundedState(paths, runtimeState, {
            writer_model: writerModel, status: "token_limit", session_id: sessionId, call, updated_at: new Date().toISOString(),
            token_limit: which, token_limit_role: "reviewer", tokens_this_call: callTotal, tokens_this_run: runTotal,
            review_path: latestReviewPath, writer_stdout_path: stdoutPath,
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
      // Bridge decides every sealed condition from the records; the reviewer's PASS alone does not
      // deliver. A condition that is not proven stops the run for the human instead of passing.
      const sealedContract = afterReview.contract?.contract || null;
      const rows = sealedContract && !ownOutcome.controller_decided
        ? acceptanceRows({ contract: sealedContract, writer: writerResult, review: reviewResult, test: testResult, reviewVersion })
        : [];
      const accepted = rows.length ? decideAcceptance(rows) : null;
      if (rows.length) await recordIo(paths, runId, { event: "acceptance", call, decision: accepted, review_version: reviewVersion, rows });
      if (reviewResult.gate === "PASS" && accepted && accepted !== "proven") {
        await writeBoundedState(paths, runtimeState, {
          writer_model: writerModel, status: "acceptance_unverified", session_id: sessionId, call, updated_at: new Date().toISOString(),
          ...(testResult ? { test_passed: testResult.kind === "command" ? testResult.passed : null } : {}),
          review_gate: reviewResult.gate, review_path: latestReviewPath, writer_stdout_path: stdoutPath,
        });
        await recordIo(paths, runId, { event: "stop", status: "acceptance_unverified", role: "controller", provider: null, detail_ref: "acceptance" });
        await consumeAuthorization(paths, control, "acceptance_unverified");
        return 0;
      }
      // Out-of-scope changes Bridge could not attribute (another run's record, a human edit, a commit
      // between calls) are never delivered as passed; the human judges them. No run is named.
      const scopeInDoubt = ownOutcome.review_input?.work_proof?.scope_unverified || [];
      if (reviewResult.gate === "PASS" && scopeInDoubt.length) {
        await writeBoundedState(paths, runtimeState, { ...proofState, status: "scope_unverified", updated_at: new Date().toISOString(), scope_unverified: scopeInDoubt, review_gate: reviewResult.gate, review_path: latestReviewPath });
        await recordIo(paths, runId, { event: "stop", status: "scope_unverified", role: "controller", provider: null, detail_ref: "scope" });
        await consumeAuthorization(paths, control, "scope_unverified");
        return 0;
      }
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
        ...(testResult ? { test_passed: testResult.kind === "command" ? testResult.passed : null } : {}),
        ...gate,
        review_path: latestReviewPath,
        writer_stdout_path: stdoutPath,
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
      if (call >= rounds) {
        await writeBoundedState(paths, runtimeState, {
          writer_model: writerModel,
          status: "rounds_exhausted",
          session_id: sessionId,
          call,
          updated_at: new Date().toISOString(),
          ...(testResult ? { test_passed: testResult.kind === "command" ? testResult.passed : null } : {}),
          ...gate,
          review_path: latestReviewPath,
          writer_stdout_path: stdoutPath,
          failure: failureSummary(budgetStop({ phase: "correction", maxCalls: rounds })),
        });
        await consumeAuthorization(paths, control, "rounds_exhausted", gate);
        return 76;
      }

      currentControl = await loadLiveControl(paths, runtimeState);
      currentControl.runtime_state = runtimeState;
      if (!sameAuthorization(currentControl, control)) {
        throw new Error("Work package authorization was cancelled before correction.");
      }
      await runtimeState.incrementIteration();
    }
    await consumeAuthorization(paths, control, "rounds_exhausted");
    return 76;
  } catch (error) {
    // RC3-BLOCKER-01 step 4: the database is the one record; a run that cannot write to it stops here
    // and calls no model after this. Its stop is kept beside its files until the database is back.
    if (error instanceof DatabaseUnavailableError) {
      await recordIo(paths, runtimeState.runId, { event: "stop", status: "database_unavailable", role: "controller", provider: null, detail_ref: "database" }).catch(() => {});
      await stopRunRecord(paths, runtimeState.runId, { closedReason: "database_unavailable" }).catch(() => {});
      return UNAVAILABLE_EXIT;
    }
    // The change list for the review cannot be read: no review without it, the run fails here.
    if (error instanceof EvidenceUnavailableError) {
      await recordIo(paths, runtimeState.runId, { event: "stop", status: "evidence_unavailable", role: "controller", provider: null, detail_ref: "delta" });
      await consumeAuthorization(paths, control, "evidence_unavailable");
      return UNAVAILABLE_EXIT;
    }
    if (await runStopped(paths, runtimeState.runId)) return 130;
    const currentState = await runtimeState.getState().catch(() => null);
    const stateBelongsToThisInvocation = Boolean(validation) && currentState?.session_id === validation.session_id
      && Number.isFinite(Date.parse(currentState?.updated_at))
      && Date.parse(currentState.updated_at) >= invocationStartedAt;
    const liveControl = await loadLiveControl(paths, runtimeState).catch(() => null);
    const authorizationStillActive = liveControl && sameAuthorization(liveControl, control);
    if (!stateBelongsToThisInvocation && authorizationStillActive) {
      await writeBoundedState(paths, runtimeState, {
        status: "controller_failure",
        writer_model: validation?.model ?? writerModelFor(control),
        session_id: validation?.session_id ?? String(control.active_writer_session),
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
