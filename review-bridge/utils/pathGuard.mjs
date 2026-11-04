// Path checks: whether a path stays under an allowed root, and whether two paths are the same.
import path from "node:path";

export function resolvePath(value) {
  return path.resolve(value);
}

export function isUnder(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertUnder(candidate, root, label = "Path") {
  if (!isUnder(candidate, root)) {
    throw new Error(label + " escaped its allowed root.");
  }
  return path.resolve(candidate);
}

// The same check against several allowed roots: the path must stay under one of them.
export function assertUnderOne(candidate, roots, label = "Path") {
  if (!roots.some((root) => isUnder(candidate, root))) {
    throw new Error(label + " escaped its allowed root.");
  }
  return path.resolve(candidate);
}

export function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}
