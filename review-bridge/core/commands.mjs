import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { parseOptions } from "./args.mjs";
import { runBoundedResume, validateBoundedResume } from "./bounded-resume.mjs";
import { getBridgePaths } from "./paths.mjs";
import {
  enqueueReview,
  queueStatus,
  waitForPending,
  writeHookError,
  writeHookWarning,
} from "./queue.mjs";
import { fileExists, parseJson, readJson, readStdin } from "./io.mjs";
import { assertUnder, writeJson } from "./io.mjs";
import {
  applyLegacyControlMigration,
  planLegacyControlMigration,
  rollbackLegacyControlMigration,
} from "./migration-v4.mjs";
import { runReviewWorker, validateReviewWorker } from "./review.mjs";
import { createReviewerProbeService } from "./reviewer-probe.mjs";
import { serviceDown, serviceFiles, serviceStatus, serviceUp } from "./service.mjs";
import { DEFAULT_WATCH_PORT, findPortOwner, portBumpNotice, startWatchServer } from "./watch.mjs";
import {
  authorizeWorkPackage,
  cancelWorkPackage,
  createWorkPackagePlan,
  workPackageStatus,
} from "./work-package.mjs";
import {
  authorizeV4WorkPackage,
  cancelV4WorkPackage,
  createV4WorkPackagePlan,
  v4WorkPackageStatus,
} from "./work-package-v4.mjs";
import {
  assertRunResumable,
  createRunRuntimeState,
  currentClassificationProfile,
  loadControlViewBySession,
  loadSingleActiveControlView,
} from "./state-v4.mjs";

const schemas = {
  enqueue: {
    "--payload": { key: "payloadPath", type: "string" },
    "--no-start": { key: "noStart", type: "boolean" },
    "--validate-only": { key: "validateOnly", type: "boolean" },
  },
  review: {
    "--dry-run": { key: "dryRun", type: "boolean" },
    "--validate-only": { key: "validateOnly", type: "boolean" },
    "--no-notification": { key: "noNotification", type: "boolean" },
  },
  "bounded-resume": {
    "--prompt": { key: "promptPath", type: "string" },
    "--max-claude-calls": { key: "maxCalls", type: "number" },
    "--max-claude-minutes": { key: "maxMinutes", type: "number" },
    "--validate-only": { key: "validateOnly", type: "boolean" },
  },
  "work-plan": {
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
  },
  "work-start": {
    "--plan": { key: "planPath", type: "string" },
    "--approve": { key: "approval", type: "string" },
    "--yes": { key: "yes", type: "boolean" },
    "--fake-cli": { key: "fakeCli", type: "boolean" },
    "--fake-scenario": { key: "fakeScenario", type: "string" },
  },
  "work-cancel": {
    "--reason": { key: "reason", type: "string" },
  },
  "work-status": {},
  status: {},
  "migrate-control": {
    "--out": { key: "outPath", type: "string" },
    "--plan": { key: "planPath", type: "string" },
    "--approve": { key: "approval", type: "string" },
    "--legacy-sha256": { key: "legacySha256", type: "string" },
  },
  wait: {
    "--timeout-minutes": { key: "timeoutMinutes", type: "number" },
  },
  watch: {
    "--port": { key: "port", type: "number" },
    "--fake-cli": { key: "fakeCli", type: "boolean" },
  },
  up: {
    "--fake-cli": { key: "fakeCli", type: "boolean" },
  },
  down: {},
  ps: {},
};

async function confirmV4WorkStart(paths, planPath, assumeYes) {
  const resolvedPlan = assertUnder(path.resolve(planPath), paths.privateRoot, "Work plan");
  const plan = await readJson(resolvedPlan);
  if (plan.schema_version !== 4 || plan.operation !== "start_work_package") {
    throw new Error("Unsupported v4 work plan.");
  }
  if (assumeYes) return plan.plan_sha256;
  process.stdout.write([
    "Work package: " + plan.work_package_id,
    "Owner: " + plan.owner,
    "Breakpoint: " + plan.breakpoint,
    "Allowed change types: " + plan.scope.change_types.join(", "),
    "Allowed paths: " + plan.scope.allowed_paths.join(", "),
    "Claude budget: " + plan.budget.max_claude_calls + " call(s), "
      + plan.budget.max_claude_minutes_per_call + " minute(s) per call",
    "Authorization expires at: " + plan.authorization_expires_at,
    "Task:",
    plan.task,
    "",
  ].join("\n"));
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question("Authorize this work package? [y/N] ");
    if (!/^y(?:es)?$/i.test(answer.trim())) throw new Error("Work package authorization cancelled by user.");
  } finally {
    terminal.close();
  }
  return plan.plan_sha256;
}

async function startWatch({ paths, adapter, adapterId, adapterDefinition, adapterSource, port: portOption }) {
  const config = await readJson(paths.bridgeConfigPath);
  const port = portOption ?? config.watch?.port ?? DEFAULT_WATCH_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("watch port must be 0 through 65535.");
  const roles = { writer: config.roles?.writer?.provider_id, reviewer: config.roles?.reviewer?.provider_id };
  if (!roles.writer || !roles.reviewer) throw new Error("watch requires roles selected by init.");
  const service = createReviewerProbeService({
    roles,
    adapter,
    adapterId,
    adapterConfig: adapterDefinition || null,
    adapterSource,
    // Audit only: the watch process memory is the sole source of a current proof.
    auditPath: path.join(paths.configRoot, "reviewer-probe-audit.json"),
  });
  const watch = await startWatchServer({
    service,
    uiRoot: path.join(paths.bridgeRoot, "ui"),
    port,
    strictPort: config.watch?.strict_port === true,
  });
  if (watch.bumped) {
    const notice = portBumpNotice(watch.requestedPort, watch.url, findPortOwner(watch.requestedPort));
    process.stdout.write(notice + "\n");
    Promise.resolve(adapter.notify?.("Review Bridge", notice)).catch(() => {});
  }
  // The stable URL file is what up, ps, and editors read; it survives restarts.
  await fsp.writeFile(serviceFiles(paths).urlPath, watch.url + "\n", "utf8");
  process.stdout.write("Review Bridge setup page: " + watch.url + "\n"
    + "Opening or refreshing the page uses no model. Press Ctrl+C to stop.\n");
  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await watch.close();
  return 0;
}

export async function dispatchCommand({ command, args, repoRoot, bridgeRoot, adapter, adapterId = null, adapterDefinition = null, adapterSource = null, privateRootName = ".claude" }) {
  const paths = getBridgePaths(repoRoot, bridgeRoot, { privateRootName });
  const migrationAction = command === "migrate-control" ? args[0] : null;
  const commandArgs = command === "migrate-control" ? args.slice(1) : args;
  const options = parseOptions(commandArgs, schemas[command] || {});
  const isV4 = await fileExists(paths.bridgeConfigPath);
  if (command === "migrate-control") {
    if (!isV4) throw new Error("migrate-control requires the v4 runtime configuration.");
    if (migrationAction === "plan") {
      if (!options.outPath) throw new Error("migrate-control plan requires --out.");
      const plan = await planLegacyControlMigration(paths);
      const target = assertUnder(path.resolve(options.outPath), paths.privateRoot, "Migration plan");
      await writeJson(target, plan);
      process.stdout.write(JSON.stringify({ ...plan, plan_path: target }, null, 2) + "\n");
      return 0;
    }
    if (migrationAction === "apply") {
      if (!options.planPath || !options.approval) {
        throw new Error("migrate-control apply requires --plan and --approve.");
      }
      const planPath = assertUnder(path.resolve(options.planPath), paths.privateRoot, "Migration plan");
      const result = await applyLegacyControlMigration(paths, await readJson(planPath), options.approval);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return 0;
    }
    if (migrationAction === "rollback") {
      if (!options.legacySha256) throw new Error("migrate-control rollback requires --legacy-sha256.");
      const result = await rollbackLegacyControlMigration(paths, options.legacySha256);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return 0;
    }
    throw new Error("migrate-control requires plan, apply, or rollback.");
  }
  if (command === "enqueue") {
    const manualPayload = Boolean(options.payloadPath);
    try {
      const input = options.payloadPath
        ? await fsp.readFile(options.payloadPath, "utf8")
        : await readStdin();
      if (!input.trim()) return 0;
      const payload = parseJson(input);
      const control = isV4
        ? await loadControlViewBySession(paths, payload.session_id)
        : await readJson(paths.controlPath);
      const classificationProfile = isV4
        ? await currentClassificationProfile(paths, control)
        : null;
      const result = await enqueueReview({
        payload,
        paths,
        control,
        classificationProfile,
        validateOnly: Boolean(options.validateOnly),
      });
      if (options.validateOnly) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      }
      const diagnosticFailure = [
        "invalid_payload",
        "cwd_mismatch",
        "empty_message",
        "authorization_inactive",
        "session_mismatch",
      ].includes(result.reason);
      if (!result.accepted && diagnosticFailure) {
        await writeHookWarning(paths, result).catch(() => {});
        if (manualPayload) return 2;
      }
      if (result.accepted && !result.duplicate && !options.noStart && !options.validateOnly) {
        await runReviewWorker({ paths, control, adapter });
      }
      return 0;
    } catch (error) {
      await writeHookError(paths, error).catch(() => {});
      return manualPayload ? 2 : 0;
    }
  }

  if (command === "watch") {
    if (!isV4) throw new Error("watch requires the v4 runtime configuration created by init.");
    return await startWatch({ paths, adapter, adapterId, adapterDefinition, adapterSource, port: options.port });
  }
  if (["up", "down", "ps"].includes(command)) {
    if (!isV4) throw new Error(command + " requires the v4 runtime configuration created by init.");
    if (command === "up") {
      return (await serviceUp({
        paths,
        bootstrapPath: path.join(paths.bridgeRoot, "bootstrap.mjs"),
        watchArgs: options.fakeCli ? ["--fake-cli"] : [],
      })).exitCode;
    }
    return (await (command === "down" ? serviceDown : serviceStatus)({ paths })).exitCode;
  }
  if (command === "status") {
    process.stdout.write(JSON.stringify(await queueStatus(paths), null, 2) + "\n");
    return 0;
  }
  if (command === "work-status") {
    process.stdout.write(JSON.stringify(
      isV4 ? await v4WorkPackageStatus(paths) : await workPackageStatus(paths),
      null,
      2,
    ) + "\n");
    return 0;
  }
  if (command === "wait") {
    const timeoutMinutes = options.timeoutMinutes ?? 120;
    if (timeoutMinutes < 1 || timeoutMinutes > 1440) {
      throw new Error("wait timeout must be 1 through 1440 minutes.");
    }
    const file = await waitForPending(paths, timeoutMinutes);
    process.stdout.write(file + "\n");
    return 0;
  }

  const control = isV4 ? null : await readJson(paths.controlPath);
  if (command === "work-plan") {
    if (!options.outPath) throw new Error("work-plan requires --out.");
    const plan = await (isV4 ? createV4WorkPackagePlan : createWorkPackagePlan)({
      paths,
      ...(isV4 ? {} : { control }),
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
    process.stdout.write(JSON.stringify({
      valid: true,
      plan_path: plan.plan_path,
      ...(isV4 ? {} : { plan_sha256: plan.plan_sha256 }),
      work_package: plan.work_package || plan.work_package_id,
      owner: plan.owner,
      breakpoint: plan.breakpoint,
      scope: plan.scope,
      budget: plan.budget,
      next_command: isV4
        ? "work-start --plan <plan_path>"
        : "work-start --plan <plan_path> --approve " + plan.plan_sha256,
    }, null, 2) + "\n");
    return 0;
  }
  if (command === "work-start") {
    if (!options.planPath) throw new Error("work-start requires --plan.");
    if (options.fakeScenario && !options.fakeCli) {
      throw new Error("--fake-scenario requires --fake-cli.");
    }
    const approval = isV4
      ? options.approval || await confirmV4WorkStart(paths, options.planPath, Boolean(options.yes))
      : options.approval;
    if (!approval) throw new Error("Legacy work-start requires --approve.");
    const authorization = await (isV4 ? authorizeV4WorkPackage : authorizeWorkPackage)({
      paths,
      planPath: options.planPath,
      approval,
      executionMode: options.fakeCli ? "fake_cli" : "native",
    });
    const exitCode = await runBoundedResume({
      paths,
      control: authorization.control,
      adapter,
      promptPath: authorization.promptPath,
      maxCalls: authorization.plan.budget.max_claude_calls,
      maxMinutes: authorization.plan.budget.max_claude_minutes_per_call,
      startNewSession: true,
      runtimeState: isV4 ? createRunRuntimeState(paths, authorization.run.run_id) : null,
    });
    process.stdout.write(JSON.stringify(
      isV4 ? await v4WorkPackageStatus(paths, authorization.run.run_id) : await workPackageStatus(paths),
      null,
      2,
    ) + "\n");
    return exitCode;
  }
  if (command === "work-cancel") {
    if (isV4) await cancelV4WorkPackage({ paths, reason: options.reason });
    else await cancelWorkPackage({ paths, reason: options.reason });
    process.stdout.write(JSON.stringify(
      isV4 ? await v4WorkPackageStatus(paths) : await workPackageStatus(paths),
      null,
      2,
    ) + "\n");
    return 0;
  }
  if (command === "review") {
    const activeControl = isV4 ? await loadSingleActiveControlView(paths) : control;
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
  if (command === "bounded-resume") {
    const activeControl = isV4 ? await loadSingleActiveControlView(paths) : control;
    const runtimeState = isV4 ? createRunRuntimeState(paths, activeControl.v4.run_id) : null;
    if (isV4) await assertRunResumable(paths, activeControl.v4.run_id);
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
  throw new Error("Unsupported command: " + command);
}
