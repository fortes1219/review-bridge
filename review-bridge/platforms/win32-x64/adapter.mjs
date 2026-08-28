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
  const result = spawnSync("where.exe", [name], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return null;
  const workspace = path.resolve(process.cwd());
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .find((candidate) => {
      const relative = path.relative(workspace, path.resolve(candidate));
      return relative.startsWith("..") || path.isAbsolute(relative);
    }) || null;
}

async function newestCodexExtension() {
  const roots = [
    path.join(os.homedir(), ".vscode", "extensions"),
    path.join(os.homedir(), ".vscode-insiders", "extensions"),
  ];
  const candidates = [];
  for (const root of roots) {
    let extensions = [];
    try {
      extensions = await fsp.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const extension of extensions) {
      if (!extension.isDirectory() || !extension.name.startsWith("openai.chatgpt-")) continue;
      const binRoot = path.join(root, extension.name, "bin");
      let platforms = [];
      try {
        platforms = await fsp.readdir(binRoot, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const platform of platforms) {
        const candidate = path.join(binRoot, platform.name, "codex.exe");
        if (await exists(candidate)) {
          const stat = await fsp.stat(candidate);
          candidates.push({ candidate, mtime: stat.mtimeMs });
        }
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.candidate || null;
}

export async function resolveExecutable(kind) {
  const envName = kind === "codex" ? "CODEX_REVIEW_CLI" : "CLAUDE_REVIEW_CLI";
  if (process.env[envName]) {
    if (!(await exists(process.env[envName]))) throw new Error(envName + " does not point to a file.");
    return path.resolve(process.env[envName]);
  }
  const pathResult = onPath(kind === "codex" ? "codex.exe" : "claude.exe");
  if (pathResult) return pathResult;
  if (kind === "codex") {
    const extension = await newestCodexExtension();
    if (extension) return extension;
  } else {
    const localClaude = path.join(os.homedir(), ".local", "bin", "claude.exe");
    if (await exists(localClaude)) return localClaude;
  }
  throw new Error(kind + " CLI was not found on Windows.");
}

export function buildInvocation(_kind, executable, args) {
  return { command: executable, args, env: process.env };
}

export async function notify(title, message) {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "Add-Type -AssemblyName System.Drawing;",
    "$n=New-Object System.Windows.Forms.NotifyIcon;",
    "$n.Icon=[System.Drawing.SystemIcons]::Information;",
    "$n.BalloonTipTitle=$args[0];",
    "$n.BalloonTipText=$args[1];",
    "$n.Visible=$true;",
    "$n.ShowBalloonTip(5000);",
    "Start-Sleep -Seconds 6;",
    "$n.Dispose();",
  ].join("");
  try {
    const child = spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
      "-Command", script, title, message,
    ], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  } catch {
    // Notification failure never changes the review result.
  }
}
