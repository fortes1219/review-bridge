// Keeps the person's database out of these tests (see the fixture).
import { dataHome, separatePerson } from "../review-bridge/tests/fixtures/isolatedDataHome.mjs";
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
  applyNeutralInstall, applyNeutralUpgrade, applyNeutralUpgradeRollback, formatUpgradePlan, formatUpgradeResult, formatUpgradeRollbackPlan,
  loadInstalledServiceModules, MAINTENANCE_MARKER, planNeutralInstall, planNeutralUpgrade, planNeutralUpgradeRollback, PROOF_LOSS_LINE, TRANSIENT_FILES,
  verifyNeutralInstall,
} from "../installer/neutral-install.mjs";
import { policyIdentity } from "../review-bridge/service/index.mjs";
import { localDateKey } from "../review-bridge/utils/dates.mjs";

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
// The settings are flat in .review-bridge/; the install record and the run state are the service's,
// outside the project (RC3-FIX-02).
const { getBridgePaths } = await import(sourceModule("utils/paths.mjs"));
const projectPaths = (root) => getBridgePaths(root, sourceRuntime, { privateRootName: ".review-bridge" });
const manifestOf = (root) => projectPaths(root).installManifestPath;

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
  // A stack of entries, not recursion; each folder is pushed reversed, so the files come out in
  // the same depth-first order a recursive walk lists them.
  const entries = async (directory, prefix) => (await fsp.readdir(directory, { withFileTypes: true }).catch(() => []))
    .map((entry) => [path.join(directory, entry.name), prefix ? prefix + "/" + entry.name : entry.name, entry.isDirectory()]).reverse();
  const stack = await entries(root, "");
  while (stack.length) {
    const [full, name, isDirectory] = stack.pop();
    if (isDirectory) stack.push(...await entries(full, name));
    else files.set(name, sha(await fsp.readFile(full)));
  }
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
  const configFile = path.join(privateOf(root), "bridge.json");
  const config = await readJson(configFile);
  delete config.active_runs;
  // Installs made before the rename still carry this key.
  config.state_contract = "v4";
  await writeJson(configFile, config);
  const installFile = manifestOf(root);
  const manifest = await readJson(installFile);
  manifest.runtime_sha256 = sha("an older runtime " + randomUUID());
  manifest.bridge_version = "0.1.0-old";
  if (policy) manifest.policy_identity = policyIdentity(await readJson(path.join(policy, "config", "default-policy.json")));
  const installed = new Map(manifest.installed_files);
  if (legacy) {
    await fsp.cp(sourceRuntime, legacyOf(root), { recursive: true });
    for (const [name, hash] of await tree(legacyOf(root))) installed.set("tools/review-bridge/" + name, hash);
  }
  installed.set("bridge.json", sha(await fsp.readFile(configFile)));
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
  // A day file five days old: well inside the retention set below, whatever day the tests run.
  await fsp.writeFile(path.join(privateRoot, "archive", localDateKey(Date.now() - 5 * 86_400_000) + ".jsonl"), "{\"type\":\"run\"}\n");
  await fsp.appendFile(path.join(privateRoot, "rules.md"), "\n不要動測試。\n");
  await fsp.appendFile(path.join(privateRoot, "work-packages", "TEMPLATE.md"), "\n<!-- 我的欄位 -->\n");
  const configPath = path.join(privateRoot, "bridge.json");
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
  const planPath = path.join(projectPaths(root).logRoot, id + ".plan.json");
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
    allowedPaths: "README.md", rounds: 1, callTimeout: 60_000, outPath: path.join(api.paths.logRoot, id + ".plan.json"),
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
    if (name.startsWith("tools/") || name === "bridge.json") continue;
    // A day file an older Bridge kept in the project is the service's state now (RC3-FIX-02).
    if (name.startsWith("archive/")) {
      assert.equal(sha(await fsp.readFile(path.join(projectPaths(root).stateRoot, ...name.split("/")))), hash, name);
      assert.equal(after.has(name), false, name + " left the project");
      continue;
    }
    assert.equal(after.get(name), hash, name);
  }
  assert.ok((await fsp.readdir(projectPaths(root).runsDir)).length > 0, "the fake run left a run record");
  assert.ok((await fsp.readdir(projectPaths(root).authorizationsDir)).length > 0, "and an authorization");
  const config = await readJson(path.join(privateOf(root), "bridge.json"));
  assert.deepEqual(config.retention, { days: 20 });
  assert.equal(config.locale, "en");
  assert.equal(config.active_runs, "derive_from_run_projections", "the new key is added");
  assert.equal(Object.hasOwn(config, "state_contract"), false, "the retired key is removed");
  assert.equal(after.get("work-packages/TEMPLATE.new.md"), sha(await fsp.readFile(path.join(packageRoot, "project-templates", "work-package.md"))));
  assert.equal(await exists(markerOf(root)), false);
  assert.equal(await exists(lockOf(root)), false);
  const manifest = await readJson(manifestOf(root));
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
  await assert.rejects(upgrade(root, { afterBackup: async (dir) => fsp.appendFile(path.join(dir, "files", "rules.md"), "x") }), /backup could not be verified; nothing was changed/);
  await assert.rejects(upgrade(root, { afterBackup: async () => fsp.appendFile(path.join(privateOf(root), "rules.md"), "x") }), /A file changed after the backup: rules\.md/);
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
  assert.ok(plan.restore.includes("bridge.json"));
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
  const configPath = path.join(privateOf(root), "bridge.json");
  const edited = await readJson(configPath);
  edited.retention = { days: 30 };
  await writeJson(configPath, edited);
  const editedHash = sha(await fsp.readFile(configPath));
  const { plan, result } = await rollback(root);
  assert.deepEqual(plan.kept.map(([name]) => name), ["bridge.json"]);
  assert.match(formatUpgradeRollbackPlan(plan), /保留不動 1 個檔.*\n  bridge\.json/);
  assert.deepEqual(result.kept.map(([name]) => name), ["bridge.json"]);
  const after = await persistent(root);
  assert.equal(after.get("bridge.json"), editedHash);
  after.delete("bridge.json");
  before.delete("bridge.json");
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
  // A run claimed as the marker appears closes itself as cancelled. Its records are the service's
  // state, outside the project (RC3-FIX-02), so the settings the plan sealed are unchanged and the
  // upgrade goes through.
  await makeOld(root);
  const raced = await makePlan(api, "raced-1");
  const authorized = await api.authorizeWorkPackage({ paths: api.paths, planPath: raced.plan_path, approval: raced.plan_sha256, executionMode: "fake_cli" });
  const { result: racedUpgrade } = await upgrade(root, {
    afterMarker: async () => assert.rejects(api.cancelIfMaintenance(api.paths, authorized.run.run_id), /maintenance_in_progress/),
  });
  assert.equal(racedUpgrade.ok, true);
  assert.equal((await api.readRun(api.paths, authorized.run.run_id)).closed_reason, "cancelled");
  assert.equal(await exists(markerOf(root)), false);
});

test("W5 / W6 / W8 approval binds the plan; running work, a failed verification, markers, a held lock and an inside backup root refuse", async (t) => {
  const root = await workspace(t);
  await install(root);
  await makeOld(root);
  const before = await tree(privateOf(root));
  const plan = await planNeutralUpgrade({ target: root });
  await assert.rejects(applyNeutralUpgrade(plan, "0".repeat(64)), /Upgrade plan approval is invalid/);
  await assert.rejects(applyNeutralUpgrade({ ...plan, persistent_count: 1 }, plan.plan_sha256), /Upgrade plan approval is invalid/);
  await fsp.appendFile(path.join(privateOf(root), "rules.md"), "\n改了\n");
  await assert.rejects(applyNeutralUpgrade(plan, plan.plan_sha256), /The project changed after the plan was shown; make a new plan/);
  const changed = await tree(privateOf(root));
  assert.equal(await exists(markerOf(root)), false);
  sameTree(await tree(privateOf(root)), changed, "W5 nothing moved");
  assert.notEqual(changed.get("rules.md"), before.get("rules.md"));
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
  const configPath = path.join(privateOf(root), "bridge.json");
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
  // It ends as init does: the four boxes VS Code asks for and where the password is, never the password.
  const [upgraded, database] = applied.stdout.split("\n\n");
  assert.match(upgraded + "\n", /^這個專案的設定已升級到 .+\n備份在 .+\nreviewer 唯讀實測要在網頁上重做一次，才能做原生工作\n$/);
  const secret = path.join(dataHome, "postgres", "secret");
  assert.match(database, new RegExp("^  database in VS Code: install Microsoft's PostgreSQL extension and add a connection with\n"
    + "    Server 127\\.0\\.0\\.1  Port \\d+  User bridge  Database bridge\n"
    + "    Password: copy it from " + secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\n$"));
  assert.equal(applied.stdout.includes((await fsp.readFile(secret, "utf8")).trim()), false, "the password is not printed");
  const service = await serviceCheck(root);
  assert.equal(service.running, true);
  assert.equal(service.status.reviewer_readonly.state, "not_run");
  const current = cli(["upgrade", "--target", root]);
  assert.equal(current.status, 0, current.stderr);
  assert.match(current.stdout, /^已是這一版（.+），沒有動任何檔。\n\n  database in VS Code: /);
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
  const installFile = manifestOf(root);
  const manifest = await readJson(installFile);
  const installed = new Map(manifest.installed_files);
  installed.set(relative, sha(await fsp.readFile(path.join(privateOf(root), ...relative.split("/")))));
  manifest.installed_files = [...installed].sort((left, right) => left[0].localeCompare(right[0]));
  await writeJson(installFile, manifest);
}

// As a project set up before RC3-FIX-02 is laid out: the settings in .review-bridge/review-bridge/ and
// the install record beside them, in the project.
const NESTED = { "bridge.json": "review-bridge/bridge.json", "policy.override.json": "review-bridge/policy.override.json", "rules.md": "review-bridge/rules.md" };
async function makeNested(root) {
  const record = manifestOf(root);
  await fsp.mkdir(path.join(privateOf(root), "review-bridge"), { recursive: true });
  for (const [flat, nested] of Object.entries(NESTED)) await fsp.rename(path.join(privateOf(root), flat), path.join(privateOf(root), ...nested.split("/")));
  const manifest = await readJson(record);
  manifest.installed_files = manifest.installed_files.map(([name, hash]) => [NESTED[name] || name, hash]).sort((left, right) => left[0].localeCompare(right[0]));
  await writeJson(path.join(privateOf(root), "review-bridge-install.json"), manifest);
  await fsp.rm(record);
  // Its runs were kept in the project too.
  await fsp.mkdir(path.join(privateOf(root), "review-queue", "runs"), { recursive: true });
}

test("W12 an upgrade moves the nested settings up and the install record out, once; a failure puts the nested layout back as it was", async (t) => {
  const root = await workspace(t);
  await install(root);
  await makeOld(root);
  await addUserData(root);
  const manifestPath = manifestOf(root);
  await makeNested(root);
  const nested = await persistent(root);
  assert.ok(nested.has("review-bridge/bridge.json") && nested.has("review-bridge-install.json") && !nested.has("bridge.json"));
  // Only the upgrade's own plan lets the older setup's files be there; anywhere else they fail.
  await verifyNeutralInstall(root, { leftovers: true });
  await assert.rejects(verifyNeutralInstall(root), /\.review-bridge\/ still holds what an older Bridge kept there: review-queue, review-bridge, archive, review-bridge-install\.json\./);
  const plan = await planNeutralUpgrade({ target: root });
  assert.equal(plan.layout_move, true);
  assert.match(formatUpgradePlan(plan), /會把設定從 \.review-bridge\/review-bridge\/ 搬到 \.review-bridge\/ 第一層/);
  // A failure after the move and the merge: everything goes back where it was, bit for bit.
  await assert.rejects(applyNeutralUpgrade(plan, plan.plan_sha256, { afterConfig: async () => { throw new Error("disk full"); } }), /rolled back/);
  sameTree(await persistent(root), nested, "after the rollback");
  assert.equal(await exists(manifestPath), false, "the record is back in the project only");
  assert.equal(await exists(markerOf(root)), false);
  // The upgrade itself.
  const { result } = await upgrade(root);
  assert.equal(result.ok, true);
  const after = await persistent(root);
  for (const [flat, old] of Object.entries(NESTED)) {
    assert.equal(after.has(old), false, old + " moved");
    assert.ok(after.has(flat), flat + " is in .review-bridge/");
  }
  assert.equal(after.get("rules.md"), nested.get("review-bridge/rules.md"), "the person's rules.md moved as it was");
  assert.equal(after.has("review-bridge-install.json"), false);
  const config = await readJson(path.join(privateOf(root), "bridge.json"));
  assert.deepEqual(config.retention, { days: 20 });
  const record = await readJson(manifestPath);
  assert.equal(record.runtime_sha256, plan.to.runtime_sha256);
  assert.ok(record.installed_files.some(([name]) => name === "policy.override.json"));
  assert.ok(record.installed_files.every(([name]) => !name.startsWith("review-bridge/")));
  await verifyNeutralInstall(root);
  assert.equal((await planNeutralUpgrade({ target: root })).up_to_date, true);
  await fakeRun(root, "after-move");
});

// As an older Bridge left a project it ran in: besides the nested settings, every review-queue/ folder
// the service kept, a finished run with its call logs, result, plan and card, a call log of a run
// retention already removed, the reviews, the policy snapshots and probe audits, the page's output,
// and a page session whose process is gone. Returns where each file must end up, by its hash.
async function makeOldLayout(root) {
  await install(root);
  const roots = { state: projectPaths(root).stateRoot, log: projectPaths(root).logRoot };
  await makeOld(root);
  await addUserData(root);
  await makeNested(root);
  const privateRoot = privateOf(root);
  const put = async (relative, text) => {
    await fsp.mkdir(path.dirname(path.join(privateRoot, ...relative.split("/"))), { recursive: true });
    await fsp.writeFile(path.join(privateRoot, ...relative.split("/")), text);
  };
  const runId = randomUUID();
  const planSha = sha("the old plan " + runId);
  const authorizationId = "plan-" + planSha;
  await put("review-queue/runs/" + runId + ".json", JSON.stringify({ run_id: runId, status: "completed", conclusion: "success", closed_reason: "review_pass", authorization_ids: [authorizationId] }) + "\n");
  await put("review-queue/authorizations/" + authorizationId + ".json", JSON.stringify({ authorization_id: authorizationId, source_plan_sha256: planSha }) + "\n");
  await put("review-queue/authorization-claims/" + authorizationId + ".json", JSON.stringify({ authorization_id: authorizationId, run_id: runId }) + "\n");
  for (const folder of ["pending", "running", "done", "failed", "work-packages", "contracts", "authorization-invalidations", "events",
    "unrecorded", "run-locks", "reconcile-guards", "upgrade-reports", "workspace-evidence"]) {
    await put("review-queue/" + folder + "/" + (folder === "events" ? runId + ".io.jsonl" : "old-" + folder + ".json"), "{\"folder\":\"" + folder + "\"}\n");
  }
  await put("review-queue/workspace-evidence/" + planSha.slice(0, 32) + "/delta-1.json", "{\"delta\":1}\n");
  const stamp = "20261101T101010123Z";
  await put("review-queue/" + stamp + "-r" + runId.slice(0, 8) + "-writer.stdout.json", "{\"stream\":true}\n");
  await put("review-queue/" + stamp + "-r" + runId.slice(0, 8) + "-writer-only-prompt.txt", "做這件事\n");
  await put("review-queue/" + runId + ".result.md", "# 已交付\n");
  await put("review-queue/farm.plan.json", JSON.stringify({ plan_sha256: planSha, proposed_run_id: runId }) + "\n");
  await put("review-queue/authorized-" + authorizationId + ".txt", "要開工嗎？y\n");
  // A run retention already removed: its call log, plan and card name no run that is left.
  await put("review-queue/" + stamp + "-rdeadbeef-writer.stdout.json", "{\"gone\":true}\n");
  await put("review-queue/gone.plan.json", JSON.stringify({ plan_sha256: sha("gone"), proposed_run_id: randomUUID() }) + "\n");
  await put("review-queue/authorized-plan-" + sha("gone") + ".txt", "gone\n");
  await put("reviews/LATEST.txt", "review-1\n");
  await put("reviews/review-1-job.json", "{\"job\":1}\n");
  await put("review-bridge/policy-snapshots/" + sha("policy") + ".json", "{\"policy\":1}\n");
  await put("review-bridge/reviewer-probe-audit/" + localDateKey(Date.now()) + ".jsonl", "{\"probe\":1}\n");
  await put("logs/watch.stdout.log", "listening\n");
  await put("logs/watch.stderr.log", "");
  // The page the older Bridge started is gone: its pid is a process that has exited.
  const gone = spawnSync(process.execPath, ["-e", ""], { windowsHide: true }).pid;
  await put("watch-session.json", JSON.stringify({ pid: gone, port: await freePort(), url: "http://localhost:1/", service_id: "0".repeat(32), started_at: new Date().toISOString() }) + "\n");
  await put("watch-url.txt", "http://localhost:1/\n");
  // A result an older Bridge left directly in results/: the person's copy, left where it is.
  await put("results/old.result.md", "# 舊的結果\n");
  const before = await tree(privateRoot);
  const expected = new Map();
  for (const [name, hash] of before) {
    const state = /^review-queue\/(pending|running|done|failed|work-packages|contracts|authorizations|authorization-claims|authorization-invalidations|runs|events|unrecorded|run-locks|reconcile-guards|upgrade-reports|workspace-evidence)\//.test(name)
      ? name.slice("review-queue/".length)
      : /^(reviews|archive)\//.test(name) ? name : name.startsWith("review-bridge/policy-snapshots/") || name.startsWith("review-bridge/reviewer-probe-audit/") ? name.slice("review-bridge/".length) : null;
    if (state) expected.set("state/" + state, hash);
    else if (name.startsWith("logs/")) expected.set("log/" + name.slice("logs/".length), hash);
    else if (name.startsWith("review-queue/") && (name.includes(runId) || name.includes(runId.slice(0, 8)) || name === "review-queue/farm.plan.json" || name.includes(authorizationId))) {
      expected.set("log/" + runId + "/" + name.slice("review-queue/".length), hash);
    }
  }
  return { before, expected, runId, roots, dropped: ["review-queue/" + stamp + "-rdeadbeef-writer.stdout.json", "review-queue/gone.plan.json", "review-queue/authorized-plan-" + sha("gone") + ".txt"] };
}

// Every moved file is where the old layout's name says, with the same bytes.
async function assertMoved(roots, expected) {
  for (const [name, hash] of expected) {
    const [where, ...rest] = name.split("/");
    const file = path.join(where === "state" ? roots.state : roots.log, ...rest);
    assert.equal(await exists(file) ? sha(await fsp.readFile(file)) : null, hash, name);
  }
}

const PROJECT_ONLY = ["bridge.json", "policy.override.json", "results", "rules.md", "work-packages"];

test("W13 an upgrade from the older layout moves every old file out of the project, checked by SHA-256, and status still answers", async (t) => {
  const root = await workspace(t);
  const { before, expected, dropped, roots } = await makeOldLayout(root);
  // The operating system's file and the person's own are not Bridge's: not listed, not in the way, not moved.
  const theirs = { ".DS_Store": "\x00\x00\x00\x01Bud1", "notes.txt": "我的筆記\n" };
  for (const [name, text] of Object.entries(theirs)) await fsp.writeFile(path.join(privateOf(root), name), text);
  if (process.env.RB_PRINT_TREE) t.diagnostic("before:\n" + [...before.keys()].join("\n"));
  const plan = await planNeutralUpgrade({ target: root });
  // The page session points at a process that is gone: not running, so nothing to stop.
  assert.equal(plan.service_running, false);
  assert.equal(plan.legacy_files.moved, expected.size);
  assert.equal(plan.legacy_files.dropped, dropped.length);
  assert.match(formatUpgradePlan(plan), new RegExp("會把舊版留在專案裡的執行紀錄搬出專案：" + expected.size + " 個檔"));
  const result = await applyNeutralUpgrade(plan, plan.plan_sha256);
  assert.equal(result.legacy_files_moved, expected.size);
  // .review-bridge/ holds the project's five and what was never Bridge's, as it was; the old results
  // stay; the state and log folders hold every old file under its own name, with the same bytes.
  assert.deepEqual((await fsp.readdir(privateOf(root))).sort(), [...PROJECT_ONLY, ...Object.keys(theirs)].sort());
  for (const [name, text] of Object.entries(theirs)) assert.equal(await fsp.readFile(path.join(privateOf(root), name), "utf8"), text, name);
  assert.equal(await fsp.readFile(path.join(privateOf(root), "results", "old.result.md"), "utf8"), "# 舊的結果\n");
  await assertMoved(roots, expected);
  for (const name of dropped) assert.equal((await tree(projectPaths(root).logRoot)).has(path.posix.basename(name)), false, name);
  if (process.env.RB_PRINT_TREE) {
    const paths = projectPaths(root);
    t.diagnostic("after .review-bridge/:\n" + [...(await tree(privateOf(root))).keys()].join("\n"));
    t.diagnostic("after state " + paths.stateRoot + ":\n" + [...(await tree(paths.stateRoot)).keys()].join("\n"));
    t.diagnostic("after log " + paths.logRoot + ":\n" + [...(await tree(paths.logRoot)).keys()].join("\n"));
  }
  await verifyNeutralInstall(root);
  const status = bootstrapRun(root, ["status"]);
  assert.ok(status.stdout.split("\n").includes("Logs: " + projectPaths(root).logRoot), status.stdout);
  assert.equal((await planNeutralUpgrade({ target: root })).up_to_date, true);
});

test("W14 a failure part way, or a failing check after the upgrade, puts the older layout back as it was", async (t) => {
  const root = await workspace(t);
  const { before, roots } = await makeOldLayout(root);
  const nested = await persistent(root);
  // After every old file is copied out and before any source goes.
  const plan = await planNeutralUpgrade({ target: root });
  await assert.rejects(applyNeutralUpgrade(plan, plan.plan_sha256, { afterLegacyCopied: async () => { throw new Error("disk full"); } }), /rolled back.*disk full/);
  sameTree(await persistent(root), nested, "after a failure part way");
  assert.equal(await exists(markerOf(root)), false);
  // The check after the upgrade: it names the step and rolls everything back.
  const again = await planNeutralUpgrade({ target: root });
  const failing = async () => { const error = new Error("The check after the upgrade failed: the database did not open (connect ECONNREFUSED)."); throw error; };
  await assert.rejects(applyNeutralUpgrade(again, again.plan_sha256, { healthCheck: failing }), /rolled back.*the database did not open/);
  sameTree(await persistent(root), nested, "after a failed check");
  assert.equal(await exists(path.join(roots.state, "runs")) ? (await fsp.readdir(path.join(roots.state, "runs"))).length : 0, 0, "no old run is left in the state folder");
  assert.ok(before.has("review-queue/farm.plan.json"));
});

test("W15 an upgrade cut off part way is finished by running upgrade again, moving nothing twice", async (t) => {
  const root = await workspace(t);
  const { expected, roots } = await makeOldLayout(root);
  crashAt(root, "afterLegacyCopied");
  assert.equal(await exists(markerOf(root)), true, "the cut-off upgrade leaves its marker");
  const plan = await planNeutralUpgrade({ target: root });
  assert.equal(plan.kind, "resume");
  assert.match(formatUpgradePlan(plan), /^上一次升級在中途中斷，這次從中斷的地方接著做完：/);
  const marker = await readJson(markerOf(root));
  const copied = new Map();
  const placed = (to) => (to.startsWith("@state/") ? path.join(roots.state, to.slice("@state/".length)) : path.join(roots.log, to.slice("@log/".length)));
  for (const [, to] of marker.legacy_moves) copied.set(to, (await fsp.stat(placed(to))).mtimeMs);
  const result = await applyNeutralUpgrade(plan, plan.plan_sha256);
  assert.equal(result.ok, true);
  assert.deepEqual((await fsp.readdir(privateOf(root))).sort(), PROJECT_ONLY);
  await assertMoved(roots, expected);
  // What the first run copied was not copied again.
  for (const [to, mtime] of copied) assert.equal((await fsp.stat(placed(to))).mtimeMs, mtime, to);
  assert.equal((await readJson(manifestOf(root))).upgrades.length, 1, "the upgrade is recorded once");
  await verifyNeutralInstall(root);
  bootstrapRun(root, ["status"]);
});

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
  const installFile = manifestOf(root);
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

// RC3-ENTRY-02. These look at the agent files only, so the check after the upgrade opens no database.
const noDatabase = { healthCheck: async () => {} };
const earlierCommand = ".claude/commands/review-bridge.md";

// A project set up before the entries moved has them in the project, named in its install record.
async function earlierAgentFiles(root, own) {
  const command = "---\ndescription: earlier\n---\n";
  await fsp.mkdir(path.join(root, ".claude", "commands"), { recursive: true });
  await fsp.writeFile(path.join(root, ".claude", "commands", "review-bridge.md"), command);
  const added = Buffer.from("\n<!-- review-bridge:start -->\n## Review Bridge\n<!-- review-bridge:end -->\n");
  await fsp.writeFile(path.join(root, "AGENTS.md"), Buffer.concat([own, added]));
  const manifest = await readJson(manifestOf(root));
  manifest.agent_files = {
    command: { path: earlierCommand, sha256: sha(command), created_dirs: [".claude/commands"] },
    agents: { path: "AGENTS.md", created_file: false, added_prefix_newline: false, added_sha256: sha(added), added_length: added.length },
  };
  await writeJson(manifestOf(root), manifest);
}

test("upgrade takes back what an earlier Bridge wrote into the project, with the entries at user level first, and says so", async (t) => {
  const me = separatePerson(t);
  const root = await workspace(t);
  const own = Buffer.from("# Rules\n\nKeep this.\n");
  await install(root);
  await fsp.rm(me.claudeEntry);
  await earlierAgentFiles(root, own);
  const plan = await planNeutralUpgrade({ target: root });
  assert.equal(plan.up_to_date, undefined, "an unchanged runtime does not make it up to date");
  assert.deepEqual(plan.agent_files_state, {
    command: { path: earlierCommand, unchanged: true },
    agents: { path: "AGENTS.md", unchanged: true },
  });
  const shown = formatUpgradePlan(plan);
  assert.ok(shown.includes("/review-bridge 會裝在使用者層級：" + me.claudeEntry), shown);
  assert.ok(shown.includes("舊版寫進專案的 " + earlierCommand + "、AGENTS.md 那一段會收回"), shown);
  const result = await applyNeutralUpgrade(plan, plan.plan_sha256, noDatabase);
  assert.deepEqual(result.agent_files, { command: "removed", agents: "removed" });
  assert.ok(formatUpgradeResult(result).includes("舊版寫進專案的 " + earlierCommand + "、AGENTS.md 那一段已收回"), formatUpgradeResult(result));
  assert.equal(await exists(path.join(root, ".claude", "commands")), false);
  assert.equal(await fsp.readFile(path.join(root, ".claude", "settings.local.json"), "utf8"), "{\"hooks\":{}}\n", "the rest of .claude/ stays");
  assert.deepEqual(await fsp.readFile(path.join(root, "AGENTS.md")), own, "AGENTS.md is back byte for byte");
  assert.equal(await exists(me.claudeEntry), true);
  assert.equal((await readJson(manifestOf(root))).agent_files, undefined);
  assert.equal((await planNeutralUpgrade({ target: root })).up_to_date, true);
  await verifyNeutralInstall(root);
});

test("upgrade leaves what the person edited, says so once, and an AGENTS.md it created goes", async (t) => {
  const me = separatePerson(t);
  const root = await workspace(t);
  await install(root);
  await earlierAgentFiles(root, Buffer.alloc(0));
  await fsp.appendFile(path.join(root, ".claude", "commands", "review-bridge.md"), "mine\n");
  await fsp.appendFile(path.join(root, "AGENTS.md"), "My own line.\n");
  const plan = await planNeutralUpgrade({ target: root });
  assert.deepEqual(plan.agent_files_state, {
    command: { path: earlierCommand, unchanged: false },
    agents: { path: "AGENTS.md", unchanged: false },
  });
  const result = await applyNeutralUpgrade(plan, plan.plan_sha256, noDatabase);
  assert.deepEqual(result.agent_files, { command: "kept_changed", agents: "kept_changed" });
  assert.ok(formatUpgradeResult(result).includes("舊版寫進專案的 " + earlierCommand + "、AGENTS.md 那一段 你改過，留著不動"), formatUpgradeResult(result));
  assert.match(await fsp.readFile(path.join(root, ".claude", "commands", "review-bridge.md"), "utf8"), /mine\n$/);
  assert.match(await fsp.readFile(path.join(root, "AGENTS.md"), "utf8"), /My own line\.\n$/);
  assert.equal((await planNeutralUpgrade({ target: root })).up_to_date, true, "reported once, not on every upgrade");
  assert.equal(await exists(me.codexEntry), true);

  const created = await workspace(t);
  await install(created);
  await earlierAgentFiles(created, Buffer.alloc(0));
  const manifest = await readJson(manifestOf(created));
  manifest.agent_files.agents.created_file = true;
  await writeJson(manifestOf(created), manifest);
  await upgrade(created, noDatabase);
  assert.equal(await exists(path.join(created, "AGENTS.md")), false);
});

test("a failed upgrade leaves what an earlier Bridge wrote in the project, and the next one takes it back", async (t) => {
  separatePerson(t);
  const root = await workspace(t);
  await install(root);
  await earlierAgentFiles(root, Buffer.from("# Rules\n"));
  const plan = await planNeutralUpgrade({ target: root });
  await assert.rejects(applyNeutralUpgrade(plan, plan.plan_sha256, { healthCheck: async () => { throw new Error("no database"); } }), /rolled back.*no database/);
  assert.equal(await exists(path.join(root, ".claude", "commands", "review-bridge.md")), true);
  assert.equal((await readJson(manifestOf(root))).agent_files.command.path, earlierCommand);
  const { result } = await upgrade(root, noDatabase);
  assert.deepEqual(result.agent_files, { command: "removed", agents: "removed" });
  assert.equal(await fsp.readFile(path.join(root, "AGENTS.md"), "utf8"), "# Rules\n");
});

test("upgrade puts a missing entry back, leaves a file of the person's, and is up to date afterwards", async (t) => {
  const me = separatePerson(t);
  const root = await workspace(t);
  await install(root);
  await fsp.rm(me.codexEntry);
  await fsp.writeFile(me.claudeEntry, "my own command\n");
  const record = await readJson(me.record);
  record.entries = record.entries.filter((entry) => entry.path !== me.claudeEntry);
  await writeJson(me.record, record);
  const plan = await planNeutralUpgrade({ target: root });
  assert.deepEqual(plan.agent_entries.map((entry) => entry.action), ["keep", "add"]);
  const result = await applyNeutralUpgrade(plan, plan.plan_sha256, noDatabase);
  assert.ok(formatUpgradeResult(result).includes(me.claudeEntry + " 是你自己的檔，不動"), formatUpgradeResult(result));
  assert.equal(await exists(me.codexEntry), true);
  assert.equal(await fsp.readFile(me.claudeEntry, "utf8"), "my own command\n");
  assert.equal((await planNeutralUpgrade({ target: root })).up_to_date, true);
});
