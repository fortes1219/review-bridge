// The gathering (RC3-ASK-01, Owner 2026-11-06): every work order of a start is turned into a contract before
// any work, and outside any run. The first card's yes pays for the model calls; each work order is translated
// and checked, every question goes to the person at once, the answers are written back, and only what was
// answered is translated again, with no yes between rounds, until each is sealed. A second card names the
// contracts, and only its yes opens runs. Terraform's plan and apply are the shape: all the asking and the
// planning before the approve, and nothing asked after it. Where it differs: planning here costs model calls,
// so a yes comes first, and a plan is kept in a table of its own (2026-11-06-1000-contract-gatherings.sql),
// which nothing else does and is Bridge's own invention. A work order that cannot be sealed stops everything
// from working: nothing runs until every one is.
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";

import { appendIoEvent, killProcessTree, loadOrCreatePolicySnapshot, SIGN_IN_COMMANDS, tokenTotal } from "../../service/index.mjs";
import { digest } from "../../utils/digest.mjs";
import { askAnswers, exhaustedLines, nextClarify, questionLines, writeAnswers, yellow } from "./clarify.mjs";
import { loadContract } from "./contract.mjs";
import { establishContract } from "./translation.mjs";
import {
  closeGathering, gatheringFolderOf, openGatherings, recordCard, recordContract, recordGatheringEvent, sealedGathering, takeGatheringEvents,
} from "./workOrderRecords.mjs";
import { sealPlan } from "./workPackage.mjs";
import { CONTRACT_EXIT_CODES, effectiveLimits } from "./writerLoop.mjs";

const write = (line) => process.stdout.write(line + "\n");

// What besides the work order's text decides its contract: the same text under the same settings is the
// same contract, and is not paid for twice.
export function settingsOf(plan) {
  const role = ({ provider, model, effort, mcp, mcp_off: mcpOff }) => ({ provider, model, effort, mcp: mcp ?? null, mcp_off: mcpOff ?? null });
  return digest({
    work_package_id: plan.work_package_id,
    task_file: plan.task_file,
    test: plan.test ?? null,
    contract_steps: plan.contract_steps ?? null,
    writer: role(plan.writer),
    reviewer: role(plan.reviewer),
    effective_policy_sha256: plan.effective_policy_sha256,
  });
}

// The sealed contract this plan can use as it is, or null. Its file is what a run will read, so one that no
// longer reads back is as good as none: it is translated again.
export async function sealedContractOf(db, paths, plan) {
  const workOrderId = plan.work_order?.work_order_id;
  if (!workOrderId) return null;
  const row = await sealedGathering(db, { workOrderId, contentSha256: plan.task_sha256, settingsSha256: settingsOf(plan) });
  if (!row) return null;
  return await loadContract(paths, row.contract_sha256).then(() => row, () => null);
}

export async function askYes(question) {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(?:es)?$/i.test((await terminal.question(question)).trim());
  } finally {
    terminal.close();
  }
}

// Who said the first yes, and how.
export const yesOf = (via) => ({ by: os.userInfo().username, via, at: new Date().toISOString() });

// Provider words a stop came with that the next work order would die of too; a person's stop; or null.
export function stopOfRun(run) {
  const failure = run?.last_state?.failure;
  if (failure?.reason === "provider_signed_out") return { kind: "signed_out", provider: failure.provider };
  if (failure?.reason === "provider_usage_limit") return { kind: "usage_limit", provider: failure.provider, resetHint: failure.reset_hint };
  return run?.closed_reason === "stopped" ? { kind: "stopped" } : null;
}

// Playwright's SigIntWatcher: the first signal is a request to stop; the handler goes after a second, so
// the next Ctrl+C ends the process at once, and a package runner's duplicate of the first does not.
export function interruptWatcher(onInterrupt) {
  let had = false;
  let timer = null;
  const handler = () => {
    if (had) return;
    had = true;
    timer = setTimeout(disarm, 1_000);
    onInterrupt();
  };
  function disarm() {
    clearTimeout(timer);
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  }
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return { hadSignal: () => had, disarm };
}

export function stoppedLine(stop, position, notRun) {
  const rest = notRun.length ? "; " + notRun.join(", ") + " did not run" : "";
  const again = "run start on this directory again: only what is pending runs.";
  if (stop.kind === "signed_out") return "Stopped at step " + position + ": " + stop.provider + " needs signing in again (" + SIGN_IN_COMMANDS[stop.provider] + ")" + rest + ". After signing in, " + again;
  if (stop.kind === "usage_limit") return "Stopped at step " + position + ": " + stop.provider + " is out of quota" + (stop.resetHint ? " until " + stop.resetHint : "") + rest + ". When it is back, " + again;
  return "Stopped at step " + position + rest + ". To carry on, " + again;
}

// The one model-free moment before a model call of this command: the reviewer's read-only check and the
// gate, once a process, and this machine's adapter only after them. Null when the check refused.
export function readiness({ options, adapter, loadAdapter, guard, reviewerCheck, plan, again, checkFailureLines }) {
  let ready = null;
  return async () => {
    if (ready) return ready;
    if (options.fakeCli) {
      write("Reviewer read-only check: not needed with the fake CLI (no model is called)");
    } else {
      const check = await reviewerCheck({
        reviewer: plan.reviewer.provider,
        mcp: { off: plan.reviewer.mcp_off, allow: plan.reviewer.mcp },
        onStart: (reviewer) => write("Checking that the reviewer (" + reviewer + ") cannot write files: one model call..."),
      });
      if (!check.ok) {
        for (const line of checkFailureLines(check, again)) write(line);
        return null;
      }
      write("Reviewer read-only check: passed" + (check.already ? " (earlier in this page session)" : ""));
    }
    await guard(plan.reviewer.provider, { off: plan.reviewer.mcp_off, allow: plan.reviewer.mcp });
    ready = { adapter: adapter || await loadAdapter() };
    return ready;
  };
}

// One work order, once: its records are the gathering's, and the budget is the plan's.
async function translate({ paths, records, plan, adapter, isStopped, onSpawn }) {
  const { snapshot } = await loadOrCreatePolicySnapshot(paths);
  const limits = effectiveLimits({ run: { policy_snapshot: snapshot, work_package: plan } });
  let sequence = 0;
  let spent = 0;
  const trail = {
    id: plan.proposed_run_id,
    logs: paths.runLogDir(plan.proposed_run_id),
    record: async (event) => {
      if (event.event === "usage") spent += tokenTotal(event.tokens);
      sequence += 1;
      await recordGatheringEvent(records.db, { planSha256: plan.plan_sha256, sequence, event });
    },
    usageTotal: async () => spent,
    // No run, so no run's deadline to cut it to.
    timeLeft: async (timeoutMs) => timeoutMs,
  };
  const outcome = await establishContract({
    paths, trail, workPackage: plan, adapter, limits, isStopped, onSpawn,
    effort: plan.reviewer.effort, model: plan.reviewer.model ?? null, translateEffort: plan.writer.effort,
  });
  return { outcome, limits };
}

// A run opened on a gathered contract keeps how that contract was made, as if it had been made inside the
// run: its events in the run's record, and the calls' prompts and answers in the run's log folder, where
// `logs <run_id>` and clean look. Bounded by that one gathering. The folder they came from stays: another run
// may open on the same contract.
export async function runTakesGathering({ paths, db, planSha256, runId }) {
  for (const event of await takeGatheringEvents(db, planSha256)) await appendIoEvent(paths, runId, event);
  const from = paths.runLogDir(await gatheringFolderOf(db, planSha256));
  for (const name of await fsp.readdir(from).catch(() => [])) {
    if (name.includes("-contract")) await fsp.copyFile(path.join(from, name), path.join(paths.runLogDir(runId), name));
  }
}

// Why a work order did not come to a contract, in the words its result would have used.
function whyLines(t, plan, outcome, limits) {
  const { status, problems = [], questions = [], failure } = outcome;
  if (outcome.clarify_exhausted) return exhaustedLines(t, plan.clarify?.history);
  if (status === "needs_human") return [t("result.why.contract.questions"), ...questions.map((question) => "- " + question)];
  if (status === "contract_unconfirmed") return [t("result.why.contract.unconfirmed"), ...problems.slice(0, 10).map((line) => "- " + line)];
  if (status === "rate_limited") {
    return [
      t("result.why.quota", { role: t("result.tokens.role." + (failure?.role || "writer")), provider: failure?.provider || "" }),
      ...(failure?.reset_hint ? [t("result.why.quota.reset", { hint: failure.reset_hint })] : []),
    ];
  }
  if (status === "usage_unknown") return [t("result.why.usage_unknown", { role: t("result.tokens.role." + (outcome.token_limit_role || "writer")) })];
  if (status === "token_limit") {
    const which = outcome.token_limit === "per_run" ? "per_run" : "per_call";
    return [t("result.why.token_limit", {
      role: t("result.tokens.role." + (outcome.token_limit_role || "writer")), which: t("result.why.token_limit." + which),
      limit: which === "per_run" ? limits.tokens : limits.tokens_per_call, actual: which === "per_run" ? outcome.tokens_this_run : outcome.tokens_this_call,
    })];
  }
  return [
    ...(problems.length ? [t("result.why.contract.problems"), ...problems.slice(0, 10).map((line) => "- " + line)] : []),
    t("result.why.error", { reason: status }),
    ...(failure?.record_path ? [t("result.why.error.log", { path: failure.record_path })] : []),
  ];
}

// Takes every item to a sealed contract. An item is { plan, name, absolute, label, yesPlanSha256, reused }:
// `reused` is the sealed contract it has already. Returns { code } when not all of them got there, with what
// was to be said already said, and { code: null, plans } with the sealed plans, in order, otherwise.
export async function gatherContracts({ t, paths, records, items, yes, adapter, interactive, isLine, answerCommand, planAnswered, inspect = null, planName = null }) {
  const notRun = (from) => items.slice(from).map((_, index) => from + index + 1);
  const open = async (list) => {
    const opened = await openGatherings(records.db, {
      projectId: records.projectId, yes,
      items: list.map(({ plan, yesPlanSha256 }) => ({ plan, settingsSha256: settingsOf(plan), yesPlanSha256 })),
    });
    list.forEach((item, index) => { item.opened = opened[index]; });
  };
  let todo = items.filter((item) => !item.reused);
  if (todo.length) await open(todo);
  const stopped = [];
  while (todo.length) {
    const asked = [];
    let pid = null;
    const watcher = interruptWatcher(() => { if (pid) killProcessTree(pid).catch(() => {}); });
    let hard = null;
    try {
      for (const item of todo) {
        const position = items.indexOf(item) + 1;
        if (watcher.hadSignal()) { hard = { kind: "stopped", position }; break; }
        const signedOut = inspect ? await inspect(item.plan) : null;
        if (signedOut) { hard = { kind: "signed_out", provider: signedOut, position }; break; }
        write(t("gather.translating", { label: item.label }));
        const { outcome, limits } = await translate({
          paths, records, plan: item.plan, adapter,
          isStopped: async () => watcher.hadSignal(),
          onSpawn: async (spawned) => { pid = spawned; },
        });
        pid = null;
        if (outcome.status === "sealed") {
          const contract = await loadContract(paths, outcome.sha256);
          await recordContract(records.db, { workOrderId: item.opened.workOrderId, contentSha256: item.plan.task_sha256, contractSha256: outcome.sha256, contract });
          await closeGathering(records.db, { planSha256: item.plan.plan_sha256, status: "sealed", contractSha256: outcome.sha256 });
          item.sealed = outcome.sha256;
          write(t("gather.sealed", { label: item.label, sha: outcome.sha256.slice(0, 4) }));
          continue;
        }
        if (outcome.status === "needs_human" && outcome.clarify_questions?.length) {
          await closeGathering(records.db, { planSha256: item.plan.plan_sha256, status: "asking", outcome: { questions: outcome.clarify_questions } });
          asked.push({ item, questions: outcome.clarify_questions });
          write(yellow(t("gather.asks", { label: item.label, count: outcome.clarify_questions.length })));
          continue;
        }
        const { status, detail, problems, failure } = outcome;
        await closeGathering(records.db, { planSha256: item.plan.plan_sha256, status: "stopped", outcome: { status, detail, problems: problems ?? null, failure: failure ?? null } });
        if (status === "stopped") { hard = { kind: "stopped", position }; break; }
        write(yellow(t("gather.stopped", { label: item.label })));
        for (const line of whyLines(t, item.plan, outcome, limits)) write(line);
        const providerStop = stopOfRun({ last_state: { failure } });
        if (providerStop) { hard = { ...providerStop, position, status }; break; }
        stopped.push({ item, status });
      }
    } finally {
      watcher.disarm();
    }
    if (hard) {
      if (isLine) write(stoppedLine(hard, hard.position, notRun(hard.position)));
      if (hard.kind === "stopped") return { code: 130 };
      return { code: isLine ? 75 : CONTRACT_EXIT_CODES[hard.status] ?? 1 };
    }
    if (!asked.length) break;
    // Every question at once, under the work order it is about.
    if (isLine || !interactive) {
      for (const { item, questions } of asked) {
        write(yellow(t("clarify.stopped", { name: item.name })));
        for (const line of questionLines(t, questions)) write(line);
      }
    }
    if (isLine) write(yellow(t("clarify.line.total", { count: asked.length })));
    if (!interactive) {
      for (const { item } of asked) write(t("clarify.answer_with", { command: answerCommand(item) + " --answer <n|ai|text>" }));
      return { code: stopped.length ? 1 : 0 };
    }
    const answered = [];
    for (const entry of asked) {
      write(yellow(t("clarify.stopped", { name: entry.item.name })));
      const answers = await askAnswers(t, entry.questions);
      if (!answers) {
        write(t("clarify.cancelled"));
        return { code: 130 };
      }
      answered.push({ ...entry, answers });
    }
    // Nothing is written until every question is answered.
    todo = [];
    for (const { item, questions, answers } of answered) {
      const lines = await writeAnswers({ t, file: item.absolute, sealedSha256: item.plan.task_sha256, questions, answers });
      const plan = await planAnswered(item, nextClarify(item.plan.clarify || null, { questions, answers, lines }));
      if (!plan) return { code: 1 };
      item.plan = plan;
      todo.push(item);
    }
    await open(todo);
  }
  if (stopped.length) {
    write(yellow(t("gather.not_all", { count: stopped.length, total: items.length })));
    return { code: isLine ? 1 : CONTRACT_EXIT_CODES[stopped[0].status] ?? 1 };
  }
  // The second card: every plan names its contract, so one yes covers what was sealed.
  const { snapshot } = await loadOrCreatePolicySnapshot(paths);
  const id = isLine ? randomUUID() : null;
  const plans = [];
  for (const item of items) {
    const contractSha256 = item.reused?.contract_sha256 ?? item.sealed;
    const gathering = item.reused?.plan_sha256 ?? item.plan.plan_sha256;
    const workOrderId = item.opened?.workOrderId ?? item.plan.work_order.work_order_id;
    const versionNo = item.reused?.version_no ?? item.opened.versionNo;
    const plan = await sealPlan(paths, item.plan, {
      contractSha256, gathering, workOrderId, versionNo, planName,
      line: item.plan.line ? { ...item.plan.line, id } : null,
    });
    await recordCard(records.db, { projectId: records.projectId, plan, snapshot, shown: false });
    item.plan = plan;
    plans.push(plan);
  }
  return { code: null, plans };
}
