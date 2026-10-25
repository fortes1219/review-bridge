// The work order's command entries: plan, start, status, cancel, stop, review, resume, and the
// review queue's status and wait. Each owns its order of steps and what it prints.
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";

import {
  activeRuns, assertRunResumable, createRunRuntimeState, fileExists, loadControlView, loadOrCreatePolicySnapshot, loadSingleActiveControlView,
  projectRuns, readJson, recordsDatabase, runDetail, writeJson,
} from "../../service/index.mjs";
import { confirmWorkStart, contractStepsLine, startCard } from "./confirmStart.mjs";
import { loadContract } from "./contract.mjs";
import { deliverOutcome, stdoutLines } from "./delivery.mjs";
import { GateAError } from "./gateA.mjs";
import { runReviewWorker, validateReviewWorker } from "./review.mjs";
import { queueStatus, waitForPending } from "./reviewQueue.mjs";
import {
  authorizeWorkPackage,
  cancelWorkPackage,
  CHANGE_TYPES,
  closeFailedStart,
  createWorkPackagePlan,
  optionAgainstCard,
  workOrderUnchanged,
  workPackageStatus,
} from "./workPackage.mjs";
import {
  canonicalTaskFile, cardFor, cardUsed, clearProject, ensureProject, identifyWorkOrder, markCardShown, recordCard, recordContract, recordStart, withdrawCard,
} from "./workOrderRecords.mjs";
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

const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

// The plan step work-plan, start and resume share: { plan }, { cancelled }, or { refused } when
// Gate A has no approved command for non-docs work (T0-06 G2.3; nothing is written). At a terminal
// a missing breakpoint or change types are asked; without one, start takes their defaults (an
// agent runs it, and the card it prints shows them), while work-plan still requires them.
const workPackageName = (options) => options.workPackage || (options.taskFile ? path.basename(options.taskFile, path.extname(options.taskFile)) : null);
const planPathFor = (paths, options) => {
  const named = workPackageName(options);
  return options.outPath || (options.taskFile && named ? path.join(paths.queueRoot, named + ".plan.json") : null);
};

// RC3-BLOCKER-01: the work order's records are in the person's database, under this project's id.
// A plan without a work-order file (inline --task, the old test path) is no work order and is not
// recorded.
async function openRecords(paths) {
  const config = await readJson(paths.bridgeConfigPath);
  if (!config.project_id) throw new Error("This project was set up before Bridge kept its records in a database. Run: review-bridge upgrade");
  // The router's opener writes a run's kept events first; a direct call opens it plainly.
  const database = recordsDatabase() || (async () => (await import("../../service/database/index.mjs")).openDatabase());
  const db = await database();
  await ensureProject(db, { projectId: config.project_id, root: paths.repoRoot });
  return { db, projectId: config.project_id };
}

// The work order's path in the project, spelled as the file system spells it (the records' key).
const taskFileOf = (paths, file) => canonicalTaskFile(paths.repoRoot, path.resolve(file));

async function planFromOptions({ paths, options, command }) {
  const named = workPackageName(options);
  const outPath = planPathFor(paths, options);
  if (!outPath) throw new Error(command + " needs a work order. Run: review-bridge " + command + " .review-bridge/work-packages/<file>.md");
  if (options.update !== undefined && options.asNew) throw new Error("Give --update <work_order_id> or --as-new, not both.");
  let answers = {};
  if (options.taskFile && (!options.breakpoint || !options.changeTypes) && interactive()) {
    const clack = await import("@clack/prompts");
    answers = await askMissing(options, clack);
    if (answers === null) {
      clack.cancel("Operation cancelled.");
      return { cancelled: true };
    }
  }
  const defaults = command === "start" && !interactive();
  const breakpoint = options.breakpoint || answers.breakpoint || (defaults ? DEFAULT_BREAKPOINT : undefined);
  const changeTypes = options.changeTypes || answers.changeTypes || (defaults ? DEFAULT_CHANGE_TYPES.join(",") : undefined);
  if (options.taskFile && !breakpoint) throw new Error("A breakpoint is required. Add --breakpoint \"<where to stop>\" or answer the prompt.");
  if (options.taskFile && !changeTypes) throw new Error("The change types are required. Add --change-types " + DEFAULT_CHANGE_TYPES.join(",") + " (any of " + CHANGE_TYPES.join(", ") + ") or answer the prompt.");
  const text = options.taskFile ? await fsp.readFile(path.resolve(options.taskFile), "utf8").catch(() => null) : null;
  const records = text !== null ? await openRecords(paths) : null;
  const workOrder = records ? await identifyWorkOrder(records.db, {
    projectId: records.projectId, fileName: taskFileOf(paths, options.taskFile), text: text.trim(), repoRoot: paths.repoRoot,
    update: options.update, asNew: Boolean(options.asNew),
  }) : null;
  try {
    const plan = await createWorkPackagePlan({
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
      workOrder,
    });
    if (records) await recordCard(records.db, { projectId: records.projectId, plan, snapshot: (await loadOrCreatePolicySnapshot(paths)).snapshot, shown: false });
    return { plan, records };
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

// Authorizes the approved plan and runs it to its end; every way out delivers once. A work order's
// start is one database transaction around the file authorization (recordStart): the work order and
// its version, the authorization and its claim. When that transaction fails after the run was made,
// the run is closed before any model call.
async function runAuthorized({ paths, options, adapter, approval, authorizedVia, onStep }) {
  const plan = await readJson(path.resolve(options.planPath));
  const records = plan.task_file ? await openRecords(paths) : null;
  let started = null;
  const authorize = async () => (started = await authorizeWorkPackage({
    paths,
    planPath: options.planPath,
    approval,
    executionMode: options.fakeCli ? "fake_cli" : "native",
    authorizedVia,
  }));
  let authorization;
  try {
    authorization = records ? await recordStart(records.db, { planSha256: approval, authorize }) : await authorize();
  } catch (error) {
    if (started) {
      await closeFailedStart(paths, started.run.run_id, error);
      await started.workLock();
    }
    throw error;
  }
  // The sealed contract is recorded under its SHA-256, against the work order version it came from.
  const onContractSealed = records
    ? async (contractSha256) => await recordContract(records.db, {
      workOrderId: authorization.workOrderId, contentSha256: plan.task_sha256, contractSha256, contract: await loadContract(paths, contractSha256),
    })
    : null;
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
      onContractSealed,
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

// `guard` is the router's start gate (reviewer read-only proof); it runs after the options are
// checked and before the person is asked. --approve and --yes carry the person's yes through an
// agent; without them and without a terminal the card is printed and nothing starts.
export async function startWork({ paths, options, adapter, guard }) {
  if (!options.planPath) throw new Error("work-start needs a plan. Run: review-bridge work-plan <file> first, or review-bridge start <file> to do both.");
  if (options.fakeScenario && !options.fakeCli) {
    throw new Error("--fake-scenario requires --fake-cli. Add --fake-cli, or leave --fake-scenario out.");
  }
  await guard();
  const relayed = Boolean(options.approval || options.yes);
  const approval = options.approval || await confirmWorkStart(paths, options.planPath, {
    assumeYes: Boolean(options.yes),
    ask: interactive(),
    again: "review-bridge work-start --plan " + shownPath(path.resolve(options.planPath)).replaceAll("\\", "/") + (options.fakeCli ? " --fake-cli" : ""),
  });
  if (approval === null) return 1;
  return await runAuthorized({ paths, options, adapter, approval, authorizedVia: relayed ? "agent" : "terminal" });
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

function checkFailureLines(check, again) {
  const why = CHECK_REFUSALS[check.reason] || check.reason;
  const next = check.reason === "page_runs_fake_cli"
    ? "Run: review-bridge down, then " + again
    : check.reason === "reviewer_not_ready"
      ? "Sign the reviewer in (codex login), then run: " + again
      : "Run: " + again + " again" + (check.url ? ", or open " + check.url + " and press Check" : "");
  return [
    "Reviewer read-only check: not passed (" + why + ")",
    ...(check.diagnostic_id ? ["Record: " + check.audit_path + " (" + check.diagnostic_id + ")"] : []),
    next,
  ];
}

const write = (line) => process.stdout.write(line + "\n");

// After the plan, start and resume go the same way: the reviewer read-only check (once per page
// session; `reviewerCheck` is the router's, run in the page service), the card, the person's yes,
// the run. The yes is the only authorization. At a terminal it is asked; an agent shows the person
// the card printed here and runs `again` with --yes once they said yes (Owner 2026-10-25). The
// gate's reviewer proof is asserted before either.
async function runOnYes({ paths, options, adapter, loadAdapter, guard, reviewerCheck, plan, again }) {
  const { db } = await openRecords(paths);
  // E10: a card that was not shown, or was answered no at the terminal, takes no later --yes.
  const noCard = async () => {
    if (!options.yes) await withdrawCard(db, plan.plan_sha256);
    return 1;
  };
  if (options.fakeCli) {
    write("Reviewer read-only check: not needed with the fake CLI (no model is called)");
  } else {
    const check = await reviewerCheck({
      onStart: (reviewer) => write("Checking that the reviewer (" + reviewer + ") cannot write files: one model call..."),
    });
    if (!check.ok) {
      for (const line of checkFailureLines(check, again)) write(line);
      return await noCard();
    }
    write("Reviewer read-only check: passed" + (check.already ? " (earlier in this page session)" : ""));
  }
  write("");
  write(await startCard(paths, plan));
  await markCardShown(db, plan.plan_sha256);
  if (!options.yes && !interactive()) {
    write("Needs authorization. If the person says yes, run again: " + again + " --yes");
    return 1;
  }
  await guard();
  // A native start takes this machine's adapter only now, after the check (bootstrap leaves it).
  const runAdapter = adapter || await loadAdapter();
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
      return await noCard();
    }
  }
  write("");
  return await runAuthorized({
    paths, options: { ...options, planPath: plan.plan_path }, adapter: runAdapter, approval: plan.plan_sha256,
    authorizedVia: options.yes ? "agent" : "terminal",
    onStep: (step) => write("  " + step),
  });
}

// E8, E10: --yes is the yes to the card printed before it, and one card is one yes. The card is
// found in the database (Q14: this project's latest printed, not withdrawn plan for this file) and
// taken as it is, without planning again: refused when there is none, when the work order no longer
// reads as the card showed it, when an option given beside --yes is not what the card showed, when
// it already started a run, or when it is past its "Valid until". Its plan file at `planPath` is
// written from the database: the file is the running copy.
async function cardForYes({ paths, planPath, taskFile, options, again }) {
  const { db, projectId } = await openRecords(paths);
  const card = await cardFor(db, { projectId, fileName: taskFileOf(paths, taskFile) });
  const refuse = (line) => { write(line); return null; };
  if (!card) return refuse("No card was shown for this work order, so there is no yes to run on. Run: " + again + " and show the person the card.");
  if (!(await workOrderUnchanged({ task_sha256: card.content_sha256 }, taskFile))) return refuse("The work order changed after you saw the card. Run: " + again + " and look again.");
  const option = optionAgainstCard(card.body, options);
  if (option) return refuse(option + " is not what the card showed. Run: " + again + " --yes without it, or " + again + " to show the person a new card.");
  if (await cardUsed(db, card.plan_sha256)) return refuse("This card was already said yes to; one card starts one run. Run: " + again + " and show the person the new card.");
  if (!(card.authorization_expires_at > new Date())) return refuse("The card was valid until " + card.authorization_expires_at.toISOString() + ". Run: " + again + " and show the person the new card.");
  await writeJson(planPath, card.body);
  write("Plan from the card: " + shownPath(planPath));
  return { ...card.body, plan_path: planPath };
}

async function planOrSay({ paths, options, command }) {
  const planned = await planFromOptions({ paths, options, command });
  if (planned.refused) process.stdout.write(gateARefusal(planned.refused, false));
  if (planned.plan) write("Plan written to " + shownPath(planned.plan.plan_path));
  return planned.plan || null;
}

// `start <file>`: the person's one command from a work order to its result.
export async function startWorkOrder({ paths, options, adapter, loadAdapter, guard, reviewerCheck }) {
  if (!options.taskFile) throw new Error("start needs a work order. Run: review-bridge start .review-bridge/work-packages/<file>.md");
  if (options.fakeScenario && !options.fakeCli) {
    throw new Error("--fake-scenario requires --fake-cli. Add --fake-cli, or leave --fake-scenario out.");
  }
  // Forward slashes: the command is pasted into any shell, bash included, and Windows takes them.
  const again = "review-bridge start " + shownPath(path.resolve(options.taskFile)).replaceAll("\\", "/") + (options.fakeCli ? " --fake-cli" : "");
  const plan = options.yes
    ? await cardForYes({ paths, planPath: planPathFor(paths, options), taskFile: options.taskFile, options, again })
    : await planOrSay({ paths, options, command: "start" });
  if (!plan) return 1;
  return await runOnYes({ paths, options, adapter, loadAdapter, guard, reviewerCheck, plan, again });
}

// `resume <run_id>`: a stopped run is closed for good (its records were sealed by the controller
// that ran it, which no later process can vouch for), so the work order is carried on as a new
// run with that run's own stop point, change types, scope and budget, after the same card and yes.
export async function resumeWorkOrder({ paths, runId, options, adapter, loadAdapter, guard, reviewerCheck }) {
  if (!runId) throw new Error("resume needs a run id. Run: review-bridge status to see the runs, then review-bridge resume <run_id>");
  if (options.fakeScenario && !options.fakeCli) {
    throw new Error("--fake-scenario requires --fake-cli. Add --fake-cli, or leave --fake-scenario out.");
  }
  const control = await loadControlView(paths, runId).catch(() => null);
  if (!control) throw new Error("There is no run " + runId + " here. Run: review-bridge status");
  if (control.authorization_status === "active") throw new Error("Run " + runId + " is still running. Pause it first: review-bridge stop " + runId);
  const workPackage = control.run.work_package;
  if (!workPackage.task_file) throw new Error("Run " + runId + " was not started from a work order file. Run: review-bridge start <file>");
  write("Carrying on run " + runId + " (" + workPackage.task_file + ") as a new run");
  const taskFile = path.join(paths.repoRoot, ...workPackage.task_file.split("/"));
  // One plan per stopped run, so the card and its --yes name the same one.
  const planPath = path.join(paths.queueRoot, workPackage.work_package_id + ".resume-" + runId + ".plan.json");
  const again = "review-bridge resume " + runId + (options.fakeCli ? " --fake-cli" : "");
  const plan = options.yes ? await cardForYes({ paths, planPath, taskFile, options, again }) : await planOrSay({
    paths,
    command: "resume",
    options: {
      ...options,
      taskFile,
      workPackage: workPackage.work_package_id,
      breakpoint: workPackage.breakpoint,
      changeTypes: workPackage.scope.change_types.join(","),
      allowedPaths: workPackage.scope.source === "explicit" ? workPackage.scope.allowed_paths.join(",") : undefined,
      maxCalls: workPackage.budget.max_claude_calls,
      maxMinutes: workPackage.budget.max_claude_minutes_per_call,
      outPath: planPath,
    },
  });
  if (!plan) return 1;
  return await runOnYes({ paths, options, adapter, loadAdapter, guard, reviewerCheck, plan, again });
}

// `clean --all` (Owner 2026-10-25): the project's work orders, versions, plans, authorizations
// and contracts leave the person's database in one transaction; the project id is kept as cleared
// and never used again. Refused while one of its runs is running, and with a run id.
export async function clearProjectRecords({ paths, runId, options }) {
  if (runId) throw new Error("clean --all clears the whole project; give no run id. Run: review-bridge clean --all");
  const { db, projectId } = await openRecords(paths);
  const active = await activeRuns(db, projectId);
  if (active.length) throw new Error(active.length + " run(s) of this project are running. Stop them first: review-bridge stop " + active[0].run_id);
  const counts = await clearProject(db, projectId);
  if (options.json) {
    write(JSON.stringify({ project_id: projectId, cleared: counts }, null, 2));
    return 0;
  }
  write("Cleared this project's records: " + counts.work_orders + " work order(s), " + counts.work_order_versions + " version(s), "
    + counts.plans + " plan(s), " + counts.authorizations + " authorization(s), " + counts.contracts + " contract(s), " + counts.runs + " run(s).");
  write("This project's id is not used again. To use Bridge here again: review-bridge uninstall --target ., then review-bridge init");
  return 0;
}

// `status`: what Bridge is doing now, from the person's database (RC3-BLOCKER-01 step 4): the page,
// this project's runs (Q12, newest first, ten at a time; --after <run_id> is the next page), how
// many are running (Q6), the review queue, and how to look at the tables yourself. --json gives
// the same parts whole.
const STATUS_RUNS = 10;

export async function statusOverview({ paths, options, page }) {
  if (!(await fileExists(paths.bridgeConfigPath))) {
    write("This folder is not set up for Review Bridge. Run: review-bridge init");
    return 0;
  }
  const service = await page();
  const { db, projectId } = await openRecords(paths);
  const { runs, more } = await projectRuns(db, projectId, { limit: STATUS_RUNS, after: options.after || null });
  const active = await activeRuns(db, projectId);
  const queue = await queueStatus(paths);
  if (options.json) {
    write(JSON.stringify({
      page: { running: service.running, url: service.url, reason: service.reason },
      project_id: projectId, active_runs: active.length, runs, more, review_queue: queue, database: db.connection,
    }, null, 2));
    return 0;
  }
  write("Page: " + (service.running ? service.url : "not running; start it with review-bridge up"));
  if (!runs.length && !options.after) {
    write("Work: none yet. Put a work order in .review-bridge/work-packages/ and run: review-bridge start <file>");
  } else {
    write("Work: " + active.length + " running");
    for (const run of runs) {
      write("  " + [run.run_id, run.status.padEnd(14), (run.closed_reason || "-").padEnd(20), run.source_file, run.created_at.toISOString()].join("  "));
    }
    if (more) write("  More: review-bridge status --after " + runs.at(-1).run_id);
  }
  write("Review queue: pending " + queue.pending + ", running " + queue.running + ", done " + queue.done + ", failed " + queue.failed);
  if (queue.latest_review) write("Latest review: " + queue.latest_review);
  const { host, port, database, user, passwordFile } = db.connection;
  write("Database: host " + host + "  port " + port + "  database " + database + "  user " + user);
  write("          password file: " + passwordFile);
  return 0;
}

// `work-status`: the same runs as JSON for agents and scripts, with the newest one in detail: its
// work order version and contract, the yes, the plan's stop point, scope and budget, the last stop.
export async function workStatus({ paths, options }) {
  const { db, projectId } = await openRecords(paths);
  const { runs, more } = await projectRuns(db, projectId, { limit: STATUS_RUNS, after: options.after || null });
  const active = await activeRuns(db, projectId);
  const latest = runs.length ? await runDetail(db, runs[0].run_id) : null;
  write(JSON.stringify({ project_id: projectId, active_runs: active.length, latest_run: latest, runs, more }, null, 2));
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

export async function waitForReview({ paths, options }) {
  const timeoutMinutes = options.timeoutMinutes ?? 120;
  if (timeoutMinutes < 1 || timeoutMinutes > 1440) {
    throw new Error("wait timeout must be 1 through 1440 minutes.");
  }
  const file = await waitForPending(paths, timeoutMinutes);
  process.stdout.write(file + "\n");
  return 0;
}
