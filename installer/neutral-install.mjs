import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { inspectStateFilesystem } from "../review-bridge/core/filesystem-v4.mjs";
import { projectPolicyOverride, resolveProfile, detectProject } from "./install.mjs";
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

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function withInstallLock(target, operation) {
  const lockPath = path.join(path.resolve(target), ".review-bridge-install.lock");
  let handle;
  try {
    handle = await fsp.open(lockPath, "wx");
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("Another Bridge installation is active or a stale install lock needs inspection.");
    throw error;
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
    await writeJson(path.join(privateRoot, "review-bridge", "bridge.json"), {
      schema_version: 4,
      state_contract: "v4",
      profile_id: plan.profile.id,
      roles: {
        writer: { provider_id: plan.roles.writer },
        reviewer: { provider_id: plan.roles.reviewer },
        separate_sessions: true,
        reviewer_readonly_required: true,
      },
      requires_human_authorization: true,
      watch: { port: plan.watch.port, strict_port: plan.watch.strict_port },
      retention: { days: plan.retention?.days ?? DEFAULT_RETENTION_DAYS },
      readiness: { reviewer_readonly_proven: "not_run" },
      default_policy_ref: ".review-bridge/tools/review-bridge/config/default-policy.json",
      project_override_ref: ".review-bridge/review-bridge/policy.override.json",
      active_runs: "derive_from_run_projections",
    });
    await writeJson(path.join(privateRoot, "review-bridge", "policy.override.json"), projectPolicyOverride(profile));
    await fsp.mkdir(path.join(privateRoot, "work-packages"), { recursive: true });
    await fsp.copyFile(path.join(packageRoot, "project-templates", "work-package.md"),
      path.join(privateRoot, "work-packages", "TEMPLATE.md"));
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
  const templateSha = sha256(await fsp.readFile(path.join(privateRoot, "work-packages", "TEMPLATE.md")));
  if (templateSha !== manifest.work_template_sha256) throw new Error("Neutral work template checksum mismatch.");
  const boundary = gitBoundary(root);
  if (boundary.repository && !boundary.ignored) throw new Error("Neutral Bridge state is not private in Git.");
  return { valid: true, layout: "neutral", roles: manifest.roles, runtime_sha256: runtimeSha };
}
