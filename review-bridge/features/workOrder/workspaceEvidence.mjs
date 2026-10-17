import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { assertUnder } from "../../utils/pathGuard.mjs";
import { PRIVATE_ROOT_NAME } from "../../utils/paths.mjs";
import { ensureDir, readJson, writeJsonAtomic } from "../../service/index.mjs";

const excludedRoots = new Set([
  ".git",
  ".nuxt",
  ".output",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);
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
const maximumFiles = 20_000;
const maximumBaselineBytes = 100 * 1024 * 1024;

function digest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function normalizeRelative(value) {
  return path.posix.normalize(String(value).replaceAll("\\", "/")).replace(/^\.\//, "");
}

function isExcluded(relative) {
  const candidate = normalizeRelative(relative);
  if (!candidate.includes("/") && excludedRoots.has(candidate)) return true;
  return excludedControllerPaths.some((entry) => candidate === entry || candidate.startsWith(entry + "/"));
}

export function matchesAllowedPath(relative, allowedPaths) {
  const candidate = normalizeRelative(relative);
  return allowedPaths.some((entry) => {
    if (entry === "**") return true;
    const allowed = normalizeRelative(entry).replace(/\/$/, "");
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

async function manifest(root) {
  const files = [];
  let totalBytes = 0;
  async function walk(directory, prefix = "") {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = normalizeRelative(path.posix.join(prefix, entry.name));
      const absolute = assertUnder(path.join(root, ...relative.split("/")), root, "Workspace evidence path");
      if (entry.isSymbolicLink()) throw new Error("Workspace evidence refuses symlink: " + relative);
      if (entry.isDirectory()) {
        if (isExcluded(relative)) continue;
        await walk(absolute, relative);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isExcluded(relative)) continue;
      const content = await fsp.readFile(absolute);
      totalBytes += content.length;
      files.push({ path: relative, sha256: digest(content), size: content.length });
      if (files.length > maximumFiles) throw new Error("Workspace evidence exceeds " + maximumFiles + " files.");
    }
  }
  await walk(root);
  return { files, total_bytes: totalBytes };
}

function byPath(files) {
  return new Map(files.map((file) => [file.path, file]));
}

export async function createWorkspaceBaseline({ paths, planSha256, allowedPaths, forbiddenPaths = [] }) {
  const evidenceId = String(planSha256).slice(0, 32);
  const evidenceDir = assertUnder(path.join(paths.evidenceRoot, evidenceId), paths.evidenceRoot, "Evidence directory");
  await fsp.rm(evidenceDir, { recursive: true, force: true });
  await ensureDir(path.join(evidenceDir, "before"));
  const baseline = await manifest(paths.repoRoot);
  const copied = baseline.files.filter((file) => matchesAllowedPath(file.path, allowedPaths));
  const copiedBytes = copied.reduce((sum, file) => sum + file.size, 0);
  if (copiedBytes > maximumBaselineBytes) {
    throw new Error("Allowed-path baseline exceeds 100 MiB; narrow the work package scope.");
  }
  for (const file of copied) {
    const source = assertUnder(path.join(paths.repoRoot, ...file.path.split("/")), paths.repoRoot, "Baseline source");
    const target = assertUnder(path.join(evidenceDir, "before", ...file.path.split("/")), evidenceDir, "Baseline copy");
    await ensureDir(path.dirname(target));
    await fsp.copyFile(source, target);
  }
  const record = {
    schema_version: 1,
    mode: "workspace_snapshot",
    evidence_id: evidenceId,
    created_at: new Date().toISOString(),
    repo_root: paths.repoRoot,
    allowed_paths: allowedPaths,
    forbidden_paths: forbiddenPaths,
    files: baseline.files,
    total_bytes: baseline.total_bytes,
    copied_allowed_files: copied.map((file) => file.path),
  };
  const baselinePath = path.join(evidenceDir, "baseline.json");
  await writeJsonAtomic(baselinePath, record);
  return {
    mode: "workspace_snapshot",
    evidence_id: evidenceId,
    evidence_dir: evidenceDir,
    baseline_path: baselinePath,
  };
}

export async function createWorkspaceDelta({ paths, baselinePath, deltaId = "current" }) {
  const baselineFile = assertUnder(path.resolve(baselinePath), paths.evidenceRoot, "Baseline path");
  const baseline = await readJson(baselineFile);
  const current = await manifest(paths.repoRoot);
  const before = byPath(baseline.files || []);
  const after = byPath(current.files);
  const changed = [];
  for (const [relative, file] of before) {
    const next = after.get(relative);
    if (!next) changed.push({ path: relative, change: "deleted", before_sha256: file.sha256, after_sha256: null });
    else if (next.sha256 !== file.sha256) changed.push({ path: relative, change: "modified", before_sha256: file.sha256, after_sha256: next.sha256 });
  }
  for (const [relative, file] of after) {
    if (!before.has(relative)) changed.push({ path: relative, change: "added", before_sha256: null, after_sha256: file.sha256 });
  }
  changed.sort((a, b) => a.path.localeCompare(b.path));
  const scopeViolations = changed
    .filter((entry) => !matchesAllowedPath(entry.path, baseline.allowed_paths || [])
      || matchesForbiddenPath(entry.path, baseline.forbidden_paths || []))
    .map((entry) => entry.path);
  const delta = {
    schema_version: 1,
    mode: "workspace_snapshot",
    evidence_id: baseline.evidence_id,
    created_at: new Date().toISOString(),
    baseline_path: baselineFile,
    allowed_paths: baseline.allowed_paths,
    forbidden_paths: baseline.forbidden_paths || [],
    changed_files: changed,
    scope_violations: scopeViolations,
  };
  const safeDeltaId = String(deltaId).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
  if (!safeDeltaId) throw new Error("Workspace delta ID is empty.");
  const deltaPath = path.join(path.dirname(baselineFile), "delta-" + safeDeltaId + ".json");
  await writeJsonAtomic(deltaPath, delta);
  return {
    mode: delta.mode,
    evidence_id: delta.evidence_id,
    baseline_path: baselineFile,
    before_files_root: path.join(path.dirname(baselineFile), "before"),
    delta_path: deltaPath,
    changed_paths: changed.map((entry) => entry.path),
    scope_violations: scopeViolations,
  };
}
