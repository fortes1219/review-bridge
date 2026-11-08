// The Git questions the graph asks, read-only as the work proof's (features/workOrder/gitWorkspace.mjs):
// every call passes --no-optional-locks and writes nothing, not even an object (hash-object without -w).
// A project counts as without Git only when there is no .git in it or above it and no GIT_DIR; after
// that, a call Git cannot answer is an error, never "nothing changed".
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

function git(cwd, args, input = undefined) {
  const result = spawnSync("git", ["--no-optional-locks", ...args], {
    cwd, input: input === undefined ? undefined : Buffer.from(input, "utf8"), encoding: "buffer", windowsHide: true, timeout: 120_000, maxBuffer: 512 * 1024 * 1024,
  });
  if (result.status === 0) return result.stdout.toString("utf8");
  const said = result.stderr?.length ? result.stderr.toString("utf8").trim() : String(result.error?.message || "git exited with " + (result.status ?? result.signal));
  const error = new Error("Git could not answer `git " + args.join(" ") + "` in " + cwd + ". Git said: " + said);
  error.status = result.status;
  throw error;
}
const nul = (text) => text.split("\0").filter(Boolean);

export function hasGit(root) {
  if (process.env.GIT_DIR) return true;
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, ".git"))) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

// HEAD, or null in a repository with no commit yet ("no" is exit 1 with -q --verify).
export function head(root) {
  try {
    return git(root, ["rev-parse", "--verify", "-q", "HEAD"]).trim() || null;
  } catch (error) {
    if (error.status === 1) return null;
    throw error;
  }
}

// Tracked and untracked files that Git does not ignore, under `pathspecs` (relative to `root`, which may
// lead out of it with ../ for a workspace package beside it). Paths come back relative to `root`.
export function listFiles(root, pathspecs) {
  return nul(git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...pathspecs]));
}

// The files that may differ from `commit`: what `git diff` shows between it and the working tree,
// staged or not, with renames as a delete and an add, plus the untracked files Git does not ignore.
// Vitest's --changed asks Git the same two things (vcs/git.ts); Bridge diffs the working tree because
// its graph covers what is not committed yet.
// `git diff` names paths from the top of the work tree (its --relative would drop a sibling package's
// changes), `ls-files` from `root`; both come back relative to `root`.
export function changedSince(root, commit, pathspecs) {
  const top = topLevel(root);
  const fromTop = (file) => path.relative(root, path.join(top, file)).split(path.sep).join("/");
  const changed = nul(git(root, ["diff", "--name-only", "-z", "--no-renames", commit, "--", ...pathspecs])).map(fromTop);
  const untracked = nul(git(root, ["ls-files", "-z", "--others", "--exclude-standard", "--", ...pathspecs]));
  return [...new Set([...changed, ...untracked])];
}

// Git's blob id of each file's current content, as `git add` would store it, without storing it.
export function blobIds(root, files) {
  if (!files.length) return [];
  const ids = git(root, ["hash-object", "--stdin-paths"], files.join("\n") + "\n").split(/\r?\n/).filter(Boolean);
  if (ids.length !== files.length) throw new Error("Git gave " + ids.length + " blob ids for " + files.length + " files.");
  return ids;
}

// Where the work tree starts, for turning `git diff`'s top-level paths into the project's.
export function topLevel(root) {
  return path.resolve(git(root, ["rev-parse", "--show-toplevel"]).trim());
}
