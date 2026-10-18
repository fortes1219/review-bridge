// The work proof (RC3-BLOCKER-00). With Git, the start of a run is recorded as its commit, its
// branch and the content hashes of what was already changed; at each hand-off the changes since
// that start are read back from Git and hashed. Nothing is copied and the project is never walked
// as a whole. Without Git there is no work proof and the scope is not checked (Owner 2026-10-17).
//
// Who writes the evidence, and what it is checked against:
// - baseline.json: written once by the run's controller when the work is authorized. Its hash is
//   kept on the run record and, for the life of the controller, in memory (`sealed`).
// - windows/*.json: written by a run's own controller after each writer or Gate A call, never by
//   anyone else. The controller keeps each file's hash in memory; before a delta is used, its own
//   window files on disk must be exactly the sealed ones, unchanged.
// - Another run's windows are written by that run's controller; this controller cannot seal them,
//   and a run record on disk is no proof that they are genuine. They are therefore used only to
//   raise doubt: they can stop a change from counting as this run's, never clear one. An
//   out-of-scope change in doubt is reported as unverified, and an unverified scope is never
//   delivered as passed (writer loop); no other run is named as its author.
// - The stop command writes the run record and its events at any time; those are not evidence.
// Limit: models run as the same user and can write the same folder. The hashes show that a sealed
// record changed while this controller ran; they cannot prevent the change, cannot cover a record
// another controller wrote, and a delivery made by another process can check the baseline only
// against the run record, which shares that limit.
//
// Attribution: a change counts as the run's own only when its last observed change happened during
// one of the run's own calls, no other run's call overlapped that call, no later call changed it,
// and the file still holds what that call left. A window shows that a change was observed during a
// call; it does not prove who wrote it. Anything else is unattributed, and an unattributed change
// outside the scope is reported as unverified instead of being blamed on the run.
import fsp from "node:fs/promises";
import path from "node:path";

import { assertUnder } from "../../utils/pathGuard.mjs";
import { digest } from "../../utils/digest.mjs";
import { PRIVATE_ROOT_NAME } from "../../utils/paths.mjs";
import { ensureDir, listJson, readJson, writeJsonAtomic } from "../../service/index.mjs";
import {
  committedSha256,
  commitsBetween,
  currentBranch,
  EMPTY_TREE,
  fileSha256,
  headCommit,
  ignoredMatching,
  isAncestor,
  isGitWorkTree,
  trackedChangesSince,
  untrackedFiles,
} from "./gitWorkspace.mjs";

// The controller's own state is never workspace evidence. It lives only under the neutral
// private root; a provider folder such as `.claude/` is the project's, so changes there count.
const excludedControllerPaths = [
  "review-queue",
  "reviews",
  "tools/review-bridge",
  "work-packages",
  "archive",
  "review-bridge/policy-snapshots",
  "review-bridge-install.json",
].map((entry) => PRIVATE_ROOT_NAME + "/" + entry);

export class EvidenceChangedError extends Error {
  constructor(reason) {
    super("The work-proof records changed: " + reason + ".");
    this.name = "EvidenceChangedError";
  }
}

function normalizeRelative(value) {
  return path.posix.normalize(String(value).replaceAll("\\", "/")).replace(/^\.\//, "").replace(/\/$/, "");
}

function isExcluded(relative) {
  const candidate = normalizeRelative(relative);
  return excludedControllerPaths.some((entry) => candidate === entry || candidate.startsWith(entry + "/"));
}

export function matchesAllowedPath(relative, allowedPaths) {
  const candidate = normalizeRelative(relative);
  return allowedPaths.some((entry) => {
    if (entry === "**") return true;
    const allowed = normalizeRelative(entry);
    return candidate === allowed || candidate.startsWith(allowed + "/");
  });
}

// Glob subset for the fixed forbidden list (T0-03 C2.1): "**/" any depth, "**" any run,
// "*" within one segment, "?" one character. A pattern without "/" matches a file name at any depth.
function globToRegExp(pattern) {
  let out = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") { out += "(?:.*/)?"; index += 2; } else { out += ".*"; index += 1; }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/, "\\$&");
    }
  }
  return new RegExp("^" + (pattern.includes("/") ? "" : "(?:.*/)?") + out + "$");
}

export function matchesForbiddenPath(relative, forbiddenPaths) {
  const candidate = normalizeRelative(relative);
  return (forbiddenPaths || []).some((pattern) => globToRegExp(pattern).test(candidate));
}

// Forbidden files Git ignores (.env, .claude/, a deep node_modules/a/x.pem) are watched by hash;
// Git finds them, Bridge never walks an ignored folder. A failed Git call stops the evidence.
function ignoredForbiddenFiles(repoRoot, forbiddenPaths) {
  const found = ignoredMatching(repoRoot, forbiddenPaths || []);
  if (found === null) throw new Error("Git could not list the ignored files the forbidden list covers.");
  return found.map(normalizeRelative).filter((entry) => !isExcluded(entry));
}

// Content hash of every path Git says differs from the run's start, plus untracked files, plus
// watched ignored files, plus whatever was already changed when the run started.
async function stateSinceStart(repoRoot, start) {
  const tracked = trackedChangesSince(repoRoot, start.start_commit);
  const untracked = untrackedFiles(repoRoot);
  if (tracked === null || untracked === null) throw new Error("Git could not list the changes since the run started.");
  const ignored = ignoredForbiddenFiles(repoRoot, start.forbidden_paths);
  const candidates = new Set([...tracked, ...untracked, ...ignored, ...Object.keys(start.dirty)].map(normalizeRelative).filter((entry) => !isExcluded(entry)));
  const state = {};
  for (const relative of [...candidates].sort()) state[relative] = await fileSha256(repoRoot, relative);
  return state;
}

// What a path held when the run started: its recorded hash if it was already changed, otherwise
// its content in the start commit (null when it did not exist there).
function startSha256(repoRoot, start, relative) {
  return relative in start.dirty ? start.dirty[relative] : committedSha256(repoRoot, start.start_commit, relative);
}

function evidenceDirFor(paths, planSha256) {
  const evidenceId = String(planSha256).slice(0, 32);
  return { evidenceId, evidenceDir: assertUnder(path.join(paths.evidenceRoot, evidenceId), paths.evidenceRoot, "Evidence directory") };
}

export async function createWorkspaceBaseline({ paths, planSha256, runId = null, allowedPaths, forbiddenPaths = [] }) {
  const { evidenceId, evidenceDir } = evidenceDirFor(paths, planSha256);
  await fsp.rm(evidenceDir, { recursive: true, force: true });
  await ensureDir(path.join(evidenceDir, "windows"));
  const common = {
    schema_version: 2, evidence_id: evidenceId, run_id: runId, created_at: new Date().toISOString(),
    repo_root: paths.repoRoot, allowed_paths: allowedPaths, forbidden_paths: forbiddenPaths,
  };
  let record;
  if (!isGitWorkTree(paths.repoRoot)) {
    record = { ...common, mode: "none" };
  } else {
    const head = headCommit(paths.repoRoot);
    const start = { start_commit: head || EMPTY_TREE, forbidden_paths: forbiddenPaths, dirty: {} };
    // Already changed when the run started: recorded by hash, never added to Git (Owner 2026-10-17).
    start.dirty = await stateSinceStart(paths.repoRoot, start);
    record = { ...common, mode: "git", start_head: head, start_commit: start.start_commit, start_branch: currentBranch(paths.repoRoot), dirty: start.dirty };
  }
  const baselinePath = path.join(evidenceDir, "baseline.json");
  await writeJsonAtomic(baselinePath, record);
  return { mode: record.mode, evidence_id: evidenceId, evidence_dir: evidenceDir, baseline_path: baselinePath, baseline_sha256: digest(record) };
}

async function readBaseline(paths, baselinePath) {
  const baselineFile = assertUnder(path.resolve(baselinePath), paths.evidenceRoot, "Baseline path");
  return { baselineFile, baseline: await readJson(baselineFile) };
}

// The seal a controller keeps in memory for its own run: the baseline hash it started from and
// the hash of every window file it wrote. Records on disk are checked against it before use.
export function sealEvidence(baselineSha256) {
  return { baseline_sha256: baselineSha256 || null, windows: new Map() };
}

export async function verifySealedEvidence(paths, baselinePath, sealed) {
  const { baselineFile, baseline } = await readBaseline(paths, baselinePath);
  if (!sealed?.baseline_sha256 || digest(baseline) !== sealed.baseline_sha256) throw new EvidenceChangedError("the run's starting record");
  const windowsDir = path.join(path.dirname(baselineFile), "windows");
  const onDisk = new Map();
  for (const file of await listJson(windowsDir).catch(() => [])) onDisk.set(path.resolve(file), digest(await readJson(file).catch(() => null)));
  if (onDisk.size !== sealed.windows.size) throw new EvidenceChangedError("a call record was added or removed");
  for (const [file, sha256] of sealed.windows) {
    if (onDisk.get(path.resolve(file)) !== sha256) throw new EvidenceChangedError("a call record was rewritten");
  }
  return baseline;
}

// The start is valid while its commit is still in the current history on the same branch. A
// rewrite (rebase, amend, reset) or a branch switch leaves nothing sound to compare against.
export async function startPointStatus(paths, baselinePath) {
  const { baseline } = await readBaseline(paths, baselinePath);
  if (baseline.mode !== "git") return "unknown";
  if (currentBranch(paths.repoRoot) !== baseline.start_branch) return "lost";
  if (baseline.start_head && !isAncestor(paths.repoRoot, baseline.start_head)) return "lost";
  return "ok";
}

// Taken before and after each writer or Gate A call, so a change can be tied to the call it
// happened in. Without Git there is nothing to take.
export async function snapshotWorkspace(paths, baselinePath) {
  const { baseline } = await readBaseline(paths, baselinePath);
  if (baseline.mode !== "git") return null;
  return { at: new Date().toISOString(), state: await stateSinceStart(paths.repoRoot, baseline) };
}

// One call's record: each path that changed during the call, with the content it held at the end.
// The returned hash goes into the controller's seal.
export async function recordWindow(paths, baselinePath, { runId, call, phase, before }) {
  if (!before) return null;
  const { baselineFile, baseline } = await readBaseline(paths, baselinePath);
  const after = await snapshotWorkspace(paths, baselinePath);
  const keys = new Set([...Object.keys(before.state), ...Object.keys(after.state)]);
  const valueIn = (snapshot, key) => (key in snapshot.state ? snapshot.state[key] : startSha256(paths.repoRoot, baseline, key));
  const changed = [...keys].filter((key) => valueIn(before, key) !== valueIn(after, key)).sort()
    .map((key) => ({ path: key, after_sha256: valueIn(after, key) }));
  const window = { run_id: runId, call, phase, started_at: before.at, ended_at: after.at, changed };
  const file = path.join(path.dirname(baselineFile), "windows", call + "-" + phase + "-" + Date.now() + ".json");
  await writeJsonAtomic(file, window);
  return { file, sha256: digest(window), window };
}

// Own windows come from the seal when there is one. Every other window, genuine or not, is kept
// as a possible overlap: it can only turn "the run's" into "in doubt".
async function windowsFor(paths, runId, sealed) {
  const windows = [];
  const dirs = await fsp.readdir(paths.evidenceRoot, { withFileTypes: true }).catch(() => []);
  for (const dir of dirs.filter((entry) => entry.isDirectory())) {
    for (const file of await listJson(path.join(paths.evidenceRoot, dir.name, "windows")).catch(() => [])) {
      const window = await readJson(file).catch(() => null);
      if (!window || !Array.isArray(window.changed)) continue;
      if (window.run_id !== runId || !sealed || sealed.windows.has(path.resolve(file))) windows.push(window);
    }
  }
  return windows;
}

const overlaps = (a, b) => Date.parse(a.started_at) <= Date.parse(b.ended_at) && Date.parse(b.started_at) <= Date.parse(a.ended_at);
const changeIn = (window, relative) => window.changed.find((entry) => entry.path === relative) || null;

function attributionOf(relative, runId, windows, currentSha256) {
  const touching = windows.filter((window) => changeIn(window, relative)).sort((a, b) => Date.parse(a.ended_at) - Date.parse(b.ended_at));
  const last = touching.at(-1);
  if (!last || last.run_id !== runId) return "unattributed";
  // Two runs' calls overlapping the last change: both observed it, neither can claim it.
  if (windows.some((window) => window.run_id !== runId && overlaps(window, last))) return "unattributed";
  // Changed again after that call (a human, a commit between calls): not what the run left.
  return changeIn(last, relative).after_sha256 === currentSha256 ? "run" : "unattributed";
}

export async function createWorkspaceDelta({ paths, baselinePath, deltaId = "current", sealed = null }) {
  const { baselineFile } = await readBaseline(paths, baselinePath);
  const baseline = sealed ? await verifySealedEvidence(paths, baselineFile, sealed) : (await readBaseline(paths, baselineFile)).baseline;
  const base = {
    schema_version: 2, mode: baseline.mode, evidence_id: baseline.evidence_id, created_at: new Date().toISOString(),
    baseline_path: baselineFile, allowed_paths: baseline.allowed_paths, forbidden_paths: baseline.forbidden_paths || [],
    evidence_check: sealed ? "sealed" : "records_only",
  };
  let delta;
  if (baseline.mode !== "git") {
    delta = { ...base, start_point: "unknown", scope_status: "unverified", commits_since_start: [], changed_files: [], scope_violations: [], scope_unverified: [] };
  } else if ((await startPointStatus(paths, baselineFile)) === "lost") {
    delta = { ...base, start_point: "lost", scope_status: "unverified", commits_since_start: [], changed_files: [], scope_violations: [], scope_unverified: [] };
  } else {
    const now = await stateSinceStart(paths.repoRoot, baseline);
    const windows = await windowsFor(paths, baseline.run_id, sealed);
    const changed = [];
    for (const relative of Object.keys(now).sort()) {
      const before = startSha256(paths.repoRoot, baseline, relative);
      const after = now[relative];
      if (before === after) continue;
      changed.push({
        path: relative, change: before === null ? "added" : after === null ? "deleted" : "modified",
        before_sha256: before, after_sha256: after, attribution: attributionOf(relative, baseline.run_id, windows, after),
      });
    }
    const outside = (entry) => !matchesAllowedPath(entry.path, baseline.allowed_paths || []) || matchesForbiddenPath(entry.path, baseline.forbidden_paths || []);
    const violations = changed.filter((entry) => outside(entry) && entry.attribution === "run").map((entry) => entry.path);
    const unverified = changed.filter((entry) => outside(entry) && entry.attribution !== "run").map((entry) => entry.path);
    const commits = commitsBetween(paths.repoRoot, baseline.start_head || EMPTY_TREE);
    if (commits === null && headCommit(paths.repoRoot)) throw new Error("Git could not list the commits since the run started.");
    delta = {
      ...base, start_point: "ok", start_head: baseline.start_head, head: headCommit(paths.repoRoot),
      commits_since_start: commits || [],
      scope_status: unverified.length ? "partly_unverified" : "checked",
      changed_files: changed, scope_violations: violations, scope_unverified: unverified,
    };
  }
  const safeDeltaId = String(deltaId).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
  if (!safeDeltaId) throw new Error("Workspace delta ID is empty.");
  const deltaPath = path.join(path.dirname(baselineFile), "delta-" + safeDeltaId + ".json");
  await writeJsonAtomic(deltaPath, delta);
  return {
    mode: delta.mode,
    evidence_id: delta.evidence_id,
    baseline_path: baselineFile,
    delta_path: deltaPath,
    start_point: delta.start_point,
    changed_paths: delta.changed_files.map((entry) => entry.path),
    scope_violations: delta.scope_violations,
    scope_unverified: delta.scope_unverified,
  };
}
