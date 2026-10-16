// The work order's command entries: plan, start, status, cancel, stop, review, resume, and the
// review queue's status and wait. Each owns its order of steps and what it prints.
import { assertRunResumable, createRunRuntimeState, loadSingleActiveControlView } from "../../service/index.mjs";
import { confirmV4WorkStart } from "./confirmStart.mjs";
import { deliverOutcome, stdoutLines } from "./delivery.mjs";
import { GateAError } from "./gateA.mjs";
import { runReviewWorker, validateReviewWorker } from "./review.mjs";
import { queueStatus, waitForPending } from "./reviewQueue.mjs";
import {
  authorizeV4WorkPackage,
  cancelV4WorkPackage,
  createV4WorkPackagePlan,
  v4WorkPackageStatus,
} from "./workPackage.mjs";
import { runBoundedResume, stopRun, validateBoundedResume } from "./writerLoop.mjs";

export async function planWork({ paths, options }) {
  if (!options.outPath) throw new Error("work-plan requires --out.");
  let plan;
  try {
    plan = await createV4WorkPackagePlan({
      paths,
      task: options.task,
      taskFile: options.taskFile,
      owner: options.owner,
      workPackage: options.workPackage,
      breakpoint: options.breakpoint,
      changeTypes: options.changeTypes,
      allowedPaths: options.allowedPaths,
      maxCalls: options.maxCalls ?? 2,
      maxMinutes: options.maxMinutes ?? 8,
      outPath: options.outPath,
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
    const order = plan.work_order;
    const pathRefs = order ? order.references.filter((entry) => entry.kind === "path").length : 0;
    process.stdout.write([
      order ? "工作名稱：" + order.name : "工作包：" + plan.work_package_id,
      ...(order && (order.product || order.version) ? ["產品／版本：" + [order.product, order.version].filter(Boolean).join(" / ")] : []),
      "範圍：" + ({ default: "預設（整個專案減禁改清單）", references: "參考資料收緊", explicit: "指定" })[plan.scope.source] + "，" + plan.scope.allowed_paths.length + " 條路徑",
      ...(order ? ["參考資料：" + order.references.length + " 條（" + pathRefs + " 個路徑）"] : []),
      "驗收：" + (plan.gate_a?.kind === "command" ? "會跑 " + plan.gate_a.command + "（profile 核准）" : plan.gate_a?.label || "未定"),
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
  const approval = options.approval || await confirmV4WorkStart(paths, options.planPath, Boolean(options.yes));
  const authorization = await authorizeV4WorkPackage({
    paths,
    planPath: options.planPath,
    approval,
    executionMode: options.fakeCli ? "fake_cli" : "native",
    authorizedVia: options.approval ? "approve_flag" : options.yes ? "yes_flag" : "terminal",
  });
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
    });
  } finally {
    // T0-07 V2.8 (a): every way out of a v4 run delivers once; a failure here never masks the run's own exit.
    try {
      const delivery = await deliverOutcome({ paths, runId: authorization.run.run_id, adapter, notify: true });
      if (!options.json) process.stdout.write(stdoutLines(delivery).join("\n") + "\n");
    } catch (error) {
      process.stderr.write("delivery failed: " + String(error?.message || error) + "\n");
    }
  }
  if (options.json) {
    process.stdout.write(JSON.stringify(await v4WorkPackageStatus(paths, authorization.run.run_id), null, 2) + "\n");
  }
  return exitCode;
}

export async function workStatus({ paths }) {
  process.stdout.write(JSON.stringify(await v4WorkPackageStatus(paths), null, 2) + "\n");
  return 0;
}

export async function cancelWork({ paths, options, adapter }) {
  const cancelled = await cancelV4WorkPackage({ paths, reason: options.reason });
  // Codex 2026-10-14: the cancel itself delivers; the result reflects the workspace at this moment.
  await deliverOutcome({ paths, runId: cancelled.run_id, adapter, notify: true })
    .catch((error) => process.stderr.write("delivery failed: " + String(error?.message || error) + "\n"));
  process.stdout.write(JSON.stringify(await v4WorkPackageStatus(paths), null, 2) + "\n");
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
  const runtimeState = createRunRuntimeState(paths, activeControl.v4.run_id);
  await assertRunResumable(paths, activeControl.v4.run_id);
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
