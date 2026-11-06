// The model calls between the person's yes and the writer's first call, all named in
// the card the person said yes to: Bridge splits the sealed work order into its marked blocks, the
// writer's provider cuts the acceptance blocks into conditions (no write access), code checks them, the
// reviewer's provider reads them against those blocks in its own read-only session, and only then
// is the contract sealed. A work order that lists open questions stops before any model call; one that
// states no acceptance has nothing to cut, so the reviewer proposes some. A translation mistake is sent
// back to the writer a bounded number of times, and an answer in the wrong shape is asked of the reviewer
// again under the same count. A question only the human can answer, or anything the reviewer cannot
// confirm, comes back to whoever called: a start asks the person before any run exists (gather.mjs); the
// low-level work-start closes its run on it. Which of them is calling is its `trail`.
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  appendIoEvent,
  callRole,
  classifyProviderFailure,
  tokenTotal,
  usageTotalForRun,
  writeFailureRecord,
  writeText,
} from "../../service/index.mjs";
import { digest } from "../../utils/digest.mjs";
import { failureSummary } from "./budget.mjs";
import { callStamp, callTimeLeft, killStartedAfterStop } from "./processRecords.mjs";
import {
  buildContract,
  checkTranslation,
  composeCheckPrompt,
  composeTranslationPrompt,
  CONTRACT_CHECK_SCHEMA,
  CONTRACT_TRANSLATION_SCHEMA,
  decideCheck,
  sealContract,
  TRANSLATION_MAX_TURNS,
  workOrderQuestions,
} from "./contract.mjs";
import { parseWorkOrder } from "./workOrderFormat.mjs";

// A provider failure is reported as one, like the writer's or reviewer's own.
async function providerStop({ paths, trail, stamp, role, provider, phase, processResult, texts, evidence }) {
  const classified = classifyProviderFailure({ role, provider, phase, exitCode: processResult.exitCode, timedOut: processResult.timedOut, code: processResult.failureCode, texts });
  const written = await writeFailureRecord(paths, trail.logs, stamp + "-" + phase, classified, evidence);
  const status = processResult.timedOut ? (role === "translator" ? "writer_timeout" : "reviewer_failed")
    : classified.reason === "provider_usage_limit" ? "rate_limited"
      : role === "translator" ? "writer_failed" : "reviewer_failed";
  return { status, detail: classified.reason, failure: failureSummary(classified, written.record_path) };
}

// The same ceilings the writer and reviewer are held to, checked before anything else starts.
// Usage Bridge could not read is not zero: the ceiling cannot be shown to hold, so the run stops.
async function ceilingStop({ trail, usage, limits }) {
  if (usage.parse_error || usage.partial) return { status: "usage_unknown", detail: usage.role, token_limit_role: usage.role, missing: usage.missing || [] };
  const callTotal = tokenTotal(usage.tokens);
  const runTotal = await trail.usageTotal();
  if (callTotal <= limits.tokens_per_call && runTotal <= limits.tokens) return null;
  const which = callTotal > limits.tokens_per_call ? "per_call" : "per_run";
  return { status: "token_limit", detail: which, token_limit: which, token_limit_role: usage.role, tokens_this_call: callTotal, tokens_this_run: runTotal };
}

async function translateOnce({ paths, trail, workPackage, adapter, steps, lines, format, attempt, feedback, effort, onSpawn }) {
  // The call's own limit, cut to what is left of the run's time; nothing is left: no call.
  const timeoutMs = await trail.timeLeft(steps.call_timeout);
  if (timeoutMs === null) return { timedOut: true };
  const prompt = composeTranslationPrompt({ workPackageId: workPackage.work_package_id, lines, format, test: workPackage.test, attempt, feedback });
  const stamp = callStamp(trail.id);
  const { logs } = trail;
  const streamPath = path.join(logs, stamp + "-contract.stream.jsonl");
  const stderrPath = path.join(logs, stamp + "-contract.stderr.log");
  const resultPath = path.join(logs, stamp + "-contract.result.json");
  await writeText(path.join(logs, stamp + "-contract-prompt.txt"), prompt);
  const provider = steps.translate.provider;
  // The work order is in the prompt and nothing is written: no access, as far as the provider can take it away.
  const called = await callRole(provider, {
    adapter, access: "none", role: "translator", prompt, schemaPath: CONTRACT_TRANSLATION_SCHEMA, model: steps.translate.model, effort, cwd: paths.repoRoot,
    sessionId: randomUUID(), maxTurns: TRANSLATION_MAX_TURNS, mcpOff: workPackage.writer?.mcp_off, stdoutPath: streamPath, stderrPath, answerPath: resultPath, timeoutMs, onSpawn,
  });
  const usage = { ...called.usage, attempt };
  await trail.record(usage);
  if (called.failed) {
    return { usage, stop: await providerStop({
      paths, trail, stamp, role: "translator", provider, phase: "translate", processResult: called,
      texts: await called.failureTexts(), evidence: { stdout_path: streamPath, stderr_path: stderrPath },
    }) };
  }
  // The same judgement as the reviewer's probe, by the session's own init event: a translation holds
  // the work order's text, and a session that also holds a connector's tools is not used. The call has
  // already ended by then, so this stops its answer, not the call. A CLI that lists no tools says nothing.
  const held = called.mcpToolsHeld;
  if (held === null || held?.length) {
    const named = held === null ? "and its stream did not show which tools it held" : "(" + held.slice(0, 5).join(", ") + (held.length > 5 ? ", and " + (held.length - 5) + " more" : "") + ")";
    return { usage, stop: { status: "policy_failure", detail: "translation_tools", problems: [
      "The work order's translation ran in a session that was to hold no MCP tools " + named + ", so Bridge did not use its answer. Nothing was sealed and no work started. Turn those connectors off in " + provider + ", or name another writer with --writer, then start again.",
    ] } };
  }
  return { usage, translation: called.answer, resultPath };
}

async function checkOnce({ paths, trail, workPackage, adapter, steps, lines, format, candidate, sha256, attempt, effort, model, maxTurns, onSpawn }) {
  const timeoutMs = await trail.timeLeft(steps.call_timeout);
  if (timeoutMs === null) return { timedOut: true };
  const prompt = composeCheckPrompt({ workPackageId: workPackage.work_package_id, lines, format, candidate, sha256, attempt });
  const stamp = callStamp(trail.id);
  const { logs } = trail;
  const stdoutPath = path.join(logs, stamp + "-contract-check.stdout.log");
  const stderrPath = path.join(logs, stamp + "-contract-check.stderr.log");
  const resultPath = path.join(logs, stamp + "-contract-check.result.json");
  await writeText(path.join(logs, stamp + "-contract-check-prompt.txt"), prompt);
  const provider = steps.check.provider;
  // The reviewer's own read-only, throwaway session, never the writer's.
  const called = await callRole(provider, {
    adapter, access: "read", role: "contract_checker", prompt, schemaPath: CONTRACT_CHECK_SCHEMA, model, effort, cwd: paths.repoRoot, maxTurns,
    mcp: workPackage.reviewer?.mcp, mcpOff: workPackage.reviewer?.mcp_off,
    stdoutPath, stderrPath, answerPath: resultPath, timeoutMs, onSpawn,
  });
  const usage = { ...called.usage, attempt };
  await trail.record(usage);
  if (called.failed) {
    return { usage, stop: await providerStop({
      paths, trail, stamp, role: "contract_checker", provider, phase: "contract_check", processResult: called,
      texts: await called.failureTexts(), evidence: { stdout_path: stdoutPath, stderr_path: stderrPath },
    }) };
  }
  return { usage, answer: called.answer, resultPath };
}

// The calling side of the stop protocol: `stop` marks the run stopped and only then reads the
// recorded pid, while each call here records its pid and then reads the status. Whichever side
// comes second sees the other, so a call started around a stop is killed by one side or the other.
function guardedSpawn({ onSpawn, isStopped, role, provider }) {
  return async (pid) => {
    await onSpawn(pid, role, provider);
    if (await isStopped()) await killStartedAfterStop(pid);
  };
}

// Where a run's translation leaves its records: its log folder and its events, under its deadline.
export const runTrail = (paths, runId) => ({
  id: runId,
  logs: paths.runLogDir(runId),
  record: (event) => appendIoEvent(paths, runId, event),
  usageTotal: () => usageTotalForRun(paths, runId),
  timeLeft: (timeoutMs) => callTimeLeft(paths, runId, timeoutMs),
});

// Returns { status: "sealed", sha256 } or { status, ... } for the run to stop with. The stop
// state is read before every model call and again once each call has its pid, retries included.
// `effort` and `model` are the reviewer's and `translateEffort` the writer's, from the policy's
// priority table; a model of null leaves the choice to the CLI.
export async function establishContract({ paths, trail, workPackage, adapter, limits, effort, model = null, translateEffort, isStopped, onSpawn }) {
  const steps = workPackage.contract_steps;
  // The same split the plan made; the human answers what the work order leaves open, not a model.
  const format = parseWorkOrder(workPackage.task);
  const { lines } = format;
  const questions = workOrderQuestions(format);
  if (questions.length) return { status: "needs_human", detail: "open_questions", questions };
  const stopped = { status: "stopped", detail: "stopped around a contract call" };
  const translatorSpawn = guardedSpawn({ onSpawn, isStopped, role: "translator", provider: steps.translate.provider });
  const checkerSpawn = guardedSpawn({ onSpawn, isStopped, role: "contract_checker", provider: steps.check.provider });
  const clarify = workPackage.clarify || null;
  const proposing = !format.acceptance.length;
  const translator = (attempt) => ({ role: "writer", provider: steps.translate.provider, model: steps.translate.model, attempt });
  const checker = { role: "reviewer", provider: steps.check.provider };
  let feedback = [];
  let lastProblems = [];
  // The candidate of an answer in the wrong shape: the fault is the reviewer's, so the writer is not
  // called again and gets no feedback about it.
  let unchecked = null;
  for (let attempt = 1; attempt <= steps.max_attempts; attempt += 1) {
    if (await isStopped()) return stopped;
    let candidate = unchecked;
    if (!candidate && proposing) candidate = buildContract({ workPackage, lines, format, translation: { acceptance: [] }, translator: translator(attempt), checker });
    if (!candidate) {
      const translated = await translateOnce({ paths, trail, workPackage, adapter, steps, lines, format, attempt, feedback, effort: translateEffort, onSpawn: translatorSpawn });
      if (await isStopped() || translated.timedOut) return stopped;
      if (translated.stop) return translated.stop;
      const overTranslation = await ceilingStop({ trail, usage: translated.usage, limits });
      if (overTranslation) return overTranslation;
      const checked = await checkTranslation(translated.translation, { lines, format, test: workPackage.test });
      await trail.record({
        event: "contract.translation", attempt, ok: checked.ok, problems: checked.problems.slice(0, 20), result_path: translated.resultPath,
      });
      if (!checked.ok) {
        lastProblems = checked.problems;
        feedback = checked.problems.slice(0, 20);
        continue;
      }
      candidate = buildContract({ workPackage, lines, format, translation: translated.translation, translator: translator(attempt), checker });
    }
    const sha256 = digest(candidate);
    if (await isStopped()) return stopped;
    const review = await checkOnce({ paths, trail, workPackage, adapter, steps, lines, format, candidate, sha256, attempt, effort, model, maxTurns: limits.max_turns, onSpawn: checkerSpawn });
    if (await isStopped() || review.timedOut) return stopped;
    if (review.stop) return review.stop;
    const overCheck = await ceilingStop({ trail, usage: review.usage, limits });
    if (overCheck) return overCheck;
    const decided = await decideCheck(review.answer, {
      candidate, sha256, lineCount: lines.length, proposing, clarify,
      maxQuestions: limits.clarify_questions, lookupHeld: Boolean(workPackage.reviewer?.mcp?.length),
    });
    await trail.record({
      event: "contract.check", attempt, candidate_sha256: sha256, decision: decided.decision,
      problems: decided.problems.slice(0, 20), feedback: decided.feedback.slice(0, 20), questions: decided.questions.map((entry) => entry.question), result_path: review.resultPath,
    });
    if (decided.decision === "malformed") {
      unchecked = candidate;
      lastProblems = decided.problems;
      continue;
    }
    unchecked = null;
    if (decided.decision === "needs_human") {
      // Every round was asked and it still cannot be settled: the record of them goes to the person.
      if (clarify && clarify.round > limits.clarify_rounds) return { status: "needs_human", detail: "clarify_rounds", clarify_exhausted: true };
      return { status: "needs_human", detail: "ambiguous_work_order", clarify_questions: decided.questions };
    }
    if (decided.decision === "unconfirmed") return { status: "contract_unconfirmed", detail: decided.problems[0], problems: decided.problems };
    if (decided.decision === "retranslate") {
      lastProblems = decided.feedback;
      feedback = decided.feedback;
      continue;
    }
    // What the reviewer checked is the candidate; the assumptions are its own answer, so the sealed hash
    // differs from the candidate's when there are any, and the event names both.
    const sealed = await sealContract(paths, { ...candidate, assumptions: decided.assumptions });
    await trail.record({ event: "contract.sealed", contract_sha256: sealed.sha256, candidate_sha256: sha256, attempt });
    return { status: "sealed", sha256: sealed.sha256 };
  }
  // The reviewer's answer never came in the right shape: as when it says it cannot confirm.
  if (unchecked) return { status: "contract_unconfirmed", detail: lastProblems[0], problems: lastProblems };
  return { status: "contract_rejected", detail: lastProblems[0] || "translation refused", problems: lastProblems };
}
