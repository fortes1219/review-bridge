import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { parseOptions } from "./args.mjs";
import { runBoundedResume, stopRun, validateBoundedResume } from "./bounded-resume.mjs";
import { GateAError } from "./gate-a.mjs";
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
import { formatPruneSummary, prune, removeRun, RetentionConfigError } from "./retention.mjs";
import { removeServiceSession, serviceDown, serviceFiles, serviceStatus, serviceUp, writeServiceSession } from "./service.mjs";
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
    "--plain": { key: "plain", type: "boolean" },
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
  prune: {
    "--json": { key: "json", type: "boolean" },
  },
  rm: {},
  stop: {},
};

// T0-02 R3: one entry point for every prune trigger (CLI, watch start, daily timer).
async function runPrune(paths, { json = false, out = process.stdout } = {}) {
  const config = (await fileExists(paths.bridgeConfigPath)) ? await readJson(paths.bridgeConfigPath).catch(() => ({})) : {};
  let ttlSeconds = 86_400;
  for (const file of [paths.defaultPolicyPath, paths.policyOverridePath]) {
    const policy = (await fileExists(file)) ? await readJson(file).catch(() => null) : null;
    if (Number.isInteger(policy?.limits?.authorization_ttl_seconds)) ttlSeconds = policy.limits.authorization_ttl_seconds;
  }
  try {
    const summary = await prune(paths, { config, ttlSeconds });
    out.write(json ? JSON.stringify(summary, null, 2) + "\n" : formatPruneSummary(summary) + "\n");
    return summary.merge_errors.length ? 1 : 0;
  } catch (error) {
    if (error instanceof RetentionConfigError) {
      out.write("沒有清：" + error.message + "\n");
      return 1;
    }
    throw error;
  }
}

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
  // C1: the listening process records itself; up, ps, down and init verify against this.
  await writeServiceSession(paths, {
    pid: process.pid, port: watch.port, url: watch.url, service_id: watch.serviceId, started_at: new Date().toISOString(),
  });
  await fsp.writeFile(serviceFiles(paths).urlPath, watch.url + "\n", "utf8");
  // T0-02 R3.4: prune at start and once a day while the service runs.
  await runPrune(paths).catch((error) => process.stderr.write("prune: " + error.message + "\n"));
  const pruneTimer = setInterval(() => {
    runPrune(paths).catch((error) => process.stderr.write("prune: " + error.message + "\n"));
  }, 86_400_000);
  pruneTimer.unref();
  process.stdout.write("Review Bridge setup page: " + watch.url + "\n"
    + "Opening or refreshing the page uses no model. Press Ctrl+C to stop.\n");
  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  clearInterval(pruneTimer);
  await watch.close();
  await removeServiceSession(paths);
  return 0;
}

export async function dispatchCommand({ command, args, repoRoot, bridgeRoot, adapter, adapterId = null, adapterDefinition = null, adapterSource = null, privateRootName = ".claude" }) {
  const paths = getBridgePaths(repoRoot, bridgeRoot, { privateRootName });
  const migrationAction = command === "migrate-control" ? args[0] : null;
  const removeTarget = command === "rm" || command === "stop" ? args[0] : null;
  const commandArgs = ["migrate-control", "rm", "stop"].includes(command) ? args.slice(1) : args;
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
      // T0-02 R5.1: a Claude session with no Bridge run is the normal case for every
      // other session in the repo; it is not an error and is not logged.
      if (/Expected exactly one active run/.test(String(error?.message || ""))) return manualPayload ? 2 : 0;
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
  if (command === "prune") {
    if (!isV4) throw new Error("prune requires the v4 runtime configuration created by init.");
    return await runPrune(paths, { json: Boolean(options.json) });
  }
  if (command === "stop") {
    if (!isV4) throw new Error("stop requires the v4 runtime configuration created by init.");
    if (!removeTarget) throw new Error("stop requires a run id.");
    const result = await stopRun(paths, removeTarget);
    process.stdout.write(result.line + "\n");
    return result.exitCode;
  }
  if (command === "rm") {
    if (!isV4) throw new Error("rm requires the v4 runtime configuration created by init.");
    if (!removeTarget) throw new Error("rm requires a run id.");
    const result = await removeRun(paths, removeTarget);
    process.stdout.write(result.line + "\n");
    return result.exitCode;
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
    let plan;
    try {
      plan = await (isV4 ? createV4WorkPackagePlan : createWorkPackagePlan)({
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
    } catch (error) {
      // T0-06 G2.3: no approved test entry point for non-docs work; nothing is written.
      if (!(error instanceof GateAError)) throw error;
      process.stdout.write(options.plain
        ? error.plain() + "\n"
        : JSON.stringify({ valid: false, reason: error.reason, checked: error.checked }, null, 2) + "\n");
      return 1;
    }
    // JSON stays the default because the installer and tests read it; --plain is the human summary (C5.2).
    if (isV4 && options.plain) {
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
        "下一步：work-start --plan " + plan.plan_path + " --approve " + plan.plan_sha256,
      ].join("\n") + "\n");
      return 0;
    }
    process.stdout.write(JSON.stringify({
      valid: true,
      plan_path: plan.plan_path,
      ...(isV4 ? {} : { plan_sha256: plan.plan_sha256 }),
      work_package: plan.work_package || plan.work_package_id,
      owner: plan.owner,
      breakpoint: plan.breakpoint,
      scope: plan.scope,
      ...(isV4 ? { gate_a: plan.gate_a } : {}),
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
      authorizedVia: options.approval ? "approve_flag" : options.yes ? "yes_flag" : "terminal",
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
