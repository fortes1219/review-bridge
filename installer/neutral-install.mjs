import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { inspectStateFilesystem } from "../review-bridge/core/filesystem-v4.mjs";
import { getBridgePaths } from "../review-bridge/core/paths.mjs";
import { canonical } from "../review-bridge/core/policy-v4.mjs";
import {
  ACTIVE_RUN_STATUSES as RUN_ACTIVE, TERMINAL_RUN_STATUSES as RUN_TERMINAL, planUpgradeInvalidations, policyIdentity,
} from "../review-bridge/core/state-v4.mjs";
import { projectPolicyOverride, resolveProfile, detectProject } from "./project-profile.mjs";
import { validateRoles } from "./role-readiness.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privateName = ".review-bridge";

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function statOptional(file) {
  try { return await fsp.lstat(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function git(target, args) {
  const result = spawnSync("git", args, {
    cwd: target, encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function under(child, parent) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function runtimeFingerprint(root = path.join(packageRoot, "review-bridge")) {
  const rootStat = await fsp.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Runtime root must be a normal directory.");
  const files = [];
  async function visit(directory, relative = "") {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Runtime source contains a symlink.");
      const next = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), next);
      else if (entry.isFile()) files.push([next, sha256(await fsp.readFile(path.join(directory, entry.name)))]);
    }
  }
  await visit(root);
  files.sort((left, right) => left[0].localeCompare(right[0]));
  return sha256(JSON.stringify(files));
}

function gitBoundary(target) {
  const gitRootText = git(target, ["rev-parse", "--show-toplevel"]);
  if (!gitRootText) return { repository: false, ignored: null, excludePath: null, pattern: null };
  const gitRoot = path.resolve(gitRootText);
  const gitDirText = git(target, ["rev-parse", "--absolute-git-dir"]);
  const excludeText = git(target, ["rev-parse", "--git-path", "info/exclude"]);
  if (!gitDirText || !excludeText) throw new Error("Cannot locate local Git exclusion file.");
  const gitDir = path.resolve(gitDirText);
  const excludePath = path.resolve(target, excludeText);
  if (!under(excludePath, gitDir)) throw new Error("Git exclusion path is outside the selected Git directory.");
  const relativeTarget = path.relative(gitRoot, target).replaceAll("\\", "/");
  if (relativeTarget === ".." || relativeTarget.startsWith("../") || path.isAbsolute(relativeTarget)) {
    throw new Error("Target is outside its Git repository.");
  }
  const pattern = "/" + (relativeTarget ? relativeTarget + "/" : "") + privateName + "/";
  const ignored = spawnSync("git", ["check-ignore", "-q", "--no-index", path.join(target, privateName, "review-bridge-install.json")], {
    cwd: target, windowsHide: true, timeout: 10_000, stdio: "ignore",
  }).status === 0;
  return { repository: true, ignored, excludePath, pattern };
}

async function assertSafeExcludePath(excludePath) {
  const parent = await statOptional(path.dirname(excludePath));
  const file = await statOptional(excludePath);
  if (parent && (!parent.isDirectory() || parent.isSymbolicLink())) {
    throw new Error("Local Git exclusion directory is not a normal directory.");
  }
  if (file && (!file.isFile() || file.isSymbolicLink())) {
    throw new Error("Local Git exclusion file is not a normal file.");
  }
}

export const DEFAULT_WATCH_PORT = 8080;
export const DEFAULT_RETENTION_DAYS = 15;

function validateRetentionDays(days) {
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error("retention.days must be a whole number from 1 to 365.");
  }
  return days;
}

function validateWatchPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Watch port must be 1 through 65535.");
  return port;
}

export async function planNeutralInstall({ target, profileId = "auto", roles, watchPort = DEFAULT_WATCH_PORT }) {
  const root = path.resolve(target);
  const stat = await statOptional(root);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Target must be an existing, non-symlink workspace directory.");
  }
  const filesystem = inspectStateFilesystem(root);
  if (!filesystem.supported_for_concurrent_controller) {
    throw new Error("Bridge state requires a supported local filesystem.");
  }
  const selected = validateRoles(roles);
  const profile = await resolveProfile(root, profileId);
  const detection = await detectProject(root, profile);
  if (detection.evidence.length === 0) throw new Error("The selected profile has no project evidence.");
  if (await statOptional(path.join(root, privateName))) {
    throw new Error("Bridge neutral state already exists; fresh install cannot overwrite it.");
  }
  const boundary = gitBoundary(root);
  if (boundary.repository) await assertSafeExcludePath(boundary.excludePath);
  const plan = {
    schema_version: 1,
    operation: "install_neutral",
    target: root,
    roles: selected,
    watch: { port: validateWatchPort(watchPort), strict_port: false },
    retention: { days: DEFAULT_RETENTION_DAYS },
    profile: { id: profile.profile_id, label: profile.display_name, sha256: sha256(JSON.stringify(profile)) },
    detection,
    runtime_sha256: await runtimeFingerprint(),
    work_template_sha256: sha256(await fsp.readFile(path.join(packageRoot, "project-templates", "work-package.md"))),
    rules_sha256: sha256(await fsp.readFile(path.join(packageRoot, "project-templates", "rules.md"))),
    git: boundary,
    changes: [
      ...(boundary.repository && !boundary.ignored ? ["Keep Bridge private state out of Git using local Git exclusion"] : []),
      "Install Bridge-owned state under .review-bridge/",
      "Leave .claude/ and .codex/ untouched",
      "Serve the local page at http://localhost:" + watchPort + "/ (the next free port if it is taken)",
      "Run four fake scenarios in a disposable copy",
    ],
  };
  plan.plan_sha256 = sha256(JSON.stringify(plan));
  return plan;
}

// The bridge.json this version writes; T0-10 upgrades merge an installed one against it.
function neutralBridgeConfig({ profileId, roles, profile, watch = { port: DEFAULT_WATCH_PORT, strict_port: false }, retentionDays = DEFAULT_RETENTION_DAYS }) {
  return {
    schema_version: 4,
    state_contract: "v4",
    profile_id: profileId,
    roles: {
      writer: { provider_id: roles.writer },
      reviewer: { provider_id: roles.reviewer },
      separate_sessions: true,
      reviewer_readonly_required: true,
    },
    requires_human_authorization: true,
    watch: { port: watch.port, strict_port: watch.strict_port },
    retention: { days: retentionDays },
    // T0-07 V4.2: the language pack for result files, notifications and the stdout summary.
    locale: "zh-TW",
    // T0-06 G1.3: the profile-approved verification rules; work-plan picks Gate A from here.
    gate_a: { profile_id: profile.profile_id, rules: structuredClone(profile.verification_rules || []) },
    readiness: { reviewer_readonly_proven: "not_run" },
    default_policy_ref: ".review-bridge/tools/review-bridge/config/default-policy.json",
    project_override_ref: ".review-bridge/review-bridge/policy.override.json",
    active_runs: "derive_from_run_projections",
  };
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function lockOwnerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

const INSTALL_LOCK_BUSY = "Another Bridge installation is active or a stale install lock needs inspection.";

async function createExclusive(file) {
  try {
    return await fsp.open(file, "wx");
  } catch (error) {
    if (error.code === "EEXIST") return null;
    throw error;
  }
}

// An unreadable lock names no owner, so it is never treated as stale.
async function lockOwner(file) {
  try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return null; }
}

// T0-09 (Codex 2026-10-14): a crash leaves the install lock behind. Taking over a lock whose
// recorded process is gone happens only under a dedicated takeover guard, re-reading the lock
// inside it, so two processes can never both delete a stale lock and enter.
async function takeOverStaleLock(lockPath, stale) {
  const guardPath = lockPath + ".takeover";
  const guard = await createExclusive(guardPath);
  if (!guard) {
    const owner = await lockOwner(guardPath);
    if (owner?.pid && lockOwnerAlive(owner.pid)) throw new Error(INSTALL_LOCK_BUSY);
    // A guard with no readable owner yet may be one another process created a moment ago and has
    // not written to; only an old one is treated as interrupted (found by the L1 race test).
    if (!owner?.pid) {
      const stat = await statOptional(guardPath);
      if (!stat || Date.now() - stat.mtimeMs < 30_000) throw new Error(INSTALL_LOCK_BUSY);
    }
    throw new Error("An earlier takeover of the install lock was interrupted. Check that no Bridge install, uninstall or upgrade is running for this project"
      + (owner?.pid ? " (the takeover was by process " + owner.pid + ", which is gone)" : "")
      + ", then delete " + guardPath + " and " + lockPath + " and try again.");
  }
  try {
    await guard.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }) + "\n");
    await guard.close();
    const again = await lockOwner(lockPath);
    if (again && (again.pid !== stale.pid || again.started_at !== stale.started_at || lockOwnerAlive(again.pid))) throw new Error(INSTALL_LOCK_BUSY);
    if (again) await fsp.rm(lockPath, { force: true });
    const handle = await createExclusive(lockPath);
    if (!handle) throw new Error(INSTALL_LOCK_BUSY);
    return handle;
  } finally {
    await fsp.rm(guardPath, { force: true });
  }
}

export async function withInstallLock(target, operation) {
  const lockPath = path.join(path.resolve(target), ".review-bridge-install.lock");
  let handle = await createExclusive(lockPath);
  if (!handle) {
    const owner = await lockOwner(lockPath);
    if (!owner?.pid || lockOwnerAlive(owner.pid)) throw new Error(INSTALL_LOCK_BUSY);
    handle = await takeOverStaleLock(lockPath, owner);
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }) + "\n");
    return await operation();
  } finally {
    await handle.close();
    await fsp.rm(lockPath, { force: true });
  }
}

async function fileSnapshot(root, relative = "") {
  const files = [];
  for (const entry of await fsp.readdir(path.join(root, relative), { withFileTypes: true })) {
    const next = path.posix.join(relative.replaceAll("\\", "/"), entry.name);
    if (entry.isSymbolicLink()) throw new Error("Bridge state contains a symlink.");
    if (entry.isDirectory()) files.push(...await fileSnapshot(root, next));
    else if (entry.isFile()) files.push([next, sha256(await fsp.readFile(path.join(root, next)))]);
  }
  return files.sort((left, right) => left[0].localeCompare(right[0]));
}

export async function applyNeutralInstall(plan, approval) {
  if (plan.schema_version !== 1 || plan.operation !== "install_neutral") {
    throw new Error("Unsupported neutral install plan.");
  }
  const claimed = plan.plan_sha256;
  const content = { ...plan };
  delete content.plan_sha256;
  if (sha256(JSON.stringify(content)) !== claimed || approval !== claimed) {
    throw new Error("Neutral install plan approval is invalid.");
  }
  return withInstallLock(plan.target, () => applyNeutralInstallLocked(plan, claimed));
}

async function applyNeutralInstallLocked(plan, claimed) {
  const fresh = await planNeutralInstall({
    target: plan.target, profileId: plan.profile.id, roles: plan.roles, watchPort: plan.watch?.port,
  });
  if (fresh.plan_sha256 !== claimed) throw new Error("Neutral install plan is stale.");
  const privateRoot = path.join(plan.target, privateName);
  const excludePath = plan.git.excludePath;
  let previousExclude = null;
  let wroteExclude = false;
  let addedPrefixNewline = false;
  let createdRoot = false;
  try {
    if (plan.git.repository && !plan.git.ignored) {
      await assertSafeExcludePath(excludePath);
      previousExclude = await fsp.readFile(excludePath).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      const before = previousExclude || Buffer.alloc(0);
      const addition = (before.length && before[before.length - 1] !== 10 ? "\n" : "")
        + "# Review Bridge local state\n" + plan.git.pattern + "\n";
      addedPrefixNewline = addition.startsWith("\n");
      await fsp.mkdir(path.dirname(excludePath), { recursive: true });
      wroteExclude = true;
      await fsp.writeFile(excludePath, Buffer.concat([before, Buffer.from(addition, "utf8")]));
      if (!gitBoundary(plan.target).ignored) throw new Error("Local Git exclusion did not take effect.");
    }
    await fsp.mkdir(privateRoot);
    createdRoot = true;
    const runtimeTarget = path.join(privateRoot, "tools", "review-bridge");
    await fsp.mkdir(path.dirname(runtimeTarget), { recursive: true });
    await fsp.cp(path.join(packageRoot, "review-bridge"), runtimeTarget, { recursive: true });
    const profile = await resolveProfile(plan.target, plan.profile.id);
    await writeJson(path.join(privateRoot, "review-bridge", "bridge.json"), neutralBridgeConfig({
      profileId: plan.profile.id, roles: plan.roles, profile,
      watch: { port: plan.watch.port, strict_port: plan.watch.strict_port },
      retentionDays: plan.retention?.days ?? DEFAULT_RETENTION_DAYS,
    }));
    await writeJson(path.join(privateRoot, "review-bridge", "policy.override.json"), projectPolicyOverride(profile));
    await fsp.mkdir(path.join(privateRoot, "work-packages"), { recursive: true });
    await fsp.copyFile(path.join(packageRoot, "project-templates", "work-package.md"),
      path.join(privateRoot, "work-packages", "TEMPLATE.md"));
    await fsp.copyFile(path.join(packageRoot, "project-templates", "rules.md"),
      path.join(privateRoot, "review-bridge", "rules.md"));
    for (const name of ["pending", "running", "done", "failed", "work-packages", "authorizations",
      "authorization-claims", "authorization-invalidations", "runs", "events", "run-locks",
      "reconcile-guards", "upgrade-reports"]) {
      await fsp.mkdir(path.join(privateRoot, "review-queue", name), { recursive: true });
    }
    await fsp.mkdir(path.join(privateRoot, "review-bridge", "policy-snapshots"), { recursive: true });
    await fsp.mkdir(path.join(privateRoot, "reviews"), { recursive: true });
    const installedFiles = await fileSnapshot(privateRoot);
    await writeJson(path.join(privateRoot, "review-bridge-install.json"), {
      schema_version: 1,
      layout: "neutral",
      profile_id: plan.profile.id,
      roles: plan.roles,
      plan_sha256: claimed,
      runtime_sha256: plan.runtime_sha256,
      work_template_sha256: plan.work_template_sha256,
      rules_sha256: plan.rules_sha256,
      installed_files: installedFiles,
      git_exclusion: wroteExclude ? { path: excludePath, pattern: plan.git.pattern, added_prefix_newline: addedPrefixNewline } : null,
    });
    return { ok: true, target: plan.target, profile: plan.profile.id, roles: plan.roles, private_root: privateRoot };
  } catch (error) {
    if (createdRoot && path.resolve(privateRoot) === path.resolve(plan.target, privateName)) {
      await fsp.rm(privateRoot, { recursive: true, force: true });
    }
    if (wroteExclude) {
      if (previousExclude === null) await fsp.rm(excludePath, { force: true });
      else await fsp.writeFile(excludePath, previousExclude);
    }
    throw new Error("Neutral install rolled back: " + error.message);
  }
}

export async function rollbackFreshNeutralInstall(plan) {
  return withInstallLock(plan.target, () => rollbackFreshNeutralInstallLocked(plan));
}

async function rollbackFreshNeutralInstallLocked(plan) {
  const target = path.resolve(plan.target);
  const privateRoot = path.join(target, privateName);
  const manifestPath = path.join(privateRoot, "review-bridge-install.json");
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  if (manifest.layout !== "neutral" || manifest.plan_sha256 !== plan.plan_sha256) {
    throw new Error("Cannot roll back a different Bridge installation.");
  }
  if (JSON.stringify(await fileSnapshot(privateRoot).then((files) => files.filter(([name]) => name !== "review-bridge-install.json")))
    !== JSON.stringify(manifest.installed_files)) {
    throw new Error("Cannot roll back: installed Bridge state changed after setup.");
  }
  let exclusion = null;
  if (manifest.git_exclusion) {
    const suffix = Buffer.from((manifest.git_exclusion.added_prefix_newline ? "\n" : "")
      + "# Review Bridge local state\n" + manifest.git_exclusion.pattern + "\n", "utf8");
    const current = await fsp.readFile(manifest.git_exclusion.path);
    if (!current.subarray(current.length - suffix.length).equals(suffix)) {
      throw new Error("Cannot roll back: local Git exclusion changed after setup.");
    }
    exclusion = { path: manifest.git_exclusion.path, current, suffix };
  }
  // The target path is fixed by the install plan; the snapshot prevents deleting later user state.
  if (path.resolve(privateRoot) !== path.resolve(target, privateName)) throw new Error("Invalid rollback path.");
  await fsp.rm(privateRoot, { recursive: true, force: true });
  if (exclusion) {
    const remaining = exclusion.current.subarray(0, exclusion.current.length - exclusion.suffix.length);
    if (remaining.length === 0) await fsp.rm(exclusion.path, { force: true });
    else await fsp.writeFile(exclusion.path, remaining);
  }
  return { rolled_back: true, target };
}

export async function verifyNeutralInstall(target) {
  const root = path.resolve(target);
  const privateRoot = path.join(root, privateName);
  const privateStat = await fsp.lstat(privateRoot);
  if (!privateStat.isDirectory() || privateStat.isSymbolicLink()) {
    throw new Error("Neutral Bridge state root must be a normal directory.");
  }
  const manifest = JSON.parse(await fsp.readFile(path.join(privateRoot, "review-bridge-install.json"), "utf8"));
  if (manifest.schema_version !== 1 || manifest.layout !== "neutral") {
    throw new Error("Unsupported neutral install manifest.");
  }
  validateRoles(manifest.roles);
  const config = JSON.parse(await fsp.readFile(path.join(privateRoot, "review-bridge", "bridge.json"), "utf8"));
  if (config.requires_human_authorization !== true
    || config.roles?.writer?.provider_id !== manifest.roles.writer
    || config.roles?.reviewer?.provider_id !== manifest.roles.reviewer
    || config.roles?.reviewer_readonly_required !== true
    || config.readiness?.reviewer_readonly_proven !== "not_run") {
    throw new Error("Neutral install protected role or authorization settings changed.");
  }
  // The watch block is owner-editable; it only has to stay well formed.
  if (config.watch !== undefined) {
    if (!config.watch || typeof config.watch !== "object") throw new Error("Neutral install watch settings are invalid.");
    if (config.watch.port !== undefined && config.watch.port !== 0) validateWatchPort(config.watch.port);
    if (config.watch.strict_port !== undefined && typeof config.watch.strict_port !== "boolean") {
      throw new Error("Neutral install watch.strict_port must be true or false.");
    }
  }
  // The retention block is owner-editable too; only its shape is checked.
  if (config.retention !== undefined) {
    if (!config.retention || typeof config.retention !== "object") throw new Error("Neutral install retention settings are invalid.");
    if (config.retention.days !== undefined) validateRetentionDays(config.retention.days);
  }
  const runtimeSha = await runtimeFingerprint(path.join(privateRoot, "tools", "review-bridge"));
  if (runtimeSha !== manifest.runtime_sha256) throw new Error("Neutral runtime checksum mismatch.");
  // T0-10: TEMPLATE.md is owner-editable (an upgrade keeps an edited one); it only has to exist.
  // work_template_sha256 records the template this version shipped, to tell an edited one apart.
  const templateText = await fsp.readFile(path.join(privateRoot, "work-packages", "TEMPLATE.md"), "utf8").catch(() => null);
  if (!templateText?.trim()) throw new Error("Neutral work template is missing or empty (.review-bridge/work-packages/TEMPLATE.md).");
  // rules.md is owner-editable: it must exist and stay within one page; its content is not pinned.
  const rulesText = await fsp.readFile(path.join(privateRoot, "review-bridge", "rules.md"), "utf8").catch(() => null);
  if (rulesText === null) throw new Error("Neutral rules digest is missing (.review-bridge/review-bridge/rules.md).");
  if (!rulesText.trim() || rulesText.length > 4000) throw new Error("Neutral rules digest must be 1 to 4000 characters.");
  const boundary = gitBoundary(root);
  if (boundary.repository && !boundary.ignored) throw new Error("Neutral Bridge state is not private in Git.");
  return { valid: true, layout: "neutral", roles: manifest.roles, runtime_sha256: runtimeSha };
}

// ---------------------------------------------------------------------------------------------
// T0-09: neutral uninstall. Blocking (the maintenance marker inside the project, then the runtime
// moved aside) is kept apart from recovery (a journal and an index outside the project), so an
// interruption at any step can be recognised and finished or cancelled under a new approved plan.
// ---------------------------------------------------------------------------------------------

export const MAINTENANCE_MARKER = "review-queue/upgrade-in-progress.json";
export const RUNTIME_RELATIVE = "tools/review-bridge";
// B4: rebuilt by the page service or owned by the transaction; backed up, never compared bit for bit.
export const TRANSIENT_FILES = Object.freeze([
  "watch-session.json",
  "watch-url.txt",
  "logs/watch.stdout.log",
  "logs/watch.stderr.log",
  MAINTENANCE_MARKER,
]);
// Codex 2026-10-14: the run status lists come from the state machine, never a second copy.
const ACTIVE_RUN_STATUSES = new Set(RUN_ACTIVE);
const TERMINAL_RUN_STATUSES = new Set(RUN_TERMINAL);
const JOURNAL_SCHEMA = 1;

// B1: the persistent backup root for this platform; --backup-root overrides it.
export function defaultBackupRoot({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "CodexReviewBridge", "backups");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "CodexReviewBridge", "backups");
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "CodexReviewBridge", "backups");
}

async function realpathExisting(target) {
  let current = path.resolve(target);
  const rest = [];
  for (;;) {
    try {
      return path.join(await fsp.realpath(current), ...rest);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

function samePathText(left, right) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

// B2: the backup must live outside the project, after resolving links.
export async function resolveBackupRoot(target, override = null) {
  const root = await realpathExisting(override || defaultBackupRoot());
  const project = await fsp.realpath(path.resolve(target));
  if (samePathText(root, project) || under(process.platform === "win32" ? root.toLowerCase() : root, process.platform === "win32" ? project.toLowerCase() : project)) {
    throw new Error("The backup location must be outside the project: " + root);
  }
  return root;
}

async function writeDurable(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID().slice(0, 8) + ".tmp";
  const handle = await fsp.open(temp, "w");
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(temp, file);
}

async function writeJsonDurable(file, value) {
  await writeDurable(file, JSON.stringify(value, null, 2) + "\n");
}

async function readJsonOptional(file) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function withPlainLock(file, operation, { attempts = 200, delayMs = 50 } = {}) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let handle = null;
    try {
      handle = await fsp.open(file, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    await handle.close();
    try {
      return await operation();
    } finally {
      await fsp.rm(file, { force: true });
    }
  }
  throw new Error("Backup index is locked: " + file);
}

// M8 / M10: one index per backup root, keyed by the project's real path.
async function indexUpdate(root, update) {
  const file = path.join(root, "index.json");
  return await withPlainLock(file + ".lock", async () => {
    const index = (await readIndex(root)) || { schema_version: 1, open: {} };
    update(index.open);
    await writeJsonDurable(file, index);
    return index;
  });
}

function damagedRecordError(file, root, error) {
  return new Error("The backup record " + file + " cannot be read (" + (error?.message || error) + "). Do not delete it: it may be the last pointer to an unfinished uninstall. "
    + "Keep it, look under " + root + " for this project's journal.json and check it against its backup before repairing the record.");
}

// Only a missing file means "no index". Content that does not parse, or parses to anything but
// { open: { ... } } (JSON null included), is a damaged index (Codex 2026-10-14).
async function readIndex(root) {
  const file = path.join(root, "index.json");
  let text;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw damagedRecordError(file, root, error);
  }
  let index;
  try {
    index = JSON.parse(text);
  } catch (error) {
    throw damagedRecordError(file, root, error);
  }
  if (!index || typeof index !== "object" || Array.isArray(index) || !index.open || typeof index.open !== "object" || Array.isArray(index.open)) {
    throw damagedRecordError(file, root, "it is not an index (" + JSON.stringify(index)?.slice(0, 40) + ")");
  }
  return index;
}

async function indexLookup(root, project) {
  return (await readIndex(root))?.open?.[project] || null;
}

function projectKey(project) {
  return path.basename(project).replace(/[^A-Za-z0-9._-]/g, "_") + "-" + sha256(project).slice(0, 12);
}

async function runtimeModules(target) {
  const runtimeRoot = path.join(target, privateName, "tools", "review-bridge");
  if (!(await statOptional(path.join(runtimeRoot, "core", "service.mjs")))) return null;
  const { getBridgePaths } = await import(pathToFileURL(path.join(runtimeRoot, "core", "paths.mjs")).href);
  const service = await import(pathToFileURL(path.join(runtimeRoot, "core", "service.mjs")).href);
  return { runtimeRoot, service, paths: getBridgePaths(target, runtimeRoot, { privateRootName: privateName }) };
}

async function pageServiceRunning(target) {
  const runtime = await runtimeModules(target).catch(() => null);
  if (!runtime) return false;
  return (await runtime.service.checkService(runtime.paths)).running === true;
}

async function stopPageService(target) {
  const runtime = await runtimeModules(target);
  if (!runtime) return true;
  await runtime.service.serviceDown({ paths: runtime.paths, out: { write() {} } });
  return (await runtime.service.checkService(runtime.paths)).running !== true;
}

// Restarts the page service through the installed runtime, the same way init starts it.
async function startPageService(target) {
  const runtimeRoot = path.join(target, privateName, "tools", "review-bridge");
  if (!(await statOptional(path.join(runtimeRoot, "bootstrap.mjs")))) return false;
  spawnSync(process.execPath, [path.join(runtimeRoot, "bootstrap.mjs"), "up"], { cwd: target, windowsHide: true, timeout: 30_000, stdio: "ignore" });
  return await pageServiceRunning(target);
}

// Codex 2026-10-14: a missing run folder or a record that cannot be read is "cannot confirm", not "none".
async function activeRuns(privateRoot) {
  const directory = path.join(privateRoot, "review-queue", "runs");
  let entries;
  try {
    entries = await fsp.readdir(directory);
  } catch (error) {
    throw new Error("Cannot confirm that no work is running: the run folder " + directory + " cannot be listed (" + error.code + ").");
  }
  const active = [];
  for (const name of entries.filter((entry) => entry.endsWith(".json"))) {
    let run;
    try {
      run = JSON.parse(await fsp.readFile(path.join(directory, name), "utf8"));
    } catch (error) {
      throw new Error("Cannot confirm that no work is running: the run record " + name + " cannot be read (" + error.message + ").");
    }
    if (!run || typeof run.run_id !== "string" || typeof run.status !== "string") {
      throw new Error("Cannot confirm that no work is running: the run record " + name + " has no run id or status.");
    }
    if (ACTIVE_RUN_STATUSES.has(run.status)) active.push({ run_id: run.run_id, status: run.status });
    else if (!TERMINAL_RUN_STATUSES.has(run.status)) {
      throw new Error("Cannot confirm that no work is running: the run " + run.run_id + " (" + name + ") has a status this Bridge does not know: " + run.status + ".");
    }
  }
  return active;
}

function persistentOnly(files) {
  return files.filter(([name]) => !TRANSIENT_FILES.includes(name));
}

async function treeHash(root) {
  if (!(await statOptional(root))) return null;
  return sha256(JSON.stringify(await fileSnapshot(root)));
}

function excludeSuffix(exclusion) {
  return Buffer.from((exclusion.added_prefix_newline ? "\n" : "") + "# Review Bridge local state\n" + exclusion.pattern + "\n", "utf8");
}

async function excludeState(exclusion) {
  if (!exclusion) return null;
  const current = await fsp.readFile(exclusion.path).catch(() => null);
  const suffix = excludeSuffix(exclusion);
  return {
    path: exclusion.path,
    pattern: exclusion.pattern,
    added_prefix_newline: exclusion.added_prefix_newline,
    present: Boolean(current && current.length >= suffix.length && current.subarray(current.length - suffix.length).equals(suffix)),
    sha256: current ? sha256(current) : null,
  };
}

function gitStatusLines(target) {
  const text = git(target, ["status", "--porcelain", "--untracked-files=all"]);
  return text === null ? null : text.split(/\r?\n/).filter(Boolean);
}

function sealPlan(plan) {
  const content = { ...plan };
  delete content.plan_sha256;
  return { ...content, plan_sha256: sha256(JSON.stringify(content)) };
}

// U1.1: the fresh plan. Read-only; the persistent fingerprint leaves the transient files out.
async function planFreshUninstall(root, backupRootOverride) {
  const privateRoot = path.join(root, privateName);
  const manifestPath = path.join(privateRoot, "review-bridge-install.json");
  const manifestBytes = await fsp.readFile(manifestPath).catch(() => null);
  if (!manifestBytes) {
    throw new Error((await statOptional(privateRoot))
      ? "This is not a Review Bridge installation in the .review-bridge/ layout."
      : "No Review Bridge installation here. If an earlier uninstall used --backup-root, run uninstall again with that --backup-root.");
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.schema_version !== 1 || manifest.layout !== "neutral") throw new Error("This is not a Review Bridge installation in the .review-bridge/ layout.");
  const files = (await fileSnapshot(privateRoot)).filter(([name]) => name !== MAINTENANCE_MARKER);
  const persistent = persistentOnly(files);
  const installed = new Set((manifest.installed_files || []).map(([name, hash]) => name + "\0" + hash));
  installed.add("review-bridge-install.json\0" + sha256(manifestBytes));
  const userFiles = persistent.filter(([name, hash]) => !installed.has(name + "\0" + hash)).map(([name]) => name);
  const backupRoot = await resolveBackupRoot(root, backupRootOverride);
  return sealPlan({
    schema_version: 1,
    operation: "uninstall_neutral",
    kind: "fresh",
    target: root,
    install_manifest_sha256: sha256(manifestBytes),
    persistent_sha256: sha256(JSON.stringify(persistent)),
    file_count: files.length,
    persistent_count: persistent.length,
    user_file_count: userFiles.length,
    user_files: userFiles.slice(0, 20),
    git_exclusion: await excludeState(manifest.git_exclusion || null),
    backup_root: backupRoot,
    backup_root_custom: Boolean(backupRootOverride),
    service_running: await pageServiceRunning(root),
  });
}

// M10: the journal of an unfinished uninstall: the marker's record, then the default index, then
// the index of the --backup-root given now.
// M8 / M10: a transaction is findable through the marker or through any index entry that still
// names it. An index entry keeps it findable even after its journal says complete, so leftover
// entries are cleaned under a plan instead of being ignored. Unreadable records stop the plan.
async function locateJournal(root, marker, backupRootOverride) {
  const candidates = [];
  if (marker?.journal) candidates.push({ file: marker.journal, via: "marker" });
  const project = await fsp.realpath(root);
  for (const indexRoot of [defaultBackupRoot(), backupRootOverride].filter(Boolean)) {
    const resolved = await realpathExisting(indexRoot);
    const entry = await indexLookup(resolved, project);
    if (entry?.journal) candidates.push({ file: entry.journal, via: "index", root: resolved });
  }
  for (const candidate of candidates) {
    let journal;
    try {
      journal = await readJsonOptional(candidate.file);
    } catch (error) {
      throw damagedRecordError(candidate.file, path.dirname(path.dirname(path.dirname(candidate.file))), error);
    }
    if (journal === null) {
      if (candidate.via === "index") throw damagedRecordError(candidate.file, candidate.root, "the index names a journal that is missing");
      continue;
    }
    if (journal.schema_version !== JOURNAL_SCHEMA || !samePathText(journal.project, project)) {
      throw damagedRecordError(candidate.file, candidate.root || path.dirname(candidate.file), "it does not describe this project");
    }
    if (journal.state === "complete" && candidate.via !== "index") continue;
    return { file: candidate.file, journal };
  }
  return null;
}

// Every index that still names this transaction: the one it was written in, the default one, and
// the one given on this command line.
async function indexesNaming(journal, lookupRoot) {
  const roots = [];
  for (const root of [journal.backup_root, journal.default_index_root, defaultBackupRoot(), lookupRoot].filter(Boolean)) {
    const resolved = await realpathExisting(root);
    if (roots.some((known) => samePathText(known, resolved))) continue;
    const entry = await indexLookup(resolved, journal.project);
    if (entry && entry.transaction_id === journal.transaction_id) roots.push(resolved);
  }
  return roots;
}

async function readBackupManifest(journal) {
  const bytes = await fsp.readFile(path.join(journal.backup_dir, "backup-manifest.json"));
  if (sha256(bytes) !== journal.backup_manifest_sha256) throw new Error("The backup does not match the journal; it will not be used.");
  const manifest = JSON.parse(bytes.toString("utf8"));
  for (const [name, hash] of manifest.files) {
    const copy = await fsp.readFile(path.join(journal.backup_dir, "files", ...name.split("/"))).catch(() => null);
    if (!copy || sha256(copy) !== hash) throw new Error("The backup copy of " + name + " is missing or changed.");
  }
  return manifest;
}

// The original path a file under .review-bridge/ had, undoing M6 (a)'s rename of the runtime.
function originalName(name, transactionId) {
  const moved = "tools/.uninstalling-" + transactionId + "/";
  return name.startsWith(moved) ? RUNTIME_RELATIVE + "/" + name.slice(moved.length) : name;
}

// U1.5: the plan for an unfinished uninstall, built from the journal and the backup only.
async function planResumeUninstall(root, marker, located, lookupRoot = null) {
  const privateRoot = path.join(root, privateName);
  if (!located) {
    // The marker was written but the journal never was (U2.2 then a crash): nothing was stopped.
    return sealPlan({ schema_version: 1, operation: "uninstall_neutral", lookup_backup_root: lookupRoot, kind: "cancel", target: root, marker_transaction: marker?.upgrade_id || null, journal: null, restart_service: false, remove_marker: Boolean(marker) });
  }
  const { file, journal } = located;
  if (journal.state === "complete") {
    // Uninstalled and verified; only index entries that still name it are left (Codex 2026-10-14).
    return sealPlan({
      schema_version: 1, operation: "uninstall_neutral", lookup_backup_root: lookupRoot, kind: "cleanup", target: root, journal: file,
      transaction_id: journal.transaction_id, indexes: await indexesNaming(journal, lookupRoot),
    });
  }
  const deleting = ["deleting", "deleted"].includes(journal.state) || journal.deletion_started === true;
  if (!deleting) {
    return sealPlan({
      schema_version: 1, operation: "uninstall_neutral", lookup_backup_root: lookupRoot, kind: "cancel", target: root, journal: file, transaction_id: journal.transaction_id,
      journal_state: journal.state, restart_service: journal.service_was_running === true && !(await pageServiceRunning(root)), remove_marker: Boolean(marker),
    });
  }
  const backup = await readBackupManifest(journal);
  const known = new Map(backup.files);
  for (const entry of journal.newer_backed_up || []) known.set(entry[0], entry[1]);
  const remaining = (await statOptional(privateRoot)) ? await fileSnapshot(privateRoot) : [];
  const same = [];
  const newer = [];
  for (const [name, hash] of remaining) {
    if (name === MAINTENANCE_MARKER) continue;
    const original = originalName(name, journal.transaction_id);
    (known.get(original) === hash ? same : newer).push([name, hash]);
  }
  if (journal.state === "deleted" || !(await statOptional(privateRoot))) {
    return sealPlan({
      schema_version: 1, operation: "uninstall_neutral", lookup_backup_root: lookupRoot, kind: "finish", target: root, journal: file, transaction_id: journal.transaction_id,
      git_exclusion: await excludeState(journal.git_exclusion), backup_manifest_sha256: journal.backup_manifest_sha256,
    });
  }
  return sealPlan({
    schema_version: 1, operation: "uninstall_neutral", lookup_backup_root: lookupRoot, kind: "continue", target: root, journal: file, transaction_id: journal.transaction_id,
    backup_manifest_sha256: journal.backup_manifest_sha256, remaining_same: same, remaining_newer: newer,
    git_exclusion: await excludeState(journal.git_exclusion),
  });
}

export async function planNeutralUninstall({ target, backupRoot = null }) {
  const root = path.resolve(target);
  const stat = await statOptional(root);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error("Target must be an existing, non-symlink workspace directory.");
  const marker = await readJsonOptional(path.join(root, privateName, MAINTENANCE_MARKER));
  if (marker && marker.operation !== "uninstall") {
    throw new Error("An interrupted Bridge " + (marker.operation || "upgrade") + " is present; run upgrade --rollback first.");
  }
  const located = await locateJournal(root, marker, backupRoot);
  if (marker || located) return await planResumeUninstall(root, marker, located, backupRoot);
  return await planFreshUninstall(root, backupRoot);
}

async function journalWrite(context, changes) {
  Object.assign(context.journal, changes, { updated_at: new Date().toISOString() });
  await writeJsonDurable(context.journalFile, context.journal);
}

// The default index is cleared last: until then a rerun without --backup-root still finds the
// transaction. Failures surface; they are never swallowed (Codex 2026-10-14).
async function removeFromIndexes(context) {
  const journal = context.journal;
  const ordered = journal.default_index_root ? [journal.backup_root, journal.default_index_root] : [journal.backup_root];
  for (const root of ordered.filter(Boolean)) {
    if (context.beforeIndexRemoval) await context.beforeIndexRemoval(root);
    await indexUpdate(root, (open) => {
      if (open[journal.project]?.transaction_id === journal.transaction_id) delete open[journal.project];
    });
  }
}

// M11: the fixed close for any exit before deletion begins. The marker goes last, so a crash in
// the middle still leaves something the next run recognises as "cancel this transaction".
async function cancelTransaction(context, reason) {
  if (context.journal) {
    await journalWrite(context, { state: "cancelled", cancel_reason: reason });
    try {
      await removeFromIndexes(context);
    } catch (error) {
      // The marker stays, so the next uninstall still recognises this transaction and retries.
      const incomplete = new Error("The cancel did not finish: the backup index could not be cleared (" + error.message + "). Nothing was deleted; run uninstall again to finish the cancel.");
      incomplete.cancelIncomplete = true;
      throw incomplete;
    }
  }
  let restarted = null;
  // Any stop that was attempted on a service that was running is checked, not assumed: it is
  // restarted unless it is verifiably running now, and an unconfirmed restart keeps the marker.
  if (context.journal?.service_was_running && (context.serviceStopped || context.serviceStopAttempted) && !(await pageServiceRunning(context.root))) {
    restarted = await (context.restartService || startPageService)(context.root);
    if (!restarted) {
      // Codex 2026-10-14: the page service the human had running is not back; the cancel is not
      // done. The marker stays so the next uninstall offers the cancel again and retries.
      const incomplete = new Error("The cancel did not finish: the Bridge page service that was running did not restart. Nothing was deleted; run uninstall again to finish the cancel.");
      incomplete.cancelIncomplete = true;
      throw incomplete;
    }
  }
  await fsp.rm(path.join(context.root, privateName, MAINTENANCE_MARKER), { force: true });
  return restarted;
}

function stoppedForNewer(message) {
  const error = new Error(message);
  error.stoppedAt = "delete";
  return error;
}

// Codex 2026-10-15: the file is first moved aside (one atomic rename), and the moved file is what
// is hashed and deleted. Content written through the path after the check lands in a new file at
// the old path, which is not deleted here; deleteInstall stops on it before the marker goes.
async function deleteChecked(privateRoot, name, expected, context) {
  const file = path.join(privateRoot, ...name.split("/"));
  const aside = asideName(file, "uninstall");
  try {
    await fsp.rename(file, aside);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw stoppedForNewer("Stopped before deleting " + name + ": it could not be moved aside (" + error.code + "); it may be open in another program. Nothing more was deleted; run uninstall again.");
  }
  const actual = sha256(await fsp.readFile(aside));
  if (actual !== expected) {
    const where = await putBack(aside, file);
    const newer = [...(context.journal.newer || []), [name, actual]];
    await journalWrite(context, { newer });
    throw stoppedForNewer("Stopped before deleting " + name + ": it differs from the backup (it is newer)"
      + (where === file ? "" : "; it is kept as " + path.basename(where) + " because a new " + path.basename(file) + " appeared meanwhile")
      + ". Run uninstall again; the plan backs it up first.");
  }
  if (context.afterDeleteCheck) await context.afterDeleteCheck(name, file);
  await fsp.rm(aside);
}

async function removeEmptyDirectories(directory) {
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await removeEmptyDirectories(path.join(directory, entry.name));
  }
  if ((await fsp.readdir(directory)).length === 0) await fsp.rmdir(directory);
}

// M6 (a)-(e): runtime moved aside first, the marker deleted last, every file checked against the backup.
async function deleteInstall(context, known) {
  const privateRoot = path.join(context.root, privateName);
  const movedRelative = "tools/.uninstalling-" + context.journal.transaction_id;
  const moved = path.join(privateRoot, ...movedRelative.split("/"));
  if (await statOptional(path.join(privateRoot, ...RUNTIME_RELATIVE.split("/")))) {
    await fsp.rename(path.join(privateRoot, ...RUNTIME_RELATIVE.split("/")), moved);
  }
  await journalWrite(context, { step: "a_runtime_moved" });
  const files = (await statOptional(privateRoot)) ? await fileSnapshot(privateRoot) : [];
  for (const [name] of files) {
    if (name === MAINTENANCE_MARKER || name.startsWith(movedRelative + "/")) continue;
    if (context.beforeDelete) await context.beforeDelete(name);
    await deleteChecked(privateRoot, name, known.get(name), context);
  }
  await journalWrite(context, { step: "b_contents_deleted" });
  for (const [name] of files.filter(([entry]) => entry.startsWith(movedRelative + "/"))) {
    await deleteChecked(privateRoot, name, known.get(originalName(name, context.journal.transaction_id)), context);
  }
  await journalWrite(context, { step: "c_runtime_deleted" });
  // Anything still here changed after its check or appeared during deletion, so it is not in the
  // backup: the marker and the journal stay, and the continue plan backs it up before deleting it.
  const appeared = (await fileSnapshot(privateRoot)).filter(([name]) => name !== MAINTENANCE_MARKER);
  if (appeared.length) {
    await journalWrite(context, { newer: [...(context.journal.newer || []), ...appeared] });
    throw stoppedForNewer("Stopped before finishing: " + appeared.slice(0, 10).map(([name]) => name).join(", ")
      + (appeared.length > 10 ? " and " + (appeared.length - 10) + " more" : "")
      + " changed or appeared during deletion and are not in the backup. Nothing that is not in the backup was deleted. Run uninstall again; the plan backs them up first.");
  }
  await fsp.rm(path.join(privateRoot, ...MAINTENANCE_MARKER.split("/")), { force: true });
  await journalWrite(context, { step: "d_marker_deleted" });
  if (await statOptional(privateRoot)) await removeEmptyDirectories(privateRoot);
  if (await statOptional(privateRoot)) throw new Error(".review-bridge/ still has entries after deletion.");
  await journalWrite(context, { state: "deleted", step: "e_root_deleted" });
}

// M6 (f): only the exact block the install appended, and only while it is still at the end.
async function restoreExclusion(exclusion) {
  if (!exclusion) return { restored: false, reason: "not_added" };
  const current = await fsp.readFile(exclusion.path).catch(() => null);
  const suffix = excludeSuffix(exclusion);
  if (!current || current.length < suffix.length || !current.subarray(current.length - suffix.length).equals(suffix)) {
    return { restored: false, reason: "changed_since_install" };
  }
  const remaining = current.subarray(0, current.length - suffix.length);
  if (remaining.length === 0) await fsp.rm(exclusion.path, { force: true });
  else await fsp.writeFile(exclusion.path, remaining);
  return { restored: true };
}

// M6 (g): the project is back to its state before install, as far as the uninstall is concerned.
async function verifyUninstalled(context) {
  const problems = [];
  if (await statOptional(path.join(context.root, privateName))) problems.push(".review-bridge/ still exists");
  const status = gitStatusLines(context.root);
  if (status && status.some((line) => line.includes(privateName + "/"))) problems.push("git status still lists .review-bridge/");
  for (const name of [".claude", ".codex"]) {
    if ((await treeHash(path.join(context.root, name))) !== (context.journal.agent_trees?.[name] ?? null)) problems.push(name + "/ changed during uninstall");
  }
  if (problems.length) throw new Error("Uninstall verification failed: " + problems.join("; "));
}

// The journal says complete first and the index entries go after it (default index last), so a
// crash at any point leaves an entry through which the next run finds what is left to clean.
async function finishTransaction(context, exclusionResult) {
  await verifyUninstalled(context);
  await journalWrite(context, { state: "complete", step: "g_verified", exclusion: exclusionResult });
  try {
    await removeFromIndexes(context);
  } catch (error) {
    throw new Error("Uninstall removed and verified .review-bridge/, but the backup index could not be cleared (" + error.message + "). Run uninstall again to finish.");
  }
}

// B3-B5: every file under .review-bridge/ copied out, listed with its hash, and read back.
async function backupTree(privateRoot, backupDir, header, afterBackup) {
  const files = await fileSnapshot(privateRoot);
  for (const [name] of files) {
    const target = path.join(backupDir, "files", ...name.split("/"));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(path.join(privateRoot, ...name.split("/")), target);
  }
  const manifest = { schema_version: 1, ...header, created_at: new Date().toISOString(), files };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await writeDurable(path.join(backupDir, "backup-manifest.json"), bytes);
  if (afterBackup) await afterBackup(backupDir);
  await readBackupManifest({ backup_dir: backupDir, backup_manifest_sha256: sha256(bytes) });
  return { manifest, sha: sha256(bytes) };
}

async function backupInstall(context) {
  return await backupTree(path.join(context.root, privateName), context.journal.backup_dir, {
    project: context.journal.project, operation: "uninstall", transaction_id: context.journal.transaction_id,
    install_manifest_sha256: context.plan.install_manifest_sha256,
  }, context.afterBackup);
}

async function applyFreshUninstall(plan, hooks) {
  const root = plan.target;
  const privateRoot = path.join(root, privateName);
  const markerPath = path.join(privateRoot, MAINTENANCE_MARKER);
  const transactionId = randomUUID();
  const context = { root, plan, journal: null, journalFile: null, serviceStopped: false, ...hooks };
  // U2.2: the marker first. From here every Bridge start in this project fails closed.
  const marker = { schema_version: 4, upgrade_id: transactionId, operation: "uninstall", started_at: new Date().toISOString() };
  await fsp.mkdir(path.dirname(markerPath), { recursive: true });
  try {
    const handle = await fsp.open(markerPath, "wx");
    try { await handle.writeFile(JSON.stringify(marker, null, 2) + "\n"); await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("Another Bridge maintenance is in progress here.");
    throw error;
  }
  // U2.2b: the journal and the index exist on disk before anything is stopped.
  try {
    const project = await fsp.realpath(root);
    const backupDir = path.join(plan.backup_root, projectKey(project), new Date().toISOString().replace(/[:.]/g, "-") + "-uninstall-" + transactionId.slice(0, 8));
    context.journalFile = path.join(backupDir, "journal.json");
    const defaultRoot = await realpathExisting(defaultBackupRoot());
    context.journal = {
      schema_version: JOURNAL_SCHEMA, transaction_id: transactionId, operation: "uninstall", state: "started", project, target: root,
      backup_root: plan.backup_root, default_index_root: samePathText(defaultRoot, plan.backup_root) ? null : defaultRoot,
      backup_dir: backupDir, service_was_running: plan.service_running, git_exclusion: plan.git_exclusion,
      agent_trees: { ".claude": await treeHash(path.join(root, ".claude")), ".codex": await treeHash(path.join(root, ".codex")) },
      created_at: new Date().toISOString(),
    };
    if (hooks.failJournal) throw new Error("injected journal failure");
    await writeJsonDurable(context.journalFile, context.journal);
    await indexUpdate(plan.backup_root, (open) => { open[project] = { journal: context.journalFile, transaction_id: transactionId }; });
    if (context.journal.default_index_root) {
      await indexUpdate(context.journal.default_index_root, (open) => { open[project] = { journal: context.journalFile, transaction_id: transactionId, backup_root: plan.backup_root }; });
    }
    await writeJsonDurable(markerPath, { ...marker, journal: context.journalFile });
  } catch (error) {
    let note = "";
    try { await cancelTransaction(context, "journal_write_failed"); } catch (cancelError) { note = " " + cancelError.message; }
    throw new Error("Could not record the uninstall outside the project; nothing was stopped or deleted: " + error.message + note);
  }
  const refuse = async (reason, message) => {
    try {
      await cancelTransaction(context, reason);
    } catch (cancelError) {
      throw new Error(message + " " + cancelError.message);
    }
    const error = new Error(message);
    error.cancelled = reason;
    throw error;
  };
  // Codex 2026-10-14: from here until deletion starts, an unexpected error also closes under M11.
  let backup;
  try {
    if (hooks.afterJournal) await hooks.afterJournal(context);
    // U2.3: the plan the human approved must still describe the project.
    const fresh = await planFreshUninstall(root, plan.backup_root_custom ? plan.backup_root : null);
    if (fresh.plan_sha256 !== plan.plan_sha256) await refuse("plan_changed", "The project changed after the plan was shown; make a new plan.");
    // U2.4: runs are checked only now that the marker blocks new ones; unreadable records refuse.
    let runs;
    try {
      runs = await activeRuns(privateRoot);
    } catch (error) {
      await refuse("run_check_failed", error.message);
    }
    if (runs.length) await refuse("active_run", "Work is still running: " + runs.map((run) => run.run_id + " (" + run.status + ")").join(", ") + ". Stop it or let it finish first.");
    // U2.5
    if (plan.service_running) {
      // Codex 2026-10-14: recorded before the attempt, so a stop that throws after it already took
      // effect is still recovered by the cancel.
      context.serviceStopAttempted = true;
      await journalWrite(context, { service_stop_attempted: true });
      if (!(await (context.stopService || stopPageService)(root))) await refuse("service_stop_failed", "The Bridge page service did not stop.");
      context.serviceStopped = true;
      await journalWrite(context, { service_stopped: true });
    }
    if (hooks.afterServiceStop) await hooks.afterServiceStop(context);
    // U2.6
    try {
      backup = await backupInstall(context);
    } catch (error) {
      await refuse("backup_failed", "The backup could not be verified; nothing was deleted: " + error.message);
    }
    await journalWrite(context, { state: "backed_up", backup_manifest_sha256: backup.sha });
    await writeJsonDurable(markerPath, { ...marker, journal: context.journalFile, backup_dir: context.journal.backup_dir, backup_manifest_sha256: backup.sha });
    if (hooks.afterBackupVerified) await hooks.afterBackupVerified(context);
    // U2.7 / B6: the originals must still be what was approved and what was backed up.
    const now = persistentOnly(await fileSnapshot(privateRoot));
    const changed = now.find(([name, hash]) => new Map(backup.manifest.files).get(name) !== hash);
    if (sha256(JSON.stringify(now)) !== plan.persistent_sha256 || changed) {
      await refuse("original_changed", "A file changed after the backup: " + (changed ? changed[0] : "(set of files)") + ". Nothing was deleted; make a new plan.");
    }
  } catch (error) {
    if (error.cancelled || /The cancel did not finish/.test(error.message)) throw error;
    let note = "";
    try { await cancelTransaction(context, "unexpected_error"); } catch (cancelError) { note = " " + cancelError.message; }
    throw new Error("The uninstall stopped before deleting anything and was cancelled: " + error.message + note);
  }
  const known = new Map(backup.manifest.files);
  // U2.8: deletion. From here on the journal, not the marker, carries recovery.
  await journalWrite(context, { state: "deleting", deletion_started: true });
  await deleteInstall(context, known);
  if (hooks.afterDelete) await hooks.afterDelete(context);
  const exclusion = await restoreExclusion(plan.git_exclusion);
  await journalWrite(context, { step: "f_exclusion", exclusion });
  if (hooks.beforeVerify) await hooks.beforeVerify(context);
  await finishTransaction(context, exclusion);
  return {
    ok: true, operation: "uninstall", target: root, backup_dir: context.journal.backup_dir,
    file_count: backup.manifest.files.length, user_file_count: plan.user_file_count, exclusion,
  };
}

async function applyResumeUninstall(plan, hooks) {
  const root = plan.target;
  const privateRoot = path.join(root, privateName);
  if (plan.kind === "cleanup") {
    const context = { root, journal: await readJsonOptional(plan.journal), journalFile: plan.journal, ...hooks };
    for (const indexRoot of plan.indexes) {
      if (context.beforeIndexRemoval) await context.beforeIndexRemoval(indexRoot);
      await indexUpdate(indexRoot, (open) => {
        if (open[context.journal.project]?.transaction_id === context.journal.transaction_id) delete open[context.journal.project];
      });
    }
    return { ok: true, operation: "uninstall", kind: "cleanup", target: root, backup_dir: context.journal.backup_dir, indexes_cleared: plan.indexes.length };
  }
  if (plan.kind === "cancel") {
    const context = { root, journal: null, journalFile: plan.journal, serviceStopped: plan.restart_service, ...hooks };
    if (plan.journal) context.journal = await readJsonOptional(plan.journal);
    if (context.journal) context.journal.service_was_running = plan.restart_service;
    const restarted = await cancelTransaction(context, context.journal?.cancel_reason || "resumed_cancel");
    return { ok: true, operation: "uninstall", kind: "cancel", service_restarted: restarted };
  }
  const journal = await readJsonOptional(plan.journal);
  const context = { root, journal, journalFile: plan.journal, ...hooks };
  const backup = await readBackupManifest(journal);
  const known = new Map(backup.files);
  for (const entry of journal.newer_backed_up || []) known.set(entry[0], entry[1]);
  if (plan.kind === "continue") {
    // Newer originals are backed up beside the first backup and verified before anything is deleted.
    const added = [...(journal.newer_backed_up || [])];
    for (const [name, hash] of plan.remaining_newer) {
      const original = originalName(name, journal.transaction_id);
      const copy = path.join(journal.backup_dir, "newer", ...original.split("/"));
      await fsp.mkdir(path.dirname(copy), { recursive: true });
      await fsp.copyFile(path.join(privateRoot, ...name.split("/")), copy);
      if (sha256(await fsp.readFile(copy)) !== hash) throw new Error("The newer copy of " + original + " could not be verified; nothing more was deleted.");
      added.push([original, hash]);
      known.set(original, hash);
    }
    await journalWrite(context, { newer_backed_up: added, state: "deleting", deletion_started: true });
    await deleteInstall(context, known);
  }
  const exclusion = await restoreExclusion(journal.git_exclusion);
  await journalWrite(context, { step: "f_exclusion", exclusion });
  await finishTransaction(context, exclusion);
  return { ok: true, operation: "uninstall", kind: plan.kind, target: root, backup_dir: journal.backup_dir, exclusion };
}

// U1.4 / U2.1: approval binds the exact plan; it is rebuilt under the install lock before acting.
export async function applyNeutralUninstall(plan, approval, hooks = {}) {
  if (plan?.operation !== "uninstall_neutral") throw new Error("Not an uninstall plan.");
  const sealed = sealPlan(plan);
  if (sealed.plan_sha256 !== plan.plan_sha256 || approval !== plan.plan_sha256) throw new Error("Uninstall plan approval is invalid.");
  return await withInstallLock(plan.target, async () => {
    if (hooks.afterLock) await hooks.afterLock();
    if (plan.kind === "fresh") {
      const marker = await readJsonOptional(path.join(plan.target, privateName, MAINTENANCE_MARKER));
      if (marker) throw new Error("Another Bridge maintenance is in progress here.");
      return await applyFreshUninstall(plan, hooks);
    }
    const marker = await readJsonOptional(path.join(plan.target, privateName, MAINTENANCE_MARKER));
    const current = await planResumeUninstall(plan.target, marker, await locateJournal(plan.target, marker, plan.lookup_backup_root), plan.lookup_backup_root);
    if (current.plan_sha256 !== plan.plan_sha256) throw new Error("The project changed after the plan was shown; make a new plan.");
    return await applyResumeUninstall(plan, hooks);
  });
}

// ---------------------------------------------------------------------------------------------
// T0-10: neutral upgrade. The maintenance marker inside the project is the whole record: it holds
// the backup location and, before each write, the version the upgrade is about to write, so an
// interrupted upgrade is undone from the marker, the backup and tools/ alone (P2.12).
// ---------------------------------------------------------------------------------------------

const OWNER_EDITABLE_KEYS = Object.freeze(["watch", "retention", "locale", "gate_a"]);
const PROTECTED_KEYS = Object.freeze(["roles", "requires_human_authorization", "readiness"]);
const CONFIG_RELATIVE = "review-bridge/bridge.json";
const TEMPLATE_RELATIVE = "work-packages/TEMPLATE.md";
const TEMPLATE_NEW_RELATIVE = "work-packages/TEMPLATE.new.md";
const MANIFEST_RELATIVE = "review-bridge-install.json";
const RUNTIME_SIDES = Object.freeze(["previous", "next", "failed", "restore"]);

function runtimeSide(kind, id) {
  return "tools/.review-bridge-" + kind + "-" + id;
}

function inPrivate(privateRoot, relative) {
  return path.join(privateRoot, ...relative.split("/"));
}

function sameValue(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

async function runtimeVersion(runtimeRoot) {
  const manifest = await readJsonOptional(path.join(runtimeRoot, "templates", "PACKAGE_MANIFEST.json")).catch(() => null);
  return typeof manifest?.version === "string" ? manifest.version : null;
}

async function hashOptional(file) {
  try { return sha256(await fsp.readFile(file)); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

// P2.9: owner-editable keys keep their values; protected keys must stay as they are; keys Bridge
// owns take the new version's value; keys the new version adds get its default.
function mergeBridgeConfig(current, defaults) {
  for (const key of PROTECTED_KEYS) {
    if (!sameValue(current[key], defaults[key])) {
      throw new Error("The new version would change the protected bridge.json setting \"" + key + "\"; the upgrade keeps protected settings as they are and stops.");
    }
  }
  const kept = (key) => OWNER_EDITABLE_KEYS.includes(key) || PROTECTED_KEYS.includes(key);
  const merged = {};
  for (const key of Object.keys(defaults)) merged[key] = kept(key) && Object.hasOwn(current, key) ? current[key] : defaults[key];
  for (const key of Object.keys(current)) if (!Object.hasOwn(merged, key)) merged[key] = current[key];
  return {
    merged,
    added: Object.keys(defaults).filter((key) => !Object.hasOwn(current, key)),
    updated: Object.keys(defaults).filter((key) => Object.hasOwn(current, key) && !kept(key) && !sameValue(current[key], defaults[key])),
  };
}

async function defaultConfigFor(root, current, manifest) {
  return neutralBridgeConfig({ profileId: current.profile_id, roles: manifest.roles, profile: await resolveProfile(root, current.profile_id) });
}

// Where the new template goes when TEMPLATE.md was edited. TEMPLATE.new.md is reused only while it
// is absent, already the new template, or still exactly what an earlier upgrade wrote; one a human
// edited is never overwritten (Codex 2026-10-15). The fallback name carries a safe version string.
async function templateDestination(privateRoot, manifest, templateNew, to) {
  const installed = new Map(manifest.installed_files || []);
  const free = async (relative) => {
    const now = await hashOptional(inPrivate(privateRoot, relative));
    return now === null || now === templateNew || now === installed.get(relative);
  };
  if (await free(TEMPLATE_NEW_RELATIVE)) return TEMPLATE_NEW_RELATIVE;
  const version = String(to.version || to.runtime_sha256.slice(0, 12)).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 60) || "next";
  const fallback = "work-packages/TEMPLATE.new." + version + ".md";
  if (await free(fallback)) return fallback;
  throw new Error("You edited both " + TEMPLATE_NEW_RELATIVE + " and " + fallback + "; the upgrade will not overwrite either. Move one of them out of .review-bridge/work-packages/ and make a new plan.");
}

// P1.1: the read-only upgrade plan; P1.2: the refusals that need no lock.
async function planFreshUpgrade(root, backupRootOverride) {
  const privateRoot = path.join(root, privateName);
  const manifestBytes = await fsp.readFile(inPrivate(privateRoot, MANIFEST_RELATIVE)).catch(() => null);
  if (!manifestBytes) {
    throw new Error((await statOptional(privateRoot))
      ? "This is not a Review Bridge installation in the .review-bridge/ layout."
      : "No Review Bridge installation here; install it with init first.");
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.schema_version !== 1 || manifest.layout !== "neutral") throw new Error("This is not a Review Bridge installation in the .review-bridge/ layout.");
  try {
    await verifyNeutralInstall(root);
  } catch (error) {
    throw new Error("The installed Bridge does not verify, so it will not be upgraded: " + error.message);
  }
  const runtimeRoot = inPrivate(privateRoot, RUNTIME_RELATIVE);
  const sourceRuntime = path.join(packageRoot, "review-bridge");
  const from = { version: await runtimeVersion(runtimeRoot), runtime_sha256: manifest.runtime_sha256 };
  const to = { version: await runtimeVersion(sourceRuntime), runtime_sha256: await runtimeFingerprint(sourceRuntime) };
  if (from.runtime_sha256 === to.runtime_sha256) return { up_to_date: true, target: root, version: to.version, runtime_sha256: to.runtime_sha256 };
  const config = JSON.parse(await fsp.readFile(inPrivate(privateRoot, CONFIG_RELATIVE), "utf8"));
  const defaults = await defaultConfigFor(root, config, manifest);
  if (config.schema_version !== defaults.schema_version || config.state_contract !== defaults.state_contract) {
    throw new Error("The new version uses another bridge.json schema (" + config.schema_version + "/" + config.state_contract + " to "
      + defaults.schema_version + "/" + defaults.state_contract + "); converting data across major versions is not supported.");
  }
  const merge = mergeBridgeConfig(config, defaults);
  const templateNow = sha256(await fsp.readFile(inPrivate(privateRoot, TEMPLATE_RELATIVE)));
  const templateNew = sha256(await fsp.readFile(path.join(packageRoot, "project-templates", "work-package.md")));
  const templateModified = templateNow !== manifest.work_template_sha256;
  const templateAction = templateNow === templateNew ? "unchanged" : templateModified ? "keep_and_write_new" : "replace";
  const templateNewPath = templateAction === "keep_and_write_new"
    ? await templateDestination(privateRoot, manifest, templateNew, to) : null;
  const policy = {
    from: policyIdentity(JSON.parse(await fsp.readFile(path.join(runtimeRoot, "config", "default-policy.json"), "utf8"))),
    to: policyIdentity(JSON.parse(await fsp.readFile(path.join(sourceRuntime, "config", "default-policy.json"), "utf8"))),
  };
  const persistent = persistentOnly((await fileSnapshot(privateRoot)).filter(([name]) => name !== MAINTENANCE_MARKER));
  const installed = new Set((manifest.installed_files || []).map(([name, hash]) => name + "\0" + hash));
  installed.add(MANIFEST_RELATIVE + "\0" + sha256(manifestBytes));
  const userFiles = persistent.filter(([name, hash]) => !installed.has(name + "\0" + hash)).map(([name]) => name);
  const backupRoot = await resolveBackupRoot(root, backupRootOverride);
  return sealPlan({
    schema_version: 1,
    operation: "upgrade_neutral",
    kind: "upgrade",
    target: root,
    install_manifest_sha256: sha256(manifestBytes),
    from,
    to,
    runtime_file_count: {
      from: persistent.filter(([name]) => name.startsWith(RUNTIME_RELATIVE + "/")).length,
      to: (await fileSnapshot(sourceRuntime)).length,
    },
    persistent_sha256: sha256(JSON.stringify(persistent)),
    persistent_count: persistent.length,
    user_file_count: userFiles.length,
    user_files: userFiles.slice(0, 20),
    config_added_keys: merge.added,
    config_updated_keys: merge.updated,
    template: {
      modified: templateModified,
      action: templateAction,
      new_sha256: templateNew,
      new_path: templateNewPath,
    },
    policy_changed: !sameValue(policy.from, policy.to),
    policy,
    backup_root: backupRoot,
    backup_root_custom: Boolean(backupRootOverride),
    backup_parent: path.join(backupRoot, projectKey(await fsp.realpath(root))),
    service_running: await pageServiceRunning(root),
  });
}

function markerRefusal(marker) {
  return marker.operation === "uninstall"
    ? "An interrupted Bridge uninstall is present; run uninstall again to finish or cancel it."
    : "An interrupted Bridge upgrade is present; run upgrade --rollback first.";
}

export async function planNeutralUpgrade({ target, backupRoot = null }) {
  const root = path.resolve(target);
  const stat = await statOptional(root);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error("Target must be an existing, non-symlink workspace directory.");
  const markerPath = path.join(root, privateName, MAINTENANCE_MARKER);
  if (await statOptional(markerPath)) throw new Error(markerRefusal((await readJsonOptional(markerPath).catch(() => null)) || {}));
  return await planFreshUpgrade(root, backupRoot);
}

async function markerSave(context) {
  await writeJsonDurable(context.markerPath, context.marker);
}

// The marker learns each version before it is written, so a rollback can tell the upgrade's own
// writes from a human's later edits (P2.11).
async function writeRecorded(context, relative, bytes) {
  context.marker.written[relative] = sha256(bytes);
  await markerSave(context);
  await writeDurable(inPrivate(context.privateRoot, relative), bytes);
}

function refusal(message) {
  const error = new Error(message);
  error.refusal = true;
  return error;
}

// A service the upgrade stopped is started again; one that does not come back keeps the marker,
// and upgrade --rollback offers the restart again (the T0-09 cancel rule).
async function restartStoppedService(context) {
  if (!context.serviceStopAttempted || !context.marker.service_was_running || await pageServiceRunning(context.root)) return false;
  if (!(await (context.hooks.restartService || startPageService)(context.root))) {
    throw new Error("The Bridge page service that was running did not restart, so Bridge stays blocked for new work. Run: node bridge.mjs upgrade --rollback");
  }
  return true;
}

// P2.3-P2.6 failures: nothing was changed yet.
async function releaseBeforeChange(context, error) {
  const message = error.refusal ? error.message : "The upgrade stopped before changing anything: " + error.message;
  try {
    await restartStoppedService(context);
  } catch (restartError) {
    throw new Error(message + " " + restartError.message);
  }
  await fsp.rm(context.markerPath, { force: true });
  throw new Error(message);
}

async function mergeSettings(context, plan) {
  const { privateRoot } = context;
  const manifest = JSON.parse(await fsp.readFile(inPrivate(privateRoot, MANIFEST_RELATIVE), "utf8"));
  const configText = await fsp.readFile(inPrivate(privateRoot, CONFIG_RELATIVE), "utf8");
  const current = JSON.parse(configText);
  const merge = mergeBridgeConfig(current, await defaultConfigFor(context.root, current, manifest));
  context.before = {
    [CONFIG_RELATIVE]: sha256(configText),
    [TEMPLATE_RELATIVE]: await hashOptional(inPrivate(privateRoot, TEMPLATE_RELATIVE)),
  };
  const text = JSON.stringify(merge.merged, null, 2) + "\n";
  if (text !== configText) await writeRecorded(context, CONFIG_RELATIVE, Buffer.from(text, "utf8"));
  const template = await fsp.readFile(path.join(packageRoot, "project-templates", "work-package.md"));
  if (plan.template.action === "replace") await writeRecorded(context, TEMPLATE_RELATIVE, template);
  if (plan.template.action === "keep_and_write_new") await writeRecorded(context, plan.template.new_path, template);
  return { added: merge.added, template: plan.template.action, template_new_path: plan.template.new_path };
}

// D5: unclaimed authorizations bound to the old default policy are invalidated and reported.
async function writeInvalidations(context) {
  const paths = getBridgePaths(context.root, inPrivate(context.privateRoot, RUNTIME_RELATIVE), { privateRootName: privateName });
  const current = policyIdentity(JSON.parse(await fsp.readFile(paths.defaultPolicyPath, "utf8")));
  const { records, report } = await planUpgradeInvalidations(paths, current);
  const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");
  for (const { authorization_id: id, record } of records) {
    const relative = "review-queue/authorization-invalidations/" + id + ".json";
    if (!(await statOptional(inPrivate(context.privateRoot, relative)))) await writeRecorded(context, relative, json(record));
  }
  await writeRecorded(context, "review-queue/upgrade-reports/" + report.report_id + ".json", json(report));
  return report;
}

async function writeUpgradeManifest(context, plan, report) {
  const manifest = JSON.parse(await fsp.readFile(inPrivate(context.privateRoot, MANIFEST_RELATIVE), "utf8"));
  const installed = new Map((manifest.installed_files || []).filter(([name]) => !name.startsWith(RUNTIME_RELATIVE + "/")));
  for (const [name, hash] of await fileSnapshot(inPrivate(context.privateRoot, RUNTIME_RELATIVE))) installed.set(RUNTIME_RELATIVE + "/" + name, hash);
  // A file Bridge wrote over its own unedited copy stays Bridge's; an edited one stays the human's.
  for (const relative of [CONFIG_RELATIVE, TEMPLATE_RELATIVE]) {
    const written = context.marker.written[relative];
    if (written && context.before[relative] === installed.get(relative)) installed.set(relative, written);
  }
  const newPath = plan.template.new_path;
  if (newPath && context.marker.written[newPath]) installed.set(newPath, context.marker.written[newPath]);
  const next = {
    ...manifest,
    runtime_sha256: plan.to.runtime_sha256,
    work_template_sha256: plan.template.new_sha256,
    bridge_version: plan.to.version,
    installed_files: [...installed].sort((left, right) => left[0].localeCompare(right[0])),
    upgrades: [...(manifest.upgrades || []), {
      upgrade_id: context.marker.upgrade_id, from: plan.from, to: plan.to, backup_dir: context.marker.backup_dir,
      report_id: report.report_id, invalidated_count: report.invalidated_count, upgraded_at: new Date().toISOString(),
    }],
  };
  await writeRecorded(context, MANIFEST_RELATIVE, Buffer.from(JSON.stringify(next, null, 2) + "\n", "utf8"));
}

// P2.11 / P2.12: what undoing the upgrade means right now, from the marker, the backup and tools/.
async function upgradeRollbackActions(root, marker, backup) {
  const privateRoot = path.join(root, privateName);
  const backupRuntime = backup.files
    .filter(([name]) => name.startsWith(RUNTIME_RELATIVE + "/"))
    .map(([name, hash]) => [name.slice(RUNTIME_RELATIVE.length + 1), hash])
    .sort((left, right) => left[0].localeCompare(right[0]));
  if (sha256(JSON.stringify(backupRuntime)) !== marker.from_runtime_sha256) throw new Error("The backup does not hold the runtime from before the upgrade; nothing was changed.");
  const lists = { from: backupRuntime, to: marker.to_runtime_files || [] };
  // Every runtime directory is compared file by file, extra and missing files included, with the
  // runtime before (from the backup) and after (recorded in the marker before it was copied). A copy
  // interrupted midway may be part of its list. Anything else may be a human's change: the rollback
  // deletes none of it, refuses, and the marker stays (Codex 2026-10-15).
  // A side directory may be part of a list: a copy cut short, or a purge interrupted midway.
  const runtime = {};
  const unknown = [];
  for (const [key, relative] of [["current", RUNTIME_RELATIVE], ...RUNTIME_SIDES.map((kind) => [kind, runtimeSide(kind, marker.upgrade_id)])]) {
    const dir = inPrivate(privateRoot, relative);
    if (!(await statOptional(dir))) { runtime[key] = null; continue; }
    const files = await fileSnapshot(dir);
    const exact = Object.keys(lists).find((side) => sameValue(files, lists[side]));
    if (exact) { runtime[key] = exact; continue; }
    const part = key === "current" ? null : ["to", "from"].find((side) => {
      const reference = new Map(lists[side]);
      return files.every(([name, hash]) => reference.get(name) === hash);
    });
    if (part) { runtime[key] = part + "_part"; continue; }
    const from = new Map(lists.from);
    const to = new Map(lists.to);
    const names = new Set([...files.map(([name]) => name), ...from.keys(), ...to.keys()]);
    const present = new Map(files);
    const closest = [...from].filter(([name, hash]) => present.get(name) === hash).length >= [...to].filter(([name, hash]) => present.get(name) === hash).length ? from : to;
    for (const name of [...names].sort()) if (present.get(name) !== closest.get(name)) unknown.push(relative + "/" + name + (present.has(name) ? (closest.has(name) ? " (changed)" : " (added)") : " (missing)"));
  }
  if (unknown.length) {
    throw new Error("A runtime under tools/ is neither the version before nor the version after the upgrade, so the rollback will not delete or replace it and the marker stays: "
      + unknown.slice(0, 10).join(", ") + (unknown.length > 10 ? " and " + (unknown.length - 10) + " more" : "")
      + ". Move your changes out of .review-bridge/, then run upgrade --rollback again.");
  }
  const source = runtime.current === "from" ? "current" : runtime.previous === "from" ? "previous" : "backup";
  const outsideTools = ([name]) => !name.startsWith("tools/");
  const before = new Map(persistentOnly(backup.files).filter(outsideTools));
  const now = new Map(persistentOnly(await fileSnapshot(privateRoot)).filter(outsideTools));
  const written = marker.written || {};
  const restore = [];
  const remove = [];
  const kept = [];
  for (const name of [...new Set([...before.keys(), ...now.keys()])].sort()) {
    const original = before.get(name);
    const current = now.get(name) ?? null;
    const ours = written[name] ?? null;
    if (original !== undefined) {
      if (current === original) continue;
      if (current === ours || (current === null && ours !== null)) restore.push(name);
      else kept.push([name, current]);
    } else if (ours !== null && current === ours) remove.push(name);
    else kept.push([name, current]);
  }
  return { runtime, runtime_source: source, restore, remove, kept };
}

// Codex 2026-10-15: the rollback deletes or replaces only what it can show is Bridge's at the moment
// it acts, not at the moment it planned. A file is first renamed to a private name next to it (one
// atomic step), and only then hashed: a match is Bridge's and goes; anything else is linked back
// under its own name, never over a file that appeared there meanwhile. A directory goes only through
// rmdir, which the OS refuses while anything is in it. What cannot be shown to be Bridge's is kept,
// and so is the maintenance marker.
function asideName(file, purpose = "rollback") {
  return file + ".rb-" + purpose + "-" + randomUUID().slice(0, 8);
}

async function putBack(aside, file) {
  try {
    await fsp.link(aside, file);
  } catch (error) {
    if (error.code === "EEXIST") return aside;
    throw error;
  }
  await fsp.rm(aside);
  return file;
}

// Deletes the file only if, once moved aside, it hashes to `expected`. Returns where it is otherwise.
async function deleteIfExpected(file, expected) {
  const aside = asideName(file);
  try {
    await fsp.rename(file, aside);
  } catch (error) {
    if (error.code === "ENOENT") return { gone: true };
    return { kept: file, hash: null, reason: error.code };
  }
  const hash = await hashOptional(aside);
  if (expected !== undefined && expected !== null && hash === expected) {
    await fsp.rm(aside);
    return { deleted: true };
  }
  return { kept: await putBack(aside, file), hash };
}

async function listTree(root, relative = "") {
  const files = [];
  const directories = [];
  for (const entry of await fsp.readdir(path.join(root, relative), { withFileTypes: true })) {
    const next = path.posix.join(relative, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const inner = await listTree(root, next);
      files.push(...inner.files);
      directories.push(...inner.directories, next);
    } else files.push(next);
  }
  return { files, directories };
}

// Empties a runtime directory of the files that match its list, then removes the directories the
// OS lets go of. Everything else is reported as left over, relative to .review-bridge/.
async function purgeRuntimeDir(privateRoot, relative, expectedList, leftovers) {
  const root = inPrivate(privateRoot, relative);
  if (!(await statOptional(root))) return;
  const expected = new Map(expectedList || []);
  const { files, directories } = await listTree(root);
  for (const name of files) {
    const result = await deleteIfExpected(path.join(root, ...name.split("/")), expected.get(name));
    if (result.kept) leftovers.push(path.relative(privateRoot, result.kept).replaceAll("\\", "/"));
  }
  for (const name of [...directories, ""]) {
    const target = name ? path.join(root, ...name.split("/")) : root;
    try {
      await fsp.rmdir(target);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      if (!["ENOTEMPTY", "EEXIST", "EPERM", "EBUSY"].includes(error.code)) throw error;
      const shown = path.posix.join(relative, name);
      if (!leftovers.some((entry) => entry.startsWith(shown + "/"))) leftovers.push(shown + "/");
    }
  }
}

function leftoverError(leftovers) {
  const error = new Error("The rollback will not delete or overwrite these, because it cannot show they are Bridge's: "
    + leftovers.slice(0, 10).join(", ") + (leftovers.length > 10 ? " and " + (leftovers.length - 10) + " more" : "")
    + ". The marker stays, so new work stays blocked. Move them out of .review-bridge/, then run upgrade --rollback again.");
  error.leftovers = leftovers;
  return error;
}

// P2.11 / P2.13: put the runtime and the files back.
async function restoreUpgrade(context, actions, backup) {
  const { privateRoot, marker } = context;
  const relativeOf = (kind) => (kind === "current" ? RUNTIME_RELATIVE : runtimeSide(kind, marker.upgrade_id));
  const dir = (kind) => inPrivate(privateRoot, relativeOf(kind));
  const lists = {
    from: backup.files.filter(([name]) => name.startsWith(RUNTIME_RELATIVE + "/")).map(([name, hash]) => [name.slice(RUNTIME_RELATIVE.length + 1), hash]),
    to: marker.to_runtime_files || [],
  };
  const listOf = (kind) => (kind ? lists[kind.replace(/_part$/, "")] : []);
  const leftovers = [];
  const purge = (kind, runtimeKind) => purgeRuntimeDir(privateRoot, relativeOf(kind), listOf(runtimeKind), leftovers);
  const stopOnLeftovers = () => { if (leftovers.length) throw leftoverError(leftovers); };
  // What each side directory holds now, as the plan classified it; updated as directories move.
  const side = { ...actions.runtime };
  if (actions.runtime_source !== "current") {
    // The renames below never overwrite: a directory left in the way stops the rollback first.
    await purge("failed", side.failed);
    stopOnLeftovers();
    side.failed = null;
    if (await statOptional(dir("current"))) {
      await fsp.rename(dir("current"), dir("failed"));
      side.failed = side.current;
    }
    if (actions.runtime_source === "previous") {
      await fsp.rename(dir("previous"), dir("current"));
      side.previous = null;
    } else {
      await purge("restore", side.restore);
      stopOnLeftovers();
      for (const [name] of lists.from) {
        const target = path.join(dir("restore"), ...name.split("/"));
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.copyFile(path.join(marker.backup_dir, "files", ...RUNTIME_RELATIVE.split("/"), ...name.split("/")), target, fsConstants.COPYFILE_EXCL);
      }
      if ((await runtimeFingerprint(dir("restore"))) !== marker.from_runtime_sha256) throw new Error("The runtime copied back from the backup does not match the one before the upgrade.");
      await fsp.rename(dir("restore"), dir("current"));
      side.restore = null;
    }
  }
  if (context.hooks.afterRuntimeRestored) await context.hooks.afterRuntimeRestored(context);
  const original = new Map(backup.files);
  const kept = [...actions.kept];
  let restored = 0;
  let removed = 0;
  for (const name of actions.restore) {
    const file = inPrivate(privateRoot, name);
    if ((await hashOptional(file)) === original.get(name)) continue;
    const ours = marker.written?.[name] ?? null;
    const aside = asideName(file);
    let moved = true;
    try {
      await fsp.rename(file, aside);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      moved = false;
    }
    const current = moved ? await hashOptional(aside) : null;
    if (!(current === ours || (current === null && ours !== null))) {
      const where = moved ? await putBack(aside, file) : file;
      if (where === file) kept.push([name, current]);
      else leftovers.push(path.relative(privateRoot, where).replaceAll("\\", "/"));
      continue;
    }
    await fsp.mkdir(path.dirname(file), { recursive: true });
    try {
      await fsp.copyFile(path.join(marker.backup_dir, "files", ...name.split("/")), file, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      leftovers.push(name);
      if (moved) leftovers.push(path.relative(privateRoot, aside).replaceAll("\\", "/"));
      continue;
    }
    if ((await hashOptional(file)) !== original.get(name)) throw new Error("Could not restore " + name + " from the backup.");
    if (moved) await fsp.rm(aside);
    restored += 1;
  }
  for (const name of actions.remove) {
    const file = inPrivate(privateRoot, name);
    const result = await deleteIfExpected(file, marker.written?.[name]);
    if (result.deleted) removed += 1;
    else if (result.kept === file) kept.push([name, result.hash]);
    else if (result.kept) leftovers.push(path.relative(privateRoot, result.kept).replaceAll("\\", "/"));
  }
  for (const kind of RUNTIME_SIDES) await purge(kind, side[kind]);
  const manifest = JSON.parse(await fsp.readFile(inPrivate(privateRoot, MANIFEST_RELATIVE), "utf8"));
  if (manifest.runtime_sha256 !== marker.from_runtime_sha256 || (await runtimeFingerprint(dir("current"))) !== marker.from_runtime_sha256) {
    throw new Error("After the rollback the install record or the runtime is not the one from before the upgrade.");
  }
  stopOnLeftovers();
  return { runtime_source: actions.runtime_source, restored, removed, kept };
}

// P2.11: any failure after the backup puts the project back as it was before the upgrade.
async function rollbackAfterFailure(context, error) {
  let result;
  try {
    const backup = await readBackupManifest(context.marker);
    result = await restoreUpgrade(context, await upgradeRollbackActions(context.root, context.marker, backup), backup);
    await restartStoppedService(context);
  } catch (rollbackError) {
    throw new Error("The upgrade failed (" + error.message + ") and the automatic rollback did not finish (" + rollbackError.message
      + "). Bridge stays blocked for new work. Run: node bridge.mjs upgrade --rollback. The backup is in " + context.marker.backup_dir);
  }
  await fsp.rm(context.markerPath, { force: true });
  const failed = new Error("The upgrade failed and was rolled back; the installed Bridge is as before: " + error.message
    + (result.kept.length ? ". Left as they are, because they changed during the upgrade: " + result.kept.map(([name]) => name).join(", ") : ""));
  failed.rolledBack = result;
  throw failed;
}

async function applyUpgradeLocked(plan, hooks) {
  const root = plan.target;
  const privateRoot = path.join(root, privateName);
  const markerPath = inPrivate(privateRoot, MAINTENANCE_MARKER);
  const id = randomUUID();
  const context = {
    root, privateRoot, markerPath, hooks, serviceStopAttempted: false, before: {},
    marker: {
      schema_version: 4, upgrade_id: id, operation: "upgrade", started_at: new Date().toISOString(),
      from_version: plan.from.version, to_version: plan.to.version,
      from_runtime_sha256: plan.from.runtime_sha256, to_runtime_sha256: plan.to.runtime_sha256,
      service_was_running: plan.service_running, backup_dir: null, backup_manifest_sha256: null, written: {},
    },
  };
  // P2.2: the marker first. From here every Bridge start in this project fails closed.
  await fsp.mkdir(path.dirname(markerPath), { recursive: true });
  try {
    const handle = await fsp.open(markerPath, "wx");
    try { await handle.writeFile(JSON.stringify(context.marker, null, 2) + "\n"); await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("Another Bridge maintenance is in progress here.");
    throw error;
  }
  try {
    if (hooks.afterMarker) await hooks.afterMarker(context);
    // P2.3
    const fresh = await planFreshUpgrade(root, plan.backup_root_custom ? plan.backup_root : null).catch((error) => ({ error }));
    if (fresh.plan_sha256 !== plan.plan_sha256) {
      throw refusal("The project changed after the plan was shown; make a new plan." + (fresh.error ? " (" + fresh.error.message + ")" : ""));
    }
    // P2.4: runs are checked only now that the marker blocks new ones.
    const runs = await activeRuns(privateRoot).catch((error) => { throw refusal(error.message); });
    if (runs.length) throw refusal("Work is still running: " + runs.map((run) => run.run_id + " (" + run.status + ")").join(", ") + ". Stop it or let it finish first.");
    // P2.5
    if (plan.service_running) {
      context.serviceStopAttempted = true;
      if (!(await (hooks.stopService || stopPageService)(root))) throw refusal("The Bridge page service did not stop.");
    }
    if (hooks.afterServiceStop) await hooks.afterServiceStop(context);
    // P2.6 / B6: a verified backup, and the originals still what was approved and backed up.
    const project = await fsp.realpath(root);
    const backupDir = path.join(plan.backup_root, projectKey(project), new Date().toISOString().replace(/[:.]/g, "-") + "-upgrade-" + id.slice(0, 8));
    const backup = await backupTree(privateRoot, backupDir, {
      project, operation: "upgrade", transaction_id: id, install_manifest_sha256: plan.install_manifest_sha256,
    }, hooks.afterBackup).catch((error) => { throw refusal("The backup could not be verified; nothing was changed: " + error.message); });
    const now = persistentOnly(await fileSnapshot(privateRoot));
    const known = new Map(backup.manifest.files);
    const changed = now.find(([name, hash]) => known.get(name) !== hash);
    if (sha256(JSON.stringify(now)) !== plan.persistent_sha256 || changed) {
      throw refusal("A file changed after the backup: " + (changed ? changed[0] : "(set of files)") + ". Nothing was changed; make a new plan.");
    }
    context.marker.backup_dir = backupDir;
    context.marker.backup_manifest_sha256 = backup.sha;
    // The new runtime's file list, recorded before the copy, is how a rollback recognises it.
    const toFiles = await fileSnapshot(path.join(packageRoot, "review-bridge"));
    if (sha256(JSON.stringify(toFiles)) !== plan.to.runtime_sha256) throw refusal("The Bridge source changed after the plan was shown; make a new plan.");
    context.marker.to_runtime_files = toFiles;
    await markerSave(context);
  } catch (error) {
    await releaseBeforeChange(context, error);
  }
  const runtimeDir = inPrivate(privateRoot, RUNTIME_RELATIVE);
  const nextDir = inPrivate(privateRoot, runtimeSide("next", id));
  const previousDir = inPrivate(privateRoot, runtimeSide("previous", id));
  let settings;
  let report;
  try {
    if (hooks.afterBackupVerified) await hooks.afterBackupVerified(context);
    // P2.7
    await fsp.cp(path.join(packageRoot, "review-bridge"), nextDir, { recursive: true });
    if ((await runtimeFingerprint(nextDir)) !== plan.to.runtime_sha256) throw new Error("The copied runtime does not match the source it was planned from.");
    if (hooks.afterPrepare) await hooks.afterPrepare(context);
    // P2.8: only these two directories under tools/ are renamed; the marker stays throughout.
    await fsp.rename(runtimeDir, previousDir);
    if (hooks.betweenRenames) await hooks.betweenRenames(context);
    await fsp.rename(nextDir, runtimeDir);
    if (hooks.afterSwap) await hooks.afterSwap(context);
    // P2.9
    settings = await mergeSettings(context, plan);
    if (hooks.afterConfig) await hooks.afterConfig(context);
    // P2.10
    report = await writeInvalidations(context);
    await writeUpgradeManifest(context, plan, report);
    if (hooks.beforeVerify) await hooks.beforeVerify(context);
    await verifyNeutralInstall(root);
  } catch (error) {
    await rollbackAfterFailure(context, error);
  }
  await fsp.rm(markerPath, { force: true });
  const warnings = [];
  try {
    await fsp.rm(previousDir, { recursive: true, force: true });
  } catch (error) {
    warnings.push("The previous runtime could not be deleted (" + error.message + "); delete " + previousDir + " by hand.");
  }
  let restarted = false;
  if (plan.service_running) {
    restarted = await (hooks.restartService || startPageService)(root).catch(() => false);
    if (!restarted) warnings.push("The Bridge page service did not restart; start it with up.");
  }
  return {
    ok: true, operation: "upgrade", target: root, from: plan.from, to: plan.to, backup_dir: context.marker.backup_dir,
    kept_user_file_count: plan.user_file_count, config_added_keys: settings.added, template: settings.template, template_new_path: settings.template_new_path,
    invalidated_count: report.invalidated_count, invalidated_authorization_ids: report.invalidated_authorization_ids,
    service_restarted: restarted, reviewer_readonly: "not_run", warnings,
  };
}

// P1.4 / P2.1: approval binds the exact plan; it is rebuilt under the install lock before acting.
export async function applyNeutralUpgrade(plan, approval, hooks = {}) {
  if (plan?.operation !== "upgrade_neutral") throw new Error("Not an upgrade plan.");
  if (sealPlan(plan).plan_sha256 !== plan.plan_sha256 || approval !== plan.plan_sha256) throw new Error("Upgrade plan approval is invalid.");
  return await withInstallLock(plan.target, async () => {
    if (hooks.afterLock) await hooks.afterLock();
    if (await statOptional(path.join(plan.target, privateName, MAINTENANCE_MARKER))) throw new Error("Another Bridge maintenance is in progress here.");
    return await applyUpgradeLocked(plan, hooks);
  });
}

// P2.12: the plan for an interrupted upgrade. It never reads the install manifest's verdict; only
// the marker, the backup it names and what is under tools/ now.
export async function planNeutralUpgradeRollback({ target }) {
  const root = path.resolve(target);
  const stat = await statOptional(root);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error("Target must be an existing, non-symlink workspace directory.");
  const markerPath = path.join(root, privateName, MAINTENANCE_MARKER);
  const markerBytes = await fsp.readFile(markerPath).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (!markerBytes) throw new Error("No interrupted upgrade here: there is no maintenance marker.");
  let marker;
  try {
    marker = JSON.parse(markerBytes.toString("utf8"));
  } catch (error) {
    throw new Error("The maintenance marker " + markerPath + " cannot be read (" + error.message + "). Do not delete it: it is what keeps new work blocked and it names the backup.");
  }
  if (marker?.operation !== "upgrade") {
    throw new Error(marker?.operation === "uninstall"
      ? "The maintenance marker was left by an uninstall, not an upgrade; run uninstall again to finish or cancel it."
      : "The maintenance marker was not left by an upgrade (operation: " + marker?.operation + "); upgrade --rollback will not touch it.");
  }
  if (typeof marker.upgrade_id !== "string" || !/^[0-9a-f-]{36}$/.test(marker.upgrade_id)) throw new Error("The maintenance marker has no valid upgrade id.");
  const base = {
    schema_version: 1, operation: "upgrade_rollback", target: root, marker_sha256: sha256(markerBytes), upgrade_id: marker.upgrade_id,
    from: { version: marker.from_version ?? null, runtime_sha256: marker.from_runtime_sha256 },
    restart_service: marker.service_was_running === true && !(await pageServiceRunning(root)),
  };
  // Interrupted before the backup was recorded: the runtime and the settings were never touched.
  if (!marker.backup_dir) return sealPlan({ ...base, kind: "release" });
  let backup;
  try {
    backup = await readBackupManifest(marker);
  } catch (error) {
    throw new Error("The backup named by the maintenance marker does not match it, so it will not be used (" + error.message + "). Backup: " + marker.backup_dir);
  }
  if (!samePathText(String(backup.project || ""), await fsp.realpath(root)) || backup.operation !== "upgrade" || backup.transaction_id !== marker.upgrade_id) {
    throw new Error("The backup named by the maintenance marker belongs to another project or operation, so it will not be used. Backup: " + marker.backup_dir);
  }
  return sealPlan({
    ...base, kind: "restore", backup_dir: marker.backup_dir, backup_manifest_sha256: marker.backup_manifest_sha256,
    ...(await upgradeRollbackActions(root, marker, backup)),
  });
}

// P2.13
export async function applyNeutralUpgradeRollback(plan, approval, hooks = {}) {
  if (plan?.operation !== "upgrade_rollback") throw new Error("Not an upgrade rollback plan.");
  if (sealPlan(plan).plan_sha256 !== plan.plan_sha256 || approval !== plan.plan_sha256) throw new Error("Upgrade rollback plan approval is invalid.");
  return await withInstallLock(plan.target, async () => {
    const current = await planNeutralUpgradeRollback({ target: plan.target });
    if (current.plan_sha256 !== plan.plan_sha256) throw new Error("The project changed after the plan was shown; make a new plan.");
    const privateRoot = path.join(plan.target, privateName);
    const markerPath = inPrivate(privateRoot, MAINTENANCE_MARKER);
    const marker = JSON.parse(await fsp.readFile(markerPath, "utf8"));
    const context = { root: plan.target, privateRoot, markerPath, marker, hooks };
    let result = { runtime_source: null, restored: 0, removed: 0, kept: [] };
    if (plan.kind === "restore") result = await restoreUpgrade(context, plan, await readBackupManifest(marker));
    let restarted = false;
    if (plan.restart_service) {
      restarted = await (hooks.restartService || startPageService)(plan.target);
      if (!restarted) {
        throw new Error("The rollback " + (plan.kind === "restore" ? "restored the files" : "changed nothing")
          + ", but the Bridge page service that was running did not restart; the marker stays. Run upgrade --rollback again.");
      }
    }
    await fsp.rm(markerPath, { force: true });
    return { ok: true, operation: "upgrade_rollback", kind: plan.kind, target: plan.target, ...result, service_restarted: restarted, backup_dir: plan.backup_dir ?? null };
  });
}

// P1.3 and the closing lines. Every line comes from the sealed plan or the result.
export const PROOF_LOSS_LINE = "升級會重啟網頁服務；reviewer 唯讀實測的證明存在服務記憶體裡，重啟後會消失。之後要做原生工作，得在網頁上重做一次實測（會呼叫一次 reviewer 模型）。";
const PROOF_REDO_LINE = "reviewer 唯讀實測要在網頁上重做一次，才能做原生工作";
const versionText = (side) => (side.version || "未標版本") + "（" + String(side.runtime_sha256).slice(0, 8) + "）";

export function formatUpgradePlan(plan) {
  const template = {
    replace: "TEMPLATE.md：你沒改過，換成新版。",
    keep_and_write_new: "TEMPLATE.md：你改過，保留不動；新版另存成 " + path.posix.basename(plan.template.new_path || "") + "。",
    unchanged: "TEMPLATE.md：與新版相同，不動。",
  }[plan.template.action];
  return [
    "升級 Review Bridge：" + plan.target,
    versionText(plan.from) + " → " + versionText(plan.to),
    "會換掉執行程式：" + plan.runtime_file_count.from + " 個檔換成 " + plan.runtime_file_count.to + " 個檔",
    "會保留你的 " + plan.user_file_count + " 個檔（工單、結果、日檔、run 紀錄、授權、rules.md 等都不動）：",
    ...plan.user_files.map((name) => "  " + name),
    ...(plan.user_file_count > plan.user_files.length ? ["  …另外 " + (plan.user_file_count - plan.user_files.length) + " 個"] : []),
    ...(plan.config_added_keys.length ? ["bridge.json 會補上新設定：" + plan.config_added_keys.join("、")] : []),
    ...(plan.config_updated_keys.length ? ["bridge.json 會更新 Bridge 自己的設定：" + plan.config_updated_keys.join("、")] : []),
    template,
    ...(plan.policy_changed ? ["新版的預設 policy 不同：升級後未開始的授權會失效，需重新建 plan。"] : []),
    ...(plan.service_running ? ["會先停掉網頁服務，升級後再啟動。"] : []),
    "整份先備份到專案外，核對後才換：" + plan.backup_parent,
    PROOF_LOSS_LINE,
  ].join("\n") + "\n";
}

export function formatUpgradeResult(result) {
  if (result.up_to_date) return "已是這一版（" + (result.version || "未標版本") + "），沒有動任何檔。\n";
  return [
    "已升級到 " + (result.to.version || "未標版本") + "（" + result.to.runtime_sha256.slice(0, 8) + "）",
    "保留了你的 " + result.kept_user_file_count + " 個檔；備份在 " + result.backup_dir,
    ...(result.invalidated_count ? ["失效的授權 " + result.invalidated_count + " 個；要做那些工作得重新建 plan"] : []),
    ...(result.template === "keep_and_write_new" ? ["TEMPLATE.md 你改過，保留了；新版在 " + path.posix.basename(result.template_new_path)] : []),
    PROOF_REDO_LINE,
    ...result.warnings.map((warning) => "警告：" + warning),
  ].join("\n") + "\n";
}

export function formatUpgradeRollbackPlan(plan) {
  if (plan.kind === "release") {
    return [
      "上一次升級在備份之前中斷，執行程式與設定都沒動。",
      "這次會：拿掉維護標記" + (plan.restart_service ? "、重新啟動網頁服務" : "") + "。",
    ].join("\n") + "\n";
  }
  const runtime = {
    current: "執行程式：現在那份就是升級前的，不用換",
    previous: "執行程式取自 previous（升級前那份，還在 tools/ 底下）",
    backup: "執行程式取自備份",
  }[plan.runtime_source];
  const list = (items) => items.slice(0, 20).map((item) => "  " + (Array.isArray(item) ? item[0] : item));
  return [
    "上一次升級中斷，要退回升級前（" + (plan.from.version || "未標版本") + "）。",
    runtime,
    ...(plan.restore.length ? ["從備份還原 " + plan.restore.length + " 個檔：", ...list(plan.restore)] : []),
    ...(plan.remove.length ? ["刪掉升級寫入的 " + plan.remove.length + " 個檔：", ...list(plan.remove)] : []),
    ...(plan.kept.length ? ["保留不動 " + plan.kept.length + " 個檔（升級期間被改過，既不是備份版也不是升級寫入的版本）：", ...list(plan.kept)] : []),
    ...(plan.restart_service ? ["會重新啟動網頁服務。"] : []),
    "備份在：" + plan.backup_dir,
  ].join("\n") + "\n";
}

export function formatUpgradeRollbackResult(result) {
  if (result.kind === "release") return "已拿掉上一次升級留下的維護標記" + (result.service_restarted ? "，網頁服務已重新啟動" : "") + "。\n";
  return [
    "已退回升級前",
    "還原 " + result.restored + " 個檔，刪掉升級寫入的 " + result.removed + " 個檔",
    ...(result.kept.length ? ["保留不動：" + result.kept.map(([name]) => name).join("、")] : []),
    ...(result.service_restarted ? ["網頁服務已重新啟動"] : []),
  ].join("\n") + "\n";
}
