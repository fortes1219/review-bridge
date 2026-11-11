import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants, realpathSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  canonical,
  CLOSED_REASONS,
  getBridgePaths,
  inspectStateFilesystem,
  isActiveRun,
  planUpgradeInvalidations,
  policyIdentity,
} from "../review-bridge/service/index.mjs";
import { bridgeDataHome } from "../review-bridge/service/database/dataHome.mjs";
import { DEFAULT_LOCALE, systemLocale } from "../review-bridge/features/workOrder/i18n.mjs";
import { projectLogRoot, projectStateRoot, readProjectId } from "../review-bridge/utils/paths.mjs";
import {
  AGENT_COMMAND_RELATIVE, agentEntriesPending, agentEntriesState, agentFilesState, planAgentEntries, releaseAgentEntries, undoAgentFiles, writeAgentEntries,
} from "./agent-files.mjs";
import { projectPolicyOverride, resolveProfile, detectProject } from "./project-profile.mjs";
import { validateRoles } from "./role-readiness.mjs";
import { releaseAllVscodeTasks, vscodeTasksState } from "./vscode-tasks.mjs";
import { bridgeRunner } from "../review-bridge/utils/bridgeCommand.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privateName = ".review-bridge";
// The folder keeps itself out of Git, whether Git is there at init or comes later, and touches no file of
// the person's: pytest's .pytest_cache/.gitignore (cacheprovider.py), ruff's .ruff_cache, uv's .venv.
const GIT_IGNORE = Object.freeze({ relative: ".gitignore", text: "# Created by Review Bridge automatically.\n*\n" });
// The one runtime every project runs from.
const sourceRuntime = path.join(packageRoot, "review-bridge");

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

// The path as the file system names it: Windows 8.3 short names (C:\Users\RUNNER~1) expanded and
// links resolved, for the part that exists; Git reports its paths that way, so both sides of a
// comparison go through this first.
function realNative(target) {
  let current = path.resolve(target);
  const rest = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...rest);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

function under(child, parent) {
  const fold = (value) => (process.platform === "win32" ? realNative(value).toLowerCase() : realNative(value));
  const relative = path.relative(fold(parent), fold(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export async function runtimeFingerprint(root = path.join(packageRoot, "review-bridge")) {
  const rootStat = await fsp.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Runtime root must be a normal directory.");
  const files = [];
  // A queue of directories, not recursion; the files are sorted afterwards.
  const queue = [[root, ""]];
  while (queue.length) {
    const [directory, relative] = queue.shift();
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Runtime source contains a symlink.");
      const next = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) queue.push([path.join(directory, entry.name), next]);
      else if (entry.isFile()) files.push([next, sha256(await fsp.readFile(path.join(directory, entry.name)))]);
    }
  }
  files.sort((left, right) => left[0].localeCompare(right[0]));
  return sha256(JSON.stringify(files));
}

// Whether the folder is in a Git repository, and whether Git ignores .review-bridge/ there.
function gitBoundary(selected) {
  if (!git(selected, ["rev-parse", "--show-toplevel"])) return { repository: false, ignored: null };
  const target = realNative(selected);
  const ignored = spawnSync("git", ["check-ignore", "-q", "--no-index", path.join(target, privateName, CONFIG_RELATIVE)], {
    cwd: target, windowsHide: true, timeout: 10_000, stdio: "ignore",
  }).status === 0;
  return { repository: true, ignored };
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
  // Only a detected type must fit the folder. A type the person chose is used as chosen; if it
  // does not fit, its test rules fail at work time, where that check belongs.
  if (profileId === "auto" && profile.profile_id !== null && detection.evidence.length === 0) throw new Error("The selected profile has no project evidence.");
  if (await statOptional(path.join(root, privateName))) {
    throw new Error("Bridge neutral state already exists; fresh install cannot overwrite it.");
  }
  const boundary = gitBoundary(root);
  const agentEntries = await planAgentEntries();
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
    work_template_sha256: await shippedTemplateHashes(),
    rules_sha256: sha256(await fsp.readFile(path.join(packageRoot, "project-templates", "rules.md"))),
    git: boundary,
    agent_entries: agentEntries,
    changes: [
      "Write the settings and work order templates to .review-bridge/, with a .gitignore there that keeps the folder out of Git; Bridge keeps its run state and logs in your data and log folders",
      ...agentEntries.filter((entry) => entry.action === "add" || entry.action === "replace").map((entry) => "Add the /review-bridge entry for your agent, outside the project: " + entry.path),
      "Leave everything else in the project untouched",
      "Serve the local page at http://localhost:" + watchPort + "/ (the next free port if it is taken)",
      "Run four fake scenarios in a disposable copy",
    ],
  };
  plan.plan_sha256 = sha256(JSON.stringify(plan));
  return plan;
}

// The bridge.json this version writes; T0-10 upgrades merge an installed one against it.
// project_id is the project's identity in the person's database (one database for all their
// projects); the folder's path is only where it was last seen. A copied folder carries the same id;
// init in the copy gives it its own (Owner 2026-10-25).
function neutralBridgeConfig({ projectId, profileId, roles, profile, watch = { port: DEFAULT_WATCH_PORT, strict_port: false }, retentionDays = DEFAULT_RETENTION_DAYS, locale = DEFAULT_LOCALE }) {
  return {
    schema_version: 4,
    project_id: projectId,
    profile_id: profileId,
    roles: {
      writer: { provider_id: roles.writer },
      reviewer: { provider_id: roles.reviewer },
      reviewer_readonly_required: true,
    },
    requires_human_authorization: true,
    watch: { port: watch.port, strict_port: watch.strict_port },
    retention: { days: retentionDays },
    // The language pack for cards, result files, notifications and the stdout summary: the system's at init.
    locale,
    // T0-06 G1.3: the profile-approved verification rules; work-plan picks the test command from here.
    test: { profile_id: profile.profile_id, rules: structuredClone(profile.verification_rules || []) },
    readiness: { reviewer_readonly_proven: "not_run" },
    // In the Bridge folder, which every project shares.
    default_policy_ref: "review-bridge/config/default-policy.json",
    project_override_ref: ".review-bridge/policy.override.json",
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

// A queue of directories, not recursion; the files are sorted afterwards.
export async function fileSnapshot(root, relative = "") {
  const files = [];
  const queue = [relative];
  while (queue.length) {
    const directory = queue.shift();
    for (const entry of await fsp.readdir(path.join(root, directory), { withFileTypes: true })) {
      const next = path.posix.join(directory.replaceAll("\\", "/"), entry.name);
      if (entry.isSymbolicLink()) throw new Error("Bridge state contains a symlink.");
      if (entry.isDirectory()) queue.push(next);
      else if (entry.isFile()) files.push([next, sha256(await fsp.readFile(path.join(root, next)))]);
    }
  }
  return files.sort((left, right) => left[0].localeCompare(right[0]));
}

// The agent entries belong to the person and every project uses them, so the last project set up in
// this data home takes them along (Homebrew's InstalledDependents asks the same before an uninstall).
// One listing and at most one stat per project; a listing that fails cannot say "none".
async function anotherProjectInstalled(stateRoot) {
  const projects = path.join(bridgeDataHome(), "projects");
  const entries = await fsp.readdir(projects, { withFileTypes: true }).catch((error) => (error.code === "ENOENT" ? [] : null));
  if (entries === null) return true;
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== path.basename(stateRoot || "") && await statOptional(path.join(projects, entry.name, MANIFEST_RELATIVE))) return true;
  }
  return false;
}

// Where an installation's files are (RC3-FIX-02). The project keeps its settings flat in .review-bridge/
// (bridge.json, policy.override.json, rules.md); the install record is service state and lives under
// the data home's projects/<project_id>/. Snapshots, backups and markers name it "@state/<file>", so
// the upgrade and uninstall steps handle it as one more installed file. A project set up before keeps
// its settings in .review-bridge/review-bridge/ with the record beside them until its upgrade moves
// them, once (Owner 2026-11-04).
const MANIFEST_RELATIVE = "review-bridge-install.json";
const STATE_PREFIX = "@state/";
const STATE_MANIFEST = STATE_PREFIX + MANIFEST_RELATIVE;
const CONFIG_RELATIVE = "bridge.json";
const NESTED_CONFIG = "review-bridge/bridge.json";
// What the upgrade moves from the nested layout, where to.
const NESTED_MOVES = Object.freeze([
  ["review-bridge/bridge.json", "bridge.json"],
  ["review-bridge/policy.override.json", "policy.override.json"],
  ["review-bridge/rules.md", "rules.md"],
  ["review-bridge/review-prompt.md", "review-prompt.md"],
]);

function inPrivate(privateRoot, relative) {
  return path.join(privateRoot, ...relative.split("/"));
}

// `stateRoot` is given when the settings that name it may be gone (an uninstall resumed after they
// were deleted); otherwise it comes from the project id in bridge.json. The log folder follows the same
// id (the state folder's name).
async function installLayout(root, { stateRoot = null } = {}) {
  const privateRoot = path.join(root, privateName);
  const logRootOf = (state) => (state ? projectLogRoot(path.basename(state)) : null);
  if (await statOptional(inPrivate(privateRoot, CONFIG_RELATIVE))) {
    const state = stateRoot || projectStateRoot(readProjectId(inPrivate(privateRoot, CONFIG_RELATIVE)));
    return { nested: false, privateRoot, stateRoot: state, logRoot: logRootOf(state), config: CONFIG_RELATIVE, manifest: STATE_MANIFEST, rules: "rules.md" };
  }
  if (await statOptional(inPrivate(privateRoot, NESTED_CONFIG))) {
    return { nested: true, privateRoot, stateRoot, logRoot: logRootOf(stateRoot), config: NESTED_CONFIG, manifest: MANIFEST_RELATIVE, rules: "review-bridge/rules.md" };
  }
  return { nested: false, privateRoot, stateRoot, logRoot: logRootOf(stateRoot), config: CONFIG_RELATIVE, manifest: stateRoot ? STATE_MANIFEST : MANIFEST_RELATIVE, rules: "rules.md" };
}

// "@state/<file>" is in the service's state folder, "@log/<file>" in the project's log folder; any
// other name is under .review-bridge/.
const LOG_PREFIX = "@log/";

function installPath(layout, name) {
  if (name.startsWith(LOG_PREFIX)) {
    if (!layout.logRoot) throw new Error("The project's log folder is not known: " + name);
    return path.join(layout.logRoot, ...name.slice(LOG_PREFIX.length).split("/"));
  }
  if (!name.startsWith(STATE_PREFIX)) return inPrivate(layout.privateRoot, name);
  if (!layout.stateRoot) throw new Error("The install record's folder is not known: " + name);
  return path.join(layout.stateRoot, ...name.slice(STATE_PREFIX.length).split("/"));
}

// The installed files as one sorted list: everything under .review-bridge/, and the install record in
// the service's state when it is there.
async function installSnapshot(layout) {
  const files = (await statOptional(layout.privateRoot)) ? await fileSnapshot(layout.privateRoot) : [];
  const record = layout.stateRoot ? await hashOptional(installPath({ ...layout }, STATE_MANIFEST)) : null;
  if (record) files.push([STATE_MANIFEST, record]);
  return files.sort((left, right) => left[0].localeCompare(right[0]));
}

// The folders the service keeps a project's state in, made with the project like init made them in
// review-queue/ before.
const STATE_FOLDERS = Object.freeze(["pending", "running", "done", "failed", "work-packages", "authorizations",
  "authorization-claims", "authorization-invalidations", "runs", "events", "run-locks", "reconcile-guards",
  "upgrade-reports", "policy-snapshots", "reviews"]);

// What an older Bridge kept in .review-bridge/ and an upgrade takes out. Nothing else there is Bridge's:
// the person's own files and the operating system's (.DS_Store, Thumbs.db, desktop.ini) stay where they
// are, unlisted (Owner 2026-11-04).
const LEGACY_ENTRIES = Object.freeze(["review-queue", "review-bridge", "reviews", "archive", "logs", "watch-session.json", "watch-url.txt", "review-bridge-install.json"]);

// RC3-FIX-02: an older setup kept the service's state, the page's output and every run's call logs in
// the project. The upgrade moves each file once and keeps its name: the run state into the state folder
// under the names of utils/paths.mjs's STATE table; the page's output into the log folder, and each
// run's call logs, plan, authorization card and result into the log folder's <run_id>/. A call log,
// plan, card or result that no run in the old folder names belonged to a run retention already
// removed, and goes. Any other file in those folders keeps its place relative to the folder it maps to
// (review-queue/ and review-bridge/ to the state folder, logs/ to the log folder). Only a file that
// would land on a different one already there stops the plan, and two old runs sharing the 8
// characters a call log carries.
const LEGACY_FOLDERS = Object.freeze(["review-queue", "reviews", "archive", "review-bridge", "logs"]);
const LEGACY_PAGE_FILES = Object.freeze(["watch-session.json", "watch-url.txt"]);
const LEGACY_PAGE_LOGS = Object.freeze(["logs/watch.stdout.log", "logs/watch.stderr.log"]);
// A call log's name: its time, and the first 8 characters of its run when the name carries them.
const CALL_LOG = /^\d{8}T\d{9}Z(?:-r([0-9a-f]{8}))?-/;

// Every folder under the old folders, relative to .review-bridge/: a stack, not recursion.
async function legacyFolders(privateRoot) {
  const folders = [];
  const stack = [];
  for (const name of LEGACY_FOLDERS) if ((await statOptional(inPrivate(privateRoot, name)))?.isDirectory()) stack.push(name);
  while (stack.length) {
    const folder = stack.pop();
    folders.push(folder);
    for (const entry of await fsp.readdir(inPrivate(privateRoot, folder), { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(folder + "/" + entry.name);
    }
  }
  return folders.sort();
}

// The moves ([from, to, sha256]) and the files that go ([from, sha256]), from .review-bridge/ as it is
// now. Reads every old file once (its hash) and each old run record once; nothing else.
async function legacyLayoutPlan(layout, { nested }) {
  const { privateRoot } = layout;
  const moves = [];
  const drops = [];
  const unknown = [];
  const present = new Set(await fsp.readdir(privateRoot).catch(() => []));
  const files = async (folder) => (present.has(folder) ? await fileSnapshot(privateRoot, folder) : []);
  const queue = await files("review-queue");
  const runs = new Set();
  const byPrefix = new Map();
  const byAuthorization = new Map();
  for (const [name] of queue) {
    if (!/^review-queue\/runs\/[^/]+\.json$/.test(name)) continue;
    const run = await readJsonOptional(inPrivate(privateRoot, name)).catch(() => null);
    if (typeof run?.run_id !== "string") continue;
    runs.add(run.run_id);
    byPrefix.set(run.run_id.slice(0, 8), [...(byPrefix.get(run.run_id.slice(0, 8)) || []), run.run_id]);
    for (const id of [...(Array.isArray(run.authorization_ids) ? run.authorization_ids : []), run.authorization_id].filter(Boolean)) byAuthorization.set(id, run.run_id);
  }
  const toRun = (from, sha, name, runId) => (runId ? moves.push([from, LOG_PREFIX + runId + "/" + name, sha]) : drops.push([from, sha]));
  for (const [from, sha] of queue) {
    const rest = from.slice("review-queue/".length);
    const folder = rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : null;
    const call = CALL_LOG.exec(rest);
    if (folder) moves.push([from, STATE_PREFIX + rest, sha]);
    else if (call) {
      // Two old runs sharing the 8 characters cannot be told apart, so the file is not guessed at.
      const owners = call[1] ? byPrefix.get(call[1]) || [] : [];
      if (owners.length > 1) unknown.push(from);
      else toRun(from, sha, rest, owners[0]);
    } else if (rest.endsWith(".result.md")) {
      const runId = rest.slice(0, -".result.md".length);
      toRun(from, sha, rest, runs.has(runId) ? runId : null);
    } else if (rest.endsWith(".plan.json")) {
      // A plan and its card belong to the run its yes started: the authorization "plan-<plan_sha256>".
      const plan = await readJsonOptional(inPrivate(privateRoot, from)).catch(() => null);
      toRun(from, sha, rest, typeof plan?.plan_sha256 === "string" ? byAuthorization.get("plan-" + plan.plan_sha256) || null : null);
    } else if (/^authorized-.+\.txt$/.test(rest)) toRun(from, sha, rest, byAuthorization.get(rest.slice("authorized-".length, -".txt".length)) || null);
    else moves.push([from, STATE_PREFIX + rest, sha]);
  }
  for (const [from, sha] of [...await files("reviews"), ...await files("archive")]) moves.push([from, STATE_PREFIX + from, sha]);
  for (const [from, sha] of await files("review-bridge")) {
    const rest = from.slice("review-bridge/".length);
    if (!(nested && NESTED_MOVES.some(([source]) => source === from))) moves.push([from, STATE_PREFIX + rest, sha]);
  }
  const destination = { privateRoot, stateRoot: layout.stateRoot, logRoot: layout.logRoot };
  for (const [from, sha] of await files("logs")) {
    // The page's output is not a record: when the page this Bridge runs already writes its own, the
    // older one goes rather than overwrite it.
    const to = LOG_PREFIX + from.slice("logs/".length);
    if (LEGACY_PAGE_LOGS.includes(from) && destination.logRoot && await statOptional(installPath(destination, to))) drops.push([from, sha]);
    else moves.push([from, to, sha]);
  }
  // A file already where it goes is fine when it is the same; anything else there is not overwritten.
  const conflicts = [];
  if (destination.stateRoot) {
    for (const [, to, sha] of moves) {
      const there = await hashOptional(installPath(destination, to));
      if (there !== null && there !== sha) conflicts.push(to);
    }
  }
  const pageFiles = LEGACY_PAGE_FILES.filter((name) => present.has(name));
  // The page's own files are left out of the seal: the page may write them until it is stopped.
  const sealed = [moves.map(([from, to, sha]) => (TRANSIENT_FILES.includes(from) ? [from, to] : [from, to, sha])),
    drops.map(([from, sha]) => (TRANSIENT_FILES.includes(from) ? [from] : [from, sha]))];
  return { moves, drops, unknown, conflicts, page_files: pageFiles, sha256: sha256(JSON.stringify(sealed)) };
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
  let createdRoot = false;
  let wroteAgentEntries = false;
  let stateRoot = null;
  let createdState = false;
  try {
    await fsp.mkdir(privateRoot);
    createdRoot = true;
    // First, so nothing written after it is ever seen by Git, then or later.
    await fsp.writeFile(inPrivate(privateRoot, GIT_IGNORE.relative), GIT_IGNORE.text, "utf8");
    if (plan.git.repository && !gitBoundary(plan.target).ignored) throw new Error(".review-bridge/.gitignore did not keep the folder out of Git.");
    // The project holds only its settings and work order templates; the runtime stays in the Bridge
    // folder, the run state and the install record in the service's state under the project's id.
    const profile = await resolveProfile(plan.target, plan.profile.id);
    const projectId = randomUUID();
    await writeJson(inPrivate(privateRoot, CONFIG_RELATIVE), neutralBridgeConfig({
      projectId, profileId: plan.profile.id, roles: plan.roles, profile,
      watch: { port: plan.watch.port, strict_port: plan.watch.strict_port },
      retentionDays: plan.retention?.days ?? DEFAULT_RETENTION_DAYS,
      locale: await systemLocale(),
    }));
    await writeJson(inPrivate(privateRoot, "policy.override.json"), projectPolicyOverride(profile));
    await fsp.mkdir(path.join(privateRoot, "work-packages"), { recursive: true });
    for (const template of TEMPLATES) await fsp.copyFile(templateSource(template), inPrivate(privateRoot, template.relative));
    await fsp.copyFile(path.join(packageRoot, "project-templates", "rules.md"), inPrivate(privateRoot, "rules.md"));
    stateRoot = projectStateRoot(projectId);
    createdState = !(await statOptional(stateRoot));
    for (const name of STATE_FOLDERS) await fsp.mkdir(path.join(stateRoot, name), { recursive: true });
    wroteAgentEntries = true;
    await writeAgentEntries();
    const installedFiles = await fileSnapshot(privateRoot);
    await writeJson(installPath({ privateRoot, stateRoot }, STATE_MANIFEST), {
      schema_version: 1,
      layout: "neutral",
      profile_id: plan.profile.id,
      plan_sha256: claimed,
      // The Bridge runtime and default policy these settings were last set up against.
      runtime_sha256: plan.runtime_sha256,
      bridge_version: await runtimeVersion(sourceRuntime),
      policy_identity: await sourcePolicyIdentity(),
      work_template_sha256: plan.work_template_sha256,
      rules_sha256: plan.rules_sha256,
      installed_files: installedFiles,
      // Installs before .review-bridge/.gitignore recorded the line they added to .git/info/exclude here;
      // upgrade, rollback and uninstall still take that line away. A new install adds none.
      git_exclusion: null,
    });
    return { ok: true, target: plan.target, profile: plan.profile.id, roles: plan.roles, private_root: privateRoot };
  } catch (error) {
    if (wroteAgentEntries) await releaseAgentEntries({ inUse: await anotherProjectInstalled(stateRoot) }).catch(() => {});
    if (createdState) await fsp.rm(stateRoot, { recursive: true, force: true });
    if (createdRoot && path.resolve(privateRoot) === path.resolve(plan.target, privateName)) {
      await fsp.rm(privateRoot, { recursive: true, force: true });
    }
    throw new Error("Neutral install rolled back: " + error.message);
  }
}

// What upgrade and uninstall say when .review-bridge/ is here but its record is not: init rebuilds it.
const NO_RECORD = ".review-bridge/ is here, but its install record is not in Bridge's data folder (the folder was deleted, or this is another machine). Run: " + bridgeRunner() + " init — it rebuilds the record and keeps your settings, work orders and results.";

// init where .review-bridge/ is and its install record in the data folder is not (the data folder deleted,
// another machine, a reinstalled system), the way `git init` reinitializes an existing repository (git
// setup.c, "Reinitialized existing Git repository"): what is missing is made, nothing there is
// overwritten. The person's settings, rules, work orders and results stay as they are. The record counts as
// installed only the files that are exactly what this version ships, or that this call wrote; every other
// file is the person's, so upgrade and uninstall keep it. Returns null when the record is there: that is
// an install, and upgrade is the way to move it.
export async function reinitializeNeutralInstall({ target }) {
  const root = path.resolve(target);
  return await withInstallLock(root, async () => {
    const privateRoot = path.join(root, privateName);
    const configPath = inPrivate(privateRoot, CONFIG_RELATIVE);
    const config = await readJsonOptional(configPath).catch(() => null);
    if (!config?.project_id) {
      throw new Error(".review-bridge/ is here but its bridge.json has no project id, so Bridge cannot tell which project it was. Move .review-bridge/ aside and run: " + bridgeRunner() + " init");
    }
    const layout = await installLayout(root);
    if (await statOptional(installPath(layout, layout.manifest))) return null;
    for (const name of STATE_FOLDERS) await fsp.mkdir(path.join(layout.stateRoot, name), { recursive: true });
    await fsp.mkdir(path.join(privateRoot, "work-packages"), { recursive: true });
    const wrote = [];
    const fill = async (relative, write) => {
      if (await statOptional(inPrivate(privateRoot, relative))) return;
      await write(inPrivate(privateRoot, relative));
      wrote.push(relative);
    };
    for (const template of TEMPLATES) await fill(template.relative, (file) => fsp.copyFile(templateSource(template), file));
    await fill("rules.md", (file) => fsp.copyFile(path.join(packageRoot, "project-templates", "rules.md"), file));
    await fill("policy.override.json", async (file) => writeJson(file, projectPolicyOverride(await resolveProfile(root, config.profile_id ?? "auto"))));
    // Kept out of Git as init does; one the person already has there is theirs and left as it is.
    await fill(GIT_IGNORE.relative, (file) => fsp.writeFile(file, GIT_IGNORE.text, "utf8"));
    if (gitBoundary(root).repository && !gitBoundary(root).ignored) throw new Error(".review-bridge/ is not kept out of Git: its .gitignore no longer ignores it.");
    await writeAgentEntries();
    const shipped = new Map([
      ...TEMPLATES.map((template) => [template.relative, templateSource(template)]),
      ["rules.md", path.join(packageRoot, "project-templates", "rules.md")],
    ]);
    const shippedHash = new Map();
    for (const [relative, source] of shipped) shippedHash.set(relative, sha256(await fsp.readFile(source)));
    const installedFiles = (await fileSnapshot(privateRoot)).filter(([name, hash]) => wrote.includes(name) || shippedHash.get(name) === hash);
    await writeJson(installPath(layout, layout.manifest), {
      schema_version: 1,
      layout: "neutral",
      profile_id: config.profile_id ?? null,
      plan_sha256: null,
      reinitialized_at: new Date().toISOString(),
      runtime_sha256: await runtimeFingerprint(),
      bridge_version: await runtimeVersion(sourceRuntime),
      policy_identity: await sourcePolicyIdentity(),
      work_template_sha256: await shippedTemplateHashes(),
      rules_sha256: shippedHash.get("rules.md"),
      installed_files: installedFiles,
      git_exclusion: null,
    });
    return { reinitialized: true, target: root, private_root: privateRoot, wrote };
  });
}

export async function rollbackFreshNeutralInstall(plan) {
  return withInstallLock(plan.target, () => rollbackFreshNeutralInstallLocked(plan));
}

async function rollbackFreshNeutralInstallLocked(plan) {
  const target = path.resolve(plan.target);
  const privateRoot = path.join(target, privateName);
  const layout = await installLayout(target);
  const manifestPath = installPath(layout, layout.manifest);
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  if (manifest.layout !== "neutral" || manifest.plan_sha256 !== plan.plan_sha256) {
    throw new Error("Cannot roll back a different Bridge installation.");
  }
  if (JSON.stringify(await fileSnapshot(privateRoot)) !== JSON.stringify(manifest.installed_files)) {
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
  // The record goes, and the state folders init made while nothing was written in them.
  await fsp.rm(manifestPath, { force: true });
  if (await statOptional(layout.stateRoot)) await removeEmptyDirectories(layout.stateRoot);
  if (exclusion) {
    const remaining = exclusion.current.subarray(0, exclusion.current.length - exclusion.suffix.length);
    if (remaining.length === 0) await fsp.rm(exclusion.path, { force: true });
    else await fsp.writeFile(exclusion.path, remaining);
  }
  const agentEntries = await releaseAgentEntries({ inUse: await anotherProjectInstalled(layout.stateRoot) });
  return { rolled_back: true, target, agent_entries: agentEntries };
}

// `leftovers` lets an older setup's files still be there: only the upgrade's own plan asks so, since
// that upgrade is what moves them.
export async function verifyNeutralInstall(target, { leftovers = false } = {}) {
  const root = path.resolve(target);
  const privateRoot = path.join(root, privateName);
  const privateStat = await fsp.lstat(privateRoot);
  if (!privateStat.isDirectory() || privateStat.isSymbolicLink()) {
    throw new Error("Neutral Bridge state root must be a normal directory.");
  }
  // Nothing an older Bridge kept in the project is left there (RC3-FIX-02); anything else is not Bridge's.
  if (!leftovers) {
    const present = new Set(await fsp.readdir(privateRoot));
    const left = LEGACY_ENTRIES.filter((name) => present.has(name));
    if (left.length) throw new Error(".review-bridge/ still holds what an older Bridge kept there: " + left.join(", ") + ".");
  }
  const layout = await installLayout(root);
  const manifest = JSON.parse(await fsp.readFile(installPath(layout, layout.manifest), "utf8"));
  if (manifest.schema_version !== 1 || manifest.layout !== "neutral") {
    throw new Error("Unsupported neutral install manifest.");
  }
  const config = JSON.parse(await fsp.readFile(installPath(layout, layout.config), "utf8"));
  if (config.requires_human_authorization !== true
    || config.roles?.reviewer_readonly_required !== true
    || config.readiness?.reviewer_readonly_proven !== "not_run") {
    throw new Error("Neutral install protected authorization settings changed.");
  }
  // Who fills each role is the person's to change, like the watch block; it only has to name a
  // provider. bridge.json is the one place that says it.
  const roles = { writer: config.roles.writer?.provider_id, reviewer: config.roles.reviewer?.provider_id };
  try {
    validateRoles(roles);
  } catch (error) {
    throw new Error("Neutral install roles are invalid: " + error.message);
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
  // T0-10: each work-order template is owner-editable (an upgrade keeps an edited one); each one the
  // install recorded only has to exist. work_template_sha256 records the templates this version
  // shipped, to tell an edited one apart.
  for (const relative of Object.keys(recordedTemplateHashes(manifest))) {
    const templateText = await fsp.readFile(inPrivate(privateRoot, relative), "utf8").catch(() => null);
    if (!templateText?.trim()) throw new Error("Neutral work template is missing or empty (.review-bridge/" + relative + ").");
  }
  // rules.md is owner-editable: it must exist and stay within one page; its content is not pinned.
  const rulesText = await fsp.readFile(installPath(layout, layout.rules), "utf8").catch(() => null);
  if (rulesText === null) throw new Error("Neutral rules digest is missing (.review-bridge/" + layout.rules + ").");
  if (!rulesText.trim() || rulesText.length > 4000) throw new Error("Neutral rules digest must be 1 to 4000 characters.");
  const boundary = gitBoundary(root);
  if (boundary.repository && !boundary.ignored) throw new Error("Neutral Bridge state is not private in Git.");
  return { valid: true, layout: "neutral", roles, runtime_sha256: manifest.runtime_sha256 };
}

// ---------------------------------------------------------------------------------------------
// T0-09: neutral uninstall. Blocking (the maintenance marker inside the project, then the runtime
// moved aside) is kept apart from recovery (a journal and an index outside the project), so an
// interruption at any step can be recognised and finished or cancelled under a new approved plan.
// ---------------------------------------------------------------------------------------------

// Beside the settings it guards while an upgrade or uninstall changes them, like the install lock.
export const MAINTENANCE_MARKER = "upgrade-in-progress.json";
export const RUNTIME_RELATIVE = "tools/review-bridge";
// B4: rebuilt by the page service or owned by the transaction; backed up, never compared bit for bit.
export const TRANSIENT_FILES = Object.freeze([
  "watch-session.json",
  "watch-url.txt",
  "logs/watch.stdout.log",
  "logs/watch.stderr.log",
  MAINTENANCE_MARKER,
]);
// Codex 2026-10-14: what counts as running or closed comes from the state machine, never a second copy.
const JOURNAL_SCHEMA = 1;

// B1: the persistent backup root, under the person's data home beside the database's backups
// (backups/database); --backup-root overrides it.
export function defaultBackupRoot({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  return path.join(bridgeDataHome({ platform, env, home }), "backups", "installer");
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

// The page-service modules of the Bridge runtime.
export async function loadInstalledServiceModules(runtimeRoot) {
  const serviceFile = path.join(runtimeRoot, "features", "setupCheck", "pageService.mjs");
  if (!(await statOptional(serviceFile))) return null;
  const { getBridgePaths } = await import(pathToFileURL(path.join(runtimeRoot, "utils", "paths.mjs")).href);
  return { getBridgePaths, service: await import(pathToFileURL(serviceFile).href) };
}

async function runtimeModules(target) {
  const modules = await loadInstalledServiceModules(sourceRuntime);
  if (!modules) return null;
  return { runtimeRoot: sourceRuntime, service: modules.service, paths: modules.getBridgePaths(target, sourceRuntime, { privateRootName: privateName }) };
}

// The page an older Bridge started kept its session in the project. It is asked the way checkService
// asks the current one, through the same function: the recorded port answers /api/status with the
// recorded service id and pid. A dead pid, or a port that answers as something else, is not running.
function legacyPagePaths(target) {
  const privateRoot = path.join(path.resolve(target), privateName);
  return { watchSessionPath: path.join(privateRoot, "watch-session.json"), watchUrlPath: path.join(privateRoot, "watch-url.txt"), logRoot: path.join(privateRoot, "logs") };
}

async function legacyPageRunning(target) {
  const modules = await loadInstalledServiceModules(sourceRuntime).catch(() => null);
  if (!modules) return false;
  return (await modules.service.checkService(legacyPagePaths(target))).running === true;
}

async function currentPageRunning(target) {
  // A project still in the nested layout has no session where this runtime keeps it.
  if ((await installLayout(target).catch(() => null))?.nested !== false) return false;
  const runtime = await runtimeModules(target).catch(() => null);
  if (!runtime) return false;
  // Only looks: a free lease is "not running" without a request (pageService.mjs observePage).
  return (await runtime.service.observePage(runtime.paths)).running === true;
}

async function pageServiceRunning(target) {
  return (await legacyPageRunning(target)) || (await currentPageRunning(target));
}

// Each page is stopped through serviceDown, the path `down` takes.
async function stopPageService(target) {
  const modules = await loadInstalledServiceModules(sourceRuntime);
  if (!modules) return true;
  const quiet = { write() {} };
  if (await legacyPageRunning(target)) await modules.service.serviceDown({ paths: legacyPagePaths(target), out: quiet });
  if (await currentPageRunning(target)) {
    const runtime = await runtimeModules(target);
    await runtime.service.serviceDown({ paths: runtime.paths, out: quiet });
  }
  return !(await pageServiceRunning(target));
}

const REASON_LIMIT = 200;
const lastLine = (text) => String(text || "").trim().split(/\r?\n/).filter(Boolean).at(-1)?.slice(0, REASON_LIMIT) || "";

// Restarts the page service through Bridge's runtime, the same way init starts it. up exits 0 only once
// the page service it started, or the one it found, has reported ready (pageService.mjs launchPage), so
// its 0 is the answer and nothing is asked again. A failure carries what up said: its exit, the last line
// of its stdout (where up says why) and of its stderr, each clipped. The reason is shown to the person and
// never written into a marker.
async function startPageServiceDetailed(target) {
  if (!(await statOptional(path.join(sourceRuntime, "bootstrap.mjs")))) return { running: false, reason: "the Bridge runtime has no bootstrap.mjs" };
  const up = spawnSync(process.execPath, [path.join(sourceRuntime, "bootstrap.mjs"), "up", "--project", target], {
    cwd: target, windowsHide: true, timeout: 30_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  if (up.error?.code === "ETIMEDOUT") return { running: false, reason: "up timed out" };
  if (up.error || up.status !== 0 || up.signal) {
    const exit = up.signal || (up.status ?? up.error?.code ?? "error");
    return { running: false, reason: ["up exited " + exit, lastLine(up.stdout), lastLine(up.stderr)].filter(Boolean).join(" | ") };
  }
  return { running: true, reason: null };
}

// Every restart goes through here. A restart hook (tests, or a caller's own) may answer a boolean or
// { running, reason }; either way the caller gets { running: boolean, reason }.
async function restartOutcome(hook, target) {
  let value;
  try {
    value = hook ? await hook(target) : await startPageServiceDetailed(target);
  } catch (error) {
    return { running: false, reason: String(error?.message || error).slice(0, REASON_LIMIT) };
  }
  if (value && typeof value === "object") {
    return { running: value.running === true, reason: value.reason ? String(value.reason).slice(0, REASON_LIMIT) : null };
  }
  return { running: Boolean(value), reason: null };
}

const didNotRestart = (outcome) => "did not restart" + (outcome.reason ? ": " + outcome.reason : "");

// Codex 2026-10-14: a missing run folder or a record that cannot be read is "cannot confirm", not "none".
// The runs are in the service's state; a project still in the nested layout kept them in review-queue/.
// An older setup's runs left in review-queue/ are asked too, until the upgrade moves them.
async function activeRuns(layout) {
  const legacy = inPrivate(layout.privateRoot, "review-queue/runs");
  const directories = layout.nested ? [legacy] : [path.join(layout.stateRoot, "runs"), ...((await statOptional(legacy)) ? [legacy] : [])];
  const active = [];
  for (const directory of directories) active.push(...await activeRunsIn(directory));
  return active;
}

async function activeRunsIn(directory) {
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
    if (isActiveRun(run)) active.push({ run_id: run.run_id, status: run.status });
    else if (run.status !== "completed" || !CLOSED_REASONS.includes(run.closed_reason)) {
      throw new Error("Cannot confirm that no work is running: the run " + run.run_id + " (" + name + ") has a status this Bridge does not know: " + run.status + ".");
    }
  }
  return active;
}

function persistentOnly(files) {
  return files.filter(([name]) => !TRANSIENT_FILES.includes(name));
}

// `skip` leaves out a file an earlier Bridge added there (its /review-bridge command), which
// uninstall removes on purpose, together with the folders it made for it; so a folder that
// holds no other file counts as absent.
async function treeHash(root, skip = null) {
  if (!(await statOptional(root))) return null;
  const files = (await fileSnapshot(root)).filter(([name]) => name !== skip);
  return skip !== null && files.length === 0 ? null : sha256(JSON.stringify(files));
}

const COMMAND_IN_CLAUDE = AGENT_COMMAND_RELATIVE.slice(".claude/".length);

async function agentTreeHashes(root) {
  return { ".claude": await treeHash(path.join(root, ".claude"), COMMAND_IN_CLAUDE), ".codex": await treeHash(path.join(root, ".codex")) };
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
  const layout = await installLayout(root).catch(() => null);
  const manifestBytes = layout ? await fsp.readFile(installPath(layout, layout.manifest)).catch(() => null) : null;
  if (!manifestBytes) {
    throw new Error((await statOptional(privateRoot))
      ? NO_RECORD
      : "No Review Bridge installation here. If an earlier uninstall used --backup-root, run uninstall again with that --backup-root.");
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.schema_version !== 1 || manifest.layout !== "neutral") throw new Error("This is not a Review Bridge installation in the .review-bridge/ layout.");
  const files = (await installSnapshot(layout)).filter(([name]) => name !== MAINTENANCE_MARKER);
  const persistent = persistentOnly(files);
  const installed = new Set((manifest.installed_files || []).map(([name, hash]) => name + "\0" + hash));
  installed.add(layout.manifest + "\0" + sha256(manifestBytes));
  const userFiles = persistent.filter(([name, hash]) => !installed.has(name + "\0" + hash)).map(([name]) => name);
  const backupRoot = await resolveBackupRoot(root, backupRootOverride);
  const inUse = await anotherProjectInstalled(layout.stateRoot);
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
    // Where the install record is, for an uninstall resumed after the settings naming it are gone.
    state_root: layout.stateRoot,
    // What an earlier Bridge added to the project for agents, and whether each part is still as
    // written (an edited one stays).
    agent_files: manifest.agent_files || null,
    agent_files_state: await agentFilesState(root, manifest.agent_files || null),
    // What this uninstall does with the entries outside the project.
    agent_entries: await agentEntriesState({ inUse }),
    vscode_tasks: await vscodeTasksState(root, { inUse }),
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
  const remaining = await installSnapshot(await installLayout(root, { stateRoot: journal.state_root || null }));
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
    const outcome = await restartOutcome(context.restartService, context.root);
    restarted = outcome.running;
    if (!restarted) {
      // Codex 2026-10-14: the page service the human had running is not back; the cancel is not
      // done. The marker stays so the next uninstall offers the cancel again and retries.
      const incomplete = new Error("The cancel did not finish: the Bridge page service that was running " + didNotRestart(outcome) + ". Nothing was deleted; run uninstall again to finish the cancel.");
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
async function deleteChecked(layout, name, expected, context) {
  const file = installPath(layout, name);
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

// Every directory is listed first with a stack, each before the ones inside it; they are then
// tried deepest first, so a parent is only tried once its children are gone.
export async function removeEmptyDirectories(directory) {
  const directories = [];
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    directories.push(current);
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
    }
  }
  for (const current of directories.reverse()) {
    if ((await fsp.readdir(current)).length === 0) await fsp.rmdir(current);
  }
}

// M6 (a)-(e): runtime moved aside first, the marker deleted last, every file checked against the backup.
async function deleteInstall(context, known) {
  const privateRoot = path.join(context.root, privateName);
  const layout = await installLayout(context.root, { stateRoot: context.journal.state_root || null });
  const movedRelative = "tools/.uninstalling-" + context.journal.transaction_id;
  const moved = path.join(privateRoot, ...movedRelative.split("/"));
  if (await statOptional(path.join(privateRoot, ...RUNTIME_RELATIVE.split("/")))) {
    await fsp.rename(path.join(privateRoot, ...RUNTIME_RELATIVE.split("/")), moved);
  }
  await journalWrite(context, { step: "a_runtime_moved" });
  const files = await installSnapshot(layout);
  for (const [name] of files) {
    if (name === MAINTENANCE_MARKER || name.startsWith(movedRelative + "/")) continue;
    if (context.beforeDelete) await context.beforeDelete(name);
    await deleteChecked(layout, name, known.get(name), context);
  }
  await journalWrite(context, { step: "b_contents_deleted" });
  for (const [name] of files.filter(([entry]) => entry.startsWith(movedRelative + "/"))) {
    await deleteChecked(layout, name, known.get(originalName(name, context.journal.transaction_id)), context);
  }
  await journalWrite(context, { step: "c_runtime_deleted" });
  // Anything still here changed after its check or appeared during deletion, so it is not in the
  // backup: the marker and the journal stay, and the continue plan backs it up before deleting it.
  const appeared = (await installSnapshot(layout)).filter(([name]) => name !== MAINTENANCE_MARKER);
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
  const trees = await agentTreeHashes(context.root);
  for (const name of [".claude", ".codex"]) {
    if (trees[name] !== (context.journal.agent_trees?.[name] ?? null)) problems.push(name + "/ changed during uninstall");
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

// B3-B5: every installed file (under .review-bridge/, and the install record) copied out, listed with
// its hash, and read back.
async function backupTree(layout, backupDir, header, afterBackup) {
  const files = await installSnapshot(layout);
  for (const [name] of files) {
    const target = path.join(backupDir, "files", ...name.split("/"));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(installPath(layout, name), target);
  }
  const manifest = { schema_version: 1, ...header, created_at: new Date().toISOString(), files };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await writeDurable(path.join(backupDir, "backup-manifest.json"), bytes);
  if (afterBackup) await afterBackup(backupDir);
  await readBackupManifest({ backup_dir: backupDir, backup_manifest_sha256: sha256(bytes) });
  return { manifest, sha: sha256(bytes) };
}

async function backupInstall(context) {
  return await backupTree(await installLayout(context.root, { stateRoot: context.journal.state_root || null }), context.journal.backup_dir, {
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
      state_root: plan.state_root || null,
      agent_files: plan.agent_files || null, agent_trees: await agentTreeHashes(root),
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
      runs = await activeRuns(await installLayout(root));
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
    const now = persistentOnly(await installSnapshot(await installLayout(root)));
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
  const agentFiles = await undoAgentFiles(root, plan.agent_files || null);
  const inUse = await anotherProjectInstalled(plan.state_root);
  const agentEntries = await releaseAgentEntries({ inUse });
  const vscodeTasks = await releaseAllVscodeTasks(root, { inUse });
  await journalWrite(context, { step: "f_agent_files", agent_files_outcome: agentFiles, agent_entries_outcome: agentEntries, vscode_tasks_outcome: vscodeTasks });
  if (hooks.beforeVerify) await hooks.beforeVerify(context);
  await finishTransaction(context, exclusion);
  return {
    ok: true, operation: "uninstall", target: root, backup_dir: context.journal.backup_dir,
    file_count: backup.manifest.files.length, user_file_count: plan.user_file_count, exclusion, agent_files: agentFiles, agent_entries: agentEntries, vscode_tasks: vscodeTasks,
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
      await fsp.copyFile(installPath(await installLayout(root, { stateRoot: journal.state_root || null }), name), copy);
      if (sha256(await fsp.readFile(copy)) !== hash) throw new Error("The newer copy of " + original + " could not be verified; nothing more was deleted.");
      added.push([original, hash]);
      known.set(original, hash);
    }
    await journalWrite(context, { newer_backed_up: added, state: "deleting", deletion_started: true });
    await deleteInstall(context, known);
  }
  const exclusion = await restoreExclusion(journal.git_exclusion);
  await journalWrite(context, { step: "f_exclusion", exclusion });
  const agentFiles = await undoAgentFiles(root, journal.agent_files || null);
  const inUse = await anotherProjectInstalled(journal.state_root);
  const agentEntries = await releaseAgentEntries({ inUse });
  const vscodeTasks = await releaseAllVscodeTasks(root, { inUse });
  await journalWrite(context, { step: "f_agent_files", agent_files_outcome: agentFiles, agent_entries_outcome: agentEntries, vscode_tasks_outcome: vscodeTasks });
  await finishTransaction(context, exclusion);
  return { ok: true, operation: "uninstall", kind: plan.kind, target: root, backup_dir: journal.backup_dir, exclusion, agent_files: agentFiles, agent_entries: agentEntries, vscode_tasks: vscodeTasks };
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
// T0-10: upgrading a project's settings. Bridge itself is upgraded in its own folder through the
// install Guide; every project already runs that new runtime. What is left per project is its
// settings: bridge.json merged against the new defaults, the work template, authorizations bound to
// the old default policy, and the tools/ copy an older setup left in the project, which nothing uses
// any more. The maintenance marker inside the project is the whole record: it holds the backup
// location and, before each write or removal, what the upgrade is about to do, so an interrupted
// upgrade is undone from the marker and the backup alone (P2.12).
// ---------------------------------------------------------------------------------------------

const OWNER_EDITABLE_KEYS = Object.freeze(["roles", "watch", "retention", "locale", "test"]);
const PROTECTED_KEYS = Object.freeze(["requires_human_authorization", "readiness"]);
// The project's identity in the database: never replaced by an upgrade.
const IDENTITY_KEYS = Object.freeze(["project_id"]);
// Keys an earlier Bridge wrote and no longer uses; an upgrade removes them.
const RETIRED_KEYS = Object.freeze(["state_contract"]);
const RETIRED_ROLE_KEYS = Object.freeze(["separate_sessions"]);
// The work-order templates init copies and an upgrade keeps up to date: where each goes in the
// project, and the template in the package it comes from. TEMPLATE.md is the English one.
const TEMPLATES = Object.freeze([
  { relative: "work-packages/TEMPLATE.md", source: "work-package.md" },
  { relative: "work-packages/TEMPLATE.zh-TW.md", source: "work-package.zh-TW.md" },
]);
const templateSource = (template) => path.join(packageRoot, "project-templates", template.source);

async function shippedTemplateHashes() {
  const hashes = {};
  for (const template of TEMPLATES) hashes[template.relative] = sha256(await fsp.readFile(templateSource(template)));
  return hashes;
}

// One hash per template the install recorded. An install from before there were two recorded
// TEMPLATE.md's alone, as a string.
function recordedTemplateHashes(manifest) {
  const recorded = manifest.work_template_sha256;
  return typeof recorded === "string" ? { [TEMPLATES[0].relative]: recorded } : recorded || {};
}

function sameValue(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

// The version has one source, the package's package.json, which npm publishes; nothing else writes one.
async function runtimeVersion(runtimeRoot) {
  const manifest = await readJsonOptional(path.join(runtimeRoot, "..", "package.json")).catch(() => null);
  return typeof manifest?.version === "string" ? manifest.version : null;
}

async function policyIdentityOf(runtimeRoot) {
  return policyIdentity(JSON.parse(await fsp.readFile(path.join(runtimeRoot, "config", "default-policy.json"), "utf8")));
}

async function sourcePolicyIdentity() {
  return await policyIdentityOf(sourceRuntime);
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
  // The roles block is the person's except this one setting inside it.
  if (current.roles?.reviewer_readonly_required !== defaults.roles.reviewer_readonly_required) {
    throw new Error("The new version would change the protected bridge.json setting \"roles.reviewer_readonly_required\"; the upgrade keeps protected settings as they are and stops.");
  }
  const kept = (key) => OWNER_EDITABLE_KEYS.includes(key) || PROTECTED_KEYS.includes(key) || IDENTITY_KEYS.includes(key);
  const merged = {};
  for (const key of Object.keys(defaults)) merged[key] = kept(key) && Object.hasOwn(current, key) ? current[key] : defaults[key];
  for (const key of Object.keys(current)) if (!Object.hasOwn(merged, key) && !RETIRED_KEYS.includes(key)) merged[key] = current[key];
  const retiredRoleKeys = RETIRED_ROLE_KEYS.filter((key) => Object.hasOwn(merged.roles, key));
  if (retiredRoleKeys.length) merged.roles = Object.fromEntries(Object.entries(merged.roles).filter(([key]) => !retiredRoleKeys.includes(key)));
  return {
    merged,
    removed: [...Object.keys(current).filter((key) => RETIRED_KEYS.includes(key)), ...retiredRoleKeys.map((key) => "roles." + key)],
    added: Object.keys(defaults).filter((key) => !Object.hasOwn(current, key)),
    updated: Object.keys(defaults).filter((key) => Object.hasOwn(current, key) && !kept(key) && !sameValue(current[key], defaults[key])),
  };
}

async function defaultConfigFor(root, current) {
  // A project set up before project ids gets one; an existing one is kept (IDENTITY_KEYS).
  const roles = { writer: current.roles?.writer?.provider_id, reviewer: current.roles?.reviewer?.provider_id };
  return neutralBridgeConfig({ projectId: current.project_id || randomUUID(), profileId: current.profile_id, roles, profile: await resolveProfile(root, current.profile_id) });
}

// Where a new template goes when its installed one was edited: TEMPLATE.new.md beside TEMPLATE.md,
// TEMPLATE.zh-TW.new.md beside TEMPLATE.zh-TW.md. That name is reused only while it is absent,
// already the new template, or still exactly what an earlier upgrade wrote; one a human edited is
// never overwritten (Codex 2026-10-15). The fallback name carries a safe version string.
async function templateDestination(privateRoot, manifest, relative, templateNew, to) {
  const installed = new Map(manifest.installed_files || []);
  const free = async (candidate) => {
    const now = await hashOptional(inPrivate(privateRoot, candidate));
    return now === null || now === templateNew || now === installed.get(candidate);
  };
  const base = relative.slice(0, -".md".length);
  if (await free(base + ".new.md")) return base + ".new.md";
  const version = String(to.version || to.runtime_sha256.slice(0, 12)).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 60) || "next";
  const fallback = base + ".new." + version + ".md";
  if (await free(fallback)) return fallback;
  throw new Error("You edited both " + base + ".new.md and " + fallback + "; the upgrade will not overwrite either. Move one of them out of .review-bridge/work-packages/ and make a new plan.");
}

// What the upgrade does with each template: the same as the new one, nothing; missing, the new one
// is added; edited since it was installed, it is kept and the new one written beside it; otherwise
// it is replaced.
async function templatePlans(privateRoot, manifest, to) {
  const recorded = recordedTemplateHashes(manifest);
  const plans = {};
  for (const template of TEMPLATES) {
    const now = await hashOptional(inPrivate(privateRoot, template.relative));
    const templateNew = sha256(await fsp.readFile(templateSource(template)));
    const modified = now !== null && now !== recorded[template.relative];
    const action = now === templateNew ? "unchanged" : now === null ? "add" : modified ? "keep_and_write_new" : "replace";
    plans[template.relative] = {
      modified,
      action,
      new_sha256: templateNew,
      new_path: action === "keep_and_write_new" ? await templateDestination(privateRoot, manifest, template.relative, templateNew, to) : null,
    };
  }
  return plans;
}

// The tools/ copy an older setup put in the project: its files, relative to .review-bridge/.
async function legacyRuntimeFiles(privateRoot) {
  const legacy = inPrivate(privateRoot, RUNTIME_RELATIVE);
  if (!(await statOptional(legacy))) return [];
  return (await fileSnapshot(legacy)).map(([name, hash]) => [RUNTIME_RELATIVE + "/" + name, hash]);
}

// P1.1: the read-only upgrade plan; P1.2: the refusals that need no lock.
async function planFreshUpgrade(root, backupRootOverride) {
  const privateRoot = path.join(root, privateName);
  const layout = await installLayout(root).catch(() => null);
  const manifestBytes = layout ? await fsp.readFile(installPath(layout, layout.manifest)).catch(() => null) : null;
  if (!manifestBytes) {
    throw new Error((await statOptional(privateRoot))
      ? NO_RECORD
      : "No Review Bridge installation here; install it with init first.");
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.schema_version !== 1 || manifest.layout !== "neutral") throw new Error("This is not a Review Bridge installation in the .review-bridge/ layout.");
  try {
    await verifyNeutralInstall(root, { leftovers: true });
  } catch (error) {
    throw new Error("The installed Bridge does not verify, so it will not be upgraded: " + error.message);
  }
  const legacy = await legacyRuntimeFiles(privateRoot);
  const config = JSON.parse(await fsp.readFile(installPath(layout, layout.config), "utf8"));
  // Where the old files go is known once the project has an id; one set up before ids gets it now.
  const nestedId = layout.nested && config.project_id ? readProjectId(installPath(layout, layout.config)) : null;
  const known = nestedId ? { ...layout, stateRoot: projectStateRoot(nestedId), logRoot: projectLogRoot(nestedId) } : layout;
  const old = await legacyLayoutPlan(known, { nested: layout.nested });
  if (old.unknown.length) {
    throw new Error("Two old runs share the 8 characters these call logs carry, so the upgrade cannot tell whose they are: "
      + old.unknown.slice(0, 10).join(", ") + (old.unknown.length > 10 ? " and " + (old.unknown.length - 10) + " more" : "") + ".");
  }
  if (old.conflicts.length) {
    throw new Error("These old files would land on different files already in Bridge's folders, which the upgrade does not overwrite: " + old.conflicts.slice(0, 10).join(", ") + ".");
  }
  const leftovers = old.moves.length + old.drops.length + old.page_files.length;
  const from = { version: manifest.bridge_version ?? null, runtime_sha256: manifest.runtime_sha256 };
  const to = { version: await runtimeVersion(sourceRuntime), runtime_sha256: await runtimeFingerprint(sourceRuntime) };
  const agentEntries = await planAgentEntries();
  const agentFiles = manifest.agent_files?.command || manifest.agent_files?.agents ? manifest.agent_files : null;
  if (from.runtime_sha256 === to.runtime_sha256 && legacy.length === 0 && !layout.nested && leftovers === 0 && !agentFiles && !agentEntriesPending(agentEntries)) {
    return { up_to_date: true, target: root, version: to.version, runtime_sha256: to.runtime_sha256 };
  }
  const defaults = await defaultConfigFor(root, config);
  if (config.schema_version !== defaults.schema_version) {
    throw new Error("The new version uses another bridge.json schema (" + config.schema_version + " to "
      + defaults.schema_version + "); converting data across schemas is not supported.");
  }
  const merge = mergeBridgeConfig(config, defaults);
  const templates = await templatePlans(privateRoot, manifest, to);
  // The policy before is what these settings were last set up against; an older setup's tools/
  // copy carries it when the record does not.
  const policyFrom = manifest.policy_identity
    ?? (legacy.length ? await policyIdentityOf(inPrivate(privateRoot, RUNTIME_RELATIVE)).catch(() => null) : null);
  const policy = { from: policyFrom, to: await sourcePolicyIdentity() };
  const persistent = persistentOnly((await installSnapshot(layout)).filter(([name]) => name !== MAINTENANCE_MARKER));
  const installed = new Set((manifest.installed_files || []).map(([name, hash]) => name + "\0" + hash));
  installed.add(layout.manifest + "\0" + sha256(manifestBytes));
  const leaving = new Set([...old.moves, ...old.drops].map(([name]) => name));
  const userFiles = persistent.filter(([name, hash]) => !installed.has(name + "\0" + hash) && !name.startsWith(RUNTIME_RELATIVE + "/") && !leaving.has(name)).map(([name]) => name);
  const backupRoot = await resolveBackupRoot(root, backupRootOverride);
  return sealPlan({
    schema_version: 1,
    operation: "upgrade_neutral",
    kind: "upgrade",
    target: root,
    install_manifest_sha256: sha256(manifestBytes),
    from,
    to,
    legacy_runtime_sha256: legacy.length ? sha256(JSON.stringify(legacy)) : null,
    legacy_runtime_file_count: legacy.length,
    // Settings still in .review-bridge/review-bridge/ move up once, the install record to the state.
    layout_move: layout.nested,
    // The older setup's run state and logs leave the project, each file under its own name.
    legacy_files: { moved: old.moves.length, dropped: old.drops.length, page_files: old.page_files.length, sha256: old.sha256 },
    // The agent entries outside the project, and what an earlier Bridge wrote into it for agents.
    agent_entries: agentEntries,
    agent_files_state: await agentFilesState(root, agentFiles),
    persistent_sha256: sha256(JSON.stringify(persistent)),
    persistent_count: persistent.length,
    user_file_count: userFiles.length,
    user_files: userFiles.slice(0, 20),
    config_added_keys: merge.added,
    config_updated_keys: merge.updated,
    config_removed_keys: merge.removed,
    templates,
    policy_changed: policy.from !== null && !sameValue(policy.from, policy.to),
    policy,
    backup_root: backupRoot,
    backup_root_custom: Boolean(backupRootOverride),
    backup_parent: path.join(backupRoot, projectKey(await fsp.realpath(root))),
    service_running: await pageServiceRunning(root),
    // The older Bridge's page cannot be brought back by this one, so a rollback does not try.
    legacy_page_running: await legacyPageRunning(root),
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
  const markerBytes = await fsp.readFile(markerPath).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (markerBytes) {
    let marker = {};
    try { marker = JSON.parse(markerBytes.toString("utf8")) || {}; } catch {}
    if (marker.operation !== "upgrade" || !marker.plan) throw new Error(markerRefusal(marker));
    return await planResumeUpgrade(root, marker, markerBytes);
  }
  return await planFreshUpgrade(root, backupRoot);
}

// An upgrade cut off part way (the process killed, the machine off) is finished by running upgrade
// again, the way an interrupted uninstall is finished by running uninstall again. The marker holds the
// approved plan, the backup and every file already moved, so nothing is moved twice. Bridge itself
// must still be the version that upgrade started with.
async function planResumeUpgrade(root, marker, markerBytes) {
  if ((await runtimeFingerprint(sourceRuntime)) !== marker.to_runtime_sha256) {
    throw new Error("An interrupted Bridge upgrade is present and Bridge itself changed since it started; run upgrade --rollback first.");
  }
  if (marker.backup_dir) {
    try {
      await readBackupManifest(marker);
    } catch (error) {
      throw new Error("An interrupted Bridge upgrade is present, but its backup does not match it (" + error.message + "). Backup: " + marker.backup_dir);
    }
  }
  return sealPlan({
    schema_version: 1, operation: "upgrade_neutral", kind: "resume", target: root, marker_sha256: sha256(markerBytes),
    upgrade_id: marker.upgrade_id, from: marker.plan.from, to: marker.plan.to, backup_dir: marker.backup_dir || null, plan: marker.plan,
  });
}

async function markerSave(context) {
  await writeJsonDurable(context.markerPath, context.marker);
}

// The marker learns each version before it is written, so a rollback can tell the upgrade's own
// writes from a human's later edits (P2.11).
async function writeRecorded(context, relative, bytes) {
  context.marker.written[relative] = sha256(bytes);
  await markerSave(context);
  await writeDurable(installPath(context, relative), bytes);
}

// A file the upgrade takes away: named in the marker before it goes, so a rollback puts it back.
async function removeRecorded(context, relative) {
  if (!(context.marker.removed || []).includes(relative)) context.marker.removed = [...(context.marker.removed || []), relative];
  await markerSave(context);
  await fsp.rm(installPath(context, relative), { force: true });
}

// The nested layout's settings move up into .review-bridge/ and its install record into the
// service's state, each written there first and then removed here, all through the marker. A project
// set up before project ids gets its id now, since the state folder is named by it. A resumed upgrade
// skips what already moved: the id is the marker's, and a file no longer at its old place is done.
async function flattenLayout(context) {
  const nestedConfig = await readJsonOptional(inPrivate(context.privateRoot, NESTED_CONFIG));
  if (!context.marker.project_id) {
    const projectId = nestedConfig?.project_id || randomUUID();
    context.marker.project_id = projectId;
    context.marker.state_root = projectStateRoot(projectId);
    context.marker.log_root = projectLogRoot(projectId);
    await markerSave(context);
  }
  context.stateRoot = context.marker.state_root;
  context.logRoot = context.marker.log_root;
  for (const name of STATE_FOLDERS) await fsp.mkdir(path.join(context.stateRoot, name), { recursive: true });
  const renamed = new Map(NESTED_MOVES);
  for (const [from, to] of NESTED_MOVES) {
    const bytes = await fsp.readFile(inPrivate(context.privateRoot, from)).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (bytes === null) continue;
    const moved = to === CONFIG_RELATIVE && !nestedConfig.project_id
      ? Buffer.from(JSON.stringify({ ...nestedConfig, project_id: context.marker.project_id }, null, 2) + "\n", "utf8") : bytes;
    await writeRecorded(context, to, moved);
    await removeRecorded(context, from);
  }
  const record = await readJsonOptional(inPrivate(context.privateRoot, MANIFEST_RELATIVE));
  if (record) {
    record.installed_files = (record.installed_files || []).map(([name, hash]) => [renamed.get(name) || name, hash])
      .sort((left, right) => left[0].localeCompare(right[0]));
    await writeRecorded(context, STATE_MANIFEST, Buffer.from(JSON.stringify(record, null, 2) + "\n", "utf8"));
    await removeRecorded(context, MANIFEST_RELATIVE);
  }
  context.manifestName = STATE_MANIFEST;
}

// The older setup's run state and logs leave the project (RC3-FIX-02). The marker names every move and
// every file that goes before the first copy, so a rollback puts them back and a resumed upgrade moves
// nothing twice. Each copy is written whole (temporary file, flushed, renamed) and every copy is read
// back against its source's SHA-256 before any source goes.
async function moveLegacyFiles(context, plan) {
  if (!context.marker.legacy_moves) {
    const found = await legacyLayoutPlan({ privateRoot: context.privateRoot, stateRoot: context.stateRoot, logRoot: context.logRoot }, { nested: plan.layout_move });
    if (found.sha256 !== plan.legacy_files.sha256 || found.unknown.length || found.conflicts.length) {
      throw new Error("The old run files in .review-bridge/ changed after the plan was shown.");
    }
    context.marker.legacy_moves = found.moves;
    context.marker.legacy_drops = found.drops;
    // The backup holds files only; the old folders are named so a rollback makes the empty ones again.
    context.marker.legacy_folders = await legacyFolders(context.privateRoot);
    for (const [, to, sha] of found.moves) context.marker.written[to] = sha;
    context.marker.removed = [...new Set([...(context.marker.removed || []), ...found.moves.map(([from]) => from), ...found.drops.map(([from]) => from)])];
    await markerSave(context);
  }
  const { legacy_moves: moves, legacy_drops: drops } = context.marker;
  for (const [from, to, sha] of moves) {
    const target = installPath(context, to);
    if ((await hashOptional(target)) === sha) continue;
    const source = inPrivate(context.privateRoot, from);
    const bytes = await fsp.readFile(source).catch(() => null);
    if (!bytes || sha256(bytes) !== sha) throw new Error(".review-bridge/" + from + " changed or went before it was moved.");
    if (await statOptional(target)) throw new Error(to + " is already there with other content, and is not overwritten.");
    await writeDurable(target, bytes);
  }
  if (context.hooks.afterLegacyCopied) await context.hooks.afterLegacyCopied(context);
  for (const [from, to, sha] of moves) {
    if ((await hashOptional(installPath(context, to))) !== sha) throw new Error("The copy of .review-bridge/" + from + " does not match it (SHA-256).");
  }
  for (const [from] of [...moves, ...drops]) await fsp.rm(inPrivate(context.privateRoot, from), { force: true });
  for (const name of LEGACY_FOLDERS) {
    if (await statOptional(inPrivate(context.privateRoot, name))) await removeEmptyDirectories(inPrivate(context.privateRoot, name));
  }
  // The page's session and address are what a running page wrote, not records; the page is stopped.
  for (const name of LEGACY_PAGE_FILES) await fsp.rm(inPrivate(context.privateRoot, name), { force: true });
  return { moved: moves.length, dropped: drops.length };
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
  const outcome = await restartOutcome(context.hooks.restartService, context.root);
  if (!outcome.running) {
    throw new Error("The Bridge page service that was running " + didNotRestart(outcome) + ", so Bridge stays blocked for new work. Run: " + bridgeRunner() + " upgrade --rollback --target " + context.root);
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
  const manifest = JSON.parse(await fsp.readFile(installPath(context, context.manifestName), "utf8"));
  const configText = await fsp.readFile(inPrivate(privateRoot, CONFIG_RELATIVE), "utf8");
  const current = JSON.parse(configText);
  const merge = mergeBridgeConfig(current, await defaultConfigFor(context.root, current));
  // What the settings were before this upgrade wrote them, kept in the marker so a resumed upgrade
  // still knows.
  if (!context.marker.before) {
    const before = { [CONFIG_RELATIVE]: sha256(configText) };
    for (const template of TEMPLATES) before[template.relative] = await hashOptional(inPrivate(privateRoot, template.relative));
    context.marker.before = before;
    await markerSave(context);
  }
  context.before = context.marker.before;
  const text = JSON.stringify(merge.merged, null, 2) + "\n";
  if (text !== configText) await writeRecorded(context, CONFIG_RELATIVE, Buffer.from(text, "utf8"));
  const templates = {};
  for (const template of TEMPLATES) {
    const { action, new_path: newPath } = plan.templates[template.relative];
    const content = await fsp.readFile(templateSource(template));
    if (action === "replace" || action === "add") await writeRecorded(context, template.relative, content);
    if (action === "keep_and_write_new") await writeRecorded(context, newPath, content);
    templates[template.relative] = { action, new_path: newPath };
  }
  return { added: merge.added, templates };
}

// D5: unclaimed authorizations bound to the old default policy are invalidated and reported.
async function writeInvalidations(context) {
  if (context.marker.report) return context.marker.report;
  const paths = getBridgePaths(context.root, sourceRuntime, { privateRootName: privateName });
  const current = policyIdentity(JSON.parse(await fsp.readFile(paths.defaultPolicyPath, "utf8")));
  const { records, report } = await planUpgradeInvalidations(paths, current);
  // Service state, written there as the runtime writes it; a rollback of the settings leaves them, since
  // the new runtime is what runs either way.
  const json = (value) => JSON.stringify(value, null, 2) + "\n";
  for (const { authorization_id: id, record } of records) {
    const file = path.join(paths.authorizationInvalidationsDir, id + ".json");
    if (!(await statOptional(file))) await writeDurable(file, json(record));
  }
  await writeDurable(path.join(paths.upgradeReportsDir, report.report_id + ".json"), json(report));
  // A resumed upgrade reports this one again rather than write a second.
  context.marker.report = { report_id: report.report_id, invalidated_count: report.invalidated_count, invalidated_authorization_ids: report.invalidated_authorization_ids };
  await markerSave(context);
  return context.marker.report;
}

// The older setup's tools/ copy goes, after the backup holds it. The marker names every file before
// the first one is removed, so a rollback puts exactly those back.
async function removeLegacyRuntime(context, plan) {
  if (!plan.legacy_runtime_sha256) return 0;
  const files = await legacyRuntimeFiles(context.privateRoot);
  if (files.length === 0 && context.marker.legacy_runtime_removed) return context.marker.legacy_runtime_removed;
  if (sha256(JSON.stringify(files)) !== plan.legacy_runtime_sha256) throw new Error("The old tools/ copy changed after the plan was shown.");
  // Added to what the marker already names (settings and old run files moved before), never in place of it.
  context.marker.removed = [...new Set([...(context.marker.removed || []), ...files.map(([name]) => name)])];
  context.marker.legacy_runtime_removed = files.length;
  await markerSave(context);
  await fsp.rm(inPrivate(context.privateRoot, RUNTIME_RELATIVE), { recursive: true });
  const tools = inPrivate(context.privateRoot, "tools");
  if ((await fsp.readdir(tools).catch(() => null))?.length === 0) await fsp.rmdir(tools);
  return files.length;
}

async function writeUpgradeManifest(context, plan, report) {
  const manifest = JSON.parse(await fsp.readFile(installPath(context, context.manifestName), "utf8"));
  if ((manifest.upgrades || []).some((upgrade) => upgrade.upgrade_id === context.marker.upgrade_id)) return;
  const installed = new Map((manifest.installed_files || []).filter(([name]) => !name.startsWith(RUNTIME_RELATIVE + "/")));
  // A file Bridge wrote over its own unedited copy, or added, stays Bridge's; an edited one stays the
  // human's.
  for (const relative of [CONFIG_RELATIVE, ...TEMPLATES.map((template) => template.relative)]) {
    const written = context.marker.written[relative];
    if (written && (context.before[relative] === installed.get(relative) || context.before[relative] === null)) installed.set(relative, written);
  }
  for (const { new_path: newPath } of Object.values(plan.templates)) {
    if (newPath && context.marker.written[newPath]) installed.set(newPath, context.marker.written[newPath]);
  }
  // An older install's record still says who filled each role at init; bridge.json says who does now.
  const { roles: _rolesAtInit, ...recorded } = manifest;
  const next = {
    ...recorded,
    runtime_sha256: plan.to.runtime_sha256,
    work_template_sha256: Object.fromEntries(Object.entries(plan.templates).map(([relative, template]) => [relative, template.new_sha256])),
    bridge_version: plan.to.version,
    policy_identity: plan.policy.to,
    installed_files: [...installed].sort((left, right) => left[0].localeCompare(right[0])),
    upgrades: [...(manifest.upgrades || []), {
      upgrade_id: context.marker.upgrade_id, from: plan.from, to: plan.to, backup_dir: context.marker.backup_dir,
      report_id: report.report_id, invalidated_count: report.invalidated_count, upgraded_at: new Date().toISOString(),
    }],
  };
  await writeRecorded(context, context.manifestName, Buffer.from(JSON.stringify(next, null, 2) + "\n", "utf8"));
}

// P2.11 / P2.12: what undoing the upgrade means right now, from the marker and the backup. A file
// goes back when it is now what the upgrade wrote, or is gone because the upgrade wrote or removed
// it; a file the upgrade added and that is still its version goes; anything else may be a human's
// change and is kept.
async function upgradeRollbackActions(root, marker, backup) {
  const before = new Map(persistentOnly(backup.files));
  const now = new Map(persistentOnly(await installSnapshot(await installLayout(root, { stateRoot: marker.state_root || null }))));
  const written = marker.written || {};
  // The old run files the upgrade copied out of the project are asked one by one, where it put them.
  const folders = { privateRoot: path.join(root, privateName), stateRoot: marker.state_root || null, logRoot: marker.log_root || null };
  for (const name of Object.keys(written)) {
    if (now.has(name) || !(name.startsWith(STATE_PREFIX) || name.startsWith(LOG_PREFIX))) continue;
    const hash = await hashOptional(installPath(folders, name));
    if (hash !== null) now.set(name, hash);
  }
  const removed = new Set(marker.removed || []);
  const restore = [];
  const remove = [];
  const kept = [];
  for (const name of [...new Set([...before.keys(), ...now.keys()])].sort()) {
    const original = before.get(name);
    const current = now.get(name) ?? null;
    const ours = written[name] ?? null;
    if (original !== undefined) {
      if (current === original) continue;
      if (current === ours || (current === null && (ours !== null || removed.has(name)))) restore.push(name);
      else kept.push([name, current]);
    } else if (ours !== null && current === ours) remove.push(name);
    else if (current !== null) kept.push([name, current]);
  }
  return { restore, remove, kept };
}

// Codex 2026-10-15: the rollback deletes or replaces only what it can show is Bridge's at the moment
// it acts, not at the moment it planned. A file is first renamed to a private name next to it (one
// atomic step), and only then hashed: a match is Bridge's and goes; anything else is linked back
// under its own name, never over a file that appeared there meanwhile. What cannot be shown to be
// Bridge's is kept, and so is the maintenance marker.
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

function leftoverError(leftovers) {
  const error = new Error("The rollback will not delete or overwrite these, because it cannot show they are Bridge's: "
    + leftovers.slice(0, 10).join(", ") + (leftovers.length > 10 ? " and " + (leftovers.length - 10) + " more" : "")
    + ". The marker stays, so new work stays blocked. Move them out of .review-bridge/, then run upgrade --rollback again.");
  error.leftovers = leftovers;
  return error;
}

// P2.11 / P2.13: put the files back.
async function restoreUpgrade(context, actions, backup) {
  const { privateRoot, marker } = context;
  const leftovers = [];
  const original = new Map(backup.files);
  const kept = [...actions.kept];
  let restored = 0;
  let removed = 0;
  for (const name of actions.restore) {
    const file = installPath(context, name);
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
    if (!(current === ours || (current === null && (ours !== null || (marker.removed || []).includes(name))))) {
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
  for (const folder of marker.legacy_folders || []) await fsp.mkdir(inPrivate(privateRoot, folder), { recursive: true });
  if (context.hooks.afterFilesRestored) await context.hooks.afterFilesRestored(context);
  for (const name of actions.remove) {
    const file = installPath(context, name);
    const result = await deleteIfExpected(file, marker.written?.[name]);
    if (result.deleted) removed += 1;
    else if (result.kept === file) kept.push([name, result.hash]);
    else if (result.kept) leftovers.push(path.relative(privateRoot, result.kept).replaceAll("\\", "/"));
  }
  const restoredLayout = await installLayout(context.root, { stateRoot: marker.state_root || null });
  const manifest = JSON.parse(await fsp.readFile(installPath(restoredLayout, restoredLayout.manifest), "utf8"));
  if (manifest.runtime_sha256 !== marker.from_runtime_sha256) throw new Error("After the rollback the install record is not the one from before the upgrade.");
  if (leftovers.length) throw leftoverError(leftovers);
  return { restored, removed, kept };
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
      + "). Bridge stays blocked for new work. Run: " + bridgeRunner() + " upgrade --rollback --target " + context.root + ". The backup is in " + context.marker.backup_dir);
  }
  await fsp.rm(context.markerPath, { force: true });
  const failed = new Error("The upgrade failed and was rolled back; the project's settings are as before: " + error.message
    + (result.kept.length ? ". Left as they are, because they changed during the upgrade: " + result.kept.map(([name]) => name).join(", ") : ""));
  failed.rolledBack = result;
  throw failed;
}

// The steps of an upgrade that change nothing yet (P2.3-P2.6): the project is still what was approved,
// no work runs, the page is stopped, and a verified backup exists. A resumed upgrade that was cut off
// before its backup comes through here again; the page it stopped then may be down already.
async function prepareUpgrade(context, plan, layout, { resuming = false } = {}) {
  const { root, hooks } = context;
  try {
    if (hooks.afterMarker) await hooks.afterMarker(context);
    // P2.3
    const fresh = await planFreshUpgrade(root, plan.backup_root_custom ? plan.backup_root : null).catch((error) => ({ error }));
    const same = fresh.plan_sha256 === plan.plan_sha256
      || (resuming && !fresh.error && sealPlan({ ...fresh, service_running: plan.service_running, legacy_page_running: plan.legacy_page_running }).plan_sha256 === plan.plan_sha256);
    if (!same) {
      throw refusal("The project changed after the plan was shown; make a new plan." + (fresh.error ? " (" + fresh.error.message + ")" : ""));
    }
    // P2.4: runs are checked only now that the marker blocks new ones.
    const runs = await activeRuns(layout).catch((error) => { throw refusal(error.message); });
    if (runs.length) throw refusal("Work is still running: " + runs.map((run) => run.run_id + " (" + run.status + ")").join(", ") + ". Stop it or let it finish first.");
    // P2.5
    if (plan.service_running) {
      context.serviceStopAttempted = true;
      if (!(await (hooks.stopService || stopPageService)(root))) throw refusal("The Bridge page service did not stop.");
    }
    if (hooks.afterServiceStop) await hooks.afterServiceStop(context);
    // P2.6 / B6: a verified backup, and the originals still what was approved and backed up.
    const id = context.marker.upgrade_id;
    const project = await fsp.realpath(root);
    const backupDir = path.join(plan.backup_root, projectKey(project), new Date().toISOString().replace(/[:.]/g, "-") + "-upgrade-" + id.slice(0, 8));
    const backup = await backupTree(layout, backupDir, {
      project, operation: "upgrade", transaction_id: id, install_manifest_sha256: plan.install_manifest_sha256,
    }, hooks.afterBackup).catch((error) => { throw refusal("The backup could not be verified; nothing was changed: " + error.message); });
    const now = persistentOnly(await installSnapshot(layout));
    const known = new Map(backup.manifest.files);
    const changed = now.find(([name, hash]) => known.get(name) !== hash);
    if (sha256(JSON.stringify(now)) !== plan.persistent_sha256 || changed) {
      throw refusal("A file changed after the backup: " + (changed ? changed[0] : "(set of files)") + ". Nothing was changed; make a new plan.");
    }
    if ((await runtimeFingerprint(sourceRuntime)) !== plan.to.runtime_sha256) throw refusal("The Bridge folder changed after the plan was shown; make a new plan.");
    context.marker.backup_dir = backupDir;
    context.marker.backup_manifest_sha256 = backup.sha;
    await markerSave(context);
  } catch (error) {
    await releaseBeforeChange(context, error);
  }
}

// What `status` reads, read once through the same code: the person's database opens, this project's
// runs are listed, its log folder is named. An upgrade counts as done only after this answers; like
// `helm upgrade --atomic`, one that does not come up healthy is rolled back, and the step is named.
const HEALTH_STEPS = Object.freeze({
  database: "the database did not open",
  runs: "this project's runs could not be listed",
  logs: "the project's log folder could not be named",
});

async function statusHealth(root) {
  const { statusRecords } = await import(pathToFileURL(path.join(sourceRuntime, "features", "workOrder", "commands.mjs")).href);
  // The database's one pool for this process stays open, as every command leaves it (database/index.mjs).
  try {
    await statusRecords(getBridgePaths(root, sourceRuntime, { privateRootName: privateName }));
  } catch (error) {
    throw new Error("The check after the upgrade failed: " + (HEALTH_STEPS[error.status_step] || "status failed") + " (" + error.message + ").");
  }
}

// What an earlier Bridge wrote into the project for agents goes once the upgrade stands, and with the
// entries outside the project already in place (OpenSpec retires its old Codex prompts the same way:
// only after the replacement exists). A rollback therefore leaves those files as they were. The record
// goes with them, an edited part included: it is the person's now and is reported once. Cut off before
// this, the record stays and the next upgrade does it.
async function reclaimAgentFiles(context) {
  const file = installPath(context, context.manifestName);
  const { agent_files: record, ...rest } = JSON.parse(await fsp.readFile(file, "utf8"));
  if (record === undefined) return null;
  const outcome = await undoAgentFiles(context.root, record);
  await writeJsonDurable(file, rest);
  return outcome;
}

// P2.7-P2.12: the changes, every one of which a resumed upgrade can run again: what already moved is
// not moved twice, a report already written is reused, an upgrade already in the record is not added.
// Any failure, the check after the upgrade included, puts the project back as it was.
async function applyUpgradeChanges(context, plan) {
  const { root, hooks } = context;
  let settings;
  let report;
  let moved = { moved: 0, dropped: 0 };
  let legacyRemoved = 0;
  try {
    if (hooks.afterBackupVerified) await hooks.afterBackupVerified(context);
    if (plan.layout_move) await flattenLayout(context);
    moved = await moveLegacyFiles(context, plan);
    // P2.9
    settings = await mergeSettings(context, plan);
    if (hooks.afterConfig) await hooks.afterConfig(context);
    // P2.10
    report = await writeInvalidations(context);
    legacyRemoved = await removeLegacyRuntime(context, plan);
    if (hooks.afterLegacyRemoved) await hooks.afterLegacyRemoved(context);
    await writeAgentEntries();
    await writeUpgradeManifest(context, plan, report);
    if (hooks.beforeVerify) await hooks.beforeVerify(context);
    await verifyNeutralInstall(root);
    await (hooks.healthCheck || statusHealth)(root);
  } catch (error) {
    await rollbackAfterFailure(context, error);
  }
  await fsp.rm(context.markerPath, { force: true });
  const warnings = [];
  let agentFiles = null;
  try {
    agentFiles = await reclaimAgentFiles(context);
  } catch (error) {
    warnings.push("What an earlier Bridge wrote into this project for agents could not be taken back (" + error.message + "); run upgrade again.");
  }
  let restarted = false;
  if (plan.service_running) {
    const outcome = await restartOutcome(hooks.restartService, root);
    restarted = outcome.running;
    if (!restarted) warnings.push("The Bridge page service " + didNotRestart(outcome) + "; start it with up.");
  }
  return {
    ok: true, operation: "upgrade", target: root, from: plan.from, to: plan.to, backup_dir: context.marker.backup_dir,
    kept_user_file_count: plan.user_file_count, config_added_keys: settings.added, templates: settings.templates,
    legacy_runtime_removed: legacyRemoved, legacy_files_moved: moved.moved, legacy_files_dropped: moved.dropped,
    agent_entries: plan.agent_entries, agent_files: agentFiles,
    invalidated_count: report.invalidated_count, invalidated_authorization_ids: report.invalidated_authorization_ids,
    service_restarted: restarted, reviewer_readonly: "not_run", warnings,
  };
}

async function applyUpgradeLocked(plan, hooks) {
  const root = plan.target;
  const privateRoot = path.join(root, privateName);
  const markerPath = inPrivate(privateRoot, MAINTENANCE_MARKER);
  const layout = await installLayout(root);
  const context = {
    root, privateRoot, stateRoot: layout.stateRoot, logRoot: layout.logRoot, manifestName: layout.manifest, markerPath, hooks, serviceStopAttempted: false, before: {},
    marker: {
      schema_version: 4, upgrade_id: randomUUID(), operation: "upgrade", started_at: new Date().toISOString(),
      from_version: plan.from.version, to_version: plan.to.version,
      from_runtime_sha256: plan.from.runtime_sha256, to_runtime_sha256: plan.to.runtime_sha256,
      // A rollback starts again only the page this Bridge runs; the older Bridge's page cannot come back.
      service_was_running: plan.service_running && !plan.legacy_page_running, backup_dir: null, backup_manifest_sha256: null, written: {}, removed: [],
      state_root: layout.stateRoot, log_root: layout.logRoot,
      // The approved plan, so that running upgrade again after an interruption finishes this one.
      plan,
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
  await prepareUpgrade(context, plan, layout);
  return await applyUpgradeChanges(context, plan);
}

// The interrupted upgrade, finished from its marker under the plan it approved.
async function resumeUpgradeLocked(plan, hooks) {
  const root = plan.target;
  const privateRoot = path.join(root, privateName);
  const markerPath = inPrivate(privateRoot, MAINTENANCE_MARKER);
  const marker = JSON.parse(await fsp.readFile(markerPath, "utf8"));
  const approved = marker.plan;
  const layout = await installLayout(root, { stateRoot: marker.state_root || null });
  const context = {
    root, privateRoot, stateRoot: marker.state_root || layout.stateRoot, logRoot: marker.log_root || layout.logRoot,
    // The record is still beside the nested settings until the move took it to the state folder.
    manifestName: (await statOptional(inPrivate(privateRoot, MANIFEST_RELATIVE))) ? MANIFEST_RELATIVE : STATE_MANIFEST,
    markerPath, hooks, serviceStopAttempted: approved.service_running === true, before: marker.before || {}, marker,
  };
  // Cut off before its backup: nothing was changed, so the steps before any change run again.
  if (!marker.backup_dir) await prepareUpgrade(context, approved, await installLayout(root), { resuming: true });
  return await applyUpgradeChanges(context, approved);
}

// P1.4 / P2.1: approval binds the exact plan; it is rebuilt under the install lock before acting.
export async function applyNeutralUpgrade(plan, approval, hooks = {}) {
  if (plan?.operation !== "upgrade_neutral") throw new Error("Not an upgrade plan.");
  if (sealPlan(plan).plan_sha256 !== plan.plan_sha256 || approval !== plan.plan_sha256) throw new Error("Upgrade plan approval is invalid.");
  return await withInstallLock(plan.target, async () => {
    if (hooks.afterLock) await hooks.afterLock();
    if (plan.kind === "resume") {
      const current = await planNeutralUpgrade({ target: plan.target });
      if (current.plan_sha256 !== plan.plan_sha256) throw new Error("The interrupted upgrade changed after the plan was shown; make a new plan.");
      return await resumeUpgradeLocked(plan, hooks);
    }
    if (await statOptional(path.join(plan.target, privateName, MAINTENANCE_MARKER))) throw new Error("Another Bridge maintenance is in progress here.");
    return await applyUpgradeLocked(plan, hooks);
  });
}

// P2.12: the plan for an interrupted upgrade. It never reads the install manifest's verdict; only
// the marker and the backup it names.
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
  // Interrupted before the backup was recorded: the settings were never touched.
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
    const context = { root: plan.target, privateRoot, stateRoot: marker.state_root || null, logRoot: marker.log_root || null, markerPath, marker, hooks };
    let result = { restored: 0, removed: 0, kept: [] };
    if (plan.kind === "restore") result = await restoreUpgrade(context, plan, await readBackupManifest(marker));
    let restarted = false;
    if (plan.restart_service) {
      const outcome = await restartOutcome(hooks.restartService, plan.target);
      restarted = outcome.running;
      if (!restarted) {
        throw new Error("The rollback " + (plan.kind === "restore" ? "restored the files" : "changed nothing")
          + ", but the Bridge page service that was running " + didNotRestart(outcome) + "; the marker stays. Run upgrade --rollback again.");
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
const AGENT_FILE_NAMES = Object.freeze({ command: AGENT_COMMAND_RELATIVE, agents: "AGENTS.md 那一段" });
const agentEntryPaths = (entries, ...actions) => (entries || []).filter((entry) => actions.includes(entry.action)).map((entry) => entry.path).join("、");

// The lines about the agent entries and the project files an earlier Bridge wrote: `taken` and `kept`
// name those project files, each already worded for before or after the upgrade.
function agentLines(entries, verb, taken, kept) {
  const moved = agentEntryPaths(entries, "add", "replace");
  const own = agentEntryPaths(entries, "keep");
  return [
    ...(moved || taken.length ? [[moved ? "/review-bridge " + verb + "裝在使用者層級：" + moved : "", taken.length ? "舊版寫進專案的 " + taken.join("、") + verb + "收回" : ""].filter(Boolean).join("；")] : []),
    ...(own ? [own + " 是你自己的檔，不動"] : []),
    ...(kept.length ? ["舊版寫進專案的 " + kept.join("、") + " 你改過，留著不動；Bridge 已不用它，要不要留由你決定"] : []),
  ];
}

export function formatUpgradePlan(plan) {
  if (plan.kind === "resume") {
    return [
      "上一次升級在中途中斷，這次從中斷的地方接著做完：" + plan.target,
      versionText(plan.from) + " → " + versionText(plan.to),
      "已經搬好的檔不會再搬一次" + (plan.backup_dir ? "；備份在 " + plan.backup_dir : ""),
    ].join("\n") + "\n";
  }
  const templates = Object.entries(plan.templates).map(([relative, template]) => {
    const name = path.posix.basename(relative);
    return {
      replace: name + "：你沒改過，換成新版。",
      add: name + "：還沒有，加上新版。",
      keep_and_write_new: name + "：你改過，保留不動；新版另存成 " + path.posix.basename(template.new_path || "") + "。",
      unchanged: name + "：與新版相同，不動。",
    }[template.action];
  });
  return [
    "升級這個專案的 Bridge 設定：" + plan.target,
    versionText(plan.from) + " → " + versionText(plan.to),
    ...(plan.legacy_runtime_file_count ? ["會拿掉舊版留在專案裡的 tools/（" + plan.legacy_runtime_file_count + " 個檔，已經不用）"] : []),
    ...(plan.layout_move ? ["會把設定從 .review-bridge/review-bridge/ 搬到 .review-bridge/ 第一層（bridge.json、policy.override.json、rules.md），安裝紀錄搬到資料夾外的 Bridge 狀態目錄"] : []),
    ...(plan.legacy_files?.moved ? ["會把舊版留在專案裡的執行紀錄搬出專案：" + plan.legacy_files.moved + " 個檔搬到 Bridge 的狀態目錄與 log 目錄，名字不變，搬完逐檔核對 SHA-256"] : []),
    ...(plan.legacy_files?.dropped ? ["對不到任何 run 的舊呼叫紀錄、plan 與授權卡 " + plan.legacy_files.dropped + " 個，那些 run 已過保留期，會刪掉"] : []),
    ...agentLines(plan.agent_entries, "會",
      Object.entries(plan.agent_files_state || {}).filter(([, part]) => part.unchanged).map(([name]) => AGENT_FILE_NAMES[name]),
      Object.entries(plan.agent_files_state || {}).filter(([, part]) => !part.unchanged).map(([name]) => AGENT_FILE_NAMES[name])),
    ...(plan.config_added_keys.length ? ["bridge.json 會補上新設定：" + plan.config_added_keys.join("、")] : []),
    ...(plan.config_updated_keys.length ? ["bridge.json 會更新 Bridge 自己的設定：" + plan.config_updated_keys.join("、")] : []),
    ...(plan.config_removed_keys.length ? ["bridge.json 會移除 Bridge 不再使用的設定：" + plan.config_removed_keys.join("、")] : []),
    ...templates,
    ...(plan.policy_changed ? ["新版的預設 policy 不同：升級後未開始的授權會失效，需重新建 plan。"] : []),
    ...(plan.service_running ? ["會先停掉網頁服務，升級後再啟動。"] : []),
    "整份先備份到專案外，核對後才改：" + plan.backup_parent,
    PROOF_LOSS_LINE,
  ].join("\n") + "\n";
}

export function formatUpgradeResult(result) {
  if (result.up_to_date) return "已是這一版（" + (result.version || "未標版本") + "），沒有動任何檔。\n";
  return [
    "這個專案的設定已升級到 " + (result.to.version || "未標版本") + "（" + result.to.runtime_sha256.slice(0, 8) + "）",
    "備份在 " + result.backup_dir,
    ...(result.legacy_runtime_removed ? ["拿掉了舊的 tools/（" + result.legacy_runtime_removed + " 個檔）"] : []),
    ...(result.legacy_files_moved ? ["舊的執行紀錄搬出專案 " + result.legacy_files_moved + " 個檔" + (result.legacy_files_dropped ? "，刪掉對不到 run 的 " + result.legacy_files_dropped + " 個" : "")] : []),
    ...agentLines(result.agent_entries, "已",
      Object.entries(result.agent_files || {}).filter(([, outcome]) => outcome === "removed").map(([name]) => AGENT_FILE_NAMES[name]),
      Object.entries(result.agent_files || {}).filter(([, outcome]) => outcome === "kept_changed").map(([name]) => AGENT_FILE_NAMES[name])),
    ...(result.invalidated_count ? ["失效的授權 " + result.invalidated_count + " 個；要做那些工作得重新建 plan"] : []),
    ...Object.entries(result.templates).filter(([, template]) => template.action === "keep_and_write_new")
      .map(([relative, template]) => path.posix.basename(relative) + " 你改過，保留了；新版在 " + path.posix.basename(template.new_path)),
    PROOF_REDO_LINE,
    ...result.warnings.map((warning) => "警告：" + warning),
  ].join("\n") + "\n";
}

export function formatUpgradeRollbackPlan(plan) {
  if (plan.kind === "release") {
    return [
      "上一次升級在備份之前中斷，設定都沒動。",
      "這次會：拿掉維護標記" + (plan.restart_service ? "、重新啟動網頁服務" : "") + "。",
    ].join("\n") + "\n";
  }
  const list = (items) => items.slice(0, 20).map((item) => "  " + (Array.isArray(item) ? item[0] : item));
  return [
    "上一次升級中斷，要退回升級前（" + (plan.from.version || "未標版本") + "）。",
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
