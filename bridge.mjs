#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertSupportedStateFilesystem } from "./review-bridge/core/filesystem-v4.mjs";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const installer = path.join(packageRoot, "installer", "install.mjs");

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
    if (token === "--yes") {
      options.yes = true;
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
    "Target workspace: " + plan.target.root,
    "Operation: " + plan.operation,
    "Review Bridge will install private controller files under .claude/.",
    "Detected profile: " + plan.profile.display_name + " (" + plan.profile.id + ")",
    "Workspace evidence mode: " + plan.target.workspace_mode,
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

async function runFakeScenarios(target) {
  const bootstrap = path.join(target, ".claude", "tools", "review-bridge", "bootstrap.mjs");
  const workRoot = path.join(target, ".claude", "work-packages");
  const queueRoot = path.join(target, ".claude", "review-queue");
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
    ], { cwd: target, expected: scenario.expectedExit }), scenario.name + " self-test");
    if (completed.latest_state?.status !== scenario.status) {
      throw new Error(scenario.name + " self-test returned unexpected status.");
    }
    results.push({ scenario: scenario.name, status: completed.latest_state.status });
  }
  return results;
}

async function runDisposableFakeScenarios(target) {
  const disposable = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-self-test-"));
  try {
    await fsp.cp(path.join(target, ".claude"), path.join(disposable, ".claude"), { recursive: true });
    for (const relative of ["README.md", "AGENTS.md", "package.json"]) {
      const source = path.join(target, relative);
      if (await fsp.stat(source).catch(() => null)) await fsp.copyFile(source, path.join(disposable, relative));
    }
    if (!(await fsp.stat(path.join(disposable, "README.md")).catch(() => null))) {
      await fsp.writeFile(path.join(disposable, "README.md"), "# Review Bridge self-test workspace\n", "utf8");
    }
    return await runFakeScenarios(disposable);
  } finally {
    await fsp.rm(disposable, { recursive: true, force: true });
  }
}

async function inspectNativeReadiness() {
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
  for (const executable of ["claude", "codex"]) {
    try {
      await adapter.resolveExecutable(executable);
    } catch {
      missing.push(executable + " CLI");
    }
  }
  return {
    ready: missing.length === 0,
    platform: targetKey,
    adapter_status: definition.status,
    runtime_verified: definition.runtime_verified === true,
    missing,
  };
}

async function init(options) {
  await verifyReleaseIntegrity();
  const target = path.resolve(options.target || process.cwd());
  const stat = await fsp.lstat(target).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("--target must be an existing, non-symlink workspace directory.");
  }
  const filesystem = assertSupportedStateFilesystem(target);
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-init-"));
  const planPath = path.join(tempRoot, randomUUID() + ".json");
  try {
    const planned = run(process.execPath, [
      installer,
      "plan",
      "--target", target,
      "--profile", options.profile || "auto",
      "--fake-cli",
      "--json",
      "--out", planPath,
    ], { expected: [0, 2] });
    const plan = jsonOutput(planned, "Installer plan");
    if (planned.status !== 0) {
      const finding = plan.findings?.find((entry) => ["BLOCKER", "HIGH"].includes(entry.severity));
      throw new Error(finding
        ? `${finding.code}: ${finding.remediation || finding.message}`
        : "Installer preflight failed. Inspect the generated plan for details.");
    }
    await confirmInstall(plan, Boolean(options.yes));
    run(process.execPath, [
      installer,
      "apply",
      "--target", target,
      "--plan", planPath,
      "--approve", plan.plan_sha256,
    ]);
    const verification = jsonOutput(run(process.execPath, [
      installer,
      "verify",
      "--target", target,
      "--fake-cli",
    ]), "Installer verification");
    const scenarios = await runDisposableFakeScenarios(target);
    const realMode = await inspectNativeReadiness();
    return {
      ok: true,
      target,
      profile: plan.profile.id,
      workspace_mode: plan.target.workspace_mode,
      git_required: false,
      application_files_changed: false,
      state_filesystem: filesystem,
      fake_self_tests: scenarios,
      fake_runtime_verified: verification.valid === true,
      real_mode: realMode,
    };
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || ["-h", "--help"].includes(command)) {
    process.stdout.write("Usage: node bridge.mjs init [--target <workspace>] [--profile auto] [--yes]\n");
    return command ? 0 : 2;
  }
  if (command !== "init") throw new Error("Unsupported command: " + command);
  process.stdout.write(JSON.stringify(await init(parseArgs(rest)), null, 2) + "\n");
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write("Review Bridge init failed closed: " + error.message + "\n");
  process.exitCode = 2;
}
