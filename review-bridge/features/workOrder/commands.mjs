// The work order's command entries: plan, start, status, cancel, stop, review, resume, and the
// review queue's status and wait. Each owns its order of steps and what it prints.
import os from "node:os";
import path from "node:path";

import { assertRunResumable, createRunRuntimeState, loadSingleActiveControlView } from "../../service/index.mjs";
import { confirmWorkStart, contractStepsLine } from "./confirmStart.mjs";
import { deliverOutcome, stdoutLines } from "./delivery.mjs";
import { GateAError } from "./gateA.mjs";
import { runReviewWorker, validateReviewWorker } from "./review.mjs";
import { queueStatus, waitForPending } from "./reviewQueue.mjs";
import {
  authorizeWorkPackage,
  cancelWorkPackage,
  CHANGE_TYPES,
  createWorkPackagePlan,
  workPackageStatus,
} from "./workPackage.mjs";
import { runBoundedResume, stopRun, validateBoundedResume } from "./writerLoop.mjs";

// For a work-order file the rest has defaults: the work package is the file name, the plan goes
// to review-queue/<name>.plan.json, the owner is the signed-in OS user. The breakpoint and the
// change types have no default; at a terminal they are asked, otherwise they are required. The
// prompt library is loaded only then, like every other dependency of the runtime.
async function askMissing(options, clack) {
  const asked = {};
  if (!options.breakpoint) {
    const answer = await clack.text({
      message: "Where should the work stop and come back to you?",
      placeholder: "after the review",
      validate: (value) => (String(value || "").trim() ? undefined : "A breakpoint is required."),
    });
    if (clack.isCancel(answer)) return null;
    asked.breakpoint = answer;
  }
  if (!options.changeTypes) {
    const answer = await clack.multiselect({
      message: "What will this work change?",
      options: CHANGE_TYPES.map((type) => ({ value: type, label: type })),
      required: true,
    });
    if (clack.isCancel(answer)) return null;
    asked.changeTypes = answer.join(",");
  }
  return asked;
}

export async function planWork({ paths, options }) {
  const named = options.workPackage || (options.taskFile ? path.basename(options.taskFile, path.extname(options.taskFile)) : null);
  const outPath = options.outPath || (options.taskFile && named ? path.join(paths.queueRoot, named + ".plan.json") : null);
  if (!outPath) throw new Error("work-plan requires --out.");
  let answers = {};
  if (options.taskFile && (!options.breakpoint || !options.changeTypes) && process.stdin.isTTY && process.stdout.isTTY) {
    const clack = await import("@clack/prompts");
    answers = await askMissing(options, clack);
    if (answers === null) {
      clack.cancel("Operation cancelled.");
      return 1;
    }
  }
  let plan;
  try {
    plan = await createWorkPackagePlan({
      paths,
      task: options.task,
      taskFile: options.taskFile,
      owner: options.owner || (options.taskFile ? os.userInfo().username : undefined),
      workPackage: named,
      breakpoint: options.breakpoint || answers.breakpoint,
      changeTypes: options.changeTypes || answers.changeTypes,
      allowedPaths: options.allowedPaths,
      maxCalls: options.maxCalls ?? 2,
      maxMinutes: options.maxMinutes ?? 8,
      outPath,
    });
  } catch (error) {
    // T0-06 G2.3: no approved test entry point for non-docs work; nothing is written.
    if (!(error instanceof GateAError)) throw error;
    process.stdout.write(options.plain
      ? error.plain() + "\n"
      : JSON.stringify({ valid: false, reason: error.reason, checked: error.checked }, null, 2) + "\n");
    return 1;
  }
  // JSON stays the default because the installer and tests read it; --plain is the human summary (C5.2).
  if (options.plain) {
    process.stdout.write([
      plan.task_file ? "工單：" + plan.task_file : "工作包：" + plan.work_package_id,
      "範圍：" + ({ default: "預設（整個專案減禁改清單）", explicit: "指定" })[plan.scope.source] + "，" + plan.scope.allowed_paths.length + " 條路徑",
      "驗收：" + (plan.gate_a?.kind === "command" ? "會跑 " + plan.gate_a.command + "（profile 核准）" : plan.gate_a?.label || "未定"),
      ...(plan.contract_steps ? [contractStepsLine(plan.contract_steps)] : []),
      "plan：" + plan.plan_path,
      "sha：" + plan.plan_sha256,
      // T0-08: native work-start refuses --approve; the human confirms the card at the terminal.
      "下一步：work-start --plan " + plan.plan_path + "，在終端機看完卡片後輸入 y",
    ].join("\n") + "\n");
    return 0;
  }
  process.stdout.write(JSON.stringify({
    valid: true,
    plan_path: plan.plan_path,
    work_package: plan.work_package || plan.work_package_id,
    owner: plan.owner,
    breakpoint: plan.breakpoint,
    scope: plan.scope,
    gate_a: plan.gate_a,
    budget: plan.budget,
    next_command: "work-start --plan <plan_path>",
  }, null, 2) + "\n");
  return 0;
}

// `guard` is the router's start gate (T0-08 native terminal, reviewer read-only proof); it runs
// after the options are checked and before the human is asked.
export async function startWork({ paths, options, adapter, guard }) {
  if (!options.planPath) throw new Error("work-start requires --plan.");
  if (options.fakeScenario && !options.fakeCli) {
    throw new Error("--fake-scenario requires --fake-cli.");
  }
  await guard();
  const approval = options.approval || await confirmWorkStart(paths, options.planPath, Boolean(options.yes));
  const authorization = await authorizeWorkPackage({
    paths,
    planPath: options.planPath,
    approval,
    executionMode: options.fakeCli ? "fake_cli" : "native",
    authorizedVia: options.approval ? "approve_flag" : options.yes ? "yes_flag" : "terminal",
  });
  // The replaced version is delivered here too, in case its own work-start is gone.
  for (const runId of authorization.superseded) {
    await deliverOutcome({ paths, runId, adapter, notify: true })
      .catch((error) => process.stderr.write("delivery failed: " + String(error?.message || error) + "\n"));
  }
  let exitCode;
  try {
    exitCode = await runBoundedResume({
      paths,
      control: authorization.control,
      adapter,
      promptPath: authorization.promptPath,
      maxCalls: authorization.plan.budget.max_claude_calls,
      maxMinutes: authorization.plan.budget.max_claude_minutes_per_call,
      startNewSession: true,
      runtimeState: createRunRuntimeState(paths, authorization.run.run_id),
      workLock: authorization.workLock,
    });
  } finally {
    // T0-07 V2.8 (a): every way out of a run delivers once; a failure here never masks the run's own exit.
    try {
      const delivery = await deliverOutcome({ paths, runId: authorization.run.run_id, adapter, notify: true });
      if (!options.json) process.stdout.write(stdoutLines(delivery).join("\n") + "\n");
    } catch (error) {
      process.stderr.write("delivery failed: " + String(error?.message || error) + "\n");
    }
  }
  if (options.json) {
    process.stdout.write(JSON.stringify(await workPackageStatus(paths, authorization.run.run_id), null, 2) + "\n");
  }
  return exitCode;
}

export async function workStatus({ paths }) {
  process.stdout.write(JSON.stringify(await workPackageStatus(paths), null, 2) + "\n");
  return 0;
}

export async function cancelWork({ paths, options, adapter }) {
  const cancelled = await cancelWorkPackage({ paths, runId: options.runId || null, reason: options.reason });
  // Codex 2026-10-14: the cancel itself delivers; the result reflects the workspace at this moment.
  await deliverOutcome({ paths, runId: cancelled.run_id, adapter, notify: true })
    .catch((error) => process.stderr.write("delivery failed: " + String(error?.message || error) + "\n"));
  process.stdout.write(JSON.stringify(await workPackageStatus(paths), null, 2) + "\n");
  return 0;
}

export async function stopWork({ paths, runId, adapter }) {
  if (!runId) throw new Error("stop requires a run id.");
  const result = await stopRun(paths, runId);
  process.stdout.write(result.line + "\n");
  // T0-07 V2.8 (b): if the work-start process is gone, the stop command delivers.
  if (result.exitCode === 0) {
    try {
      const delivery = await deliverOutcome({ paths, runId, adapter, notify: true });
      if (!delivery.already) process.stdout.write(stdoutLines(delivery).join("\n") + "\n");
    } catch (error) {
      process.stderr.write("delivery failed: " + String(error?.message || error) + "\n");
    }
  }
  return result.exitCode;
}

export async function reviewWork({ paths, options, adapter }) {
  const activeControl = await loadSingleActiveControlView(paths);
  if (options.validateOnly) {
    const result = await validateReviewWorker({ paths, control: activeControl, adapter });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  await runReviewWorker({
    paths,
    control: activeControl,
    adapter,
    dryRun: Boolean(options.dryRun),
    noNotification: Boolean(options.noNotification),
  });
  return 0;
}

export async function resumeWork({ paths, options, adapter }) {
  const activeControl = await loadSingleActiveControlView(paths);
  const runtimeState = createRunRuntimeState(paths, activeControl.run.run_id);
  await assertRunResumable(paths, activeControl.run.run_id);
  if (!options.promptPath) throw new Error("bounded-resume requires --prompt.");
  const maxCalls = options.maxCalls ?? 2;
  const maxMinutes = options.maxMinutes ?? 8;
  if (maxCalls < 1 || maxCalls > 2) throw new Error("max Claude calls must be 1 or 2.");
  if (maxMinutes < 1 || maxMinutes > 15) throw new Error("max Claude minutes must be 1 through 15.");
  if (options.validateOnly) {
    const result = await validateBoundedResume({
      paths, control: activeControl, adapter, promptPath: options.promptPath, maxCalls, maxMinutes,
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  return await runBoundedResume({
    paths, control: activeControl, adapter, promptPath: options.promptPath, maxCalls, maxMinutes,
    runtimeState,
  });
}

export async function reviewQueueStatus({ paths }) {
  process.stdout.write(JSON.stringify(await queueStatus(paths), null, 2) + "\n");
  return 0;
}

export async function waitForReview({ paths, options }) {
  const timeoutMinutes = options.timeoutMinutes ?? 120;
  if (timeoutMinutes < 1 || timeoutMinutes > 1440) {
    throw new Error("wait timeout must be 1 through 1440 minutes.");
  }
  const file = await waitForPending(paths, timeoutMinutes);
  process.stdout.write(file + "\n");
  return 0;
}
