// The model calls between the human starting the work and the writer's first call, all named in
// the plan the human approved: the writer's provider translates the sealed work-order text (no
// tools), code checks the result, the reviewer's provider reads it against the full text in its
// own read-only session, and only then is the contract sealed. A translation mistake is sent back
// to the writer a bounded number of times; a real ambiguity or anything the reviewer cannot
// confirm stops the run for the human. There is no second human approval.
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  appendIoEvent,
  classifyProviderFailure,
  codexDiagnosticTrailer,
  readEvidenceTail,
  runProcess,
  tokenTotal,
  usageTotalForRun,
  writeFailureRecord,
  writeJson,
  writeText,
} from "../../service/index.mjs";
import { digest } from "../../utils/digest.mjs";
import { failureSummary } from "./budget.mjs";
import { callStamp, killStartedAfterStop } from "./processRecords.mjs";
import {
  buildContract,
  checkTranslation,
  composeCheckPrompt,
  composeTranslationPrompt,
  CONTRACT_CHECK_SCHEMA,
  CONTRACT_TRANSLATION_SCHEMA,
  decideCheck,
  numberedLines,
  sealContract,
  TRANSLATION_MAX_TURNS,
} from "./contract.mjs";
import { resolveLocale } from "./i18n.mjs";
import { loadSchema, parseCodexJsonl, reviewerUsageEvent, writerResultFromClaudeResult } from "./typedResults.mjs";
import { parseClaudeStream, partialUsageFromStream, usageFromResult } from "./writerPrompt.mjs";

// Until roles are honored everywhere (RC3-BLOCKER-02), each contract step has one provider that a
// native run can actually call; any other configured provider is refused before a call is made.
// The fake CLI stands in for every provider, so a fake run is not refused.
const CALLABLE_PROVIDER = Object.freeze({ translate: "claude", check: "codex" });

export function unsupportedContractStep(steps) {
  if (steps.translate.provider !== CALLABLE_PROVIDER.translate) return "The writer role is " + steps.translate.provider + "; only claude can translate a work order in this version.";
  if (steps.check.provider !== CALLABLE_PROVIDER.check) return "The reviewer role is " + steps.check.provider + "; only codex can check a translation in this version.";
  return null;
}

// A provider failure is reported as one, like the writer's or reviewer's own.
async function providerStop({ paths, stamp, role, provider, phase, processResult, texts, evidence }) {
  const classified = classifyProviderFailure({ role, provider, phase, exitCode: processResult.exitCode, timedOut: processResult.timedOut, texts });
  const written = await writeFailureRecord(paths, paths.queueRoot, stamp + "-" + phase, classified, evidence);
  const status = processResult.timedOut ? (role === "translator" ? "writer_timeout" : "reviewer_failed")
    : classified.reason === "provider_usage_limit" ? "rate_limited"
      : role === "translator" ? "writer_failed" : "reviewer_failed";
  return { status, detail: classified.reason, failure: failureSummary(classified, written.record_path) };
}

// The same ceilings the writer and reviewer are held to, checked before anything else starts.
// Usage Bridge could not read is not zero: the ceiling cannot be shown to hold, so the run stops.
async function ceilingStop({ paths, runId, usage, limits }) {
  if (usage.parse_error || usage.partial) return { status: "usage_unknown", detail: usage.role, token_limit_role: usage.role, missing: usage.missing || [] };
  const callTotal = tokenTotal(usage.tokens);
  const runTotal = await usageTotalForRun(paths, runId);
  if (callTotal <= limits.tokens_per_call && runTotal <= limits.tokens) return null;
  const which = callTotal > limits.tokens_per_call ? "per_call" : "per_run";
  return { status: "token_limit", detail: which, token_limit: which, token_limit_role: usage.role, tokens_this_call: callTotal, tokens_this_run: runTotal };
}

async function translateOnce({ paths, runId, workPackage, adapter, steps, lines, locale, attempt, feedback, effort, onSpawn }) {
  const prompt = composeTranslationPrompt({ workPackageId: workPackage.work_package_id, lines, test: workPackage.test, locale, attempt, feedback });
  const stamp = callStamp(runId);
  const streamPath = path.join(paths.queueRoot, stamp + "-contract.stream.jsonl");
  const stderrPath = path.join(paths.queueRoot, stamp + "-contract.stderr.log");
  await writeText(path.join(paths.queueRoot, stamp + "-contract-prompt.txt"), prompt);
  const executable = await adapter.resolveExecutable("claude");
  const args = [
    "-p",
    "--session-id", randomUUID(),
    // No tool exists in this session: the work order is in the prompt and nothing is written.
    "--tools", "",
    // A model of null leaves the choice to the CLI.
    ...(steps.translate.model ? ["--model", steps.translate.model] : []),
    "--effort", effort,
    "--max-turns", String(TRANSLATION_MAX_TURNS),
    "--output-format", "stream-json",
    "--verbose",
    "--json-schema", JSON.stringify(await loadSchema(CONTRACT_TRANSLATION_SCHEMA)),
  ];
  const startedAt = Date.now();
  const processResult = await runProcess({
    invocation: adapter.buildInvocation("claude", executable, args), cwd: paths.repoRoot, input: prompt,
    stdoutPath: streamPath, stderrPath, timeoutMs: steps.call_timeout, onSpawn,
  });
  const stream = parseClaudeStream(await fsp.readFile(streamPath, "utf8").catch(() => ""));
  const durationMs = Date.now() - startedAt;
  const usage = { ...(stream.result && !processResult.timedOut
    ? usageFromResult(stream.result, { call: 0, durationMs })
    : partialUsageFromStream(stream.streamUsage, { call: 0, durationMs })), role: "translator", attempt };
  await appendIoEvent(paths, runId, usage);
  if (processResult.timedOut || !stream.result || stream.result.is_error === true || processResult.exitCode !== 0) {
    return { usage, stop: await providerStop({
      paths, stamp, role: "translator", provider: "claude", phase: "translate", processResult,
      texts: [String(stream.result?.result || ""), await readEvidenceTail(stderrPath)], evidence: { stdout_path: streamPath, stderr_path: stderrPath },
    }) };
  }
  const translation = writerResultFromClaudeResult(stream.result);
  const resultPath = path.join(paths.queueRoot, stamp + "-contract.result.json");
  await writeJson(resultPath, translation);
  return { usage, translation, resultPath };
}

async function checkOnce({ paths, runId, workPackage, adapter, steps, lines, candidate, sha256, locale, attempt, effort, model, onSpawn }) {
  const prompt = composeCheckPrompt({ workPackageId: workPackage.work_package_id, lines, candidate, sha256, locale, attempt });
  const stamp = callStamp(runId);
  const stdoutPath = path.join(paths.queueRoot, stamp + "-contract-check.stdout.log");
  const stderrPath = path.join(paths.queueRoot, stamp + "-contract-check.stderr.log");
  const resultPath = path.join(paths.queueRoot, stamp + "-contract-check.result.json");
  await writeText(path.join(paths.queueRoot, stamp + "-contract-check-prompt.txt"), prompt);
  const executable = await adapter.resolveExecutable("codex");
  // The reviewer's own read-only, throwaway session, never the writer's.
  const args = [
    "--ask-for-approval", "never",
    "-c", "model_reasoning_effort=\"" + effort + "\"",
    ...(model ? ["--model", model] : []),
    // A project without Git still gets a contract (Owner 2026-10-17); Codex otherwise refuses any
    // folder that is not a trusted Git repository. The session stays read-only and writes nothing.
    "exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--cd", paths.repoRoot,
    "--output-schema", CONTRACT_CHECK_SCHEMA, "--json", "--output-last-message", resultPath, "-",
  ];
  const startedAt = Date.now();
  const processResult = await runProcess({
    invocation: adapter.buildInvocation("codex", executable, args), cwd: paths.repoRoot, input: prompt,
    stdoutPath, stderrPath, timeoutMs: steps.call_timeout, onSpawn,
  });
  const stream = parseCodexJsonl(await fsp.readFile(stdoutPath, "utf8").catch(() => ""));
  const usage = { ...reviewerUsageEvent({ usage: stream.usage, trailerTokens: null, call: 0, durationMs: Date.now() - startedAt }), role: "contract_checker", attempt };
  await appendIoEvent(paths, runId, usage);
  const text = await fsp.readFile(resultPath, "utf8").catch(() => "");
  if (processResult.timedOut || processResult.exitCode !== 0 || !text.trim()) {
    return { usage, stop: await providerStop({
      paths, stamp, role: "contract_checker", provider: "codex", phase: "contract_check", processResult,
      texts: [codexDiagnosticTrailer(await readEvidenceTail(stderrPath))], evidence: { stdout_path: stdoutPath, stderr_path: stderrPath },
    }) };
  }
  let answer = null;
  try { answer = JSON.parse(text); } catch { answer = null; }
  return { usage, answer, resultPath };
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

// Returns { status: "sealed", sha256 } or { status, ... } for the run to stop with. The stop
// state is read before every model call and again once each call has its pid, retries included.
// `effort` and `model` are the reviewer's and `translateEffort` the writer's, from the policy's
// priority table; a model of null leaves the choice to the CLI.
export async function establishContract({ paths, runId, workPackage, adapter, limits, effort, model = null, translateEffort, executionMode, isStopped, onSpawn }) {
  const steps = workPackage.contract_steps;
  const unsupported = executionMode === "fake_cli" ? null : unsupportedContractStep(steps);
  if (unsupported) return { status: "policy_failure", detail: "unsupported_role", problems: [unsupported] };
  const lines = numberedLines(workPackage.task);
  const locale = await resolveLocale(paths);
  const stopped = { status: "stopped", detail: "stopped around a contract call" };
  const translatorSpawn = guardedSpawn({ onSpawn, isStopped, role: "translator", provider: steps.translate.provider });
  const checkerSpawn = guardedSpawn({ onSpawn, isStopped, role: "contract_checker", provider: steps.check.provider });
  let feedback = [];
  let lastProblems = [];
  for (let attempt = 1; attempt <= steps.max_attempts; attempt += 1) {
    if (await isStopped()) return stopped;
    const translated = await translateOnce({ paths, runId, workPackage, adapter, steps, lines, locale, attempt, feedback, effort: translateEffort, onSpawn: translatorSpawn });
    if (await isStopped()) return stopped;
    if (translated.stop) return translated.stop;
    const overTranslation = await ceilingStop({ paths, runId, usage: translated.usage, limits });
    if (overTranslation) return overTranslation;
    const checked = await checkTranslation(translated.translation, { lines, test: workPackage.test });
    await appendIoEvent(paths, runId, {
      event: "contract.translation", attempt, ok: checked.ok, problems: checked.problems.slice(0, 20), questions: checked.questions, result_path: translated.resultPath,
    });
    if (!checked.ok) {
      lastProblems = checked.problems;
      feedback = checked.problems.slice(0, 20);
      continue;
    }
    if (checked.questions.length) return { status: "needs_human", detail: "open_questions", questions: checked.questions };
    const candidate = buildContract({
      workPackage, lines, translation: translated.translation,
      translator: { role: "writer", provider: steps.translate.provider, model: steps.translate.model, attempt },
      checker: { role: "reviewer", provider: steps.check.provider },
    });
    const sha256 = digest(candidate);
    if (await isStopped()) return stopped;
    const review = await checkOnce({ paths, runId, workPackage, adapter, steps, lines, candidate, sha256, locale, attempt, effort, model, onSpawn: checkerSpawn });
    if (await isStopped()) return stopped;
    if (review.stop) return review.stop;
    const overCheck = await ceilingStop({ paths, runId, usage: review.usage, limits });
    if (overCheck) return overCheck;
    const decided = await decideCheck(review.answer, { candidate, sha256 });
    await appendIoEvent(paths, runId, {
      event: "contract.check", attempt, candidate_sha256: sha256, decision: decided.decision,
      problems: decided.problems.slice(0, 20), feedback: decided.feedback.slice(0, 20), questions: decided.questions, result_path: review.resultPath,
    });
    if (decided.decision === "needs_human") return { status: "needs_human", detail: "ambiguous_work_order", questions: decided.questions };
    if (decided.decision === "unconfirmed") return { status: "contract_unconfirmed", detail: decided.problems[0], problems: decided.problems };
    if (decided.decision === "retranslate") {
      lastProblems = decided.feedback;
      feedback = decided.feedback;
      continue;
    }
    const sealed = await sealContract(paths, candidate);
    await appendIoEvent(paths, runId, { event: "contract.sealed", contract_sha256: sealed.sha256, attempt });
    return { status: "sealed", sha256: sealed.sha256 };
  }
  return { status: "contract_rejected", detail: lastProblems[0] || "translation refused", problems: lastProblems };
}
