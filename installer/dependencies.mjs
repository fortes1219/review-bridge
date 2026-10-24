// Bridge's own dependencies (pg and the embedded PostgreSQL binaries) live in node_modules beside
// the package, as with any npm-installed program. init installs them from the shipped lock file
// when any is missing or is not the locked version. Projects never hold them.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { postgresPackageName } from "../review-bridge/service/database/platformPackages.mjs";

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

// What is not as the lock file says: each named dependency and this machine's PostgreSQL package
// at its locked version, and that package's three server binaries on disk. Empty means complete.
export async function dependencyProblems(packageRoot, { platform = process.platform, arch = process.arch } = {}) {
  const manifest = await readJson(path.join(packageRoot, "package.json"));
  const lock = await readJson(path.join(packageRoot, "package-lock.json"));
  const binariesPackage = postgresPackageName({ platform, arch });
  if (!binariesPackage) return ["no PostgreSQL binaries are packaged for " + platform + "-" + arch];
  const problems = [];
  for (const name of [...Object.keys(manifest.dependencies || {}), binariesPackage]) {
    const locked = lock.packages?.["node_modules/" + name]?.version;
    if (!locked) {
      problems.push(name + " is not in package-lock.json");
      continue;
    }
    const installed = await readJson(path.join(packageRoot, "node_modules", ...name.split("/"), "package.json")).then((json) => json.version, () => null);
    if (installed !== locked) problems.push(name + (installed ? " is " + installed + ", locked " + locked : " is not installed"));
  }
  if (problems.length) return problems;
  let binaries;
  try {
    binaries = await import(pathToFileURL(createRequire(path.join(packageRoot, "package.json")).resolve(binariesPackage)).href);
  } catch (error) {
    return [binariesPackage + " cannot be loaded: " + error.message];
  }
  for (const tool of ["initdb", "pg_ctl", "postgres"]) {
    if (!binaries[tool] || !fs.existsSync(binaries[tool])) problems.push("the " + tool + " binary of " + binariesPackage + " is missing");
  }
  return problems;
}

// npm's own entry point next to this Node, run with this Node, so no shell is involved.
export function npmEntry({ env = process.env, execPath = process.execPath } = {}) {
  const candidates = [
    env.npm_execpath,
    path.join(path.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate) => candidate && candidate.endsWith("npm-cli.js"));
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error("npm was not found next to Node (" + execPath + "); install Node.js with npm.");
  return found;
}

// `npm ci` installs exactly the lock file into node_modules; dev dependencies are not installed.
export function installWithNpm(packageRoot) {
  const result = spawnSync(process.execPath, [npmEntry(), "ci", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: packageRoot, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const tail = String(result.stderr || result.stdout || "").trim().split(/\r?\n/).slice(-5).join(" | ");
    throw new Error("npm ci failed in " + packageRoot + ": " + tail);
  }
}

// Installs the dependencies when they are not as locked, then checks again. Anything still missing
// fails init before any project is touched.
export async function ensureDependencies(packageRoot, { install = installWithNpm, notify = () => {}, platform, arch } = {}) {
  const before = await dependencyProblems(packageRoot, { platform, arch });
  if (!before.length) return { installed: false };
  notify("Installing Review Bridge dependencies (" + before.join("; ") + ")");
  await install(packageRoot);
  const after = await dependencyProblems(packageRoot, { platform, arch });
  if (after.length) throw new Error("Review Bridge dependencies are not complete after installing: " + after.join("; "));
  return { installed: true };
}
