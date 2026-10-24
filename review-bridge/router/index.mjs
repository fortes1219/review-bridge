// The command table: each command's options, whether it needs the configuration, and which
// feature entry it goes to. The router wires features together (the work order's delivery into
// the records and the setup page) and adds the start gate; the order of steps is the features'.
import { parseOptions } from "./args.mjs";
import { assertNativeAllowed, assertReviewerProof } from "./guards/nativeGate.mjs";
import * as records from "../features/records/index.mjs";
import * as setupCheck from "../features/setupCheck/index.mjs";
import * as workOrder from "../features/workOrder/index.mjs";
import { fileExists } from "../service/index.mjs";
import { getBridgePaths } from "../utils/paths.mjs";

// A run is given its result before the records fold or remove it; the human is not notified.
const deliverQuietly = ({ paths, adapter }) => (runId) => workOrder.deliverOutcome({ paths, runId, adapter, notify: false });

// T0-08: the same gate as bootstrap again, because dispatchCommand can be called without it.
const startGate = ({ command, args, paths, options }) => async () => {
  assertNativeAllowed({ command, args, stdinIsTTY: Boolean(process.stdin.isTTY), stdoutIsTTY: Boolean(process.stdout.isTTY) });
  if (!options.fakeCli) await assertReviewerProof(paths);
};

const COMMANDS = {
  review: {
    options: {
      "--dry-run": { key: "dryRun", type: "boolean" },
      "--validate-only": { key: "validateOnly", type: "boolean" },
      "--no-notification": { key: "noNotification", type: "boolean" },
    },
    run: (context) => workOrder.reviewWork(context),
  },
  "bounded-resume": {
    options: {
      "--prompt": { key: "promptPath", type: "string" },
      "--max-claude-calls": { key: "maxCalls", type: "number" },
      "--max-claude-minutes": { key: "maxMinutes", type: "number" },
      "--validate-only": { key: "validateOnly", type: "boolean" },
    },
    run: (context) => workOrder.resumeWork(context),
  },
  "work-plan": {
    options: {
      "--task": { key: "task", type: "string" },
      "--task-file": { key: "taskFile", type: "string" },
      "--owner": { key: "owner", type: "string" },
      "--work-package": { key: "workPackage", type: "string" },
      "--breakpoint": { key: "breakpoint", type: "string" },
      "--change-types": { key: "changeTypes", type: "string" },
      "--allow-paths": { key: "allowedPaths", type: "string" },
      "--max-claude-calls": { key: "maxCalls", type: "number" },
      "--max-claude-minutes": { key: "maxMinutes", type: "number" },
      "--out": { key: "outPath", type: "string" },
      "--plain": { key: "plain", type: "boolean" },
    },
    // `work-plan <file>` is the same as `work-plan --task-file <file>`.
    positional: "taskFile",
    run: (context) => workOrder.planWork(context),
  },
  "work-start": {
    options: {
      "--plan": { key: "planPath", type: "string" },
      "--approve": { key: "approval", type: "string" },
      "--yes": { key: "yes", type: "boolean" },
      "--fake-cli": { key: "fakeCli", type: "boolean" },
      "--fake-scenario": { key: "fakeScenario", type: "string" },
      // T0-07 V3.3: the status JSON is opt-in; the default is three plain lines.
      "--json": { key: "json", type: "boolean" },
    },
    run: (context) => workOrder.startWork({ ...context, guard: startGate(context) }),
  },
  "work-cancel": {
    options: { "--reason": { key: "reason", type: "string" }, "--run": { key: "runId", type: "string" } },
    run: (context) => workOrder.cancelWork(context),
  },
  "work-status": {
    options: {},
    run: (context) => workOrder.workStatus(context),
  },
  // status and wait only read the review queue; every other command needs the configuration.
  status: {
    options: {},
    configFree: true,
    run: (context) => workOrder.reviewQueueStatus(context),
  },
  wait: {
    options: { "--timeout-minutes": { key: "timeoutMinutes", type: "number" } },
    configFree: true,
    run: (context) => workOrder.waitForReview(context),
  },
  watch: {
    options: {
      "--port": { key: "port", type: "number" },
      "--fake-cli": { key: "fakeCli", type: "boolean" },
    },
    run: (context) => setupCheck.startWatch({
      ...context,
      port: context.options.port,
      daily: () => records.runPrune(context.paths, { deliver: deliverQuietly(context) }),
    }),
  },
  up: {
    options: { "--fake-cli": { key: "fakeCli", type: "boolean" } },
    run: (context) => setupCheck.upService(context),
  },
  down: {
    options: {},
    run: (context) => setupCheck.downService(context),
  },
  ps: {
    options: {},
    run: (context) => setupCheck.showService(context),
  },
  prune: {
    options: { "--json": { key: "json", type: "boolean" } },
    run: (context) => records.runPrune(context.paths, { json: Boolean(context.options.json), deliver: deliverQuietly(context) }),
  },
  rm: {
    options: {},
    takesRunId: true,
    run: (context) => records.removeRecord(context.paths, context.runId, { deliver: deliverQuietly(context) }),
  },
  stop: {
    options: {},
    takesRunId: true,
    run: (context) => workOrder.stopWork(context),
  },
};

export async function dispatchCommand({ command, args, repoRoot, bridgeRoot, adapter, adapterId = null, adapterDefinition = null, adapterSource = null, privateRootName }) {
  const paths = getBridgePaths(repoRoot, bridgeRoot, { privateRootName });
  const entry = COMMANDS[command];
  const runId = entry?.takesRunId ? args[0] : null;
  let rest = entry?.takesRunId ? args.slice(1) : args;
  const positional = entry?.positional && rest[0] !== undefined && !rest[0].startsWith("--") ? rest[0] : null;
  if (positional !== null) rest = rest.slice(1);
  const options = parseOptions(rest, entry?.options || {});
  if (positional !== null) {
    if (options[entry.positional] !== undefined) throw new Error("Give the work order once: either " + positional + " or --task-file.");
    options[entry.positional] = positional;
  }
  if (!entry?.configFree && !(await fileExists(paths.bridgeConfigPath))) {
    throw new Error(command + " requires the runtime configuration created by init.");
  }
  if (!entry) throw new Error("Unsupported command: " + command);
  return await entry.run({ command, args, paths, options, runId, adapter, adapterId, adapterDefinition, adapterSource });
}
