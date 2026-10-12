#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { inspectStateFilesystem } from "../review-bridge/core/filesystem-v4.mjs";
import { getBridgePaths } from "../review-bridge/core/paths.mjs";
import {
  beginUpgrade,
  completeUpgrade,
  reportUpgradeInvalidations,
} from "../review-bridge/core/state-v4.mjs";

const installerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installerVersion = "0.2.0-rc.2";
const hookCommand = 'node ".claude/tools/review-bridge/bootstrap.mjs" enqueue --no-start';
const managed = {
  runtime: ".claude/tools/review-bridge",
  rule: ".claude/rules/review-bridge.md",
  settings: ".claude/settings.local.json",
  bridgeConfig: ".claude/review-bridge/bridge.json",
  policyOverride: ".claude/review-bridge/policy.override.json",
  promptOverride: ".claude/review-bridge/review-prompt.md",
  workTemplate: ".claude/work-packages/TEMPLATE.md",
  rulesDigest: ".claude/review-bridge/rules.md",
  manifest: ".claude/review-bridge-install.json",
  upgradeMarker: ".claude/review-queue/upgrade-in-progress.json",
};
const impactPaths = [
  managed.runtime,
  managed.rule,
  managed.settings,
  ".claude/review-queue",
  ".claude/reviews",
  ".claude/review-bridge",
  managed.manifest,
  managed.workTemplate,
];

function usage() {
  return [
    "Usage:",
    "  node installer/install.mjs plan --target <repo> --profile <auto|profile-id> [--operation install|upgrade|uninstall|rollback] [--out <plan.json>] [--json] [--adopt-existing] [--fake-cli] [--backup-root <path>]",
    "  node installer/install.mjs apply --target <repo> --plan <plan.json> --approve <sha256>",
    "  node installer/install.mjs upgrade --target <repo> --plan <plan.json> --approve <sha256>",
    "  node installer/install.mjs uninstall --target <repo> --plan <plan.json> --approve <sha256>",
    "  node installer/install.mjs rollback --target <repo> --plan <plan.json> --approve <sha256>",
    "  node installer/install.mjs verify --target <repo> [--fake-cli]",
  ].join("\n");
}

function parseArgs(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) throw new Error("Unexpected argument: " + token);
    const key = token.slice(2);
    if (["adopt-existing", "fake-cli", "json"].includes(key)) {
      options[key] = true;
      continue;
    }
    const value = values[index + 1];
    if (!value || value.startsWith("--")) throw new Error("Missing value for --" + key);
    options[key] = value;
    index += 1;
  }
  return options;
}

function remediationForFinding(finding) {
  const remediations = {
    PRIVATE_BOUNDARY_MISSING: "Add `.claude/` to .gitignore and re-run init.",
    UNSUPPORTED_STATE_FILESYSTEM: "Move the project to a supported local filesystem and re-run init.",
    PROFILE_MISMATCH: "Choose a profile that matches the project and re-run init.",
    SETTINGS_INVALID: "Fix .claude/settings.local.json and re-run init.",
    MANAGED_PATH_SYMLINK: "Replace the managed symlink with a normal local path and re-run init.",
    ALREADY_INSTALLED: "Use an upgrade plan for this installed project.",
    NOT_INSTALLED: "Install Review Bridge before running this operation.",
    INCOMPLETE_UPGRADE: "Create and approve a rollback plan before another operation.",
    UNMANAGED_BRIDGE_HOOK: "Re-run planning with --adopt-existing after reviewing the existing hook.",
    PROJECT_PROMPT_CONFLICT: "Choose one authoritative project review prompt before adoption.",
    ROLLBACK_POINT_MISSING: "Use a manifest with a valid rollback point.",
  };
  return remediations[finding.code] || finding.message || "Resolve the preflight finding and re-run init.";
}

function humanFindingLine(finding) {
  return `${finding.severity} ${finding.code}: ${remediationForFinding(finding)}`;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function canonicalText(value) {
  return JSON.stringify(canonical(value));
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(file) {
  try {
    await fsp.lstat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(file) {
  return JSON.parse((await fsp.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

async function readJsonOptional(file) {
  return (await exists(file)) ? await readJson(file) : null;
}

async function hashFile(file) {
  return digest(await fsp.readFile(file));
}

async function walkFiles(root, prefix = "") {
  if (!(await exists(root))) return [];
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(root, entry.name);
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Symlinks are not accepted in managed source: " + absolute);
    if (entry.isDirectory()) files.push(...await walkFiles(absolute, relative));
    else if (entry.isFile()) files.push({ path: relative, sha256: await hashFile(absolute) });
  }
  return files;
}

async function pathState(target, relative) {
  const absolute = path.join(target, relative);
  if (!(await exists(absolute))) return { path: relative, state: "missing" };
  const stat = await fsp.lstat(absolute);
  if (stat.isSymbolicLink()) return { path: relative, state: "symlink" };
  if (stat.isDirectory()) return { path: relative, state: "directory", files: await walkFiles(absolute) };
  return { path: relative, state: "file", sha256: await hashFile(absolute) };
}

function gitOptional(target, args) {
  const result = spawnSync("git", args, { cwd: target, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function inspectWorkspace(target) {
  const root = path.resolve(target);
  const discovered = gitOptional(root, ["rev-parse", "--show-toplevel"]);
  if (!discovered) {
    return {
      mode: "snapshot",
      git_available: gitOptional(root, ["--version"]) !== null,
      git_repository: false,
      git_root: null,
      head: null,
      claude_private_boundary_ignored: null,
    };
  }
  const gitRoot = path.resolve(discovered);
  const ignored = spawnSync("git", ["check-ignore", "-q", "--no-index", ".claude/review-bridge-install.json"], {
    cwd: root,
    stdio: "ignore",
  }).status === 0;
  if (gitRoot.toLowerCase() !== root.toLowerCase()) {
    return {
      mode: "snapshot",
      git_available: true,
      git_repository: true,
      git_root: gitRoot,
      head: gitOptional(root, ["rev-parse", "--verify", "HEAD"]),
      claude_private_boundary_ignored: ignored,
    };
  }
  return {
    mode: "git",
    git_available: true,
    git_repository: true,
    git_root: gitRoot,
    head: gitOptional(root, ["rev-parse", "--verify", "HEAD"]),
    claude_private_boundary_ignored: ignored,
  };
}

function bridgeHooks(settings) {
  const groups = settings?.hooks?.Stop;
  if (!Array.isArray(groups)) return [];
  const found = [];
  for (const [groupIndex, group] of groups.entries()) {
    if (!Array.isArray(group?.hooks)) continue;
    for (const [hookIndex, hook] of group.hooks.entries()) {
      if (hook?.type === "command" && typeof hook.command === "string" && hook.command.includes("review-bridge")) {
        found.push({ groupIndex, hookIndex, command: hook.command, timeout: hook.timeout ?? null });
      }
    }
  }
  return found;
}

function mergeHook(settings) {
  const output = structuredClone(settings || {});
  output.hooks ||= {};
  const groups = Array.isArray(output.hooks.Stop) ? output.hooks.Stop : [];
  const cleaned = [];
  for (const group of groups) {
    if (!Array.isArray(group?.hooks)) {
      cleaned.push(group);
      continue;
    }
    const hooks = group.hooks.filter((hook) => !(hook?.type === "command" && typeof hook.command === "string" && hook.command.includes("review-bridge")));
    if (hooks.length > 0) cleaned.push({ ...group, hooks });
  }
  cleaned.push({ hooks: [{ type: "command", command: hookCommand, timeout: 30 }] });
  output.hooks.Stop = cleaned;
  return output;
}

function removeHook(settings) {
  const output = structuredClone(settings || {});
  if (!Array.isArray(output?.hooks?.Stop)) return output;
  output.hooks.Stop = output.hooks.Stop.flatMap((group) => {
    if (!Array.isArray(group?.hooks)) return [group];
    const hooks = group.hooks.filter((hook) => !(hook?.type === "command" && hook.command === hookCommand));
    return hooks.length ? [{ ...group, hooks }] : [];
  });
  return output;
}

export function projectPolicyOverride(profile) {
  const rules = [];
  if ((profile.review_terms?.security || []).length) {
    rules.push({
      id: "project-" + profile.profile_id + "-security",
      protected: false,
      level: "SECURITY",
      priority: 410,
      reason: "project security boundary",
      any: profile.review_terms.security,
      none: [],
    });
  }
  if ((profile.review_terms?.full || []).length) {
    rules.push({
      id: "project-" + profile.profile_id + "-full",
      protected: false,
      level: "FULL",
      priority: 310,
      reason: "project full semantic review",
      any: profile.review_terms.full,
      none: [],
    });
  }
  return {
    schema_version: 4,
    profile_id: profile.profile_id,
    classification: { rules },
  };
}

function bridgeConfig(profileId, profile = null) {
  return {
    schema_version: 4,
    state_contract: "v4",
    profile_id: profileId,
    // T0-06 G1.3: the profile-approved verification rules; work-plan picks Gate A from here.
    gate_a: { profile_id: profileId, rules: structuredClone(profile?.verification_rules || []) },
    default_policy_ref: ".claude/tools/review-bridge/config/default-policy.json",
    project_override_ref: ".claude/review-bridge/policy.override.json",
    active_runs: "derive_from_run_projections",
  };
}

function rootGlobRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^" + escaped.replaceAll("*", ".*").replaceAll("?", ".") + "$", "i");
}

async function rootGlobMatches(target, pattern) {
  const matcher = rootGlobRegex(pattern);
  return (await fsp.readdir(target, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => matcher.test(name));
}

async function readTextOptional(file) {
  return (await exists(file)) ? await fsp.readFile(file, "utf8") : null;
}

async function contentRuleMatches(target, rule) {
  const text = await readTextOptional(path.join(target, rule.file));
  if (text === null) return false;
  return (rule.patterns || []).some((pattern) => new RegExp(pattern, rule.flags || "i").test(text));
}

async function listProfileIds() {
  const entries = await fsp.readdir(path.join(installerRoot, "profiles"), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -5))
    .sort();
}

async function loadProfile(profileId) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(profileId)) throw new Error("Invalid profile ID: " + profileId);
  const file = path.join(installerRoot, "profiles", profileId + ".json");
  if (!(await exists(file))) throw new Error("Unsupported profile: " + profileId);
  const profile = await readJson(file);
  if (profile.schema_version !== 2 || profile.profile_id !== profileId || typeof profile.display_name !== "string") {
    throw new Error("Profile schema is invalid: " + profileId);
  }
  return profile;
}

async function autoProfileMatches(target, profile) {
  const rules = profile.auto_detection || {};
  if ((rules.files_all || []).length > 0) {
    const matches = await Promise.all(rules.files_all.map((file) => exists(path.join(target, file))));
    if (!matches.every(Boolean)) return false;
  }
  if ((rules.files_any || []).length > 0
      && !(await Promise.all(rules.files_any.map((file) => exists(path.join(target, file))))).some(Boolean)) return false;
  if ((rules.root_globs_any || []).length > 0) {
    const matches = await Promise.all(rules.root_globs_any.map((pattern) => rootGlobMatches(target, pattern)));
    if (!matches.some((entries) => entries.length > 0)) return false;
  }
  if ((rules.content_all || []).length > 0) {
    const matches = await Promise.all(rules.content_all.map((rule) => contentRuleMatches(target, rule)));
    if (!matches.every(Boolean)) return false;
  }
  if ((rules.content_any || []).length > 0) {
    const matches = await Promise.all(rules.content_any.map((rule) => contentRuleMatches(target, rule)));
    if (!matches.some(Boolean)) return false;
  }
  if ((rules.content_none || []).length > 0) {
    const matches = await Promise.all(rules.content_none.map((rule) => contentRuleMatches(target, rule)));
    if (matches.some(Boolean)) return false;
  }
  return Object.values(rules).some((value) => Array.isArray(value) && value.length > 0);
}

export async function resolveProfile(target, requestedId) {
  if (requestedId !== "auto") return await loadProfile(requestedId);
  const matched = [];
  for (const id of await listProfileIds()) {
    const profile = await loadProfile(id);
    if (await autoProfileMatches(target, profile)) matched.push(profile);
  }
  if (matched.length === 0) throw new Error("Auto profile detection found no supported project profile.");
  if (matched.length > 1) {
    throw new Error("Auto profile detection is ambiguous; choose --profile explicitly from: " + matched.map((profile) => profile.profile_id).join(", "));
  }
  return matched[0];
}

export async function detectProject(target, profile) {
  const evidence = [];
  for (const candidate of profile.required_files_any || []) {
    if (await exists(path.join(target, candidate))) evidence.push(candidate);
  }
  for (const pattern of profile.required_root_globs_any || []) {
    evidence.push(...await rootGlobMatches(target, pattern));
  }
  const capabilities = [];
  const verificationCommands = [];
  for (const rule of profile.capability_patterns || []) {
    if (await contentRuleMatches(target, rule)) capabilities.push(rule.name);
  }
  if (profile.dependency_manifest) {
    const manifestPath = path.join(target, profile.dependency_manifest.file);
    const manifest = await readJsonOptional(manifestPath);
    if (manifest) {
      const dependencies = Object.assign({}, ...(profile.dependency_manifest.sections || []).map((section) => manifest[section] || {}));
      for (const rule of profile.dependency_manifest.capabilities || []) {
        if ((rule.dependencies || []).some((dependency) => Object.hasOwn(dependencies, dependency))) capabilities.push(rule.name);
      }
      const scripts = manifest[profile.dependency_manifest.script_section || "scripts"] || {};
      for (const script of profile.verification_script_candidates || []) {
        if (typeof scripts[script] === "string") {
          verificationCommands.push((profile.dependency_manifest.script_runner || "npm run") + " " + script);
        }
      }
    }
  }
  verificationCommands.push(...(profile.verification_candidates || []));
  // T0-06: Gate A reads verification_rules only; lint_rules stay here for the detection summary.
  for (const rule of [...(profile.verification_rules || []), ...(profile.lint_rules || [])]) {
    const filesAny = rule.files_any || [];
    const filesNone = rule.files_none || [];
    const anyPresent = filesAny.length === 0
      || (await Promise.all(filesAny.map((file) => exists(path.join(target, file))))).some(Boolean);
    const nonePresent = (await Promise.all(filesNone.map((file) => exists(path.join(target, file))))).every((present) => !present);
    const platformMatches = (!rule.platform && !rule.platforms)
      || rule.platform === process.platform
      || (rule.platforms || []).includes(process.platform);
    if (anyPresent && nonePresent && platformMatches) verificationCommands.push(rule.command);
  }
  return {
    evidence: [...new Set(evidence)].sort(),
    capabilities: [...new Set(capabilities)].sort(),
    verification_commands: [...new Set(verificationCommands)],
    semantic_reference_tool: profile.semantic_reference_tool,
    structural_search_tool: profile.structural_search_tool,
    execute_during_apply: false,
  };
}

async function sourceInfo() {
  const packageManifest = await readJson(path.join(installerRoot, "review-bridge", "templates", "PACKAGE_MANIFEST.json"));
  const runtimeFiles = await walkFiles(path.join(installerRoot, "review-bridge"));
  return { bridge_version: packageManifest.version, runtime_files: runtimeFiles, runtime_sha256: digest(canonicalText(runtimeFiles)) };
}

async function targetFingerprint(target) {
  const states = [];
  for (const relative of [".gitignore", ".git/info/exclude", "Cargo.toml", "package.json", ...impactPaths]) {
    states.push(await pathState(target, relative));
  }
  return digest(canonicalText(states));
}

function defaultBackupRoot() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share");
  return path.resolve(base, "CodexReviewBridge", "backups");
}

function externalBackupRoot(value, target) {
  const root = path.resolve(value || defaultBackupRoot());
  const relative = path.relative(path.resolve(target), root);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("Persistent backup root must be outside the target repository.");
  }
  return root;
}

async function makePlan({
  target,
  profileId,
  operation = "install",
  adoptExisting = false,
  backupRoot = null,
  executionMode = "native",
}) {
  if (!["install", "upgrade", "uninstall", "rollback"].includes(operation)) throw new Error("Unsupported operation: " + operation);
  const root = path.resolve(target);
  const targetState = await fsp.lstat(root).catch(() => null);
  if (!targetState?.isDirectory() || targetState.isSymbolicLink()) {
    throw new Error("Target must be an existing, non-symlink workspace directory.");
  }
  const workspace = inspectWorkspace(root);
  const stateFilesystem = inspectStateFilesystem(root);
  const profile = await resolveProfile(root, profileId);
  const findings = [];
  if (!stateFilesystem.supported_for_concurrent_controller) {
    findings.push({
      severity: "BLOCKER",
      code: "UNSUPPORTED_STATE_FILESYSTEM",
      message: "Concurrent controller state is unsupported here: " + stateFilesystem.reasons.join(", "),
    });
  }
  if (workspace.git_repository && !workspace.claude_private_boundary_ignored) {
    findings.push({ severity: "BLOCKER", code: "PRIVATE_BOUNDARY_MISSING", message: ".claude/ is not ignored; the installer will not modify tracked .gitignore." });
  }
  const detection = await detectProject(root, profile);
  if (detection.evidence.length === 0) findings.push({ severity: "BLOCKER", code: "PROFILE_MISMATCH", message: "The selected profile has no required project evidence." });
  const settingsPath = path.join(root, managed.settings);
  let settings = {};
  try {
    settings = (await readJsonOptional(settingsPath)) || {};
  } catch (error) {
    findings.push({ severity: "HIGH", code: "SETTINGS_INVALID", message: error.message });
  }
  const hooks = bridgeHooks(settings);
  const existingManifest = await readJsonOptional(path.join(root, managed.manifest));
  const incompleteUpgrade = await readJsonOptional(path.join(root, managed.upgradeMarker));
  const existingRuntimePrompt = path.join(root, managed.runtime, "review-prompt.md");
  const promptOverridePath = path.join(root, managed.promptOverride);
  const packagedPrompt = path.join(installerRoot, "review-bridge", "review-prompt.md");
  const runtimePromptPresent = await exists(existingRuntimePrompt);
  const promptOverridePresent = await exists(promptOverridePath);
  const runtimePromptSha256 = runtimePromptPresent ? await hashFile(existingRuntimePrompt) : null;
  const promptOverrideSha256 = promptOverridePresent ? await hashFile(promptOverridePath) : null;
  const packagedPromptSha256 = await hashFile(packagedPrompt);
  const preserveExistingRuntimePrompt = operation === "install"
    && adoptExisting
    && runtimePromptPresent
    && runtimePromptSha256 !== packagedPromptSha256
    && !promptOverridePresent;
  if (operation === "install" && adoptExisting && runtimePromptPresent && promptOverridePresent
      && runtimePromptSha256 !== promptOverrideSha256) {
    findings.push({ severity: "HIGH", code: "PROJECT_PROMPT_CONFLICT", message: "Existing runtime and project override review prompts differ; resolve which project policy is authoritative before adoption." });
  }
  for (const relative of impactPaths) {
    const state = await pathState(root, relative);
    if (state.state === "symlink") {
      findings.push({ severity: "HIGH", code: "MANAGED_PATH_SYMLINK", message: "Managed path cannot be a symlink: " + relative });
    }
  }
  if (operation === "install" && existingManifest) findings.push({ severity: "BLOCKER", code: "ALREADY_INSTALLED", message: "Use an upgrade plan for an installed target." });
  if (operation !== "install" && !existingManifest) findings.push({ severity: "BLOCKER", code: "NOT_INSTALLED", message: "No ownership manifest exists for this operation." });
  if (incompleteUpgrade && operation !== "rollback") {
    findings.push({
      severity: "BLOCKER",
      code: "INCOMPLETE_UPGRADE",
      message: "An interrupted upgrade is present. Use a checksum-approved rollback before another operation.",
    });
  }
  if (operation === "install" && hooks.length > 0 && !adoptExisting) findings.push({ severity: "HIGH", code: "UNMANAGED_BRIDGE_HOOK", message: "Existing review-bridge hook requires an explicit --adopt-existing plan." });
  const source = await sourceInfo();
  const resolvedBackupRoot = externalBackupRoot(backupRoot, root);
  const rollbackPoint = operation === "rollback"
    ? incompleteUpgrade?.rollback_point || existingManifest?.rollback_points?.at(-1) || null
    : null;
  if (operation === "rollback" && !rollbackPoint) findings.push({ severity: "BLOCKER", code: "ROLLBACK_POINT_MISSING", message: "The ownership manifest has no persistent pre-operation snapshot." });
  for (const finding of findings) finding.remediation = remediationForFinding(finding);
  const plan = {
    schema_version: 1,
    installer: { name: "codex-review-bridge-installer", version: installerVersion },
    operation,
    execution_mode: executionMode,
    target: {
      root,
      workspace_mode: workspace.mode,
      git_available: workspace.git_available,
      git_repository: workspace.git_repository,
      git_root: workspace.git_root,
      head: workspace.head,
    },
    profile: { id: profile.profile_id, display_name: profile.display_name },
    detection,
    source,
    adoption: { existing_bridge: Boolean(adoptExisting), observed_bridge_hooks: hooks },
    project_prompt: {
      override_path: managed.promptOverride,
      override_present: promptOverridePresent,
      preserve_existing_runtime_prompt: preserveExistingRuntimePrompt,
      existing_runtime_prompt_sha256: runtimePromptSha256,
    },
    observations: {
      claude_private_boundary_ignored: workspace.claude_private_boundary_ignored,
      state_filesystem: stateFilesystem,
      settings_present: await exists(settingsPath),
      ownership_manifest_present: Boolean(existingManifest),
    },
    backup: { root: resolvedBackupRoot, persistent: true, rollback_point: rollbackPoint },
    changes: operation === "uninstall"
      ? ["snapshot current bridge state outside the repository", "remove unchanged installer-owned files", "remove exact owned Stop hook", "preserve modified or runtime state", "remove ownership manifest"]
      : operation === "rollback"
        ? ["snapshot current post-install state outside the repository", "restore the selected pre-operation snapshot", "verify restored path hashes"]
        : ["snapshot pre-operation state outside the repository", ...(preserveExistingRuntimePrompt ? ["preserve the existing project review prompt as a project-owned override"] : []), "install review bridge runtime", "merge one Stop hook", "install project rule", "seed v4 bridge config and project policy override", "write ownership manifest"],
    verification: {
      commands: [executionMode === "fake_cli"
        ? "node .claude/tools/review-bridge/bootstrap.mjs doctor --fake-cli"
        : "node .claude/tools/review-bridge/bootstrap.mjs doctor"],
      project_commands: detection.verification_commands,
      run_project_commands: false,
    },
    findings,
    state_fingerprint: await targetFingerprint(root),
  };
  plan.plan_sha256 = digest(canonicalText(plan));
  return plan;
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function copyPath(source, target) {
  if (!(await exists(source))) return;
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.cp(source, target, { recursive: true, force: true, errorOnExist: false });
}

function assertUnder(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Managed path escaped or resolved to the repository root: " + candidate);
  }
  return path.resolve(candidate);
}

async function removePath(candidate, root) {
  await fsp.rm(assertUnder(candidate, root), { recursive: true, force: true });
}

function targetBackupKey(target) {
  const normalized = process.platform === "win32"
    ? path.resolve(target).toLowerCase()
    : path.resolve(target);
  return digest(normalized).slice(0, 24);
}

function snapshotDirectory(target, backupRoot, snapshotId) {
  if (!/^[0-9TZ-]+-[0-9a-f-]{36}$/.test(snapshotId)) {
    throw new Error("Persistent snapshot ID is invalid.");
  }
  const root = externalBackupRoot(backupRoot, target);
  return assertUnder(path.join(root, targetBackupKey(target), snapshotId), root);
}

async function createPersistentSnapshot(target, backupRoot, reason) {
  const id = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID();
  const directory = snapshotDirectory(target, backupRoot, id);
  const dataRoot = path.join(directory, "data");
  await fsp.mkdir(dataRoot, { recursive: true });
  const states = [];
  for (const relative of impactPaths) {
    const state = await pathState(target, relative);
    if (state.state === "symlink") throw new Error("Persistent snapshots do not accept symlinked managed paths: " + relative);
    states.push(state);
    if (state.state !== "missing") {
      await copyPath(path.join(target, relative), path.join(dataRoot, relative));
    }
  }
  const snapshotManifest = {
    schema_version: 1,
    snapshot_id: id,
    target_root: path.resolve(target),
    target_key: targetBackupKey(target),
    reason,
    created_at: new Date().toISOString(),
    paths: states,
  };
  const manifestPath = path.join(directory, "snapshot.json");
  await writeJson(manifestPath, snapshotManifest);
  return {
    snapshot_id: id,
    backup_root: externalBackupRoot(backupRoot, target),
    manifest_sha256: await hashFile(manifestPath),
    reason,
    created_at: snapshotManifest.created_at,
  };
}

async function readPersistentSnapshot(target, point) {
  if (!point || typeof point.snapshot_id !== "string" || typeof point.backup_root !== "string") {
    throw new Error("Persistent rollback point is incomplete.");
  }
  const directory = snapshotDirectory(target, point.backup_root, point.snapshot_id);
  const manifestPath = path.join(directory, "snapshot.json");
  if (!(await exists(manifestPath))) throw new Error("Persistent rollback snapshot is missing.");
  if (await hashFile(manifestPath) !== point.manifest_sha256) throw new Error("Persistent rollback snapshot manifest checksum mismatch.");
  const snapshot = await readJson(manifestPath);
  if (path.resolve(snapshot.target_root).toLowerCase() !== path.resolve(target).toLowerCase()
      || snapshot.target_key !== targetBackupKey(target)
      || snapshot.snapshot_id !== point.snapshot_id) {
    throw new Error("Persistent rollback snapshot does not belong to this target.");
  }
  const expectedPaths = [...impactPaths].sort();
  const actualPaths = (snapshot.paths || []).map((entry) => entry.path).sort();
  if (canonicalText(expectedPaths) !== canonicalText(actualPaths)) {
    throw new Error("Persistent rollback snapshot path coverage is invalid.");
  }
  const dataStates = [];
  const dataRoot = path.join(directory, "data");
  for (const expected of snapshot.paths) {
    if (!expected || typeof expected.path !== "string" || !["missing", "file", "directory"].includes(expected.state)) {
      throw new Error("Persistent rollback snapshot contains an invalid path state.");
    }
    dataStates.push(await pathState(dataRoot, expected.path));
  }
  if (canonicalText(dataStates) !== canonicalText(snapshot.paths)) {
    throw new Error("Persistent rollback snapshot data checksum mismatch.");
  }
  return { directory, dataRoot, snapshot };
}

async function restorePersistentSnapshot(target, point) {
  const loaded = await readPersistentSnapshot(target, point);
  for (const relative of impactPaths) await removePath(path.join(target, relative), target);
  for (const state of loaded.snapshot.paths) {
    if (state.state !== "missing") {
      await copyPath(path.join(loaded.dataRoot, state.path), path.join(target, state.path));
    }
  }
  const restored = [];
  for (const relative of impactPaths) restored.push(await pathState(target, relative));
  if (canonicalText(restored) !== canonicalText(loaded.snapshot.paths)) {
    throw new Error("Restored target does not match the persistent snapshot.");
  }
  return loaded.snapshot;
}

async function removePersistentSnapshot(target, point) {
  if (!point) return;
  const root = externalBackupRoot(point.backup_root, target);
  const targetDirectory = assertUnder(path.join(root, targetBackupKey(target)), root);
  const directory = snapshotDirectory(target, point.backup_root, point.snapshot_id);
  await fsp.rm(directory, { recursive: true, force: true });
  for (const candidate of [targetDirectory, root]) {
    try {
      await fsp.rmdir(candidate);
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;
    }
  }
}

async function acquireInstallerLock(target) {
  const lock = path.join(target, ".claude", ".review-bridge-installer.lock");
  await fsp.mkdir(path.dirname(lock), { recursive: true });
  let handle;
  try {
    handle = await fsp.open(lock, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  } catch (error) {
    throw new Error("Installer lock is already held or invalid: " + error.message);
  }
  return async () => {
    await handle.close();
    await fsp.rm(lock, { force: true });
  };
}

async function backupImpacted(target, backupRoot) {
  const backedUp = [];
  for (const relative of impactPaths) {
    const source = path.join(target, relative);
    if (await exists(source)) {
      await copyPath(source, path.join(backupRoot, relative));
      backedUp.push(relative);
    }
  }
  return backedUp;
}

async function rollback(target, backupRoot, backedUp) {
  for (const relative of impactPaths) await removePath(path.join(target, relative), target);
  for (const relative of backedUp) await copyPath(path.join(backupRoot, relative), path.join(target, relative));
}

async function collectOwnedFiles(target) {
  const files = [];
  for (const entry of await walkFiles(path.join(target, managed.runtime))) files.push({ path: path.posix.join(managed.runtime, entry.path), sha256: entry.sha256, kind: "runtime" });
  files.push({ path: managed.rule, sha256: await hashFile(path.join(target, managed.rule)), kind: "rule" });
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function verifyInstalled(target, { print = true, executionMode = null } = {}) {
  const manifestPath = path.join(target, managed.manifest);
  const manifest = await readJson(manifestPath);
  const mode = executionMode || manifest.execution_mode || "native";
  const errors = [];
  for (const file of manifest.owned_files || []) {
    const absolute = path.join(target, file.path);
    if (!(await exists(absolute))) errors.push("missing owned file: " + file.path);
    else if (await hashFile(absolute) !== file.sha256) errors.push("modified owned file: " + file.path);
  }
  const settings = await readJson(path.join(target, managed.settings));
  const exactHooks = bridgeHooks(settings).filter((hook) => hook.command === hookCommand);
  if (exactHooks.length !== 1) errors.push("expected exactly one owned Stop hook, found " + exactHooks.length);
  const doctorArgs = [path.join(target, managed.runtime, "bootstrap.mjs"), "doctor"];
  if (mode === "fake_cli") doctorArgs.push("--fake-cli");
  const doctor = spawnSync(process.execPath, doctorArgs, { cwd: target, encoding: "utf8" });
  if (doctor.status !== 0) {
    const detail = doctor.stderr || doctor.stdout || doctor.error?.message || "unknown child-process failure";
    errors.push("bridge doctor failed: " + String(detail).trim());
  }
  else {
    try {
      const result = JSON.parse(doctor.stdout);
      if (result.valid !== true) errors.push("bridge doctor did not report valid=true");
    } catch (error) {
      errors.push("bridge doctor returned invalid JSON: " + error.message);
    }
  }
  const result = {
    valid: errors.length === 0,
    errors,
    manifest_version: manifest.installer_version,
    execution_mode: mode,
    authorization_expected: "no active v4 run",
  };
  if (print) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.valid) {
    throw new Error("Installed bridge verification failed:\n- " + errors.join("\n- "));
  }
  return result;
}

async function installOrUpgrade(target, plan, rollbackPoint) {
  const previousManifest = await readJsonOptional(path.join(target, managed.manifest));
  const seeded = previousManifest?.seeded_files ? [...previousManifest.seeded_files] : [];
  const settingsCreated = previousManifest?.settings_created ?? !(await exists(path.join(target, managed.settings)));
  const directoryCandidates = [
    ".claude/tools/review-bridge", ".claude/review-bridge", ".claude/rules", ".claude/work-packages", ".claude/review-queue",
    ".claude/review-queue/pending", ".claude/review-queue/running",
    ".claude/review-queue/done", ".claude/review-queue/failed", ".claude/review-queue/work-packages",
    ".claude/review-queue/authorizations", ".claude/review-queue/authorization-claims",
    ".claude/review-queue/authorization-invalidations", ".claude/review-queue/runs",
    ".claude/review-queue/events", ".claude/review-queue/run-locks",
    ".claude/review-queue/reconcile-guards", ".claude/review-queue/upgrade-reports",
    ".claude/review-bridge/policy-snapshots", ".claude/reviews",
  ];
  const createdDirectories = previousManifest?.created_directories ? [...previousManifest.created_directories] : [];
  for (const relative of directoryCandidates) {
    if (!(await exists(path.join(target, relative)))) createdDirectories.push(relative);
  }
  const runtimeTarget = path.join(target, managed.runtime);
  const isUpgrade = plan.operation === "upgrade";
  let upgrade = null;
  let upgradeReport = null;
  if (isUpgrade) {
    const paths = getBridgePaths(target, runtimeTarget);
    const marker = await beginUpgrade(paths, {
      from_installer_version: previousManifest?.installer_version || null,
      to_installer_version: installerVersion,
      rollback_point: rollbackPoint,
    });
    const toolsRoot = path.dirname(runtimeTarget);
    upgrade = {
      paths,
      marker,
      stagedRuntime: path.join(toolsRoot, ".review-bridge-next-" + marker.upgrade_id),
      previousRuntime: path.join(toolsRoot, ".review-bridge-previous-" + marker.upgrade_id),
      activated: false,
    };
  }
  try {
  if (plan.project_prompt?.preserve_existing_runtime_prompt) {
    const source = path.join(target, managed.runtime, "review-prompt.md");
    const destination = path.join(target, managed.promptOverride);
    if (!(await exists(source))) throw new Error("Planned project review prompt source is missing.");
    if (await exists(destination)) throw new Error("Project review prompt override appeared after planning.");
    await copyPath(source, destination);
  }
  if (upgrade) {
    await copyPath(path.join(installerRoot, "review-bridge"), upgrade.stagedRuntime);
    await fsp.rename(runtimeTarget, upgrade.previousRuntime);
    try {
      await fsp.rename(upgrade.stagedRuntime, runtimeTarget);
      upgrade.activated = true;
    } catch (error) {
      await fsp.rename(upgrade.previousRuntime, runtimeTarget);
      throw error;
    }
    if (process.env.REVIEW_BRIDGE_INSTALLER_TEST_FAULT === "upgrade-after-runtime-activation") {
      throw new Error("Injected failure after atomic runtime activation.");
    }
  } else {
    await removePath(runtimeTarget, target);
    await copyPath(path.join(installerRoot, "review-bridge"), runtimeTarget);
  }
  await fsp.mkdir(path.dirname(path.join(target, managed.rule)), { recursive: true });
  await fsp.copyFile(path.join(installerRoot, "project-templates", "review-bridge.md"), path.join(target, managed.rule));
  if (!(await exists(path.join(target, managed.workTemplate)))) {
    await fsp.mkdir(path.dirname(path.join(target, managed.workTemplate)), { recursive: true });
    await fsp.copyFile(path.join(installerRoot, "project-templates", "work-package.md"), path.join(target, managed.workTemplate));
    seeded.push({ path: managed.workTemplate, seed_sha256: await hashFile(path.join(target, managed.workTemplate)) });
  }
  if (!(await exists(path.join(target, managed.rulesDigest)))) {
    await fsp.mkdir(path.dirname(path.join(target, managed.rulesDigest)), { recursive: true });
    await fsp.copyFile(path.join(installerRoot, "project-templates", "rules.md"), path.join(target, managed.rulesDigest));
    seeded.push({ path: managed.rulesDigest, seed_sha256: await hashFile(path.join(target, managed.rulesDigest)) });
  }
  const settingsPath = path.join(target, managed.settings);
  await writeJson(settingsPath, mergeHook((await readJsonOptional(settingsPath)) || {}));
  if (!(await exists(path.join(target, managed.bridgeConfig)))) {
    await writeJson(path.join(target, managed.bridgeConfig), bridgeConfig(plan.profile.id, await loadProfile(plan.profile.id)));
    seeded.push({ path: managed.bridgeConfig, seed_sha256: await hashFile(path.join(target, managed.bridgeConfig)) });
  }
  if (!(await exists(path.join(target, managed.policyOverride)))) {
    await writeJson(path.join(target, managed.policyOverride), projectPolicyOverride(await loadProfile(plan.profile.id)));
    seeded.push({ path: managed.policyOverride, seed_sha256: await hashFile(path.join(target, managed.policyOverride)) });
  }
  for (const directory of [
    "pending", "running", "done", "failed", "work-packages", "authorizations",
    "authorization-claims", "authorization-invalidations", "runs", "events", "run-locks",
    "reconcile-guards", "upgrade-reports",
  ]) await fsp.mkdir(path.join(target, ".claude", "review-queue", directory), { recursive: true });
  await fsp.mkdir(path.join(target, ".claude", "review-bridge", "policy-snapshots"), { recursive: true });
  await fsp.mkdir(path.join(target, ".claude", "reviews"), { recursive: true });
  if (upgrade) upgradeReport = await reportUpgradeInvalidations(getBridgePaths(target, runtimeTarget));
  const ownedFiles = await collectOwnedFiles(target);
  await writeJson(path.join(target, managed.manifest), {
    schema_version: 1,
    installer_version: installerVersion,
    bridge_version: plan.source.bridge_version,
    profile_id: plan.profile.id,
    execution_mode: plan.execution_mode || "native",
    installed_at: previousManifest?.installed_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    rollback_points: [...(previousManifest?.rollback_points || []), rollbackPoint],
    settings_created: settingsCreated,
    created_directories: [...new Set(createdDirectories)],
    seeded_files: seeded,
    owned_files: ownedFiles,
    shared_settings: { path: managed.settings, hook_command: hookCommand },
    latest_upgrade_report: upgradeReport ? {
      report_id: upgradeReport.report_id,
      invalidated_count: upgradeReport.invalidated_count,
    } : null,
  });
  if (process.env.REVIEW_BRIDGE_INSTALLER_TEST_FAULT === "after-write") {
    throw new Error("Injected installer transaction fault.");
  }
  await verifyInstalled(target, { print: false });
  if (upgrade) {
    await completeUpgrade(upgrade.paths);
    await removePath(upgrade.previousRuntime, target);
  }
  return { upgrade_report: upgradeReport };
  } catch (error) {
    if (upgrade) {
      if (upgrade.activated) {
        await removePath(runtimeTarget, target);
        if (await exists(upgrade.previousRuntime)) await fsp.rename(upgrade.previousRuntime, runtimeTarget);
      } else {
        await removePath(upgrade.stagedRuntime, target);
      }
      await completeUpgrade(upgrade.paths).catch(() => {});
    }
    throw error;
  }
}

async function uninstall(target) {
  const manifest = await readJson(path.join(target, managed.manifest));
  const modified = [];
  for (const file of manifest.owned_files || []) {
    const absolute = path.join(target, file.path);
    if (!(await exists(absolute))) continue;
    if (await hashFile(absolute) === file.sha256) await removePath(absolute, target);
    else modified.push(file.path);
  }
  if (modified.length > 0) throw new Error("Human-modified installer-owned files require a new decision: " + modified.join(", "));
  const preservedSeeded = [];
  for (const file of manifest.seeded_files || []) {
    const absolute = path.join(target, file.path);
    if (!(await exists(absolute))) continue;
    if (await hashFile(absolute) === file.seed_sha256) await removePath(absolute, target);
    else preservedSeeded.push(file.path);
  }
  const settingsPath = path.join(target, managed.settings);
  const settings = await readJsonOptional(settingsPath);
  if (settings) {
    const cleaned = removeHook(settings);
    const noStopHooks = Array.isArray(cleaned?.hooks?.Stop) && cleaned.hooks.Stop.length === 0;
    if (noStopHooks) delete cleaned.hooks.Stop;
    if (cleaned.hooks && Object.keys(cleaned.hooks).length === 0) delete cleaned.hooks;
    if (manifest.settings_created && Object.keys(cleaned).length === 0) await removePath(settingsPath, target);
    else await writeJson(settingsPath, cleaned);
  }
  await removePath(path.join(target, managed.manifest), target);
  for (const relative of [...(manifest.created_directories || [])].sort((a, b) => b.length - a.length)) {
    const absolute = path.join(target, relative);
    try {
      const entries = await fsp.readdir(absolute);
      if (entries.length === 0) await fsp.rmdir(absolute);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
  }
  return { preserved_seeded_files: preservedSeeded };
}

async function executeApproved(command, options) {
  if (!options.target || !options.plan || !options.approve) throw new Error("--target, --plan, and --approve are required.");
  const target = path.resolve(options.target);
  const plan = await readJson(path.resolve(options.plan));
  const expectedHash = plan.plan_sha256;
  const copy = structuredClone(plan);
  delete copy.plan_sha256;
  const actualHash = digest(canonicalText(copy));
  if (actualHash !== expectedHash || options.approve !== expectedHash) throw new Error("Plan checksum approval does not match canonical plan content.");
  const expectedOperation = command === "apply" ? "install" : command;
  if (plan.operation !== expectedOperation) throw new Error("Plan operation does not match command.");
  if (path.resolve(plan.target.root).toLowerCase() !== target.toLowerCase()) throw new Error("Plan target does not match --target.");
  if (plan.findings.some((finding) => ["BLOCKER", "HIGH"].includes(finding.severity))) throw new Error("Approved plan still contains a blocker or HIGH finding.");
  const fresh = await makePlan({
    target,
    profileId: plan.profile.id,
    operation: plan.operation,
    adoptExisting: plan.adoption.existing_bridge,
    backupRoot: plan.backup.root,
  });
  if (fresh.state_fingerprint !== plan.state_fingerprint) throw new Error("Target installer-relevant state changed after planning.");
  if (fresh.source.runtime_sha256 !== plan.source.runtime_sha256) throw new Error("Installer runtime source changed after planning.");
  const release = await acquireInstallerLock(target);
  const transactionId = randomUUID();
  const localBackupRoot = path.join(target, ".claude", ".review-bridge-installer-backup-" + transactionId);
  let backedUp = [];
  let transactionBackupReady = false;
  let persistentPoint = null;
  try {
    if (command === "rollback") await readPersistentSnapshot(target, plan.backup.rollback_point);
    backedUp = await backupImpacted(target, localBackupRoot);
    transactionBackupReady = true;
    persistentPoint = await createPersistentSnapshot(
      target,
      plan.backup.root,
      command === "rollback" ? "pre-rollback-safety" : "pre-" + plan.operation,
    );
    let operationResult = null;
    if (command === "uninstall") operationResult = await uninstall(target);
    else if (command === "rollback") operationResult = await restorePersistentSnapshot(target, plan.backup.rollback_point);
    else operationResult = await installOrUpgrade(target, plan, persistentPoint);
    await removePath(localBackupRoot, target);
    process.stdout.write(JSON.stringify({
      ok: true,
      operation: plan.operation,
      target,
      plan_sha256: expectedHash,
      persistent_snapshot: persistentPoint,
      restored_snapshot: command === "rollback" ? plan.backup.rollback_point : null,
      result: operationResult,
    }, null, 2) + "\n");
  } catch (error) {
    if (transactionBackupReady) await rollback(target, localBackupRoot, backedUp);
    await removePath(localBackupRoot, target);
    await removePersistentSnapshot(target, persistentPoint);
    throw new Error("Transaction rolled back: " + error.message);
  } finally {
    await release();
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(usage() + "\n");
    return command ? 0 : 2;
  }
  const options = parseArgs(rest);
  if (command === "plan") {
    if (!options.target || !options.profile) throw new Error("--target and --profile are required.");
    const plan = await makePlan({
      target: options.target,
      profileId: options.profile,
      operation: options.operation || "install",
      adoptExisting: Boolean(options["adopt-existing"]),
      backupRoot: options["backup-root"] || null,
      executionMode: options["fake-cli"] ? "fake_cli" : "native",
    });
    const output = JSON.stringify(plan, null, 2) + "\n";
    if (options.out) await fsp.writeFile(path.resolve(options.out), output, "utf8");
    const blocking = plan.findings.find((finding) => ["BLOCKER", "HIGH"].includes(finding.severity));
    if (options.json) process.stdout.write(output);
    else if (blocking) process.stderr.write(humanFindingLine(blocking) + "\n");
    else process.stdout.write(`Plan ready: ${plan.plan_sha256}. Review ${options.out || "the plan output"} before apply.\n`);
    return blocking ? 2 : 0;
  }
  if (["apply", "upgrade", "uninstall", "rollback"].includes(command)) {
    await executeApproved(command, options);
    return 0;
  }
  if (command === "verify") {
    if (!options.target) throw new Error("--target is required.");
    await verifyInstalled(path.resolve(options.target), {
      executionMode: options["fake-cli"] ? "fake_cli" : null,
    });
    return 0;
  }
  throw new Error("Unknown command: " + command);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write("Installer failed closed: " + error.message + "\n");
    process.exitCode = 2;
  }
}
