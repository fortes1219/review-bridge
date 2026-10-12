import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(root, "installer", "install.mjs");
const backupRoots = new Map();

function run(args, options = {}) {
  return spawnSync(process.execPath, [installer, ...args], {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function fixture(kind, { ignored = true, settings = null, commit = true } = {}) {
  const target = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-" + kind + "-"));
  execFileSync("git", ["init"], { cwd: target, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: target });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: target });
  await fsp.writeFile(path.join(target, ".gitignore"), ignored ? ".claude/\n" : "dist/\n", "utf8");
  await fsp.writeFile(path.join(target, "AGENTS.md"), "# Fixture\n", "utf8");
  if (kind === "rust") {
    await fsp.writeFile(path.join(target, "Cargo.toml"), "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\nedition = \"2024\"\n\n[dependencies]\ntokio = \"1\"\n", "utf8");
  } else {
    await writeJson(path.join(target, "package.json"), {
      private: true,
      scripts: { lint: "eslint .", "test:run": "vitest run", build: "vite build" },
      dependencies: { vue: "latest", zod: "latest" },
      devDependencies: { typescript: "latest", vite: "latest", vitest: "latest" },
    });
  }
  if (settings) await writeJson(path.join(target, ".claude", "settings.local.json"), settings);
  if (commit) {
    execFileSync("git", ["add", "."], { cwd: target });
    execFileSync("git", ["commit", "-m", "fixture"], { cwd: target, stdio: "ignore" });
  }
  return target;
}

async function profileFixture(files) {
  const target = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-profile-"));
  execFileSync("git", ["init"], { cwd: target, stdio: "ignore" });
  await fsp.writeFile(path.join(target, ".gitignore"), ".claude/\n", "utf8");
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(target, relative);
    await fsp.mkdir(path.dirname(absolute), { recursive: true });
    if (typeof content === "string") await fsp.writeFile(absolute, content, "utf8");
    else await writeJson(absolute, content);
  }
  return target;
}

async function workingFiles(target, relative = "") {
  const directory = path.join(target, relative);
  const result = [];
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    if (!relative && entry.name === ".git") continue;
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...await workingFiles(target, next));
    else if (entry.isFile()) result.push(next.replaceAll("\\", "/"));
  }
  return result.sort();
}

function backupRootFor(target) {
  if (!backupRoots.has(target)) backupRoots.set(target, target + "-bridge-backups");
  return backupRoots.get(target);
}

async function removeFixture(target) {
  await fsp.rm(target, { recursive: true, force: true });
  await fsp.rm(backupRootFor(target), { recursive: true, force: true });
}

async function createPlan(target, profile, operation = "install", extra = [], executionMode = "fake") {
  const planPath = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-plan-")), "plan.json");
  const result = run([
    "plan", "--target", target, "--profile", profile, "--operation", operation,
    "--backup-root", backupRootFor(target), "--out", planPath, "--json",
    ...(executionMode === "fake" ? ["--fake-cli"] : []), ...extra,
  ]);
  if (!(await fsp.stat(planPath).catch(() => null))) {
    throw new Error("Plan was not written: " + (result.stderr || result.stdout));
  }
  const plan = JSON.parse(await fsp.readFile(planPath, "utf8"));
  return { result, planPath, plan };
}

async function applyPlan(command, target, planPath, plan, options = {}) {
  return run([command, "--target", target, "--plan", planPath, "--approve", plan.plan_sha256], options);
}

test("Rust lifecycle is checksum-gated and seeds inactive v4 state", async (t) => {
  const target = await fixture("rust");
  t.after(() => removeFixture(target));
  const beforeFiles = await workingFiles(target);
  const install = await createPlan(target, "rust-backend");
  assert.equal(install.result.status, 0, install.result.stderr);
  assert.equal(install.plan.detection.capabilities.includes("tokio"), true);
  const wrong = run(["apply", "--target", target, "--plan", install.planPath, "--approve", "0".repeat(64)]);
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /checksum/i);
  const applied = await applyPlan("apply", target, install.planPath, install.plan);
  assert.equal(applied.status, 0, applied.stderr);
  const bridgeConfig = JSON.parse(await fsp.readFile(path.join(target, ".claude", "review-bridge", "bridge.json"), "utf8"));
  assert.equal(bridgeConfig.schema_version, 4);
  assert.equal(bridgeConfig.active_runs, "derive_from_run_projections");
  await assert.rejects(fsp.access(path.join(target, ".claude", "review-queue", "CONTROL.json")));
  const policy = JSON.parse(await fsp.readFile(path.join(target, ".claude", "review-bridge", "policy.override.json"), "utf8"));
  const escalationPatterns = policy.classification.rules.flatMap((rule) => rule.any);
  assert.equal(escalationPatterns.includes("rust"), false);
  assert.equal(escalationPatterns.includes("tokio"), false);
  const verify = run(["verify", "--target", target]);
  assert.equal(verify.status, 0, verify.stderr);
  const upgrade = await createPlan(target, "rust-backend", "upgrade");
  assert.equal(upgrade.result.status, 0, upgrade.result.stderr);
  assert.equal((await applyPlan("upgrade", target, upgrade.planPath, upgrade.plan)).status, 0);
  const uninstall = await createPlan(target, "rust-backend", "uninstall");
  assert.equal(uninstall.result.status, 0, uninstall.result.stderr);
  const removed = await applyPlan("uninstall", target, uninstall.planPath, uninstall.plan);
  assert.equal(removed.status, 0, removed.stderr);
  await assert.rejects(fsp.access(path.join(target, ".claude", "review-bridge-install.json")));
  const afterUninstall = await workingFiles(target);
  assert.deepEqual(
    afterUninstall.filter((file) =>
      !file.startsWith(".claude/review-bridge/policy-snapshots/")
      && !file.startsWith(".claude/review-queue/upgrade-reports/")),
    beforeFiles,
  );
  assert.equal(
    afterUninstall.filter((file) => file.startsWith(".claude/review-bridge/policy-snapshots/")).length,
    1,
  );
  assert.equal(
    afterUninstall.filter((file) => file.startsWith(".claude/review-queue/upgrade-reports/")).length,
    1,
  );
});

test("Vue install structurally preserves permissions and unrelated hooks", async (t) => {
  const unrelated = { type: "command", command: "node existing-hook.mjs", timeout: 10 };
  const target = await fixture("vue", {
    settings: {
      permissions: { allow: ["Read", "Bash(npm run lint)"] },
      custom: { keep: true },
      hooks: { Stop: [{ hooks: [unrelated] }] },
    },
  });
  t.after(() => removeFixture(target));
  const install = await createPlan(target, "vue-frontend");
  assert.equal(install.result.status, 0, install.result.stderr);
  // T0-06: the profile rule `npm test` joins the script candidates in the detection summary.
  assert.deepEqual(install.plan.detection.verification_commands, ["npm run lint", "npm run test:run", "npm run build", "npm test"]);
  const applied = await applyPlan("apply", target, install.planPath, install.plan);
  assert.equal(applied.status, 0, applied.stderr);
  const settings = JSON.parse(await fsp.readFile(path.join(target, ".claude", "settings.local.json"), "utf8"));
  assert.deepEqual(settings.permissions.allow, ["Read", "Bash(npm run lint)"]);
  assert.equal(settings.custom.keep, true);
  assert.equal(settings.hooks.Stop.flatMap((group) => group.hooks || []).some((hook) => hook.command === unrelated.command), true);
  assert.equal(settings.hooks.Stop.flatMap((group) => group.hooks || []).filter((hook) => hook.command?.includes("review-bridge")).length, 1);
});

test("Vue install works in a workspace with no Git repository or ignore file", async (t) => {
  const target = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-vue-no-git-"));
  t.after(() => removeFixture(target));
  await writeJson(path.join(target, "package.json"), {
    name: "clean-vite-vue-ts",
    private: true,
    scripts: { build: "vite build", typecheck: "vue-tsc --noEmit" },
    dependencies: { vue: "latest" },
    devDependencies: { typescript: "latest", vite: "latest" },
  });
  await fsp.writeFile(path.join(target, "README.md"), "# Clean Vue workspace\n", "utf8");

  const install = await createPlan(target, "auto", "install", ["--fake-cli"]);
  assert.equal(install.result.status, 0, install.result.stderr);
  assert.equal(install.plan.profile.id, "vue-frontend");
  assert.equal(install.plan.target.workspace_mode, "snapshot");
  assert.equal(install.plan.target.git_repository, false);
  assert.equal(install.plan.target.git_root, null);
  assert.equal(install.plan.target.head, null);
  assert.equal(install.plan.observations.claude_private_boundary_ignored, null);
  assert.equal(install.plan.findings.some((entry) => entry.code === "PRIVATE_BOUNDARY_MISSING"), false);

  const applied = await applyPlan("apply", target, install.planPath, install.plan);
  assert.equal(applied.status, 0, applied.stderr);
  const verify = run(["verify", "--target", target, "--fake-cli"]);
  assert.equal(verify.status, 0, verify.stderr);
});

test("auto profile registry recognizes common backend and frontend stacks", async (t) => {
  const cases = [
    {
      id: "rust-backend",
      files: { "Cargo.toml": "[package]\nname='fixture'\nversion='0.1.0'\n[dependencies]\ntokio='1'\n" },
      capability: "tokio",
      verification: "cargo test --workspace",
    },
    {
      id: "vue-frontend",
      files: { "package.json": { scripts: { typecheck: "vue-tsc --noEmit" }, dependencies: { vue: "3" }, devDependencies: { typescript: "5" } } },
      capability: "vue",
      verification: "npm run typecheck",
    },
    {
      id: "node-backend",
      files: { "package.json": { scripts: { test: "node --test" }, dependencies: { express: "5" } } },
      capability: "express",
      verification: "npm run test",
    },
    {
      id: "go-backend",
      files: { "go.mod": "module example.invalid/fixture\n\ngo 1.24\n\nrequire github.com/gin-gonic/gin v1.10.0\n" },
      capability: "gin",
      verification: "go test ./...",
    },
    {
      id: "python-backend",
      files: { "pyproject.toml": "[project]\ndependencies = ['fastapi', 'pytest']\n" },
      capability: "fastapi",
      verification: null,
    },
    {
      id: "java-backend",
      files: { "pom.xml": "<project><dependencies><dependency>spring-boot</dependency></dependencies></project>" },
      capability: "spring-boot",
      verification: "mvn test",
    },
    {
      id: "php-laravel",
      files: {
        "artisan": "#!/usr/bin/env php\n",
        "composer.json": { require: { "laravel/framework": "^12" }, scripts: { test: "phpunit" } },
      },
      capability: "laravel",
      verification: "php artisan test",
    },
    {
      id: "dotnet-backend",
      files: { "Fixture.csproj": "<Project Sdk=\"Microsoft.NET.Sdk.Web\"></Project>" },
      capability: null,
      verification: "dotnet test",
    },
  ];

  for (const expected of cases) {
    await t.test(expected.id, async (t) => {
      const target = await profileFixture(expected.files);
      t.after(() => removeFixture(target));
      const planned = await createPlan(target, "auto");
      assert.equal(planned.result.status, 0, planned.result.stderr);
      assert.equal(planned.plan.profile.id, expected.id);
      if (expected.capability) assert.equal(planned.plan.detection.capabilities.includes(expected.capability), true);
      if (expected.verification) assert.equal(planned.plan.detection.verification_commands.includes(expected.verification), true);
    });
  }
});

test("auto profile detection fails closed for a mixed-stack repository", async (t) => {
  const target = await profileFixture({
    "Cargo.toml": "[package]\nname='fixture'\nversion='0.1.0'\n",
    "package.json": { dependencies: { vue: "3" } },
  });
  t.after(() => removeFixture(target));
  const planPath = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-plan-")), "plan.json");
  const result = run([
    "plan", "--target", target, "--profile", "auto", "--operation", "install",
    "--backup-root", backupRootFor(target), "--out", planPath,
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /ambiguous/i);
  await assert.rejects(fsp.access(planPath));
});

test("planning fails closed when .claude is not ignored", async (t) => {
  const target = await fixture("rust", { ignored: false });
  t.after(() => removeFixture(target));
  const planned = await createPlan(target, "rust-backend");
  assert.equal(planned.result.status, 2);
  assert.equal(planned.plan.findings.some((finding) => finding.code === "PRIVATE_BOUNDARY_MISSING"), true);
});

test("an approved plan becomes stale after installer-relevant target changes", async (t) => {
  const target = await fixture("vue");
  t.after(() => removeFixture(target));
  const planned = await createPlan(target, "vue-frontend");
  assert.equal(planned.result.status, 0, planned.result.stderr);
  await writeJson(path.join(target, ".claude", "settings.local.json"), { permissions: { allow: ["Read"] } });
  const result = await applyPlan("apply", target, planned.planPath, planned.plan);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /state changed/i);
  await assert.rejects(fsp.access(path.join(target, ".claude", "review-bridge-install.json")));
});

test("an unborn Git repository can be planned and installed", async (t) => {
  const target = await fixture("rust", { commit: false });
  t.after(() => removeFixture(target));
  const planned = await createPlan(target, "rust-backend");
  assert.equal(planned.result.status, 0, planned.result.stderr);
  assert.equal(planned.plan.target.head, null);
  const applied = await applyPlan("apply", target, planned.planPath, planned.plan);
  assert.equal(applied.status, 0, applied.stderr);
});

test("upgrade and uninstall preserve v4 runtime audit state", async (t) => {
  const target = await fixture("rust");
  t.after(() => removeFixture(target));
  const install = await createPlan(target, "rust-backend");
  assert.equal((await applyPlan("apply", target, install.planPath, install.plan)).status, 0);
  const runPath = path.join(target, ".claude", "review-queue", "runs", "fixture-run.json");
  await writeJson(runPath, { schema_version: 4, run_id: "fixture-run", status: "pass" });
  const upgrade = await createPlan(target, "rust-backend", "upgrade");
  assert.equal((await applyPlan("upgrade", target, upgrade.planPath, upgrade.plan)).status, 0);
  assert.equal((JSON.parse(await fsp.readFile(runPath, "utf8"))).status, "pass");
  const uninstall = await createPlan(target, "rust-backend", "uninstall");
  const removed = await applyPlan("uninstall", target, uninstall.planPath, uninstall.plan);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal((JSON.parse(await fsp.readFile(runPath, "utf8"))).status, "pass");
});

test("a mid-transaction failure restores the exact pre-install file set", async (t) => {
  const target = await fixture("vue", { settings: { permissions: { allow: ["Read"] } } });
  t.after(() => removeFixture(target));
  const beforeFiles = await workingFiles(target);
  const beforeSettings = await fsp.readFile(path.join(target, ".claude", "settings.local.json"), "utf8");
  const planned = await createPlan(target, "vue-frontend");
  const result = await applyPlan("apply", target, planned.planPath, planned.plan, {
    env: { ...process.env, REVIEW_BRIDGE_INSTALLER_TEST_FAULT: "after-write" },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /rolled back/i);
  assert.deepEqual(await workingFiles(target), beforeFiles);
  assert.equal(await fsp.readFile(path.join(target, ".claude", "settings.local.json"), "utf8"), beforeSettings);
  await assert.rejects(fsp.access(backupRootFor(target)));
});

test("an unmanaged bridge hook requires explicit adoption in the approved plan", async (t) => {
  const target = await fixture("rust", {
    settings: { hooks: { Stop: [{ hooks: [{ type: "command", command: "node .claude/tools/review-bridge/bootstrap.mjs enqueue", timeout: 30 }] }] } },
  });
  t.after(() => removeFixture(target));
  const blocked = await createPlan(target, "rust-backend");
  assert.equal(blocked.result.status, 2);
  assert.equal(blocked.plan.findings.some((finding) => finding.code === "UNMANAGED_BRIDGE_HOOK"), true);
  const adopted = await createPlan(target, "rust-backend", "install", ["--adopt-existing"]);
  assert.equal(adopted.result.status, 0, adopted.result.stderr);
  assert.equal((await applyPlan("apply", target, adopted.planPath, adopted.plan)).status, 0);
});

test("adoption preserves a custom runtime review prompt as a project-owned override", async (t) => {
  const target = await fixture("rust", {
    settings: { hooks: { Stop: [{ hooks: [{ type: "command", command: "node .claude/tools/review-bridge/bootstrap.mjs enqueue", timeout: 30 }] }] } },
  });
  t.after(() => removeFixture(target));
  const customPrompt = "# Project Review Policy\n\nKeep project-specific guardrails.\n";
  const runtimeRoot = path.join(target, ".claude", "tools", "review-bridge");
  await fsp.mkdir(runtimeRoot, { recursive: true });
  await fsp.writeFile(path.join(runtimeRoot, "review-prompt.md"), customPrompt, "utf8");

  const adopted = await createPlan(target, "rust-backend", "install", ["--adopt-existing"]);
  assert.equal(adopted.result.status, 0, adopted.result.stderr);
  assert.equal(adopted.plan.project_prompt.preserve_existing_runtime_prompt, true);
  const applied = await applyPlan("apply", target, adopted.planPath, adopted.plan);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(
    await fsp.readFile(path.join(target, ".claude", "review-bridge", "review-prompt.md"), "utf8"),
    customPrompt,
  );
  assert.notEqual(
    await fsp.readFile(path.join(target, ".claude", "tools", "review-bridge", "review-prompt.md"), "utf8"),
    customPrompt,
  );
  const verify = run(["verify", "--target", target]);
  assert.equal(verify.status, 0, verify.stderr);

  const rollbackPlan = await createPlan(target, "rust-backend", "rollback");
  assert.equal(rollbackPlan.result.status, 0, rollbackPlan.result.stderr);
  const restored = await applyPlan("rollback", target, rollbackPlan.planPath, rollbackPlan.plan);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(await fsp.readFile(path.join(runtimeRoot, "review-prompt.md"), "utf8"), customPrompt);
  await assert.rejects(fsp.access(path.join(target, ".claude", "review-bridge", "review-prompt.md")));
  await assert.rejects(fsp.access(path.join(target, ".claude", "review-bridge-install.json")));
});

test("rollback restores the exact pre-install state and removes later runtime artifacts", async (t) => {
  const originalSettings = {
    permissions: { allow: ["Read"] },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "node legacy-review-bridge.mjs", timeout: 12 }] }] },
  };
  const target = await fixture("vue", { settings: originalSettings });
  t.after(() => removeFixture(target));
  await writeJson(path.join(target, ".claude", "review-queue", "done", "preexisting.json"), { keep: true });
  const beforeFiles = await workingFiles(target);
  const beforeSettings = await fsp.readFile(path.join(target, ".claude", "settings.local.json"), "utf8");
  const beforeQueue = await fsp.readFile(path.join(target, ".claude", "review-queue", "done", "preexisting.json"), "utf8");

  const install = await createPlan(target, "vue-frontend", "install", ["--adopt-existing"]);
  assert.equal(install.result.status, 0, install.result.stderr);
  const applied = await applyPlan("apply", target, install.planPath, install.plan);
  assert.equal(applied.status, 0, applied.stderr);
  const appliedOutput = JSON.parse(applied.stdout);
  assert.equal(typeof appliedOutput.persistent_snapshot.snapshot_id, "string");

  await writeJson(path.join(target, ".claude", "review-queue", "done", "post-install.json"), { remove: true });
  await fsp.writeFile(path.join(target, ".claude", "reviews", "post-install-codex-review.md"), "remove\n", "utf8");
  const rollbackPlan = await createPlan(target, "vue-frontend", "rollback");
  assert.equal(rollbackPlan.result.status, 0, rollbackPlan.result.stderr);
  const restored = await applyPlan("rollback", target, rollbackPlan.planPath, rollbackPlan.plan);
  assert.equal(restored.status, 0, restored.stderr);
  assert.deepEqual(await workingFiles(target), beforeFiles);
  assert.equal(await fsp.readFile(path.join(target, ".claude", "settings.local.json"), "utf8"), beforeSettings);
  assert.equal(await fsp.readFile(path.join(target, ".claude", "review-queue", "done", "preexisting.json"), "utf8"), beforeQueue);
  await assert.rejects(fsp.access(path.join(target, ".claude", "review-bridge-install.json")));
});

test("a corrupt persistent snapshot fails closed without changing the installed target", async (t) => {
  const target = await fixture("vue", { settings: { permissions: { allow: ["Read"] } } });
  t.after(() => removeFixture(target));
  const install = await createPlan(target, "vue-frontend");
  assert.equal((await applyPlan("apply", target, install.planPath, install.plan)).status, 0);
  const installedFiles = await workingFiles(target);
  const installedSettings = await fsp.readFile(path.join(target, ".claude", "settings.local.json"), "utf8");
  const manifest = JSON.parse(await fsp.readFile(path.join(target, ".claude", "review-bridge-install.json"), "utf8"));
  const point = manifest.rollback_points.at(-1);
  const targetDirectories = await fsp.readdir(point.backup_root, { withFileTypes: true });
  const targetDirectory = targetDirectories.find((entry) => entry.isDirectory());
  assert.ok(targetDirectory);
  const snapshotSettings = path.join(point.backup_root, targetDirectory.name, point.snapshot_id, "data", ".claude", "settings.local.json");
  await fsp.appendFile(snapshotSettings, " ", "utf8");

  const rollbackPlan = await createPlan(target, "vue-frontend", "rollback");
  assert.equal(rollbackPlan.result.status, 0, rollbackPlan.result.stderr);
  const result = await applyPlan("rollback", target, rollbackPlan.planPath, rollbackPlan.plan);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /data checksum mismatch/i);
  assert.deepEqual(await workingFiles(target), installedFiles);
  assert.equal(await fsp.readFile(path.join(target, ".claude", "settings.local.json"), "utf8"), installedSettings);
  assert.equal(await fsp.access(path.join(target, ".claude", "review-bridge-install.json")), undefined);
});
