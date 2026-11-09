// The work order's command entries: plan, start, status, cancel, stop, review, resume, and the
// review queue's status and wait. Each owns its order of steps and what it prints.
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  activeLineSteps, activeRuns, appendIoEvent, assertRunResumable, bridgeDataHome, createRunRuntimeState, fileExists, loadControlView, loadOrCreatePolicySnapshot, loadSingleActiveControlView,
  inspectProvider, listCodexMcpServers, projectRuns, readJson, RoleCliNotReadyError, recordsDatabase, runDetail, SIGN_IN_COMMANDS, updateGraph, writeJsonAtomic,
} from "../../service/index.mjs";
import { localTimestamp } from "../../utils/dates.mjs";
import { askYes, cardTranslator, confirmWorkStart, contractLine, needsAuthorizationLine, readiness, startCard } from "./confirmStart.mjs";
import { loadContract } from "./contract.mjs";
import { deliverOutcome, stdoutLines } from "./delivery.mjs";
import { createTranslator, resolveLocale } from "./i18n.mjs";
import { directoryOfTarget, fileLineRunning, startDirectory } from "./line.mjs";
import { runReviewWorker, validateReviewWorker } from "./review.mjs";
import { waitForPending } from "./reviewQueue.mjs";
import {
  authorizeWorkPackage,
  cancelWorkPackage,
  closeFailedStart,
  createWorkPackagePlan,
  optionAgainstCard,
  planFilePath,
  PLAN_SCHEMA_VERSION,
  workOrderUnchanged,
  workPackageStatus,
} from "./workPackage.mjs";
import {
  canonicalTaskFile, cardFor, cardUsed, clearProject, ensureProject, identifyWorkOrder, markCardShown, recordCard, recordContract, recordStart, withdrawCard,
} from "./workOrderRecords.mjs";
import { refuseForm, writeWorkOrderIds } from "./workOrderForm.mjs";
import { formProblems, parseWorkOrder, sealedText, WorkOrderFormError, workOrderIdOf } from "./workOrderFormat.mjs";
import { runBoundedResume, stopRun, validateBoundedResume } from "./writerLoop.mjs";
import { bridgeRunner } from "../../utils/bridgeCommand.mjs";

export const DEFAULT_BREAKPOINT = "after the review";

// For a work-order file the rest has defaults: the work package is the file name, the plan goes
// to <name>.plan.json in the log folder of the run it proposes, the owner is the signed-in OS user,
// the roles come from bridge.json, and priority, model, effort and budget from the work order or the policy. The breakpoint is asked at a terminal with a
// default that Enter takes; without a terminal start takes the default and work-plan requires it.
// The prompt library is loaded only then, like every other dependency of the runtime.
async function askMissing(options, clack) {
  const answer = await clack.text({
    message: "Where should the work stop and come back to you?",
    placeholder: DEFAULT_BREAKPOINT,
    defaultValue: DEFAULT_BREAKPOINT,
  });
  return clack.isCancel(answer) ? null : { breakpoint: answer };
}

const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

// The plan step work-plan, start and resume share: { plan } or { cancelled }. At a terminal a
// missing breakpoint is asked; without one, start takes the default (an agent runs it, and the card
// it prints shows it), while work-plan still requires it.
const workPackageName = (options) => options.workPackage || (options.taskFile ? path.basename(options.taskFile, path.extname(options.taskFile)) : null);

// RC3-BLOCKER-01: the work order's records are in the person's database, under this project's id.
// A plan without a work-order file (inline --task, the old test path) is no work order and is not
// recorded.
async function openRecords(paths) {
  const config = await readJson(paths.bridgeConfigPath);
  if (!config.project_id) throw new Error("This project was set up before Bridge kept its records in a database. Run: " + bridgeRunner() + " upgrade");
  // The router's opener writes a run's kept events first; a direct call opens it plainly.
  const database = recordsDatabase() || (async () => (await import("../../service/database/index.mjs")).openDatabase());
  const db = await database();
  await ensureProject(db, { projectId: config.project_id, root: paths.repoRoot });
  return { db, projectId: config.project_id };
}

// The project's language for what another feature prints; the router hands this to the graph feature.
export const projectTranslator = (paths) => cardTranslator(paths);

// The project's row, which the graph's rows point at; the router hands this to the graph feature.
export async function recordProject(db, paths) {
  await ensureProject(db, { projectId: paths.projectId, root: paths.repoRoot });
}

// The work order's path in the project, spelled as the file system spells it (the records' key).
const taskFileOf = (paths, file) => canonicalTaskFile(paths.repoRoot, path.resolve(file));

// `batch` is one card's worth of plans (a directory's): its records are opened once, and what does not
// change from file to file (the CLI's state, its list of MCP servers) is asked once.
async function planFromOptions({ paths, options, command, adapter, inspectionAdapter, batch = null, line = null }) {
  const once = (key, work) => (batch ? (batch.cache[key] ??= work()) : work());
  const named = workPackageName(options);
  if (!options.outPath && !(options.taskFile && named)) throw new Error(command + " needs a work order. Run: review-bridge " + command + " .review-bridge/work-packages/<file>.md");
  if (options.update !== undefined && options.asNew) throw new Error("Give --update <work_order_id> or --as-new, not both.");
  let answers = {};
  if (options.taskFile && !options.breakpoint && interactive()) {
    const clack = await import("@clack/prompts");
    answers = await askMissing(options, clack);
    if (answers === null) {
      clack.cancel("Operation cancelled.");
      return { cancelled: true };
    }
  }
  const defaults = command === "start" && !interactive();
  const breakpoint = options.breakpoint || answers.breakpoint || (defaults ? DEFAULT_BREAKPOINT : undefined);
  if (options.taskFile && !breakpoint) throw new Error("A breakpoint is required. Add --breakpoint \"<where to stop>\" or answer the prompt.");
  const raw = options.taskFile ? await fsp.readFile(path.resolve(options.taskFile), "utf8").catch(() => null) : null;
  // What the person wrote, without the id line Bridge keeps in the front matter; the id says which work order.
  const text = raw === null ? null : sealedText(raw);
  // A work order Bridge cannot split, or one without what it must say, is refused, with its lines, before
  // anything about it is recorded.
  const format = text !== null ? parseWorkOrder(text.trim()) : null;
  const form = format ? formProblems(format) : null;
  if (form && !form.ok) throw new WorkOrderFormError(form);
  const records = text !== null ? batch?.records ?? await openRecords(paths) : null;
  const workOrder = records ? await identifyWorkOrder(records.db, {
    projectId: records.projectId, fileName: taskFileOf(paths, options.taskFile), text: text.trim(), id: workOrderIdOf(raw), repoRoot: paths.repoRoot,
    update: options.update, asNew: Boolean(options.asNew),
  }) : null;
  // Calls no model, so it uses the adapter for model-free checks; a fake run's is the fake CLI.
  const modelFree = async () => (adapter?.resolveExecutable ? adapter : await inspectionAdapter());
  // A flag given at the terminal comes before the work order's own budget (settleWorkOrder).
  const plan = await createWorkPackagePlan({
    paths,
    task: options.task,
    taskFile: options.taskFile,
    owner: options.owner || (options.taskFile ? os.userInfo().username : undefined),
    workPackage: named,
    breakpoint,
    allowedPaths: options.allowedPaths,
    rounds: options.rounds,
    callTimeout: options.callTimeout,
    writer: options.writer,
    reviewer: options.reviewer,
    listCodexMcp: () => once("mcp", async () => await listCodexMcpServers(await modelFree())),
    // The fake CLI has nothing to install or sign in to.
    checkCodex: options.fakeCli ? null : () => once("codex", async () => (await inspectProvider("codex", { adapter: await modelFree() })).next_action),
    outPath: options.outPath,
    planName: options.planName,
    workOrder,
    line,
  });
  if (records) await recordCard(records.db, { projectId: records.projectId, plan, snapshot: (await loadOrCreatePolicySnapshot(paths)).snapshot, shown: false });
  return { plan, records };
}

export async function planWork({ paths, options, adapter, inspectionAdapter }) {
  const planned = await planFromOptions({ paths, options, command: "work-plan", adapter, inspectionAdapter });
  if (planned.cancelled) return 1;
  const { plan } = planned;
  // --plain is the human summary (C5.2); --json is what scripts and tests read.
  if (options.plain) {
    process.stdout.write([
      plan.task_file ? "工單：" + plan.task_file : "工作包：" + plan.work_package_id,
      "範圍：" + ({ default: "預設（整個專案減禁改清單）", explicit: "指定" })[plan.scope.source] + "，" + plan.scope.allowed_paths.length + " 條路徑",
      "驗收：" + (plan.test?.kind === "command" ? "會跑 " + plan.test.command + "（profile 核准）" : plan.test?.label || "沒有設定測試"),
      ...(plan.contract_sha256 ? ["合約：" + contractLine(await cardTranslator(paths), plan)] : []),
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
      test: plan.test,
      priority: plan.priority,
      writer: plan.writer,
      reviewer: plan.reviewer,
      budget: plan.budget,
      budget_source: plan.budget_source,
      next_command: "work-start --plan <plan_path>",
    }, null, 2) + "\n");
    return 0;
  }
  const shown = shownPath(plan.plan_path);
  process.stdout.write("Plan written to " + shown + "\nNext: " + bridgeRunner() + " work-start --plan " + shown + "\n");
  return 0;
}

// The plan as sealed and written: the same body without where it was written, as recordCard keeps it.
const sealedBody = ({ plan_path: _written, ...body }) => body;

// A path as the person can paste it back: relative to where they are when that is shorter.
function shownPath(file) {
  const relative = path.relative(process.cwd(), file);
  const shown = relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
  return /\s/.test(shown) ? "\"" + shown + "\"" : shown;
}

// `update` is the graph's own (tests give another). Nothing here stops the run: a record that cannot be
// written is said too, and the run's own next record meets the same database.
export async function updateRunGraph(paths, records, runId, { update = updateGraph, record = appendIoEvent, write = (text) => process.stderr.write(text) } = {}) {
  try {
    await update({ db: records.db, projectId: records.projectId, projectRoot: paths.repoRoot, dataHome: bridgeDataHome() });
    return null;
  } catch (error) {
    const reason = String(error?.message || error);
    const t = await cardTranslator(paths);
    write(t("start.graph_not_updated", { reason }) + "\n");
    await record(paths, runId, { event: "graph_update", updated: false, reason }).catch((recordError) => write(String(recordError?.message || recordError) + "\n"));
    return reason;
  }
}

// Authorizes the approved plan and runs it to its end; every way out delivers once. A work order's
// start is one database transaction around the file authorization (recordStart): the work order and
// its version, the authorization and its claim. When that transaction fails after the run was made,
// the run is closed before any model call.
// A start that holds its plan in memory passes it in and the file it wrote is not read back, as Vite's
// optimizer hands its metadata on in memory and reads _metadata.json only at the next start; work-start
// (`held` null) reads the file it was given.
async function runAuthorized({ paths, options, plan: held = null, adapter, approval, authorizedVia, onStep, endSteps = () => {} }) {
  const plan = held ?? await readJson(path.resolve(options.planPath));
  const records = plan.task_file ? await openRecords(paths) : null;
  let started = null;
  const authorize = async () => (started = await authorizeWorkPackage({
    paths,
    planPath: options.planPath,
    plan,
    approval,
    executionMode: options.fakeCli ? "fake_cli" : "native",
    authorizedVia,
  }));
  let authorization;
  try {
    authorization = records ? await recordStart(records.db, { planSha256: approval, authorize }) : await authorize();
    // The contract the plan sealed is recorded under its SHA-256, against the work order version it came from.
    if (records && plan.contract_sha256) {
      await recordContract(records.db, {
        workOrderId: authorization.workOrderId, contentSha256: plan.task_sha256, contractSha256: plan.contract_sha256, contract: await loadContract(paths, plan.contract_sha256),
      });
    }
    // The work order and its authorization are in the records now, so its id goes into the file, as Jira
    // gives an issue its key before the key is printed on it (Owner 2026-11-08). A check that failed before
    // this point left neither. Before any model call; a file it cannot write closes this start.
    if (records) await writeWorkOrderIds(paths, [{ ...plan, work_order: { ...plan.work_order, work_order_id: authorization.workOrderId } }]);
  } catch (error) {
    if (started) {
      await closeFailedStart(paths, started.run.run_id, error);
      await started.workLock();
    }
    throw error;
  }
  // The project's graph is brought up to date before the writer's first call, from the files Git says
  // changed. The work does not depend on it: a graph that cannot be updated goes into this run's records
  // (the result shows it beside the verdicts, so the person knows the reviewer judged on the old graph),
  // is said in the project's language, and the writer and reviewer read it as it was.
  if (records) await updateRunGraph(paths, records, authorization.run.run_id);
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
      rounds: authorization.plan.budget.rounds,
      callTimeout: authorization.plan.budget.call_timeout,
      startNewSession: true,
      runtimeState: createRunRuntimeState(paths, authorization.run.run_id),
      workLock: authorization.workLock,
      onStep,
    });
  } finally {
    endSteps();
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
  if (!options.planPath) throw new Error("work-start needs a plan. Run: " + bridgeRunner() + " work-plan <file> first, or " + bridgeRunner() + " start <file> to do both.");
  if (options.fakeScenario && !options.fakeCli) {
    throw new Error("--fake-scenario requires --fake-cli. Add --fake-cli, or leave --fake-scenario out.");
  }
  // The gate first: without the proof nothing else is looked at. It asks about the plan's reviewer; a
  // plan that cannot be read is refused below, once the gate has let it through.
  const sealed = await readJson(path.resolve(options.planPath)).catch(() => null);
  await guard(sealed?.reviewer?.provider, sealed?.reviewer ? { off: sealed.reviewer.mcp_off, allow: sealed.reviewer.mcp } : null);
  const relayed = Boolean(options.approval || options.yes);
  const approval = options.approval || await confirmWorkStart(paths, options.planPath, {
    assumeYes: Boolean(options.yes),
    ask: interactive(),
    again: bridgeRunner() + " work-start --plan " + shownPath(path.resolve(options.planPath)).replaceAll("\\", "/") + (options.fakeCli ? " --fake-cli" : ""),
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
    ? "Run: " + bridgeRunner() + " down, then " + again
    : check.reason === "reviewer_not_ready"
      ? "Sign the reviewer in (" + (SIGN_IN_COMMANDS[check.provider] || "see its CLI's help") + "), then run: " + again
      : "Run: " + again + " again" + (check.url ? ", or open " + check.url + " and press Check" : "");
  return [
    "Reviewer read-only check: not passed (" + why + ")",
    ...(check.diagnostic_id ? ["Record: " + check.audit_path + " (" + check.diagnostic_id + ")"] : []),
    next,
  ];
}

const write = (line) => process.stdout.write(line + "\n");

// How a run's steps are shown. At a terminal each step is a clack spinner until the next one starts,
// as init shows its steps (install-guide's spinnerStep), so the wait for a model call is visible; an
// agent, or output that is not a terminal, gets one line per step. `end` stops the last spinner
// before the result is printed.
async function runSteps() {
  if (!interactive()) return { step: (label) => write("  " + label), end: () => {} };
  const { spinner } = await import("@clack/prompts");
  let spin = null;
  let current = null;
  const end = () => {
    spin?.stop(current);
    spin = null;
  };
  return {
    step: (label) => {
      end();
      spin = spinner();
      spin.start(label);
      current = label;
    },
    end,
  };
}

// E8, E10: --yes is the yes to the card printed before it, and one card is one yes. The card is
// found in the database (Q14: this project's latest printed, not withdrawn plan for this file) and
// taken as it is, without planning again: refused when there is none, when the work order no longer
// reads as the card showed it, when an option given beside --yes is not what the card showed, when
// it already started a run, or when it is past its "Valid until". Its plan file in the log folder of
// the run it proposes is written from the database: the file is the running copy.
async function cardForYes({ paths, planName = null, taskFile, options, again }) {
  const { db, projectId } = await openRecords(paths);
  const card = await cardFor(db, { projectId, fileName: taskFileOf(paths, taskFile) });
  // The person was stopped here, so it is said in their language (Owner 2026-11-06), as the card is.
  const t = await cardTranslator(paths);
  const refuse = (line) => { write(line); return null; };
  if (!card) return refuse(t("yes.no_card", { again }));
  // A directory's card printed no work order's text, so its yes is not a yes to this one alone.
  if (card.body.line) return refuse(t("yes.directory_card", { directory: card.body.line.directory, again }));
  if (card.body.schema_version !== PLAN_SCHEMA_VERSION) return refuse(t("yes.old_card", { again }));
  if (!(await workOrderUnchanged({ task_sha256: card.content_sha256 }, taskFile))) return refuse(t("yes.changed", { again }));
  const option = optionAgainstCard(card.body, options);
  if (option) return refuse(t("yes.option", { option, again }));
  if (await cardUsed(db, card.plan_sha256)) return refuse(t("yes.used", { again }));
  if (!(card.authorization_expires_at > new Date())) return refuse(t("yes.expired", { until: card.authorization_expires_at.toISOString(), again }));
  const planPath = options.outPath || planFilePath(paths, card.body, planName);
  await writeJsonAtomic(planPath, card.body);
  write(t("yes.plan_from_card", { path: shownPath(planPath) }));
  return { ...card.body, plan_path: planPath };
}

// The same two lines the reviewer's check prints when its CLI is not ready, here for a role whose CLI
// the plan could not ask: no card was made, so there is nothing to withdraw.
function notReadyLines(error, again) {
  const sign = "(" + SIGN_IN_COMMANDS[error.provider] + ")";
  const next = (error.nextAction === "install_cli" ? "Install the " + error.provider + " CLI and sign it in " + sign : "Sign the " + error.role + " in " + sign) + ", then run: " + again;
  return [
    error.role === "reviewer"
      ? "Reviewer read-only check: not passed (the reviewer CLI is not installed and signed in)"
      : "Writer: not ready (the writer CLI is not installed and signed in)",
    next,
  ];
}

async function planOrSay({ paths, options, command, adapter, inspectionAdapter, again, batch = null, line = null }) {
  let planned;
  try {
    planned = await planFromOptions({ paths, options, command, adapter, inspectionAdapter, batch, line });
  } catch (error) {
    if (error instanceof WorkOrderFormError) {
      const absolute = path.resolve(options.taskFile);
      await refuseForm(await createTranslator(await resolveLocale(paths)), error, { absolute, file: taskFileOf(paths, absolute), again, write });
      return null;
    }
    if (!(error instanceof RoleCliNotReadyError)) throw error;
    for (const line of notReadyLines(error, again)) write(line);
    return null;
  }
  if (planned.plan && !batch) write("Plan written to " + shownPath(planned.plan.plan_path));
  return planned.plan || null;
}

// One work order (Owner 2026-11-08): one card, one yes, the run. The contract was cut by code when the
// plan was made and the card names it, so no model is called before the yes and nothing is asked after it.
// --yes says yes to the card printed last.
async function startFile({ paths, options, adapter, loadAdapter, inspectionAdapter, guard, reviewerCheck, again, planOptions = {}, planName = null, command = "start" }) {
  const { db } = await openRecords(paths);
  const taskFile = planOptions.taskFile ?? options.taskFile;
  const plan = options.yes
    ? await cardForYes({ paths, planName, taskFile, options, again })
    : await planOrSay({ paths, options: { ...options, ...planOptions }, command, adapter, inspectionAdapter, again });
  if (!plan) return 1;
  const ready = readiness({ options, adapter, loadAdapter, guard, reviewerCheck, plan, again, checkFailureLines });
  const t = await cardTranslator(paths);
  write("");
  write(await startCard(paths, plan, t));
  await markCardShown(db, plan.plan_sha256);
  const yesGiven = Boolean(options.yes);
  if (!yesGiven) {
    if (!interactive()) { write(needsAuthorizationLine(t, again)); return 1; }
    if (!(await askYes(t("card.ask")))) {
      await withdrawCard(db, plan.plan_sha256);
      write(t("card.declined"));
      return 1;
    }
  }
  const prepared = await ready();
  if (!prepared) {
    if (!yesGiven) await withdrawCard(db, plan.plan_sha256);
    return 1;
  }
  write("");
  const steps = await runSteps();
  return await runAuthorized({
    paths, options: { ...options, planPath: plan.plan_path }, plan: sealedBody(plan), adapter: prepared.adapter, approval: plan.plan_sha256,
    authorizedVia: yesGiven ? "agent" : "terminal",
    onStep: steps.step,
    endSteps: steps.end,
  });
}

// `start <file>`: the person's one command from a work order to its result. `start <directory>`: the
// same for every work order in a directory of work-packages/, one after another, on one yes.
export async function startWorkOrder({ paths, options, adapter, loadAdapter, inspectionAdapter, guard, reviewerCheck }) {
  if (!options.taskFile) throw new Error("start needs a work order. Run: " + bridgeRunner() + " start .review-bridge/work-packages/<file>.md");
  if (options.fakeScenario && !options.fakeCli) {
    throw new Error("--fake-scenario requires --fake-cli. Add --fake-cli, or leave --fake-scenario out.");
  }
  const directory = await directoryOfTarget(paths, options.taskFile);
  if (directory) {
    const again = bridgeRunner() + " start " + shownPath(directory.absolute).replaceAll("\\", "/") + (options.fakeCli ? " --fake-cli" : "");
    return await startDirectory({
      paths, options, adapter, loadAdapter, guard, reviewerCheck, directory,
      tools: {
        openRecords, interactive, shownPath, checkFailureLines,
        // A role's CLI not ready is said once and ends the card; no card was shown yet to take back.
        planOne: ({ row, batch, line }) => planOrSay({
          paths, command: "start", adapter, inspectionAdapter, batch, line, again,
          options: { ...options, yes: false, taskFile: row.absolute, breakpoint: options.breakpoint || DEFAULT_BREAKPOINT },
        }),
        runPlan: ({ plan, adapter: runAdapter, authorizedVia, onStep }) => runAuthorized({
          paths, options: { ...options, planPath: plan.plan_path }, plan: sealedBody(plan), adapter: runAdapter, approval: plan.plan_sha256, authorizedVia, onStep,
        }),
      },
    });
  }
  const running = await fileLineRunning(paths, openRecords, path.resolve(options.taskFile));
  if (running) { write(running); return 1; }
  // Forward slashes: the command is pasted into any shell, bash included, and Windows takes them.
  const again = bridgeRunner() + " start " + shownPath(path.resolve(options.taskFile)).replaceAll("\\", "/") + (options.fakeCli ? " --fake-cli" : "");
  return await startFile({ paths, options, adapter, loadAdapter, inspectionAdapter, guard, reviewerCheck, again });
}

// `resume <run_id>`: a stopped run is closed for good (its records were sealed by the controller
// that ran it, which no later process can vouch for), so the work order is carried on as a new
// run with that run's own stop point and scope, after the same card and yes. It is a new start: its
// roles come from bridge.json or the flags as they are now, and its priority, model, effort and
// budget from the work order again; the card shows them all.
export async function resumeWorkOrder({ paths, runId, options, adapter, loadAdapter, inspectionAdapter, guard, reviewerCheck }) {
  if (!runId) throw new Error("resume needs a run id. Run: " + bridgeRunner() + " status to see the runs, then " + bridgeRunner() + " resume <run_id>");
  if (options.fakeScenario && !options.fakeCli) {
    throw new Error("--fake-scenario requires --fake-cli. Add --fake-cli, or leave --fake-scenario out.");
  }
  const control = await loadControlView(paths, runId).catch(() => null);
  if (!control) throw new Error("There is no run " + runId + " here. Run: " + bridgeRunner() + " status");
  if (control.authorization_status === "active") throw new Error("Run " + runId + " is still running. Pause it first: " + bridgeRunner() + " stop " + runId);
  const workPackage = control.run.work_package;
  if (!workPackage.task_file) throw new Error("Run " + runId + " was not started from a work order file. Run: " + bridgeRunner() + " start <file>");
  const taskFile = path.join(paths.repoRoot, ...workPackage.task_file.split("/"));
  // resume saves one work order and has nothing to do with its directory's line; it waits for that line.
  const running = await fileLineRunning(paths, openRecords, taskFile);
  if (running) { write(running); return 1; }
  write("Carrying on run " + runId + " (" + workPackage.task_file + ") as a new run");
  // One plan per stopped run, so the card and its --yes name the same one.
  const planName = workPackage.work_package_id + ".resume-" + runId;
  const again = bridgeRunner() + " resume " + runId + (options.fakeCli ? " --fake-cli" : "");
  return await startFile({
    paths, options, adapter, loadAdapter, inspectionAdapter, guard, reviewerCheck, again, planName, command: "resume",
    planOptions: {
      taskFile,
      workPackage: workPackage.work_package_id,
      breakpoint: workPackage.breakpoint,
      allowedPaths: workPackage.scope.source === "explicit" ? workPackage.scope.allowed_paths.join(",") : undefined,
      planName,
    },
  });
}

// `clean --all` (Owner 2026-10-25): the project's work orders, versions, plans, authorizations
// and contracts leave the person's database in one transaction; the project id is kept as cleared
// and never used again. Refused while one of its runs is running, and with a run id.
export async function clearProjectRecords({ paths, runId, options }) {
  if (runId) throw new Error("clean --all clears the whole project; give no run id. Run: " + bridgeRunner() + " clean --all");
  const { db, projectId } = await openRecords(paths);
  const active = await activeRuns(db, projectId);
  if (active.length) throw new Error(active.length + " run(s) of this project are running. Stop them first: " + bridgeRunner() + " stop " + active[0].run_id);
  const counts = await clearProject(db, projectId);
  if (options.json) {
    write(JSON.stringify({ project_id: projectId, cleared: counts }, null, 2));
    return 0;
  }
  write("Cleared this project's records: " + counts.work_orders + " work order(s), " + counts.work_order_versions + " version(s), "
    + counts.plans + " plan(s), " + counts.authorizations + " authorization(s), " + counts.contracts + " contract(s), " + counts.runs + " run(s), "
    + counts.graph_files + " graph file(s).");
  write("This project's id is not used again. To use Bridge here again: " + bridgeRunner() + " uninstall --target ., then " + bridgeRunner() + " init");
  return 0;
}

// `status`: what Bridge is doing now, from the person's database (RC3-BLOCKER-01 step 4): the page,
// this project's runs (Q12, newest first, ten at a time; --after <run_id> is the next page), how
// many are running (Q6), the review queue, and how to look at the tables yourself. --json gives
// the same parts whole.
const STATUS_RUNS = 10;

// What `status` reads from the records, in its order: the database opens, this project's runs are
// listed, the project's log folder is named. The upgrade's check afterwards reads the same (RC3-FIX-02);
// a failure carries the step it stopped at.
export async function statusRecords(paths, { after = null } = {}) {
  let step = "database";
  try {
    const { db, projectId } = await openRecords(paths);
    step = "runs";
    const { runs, more } = await projectRuns(db, projectId, { limit: STATUS_RUNS, after });
    const active = await activeRuns(db, projectId);
    const lines = active.length ? await activeLineSteps(db, projectId) : [];
    step = "logs";
    return { db, projectId, runs, more, active, lines, logs: paths.logRoot };
  } catch (error) {
    error.status_step = step;
    throw error;
  }
}

// `status` only looks (RC3-DOWN-01): a database that `down` stopped is said to be stopped, never started
// to answer, as brew services list reports a service; its runs are shown once it is up again.
// A data directory that does not exist, cannot be read or is no cluster is said with where it is, and
// exits 4, as pg_ctl status does ("If an accessible data directory is not specified, pg_ctl returns an
// exit status of 4"; LSB: status unknown); nothing says up would start it (Fortes 2026-11-09).
// `databaseStatus` and `records` are seams for tests.
// The runs are the database's alone, listed and not totalled, as gh run list does (Fortes 2026-11-08):
// the page service's review-queue folders are its working copy, emptied when it restarts.
const DATA_DIRECTORY_UNUSABLE = 4;

export async function statusOverview({ paths, options, page, databaseStatus = null, records = statusRecords }) {
  if (!(await fileExists(paths.bridgeConfigPath))) {
    write("This folder is not set up for Review Bridge. Run: " + bridgeRunner() + " init");
    return 0;
  }
  const service = await page();
  const t = await createTranslator(await resolveLocale(paths));
  const server = await (databaseStatus ?? (await import("../../service/database/index.mjs")).databaseStatus)();
  if (server.state !== "running") {
    const unusable = server.state === "unusable";
    const exitCode = unusable ? DATA_DIRECTORY_UNUSABLE : 0;
    if (options.json) {
      const detail = unusable ? { problem: server.problem, path: server.path, ...(server.code ? { code: server.code } : {}) } : {};
      write(JSON.stringify({ page: { running: service.running, url: service.url, reason: service.reason }, database: { running: false, ...detail } }, null, 2));
      return exitCode;
    }
    write(service.running ? t("status.page.running", { url: service.url }) : t("status.page.not_running"));
    write(unusable ? t("status.database." + server.problem, { path: server.path, code: server.code }) : t("status.database.stopped"));
    return exitCode;
  }
  const { db, projectId, runs, more, active, lines, logs } = await records(paths, { after: options.after || null });
  const latestReview = (await fsp.readFile(paths.latestPath, "utf8").catch(() => "")).trim() || null;
  // Who the next start uses, from the one place that says it; a run keeps what its card showed.
  const { roles: configured } = await readJson(paths.bridgeConfigPath);
  const roles = { writer: configured?.writer?.provider_id ?? null, reviewer: configured?.reviewer?.provider_id ?? null };
  if (options.json) {
    write(JSON.stringify({
      page: { running: service.running, url: service.url, reason: service.reason },
      roles, project_id: projectId, active_runs: active.length, lines, runs, more, latest_review: latestReview, logs, database: { running: true, ...db.connection },
    }, null, 2));
    return 0;
  }
  // Every line in the project's language, as the database lines beside them are (Fortes 2026-11-09).
  write(service.running ? t("status.page.running", { url: service.url }) : t("status.page.not_running"));
  write(t("status.database.running"));
  if (!runs.length && !options.after) {
    write(t("status.work.none"));
  } else {
    write(t("status.work.running", { count: active.length }));
    for (const { line, source_file: sourceFile, run_id: runId, created_at: startedAt } of lines) {
      write("  " + t("status.work.line", { directory: line.directory, position: line.position, total: line.total, file: path.posix.basename(sourceFile), run: runId, time: localTimestamp(startedAt) }));
    }
    for (const run of runs) {
      write("  " + [run.run_id, run.status.padEnd(11), (run.conclusion || "-").padEnd(15), (run.closed_reason || "-").padEnd(20), run.source_file, localTimestamp(run.created_at)].join("  "));
    }
    if (more) write("  " + t("status.more", { run: runs.at(-1).run_id }));
  }
  if (latestReview) write(t("status.latest_review", { file: latestReview }));
  write(t("status.roles", { writer: roles.writer, reviewer: roles.reviewer }));
  // The run's call logs live outside the project, one folder per run (review-bridge logs <run_id>).
  write(t("status.logs", { folder: logs }));
  // What VS Code's PostgreSQL extension asks for; the password stays in its owner-only file.
  const { host, port, database, user, passwordFile } = db.connection;
  write(t("status.database.vscode"));
  write("  " + t("database.vscode.connection", { host, port, user, database }));
  write("  " + t("database.vscode.password", { file: passwordFile }));
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
  const rounds = options.rounds ?? 2;
  const callTimeout = options.callTimeout ?? 480_000;
  if (rounds < 1 || rounds > 2) throw new Error("Writer rounds must be 1 or 2.");
  if (callTimeout < 60_000 || callTimeout > 900_000) throw new Error("Writer call timeout must be 60000 through 900000 ms.");
  if (options.validateOnly) {
    const result = await validateBoundedResume({
      paths, control: activeControl, adapter, promptPath: options.promptPath, rounds, callTimeout,
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  return await runBoundedResume({
    paths, control: activeControl, adapter, promptPath: options.promptPath, rounds, callTimeout,
    runtimeState,
  });
}

export async function waitForReview({ paths, options }) {
  const timeout = options.timeout ?? 7_200_000;
  if (timeout < 60_000 || timeout > 86_400_000) {
    throw new Error("wait timeout must be 60000 through 86400000 ms.");
  }
  const file = await waitForPending(paths, timeout);
  process.stdout.write(file + "\n");
  return 0;
}
