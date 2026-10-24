// The `review-bridge` command is npm's global link to this package (`npm link`): npm writes the
// command into its global folder, which the Node installer puts on PATH. Nothing else is written
// outside the package.
import fs from "node:fs";
import path from "node:path";

import { runNpm } from "./dependencies.mjs";

function samePath(left, right) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

// Where npm's global command goes and what it points at now: this package, another Bridge copy, or
// nothing. `on_path` says whether this terminal's PATH reaches that folder.
export function commandLink(packageRoot, { npm = runNpm, env = process.env } = {}) {
  const name = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).name;
  const globalModules = npm(packageRoot, ["root", "-g"]).stdout.trim();
  const prefix = npm(packageRoot, ["prefix", "-g"]).stdout.trim();
  const commandFolder = process.platform === "win32" ? prefix : path.join(prefix, "bin");
  let pointsTo = null;
  try {
    pointsTo = fs.realpathSync(path.join(globalModules, name));
  } catch {
    // Not linked yet.
  }
  const searched = String(env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean).map((entry) => path.resolve(entry));
  return {
    linked: pointsTo !== null && samePath(pointsTo, fs.realpathSync(packageRoot)),
    points_to: pointsTo,
    command_folder: commandFolder,
    on_path: searched.some((entry) => samePath(entry, path.resolve(commandFolder))),
  };
}

export function linkCommand(packageRoot, { npm = runNpm } = {}) {
  npm(packageRoot, ["link", "--no-audit", "--no-fund"]);
}
