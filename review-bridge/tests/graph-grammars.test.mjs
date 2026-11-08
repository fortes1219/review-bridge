// T0-GRAPH-01: a language's parser package is installed when a project needs it, into Bridge's data
// folder (grammars/<name>@<version>/, as npx keeps one folder per package set), never into the project;
// a package that cannot be installed leaves that language's files unread and named. npm is a stand-in
// here: nothing is downloaded. Its own file, because the parsers register once per process.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensurePackage, grammarsRoot, loadGrammars, npmInstall } from "../service/graph/grammars.mjs";
import { LANGUAGE_PACKAGES } from "../service/graph/languages.mjs";

async function tempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-grammars-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

// What `npm install` leaves for a package of ast-grep/langs: its package.json and an index.js that
// names its parser, as packages/<lang>/index.js does.
function fakeNpm({ fail = [] } = {}) {
  const installs = [];
  const install = async (cwd) => {
    const manifest = JSON.parse(await fsp.readFile(path.join(cwd, "package.json"), "utf8"));
    const [name] = Object.keys(manifest.dependencies);
    installs.push(name + "@" + manifest.dependencies[name]);
    if (fail.includes(name)) return { ok: false, output: "npm ERR! network" };
    const folder = path.join(cwd, "node_modules", ...name.split("/"));
    await fsp.mkdir(folder, { recursive: true });
    await fsp.writeFile(path.join(folder, "package.json"), JSON.stringify({ name, main: "index.js" }));
    await fsp.writeFile(path.join(folder, "index.js"), "module.exports = { libraryPath: " + JSON.stringify(path.join(folder, "parser.so")) + ", extensions: ['x'], languageSymbol: 'tree_sitter_x', expandoChar: 'µ' };\n");
    return { ok: true, output: "" };
  };
  return { installs, install };
}

test("the versions are pinned: napi 0.51.1's language packages at 0.0.6 or 0.0.7", () => {
  assert.deepEqual(LANGUAGE_PACKAGES, {
    python: "@ast-grep/lang-python@0.0.6", go: "@ast-grep/lang-go@0.0.6", rust: "@ast-grep/lang-rust@0.0.7", java: "@ast-grep/lang-java@0.0.7",
    kotlin: "@ast-grep/lang-kotlin@0.0.7", cpp: "@ast-grep/lang-cpp@0.0.6", csharp: "@ast-grep/lang-csharp@0.0.6",
  });
});

test("a package is installed once into the data folder and found there afterwards; a failed install leaves nothing", async (t) => {
  const dataHome = await tempDir(t);
  const npm = fakeNpm({ fail: ["@ast-grep/lang-kotlin"] });
  const first = await ensurePackage(dataHome, "@ast-grep/lang-go@0.0.6", { install: npm.install });
  assert.deepEqual(first, { folder: path.join(grammarsRoot(dataHome), "@ast-grep+lang-go@0.0.6"), installed: true });
  assert.deepEqual((await ensurePackage(dataHome, "@ast-grep/lang-go@0.0.6", { install: npm.install })).installed, false);
  assert.deepEqual(npm.installs, ["@ast-grep/lang-go@0.0.6"], "asked of npm once");
  await assert.rejects(ensurePackage(dataHome, "@ast-grep/lang-kotlin@0.0.7", { install: npm.install }), /npm could not install @ast-grep\/lang-kotlin@0\.0\.7: npm ERR! network/);
  assert.deepEqual(await fsp.readdir(grammarsRoot(dataHome)), ["@ast-grep+lang-go@0.0.6"], "no half-installed folder, no staging folder");
});

test("the parsers a project needs register once, in one call; a language whose package failed is named with why", async (t) => {
  const dataHome = await tempDir(t);
  const npm = fakeNpm({ fail: ["@ast-grep/lang-rust"] });
  const registered = [];
  const napi = { registerDynamicLanguage: (languages) => registered.push(languages) };
  const loaded = await loadGrammars(dataHome, new Set(["typescript", "go", "rust", "tsx"]), { install: npm.install, napi });
  assert.deepEqual([...loaded.ready].sort(), ["go", "tsx", "typescript"]);
  assert.match(loaded.problems.rust, /npm could not install @ast-grep\/lang-rust@0\.0\.7/);
  assert.equal(registered.length, 1);
  assert.deepEqual(Object.keys(registered[0]), ["go"]);
  assert.deepEqual(registered[0].go.extensions, ["x"]);
  const later = await loadGrammars(dataHome, new Set(["go", "python"]), { install: npm.install, napi });
  assert.equal(registered.length, 1, "napi registers dynamic languages once per process");
  assert.ok(later.ready.has("go"));
  assert.match(later.problems.python, /the next start reads it/);
});

test("npm is run in the package's folder with fixed words only, through a shell on Windows", async () => {
  const seen = [];
  const spawnProcess = (command, args, options) => {
    seen.push({ command, args, cwd: options.cwd, shell: options.shell === true });
    const listeners = {};
    const child = { stdout: null, stderr: null, kill() {}, on: (event, fn) => { listeners[event] = fn; } };
    setImmediate(() => listeners.close?.(0));
    return child;
  };
  assert.deepEqual(await npmInstall(path.join(os.tmpdir(), "a b"), { spawnProcess }), { ok: true, output: "" });
  const expected = process.platform === "win32"
    ? { command: "npm install --no-audit --no-fund --loglevel=error", args: [], cwd: path.join(os.tmpdir(), "a b"), shell: true }
    : { command: "npm", args: ["install", "--no-audit", "--no-fund", "--loglevel=error"], cwd: path.join(os.tmpdir(), "a b"), shell: false };
  assert.deepEqual(seen, [expected]);
});
