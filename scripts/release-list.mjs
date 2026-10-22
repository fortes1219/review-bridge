// The release list is SHA256SUMS.txt: the files a release carries, each with its sha256, kept by
// hand. Nothing enters it by being on disk or tracked by Git; a file enters only when it is named.
// The packager ships exactly this list, and init's integrity check reads the same list, so what is
// verified and what is shipped cannot drift apart. Private folders are refused wherever they appear.
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

export const LIST_NAME = "SHA256SUMS.txt";

// Never shipped: this working copy's provider and Bridge state, version control, dependencies and
// scratch space. Matched on any path segment, case-insensitively, so ".Claude/x" is refused too.
export const PRIVATE_SEGMENTS = Object.freeze([".claude", ".review-bridge", ".git", "node_modules", ".tmp"]);

export const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

// .env and .env.<anything> hold real values and are never shipped, at any depth and in any case;
// only .env.example, the placeholder template, may be.
function isEnvironmentFile(segment) {
  const name = segment.toLowerCase();
  return name === ".env" || (name.startsWith(".env.") && name !== ".env.example");
}

// A path the list may name: relative, forward slashes, no empty, "." or ".." segment, no control
// character, nothing private, and never the list itself.
export function checkReleasePath(relative) {
  if (typeof relative !== "string" || relative === "") throw new Error("A release path is empty.");
  if (relative.includes("\\")) throw new Error("A release path uses a backslash: " + relative);
  if (/^[A-Za-z]:/.test(relative) || relative.startsWith("/")) throw new Error("A release path is absolute: " + relative);
  if (/[\u0000-\u001f\u007f]/u.test(relative)) throw new Error("A release path has a control character: " + JSON.stringify(relative));
  const segments = relative.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("A release path has an unsafe segment: " + relative);
  }
  if (segments.some((segment) => PRIVATE_SEGMENTS.includes(segment.toLowerCase()))) {
    throw new Error("A private path cannot be released: " + relative);
  }
  if (segments.some(isEnvironmentFile)) throw new Error("An environment file cannot be released: " + relative);
  if (segments.length === 1 && segments[0].toLowerCase() === LIST_NAME.toLowerCase()) {
    throw new Error("The release list cannot name itself.");
  }
  return relative;
}

// The list's lines, each checked; a malformed line, an unsafe path or a duplicate (also one that
// differs only in case) refuses the whole list.
export function parseReleaseList(text) {
  const lines = String(text).split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new Error("The release list is empty.");
  const seen = new Set();
  return lines.map((line, index) => {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match) throw new Error("The release list has a malformed line " + (index + 1) + ".");
    const relative = checkReleasePath(match[2]);
    const key = relative.toLowerCase();
    if (seen.has(key)) throw new Error("The release list names a path twice: " + relative);
    seen.add(key);
    return { sha256: match[1], path: relative };
  });
}

// The bytes of one listed file: a regular file that stays inside the package, reached without any
// link. Every step of the path is checked, not only the last: a folder that is a link or a Windows
// junction (docs/alias -> .claude) would otherwise carry private files in under an innocent name.
export async function readReleaseFile(packageRoot, relative) {
  const segments = relative.split("/");
  let stat;
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const step = path.join(packageRoot, ...segments.slice(0, depth));
    try {
      stat = await fsp.lstat(step);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") throw new Error("A listed file is missing: " + relative);
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("A listed path goes through a link: " + segments.slice(0, depth).join("/"));
  }
  const absolute = path.join(packageRoot, ...segments);
  if (!stat.isFile()) throw new Error("A listed path is not a regular file: " + relative);
  const realRoot = await fsp.realpath(packageRoot);
  const real = await fsp.realpath(absolute);
  if (!real.startsWith(realRoot + path.sep)) throw new Error("A listed file resolves outside the package: " + relative);
  return await fsp.readFile(absolute);
}

// The list as it is, every file present with the listed content. Returns the list text and each
// file's bytes as they were checked, so whatever is shipped is exactly what was checked.
export async function verifyReleaseList(packageRoot) {
  const text = await fsp.readFile(path.join(packageRoot, LIST_NAME), "utf8");
  const files = [];
  for (const entry of parseReleaseList(text)) {
    const content = await readReleaseFile(packageRoot, entry.path);
    if (sha256(content) !== entry.sha256) throw new Error("A listed file does not match its checksum: " + entry.path);
    files.push({ path: entry.path, content });
  }
  return { text, files };
}
