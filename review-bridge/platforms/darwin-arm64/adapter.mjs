import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";

async function exists(file) {
  try {
    return (await fsp.stat(file)).isFile();
  } catch {
    return false;
  }
}

function onPath(name) {
  const result = spawnSync("/usr/bin/which", [name], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  const candidate = result.stdout.trim();
  const relative = path.relative(path.resolve(process.cwd()), path.resolve(candidate));
  return relative.startsWith("..") || path.isAbsolute(relative) ? candidate : null;
}

export async function resolveExecutable(kind) {
  const envName = kind === "codex" ? "CODEX_REVIEW_CLI" : "CLAUDE_REVIEW_CLI";
  if (process.env[envName]) {
    if (!(await exists(process.env[envName]))) throw new Error(envName + " does not point to a file.");
    return path.resolve(process.env[envName]);
  }
  const name = kind === "codex" ? "codex" : "claude";
  const found = onPath(name);
  if (found) return found;
  const candidates = [
    path.join(os.homedir(), ".local", "bin", name),
    path.join("/opt/homebrew/bin", name),
    path.join("/usr/local/bin", name),
  ];
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  throw new Error(kind + " CLI was not found on darwin-arm64.");
}

export function buildInvocation(_kind, executable, args) {
  return { command: executable, args, env: process.env };
}

export async function notify(title, message) {
  const script = "on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run";
  try {
    const child = spawn("/usr/bin/osascript", ["-e", script, title, message], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // Experimental adapter: notification failure is non-fatal.
  }
}
