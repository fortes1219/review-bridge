import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { dependencyProblems, ensureDependencies, npmEntry } from "../installer/dependencies.mjs";
import { postgresPackageName } from "../review-bridge/service/database/platformPackages.mjs";

// Bridge's own pg and PostgreSQL binaries live in node_modules beside the package. These tests
// never run npm: the install step is a stand-in that writes or leaves the files.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binariesPackage = postgresPackageName();

// A package folder whose lock names pg 8.0.0 and this machine's binaries package 18.0.0.
async function fakePackage(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-deps-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fake-bridge", dependencies: { pg: "8.0.0" } }));
  await fsp.writeFile(path.join(root, "package-lock.json"), JSON.stringify({
    lockfileVersion: 3,
    packages: { "": {}, "node_modules/pg": { version: "8.0.0" }, ["node_modules/" + binariesPackage]: { version: "18.0.0" } },
  }));
  return root;
}

// Puts a dependency into the fake package's node_modules at a version; the binaries package also
// gets an entry point that names its three binaries, which exist unless left out.
async function place(root, name, version, { binaries = ["initdb", "pg_ctl", "postgres"] } = {}) {
  const folder = path.join(root, "node_modules", ...name.split("/"));
  await fsp.mkdir(folder, { recursive: true });
  await fsp.writeFile(path.join(folder, "package.json"), JSON.stringify({ name, version, main: "index.js" }));
  if (name !== binariesPackage) return;
  await fsp.mkdir(path.join(folder, "bin"), { recursive: true });
  const entries = [];
  for (const tool of ["initdb", "pg_ctl", "postgres"]) {
    const file = path.join(folder, "bin", tool);
    if (binaries.includes(tool)) await fsp.writeFile(file, "");
    entries.push("exports." + tool + " = " + JSON.stringify(file) + ";");
  }
  await fsp.writeFile(path.join(folder, "index.js"), entries.join("\n") + "\n");
}

test("this package's own dependencies are installed as its lock file says", async () => {
  assert.deepEqual(await dependencyProblems(packageRoot), []);
});

test("complete dependencies are left alone: nothing is installed", async (t) => {
  const root = await fakePackage(t);
  await place(root, "pg", "8.0.0");
  await place(root, binariesPackage, "18.0.0");
  let installs = 0;
  assert.deepEqual(await ensureDependencies(root, { install: () => { installs += 1; } }), { installed: false });
  assert.equal(installs, 0);
});

test("a missing or wrong-version dependency is installed once, then checked again", async (t) => {
  const root = await fakePackage(t);
  await place(root, "pg", "7.9.0");
  assert.deepEqual(await dependencyProblems(root), ["pg is 7.9.0, locked 8.0.0", binariesPackage + " is not installed"]);
  const notices = [];
  let installs = 0;
  const result = await ensureDependencies(root, {
    notify: (line) => notices.push(line),
    install: async () => {
      installs += 1;
      await place(root, "pg", "8.0.0");
      await place(root, binariesPackage, "18.0.0");
    },
  });
  assert.deepEqual(result, { installed: true });
  assert.equal(installs, 1);
  assert.match(notices[0], /pg is 7\.9\.0, locked 8\.0\.0/);
});

test("an install that leaves a binary missing fails, naming it", async (t) => {
  const root = await fakePackage(t);
  await place(root, "pg", "8.0.0");
  await place(root, binariesPackage, "18.0.0", { binaries: ["initdb", "pg_ctl"] });
  assert.deepEqual(await dependencyProblems(root), ["the postgres binary of " + binariesPackage + " is missing"]);
  await assert.rejects(ensureDependencies(root, { install: () => {} }), /not complete after installing: the postgres binary/);
});

test("a dependency the lock file does not name is reported, not guessed", async (t) => {
  const root = await fakePackage(t);
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fake-bridge", dependencies: { pg: "8.0.0", extra: "1.0.0" } }));
  await place(root, "pg", "8.0.0");
  await place(root, binariesPackage, "18.0.0");
  assert.deepEqual(await dependencyProblems(root), ["extra is not in package-lock.json"]);
});

test("a machine with no packaged PostgreSQL binaries is reported by name", async (t) => {
  const root = await fakePackage(t);
  assert.deepEqual(await dependencyProblems(root, { platform: "win32", arch: "ia32" }), ["no PostgreSQL binaries are packaged for win32-ia32"]);
});

test("npm is found next to this Node and run without a shell", () => {
  const entry = npmEntry({ env: {} });
  assert.match(entry, /npm-cli\.js$/);
  assert.ok(fs.existsSync(entry));
  assert.throws(() => npmEntry({ env: {}, execPath: path.join(os.tmpdir(), "no-node-here", "node") }), /npm was not found/);
});
