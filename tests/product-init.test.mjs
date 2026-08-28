import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridge = path.join(packageRoot, "bridge.mjs");

test("init fails closed with one readable line when release integrity is damaged", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-integrity-target-"));
  const damagedPackage = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-integrity-package-"));
  t.after(() => Promise.all([
    fsp.rm(root, { recursive: true, force: true }),
    fsp.rm(damagedPackage, { recursive: true, force: true }),
  ]));
  await fsp.cp(packageRoot, damagedPackage, { recursive: true });
  await fsp.appendFile(path.join(damagedPackage, "README.md"), "\ndamaged after packaging\n", "utf8");

  const result = spawnSync(process.execPath, [path.join(damagedPackage, "bridge.mjs"), "init", "--target", root, "--yes"], {
    cwd: damagedPackage,
    encoding: "utf8",
    env: process.env,
    windowsHide: true,
  });

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), "Review Bridge init failed closed: Release integrity check failed. Download and extract a fresh package.");
  assert.equal(await fsp.stat(path.join(root, ".claude")).catch(() => null), null);
});

test("human init approval shows actionable scope without exposing internal checksum", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-human-init-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "clean-vue-app",
    private: true,
    dependencies: { vue: "latest" },
    devDependencies: { typescript: "latest", vite: "latest" },
  }, null, 2) + "\n", "utf8");

  const result = spawnSync(process.execPath, [bridge, "init", "--target", root], {
    cwd: packageRoot,
    encoding: "utf8",
    env: process.env,
    input: "n\n",
    windowsHide: true,
  });

  assert.equal(result.status, 2);
  assert.match(result.stdout, new RegExp(`Target workspace: ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(result.stdout, /Operation: install/);
  assert.match(result.stdout, /Detected profile: Vue and TypeScript frontend \(vue-frontend\)/);
  assert.doesNotMatch(result.stdout, /SHA-?256|plan_sha256|[0-9a-f]{64}/i);
  assert.match(result.stdout, /Planned changes:/);
  assert.match(result.stdout, /PASS, FAIL_THEN_PASS, HARD_STOP, and RATE_LIMIT with fake CLIs/);
  assert.match(result.stderr, /Installation cancelled by user/);
  assert.equal(await fsp.stat(path.join(root, ".claude")).catch(() => null), null);
});

test("R5 init keeps self-test artifacts disposable and installs TEMPLATE.md", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-product-init-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "clean-vite-vue-ts",
    private: true,
    scripts: { build: "vite build", typecheck: "vue-tsc --noEmit" },
    dependencies: { vue: "latest" },
    devDependencies: { typescript: "latest", vite: "latest" },
  }, null, 2) + "\n", "utf8");
  await fsp.writeFile(path.join(root, "README.md"), "# Clean Vue workspace\n", "utf8");

  const result = spawnSync(process.execPath, [bridge, "init", "--target", root, "--yes"], {
    cwd: packageRoot,
    encoding: "utf8",
    env: process.env,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.profile, "vue-frontend");
  assert.equal(output.workspace_mode, "snapshot");
  assert.equal(output.git_required, false);
  assert.deepEqual(output.fake_self_tests, [
    { scenario: "PASS", status: "pass" },
    { scenario: "FAIL_THEN_PASS", status: "pass" },
    { scenario: "HARD_STOP", status: "hard_stop" },
    { scenario: "RATE_LIMIT", status: "rate_limited" },
  ]);
  await fsp.access(path.join(root, ".claude", "review-bridge-install.json"));
  assert.deepEqual(await fsp.readdir(path.join(root, ".claude", "work-packages")), ["TEMPLATE.md"]);
  const queueEntries = await fsp.readdir(path.join(root, ".claude", "review-queue"), { withFileTypes: true });
  assert.deepEqual(queueEntries.filter((entry) => entry.isFile()).map((entry) => entry.name), []);
});
