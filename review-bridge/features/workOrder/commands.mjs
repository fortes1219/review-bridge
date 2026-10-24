// The work order's command entries: plan, start, status, cancel, stop, review, resume, and the
// review queue's status and wait. Each owns its order of steps and what it prints.
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";

import { assertRunResumable, createRunRuntimeState, loadSingleActiveControlView } from "../../service/index.mjs";
import { confirmWorkStart, contractStepsLine, startCard } from "./confirmStart.mjs";
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

export const DEFAULT_BREAKPOINT = "after the review";
const DEFAULT_CHANGE_TYPES = Object.freeze(["docs"]);

// For a work-order file the rest has defaults: the work package is the file name, the plan goes
// to review-queue/<name>.plan.json, the owner is the signed-in OS user. The breakpoint and the
// change types are asked at a terminal with a default that Enter takes; the work order has no
// field that names its change types, so they are never guessed from its text. Without a terminal
// both are required. The prompt library is loaded only then, like every other dependency of the
// runtime.
async function askMissing(options, clack) {
  const asked = {};
  if (!options.breakpoint) {
    const answer = await clack.text({
      message: "Where should the work stop and come back to you?",
      placeholder: DEFAULT_BREAKPOINT,
      defaultValue: DEFAULT_BREAKPOINT,
    });
    if (clack.isCancel(answer)) return null;
    asked.breakpoint = answer;
  }
  if (!options.changeTypes) {
    const answer = await clack.multiselect({
      message: "What will this work change?",
      options: CHANGE_TYPES.map((type) => ({ value: type, label: type })),
      initialValues: [...DEFAULT_CHANGE_TYPES],
      required: true,
    });
    if (clack.isCancel(answer)) return null;
    asked.changeTypes = answer.join(",");
  }
  return asked;
}

// The plan step work-plan and start share: { plan }, { cancelled }, or { refused } when Gate A has
// no approved command for non-docs work (T0-06 G2.3; nothing is written).
async function planFromOptions({ paths, options, command }) {
  const named = options.workPackage || (options.taskFile ? path.basename(options.taskFile, path.extname(options.taskFile)) : null);
  const outPath = options.outPath || (options.taskFile && named ? path.join(paths.queueRoot, named + ".plan.json") : null);
  if (!outPath) throw new Error(command + " needs a work order. Run: review-bridge " + command + " .review-bridge/work-packages/<file>.md");
  let answers = {};
  if (options.taskFile && (!options.breakpoint || !options.changeTypes) && process.stdin.isTTY && process.stdout.isTTY) {
    const clack = await import("@clack/prompts");
    answers = await askMissing(options, clack);
    if (answers === null) {
      clack.cancel("Operation cancelled.");
      return { cancelled: true };
    }
  }
  const breakpoint = options.breakpoint || answers.breakpoint;
  const changeTypes = options.changeTypes || answers.changeTypes;
  if (options.taskFile && !breakpoint) throw new Error("A breakpoint is required. Add --breakpoint \"<where to stop>\" or answer the prompt.");
  if (options.taskFile && !changeTypes) throw new Error("The change types are required. Add --change-types " + DEFAULT_CHANGE_TYPES.join(",") + " (any of " + CHANGE_TYPES.join(", ") + ") or answer the prompt.");
  try {
    return {
      plan: await createWorkPackagePlan({
        paths,
        task: options.task,
        taskFile: options.taskFile,
        owner: options.owner || (options.taskFile ? os.userInfo().username : undefined),
        workPackage: named,
        breakpoint,
        changeTypes,
        allowedPaths: options.allowedPaths,
        maxCalls: options.maxCalls ?? 2,
        maxMinutes: options.maxMinutes ?? 8,
        outPath,
      }),
    };
  } catch (error) {
    if (!(error instanceof GateAError)) throw error;
    return { refused: error };
  }
}

function gateARefusal(error, json) {
  return json
    ? JSON.stringify({ valid: false, reason: error.reason, checked: error.checked }, null, 2) + "\n"
    : error.plain() + "\nOnly docs-only work can start without one. Add a test script to the project, or plan the work as docs: --change-types docs\n";
}

export async function planWork({ paths, options }) {
  const planned = await planFromOptions({ paths, options, command: "work-plan" });
  if (planned.cancelled) return 1;
  if (planned.refused) {
    process.stdout.write(options.plain ? planned.refused.plain() + "\n" : gateARefusal(planned.refused, options.json));
    return 1;
  }
  const { plan } = planned;
  // --plain is the human summary (C5.2); --json is what scripts and tests read.
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
  if (options.json) {
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
  const shown = shownPath(plan.plan_path);
  process.stdout.write("Plan written to " + shown + "\nNext: review-bridge work-start --plan " + shown + "\n");
  return 0;
}

// A path as the person can paste it back: relative to where they are when that is shorter.
function shownPath(file) {
  const relative = path.relative(process.cwd(), file);
  const shown = relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
  return /\s/.test(shown) ? "\"" + shown + "\"" : shown;
}

// Authorizes the approved plan and runs it to its end; every way out delivers once.
async function runAuthorized({ paths, options, adapter, approval, authorizedVia, onStep }) {
  const authorization = await authorizeWorkPackage({
    paths,
    planPath: options.planPath,
    approval,
    executionMode: options.fakeCli ? "fake_cli" : "native",
    authorizedVia,
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
      onStep,
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

// `guard` is the router's start gate (T0-08 native terminal, reviewer read-only proof); it runs
// after the options are checked and before the human is asked.
export async function startWork({ paths, options, adapter, guard }) {
  if (!options.planPath) throw new Error("work-start needs a plan. Run: review-bridge work-plan <file> first, or review-bridge start <file> to do both.");
  if (options.fakeScenario && !options.fakeCli) {
    throw new Error("--fake-scenario requires --fake-cli. Add --fake-cli, or leave --fake-scenario out.");
  }
  await guard();
  const approval = options.approval || await confirmWorkStart(paths, options.planPath, Boolean(options.yes));
  return await runAuthorized({
    paths, options, adapter, approval,
    authorizedVia: options.approval ? "approve_flag" : options.yes ? "yes_flag" : "terminal",
  });
}

const CHECK_REFUSALS = Object.freeze({
  page_not_running: "the Bridge page could not be started",
  page_runs_fake_cli: "the Bridge page is running with the fake CLI",
  adapter_not_verified: "this platform's adapter is not verified, so the check is not available here",
  reviewer_not_ready: "the reviewer CLI is not installed and signed in",
  unsupported_reviewer: "the selected reviewer cannot prove it is read-only",
  in_flight: "a check is already running",
  probe_not_started: "the check did not start",
});

function checkFailureLines(check, file) {
  const why = CHECK_REFUSALS[check.reason] || check.reason;
  const next = check.reason === "page_runs_fake_cli"
    ? "Run: review-bridge down, then review-bridge start " + file
    : check.reason === "reviewer_not_ready"
      ? "Sign the reviewer in (codex login), then run: review-bridge start " + file
      : "Run: review-bridge start " + file + " again" + (check.url ? ", or open " + check.url + " and press Check" : "");
  return [
    "Reviewer read-only check: not passed (" + why + ")",
    ...(check.diagnostic_id ? ["Record: " + check.audit_path + " (" + check.diagnostic_id + ")"] : []),
    next,
  ];
}

// `start <file>`: the human's one command from a work order to its result. It plans the work,
// makes sure the reviewer read-only check has passed (once per page session; `reviewerCheck` is
// the router's, run in the page service), shows the card, asks once, and runs. The answer at
// this question is the only authorization; nothing else asks for one.
export async function startWorkOrder({ paths, options, adapter, guard, reviewerCheck }) {
  if (!options.taskFile) throw new Error("start needs a work order. Run: review-bridge start .review-bridge/work-packages/<file>.md");
  if (options.fakeScenario && !options.fakeCli) {
    throw new Error("--fake-scenario requires --fake-cli. Add --fake-cli, or leave --fake-scenario out.");
  }
  const file = shownPath(path.resolve(options.taskFile));
  const planned = await planFromOptions({ paths, options, command: "start" });
  if (planned.cancelled) return 1;
  if (planned.refused) {
    process.stdout.write(gateARefusal(planned.refused, false));
    return 1;
  }
  const { plan } = planned;
  const write = (line) => process.stdout.write(line + "\n");
  write("Plan written to " + shownPath(plan.plan_path));
  if (options.fakeCli) {
    write("Reviewer read-only check: not needed with the fake CLI (no model is called)");
  } else {
    const check = await reviewerCheck({
      onStart: (reviewer) => write("Checking that the reviewer (" + reviewer + ") cannot write files: one model call..."),
    });
    if (!check.ok) {
      for (const line of checkFailureLines(check, file)) write(line);
      return 1;
    }
    write("Reviewer read-only check: passed" + (check.already ? " (earlier in this page session)" : ""));
  }
  write("");
  write(await startCard(paths, plan));
  await guard();
  if (!options.yes) {
    const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try {
      answer = await terminal.question("Start this work? [y/N] ");
    } finally {
      terminal.close();
    }
    if (!/^y(?:es)?$/i.test(answer.trim())) {
      write("Not started. Nothing was authorized.");
      return 1;
    }
  }
  write("");
  return await runAuthorized({
    paths, options: { ...options, planPath: plan.plan_path }, adapter, approval: plan.plan_sha256,
    authorizedVia: options.yes ? "yes_flag" : "terminal",
    onStep: (step) => write("  " + step),
  });
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
