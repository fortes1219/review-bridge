#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertSupportedStateFilesystem } from "./review-bridge/core/filesystem-v4.mjs";
import { inspectRoleReadiness, PROVIDERS, validateRoles } from "./installer/role-readiness.mjs";
import { applyNeutralInstall, planNeutralInstall, rollbackFreshNeutralInstall, verifyNeutralInstall } from "./installer/neutral-install.mjs";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

async function verifyReleaseIntegrity() {
  try {
    const manifest = await fsp.readFile(path.join(packageRoot, "SHA256SUMS.txt"), "utf8");
    const lines = manifest.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) throw new Error("empty checksum manifest");
    for (const line of lines) {
      const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
      if (!match) throw new Error("invalid checksum manifest");
      const relative = match[2].replaceAll("/", path.sep);
      const absolute = path.resolve(packageRoot, relative);
      if (absolute === packageRoot || !absolute.startsWith(packageRoot + path.sep)) {
        throw new Error("checksum path escapes package root");
      }
      const actual = createHash("sha256").update(await fsp.readFile(absolute)).digest("hex");
      if (actual !== match[1]) throw new Error("checksum mismatch");
    }
  } catch {
    throw new Error("Release integrity check failed. Download and extract a fresh package.");
  }
}

function parseArgs(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (token === "--yes" || token === "--json" || token === "--fake-cli") {
      options[token.slice(2)] = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error("Unexpected argument: " + token);
    const value = values[index + 1];
    if (!value || value.startsWith("--")) throw new Error("Missing value for " + token);
    options[token.slice(2)] = value;
    index += 1;
  }
  return options;
}

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

async function confirmInstall(plan, assumeYes) {
  if (assumeYes) return;
  process.stdout.write([
    "Target workspace: " + (typeof plan.target === "string" ? plan.target : plan.target.root),
    "Operation: " + plan.operation,
    "Review Bridge will install private controller files under .review-bridge/.",
    "Detected profile: " + (plan.profile.label || plan.profile.display_name) + " (" + plan.profile.id + ")",
    "Planned changes:",
    ...plan.changes.map((change) => "  - " + change),
    "Application files will not be changed during init.",
    "The next step runs PASS, FAIL_THEN_PASS, HARD_STOP, and RATE_LIMIT with fake CLIs.",
    "",
  ].join("\n"));
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question("Continue and run the four no-token self-tests? [y/N] ");
    if (!/^y(?:es)?$/i.test(answer.trim())) throw new Error("Installation cancelled by user.");
  } finally {
    terminal.close();
  }
}

async function runFakeScenarios(target, privateName = ".claude") {
  const bootstrap = path.join(target, privateName, "tools", "review-bridge", "bootstrap.mjs");
  const workRoot = path.join(target, privateName, "work-packages");
  const queueRoot = path.join(target, privateName, "review-queue");
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
    const planPath = path.join(queueRoot, id + ".plan.json");
    await fsp.writeFile(taskPath, "Self-test only. Do not modify application files.\n", "utf8");
    const planned = jsonOutput(run(process.execPath, [
      bootstrap,
      "work-plan",
      "--task-file", taskPath,
      "--owner", "Review Bridge init",
      "--work-package", id,
      "--breakpoint", "return to human after fake review gate",
      "--change-types", "docs",
      "--allow-paths", "README.md",
      "--max-claude-calls", "2",
      "--max-claude-minutes", "1",
      "--out", planPath,
    ], { cwd: target }), scenario.name + " work plan");
    const completed = jsonOutput(run(process.execPath, [
      bootstrap,
      "work-start",
      "--plan", planPath,
      "--yes",
      "--fake-cli",
      "--fake-scenario", scenario.name,
      "--json",
    ], { cwd: target, expected: scenario.expectedExit }), scenario.name + " self-test");
    if (completed.latest_state?.status !== scenario.status) {
      throw new Error(scenario.name + " self-test returned unexpected status.");
    }
    results.push({ scenario: scenario.name, status: completed.latest_state.status });
  }
  return results;
}

async function runDisposableFakeScenarios(target, privateName = ".claude") {
  const disposable = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-self-test-"));
  try {
    await fsp.cp(path.join(target, privateName), path.join(disposable, privateName), { recursive: true });
    for (const relative of ["README.md", "AGENTS.md", "package.json"]) {
      const source = path.join(target, relative);
      if (await fsp.stat(source).catch(() => null)) await fsp.copyFile(source, path.join(disposable, relative));
    }
    if (!(await fsp.stat(path.join(disposable, "README.md")).catch(() => null))) {
      await fsp.writeFile(path.join(disposable, "README.md"), "# Review Bridge self-test workspace\n", "utf8");
    }
    return await runFakeScenarios(disposable, privateName);
  } finally {
    await fsp.rm(disposable, { recursive: true, force: true });
  }
}

async function inspectNativeReadiness(roles) {
  const manifest = JSON.parse(await fsp.readFile(path.join(packageRoot, "review-bridge", "manifest.json"), "utf8"));
  const targetKey = process.platform + "-" + process.arch;
  const definition = manifest.adapters?.[targetKey];
  if (!definition || !["active", "candidate"].includes(definition.status)) {
    return {
      ready: false,
      platform: targetKey,
      adapter_status: definition?.status || "unsupported",
      missing: ["active platform adapter"],
    };
  }
  const adapterPath = path.resolve(packageRoot, "review-bridge", definition.module);
  const adapter = await import(pathToFileURL(adapterPath).href);
  const missing = [];
  for (const executable of new Set([roles.writer, roles.reviewer])) {
    try {
      await adapter.resolveExecutable(executable);
    } catch {
      missing.push(executable + " CLI");
    }
  }
  return {
    ready: false,
    cli_available: missing.length === 0,
    authorization_ready: false,
    reason: "Run up, open the page and pass the reviewer read-only check; then start work at an interactive terminal.",
    platform: targetKey,
    adapter_status: definition.status,
    runtime_verified: definition.runtime_verified === true,
    missing,
  };
}

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
  await verifyReleaseIntegrity();
  return inspectSelectedRoles(await chooseRoles(options));
}

async function inspectSelectedRoles(roles) {
  const manifest = JSON.parse(await fsp.readFile(path.join(packageRoot, "review-bridge", "manifest.json"), "utf8"));
  const targetKey = process.platform + "-" + process.arch;
  const definition = manifest.adapters?.[targetKey];
  if (!definition || !["active", "candidate"].includes(definition.status)) {
    return inspectRoleReadiness(roles, {
      adapter: { async resolveExecutable() { throw new Error("Unsupported platform"); } },
    });
  }
  const adapterPath = path.resolve(packageRoot, "review-bridge", definition.module);
  const adapter = await import(pathToFileURL(adapterPath).href);
  return inspectRoleReadiness(roles, { adapter });
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

async function init(options) {
  await verifyReleaseIntegrity();
  const roles = await chooseRoles(options);
  // Live readiness is reported, never forced: the fake self-tests below are model-free
  // and need no CLI or login, and native work stays blocked either way.
  const roleReadiness = await inspectSelectedRoles(roles);
  const missingSteps = missingRoleSteps(roleReadiness);
  if (!options.yes) {
    process.stdout.write(formatRoleCheck(roleReadiness));
    if (missingSteps.length > 0) {
      process.stdout.write("Selected roles are not ready. Setup continues with fake self-tests only; complete the steps above before native work.\n");
    }
  }
  const target = path.resolve(options.target || process.cwd());
  const stat = await fsp.lstat(target).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("--target must be an existing, non-symlink workspace directory.");
  }
  const filesystem = assertSupportedStateFilesystem(target);
  const watchPort = options.port === undefined ? undefined : Number(options.port);
  if (watchPort !== undefined && (!Number.isInteger(watchPort) || watchPort < 1 || watchPort > 65535)) {
    throw new Error("--port must be 1 through 65535.");
  }
  const plan = await planNeutralInstall({ target, profileId: options.profile || "auto", roles, watchPort });
  await confirmInstall(plan, Boolean(options.yes));
  await applyNeutralInstall(plan, plan.plan_sha256);
  let verification;
  let scenarios;
  try {
    verification = await verifyNeutralInstall(target);
    scenarios = await runDisposableFakeScenarios(target, ".review-bridge");
  } catch (error) {
    try {
      await rollbackFreshNeutralInstall(plan);
    } catch (rollbackError) {
      throw new Error(`Setup failed: ${error.message}; rollback needs attention: ${rollbackError.message}`);
    }
    throw new Error(`Setup failed and was rolled back: ${error.message}`);
  }
  const realMode = await inspectNativeReadiness(roles);
  const service = await startService(target, Boolean(options["fake-cli"]));
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
    role_next_steps: missingSteps,
    fake_self_tests: scenarios,
    fake_runtime_verified: verification.valid === true,
    real_mode: realMode,
    work_folder: path.join(target, ".review-bridge", "work-packages"),
    url: service.url,
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

// Starts the resident page service through the installed runtime, then verifies it with
// the runtime's own health check (T0-01 C4). Nothing printed by `up` is parsed; a failure
// to start leaves the install in place and is reported instead of rolled back.
async function startService(target, fakeCli) {
  const runtimeRoot = path.join(target, ".review-bridge", "tools", "review-bridge");
  run(process.execPath, [path.join(runtimeRoot, "bootstrap.mjs"), "up", ...(fakeCli ? ["--fake-cli"] : [])], {
    cwd: target, expected: [0, 1, 2],
  });
  const { getBridgePaths } = await import(pathToFileURL(path.join(runtimeRoot, "core", "paths.mjs")).href);
  const { checkService, serviceFiles } = await import(pathToFileURL(path.join(runtimeRoot, "core", "service.mjs")).href);
  const paths = getBridgePaths(target, runtimeRoot, { privateRootName: ".review-bridge" });
  const check = await checkService(paths);
  // Display only: the port-bump line the watch process logged.
  const stdoutLog = await fsp.readFile(serviceFiles(paths).stdoutPath, "utf8").catch(() => "");
  const notice = stdoutLog.split(/\r?\n/).find((line) => line.includes("占用，改用")) || null;
  return { started: check.running, url: check.running ? check.url : null, reason: check.reason, notice };
}

function formatInitResult(result) {
  return [
    ...(result.service_notice ? [result.service_notice] : []),
    "工作資料夾：" + result.work_folder,
    "網頁：" + (result.url || "沒有啟動（" + result.service_reason + "），執行 review-bridge up"),
    "下一步：在 VS Code 打開 " + result.next_step.path,
  ].join("\n") + "\n";
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || ["-h", "--help"].includes(command)) {
    process.stdout.write("Usage: node bridge.mjs init [--target <workspace>] [--profile auto] [--writer claude|codex] [--reviewer claude|codex] [--port <n>] [--yes] [--json]\n"
      + "       node bridge.mjs roles-check [--writer claude|codex] [--reviewer claude|codex] [--json]\n");
    return command ? 0 : 2;
  }
  if (command === "roles-check") {
    const options = parseArgs(rest);
    const result = await rolesCheck(options);
    process.stdout.write(options.json ? JSON.stringify(result, null, 2) + "\n" : formatRoleCheck(result));
    return 0;
  }
  if (command !== "init") throw new Error("Unsupported command: " + command);
  const options = parseArgs(rest);
  const result = await init(options);
  process.stdout.write(options.json ? JSON.stringify(result, null, 2) + "\n" : formatInitResult(result));
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write("Review Bridge init failed closed: " + error.message + "\n");
  process.exitCode = 2;
}
