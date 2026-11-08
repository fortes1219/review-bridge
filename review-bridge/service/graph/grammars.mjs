// The parsers the graph needs, ready in this process. JavaScript, TypeScript and TSX come with
// @ast-grep/napi; each of the other six is an @ast-grep/lang-* package that a project needs only if it
// has files in that language (Owner 2026-11-08, choice B). They are installed the way npx installs what it
// runs (npm/cli libnpmexec: one folder per package set in npm's cache, then Arborist): one folder per
// pinned package under Bridge's data folder, `grammars/<name>@<version>/`, shared by every project and
// never inside one. npm itself installs it; each package finds its prebuilt parser for this platform when
// it is loaded (ast-grep/langs index.js `libraryPath`). A package that cannot be installed or loaded
// leaves its files unparsed and listed (`no_parser`), never silently left out.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { BUILT_IN, LANGUAGE_PACKAGES } from "./languages.mjs";

const folderName = (spec) => spec.replace("/", "+");
const packageName = (spec) => spec.slice(0, spec.lastIndexOf("@"));

export const grammarsRoot = (dataHome) => path.join(dataHome, "grammars");

// `npm install` in the package's own folder (its package.json names the one pinned dependency). On
// Windows npm is a .cmd file, which Node runs only through a shell (Node docs, "Spawning .bat and .cmd
// files on Windows"); the command line holds fixed words only, and the folder is the working directory.
export function npmInstall(cwd, { spawnProcess = spawn, timeoutMs = 300_000 } = {}) {
  return new Promise((resolve) => {
    let output = "";
    const words = ["npm", "install", "--no-audit", "--no-fund", "--loglevel=error"];
    const options = { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] };
    // Through a shell the fixed words go as one command, not as arguments (Node 24 DEP0190).
    const child = process.platform === "win32"
      ? spawnProcess(words.join(" "), [], { ...options, shell: true })
      : spawnProcess(words[0], words.slice(1), options);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout?.on("data", (chunk) => { output += chunk; });
    child.stderr?.on("data", (chunk) => { output += chunk; });
    child.on("error", (error) => { clearTimeout(timer); resolve({ ok: false, output: error.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, output: output.trim().slice(-2000) }); });
  });
}

// The folder of an installed package, or null. A folder is complete once it has its name: it is
// installed under a temporary name and renamed, so a second process installing the same package at
// the same time either finds it whole or loses the rename and keeps the first.
async function installed(root, spec) {
  const folder = path.join(root, folderName(spec));
  const manifest = path.join(folder, "node_modules", ...packageName(spec).split("/"), "package.json");
  return (await fsp.stat(manifest).then(() => true, () => false)) ? folder : null;
}

export async function ensurePackage(dataHome, spec, { install = npmInstall } = {}) {
  const root = grammarsRoot(dataHome);
  const found = await installed(root, spec);
  if (found) return { folder: found, installed: false };
  await fsp.mkdir(root, { recursive: true });
  const staging = path.join(root, ".install-" + randomUUID());
  await fsp.mkdir(staging);
  try {
    const version = spec.slice(spec.lastIndexOf("@") + 1);
    await fsp.writeFile(path.join(staging, "package.json"), JSON.stringify({ private: true, dependencies: { [packageName(spec)]: version } }, null, 2) + "\n");
    const result = await install(staging);
    if (!result.ok) throw new Error("npm could not install " + spec + ": " + (result.output || "no output"));
    await fsp.rename(staging, path.join(root, folderName(spec))).catch(async (error) => {
      if (!(await installed(root, spec))) throw error;
    });
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
  return { folder: path.join(root, folderName(spec)), installed: true };
}

// @ast-grep/napi registers dynamic languages "exactly once in the program": the first call here
// registers every language asked for; a later call can add none (that language reads as no_parser in
// this process and is installed and read by the next one).
let registered = null;

export async function loadGrammars(dataHome, languages, { install = npmInstall, napi = null, onInstall = () => {} } = {}) {
  const sg = napi ?? await import("@ast-grep/napi");
  const ready = new Set(Object.keys(BUILT_IN).filter((language) => languages.has(language)));
  const problems = {};
  const wanted = [...languages].filter((language) => LANGUAGE_PACKAGES[language]);
  if (registered) {
    for (const language of wanted) {
      if (registered.has(language)) ready.add(language);
      else problems[language] = "Its parser was not loaded when this process started; the next start reads it.";
    }
    return { ready, problems, napi: sg };
  }
  const registrations = {};
  for (const language of wanted) {
    const spec = LANGUAGE_PACKAGES[language];
    try {
      const { folder, installed: fresh } = await ensurePackage(dataHome, spec, { install });
      if (fresh) onInstall(spec);
      const lang = createRequire(path.join(folder, "package.json"))(packageName(spec));
      registrations[language] = { libraryPath: lang.libraryPath, extensions: lang.extensions, languageSymbol: lang.languageSymbol, expandoChar: lang.expandoChar };
    } catch (error) {
      problems[language] = error.message;
    }
  }
  registered = new Set(Object.keys(registrations));
  if (registered.size) {
    try {
      sg.registerDynamicLanguage(registrations);
    } catch (error) {
      for (const language of registered) problems[language] = error.message;
      registered = new Set();
    }
  }
  for (const language of registered) ready.add(language);
  return { ready, problems, napi: sg };
}

export const BUILT_IN_LANG = BUILT_IN;
