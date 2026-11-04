#!/usr/bin/env node

import "./review-bridge/utils/nodeVersion.mjs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { assertSupportedStateFilesystem } from "./review-bridge/service/index.mjs";
import { databaseLines, runGuide } from "./installer/install-guide.mjs";
import { renderCommandHelp, renderMainHelp } from "./review-bridge/router/help.mjs";
import { COMMANDS, parseCommandLine } from "./review-bridge/router/index.mjs";
import { inspectRoleReadiness, PROVIDERS, validateRoles } from "./installer/role-readiness.mjs";
import { loadAdapterForInspection, resolveAdapterModule, UNSUPPORTED_ADAPTER } from "./review-bridge/router/platform.mjs";
import { projectLogRoot, projectStateRoot } from "./review-bridge/utils/paths.mjs";
import {
  applyNeutralInstall, applyNeutralUninstall, applyNeutralUpgrade, applyNeutralUpgradeRollback, formatUpgradePlan, formatUpgradeResult,
  formatUpgradeRollbackPlan, formatUpgradeRollbackResult, loadInstalledServiceModules, planNeutralInstall, planNeutralUninstall, planNeutralUpgrade, planNeutralUpgradeRollback,
  rollbackFreshNeutralInstall, verifyNeutralInstall,
} from "./installer/neutral-install.mjs";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
// The one runtime: every project's commands, self-tests and page service run from here.
const runtimeRoot = path.join(packageRoot, "review-bridge");
const bootstrapPath = path.join(runtimeRoot, "bootstrap.mjs");
const INSTALLER_COMMANDS = new Set(["init", "roles-check", "uninstall", "upgrade"]);

function run(command, args, { cwd = packageRoot, expected = [0] } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!expected.includes(result.status)) {
    throw new Error([result.stderr, result.stdout].filter(Boolean).join("\n").trim()
      || "Command failed with exit code " + result.status + ".");
  }
  return result;
}

function jsonOutput(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(label + " did not return valid JSON.");
  }
}

// A failed self-test is said in one line: the scenario, why its run closed, and where the details
// are. The run's result file is the details when it was written; otherwise the command's output is.
class SelfTestError extends Error {}

async function selfTestFailure(name, result, completed, resultFile) {
  let details = resultFile;
  if (!(await fsp.stat(resultFile).catch(() => null))) {
    details = path.join(path.dirname(resultFile), "self-test-" + name.toLowerCase().replaceAll("_", "-") + ".log");
    await fsp.writeFile(details, [result.stdout, result.stderr].filter(Boolean).join("\n"), "utf8");
  }
  return new SelfTestError(name + " self-test failed: " + (completed?.closed_reason || "exit " + result.status) + ". Details: " + details);
}

async function runFakeScenarios(target, privateName) {
  const bootstrap = bootstrapPath;
  const workRoot = path.join(target, privateName, "work-packages");
  await fsp.mkdir(workRoot, { recursive: true });
  const scenarios = [
    { name: "PASS", expectedExit: [0], status: "pass" },
    { name: "FAIL_THEN_PASS", expectedExit: [0], status: "pass" },
    { name: "HARD_STOP", expectedExit: [0], status: "hard_stop" },
    { name: "RATE_LIMIT", expectedExit: [75], status: "rate_limited" },
  ];
  const results = [];
  for (const scenario of scenarios) {
    const id = "init-self-test-" + scenario.name.toLowerCase().replaceAll("_", "-");
    const taskPath = path.join(workRoot, id + ".md");
    // A minimal work order: the fake translation turns its one acceptance line into AC1.
    await fsp.writeFile(taskPath, [
      "# Review Bridge self-test",
      "",
      "<!-- bridge:requested_work -->",
      "Self-test only. Do not modify application files.",
      "",
      "<!-- bridge:acceptance -->",
      "## Acceptance",
      "",
      "- The fake review gate is reached.",
      "",
    ].join("\n"), "utf8");
    const planned = jsonOutput(run(process.execPath, [
      bootstrap,
      "work-plan",
      "--task-file", taskPath,
      "--owner", "Review Bridge init",
      "--work-package", id,
      "--breakpoint", "return to human after fake review gate",
      "--allow-paths", "README.md",
      "--rounds", "2",
      "--call-timeout", "60000",
      "--json",
    ], { cwd: target }), scenario.name + " work plan");
    const started = spawnSync(process.execPath, [
      bootstrap,
      "work-start",
      "--plan", planned.plan_path,
      "--yes",
      "--fake-cli",
      "--fake-scenario", scenario.name,
      "--json",
    ], { cwd: target, encoding: "utf8", env: process.env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    if (started.error) throw started.error;
    let completed = null;
    try {
      completed = JSON.parse(started.stdout);
    } catch {}
    if (!scenario.expectedExit.includes(started.status) || completed?.latest_state?.status !== scenario.status) {
      throw await selfTestFailure(scenario.name, started, completed, path.join(workRoot, id + ".result.md"));
    }
    results.push({ scenario: scenario.name, status: completed.latest_state.status });
  }
  return results;
}

async function runDisposableFakeScenarios(target, privateName = ".claude") {
  const disposable = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-self-test-"));
  let keep = false;
  try {
    await fsp.cp(path.join(target, privateName), path.join(disposable, privateName), { recursive: true });
    for (const relative of ["README.md", "AGENTS.md", "package.json"]) {
      const source = path.join(target, relative);
      if (await fsp.stat(source).catch(() => null)) await fsp.copyFile(source, path.join(disposable, relative));
    }
    if (!(await fsp.stat(path.join(disposable, "README.md")).catch(() => null))) {
      await fsp.writeFile(path.join(disposable, "README.md"), "# Review Bridge self-test workspace\n", "utf8");
    }
    // The copy is its own project in the person's database, never the real one, and its records go
    // when the self-tests end. It has no test rules: the self-tests check Bridge's own four paths, not
    // the project's tests (the copy has none of its dependencies), so its runs record not_configured.
    const config = path.join(disposable, privateName, "bridge.json");
    const settings = JSON.parse(await fsp.readFile(config, "utf8"));
    const projectId = randomUUID();
    await fsp.writeFile(config, JSON.stringify({ ...settings, project_id: projectId, test: { ...settings.test, rules: [] } }, null, 2) + "\n", "utf8");
    try {
      return await runFakeScenarios(disposable, privateName);
    } finally {
      run(process.execPath, [bootstrapPath, "clean", "--all"], { cwd: disposable, expected: [0, 1, 2] });
      // Its state and logs live outside the copy, under its own id, and go with its records.
      for (const folder of [projectStateRoot(projectId), projectLogRoot(projectId)]) await fsp.rm(folder, { recursive: true, force: true });
    }
  } catch (error) {
    // A failed self-test keeps the copy, so the file its message names is still there.
    if (error instanceof SelfTestError) keep = true;
    throw error;
  } finally {
    if (!keep) await fsp.rm(disposable, { recursive: true, force: true });
  }
}

// RC3-LINUX-00: the adapter for checks that call no model, on any platform. A platform without a
// usable adapter gets one that finds no CLI, so its readiness is reported as not ready, never lost.
async function inspectionAdapter() {
  const manifest = JSON.parse(await fsp.readFile(path.join(packageRoot, "review-bridge", "manifest.json"), "utf8"));
  const bridgeRoot = path.join(packageRoot, "review-bridge");
  const definition = loadAdapterForInspection(manifest, process.platform, process.arch, { bridgeRoot });
  const adapter = definition ? await import(resolveAdapterModule(bridgeRoot, definition.module)) : UNSUPPORTED_ADAPTER;
  return { definition, adapter, platform: process.platform + "-" + process.arch };
}

// One set of keys on every platform: an unverified or missing adapter only makes the values false.
function nativeReadiness({ platform, definition, missing }) {
  const eligible = definition?.eligible === true;
  return {
    ready: false,
    cli_available: missing.length === 0,
    authorization_ready: false,
    reason: eligible
      ? "Run up, open the page and pass the reviewer read-only check; then start work at an interactive terminal."
      : "This platform's adapter is not verified: the reviewer read-only check and native work are not available here.",
    platform,
    adapter_status: definition?.status || "unsupported",
    runtime_verified: definition?.runtime_verified === true,
    missing: [...(eligible ? [] : ["verified platform adapter"]), ...missing],
  };
}

async function inspectNativeReadiness(roles) {
  const { definition, adapter, platform } = await inspectionAdapter();
  const missing = [];
  for (const executable of new Set([roles.writer, roles.reviewer])) {
    try {
      await adapter.resolveExecutable(executable);
    } catch {
      missing.push(executable + " CLI");
    }
  }
  return nativeReadiness({ platform, definition, missing });
}

// roles-check asks at a terminal for any role not given.
async function chooseRoles(options) {
  let writer = options.writer;
  let reviewer = options.reviewer;
  if (writer && reviewer) return validateRoles({ writer, reviewer });
  if (options.yes || options.json) {
    throw new Error("Select both --writer and --reviewer explicitly.");
  }
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (!writer) writer = (await terminal.question(`Writer (${PROVIDERS.join("/")}): `)).trim();
    if (!reviewer) reviewer = (await terminal.question(`Reviewer (${PROVIDERS.join("/")}): `)).trim();
  } finally {
    terminal.close();
  }
  return validateRoles({ writer, reviewer });
}

async function rolesCheck(options) {
  return inspectSelectedRoles(await chooseRoles(options));
}

async function inspectSelectedRoles(roles) {
  return inspectRoleReadiness(roles, { adapter: (await inspectionAdapter()).adapter });
}

function formatRoleCheck(result) {
  const lines = [];
  for (const role of ["writer", "reviewer"]) {
    const check = result.checks[role];
    const state = !check.cli_present ? "CLI not found"
      : check.authenticated === true ? "signed in"
        : check.authenticated === false ? "sign in required" : "sign-in status unknown";
    lines.push(`${role}: ${check.provider} — ${state}`);
    if (check.next_action === "install_cli") lines.push(`  Next: install the ${check.provider} CLI, then check again.`);
    if (check.next_action === "sign_in") lines.push(`  Next: run ${check.provider === "claude" ? "claude auth login" : "codex login"}, then check again.`);
    if (check.next_action === "recheck_sign_in") lines.push(`  Next: check ${check.provider} sign-in status, then check again.`);
  }
  lines.push("Reviewer cannot write files: not tested (run `bootstrap.mjs watch` after init; the check uses one disclosed model call).");
  lines.push("Native work cannot start from this check.");
  return lines.join("\n") + "\n";
}

function missingRoleSteps(result) {
  return Object.entries(result.checks)
    .filter(([, check]) => check.next_action !== "none")
    .map(([role, check]) => ({ role, provider: check.provider, next_action: check.next_action }));
}

// init is the Guide (installer/install-guide.mjs): it asks what the command line left open, then
// sets the project up here in four steps, the same with or without a terminal.
async function init(options) {
  return await runGuide(options, {
    packageRoot,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) && !options.yes && !options.json,
    write: (text) => process.stdout.write(text),
    inspectProvider: async (provider) => (await inspectSelectedRoles({ writer: provider, reviewer: provider })).checks.writer,
    setUpProject,
  });
}

async function setUpProject({ target, roles, profileId, watchPort, fakeCli }, step) {
  if (watchPort !== undefined && (!Number.isInteger(watchPort) || watchPort < 1 || watchPort > 65535)) {
    throw new Error("--port must be 1 through 65535.");
  }
  const filesystem = assertSupportedStateFilesystem(target);
  // Live readiness is reported, never forced: the fake self-tests below are model-free
  // and need no CLI or login, and native work stays blocked either way.
  const roleReadiness = await inspectSelectedRoles(roles);
  const plan = await step("Setting up .review-bridge/", async () => {
    const planned = await planNeutralInstall({ target, profileId, roles, watchPort });
    await applyNeutralInstall(planned, planned.plan_sha256);
    return planned;
  });
  let verification;
  let scenarios;
  try {
    verification = await step("Checking the setup", () => verifyNeutralInstall(target));
    scenarios = await step("Running the four fake self-tests", () => runDisposableFakeScenarios(target, ".review-bridge"));
  } catch (error) {
    try {
      await rollbackFreshNeutralInstall(plan);
    } catch (rollbackError) {
      throw new Error(`Setup failed: ${error.message}; rollback needs attention: ${rollbackError.message}`);
    }
    throw new Error(`Setup failed and was rolled back: ${error.message}`);
  }
  const realMode = await inspectNativeReadiness(roles);
  const service = await step("Starting the local page", () => startService(target, fakeCli));
  const database = await databaseConnection();
  return {
    ok: true,
    target,
    profile: plan.profile.id,
    workspace_mode: plan.git.repository ? "git" : "snapshot",
    git_required: false,
    application_files_changed: false,
    state_filesystem: filesystem,
    roles,
    role_readiness: roleReadiness,
    role_next_steps: missingRoleSteps(roleReadiness),
    fake_self_tests: scenarios,
    fake_runtime_verified: verification.valid === true,
    real_mode: realMode,
    work_folder: path.join(target, ".review-bridge", "work-packages"),
    url: service.url,
    database,
    service_started: service.started,
    service_reason: service.reason,
    service_notice: service.notice,
    next_step: {
      action: "open_work_template",
      path: ".review-bridge/work-packages/TEMPLATE.md",
      note: "The local page shows role readiness without model calls; the reviewer write-denial check runs only when you press its button.",
    },
  };
}

// Starts the project's resident page service through Bridge's runtime, then verifies it with
// the runtime's own health check (T0-01 C4). Nothing printed by `up` is parsed; a failure
// to start leaves the project setup in place and is reported instead of rolled back.
async function startService(target, fakeCli) {
  run(process.execPath, [bootstrapPath, "up", "--project", target, ...(fakeCli ? ["--fake-cli"] : [])], {
    cwd: target, expected: [0, 1, 2],
  });
  const modules = await loadInstalledServiceModules(runtimeRoot);
  if (!modules) throw new Error("The Bridge runtime has no page service module.");
  const { checkService, serviceFiles } = modules.service;
  const paths = modules.getBridgePaths(target, runtimeRoot, { privateRootName: ".review-bridge" });
  const check = await checkService(paths);
  // Display only: the port-bump line the watch process logged.
  const stdoutLog = await fsp.readFile(serviceFiles(paths).stdoutPath, "utf8").catch(() => "");
  const notice = stdoutLog.split(/\r?\n/).find((line) => line.includes("占用，改用")) || null;
  return { started: check.running, url: check.running ? check.url : null, reason: check.reason, notice };
}

// How to reach the person's database, for init's last lines: the same connection `status` prints.
// Opening it starts the server if it is not running.
async function databaseConnection() {
  const { openDatabase } = await import("./review-bridge/service/database/index.mjs");
  const db = await openDatabase();
  try {
    return db.connection;
  } finally {
    await db.close();
  }
}

// After an upgrade the database is opened (and its new migrations applied) to say how to reach it;
// one that cannot be opened is said as it is, since the upgrade itself is done.
async function upgradeDatabaseLines() {
  try {
    return databaseLines(await databaseConnection());
  } catch (error) {
    return ["  database: could not be opened: " + String(error?.message || error)];
  }
}

// T0-09 U1: what the human approves. Every line comes from the sealed plan.
function formatUninstallPlan(plan) {
  if (plan.kind === "cancel") {
    return [
      "上一次解除安裝在開始刪除前中斷，沒有刪任何檔。",
      "這次會：取消那筆解除安裝" + (plan.restart_service ? "、重新啟動網頁服務" : "") + (plan.remove_marker ? "、拿掉維護標記" : "") + "。",
    ].join("\n") + "\n";
  }
  if (plan.kind === "finish") {
    return "上一次解除安裝已刪完 .review-bridge/，只剩還原 git 排除與最後檢查。\n";
  }
  if (plan.kind === "continue") {
    return [
      "上一次解除安裝刪到一半中斷。",
      "還剩 " + (plan.remaining_same.length + plan.remaining_newer.length) + " 個檔：" + plan.remaining_same.length + " 個與備份相同，照刪；"
        + plan.remaining_newer.length + " 個比備份新，先追加備份再刪：",
      ...plan.remaining_newer.slice(0, 20).map(([name]) => "  " + name),
    ].join("\n") + "\n";
  }
  return [
    "解除安裝 Review Bridge：" + plan.target,
    ...(plan.service_running ? ["會先停掉網頁服務。"] : []),
    ".review-bridge/ 共 " + plan.file_count + " 個檔，其中你建立或改過的 " + plan.user_file_count + " 個：",
    ...plan.user_files.map((name) => "  " + name),
    ...(plan.user_file_count > plan.user_files.length ? ["  …另外 " + (plan.user_file_count - plan.user_files.length) + " 個"] : []),
    "整份先備份到專案外，核對後才刪：" + plan.backup_root,
    ...(plan.git_exclusion?.present ? ["會從 " + plan.git_exclusion.path + " 拿掉安裝時加的這一行：" + plan.git_exclusion.pattern] : []),
    ...Object.values(plan.agent_files_state || {}).map((part) => (part.unchanged
      ? "會移除安裝時加的 " + part.path + (part.path === "AGENTS.md" ? " 那一段" : "")
      : part.path + " 裡安裝時加的內容你改過，留著不動")),
  ].join("\n") + "\n";
}

function formatUninstallResult(result) {
  if (result.kind === "cancel") return "已取消上一次的解除安裝" + (result.service_restarted ? "，網頁服務已重新啟動" : "") + "。\n";
  return [
    "已解除安裝",
    "備份在：" + result.backup_dir + (result.file_count ? "（" + result.file_count + " 個檔，含你的 " + (result.user_file_count ?? 0) + " 個）" : ""),
    "要找回工單或結果，從備份資料夾複製回來",
  ].join("\n") + "\n";
}

// Removes one project's setup. Review Bridge itself is removed by npm: npm uninstall -g review-bridge.
async function uninstall(options) {
  if (options.target === undefined) throw new Error("uninstall needs --target <folder>. To remove Review Bridge itself, run: npm uninstall -g review-bridge");
  if (options.yes) throw new Error("uninstall has no --yes. Use --plan-out <file>, then --plan <file> --approve <sha>, or confirm at an interactive terminal.");
  const target = path.resolve(options.target);
  if (options.plan) {
    if (!options.approve) throw new Error("--plan needs --approve <sha>.");
    const plan = JSON.parse(await fsp.readFile(path.resolve(options.plan), "utf8"));
    if (path.resolve(plan.target || "") !== target) throw new Error("The plan is for another project.");
    return await applyNeutralUninstall(plan, options.approve);
  }
  const plan = await planNeutralUninstall({ target, backupRoot: options["backup-root"] || null });
  if (options["plan-out"]) {
    await fsp.writeFile(path.resolve(options["plan-out"]), JSON.stringify(plan, null, 2) + "\n", "utf8");
    return { plan_written: path.resolve(options["plan-out"]), plan_sha256: plan.plan_sha256, kind: plan.kind };
  }
  if (!process.stdin.isTTY) throw new Error("No terminal to confirm at. Use --plan-out <file>, then --plan <file> --approve <sha>.");
  process.stdout.write(formatUninstallPlan(plan));
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question("要繼續嗎？[y/N] ");
    if (!/^y(?:es)?$/i.test(answer.trim())) throw new Error("Uninstall cancelled by user.");
  } finally {
    terminal.close();
  }
  return await applyNeutralUninstall(plan, plan.plan_sha256);
}

// T0-10 P1.3 / P1.4: the same three routes as uninstall, for the upgrade and for its rollback.
async function upgrade(options) {
  if (options.yes) throw new Error("upgrade has no --yes. Use --plan-out <file>, then --plan <file> --approve <sha>, or confirm at an interactive terminal.");
  const target = path.resolve(options.target || process.cwd());
  const rollback = options.rollback === true;
  if (options.plan) {
    if (!options.approve) throw new Error("--plan needs --approve <sha>.");
    const plan = JSON.parse(await fsp.readFile(path.resolve(options.plan), "utf8"));
    if (path.resolve(plan.target || "") !== target) throw new Error("The plan is for another project.");
    if (rollback !== (plan.operation === "upgrade_rollback")) throw new Error(rollback ? "That is not an upgrade rollback plan." : "That is an upgrade rollback plan; add --rollback.");
    return rollback ? await applyNeutralUpgradeRollback(plan, options.approve) : await applyNeutralUpgrade(plan, options.approve);
  }
  const plan = rollback ? await planNeutralUpgradeRollback({ target }) : await planNeutralUpgrade({ target, backupRoot: options["backup-root"] || null });
  if (plan.up_to_date) return plan;
  if (options["plan-out"]) {
    await fsp.writeFile(path.resolve(options["plan-out"]), JSON.stringify(plan, null, 2) + "\n", "utf8");
    return { plan_written: path.resolve(options["plan-out"]), plan_sha256: plan.plan_sha256, operation: plan.operation, kind: plan.kind };
  }
  if (!process.stdin.isTTY) throw new Error("No terminal to confirm at. Use --plan-out <file>, then --plan <file> --approve <sha>.");
  process.stdout.write(rollback ? formatUpgradeRollbackPlan(plan) : formatUpgradePlan(plan));
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question("要繼續嗎？[y/N] ");
    if (!/^y(?:es)?$/i.test(answer.trim())) throw new Error((rollback ? "Upgrade rollback" : "Upgrade") + " cancelled by user.");
  } finally {
    terminal.close();
  }
  return rollback ? await applyNeutralUpgradeRollback(plan, plan.plan_sha256) : await applyNeutralUpgrade(plan, plan.plan_sha256);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const all = rest.includes("--all");
  if (!command || ["-h", "--help", "help"].includes(command)) {
    process.stdout.write(renderMainHelp({ all }));
    return command ? 0 : 2;
  }
  if (["-v", "--version"].includes(command)) {
    process.stdout.write(JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version + "\n");
    return 0;
  }
  if (COMMANDS[command] && (rest.includes("--help") || rest.includes("-h"))) {
    process.stdout.write(renderCommandHelp(command, { all }));
    return 0;
  }
  // Every other command is the project runtime's, run in the terminal it was typed in, against the
  // project named by --project or the current folder.
  if (!INSTALLER_COMMANDS.has(command)) {
    const forwarded = spawnSync(process.execPath, [bootstrapPath, command, ...rest], { stdio: "inherit" });
    if (forwarded.error) throw forwarded.error;
    return forwarded.status ?? 1;
  }
  if (command === "roles-check") {
    const { options } = parseCommandLine(command, rest);
    const result = await rolesCheck(options);
    process.stdout.write(options.json ? JSON.stringify(result, null, 2) + "\n" : formatRoleCheck(result));
    return 0;
  }
  if (command === "uninstall") {
    const { options } = parseCommandLine(command, rest);
    const result = await uninstall(options);
    process.stdout.write(options.json || result.plan_written ? JSON.stringify(result, null, 2) + "\n" : formatUninstallResult(result));
    return 0;
  }
  if (command === "upgrade") {
    const { options } = parseCommandLine(command, rest);
    const result = await upgrade(options);
    if (options.json || result.plan_written) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    else if (result.operation === "upgrade_rollback") process.stdout.write(formatUpgradeRollbackResult(result));
    // An upgrade ends the way init does: how to reach the database, from the same lines.
    else process.stdout.write(formatUpgradeResult(result) + "\n" + (await upgradeDatabaseLines()).join("\n") + "\n");
    return 0;
  }
  const { options } = parseCommandLine(command, rest);
  const result = await init(options);
  if (!result.printed) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  const failed = INSTALLER_COMMANDS.has(process.argv[2]) ? process.argv[2] : "init";
  process.stderr.write("Review Bridge " + failed + " failed closed: " + error.message + "\n");
  process.exitCode = 2;
}
