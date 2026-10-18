// Read-only Git access for the work proof (RC3-BLOCKER-00). Every call passes --no-optional-locks,
// so reading never takes the index lock; nothing here commits, adds, stashes, resets, checks out
// or writes to the object store (Owner 2026-10-17). A failed call is an error to the caller; it is
// never read as "nothing" or "no".
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

// Git's empty tree: the "start" of a repository that has no commit yet.
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

function gitCall(repoRoot, args) {
  return spawnSync("git", ["--no-optional-locks", ...args], {
    cwd: repoRoot, encoding: "buffer", windowsHide: true, timeout: 60_000, maxBuffer: 512 * 1024 * 1024,
  });
}

export function runGit(repoRoot, args) {
  const result = gitCall(repoRoot, args);
  return result.status === 0 ? result.stdout : null;
}

// For questions whose "no" answer is exit 1 (no branch, not an ancestor, no HEAD yet): any other
// outcome, such as a timeout or a broken repository, is a failure and is never read as "no".
function yesNoGit(repoRoot, args, what) {
  const result = gitCall(repoRoot, args);
  if (result.status === 0) return result.stdout;
  if (result.status === 1) return null;
  throw new Error("Git could not tell " + what + ".");
}

const text = (buffer) => (buffer === null ? null : buffer.toString("utf8").trim());
const nulList = (buffer) => (buffer === null ? null : buffer.toString("utf8").split("\0").filter(Boolean));

// A project without Git is one with no .git in it or above it and no GIT_DIR: that is decided
// without asking Git. Once Git is expected, any failure to answer is an error, never "no Git"
// (Codex review round 3).
function gitExpected(repoRoot) {
  if (process.env.GIT_DIR) return true;
  for (let dir = path.resolve(repoRoot); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, ".git"))) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

export function isGitWorkTree(repoRoot) {
  if (!gitExpected(repoRoot)) return false;
  if (text(runGit(repoRoot, ["rev-parse", "--is-inside-work-tree"])) === "true") return true;
  throw new Error("Git could not tell whether " + repoRoot + " is a Git work tree.");
}

export function headCommit(repoRoot) {
  return text(yesNoGit(repoRoot, ["rev-parse", "--verify", "-q", "HEAD"], "the current commit")) || null;
}

// null only for a detached HEAD.
export function currentBranch(repoRoot) {
  return text(yesNoGit(repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"], "the current branch")) || null;
}

// Tracked paths whose working-tree content differs from `base` (a commit, or the empty tree).
export function trackedChangesSince(repoRoot, base) {
  return nulList(runGit(repoRoot, ["diff", "--no-renames", "--name-only", "-z", base, "--"]));
}

export function untrackedFiles(repoRoot) {
  return nulList(runGit(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]));
}

// Ignored files that match the forbidden list, at any depth, found by Git itself: Bridge never walks
// node_modules, .venv or build. Each pattern becomes a glob pathspec; one without "/" matches a
// file name at any depth. No --directory: with it Git reports only "node_modules/", never the
// node_modules/a/x.pem inside (checked 2026-10-19). null means Git failed, never "none found".
export function ignoredMatching(repoRoot, patterns) {
  if (!patterns.length) return [];
  const pathspecs = patterns.map((pattern) => ":(glob)" + (pattern.includes("/") ? pattern : "**/" + pattern));
  return nulList(runGit(repoRoot, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...pathspecs]));
}

export function commitsBetween(repoRoot, from, to = "HEAD") {
  const range = from === EMPTY_TREE ? [to] : [from + ".." + to];
  const out = text(runGit(repoRoot, ["log", "--reverse", "--format=%H%x09%s", ...range]));
  return out === null ? null : out.split("\n").filter(Boolean).map((line) => ({ commit: line.slice(0, 40), subject: line.slice(41) }));
}

export function isAncestor(repoRoot, ancestor, descendant = "HEAD") {
  return yesNoGit(repoRoot, ["merge-base", "--is-ancestor", ancestor, descendant], "whether the start commit is still in the history") !== null;
}

// The content hash of `relative` as committed in `commit`, or null when it is not there. "Not
// there" comes from an empty ls-tree; a failed call is an error, never read as "not there".
export function committedSha256(repoRoot, commit, relative) {
  if (!commit || commit === EMPTY_TREE) return null;
  const entry = runGit(repoRoot, ["ls-tree", "-z", commit, "--", relative]);
  if (entry === null) throw new Error("Git could not read " + relative + " in the start commit.");
  const match = /^\d+ blob ([0-9a-f]+)\t/.exec(entry.toString("utf8"));
  if (!match) return null;
  const blob = runGit(repoRoot, ["cat-file", "blob", match[1]]);
  if (blob === null) throw new Error("Git could not read " + relative + " in the start commit.");
  return sha256(blob);
}

// Locks that another program holds briefly on Windows (a dev server writing a log, an editor, a
// virus scanner) are retried a few times before the read counts as failed.
const LOCKED = new Set(["EBUSY", "EPERM", "EACCES"]);

// null means the file does not exist. Any other failure to read is reported, never taken for a
// deletion: on Windows a locked file used to read as "deleted" and could be judged out of scope.
export async function fileSha256(repoRoot, relative) {
  const file = path.join(repoRoot, ...relative.split("/"));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return sha256(await fsp.readFile(file));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      if (!LOCKED.has(error.code) || attempt >= 5) throw new Error("Could not read " + relative + " for the work proof (" + error.code + ").");
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
}
