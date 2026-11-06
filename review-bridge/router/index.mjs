// The command table: each command's summary, its options (type, default, one line of help), who it
// is for, whether it needs the configuration, and which feature entry it goes to. Help, the
// README's command list and option parsing all read this one table. The router wires features
// together (the work order's delivery into the records, the reviewer check into start) and adds
// the start gate; the order of steps is the features'.
import { parseOptions } from "./args.mjs";
import { assertNativeAllowed, assertReviewerProof } from "./guards/nativeGate.mjs";
import * as backup from "../features/backup/index.mjs";
import * as records from "../features/records/index.mjs";
import * as setupCheck from "../features/setupCheck/index.mjs";
import * as workOrder from "../features/workOrder/index.mjs";
import {
  createRunRecorder, deleteRunRecords, fileExists, installRunRecorder, readJson, rebuildRunFiles, recordsDatabase, replayUnrecorded,
} from "../service/index.mjs";
import { getBridgePaths } from "../utils/paths.mjs";

// clean <run_id> also removes the run from the person's database: one delete, and every row it owns
// goes with it; its authorization and claim stay, so its card never takes another yes.
const forgetRunRecords = () => async (runId) => {
  const database = recordsDatabase();
  return database ? await deleteRunRecords(await database(), runId) : 0;
};

// A run is given its result before the records fold or remove it; the human is not notified.
const deliverQuietly = ({ paths, adapter }) => (runId) => workOrder.deliverOutcome({ paths, runId, adapter, notify: false });

// T0-08: the same gate as bootstrap again, because dispatchCommand can be called without it.
const startGate = ({ command, args, paths, options }) => async (reviewer, mcp) => {
  assertNativeAllowed({ command, args });
  if (!options.fakeCli) await assertReviewerProof(paths, { reviewer, mcp });
};

const PROVIDER = "<claude|codex>";
// Options shared by several commands. `internal` options are for tests and agents and are shown
// only by --help --all, like the agent commands.
const FAKE_CLI = { key: "fakeCli", type: "boolean", internal: true, help: "Use the built-in fake CLI instead of a model (tests and self-checks)" };
const FAKE_SCENARIO = { key: "fakeScenario", type: "string", value: "<name>", default: "PASS", internal: true, help: "Fake CLI outcome: PASS, FAIL_THEN_PASS, HARD_STOP or RATE_LIMIT" };
const JSON_OUT = { key: "json", type: "boolean", help: "Print the result as JSON" };
const AFTER = { key: "after", type: "string", value: "<run_id>", default: "the newest runs", help: "Show the ten runs after this one (the next page)" };
// The person's yes to the card, relayed by an agent: without a terminal start and resume print the
// card and stop, and the agent runs the same command again with --yes once the person said yes.
const YES = { key: "yes", type: "boolean", help: "The person said yes to the card; an agent adds this after showing them the card" };
const reviewerCheckFor = (context) => ({ onStart, reviewer, mcp }) => setupCheck.ensureReviewerChecked({ paths: context.paths, onStart, reviewer, mcp });
const WORK_ORDER_OPTIONS = {
  "--writer": { key: "writer", type: "string", value: PROVIDER, default: "the writer in bridge.json", help: "Writer for this run only; the card shows it" },
  "--reviewer": { key: "reviewer", type: "string", value: PROVIDER, default: "the reviewer in bridge.json", help: "Reviewer for this run only; the card shows it" },
  "--breakpoint": { key: "breakpoint", type: "string", value: "<text>", default: "after the review, asked at a terminal", help: "Where the work stops and comes back to you" },
  "--allow-paths": { key: "allowedPaths", type: "string", value: "<list>", default: "the whole project except protected files", help: "Limit the work to these paths, comma-separated" },
  "--owner": { key: "owner", type: "string", value: "<name>", default: "your OS user name", help: "Who owns the work" },
  "--work-package": { key: "workPackage", type: "string", value: "<id>", default: "the work order's file name", help: "Name of the work package" },
  "--rounds": { key: "rounds", type: "number", value: "<n>", default: "the work order's budget, else the policy limit", help: "Writer rounds this work may use; comes before the work order's budget" },
  "--call-timeout": { key: "callTimeout", type: "number", value: "<ms>", default: "the work order's budget, else the policy limit", help: "Milliseconds each writer call may run; comes before the work order's budget" },
  // The card says which work order this file is; these print another card that says otherwise.
  "--update": { key: "update", type: "string", value: "<work_order_id>", default: "what Bridge finds, shown on the card", help: "Make this a new version of that work order" },
  "--as-new": { key: "asNew", type: "boolean", help: "Make this a new work order" },
};

export const COMMANDS = {
  init: {
    audience: "human",
    installer: true,
    summary: "Set up Review Bridge in this folder: asks for the writer, the reviewer and the project type",
    note: "Afterwards you start work through your agent: in Claude Code type /review-bridge start <file>; in Codex, $review-bridge start <file>. review-bridge start <file> at a terminal is for advanced use and CI.",
    options: {
      "--target": { key: "target", type: "string", value: "<folder>", default: "the current folder", help: "Set up this folder instead" },
      "--writer": { key: "writer", type: "string", value: PROVIDER, default: "your saved default, else claude", help: "Writer role" },
      "--reviewer": { key: "reviewer", type: "string", value: PROVIDER, default: "your saved default, else codex", help: "Reviewer role" },
      "--profile": { key: "profile", type: "string", value: "<type|none>", default: "what detection finds, else none", help: "Project type; its test command becomes the tests a run executes" },
      "--port": { key: "port", type: "number", value: "<n>", default: "8080, or the next free port", help: "Port of the local page" },
      "--yes": { key: "yes", type: "boolean", help: "Ask nothing; use the defaults" },
      "--json": { key: "json", type: "boolean", help: "Ask nothing; print the result as JSON" },
      "--fake-cli": { ...FAKE_CLI, key: "fake-cli" },
    },
  },
  start: {
    audience: "human",
    positional: "taskFile",
    usage: "<file>",
    summary: "Run a work order: plan it, check the reviewer can only read, show what you authorize, ask once, then run it",
    options: {
      ...WORK_ORDER_OPTIONS,
      "--yes": YES,
      "--fake-cli": FAKE_CLI,
      "--fake-scenario": FAKE_SCENARIO,
    },
    run: (context) => workOrder.startWorkOrder({ ...context, guard: startGate(context), reviewerCheck: reviewerCheckFor(context) }),
  },
  stop: {
    audience: "human",
    takesRunId: true,
    usage: "<run_id>",
    summary: "Pause a running work order: its model process is stopped and its records are kept (resume <run_id> carries it on)",
    options: {},
    run: (context) => workOrder.stopWork(context),
  },
  resume: {
    audience: "human",
    takesRunId: true,
    usage: "<run_id>",
    summary: "Carry on a stopped work order: a new run of the same work order with the same stop point and scope; its roles, models, effort and budget are settled again, and the same card and yes as start show them",
    options: { "--writer": WORK_ORDER_OPTIONS["--writer"], "--reviewer": WORK_ORDER_OPTIONS["--reviewer"], "--yes": YES, "--fake-cli": FAKE_CLI, "--fake-scenario": FAKE_SCENARIO },
    run: (context) => workOrder.resumeWorkOrder({ ...context, guard: startGate(context), reviewerCheck: reviewerCheckFor(context) }),
  },
  clean: {
    audience: "human",
    takesRunId: "optional",
    usage: "[<run_id>]",
    summary: "Clear records: without a run id, fold finished runs into day files and drop what is past retention; with one, remove that finished run (a running one is refused)",
    options: {
      "--all": { key: "all", type: "boolean", help: "Clear this project's work orders, versions, plans and contracts from your database (refused while a run is running)" },
      "--json": { ...JSON_OUT, help: "Print the result as JSON (without a run id)" },
    },
    run: (context) => (context.options.all
      ? workOrder.clearProjectRecords(context)
      : context.runId
        ? records.removeRecord(context.paths, context.runId, { deliver: deliverQuietly(context), forget: forgetRunRecords(context) })
        : records.runPrune(context.paths, { json: Boolean(context.options.json), deliver: deliverQuietly(context) })),
  },
  // status and wait only read; every other command needs the configuration.
  status: {
    audience: "human",
    configFree: true,
    summary: "Show what Bridge is doing now: the page, this project's runs, the review queue, and how to look at the database",
    options: { "--after": AFTER, "--json": { ...JSON_OUT } },
    run: (context) => workOrder.statusOverview({ ...context, page: () => setupCheck.checkService(context.paths) }),
  },
  logs: {
    audience: "human",
    positional: "target",
    usage: "<run_id|file>",
    summary: "Show a run's log folder and what each file in it is; for a work order (its file or source_id), its runs newest first",
    options: { "--after": AFTER, "--json": { ...JSON_OUT, help: "Print the result as JSON, with the same run fields as work-status" } },
    run: (context) => workOrder.showLogs(context),
  },
  up: {
    audience: "human",
    summary: "Start the local page service in the background",
    options: { "--fake-cli": FAKE_CLI },
    run: (context) => setupCheck.upService(context),
  },
  down: {
    audience: "human",
    summary: "Stop the local page service",
    options: {},
    run: (context) => setupCheck.downService(context),
  },
  ps: {
    audience: "human",
    summary: "Show whether the local page service is running, and its address",
    options: {},
    run: (context) => setupCheck.showService(context),
  },
  watch: {
    audience: "human",
    summary: "Run the local page in this terminal until Ctrl+C",
    options: {
      "--port": { key: "port", type: "number", value: "<n>", default: "the port init chose", help: "Port of the local page" },
      "--fake-cli": FAKE_CLI,
    },
    run: (context) => setupCheck.startWatch({
      ...context,
      port: context.options.port,
      daily: () => records.runPrune(context.paths, { deliver: deliverQuietly(context) }),
    }),
  },
  upgrade: {
    audience: "human",
    installer: true,
    summary: "Move this folder's setup to the installed Review Bridge version, with a backup",
    options: {
      "--target": { key: "target", type: "string", value: "<folder>", default: "the current folder", help: "Upgrade this folder instead" },
      "--rollback": { key: "rollback", type: "boolean", help: "Undo the last upgrade from its backup" },
      "--plan-out": { key: "plan-out", type: "string", value: "<file>", help: "Write the plan to a file instead of asking" },
      "--plan": { key: "plan", type: "string", value: "<file>", help: "Apply a plan written by --plan-out (needs --approve)" },
      "--approve": { key: "approve", type: "string", value: "<sha>", help: "The plan's SHA-256, as printed by --plan-out" },
      "--backup-root": { key: "backup-root", type: "string", value: "<folder>", default: "Review Bridge's backup folder", help: "Where the backup goes" },
      "--json": { ...JSON_OUT },
      "--yes": { key: "yes", type: "boolean", internal: true, help: "Refused: confirm at a terminal, or use --plan-out then --plan --approve" },
    },
  },
  uninstall: {
    audience: "human",
    installer: true,
    summary: "Remove Review Bridge from a folder, with a backup (Review Bridge itself: npm uninstall -g review-bridge)",
    options: {
      "--target": { key: "target", type: "string", value: "<folder>", required: true, help: "The folder to remove the setup from" },
      "--plan-out": { key: "plan-out", type: "string", value: "<file>", help: "Write the plan to a file instead of asking" },
      "--plan": { key: "plan", type: "string", value: "<file>", help: "Apply a plan written by --plan-out (needs --approve)" },
      "--approve": { key: "approve", type: "string", value: "<sha>", help: "The plan's SHA-256, as printed by --plan-out" },
      "--backup-root": { key: "backup-root", type: "string", value: "<folder>", default: "Review Bridge's backup folder", help: "Where the backup goes" },
      "--json": { ...JSON_OUT },
      "--yes": { key: "yes", type: "boolean", internal: true, help: "Refused: confirm at a terminal, or use --plan-out then --plan --approve" },
    },
  },
  vscode: {
    audience: "human",
    installer: true,
    summary: "Add Bridge's tasks to VS Code's task list, in this project's .vscode/tasks.json; with --user, in your user tasks for all projects",
    options: {
      "--user": { key: "user", type: "boolean", help: "Write to your VS Code user tasks instead of this project" },
      "--target": { key: "target", type: "string", value: "<folder>", default: "the current folder", help: "Write to this set-up folder instead" },
      "--json": { ...JSON_OUT },
    },
  },
  doctor: {
    audience: "human",
    configFree: true,
    summary: "Check which platform adapter this machine uses, without running any work",
    options: { "--fake-cli": FAKE_CLI },
  },
  backup: {
    audience: "human",
    configFree: true,
    summary: "Copy your database, for all your projects, with the database stopped (refused while a run is running)",
    options: {},
    run: () => backup.backupDatabase(),
  },
  "work-plan": {
    audience: "agent",
    positional: "taskFile",
    usage: "<file>",
    summary: "Seal a work order into a plan without starting it (start does this for you)",
    options: {
      ...WORK_ORDER_OPTIONS,
      "--task-file": { key: "taskFile", type: "string", value: "<file>", help: "The work order, instead of giving it first" },
      "--task": { key: "task", type: "string", value: "<text>", internal: true, help: "Work text instead of a work order file (needs --allow-paths)" },
      "--out": { key: "outPath", type: "string", value: "<file>", default: "<name>.plan.json in the run's log folder", help: "Where the plan is written" },
      "--plain": { key: "plain", type: "boolean", help: "Print a short summary of the plan" },
      "--json": { ...JSON_OUT },
      "--fake-cli": FAKE_CLI,
    },
    run: (context) => workOrder.planWork(context),
  },
  "work-start": {
    audience: "agent",
    summary: "Start a sealed plan on the person's yes (start does this for you)",
    options: {
      "--plan": { key: "planPath", type: "string", value: "<file>", required: true, help: "The plan written by work-plan" },
      "--approve": { key: "approval", type: "string", value: "<sha>", internal: true, help: "The plan's SHA-256, as the person's yes" },
      "--yes": YES,
      "--fake-cli": FAKE_CLI,
      "--fake-scenario": FAKE_SCENARIO,
      // T0-07 V3.3: the status JSON is opt-in; the default is three plain lines.
      "--json": { ...JSON_OUT, help: "Print the run's state as JSON at the end" },
    },
    run: (context) => workOrder.startWork({ ...context, guard: startGate(context) }),
  },
  "work-status": {
    audience: "agent",
    summary: "Show the current work as JSON: this project's runs and the newest one in detail",
    options: { "--after": AFTER },
    run: (context) => workOrder.workStatus(context),
  },
  "work-cancel": {
    audience: "agent",
    summary: "Cancel the active authorization so the run cannot continue",
    options: {
      "--reason": { key: "reason", type: "string", value: "<text>", required: true, help: "Why it is cancelled" },
      "--run": { key: "runId", type: "string", value: "<run_id>", default: "the only active run", help: "Which run" },
    },
    run: (context) => workOrder.cancelWork(context),
  },
  review: {
    audience: "agent",
    summary: "Run the review worker on queued work (internal; refused with real models)",
    options: {
      "--dry-run": { key: "dryRun", type: "boolean", help: "Show what would be reviewed" },
      "--validate-only": { key: "validateOnly", type: "boolean", help: "Only check that a review could run" },
      "--no-notification": { key: "noNotification", type: "boolean", help: "Do not show a desktop notification" },
    },
    run: (context) => workOrder.reviewWork(context),
  },
  "bounded-resume": {
    audience: "agent",
    summary: "Internal: resume the writer session of the one active run (refused with real models; resume <run_id> is the command for people)",
    options: {
      "--prompt": { key: "promptPath", type: "string", value: "<file>", required: true, help: "The prompt file" },
      "--rounds": { key: "rounds", type: "number", value: "<n>", default: "2", help: "Writer rounds" },
      "--call-timeout": { key: "callTimeout", type: "number", value: "<ms>", default: "480000", help: "Milliseconds per writer call" },
      "--validate-only": { key: "validateOnly", type: "boolean", help: "Only check that the resume could run" },
    },
    run: (context) => workOrder.resumeWork(context),
  },
  wait: {
    audience: "agent",
    configFree: true,
    summary: "Wait for the next queued review report and print its path",
    options: { "--timeout": { key: "timeout", type: "number", value: "<ms>", default: "7200000", help: "How long to wait, in milliseconds" } },
    run: (context) => workOrder.waitForReview(context),
  },
  prune: {
    audience: "agent",
    summary: "Same as clean without a run id",
    options: { "--json": { ...JSON_OUT } },
    run: (context) => records.runPrune(context.paths, { json: Boolean(context.options.json), deliver: deliverQuietly(context) }),
  },
  rm: {
    audience: "agent",
    takesRunId: true,
    usage: "<run_id>",
    summary: "Same as clean <run_id>",
    options: {},
    run: (context) => records.removeRecord(context.paths, context.runId, { deliver: deliverQuietly(context), forget: forgetRunRecords(context) }),
  },
  "roles-check": {
    audience: "agent",
    installer: true,
    summary: "Check that the writer and reviewer CLIs are installed and signed in, without a model call",
    options: {
      "--writer": { key: "writer", type: "string", value: PROVIDER, help: "Writer role, asked at a terminal when not given" },
      "--reviewer": { key: "reviewer", type: "string", value: PROVIDER, help: "Reviewer role, asked at a terminal when not given" },
      "--json": { ...JSON_OUT },
      "--yes": { key: "yes", type: "boolean", internal: true, help: "Ask nothing" },
    },
  },
};

// Every command that is not the installer's also takes the project folder (bootstrap reads it
// before the command's own options).
export const PROJECT_OPTION = Object.freeze({
  "--project": { key: "project", type: "string", value: "<folder>", default: "the current folder", help: "The project folder" },
});

// The help line printed after a refusal of the command line itself.
export function helpHint(command) {
  return COMMANDS[command] ? " Run: review-bridge " + command + " --help" : " Run: review-bridge --help";
}

// Splits a command line into the run id, the positional work order and the options of the table.
export function parseCommandLine(command, args) {
  const entry = COMMANDS[command];
  if (!entry) throw new Error("Unknown command: " + command + "." + helpHint(null));
  const hasRunId = entry.takesRunId === true || (entry.takesRunId === "optional" && args[0] !== undefined && !args[0].startsWith("--"));
  const runId = hasRunId ? args[0] : null;
  let rest = hasRunId ? args.slice(1) : args;
  const positional = entry.positional && rest[0] !== undefined && !rest[0].startsWith("--") ? rest[0] : null;
  if (positional !== null) rest = rest.slice(1);
  let options;
  try {
    options = parseOptions(rest, entry.options);
  } catch (error) {
    throw new Error(error.message.replace(/\.$/, "") + "." + helpHint(command));
  }
  if (positional !== null) {
    if (options[entry.positional] !== undefined) throw new Error("Give the work order once: either " + positional + " or --task-file.");
    options[entry.positional] = positional;
  }
  return { runId, options };
}

// RC3-BLOCKER-01 step 3: in a project with an id, every run fact this process writes also goes to the
// person's database, which is opened on the first one (a command that writes none never opens it).
async function recordRunsOf(paths) {
  const config = await readJson(paths.bridgeConfigPath).catch(() => null);
  if (!config?.project_id) return;
  // Once the database opens, the events a run kept while it was gone are written first.
  let ready = null;
  const database = async () => {
    const db = await (await import("../service/database/index.mjs")).openDatabase();
    ready ??= replayUnrecorded(db, paths, { rebuild: (runId) => rebuildRunFiles(paths, runId, db) }).catch((error) => { ready = null; throw error; });
    await ready;
    return db;
  };
  installRunRecorder(createRunRecorder(database), database);
}

// `loadAdapter` is how start and resume take the platform adapter when it was not given: only after
// the reviewer check and the yes.
export async function dispatchCommand({ command, args, repoRoot, bridgeRoot, adapter, loadAdapter = null, inspectionAdapter = null, adapterId = null, adapterDefinition = null, adapterSource = null, privateRootName }) {
  const paths = getBridgePaths(repoRoot, bridgeRoot, { privateRootName });
  const entry = COMMANDS[command];
  if (!entry?.run) throw new Error("Unknown command: " + command + "." + helpHint(null));
  const { runId, options } = parseCommandLine(command, args);
  if (!entry.configFree && !(await fileExists(paths.bridgeConfigPath))) {
    throw new Error("This folder is not set up for Review Bridge. Run: review-bridge init");
  }
  await recordRunsOf(paths);
  return await entry.run({ command, args, paths, options, runId, adapter, loadAdapter, inspectionAdapter, adapterId, adapterDefinition, adapterSource });
}
