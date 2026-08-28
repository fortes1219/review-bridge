import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

async function exists(file) {
  try {
    return (await fsp.stat(file)).isFile();
  } catch {
    return false;
  }
}

export async function resolveExecutable(kind) {
  const envName = kind === "codex" ? "CODEX_REVIEW_CLI" : "CLAUDE_REVIEW_CLI";
  if (process.env[envName]) {
    if (!(await exists(process.env[envName]))) throw new Error(envName + " does not point to a file.");
    return path.resolve(process.env[envName]);
  }
  const name = kind === "codex" ? "codex" : "claude";
  const result = spawnSync("/usr/bin/which", [name], { encoding: "utf8" });
  if (result.status === 0 && result.stdout.trim()) {
    const candidate = result.stdout.trim();
    const relative = path.relative(path.resolve(process.cwd()), path.resolve(candidate));
    if (relative.startsWith("..") || path.isAbsolute(relative)) return candidate;
  }
  const local = path.join(os.homedir(), ".local", "bin", name);
  if (await exists(local)) return local;
  throw new Error(kind + " CLI was not found on linux-x64.");
}

export function buildInvocation(_kind, executable, args) {
  return { command: executable, args, env: process.env };
}

export async function notify() {
  // Test-only POSIX target. Notification is intentionally disabled.
}
