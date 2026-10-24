// The `review-bridge` command is npm's global link to this package (`npm link`): npm writes the
// command into its global folder. On Windows that folder has to be in the person's persistent user
// PATH for new terminals to find it; the Guide reads that PATH, never this terminal's, and adds the
// folder only when the person agrees. On macOS and Linux it prints the line to add and edits no
// shell file.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { runNpm } from "./dependencies.mjs";

function samePath(left, right) {
  const clean = (value) => path.resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? clean(left).toLowerCase() === clean(right).toLowerCase() : clean(left) === clean(right);
}

function packageName(packageRoot) {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).name;
}

// Where npm's global command goes and what it points at now: this package, another Bridge copy, or
// nothing.
export function commandLink(packageRoot, { npm = runNpm } = {}) {
  const globalModules = npm(packageRoot, ["root", "-g"]).stdout.trim();
  const prefix = npm(packageRoot, ["prefix", "-g"]).stdout.trim();
  let pointsTo = null;
  try {
    pointsTo = fs.realpathSync(path.join(globalModules, packageName(packageRoot)));
  } catch {
    // Not linked yet.
  }
  return {
    linked: pointsTo !== null && samePath(pointsTo, fs.realpathSync(packageRoot)),
    points_to: pointsTo,
    command_folder: process.platform === "win32" ? prefix : path.join(prefix, "bin"),
  };
}

export function linkCommand(packageRoot, { npm = runNpm } = {}) {
  npm(packageRoot, ["link", "--no-audit", "--no-fund"]);
}

// Removes the global command; the caller checks first that it points at this package. Personal
// data and the user PATH are not touched.
export function unlinkCommand(packageRoot, { npm = runNpm } = {}) {
  npm(packageRoot, ["rm", "-g", packageName(packageRoot)]);
}

// The user PATH is read and written as stored, variables such as %USERPROFILE% left unexpanded, so
// adding one entry leaves every other entry exactly as it was. The write goes through the registry
// with the value's own type; clearing an unused variable through SetEnvironmentVariable then sends
// the system's "environment changed" notice, which new terminals pick up. The key is always under
// HKEY_CURRENT_USER; REVIEW_BRIDGE_USER_PATH_KEY names another one there (tests), as
// REVIEW_BRIDGE_DATA_HOME does for the data folder.
const USER_PATH_KEY = () => process.env.REVIEW_BRIDGE_USER_PATH_KEY || "Environment";
const READ_USER_PATH = `
$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($env:RB_KEY)
$value = if ($k) { $k.GetValue('Path', '', 'DoNotExpandEnvironmentNames') } else { '' }
$kind = if ($k -and $k.GetValueNames() -contains 'Path') { [string]$k.GetValueKind('Path') } else { 'ExpandString' }
[Console]::Out.Write((ConvertTo-Json @{ value = [string]$value; kind = $kind } -Compress))
`;
const APPEND_USER_PATH = `
$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($env:RB_KEY)
$value = $k.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
$kind = if ($k.GetValueNames() -contains 'Path') { $k.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
$next = if ($value) { $value.TrimEnd(';') + ';' + $env:RB_ADD } else { $env:RB_ADD }
$k.SetValue('Path', $next, $kind)
$k.Close()
[Environment]::SetEnvironmentVariable('ReviewBridgePathNotice', $null, 'User')
`;

function powershell(script, env) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, env: { ...process.env, ...env }, timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("PowerShell failed: " + String(result.stderr || result.stdout).trim().split(/\r?\n/).at(-1));
  return result.stdout;
}

function expandWindows(entry, env) {
  return entry.replace(/%([^%]+)%/g, (whole, name) => {
    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key ? env[key] : whole;
  });
}

// Whether the persistent user PATH reaches `folder`, and the raw value it was decided from.
export function userPathState(folder, { key = USER_PATH_KEY(), env = process.env } = {}) {
  const stored = JSON.parse(powershell(READ_USER_PATH, { RB_KEY: key }));
  const entries = stored.value.split(";").map((entry) => entry.trim()).filter(Boolean);
  return {
    value: stored.value,
    kind: stored.kind,
    has_folder: entries.some((entry) => samePath(expandWindows(entry, env), folder)),
  };
}

export function addToUserPath(folder, { key = USER_PATH_KEY() } = {}) {
  powershell(APPEND_USER_PATH, { RB_KEY: key, RB_ADD: folder });
}

// What a terminal needs to find the command. Windows: whether the persistent user PATH has the
// folder (if not, it is offered for adding) and whether this terminal already sees it (if not, a new
// terminal is needed). macOS and Linux: whether this terminal finds it; if not, the line to add.
export function pathPlan(folder, { platform = process.platform, readUserPath = userPathState, env = process.env } = {}) {
  const searched = String(env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const thisTerminal = searched.some((entry) => samePath(entry, folder));
  if (platform === "win32") {
    const inUserPath = readUserPath(folder).has_folder;
    return { platform, folder, in_user_path: inUserPath, add_to_user_path: !inUserPath, this_terminal: thisTerminal, shell_line: null };
  }
  return { platform, folder, in_user_path: null, add_to_user_path: false, this_terminal: thisTerminal, shell_line: thisTerminal ? null : "export PATH=\"" + folder + ":$PATH\"" };
}
