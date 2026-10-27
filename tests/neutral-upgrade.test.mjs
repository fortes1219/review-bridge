// Keeps the person's database out of these tests (see the fixture).
import "../review-bridge/tests/fixtures/isolatedDataHome.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  applyNeutralInstall, applyNeutralUpgrade, applyNeutralUpgradeRollback, formatUpgradePlan, formatUpgradeRollbackPlan,
  loadInstalledServiceModules, MAINTENANCE_MARKER, planNeutralInstall, planNeutralUpgrade, planNeutralUpgradeRollback, PROOF_LOSS_LINE, TRANSIENT_FILES,
  verifyNeutralInstall,
} from "../installer/neutral-install.mjs";
import { policyIdentity } from "../review-bridge/service/index.mjs";

// Bridge itself is upgraded in its own folder by the install Guide; every project already runs that
// runtime. These tests cover what is left per project: its settings, its template, authorizations
// bound to the old default policy, and the tools/ copy an older setup left in the project.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridge = path.join(packageRoot, "bridge.mjs");
const sourceRuntime = path.join(packageRoot, "review-bridge");
const sourceBootstrap = path.join(sourceRuntime, "bootstrap.mjs");
const sourceModule = (relative) => pathToFileURL(path.join(sourceRuntime, ...relative.split("/"))).href;

// Every default backup root points into a temporary folder; nothing touches the real user profile.
// One default backup root per test process. Test files that share a process (--test-isolation=none)
// set LOCALAPPDATA to the same value, and it goes only when the process exits (Codex 2026-10-15).
const defaultBase = path.join(os.tmpdir(), "rb-default-backups-" + process.pid);
await fsp.mkdir(defaultBase, { recursive: true });
process.env.LOCALAPPDATA = defaultBase;
process.env.XDG_DATA_HOME = defaultBase;
if (process.platform === "darwin") process.env.HOME = defaultBase;
process.on("exit", () => fs.rmSync(defaultBase, { recursive: true, force: true }));
const childEnv = { ...process.env };

const sha = (data) => createHash("sha256").update(data).digest("hex");
const exists = async (file) => Boolean(await fsp.stat(file).catch(() => null));
const readJson = async (file) => JSON.parse(await fsp.readFile(file, "utf8"));
const writeJson = (file, value) => fsp.writeFile(file, JSON.stringify(value, null, 2) + "\n");
const privateOf = (root) => path.join(root, ".review-bridge");
const legacyOf = (root) => path.join(root, ".review-bridge", "tools", "review-bridge");
const markerOf = (root) => path.join(root, ".review-bridge", ...MAINTENANCE_MARKER.split("/"));
const lockOf = (root) => path.join(root, ".review-bridge-install.lock");

async function workspace(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rb-upgrade-"));
  t.after(async () => {
    spawnSync(process.execPath, [sourceBootstrap, "down"], { cwd: root, windowsHide: true, stdio: "ignore" });
    await fsp.rm(root, { recursive: true, force: true });
  });
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "vue-test", dependencies: { vue: "latest" }, devDependencies: { vite: "latest" } }));
  await fsp.writeFile(path.join(root, "README.md"), "# demo\n");
  await fsp.mkdir(path.join(root, ".claude"));
  await fsp.writeFile(path.join(root, ".claude", "settings.local.json"), "{\"hooks\":{}}\n");
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: root, windowsHide: true }).status, 0);
  return root;
}

async function install(root) {
  const plan = await planNeutralInstall({ target: root, roles: { writer: "claude", reviewer: "codex" } });
  await applyNeutralInstall(plan, plan.plan_sha256);
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function installWithService(root) {
  const result = spawnSync(process.execPath, [bridge, "init", "--target", root, "--writer", "claude", "--reviewer", "codex", "--yes", "--fake-cli", "--port", String(await freePort())], {
    cwd: packageRoot, encoding: "utf8", windowsHide: true, env: childEnv, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await serviceRunning(root), true, "init should leave the page service running");
}

async function serviceCheck(root) {
  const modules = await loadInstalledServiceModules(sourceRuntime);
  return await modules.service.checkService(modules.getBridgePaths(root, sourceRuntime, { privateRootName: ".review-bridge" }));
}

async function serviceRunning(root) {
  return (await serviceCheck(root)).running === true;
}

async function tree(root) {
  const files = new Map();
  async function visit(directory, prefix = "") {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const name = prefix ? prefix + "/" + entry.name : entry.name;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), name);
      else files.set(name, sha(await fsp.readFile(path.join(directory, entry.name))));
    }
  }
  await visit(root);
  return files;
}

// A copy of the runtime with another default policy: what an older Bridge ran with.
async function oldPolicyRuntime(t) {
  const copy = await fsp.mkdtemp(path.join(os.tmpdir(), "rb-old-runtime-"));
  t.after(() => fsp.rm(copy, { recursive: true, force: true }));
  await fsp.cp(sourceRuntime, copy, { recursive: true, filter: (source) => !source.startsWith(path.join(sourceRuntime, "tests")) });
  const policyFile = path.join(copy, "config", "default-policy.json");
  const defaults = await readJson(policyFile);
  defaults.package_policy_id += "-old";
  await writeJson(policyFile, defaults);
  return copy;
}

// "Set up by an older Bridge": the install record names another runtime and version (and, if
// asked, another default policy), bridge.json is from before active_runs existed, and, if asked,
// the older setup's tools/ copy is in the project. The record follows, so it still verifies.
async function makeOld(root, { policy = null, legacy = false } = {}) {
  const configFile = path.join(privateOf(root), "review-bridge", "bridge.json");
  const config = await readJson(configFile);
  delete config.active_runs;
  // Installs made before the rename still carry this key.
  config.state_contract = "v4";
  await writeJson(configFile, config);
  const installFile = path.join(privateOf(root), "review-bridge-install.json");
  const manifest = await readJson(installFile);
  manifest.runtime_sha256 = sha("an older runtime " + randomUUID());
  manifest.bridge_version = "0.1.0-old";
  if (policy) manifest.policy_identity = policyIdentity(await readJson(path.join(policy, "config", "default-policy.json")));
  const installed = new Map(manifest.installed_files);
  if (legacy) {
    await fsp.cp(sourceRuntime, legacyOf(root), { recursive: true });
    for (const [name, hash] of await tree(legacyOf(root))) installed.set("tools/review-bridge/" + name, hash);
  }
  installed.set("review-bridge/bridge.json", sha(await fsp.readFile(configFile)));
  manifest.installed_files = [...installed].sort((left, right) => left[0].localeCompare(right[0]));
  await writeJson(installFile, manifest);
}

// Persistent data only: the transient files of the page service and the transaction are left out.
async function persistent(root) {
  const files = await tree(privateOf(root));
  for (const name of TRANSIENT_FILES) files.delete(name);
  return files;
}

function sameTree(actual, expected, label) {
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort(), label + ": the set of files");
  for (const [name, hash] of expected) assert.equal(actual.get(name), hash, label + ": " + name);
}

async function addUserData(root) {
  const privateRoot = privateOf(root);
  await fsp.writeFile(path.join(privateRoot, "work-packages", "farm.md"), "# Work order: farm\n");
  await fsp.writeFile(path.join(privateRoot, "work-packages", "farm.result.md"), "# 已交付\n");
  await fsp.mkdir(path.join(privateRoot, "archive"), { recursive: true });
  await fsp.writeFile(path.join(privateRoot, "archive", "2026-10-14.jsonl"), "{\"type\":\"run\"}\n");
  await fsp.appendFile(path.join(privateRoot, "review-bridge", "rules.md"), "\n不要動測試。\n");
  await fsp.appendFile(path.join(privateRoot, "work-packages", "TEMPLATE.md"), "\n<!-- 我的欄位 -->\n");
  const configPath = path.join(privateRoot, "review-bridge", "bridge.json");
  const config = await readJson(configPath);
  config.retention = { days: 20 };
  config.locale = "en";
  await writeJson(configPath, config);
}

function bootstrapRun(root, args, expected = 0) {
  const result = spawnSync(process.execPath, [sourceBootstrap, ...args], {
    cwd: root, encoding: "utf8", windowsHide: true, env: childEnv, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, expected, [args[0], result.stdout, result.stderr].join("\n"));
  return result;
}

// One fake work package through the CLI, the same way init's self-test runs it.
async function fakeRun(root, id) {
  const planPath = path.join(privateOf(root), "review-queue", id + ".plan.json");
  const taskPath = path.join(privateOf(root), "work-packages", id + ".md");
  // A work order with something to check; one without stops at translation and asks the human.
  await fsp.writeFile(taskPath, "# Update the README\n\n<!-- bridge:requested_work -->\nUpdate README.md only.\n\n<!-- bridge:acceptance -->\n## Acceptance\n\n- README.md says hello.\n");
  bootstrapRun(root, ["work-plan", "--task-file", taskPath, "--owner", "o", "--work-package", id, "--breakpoint", "b",
    "--allow-paths", "README.md", "--rounds", "2", "--call-timeout", "60000", "--out", planPath]);
  const started = bootstrapRun(root, ["work-start", "--plan", planPath, "--yes", "--fake-cli", "--fake-scenario", "PASS", "--json"]);
  assert.equal(JSON.parse(started.stdout).latest_state.status, "pass");
}

async function upgrade(root, hooks = {}, { backupRoot = null } = {}) {
  const plan = await planNeutralUpgrade({ target: root, backupRoot });
  return { plan, result: await applyNeutralUpgrade(plan, plan.plan_sha256, hooks) };
}

async function rollback(root, hooks = {}) {
  const plan = await planNeutralUpgradeRollback({ target: root });
  return { plan, result: await applyNeutralUpgradeRollback(plan, plan.plan_sha256, hooks) };
}

// A real crash: a child process runs the upgrade and exits at the named hook with no cleanup; its
// install lock is left behind with its (now gone) pid.
function crashAt(root, hook) {
  const script = [
    "const m = await import(process.env.RB_MODULE);",
    "const plan = await m.planNeutralUpgrade({ target: process.env.RB_TARGET });",
    "await m.applyNeutralUpgrade(plan, plan.plan_sha256, { [process.env.RB_HOOK]: async () => process.exit(9) });",
    "process.exit(0);",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", windowsHide: true,
    env: { ...childEnv, RB_MODULE: pathToFileURL(path.join(packageRoot, "installer", "neutral-install.mjs")).href, RB_TARGET: root, RB_HOOK: hook },
  });
  assert.equal(result.status, 9, "the child should exit at " + hook + ": " + result.stderr);
}

async function workApi(root, runtimeRoot = sourceRuntime) {
  const { getBridgePaths } = await import(sourceModule("utils/paths.mjs"));
  return {
    paths: getBridgePaths(root, runtimeRoot, { privateRootName: ".review-bridge" }),
    ...(await import(sourceModule("features/workOrder/workPackage.mjs"))),
    ...(await import(sourceModule("service/records/runStore.mjs"))),
    ...(await import(sourceModule("service/records/policySnapshots.mjs"))),
  };
}

async function makePlan(api, id) {
  return await api.createWorkPackagePlan({
    paths: api.paths, task: "Update README.md only.", owner: "o", workPackage: id, breakpoint: "b",
    allowedPaths: "README.md", rounds: 1, callTimeout: 60_000, outPath: path.join(api.paths.queueRoot, id + ".plan.json"),
  });
}

test("a project set up now holds no runtime and is already up to date", async (t) => {
  const root = await workspace(t);
  await install(root);
  assert.equal(await exists(path.join(privateOf(root), "tools")), false);
  assert.equal((await planNeutralUpgrade({ target: root })).up_to_date, true);
});

test("W1 upgrade merges the settings, removes the old tools/ copy, keeps every user file and editable setting, and work still runs", async (t) => {
  const root = await workspace(t);
  await install(root);
  await makeOld(root, { legacy: true });
  await fakeRun(root, "before-upgrade");
  await addUserData(root);
  const before = await persistent(root);
  const { plan, result } = await upgrade(root);
  assert.equal(plan.from.version, "0.1.0-old");
  assert.equal(plan.to.version, (await readJson(path.join(sourceRuntime, "templates", "PACKAGE_MANIFEST.json"))).version);
  assert.deepEqual(plan.config_added_keys, ["active_runs"]);
  assert.deepEqual(plan.config_removed_keys, ["state_contract"]);
  // The edited English template is kept; the untouched Chinese one is replaced.
  assert.equal(plan.templates["work-packages/TEMPLATE.md"].action, "keep_and_write_new");
  assert.equal(plan.templates["work-packages/TEMPLATE.zh-TW.md"].action, "unchanged");
  assert.equal(plan.policy_changed, false);
  assert.ok(plan.legacy_runtime_file_count > 10);
  assert.match(formatUpgradePlan(plan), /會拿掉舊版留在專案裡的 tools\/（\d+ 個檔，已經不用）/);
  // farm.md, farm.result.md, the day file, rules.md, TEMPLATE.md, bridge.json and the fake run's records.
  assert.ok(plan.user_file_count >= 8, "user files: " + plan.user_file_count);
  assert.ok(plan.user_files.every((name) => !name.startsWith("tools/")), "the old copy is not counted as the person's");
  assert.equal(result.ok, true);
  assert.equal(result.legacy_runtime_removed, plan.legacy_runtime_file_count);
  assert.equal(await exists(path.join(privateOf(root), "tools")), false, "the old tools/ copy is gone");
  const after = await persistent(root);
  // Work orders, results, the day file, run records, authorizations, rules.md, the policy override
  // and the edited TEMPLATE.md: bit for bit as before.
  for (const [name, hash] of before) {
    if (name.startsWith("tools/") || ["review-bridge/bridge.json", "review-bridge-install.json"].includes(name)) continue;
    assert.equal(after.get(name), hash, name);
  }
  assert.ok([...before.keys()].some((name) => name.startsWith("review-queue/runs/")), "the fake run left a run record");
  assert.ok([...before.keys()].some((name) => name.startsWith("review-queue/authorizations/")), "and an authorization");
  const config = await readJson(path.join(privateOf(root), "review-bridge", "bridge.json"));
  assert.deepEqual(config.retention, { days: 20 });
  assert.equal(config.locale, "en");
  assert.equal(config.active_runs, "derive_from_run_projections", "the new key is added");
  assert.equal(Object.hasOwn(config, "state_contract"), false, "the retired key is removed");
  assert.equal(after.get("work-packages/TEMPLATE.new.md"), sha(await fsp.readFile(path.join(packageRoot, "project-templates", "work-package.md"))));
  assert.equal(await exists(markerOf(root)), false);
  assert.equal(await exists(lockOf(root)), false);
  const manifest = await readJson(path.join(privateOf(root), "review-bridge-install.json"));
  assert.equal(manifest.runtime_sha256, plan.to.runtime_sha256);
  assert.equal(manifest.bridge_version, plan.to.version);
  assert.ok(manifest.installed_files.every(([name]) => !name.startsWith("tools/")));
  assert.equal(manifest.upgrades.at(-1).backup_dir, result.backup_dir);
  // The backup outside the project holds the whole folder from before, the old copy included.
  const backup = await readJson(path.join(result.backup_dir, "backup-manifest.json"));
  assert.equal(backup.operation, "upgrade");
  for (const [name, hash] of before) assert.equal(new Map(backup.files).get(name), hash, "backed up: " + name);
  await fakeRun(root, "after-upgrade");
  // The same version again: nothing to do and nothing touched.
  const settled = await tree(privateOf(root));
  const again = await planNeutralUpgrade({ target: root });
  assert.equal(again.up_to_date, true);
  sameTree(await tree(privateOf(root)), settled, "W9");
});

test("W2 a failure at each step rolls back: persistent data bit for bit, the old copy back, no marker, no lock, the page service as before", async (t) => {
  const root = await workspace(t);
  await installWithService(root);
  await makeOld(root, { legacy: true });
  await addUserData(root);
  const fail = async () => { throw new Error("injected"); };
  for (const hook of ["afterConfig", "afterLegacyRemoved", "beforeVerify"]) {
    const before = await persistent(root);
    await assert.rejects(upgrade(root, { [hook]: fail }), /The upgrade failed and was rolled back; the project's settings are as before: injected/, hook);
    sameTree(await persistent(root), before, hook);
    assert.equal(await exists(markerOf(root)), false, hook + ": marker");
    assert.equal(await exists(lockOf(root)), false, hook + ": lock");
    assert.equal(await serviceRunning(root), true, hook + ": the page service is back");
  }
  // Without the page service it stays off.
  bootstrapRun(root, ["down"]);
  const before = await persistent(root);
  await assert.rejects(upgrade(root, { afterConfig: fail }), /rolled back/);
  sameTree(await persistent(root), before, "no service");
  assert.equal(await serviceRunning(root), false);
  // A failed backup or a changed original: nothing was changed at all.
  await assert.rejects(upgrade(root, { afterBackup: async (dir) => fsp.appendFile(path.join(dir, "files", "review-bridge", "rules.md"), "x") }), /backup could not be verified; nothing was changed/);
  await assert.rejects(upgrade(root, { afterBackup: async () => fsp.appendFile(path.join(privateOf(root), "review-bridge", "rules.md"), "x") }), /A file changed after the backup: review-bridge\/rules\.md/);
  assert.equal(await exists(markerOf(root)), false);
});

test("W2b an automatic rollback that cannot finish keeps the marker and names upgrade --rollback", async (t) => {
  const root = await workspace(t);
  await install(root);
  await makeOld(root, { legacy: true });
  const before = await persistent(root);
  await assert.rejects(upgrade(root, {
    afterLegacyRemoved: async () => { throw new Error("injected"); },
    afterFilesRestored: async () => { throw new Error("restore blocked"); },
  }), /automatic rollback did not finish \(restore blocked\)\. Bridge stays blocked for new work\. Run: review-bridge upgrade --rollback --target .+\. The backup is in /);
  assert.equal(await exists(markerOf(root)), true, "new work stays blocked");
  await rollback(root);
  sameTree(await persistent(root), before, "after upgrade --rollback");
  assert.equal(await exists(markerOf(root)), false);
});

test("W3 a crash after the old copy was removed: work is refused, the rollback puts the copy and the settings back, and work runs again", async (t) => {
  const root = await workspace(t);
  await install(root);
  await makeOld(root, { legacy: true });
  await fakeRun(root, "before-crash");
  const api = await workApi(root);
  const pending = await makePlan(api, "pending-1");
  const before = await persistent(root);
  crashAt(root, "afterLegacyRemoved");
  assert.equal(await exists(markerOf(root)), true);
  assert.equal(await exists(legacyOf(root)), false, "the old copy is gone");
  assert.ok((await readJson(markerOf(root))).removed.length > 10, "the marker names every removed file");
  // The state machine refuses new work while the marker is there.
  await assert.rejects(api.authorizeWorkPackage({ paths: api.paths, planPath: pending.plan_path, approval: pending.plan_sha256, executionMode: "fake_cli" }), /Runtime upgrade is in progress/);
  const plan = await planNeutralUpgradeRollback({ target: root });
  assert.equal(plan.kind, "restore");
  assert.ok(plan.restore.includes("tools/review-bridge/bootstrap.mjs"));
  assert.ok(plan.restore.includes("review-bridge/bridge.json"));
  await applyNeutralUpgradeRollback(plan, plan.plan_sha256);
  sameTree(await persistent(root), before, "after rollback");
  assert.equal(await exists(lockOf(root)), false, "the stale lock was taken over and released");
  await fakeRun(root, "after-rollback");
});

test("W3b interrupted after the page service stopped and before the backup: the plan only releases the marker and restarts what ran", async (t) => {
  const root = await workspace(t);
  await installWithService(root);
  await makeOld(root);
  const before = await persistent(root);
  crashAt(root, "afterServiceStop");
  assert.equal(await serviceRunning(root), false);
  assert.equal((await readJson(markerOf(root))).backup_dir, null);
  const plan = await planNeutralUpgradeRollback({ target: root });
  assert.equal(plan.kind, "release");
  assert.equal(plan.restart_service, true);
  assert.equal(formatUpgradeRollbackPlan(plan), "上一次升級在備份之前中斷，設定都沒動。\n這次會：拿掉維護標記、重新啟動網頁服務。\n");
  await applyNeutralUpgradeRollback(plan, plan.plan_sha256);
  assert.equal(await exists(markerOf(root)), false);
  assert.equal(await serviceRunning(root), true);
  sameTree(await persistent(root), before, "release with service");
  // The same point when nothing was running: only the marker goes.
  bootstrapRun(root, ["down"]);
  crashAt(root, "afterServiceStop");
  const quiet = await planNeutralUpgradeRollback({ target: root });
  assert.equal(quiet.restart_service, false);
  assert.equal(formatUpgradeRollbackPlan(quiet), "上一次升級在備份之前中斷，設定都沒動。\n這次會：拿掉維護標記。\n");
  await applyNeutralUpgradeRollback(quiet, quiet.plan_sha256);
  assert.equal(await serviceRunning(root), false);
  sameTree(await persistent(root), before, "release without service");
});

test("W3b a backup that does not match the marker, or a marker left by uninstall, is refused", async (t) => {
  const root = await workspace(t);
  await install(root);
  await makeOld(root);
  crashAt(root, "afterBackupVerified");
  const marker = await readJson(markerOf(root));
  assert.ok(marker.backup_dir);
  await fsp.appendFile(path.join(marker.backup_dir, "backup-manifest.json"), " ");
  await assert.rejects(planNeutralUpgradeRollback({ target: root }), /The backup named by the maintenance marker does not match it, so it will not be used/);
  await writeJson(markerOf(root), { operation: "uninstall", upgrade_id: "x" });
  await assert.rejects(planNeutralUpgradeRollback({ target: root }), /left by an uninstall, not an upgrade; run uninstall again/);
  await fsp.rm(markerOf(root));
  await assert.rejects(planNeutralUpgradeRollback({ target: root }), /No interrupted upgrade here/);
});

test("W3c interrupted after the settings merge, then bridge.json edited by hand: the rollback leaves that file alone", async (t) => {
  const root = await workspace(t);
  await install(root);
  await makeOld(root);
  const before = await persistent(root);
  crashAt(root, "afterConfig");
  const configPath = path.join(privateOf(root), "review-bridge", "bridge.json");
  const edited = await readJson(configPath);
  edited.retention = { days: 30 };
  await writeJson(configPath, edited);
  const editedHash = sha(await fsp.readFile(configPath));
  const { plan, result } = await rollback(root);
  assert.deepEqual(plan.kept.map(([name]) => name), ["review-bridge/bridge.json"]);
  assert.match(formatUpgradeRollbackPlan(plan), /保留不動 1 個檔.*\n  review-bridge\/bridge\.json/);
  assert.deepEqual(result.kept.map(([name]) => name), ["review-bridge/bridge.json"]);
  const after = await persistent(root);
  assert.equal(after.get("review-bridge/bridge.json"), editedHash);
  after.delete("review-bridge/bridge.json");
  before.delete("review-bridge/bridge.json");
  sameTree(after, before, "everything else");
});

test("W3d a file the person put back into tools/ after a crash is kept, and the rest of the copy comes back", async (t) => {
  const root = await workspace(t);
  await install(root);
  await makeOld(root, { legacy: true });
  const before = await persistent(root);
  crashAt(root, "afterLegacyRemoved");
  const prompt = path.join(legacyOf(root), "review-prompt.md");
  await fsp.mkdir(path.dirname(prompt), { recursive: true });
  await fsp.writeFile(prompt, "我的版本\n");
  const { plan, result } = await rollback(root);
  assert.deepEqual(plan.kept.map(([name]) => name), ["tools/review-bridge/review-prompt.md"]);
  assert.deepEqual(result.kept.map(([name]) => name), ["tools/review-bridge/review-prompt.md"]);
  assert.equal(await fsp.readFile(prompt, "utf8"), "我的版本\n", "the person's file is not overwritten");
  const after = await persistent(root);
  after.delete("tools/review-bridge/review-prompt.md");
  before.delete("tools/review-bridge/review-prompt.md");
  sameTree(after, before, "everything else is back");
  assert.equal(await exists(markerOf(root)), false);
});

test("W3e a file written after the rollback plan was made stops that plan; the next plan keeps the file", async (t) => {
  const root = await workspace(t);
  await install(root);
  await makeOld(root, { legacy: true });
  crashAt(root, "afterLegacyRemoved");
  const plan = await planNeutralUpgradeRollback({ target: root });
  assert.ok(plan.restore.includes("tools/review-bridge/review-prompt.md"));
  // Written after the plan looked, before the rollback gets to it.
  const prompt = path.join(legacyOf(root), "review-prompt.md");
  await fsp.mkdir(path.dirname(prompt), { recursive: true });
  await fsp.writeFile(prompt, "not Bridge's\n");
  await assert.rejects(applyNeutralUpgradeRollback(plan, plan.plan_sha256), /The project changed after the plan was shown; make a new plan/);
  assert.equal(await fsp.readFile(prompt, "utf8"), "not Bridge's\n");
  assert.equal(await exists(markerOf(root)), true, "the marker stays");
  const { result } = await rollback(root);
  assert.ok(result.kept.some(([name]) => name === "tools/review-bridge/review-prompt.md"));
  assert.equal(await fsp.readFile(prompt, "utf8"), "not Bridge's\n");
  assert.equal(await exists(markerOf(root)), false);
});

test("W4 work-start is refused once the marker is written; a run claimed just before cancels itself", async (t) => {
  const root = await workspace(t);
  await install(root);
  await makeOld(root);
  const api = await workApi(root);
  const waiting = await makePlan(api, "waiting-1");
  let refused = null;
  const { result } = await upgrade(root, {
    afterMarker: async () => {
      refused = await api.authorizeWorkPackage({ paths: api.paths, planPath: waiting.plan_path, approval: waiting.plan_sha256, executionMode: "fake_cli" })
        .then(() => null, (error) => error.message);
    },
  });
  assert.equal(result.ok, true);
  assert.match(refused, /Runtime upgrade is in progress/);
  // A run claimed as the marker appears closes itself as cancelled; the upgrade then sees the
  // project changed since its plan and refuses cleanly, and the next plan goes through.
  await makeOld(root);
  const raced = await makePlan(api, "raced-1");
  const authorized = await api.authorizeWorkPackage({ paths: api.paths, planPath: raced.plan_path, approval: raced.plan_sha256, executionMode: "fake_cli" });
  await assert.rejects(upgrade(root, {
    afterMarker: async () => assert.rejects(api.cancelIfMaintenance(api.paths, authorized.run.run_id), /maintenance_in_progress/),
  }), /The project changed after the plan was shown/);
  assert.equal((await api.readRun(api.paths, authorized.run.run_id)).closed_reason, "cancelled");
  assert.equal(await exists(markerOf(root)), false);
  assert.equal((await upgrade(root)).result.ok, true);
});

test("W5 / W6 / W8 approval binds the plan; running work, a failed verification, markers, a held lock and an inside backup root refuse", async (t) => {
  const root = await workspace(t);
  await install(root);
  await makeOld(root);
  const before = await tree(privateOf(root));
  const plan = await planNeutralUpgrade({ target: root });
  await assert.rejects(applyNeutralUpgrade(plan, "0".repeat(64)), /Upgrade plan approval is invalid/);
  await assert.rejects(applyNeutralUpgrade({ ...plan, persistent_count: 1 }, plan.plan_sha256), /Upgrade plan approval is invalid/);
  await fsp.appendFile(path.join(privateOf(root), "review-bridge", "rules.md"), "\n改了\n");
  await assert.rejects(applyNeutralUpgrade(plan, plan.plan_sha256), /The project changed after the plan was shown; make a new plan/);
  const changed = await tree(privateOf(root));
  assert.equal(await exists(markerOf(root)), false);
  sameTree(await tree(privateOf(root)), changed, "W5 nothing moved");
  assert.notEqual(changed.get("review-bridge/rules.md"), before.get("review-bridge/rules.md"));
  // W6: running work.
  const api = await workApi(root);
  const running = await makePlan(api, "running-1");
  await api.authorizeWorkPackage({ paths: api.paths, planPath: running.plan_path, approval: running.plan_sha256, executionMode: "fake_cli" });
  const busy = await persistent(root);
  await assert.rejects(upgrade(root), /Work is still running: .+ \(in_progress\)\. Stop it or let it finish first/);
  sameTree(await persistent(root), busy, "W6 running work");
  assert.equal(await exists(markerOf(root)), false);
  // W6: a held install lock.
  const fresh = await planNeutralUpgrade({ target: root });
  await fsp.writeFile(lockOf(root), JSON.stringify({ pid: process.pid }));
  await assert.rejects(applyNeutralUpgrade(fresh, fresh.plan_sha256), /Another Bridge installation is active/);
  await fsp.rm(lockOf(root));
  // W6: markers left by an upgrade or an uninstall.
  await fsp.writeFile(markerOf(root), JSON.stringify({ operation: "upgrade", upgrade_id: "u" }));
  await assert.rejects(planNeutralUpgrade({ target: root }), /interrupted Bridge upgrade is present; run upgrade --rollback first/);
  await fsp.writeFile(markerOf(root), JSON.stringify({ operation: "uninstall", upgrade_id: "u" }));
  await assert.rejects(planNeutralUpgrade({ target: root }), /interrupted Bridge uninstall is present; run uninstall again/);
  await fsp.rm(markerOf(root));
  // W6: a backup root inside the project.
  await assert.rejects(planNeutralUpgrade({ target: root, backupRoot: path.join(root, "backups") }), /must be outside the project/);
  // W8: a protected setting changed.
  const configPath = path.join(privateOf(root), "review-bridge", "bridge.json");
  const config = await readJson(configPath);
  config.requires_human_authorization = false;
  await writeJson(configPath, config);
  await assert.rejects(planNeutralUpgrade({ target: root }), /does not verify, so it will not be upgraded: Neutral install protected role or authorization settings changed/);
  await assert.rejects(planNeutralUpgrade({ target: path.join(root, "missing") }), /existing, non-symlink workspace/);
});

test("W7 a new default policy invalidates unstarted authorizations, reports them and refuses them with a new-plan message", async (t) => {
  const root = await workspace(t);
  await install(root);
  const old = await oldPolicyRuntime(t);
  await makeOld(root, { policy: old });
  // Made while the older Bridge (with its own default policy) ran.
  const before = await workApi(root, old);
  const { snapshot } = await before.loadOrCreatePolicySnapshot(before.paths);
  const workPackage = await before.createImmutableWorkPackage(before.paths, {
    work_package_id: "wp-" + randomUUID(), task: "Unclaimed fixture.", acceptance_criteria: [],
    scope: { allowed_paths: ["README.md"] }, budget: { rounds: 1, call_timeout: 1 }, breakpoint: "b",
  });
  const authorization = await before.createAuthorization(before.paths, {
    authorizedBy: "Human Owner", workPackageSha256: workPackage.record.content_sha256, policySha256: snapshot.effective_policy_sha256,
    ttl: snapshot.effective_policy.limits.authorization_ttl,
  });
  const stalePlan = await makePlan(before, "stale-1");
  const { plan, result } = await upgrade(root);
  assert.equal(plan.policy_changed, true);
  assert.match(formatUpgradePlan(plan), /新版的預設 policy 不同：升級後未開始的授權會失效，需重新建 plan。/);
  assert.deepEqual(result.invalidated_authorization_ids, [authorization.authorization_id]);
  const api = await workApi(root);
  assert.equal(await exists(path.join(api.paths.authorizationInvalidationsDir, authorization.authorization_id + ".json")), true);
  await assert.rejects(api.claimStartAuthorization(api.paths, authorization.authorization_id, { executionMode: "fake_cli" }), /Bridge was upgraded or its policy changed\. Make a new plan with work-plan/);
  await assert.rejects(api.authorizeWorkPackage({ paths: api.paths, planPath: stalePlan.plan_path, approval: stalePlan.plan_sha256, executionMode: "fake_cli" }), /Work plan is stale because effective policy changed: Bridge was upgraded or its policy changed\. Make a new plan with work-plan/);
});

test("W10 / W11 the CLI has no --yes and needs a terminal; the plan route works; the proof-loss line is shown and the restarted page is not_run", async (t) => {
  const root = await workspace(t);
  await installWithService(root);
  await makeOld(root);
  const cli = (args, input) => spawnSync(process.execPath, [bridge, ...args], { cwd: packageRoot, encoding: "utf8", env: childEnv, windowsHide: true, ...(input ? { input } : {}) });
  for (const args of [["upgrade", "--target", root, "--yes"], ["upgrade", "--rollback", "--target", root, "--yes"]]) {
    const refused = cli(args);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /^Review Bridge upgrade failed closed: upgrade has no --yes/);
  }
  const piped = cli(["upgrade", "--target", root], "y\n");
  assert.equal(piped.status, 2);
  assert.match(piped.stderr, /No terminal to confirm at\. Use --plan-out <file>, then --plan <file> --approve <sha>/);
  const plan = await planNeutralUpgrade({ target: root });
  assert.ok(formatUpgradePlan(plan).endsWith(PROOF_LOSS_LINE + "\n"));
  assert.match(formatUpgradePlan(plan), /會先停掉網頁服務，升級後再啟動。/);
  const planFile = path.join(os.tmpdir(), "rb-upgrade-plan-" + process.pid + ".json");
  t.after(() => fsp.rm(planFile, { force: true }));
  const written = cli(["upgrade", "--target", root, "--plan-out", planFile]);
  assert.equal(written.status, 0, written.stderr);
  const { plan_sha256: approval } = JSON.parse(written.stdout);
  const wrongKind = cli(["upgrade", "--rollback", "--target", root, "--plan", planFile, "--approve", approval]);
  assert.match(wrongKind.stderr, /That is not an upgrade rollback plan/);
  const applied = cli(["upgrade", "--target", root, "--plan", planFile, "--approve", approval]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /^這個專案的設定已升級到 .+\n保留了你的 \d+ 個檔；備份在 .+\nreviewer 唯讀實測要在網頁上重做一次，才能做原生工作\n$/);
  const service = await serviceCheck(root);
  assert.equal(service.running, true);
  assert.equal(service.status.reviewer_readonly.state, "not_run");
  const current = cli(["upgrade", "--target", root]);
  assert.equal(current.status, 0, current.stderr);
  assert.match(current.stdout, /^已是這一版（.+），沒有動任何檔。\n$/);
  // upgrade --rollback takes only the plan route or a terminal, too.
  await makeOld(root);
  crashAt(root, "afterServiceStop");
  const rollbackPiped = cli(["upgrade", "--rollback", "--target", root], "y\n");
  assert.equal(rollbackPiped.status, 2);
  assert.match(rollbackPiped.stderr, /No terminal to confirm at/);
  const rollbackWritten = cli(["upgrade", "--rollback", "--target", root, "--plan-out", planFile]);
  assert.equal(rollbackWritten.status, 0, rollbackWritten.stderr);
  const rolled = cli(["upgrade", "--rollback", "--target", root, "--plan", planFile, "--approve", JSON.parse(rollbackWritten.stdout).plan_sha256]);
  assert.equal(rolled.status, 0, rolled.stderr);
  assert.equal(rolled.stdout, "已拿掉上一次升級留下的維護標記，網頁服務已重新啟動。\n");
  assert.equal(await serviceRunning(root), true);
});

async function recordInstalled(root, relative) {
  const installFile = path.join(privateOf(root), "review-bridge-install.json");
  const manifest = await readJson(installFile);
  const installed = new Map(manifest.installed_files);
  installed.set(relative, sha(await fsp.readFile(path.join(privateOf(root), ...relative.split("/")))));
  manifest.installed_files = [...installed].sort((left, right) => left[0].localeCompare(right[0]));
  await writeJson(installFile, manifest);
}

test("W1b TEMPLATE.new.md left by an earlier upgrade is reused only while unedited; an edited one is never overwritten", async (t) => {
  const root = await workspace(t);
  await install(root);
  await makeOld(root);
  const work = path.join(privateOf(root), "work-packages");
  const shipped = await fsp.readFile(path.join(packageRoot, "project-templates", "work-package.md"));
  await fsp.appendFile(path.join(work, "TEMPLATE.md"), "\n<!-- 我的欄位 -->\n");
  // As an earlier upgrade left it: an older shipped template, recorded as Bridge's.
  await fsp.writeFile(path.join(work, "TEMPLATE.new.md"), "<!-- older shipped template -->\n");
  await recordInstalled(root, "work-packages/TEMPLATE.new.md");
  const reuse = await planNeutralUpgrade({ target: root });
  assert.equal(reuse.templates["work-packages/TEMPLATE.md"].new_path, "work-packages/TEMPLATE.new.md");
  // Once a human edits it, the plan picks another name and seals it.
  await fsp.appendFile(path.join(work, "TEMPLATE.new.md"), "我的修改\n");
  const humanEdit = await fsp.readFile(path.join(work, "TEMPLATE.new.md"));
  const plan = await planNeutralUpgrade({ target: root });
  const version = plan.to.version.replace(/[^A-Za-z0-9._-]/g, "_");
  assert.equal(plan.templates["work-packages/TEMPLATE.md"].new_path, "work-packages/TEMPLATE.new." + version + ".md");
  assert.ok(formatUpgradePlan(plan).includes("新版另存成 TEMPLATE.new." + version + ".md。"));
  const result = await applyNeutralUpgrade(plan, plan.plan_sha256);
  assert.deepEqual(await fsp.readFile(path.join(work, "TEMPLATE.new.md")), humanEdit, "the human's file is untouched");
  assert.deepEqual(await fsp.readFile(path.join(work, "TEMPLATE.new." + version + ".md")), shipped);
  assert.equal(result.templates["work-packages/TEMPLATE.md"].new_path, plan.templates["work-packages/TEMPLATE.md"].new_path);
  // Both names edited by a human: no plan.
  await makeOld(root);
  await fsp.appendFile(path.join(work, "TEMPLATE.new." + version + ".md"), "也改了\n");
  await assert.rejects(planNeutralUpgrade({ target: root }), /You edited both work-packages\/TEMPLATE\.new\.md and work-packages\/TEMPLATE\.new\..+\.md; the upgrade will not overwrite either/);
});

// An install made before there were two templates recorded TEMPLATE.md's hash alone and has no
// Chinese one: the upgrade adds it, records both, and the result verifies.
test("W1c an install from before the Chinese template gets it added, and both templates are recorded", async (t) => {
  const root = await workspace(t);
  await install(root);
  await makeOld(root);
  const work = path.join(privateOf(root), "work-packages");
  const installFile = path.join(privateOf(root), "review-bridge-install.json");
  const manifest = await readJson(installFile);
  manifest.work_template_sha256 = manifest.work_template_sha256["work-packages/TEMPLATE.md"];
  manifest.installed_files = manifest.installed_files.filter(([name]) => name !== "work-packages/TEMPLATE.zh-TW.md");
  await writeJson(installFile, manifest);
  await fsp.rm(path.join(work, "TEMPLATE.zh-TW.md"));
  await verifyNeutralInstall(root);
  const plan = await planNeutralUpgrade({ target: root });
  assert.equal(plan.templates["work-packages/TEMPLATE.md"].action, "unchanged");
  assert.equal(plan.templates["work-packages/TEMPLATE.zh-TW.md"].action, "add");
  assert.ok(formatUpgradePlan(plan).includes("TEMPLATE.zh-TW.md：還沒有，加上新版。"));
  await applyNeutralUpgrade(plan, plan.plan_sha256);
  const shipped = await fsp.readFile(path.join(packageRoot, "project-templates", "work-package.zh-TW.md"));
  assert.deepEqual(await fsp.readFile(path.join(work, "TEMPLATE.zh-TW.md")), shipped);
  const upgraded = await readJson(installFile);
  assert.deepEqual(upgraded.work_template_sha256, {
    ["work-packages/TEMPLATE.md"]: sha(await fsp.readFile(path.join(packageRoot, "project-templates", "work-package.md"))),
    ["work-packages/TEMPLATE.zh-TW.md"]: sha(shipped),
  });
  assert.ok(upgraded.installed_files.some(([name, hash]) => name === "work-packages/TEMPLATE.zh-TW.md" && hash === sha(shipped)), "the added template is Bridge's");
  await verifyNeutralInstall(root);
});

// RC3-LINUX-00: a restart that fails with a reason (the shape the installer's own restart returns)
// is a failure on every path, and the person sees the reason; service_restarted stays a boolean.
const failedRestart = async () => ({ running: false, reason: "up exited 2 | port 4888 is taken" });

test("a page service that does not come back after an upgrade is a warning that says why", async (t) => {
  const root = await workspace(t);
  await installWithService(root);
  await makeOld(root);
  const { result } = await upgrade(root, { restartService: failedRestart });
  assert.equal(result.ok, true);
  assert.equal(result.service_restarted, false);
  assert.ok(result.warnings.includes("The Bridge page service did not restart: up exited 2 | port 4888 is taken; start it with up."), JSON.stringify(result.warnings));
});

test("a failed upgrade whose page service does not come back keeps the marker and says why", async (t) => {
  const root = await workspace(t);
  await installWithService(root);
  await makeOld(root);
  await assert.rejects(upgrade(root, { afterConfig: async () => { throw new Error("injected"); }, restartService: failedRestart }),
    /automatic rollback did not finish \(The Bridge page service that was running did not restart: up exited 2 \| port 4888 is taken, so Bridge stays blocked/);
  assert.equal(await exists(markerOf(root)), true);
  const { result } = await rollback(root);
  assert.equal(result.service_restarted, true);
  assert.equal(await serviceRunning(root), true);
});

test("a rollback whose page service does not come back keeps the marker and says why", async (t) => {
  const root = await workspace(t);
  await installWithService(root);
  await makeOld(root);
  crashAt(root, "afterServiceStop");
  const plan = await planNeutralUpgradeRollback({ target: root });
  assert.equal(plan.restart_service, true);
  await assert.rejects(applyNeutralUpgradeRollback(plan, plan.plan_sha256, { restartService: failedRestart }),
    /did not restart: up exited 2 \| port 4888 is taken; the marker stays/);
  assert.equal(await exists(markerOf(root)), true);
  const { result } = await rollback(root);
  assert.equal(result.service_restarted, true);
});
