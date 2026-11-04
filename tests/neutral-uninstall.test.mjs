// Keeps the person's database out of these tests (see the fixture).
import "../review-bridge/tests/fixtures/isolatedDataHome.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  applyNeutralInstall, applyNeutralUninstall, defaultBackupRoot, loadInstalledServiceModules, MAINTENANCE_MARKER,
  planNeutralInstall, planNeutralUninstall,
} from "../installer/neutral-install.mjs";
import { databaseBackupsRoot } from "../review-bridge/service/database/backup.mjs";
import { bridgeDataHome } from "../review-bridge/service/database/dataHome.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridge = path.join(packageRoot, "bridge.mjs");

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
const { getBridgePaths } = await import(pathToFileURL(path.join(packageRoot, "review-bridge", "utils", "paths.mjs")).href);
const projectPaths = (root) => getBridgePaths(root, path.join(packageRoot, "review-bridge"), { privateRootName: ".review-bridge" });

async function workspace(t, { gitRepo = true } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rb-uninstall-"));
  t.after(async () => {
    const bootstrap = path.join(packageRoot, "review-bridge", "bootstrap.mjs");
    spawnSync(process.execPath, [bootstrap, "down"], { cwd: root, windowsHide: true, stdio: "ignore" });
    await fsp.rm(root, { recursive: true, force: true });
  });
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "vue-test", dependencies: { vue: "latest" }, devDependencies: { vite: "latest" } }));
  await fsp.mkdir(path.join(root, ".claude"));
  await fsp.writeFile(path.join(root, ".claude", "settings.local.json"), "{\"hooks\":{}}\n");
  if (gitRepo) {
    assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: root, windowsHide: true }).status, 0);
    await fsp.mkdir(path.join(root, ".git", "info"), { recursive: true });
    await fsp.writeFile(path.join(root, ".git", "info", "exclude"), "# local\n*.swp\n");
  }
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

// A real init: installs, runs the fake self-tests and starts the page service.
async function installWithService(root) {
  const result = spawnSync(process.execPath, [bridge, "init", "--target", root, "--writer", "claude", "--reviewer", "codex", "--yes", "--fake-cli", "--port", String(await freePort())], {
    cwd: packageRoot, encoding: "utf8", windowsHide: true, env: childEnv, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await serviceRunning(root), true, "init should leave the page service running");
}

async function serviceRunning(root) {
  const runtimeRoot = path.join(packageRoot, "review-bridge");
  const modules = await loadInstalledServiceModules(runtimeRoot);
  if (!modules) return false;
  return (await modules.service.checkService(modules.getBridgePaths(root, runtimeRoot, { privateRootName: ".review-bridge" }))).running;
}

async function addUserData(root) {
  const privateRoot = path.join(root, ".review-bridge");
  await fsp.writeFile(path.join(privateRoot, "work-packages", "farm.md"), "# Work order: farm\n");
  await fsp.writeFile(path.join(privateRoot, "work-packages", "farm.result.md"), "# 已交付\n");
  await fsp.mkdir(path.join(privateRoot, "archive"), { recursive: true });
  await fsp.writeFile(path.join(privateRoot, "archive", "2026-10-14.jsonl"), "{\"type\":\"run\"}\n");
  await fsp.appendFile(path.join(privateRoot, "rules.md"), "\n不要動測試。\n");
  const configPath = path.join(privateRoot, "bridge.json");
  const config = JSON.parse(await fsp.readFile(configPath, "utf8"));
  config.retention = { days: 20 };
  await fsp.writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
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

async function uninstall(root, { backupRoot = null } = {}, hooks = {}) {
  const plan = await planNeutralUninstall({ target: root, backupRoot });
  return { plan, result: await applyNeutralUninstall(plan, plan.plan_sha256, hooks) };
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

async function journalOf(plan) {
  const indexed = (await readJson(path.join(plan.backup_root, "index.json")).catch(() => ({ open: {} }))).open;
  const project = await fsp.realpath(plan.target);
  return { indexed: indexed[project] || null };
}

// A real crash: a child process runs the uninstall and exits at the named hook point, with no
// cleanup at all; its install lock is left behind with its (now gone) pid.
async function crashAt(root, hook, { count = 1, backupRoot = null } = {}) {
  const script = [
    "const m = await import(process.env.RB_MODULE);",
    "const plan = await m.planNeutralUninstall({ target: process.env.RB_TARGET, backupRoot: process.env.RB_BACKUP_ROOT || null });",
    "let n = 0;",
    "await m.applyNeutralUninstall(plan, plan.plan_sha256, { [process.env.RB_HOOK]: async () => { n += 1; if (n === Number(process.env.RB_COUNT)) process.exit(9); } });",
    "process.exit(0);",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", windowsHide: true,
    env: { ...childEnv, RB_MODULE: pathToFileURL(path.join(packageRoot, "installer", "neutral-install.mjs")).href, RB_TARGET: root, RB_HOOK: hook, RB_COUNT: String(count), RB_BACKUP_ROOT: backupRoot || "" },
  });
  assert.equal(result.status, 9, "the child should exit at " + hook + ": " + result.stderr);
  assert.ok(await fsp.stat(path.join(root, ".review-bridge-install.lock")).catch(() => null), "a crash leaves the install lock behind");
}
const exists = async (file) => Boolean(await fsp.stat(file).catch(() => null));

test("V1 uninstall removes .review-bridge/, restores the exclusion, keeps .claude/, and the backup holds every file", async (t) => {
  const root = await workspace(t);
  const excludeBefore = await fsp.readFile(path.join(root, ".git", "info", "exclude"));
  const claudeBefore = await tree(path.join(root, ".claude"));
  await install(root);
  await addUserData(root);
  const before = await tree(path.join(root, ".review-bridge"));
  const manifest = projectPaths(root).installManifestPath;
  assert.equal(await exists(manifest), true);
  const { plan, result } = await uninstall(root);
  assert.equal(plan.kind, "fresh");
  assert.ok(plan.user_files.includes("work-packages/farm.md"));
  assert.ok(plan.user_files.includes("rules.md"));
  assert.equal(plan.backup_root, await fsp.realpath(defaultBackupRoot()).catch(() => defaultBackupRoot()));
  assert.equal(await exists(path.join(root, ".review-bridge")), false);
  assert.equal(await exists(path.join(root, ".review-bridge-install.lock")), false);
  assert.deepEqual(await fsp.readFile(path.join(root, ".git", "info", "exclude")), excludeBefore);
  assert.deepEqual(await tree(path.join(root, ".claude")), claudeBefore);
  const backup = await tree(path.join(result.backup_dir, "files"));
  for (const [name, hash] of before) assert.equal(backup.get(name), hash, name);
  for (const name of ["work-packages/farm.md", "work-packages/farm.result.md", "archive/2026-10-14.jsonl", "rules.md", "@state/review-bridge-install.json"]) assert.ok(backup.has(name), name);
  // The install record goes with the project's files.
  assert.equal(await exists(manifest), false);
  const journal = await readJson(path.join(result.backup_dir, "journal.json"));
  assert.equal(journal.state, "complete");
  assert.equal((await journalOf(plan)).indexed, null);
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" }).stdout;
  assert.doesNotMatch(status, /\.review-bridge\//);
});

test("V2 / V8k a run in progress, a changed plan, a failed backup and a changed original each cancel cleanly and the next plan is fresh", async (t) => {
  const root = await workspace(t);
  await install(root);
  await addUserData(root);
  const before = await tree(path.join(root, ".review-bridge"));
  const checkCancelled = async (plan, reason) => {
    const marker = path.join(root, ".review-bridge", ...MAINTENANCE_MARKER.split("/"));
    assert.equal(await exists(marker), false, reason + ": marker gone");
    assert.equal(await exists(path.join(root, ".review-bridge-install.lock")), false, reason + ": lock gone");
    assert.equal((await journalOf(plan)).indexed, null, reason + ": index cleared");
    const after = await tree(path.join(root, ".review-bridge"));
    for (const [name, hash] of before) if (!name.startsWith("logs/")) assert.equal(after.get(name), hash, reason + " " + name);
    assert.equal((await planNeutralUninstall({ target: root })).kind, "fresh", reason + ": next plan is fresh");
  };
  // A run in progress.
  const runFile = path.join(projectPaths(root).runsDir, "run-0001.json");
  await fsp.writeFile(runFile, JSON.stringify({ run_id: "run-0001", status: "in_progress" }));
  let plan = await planNeutralUninstall({ target: root });
  await assert.rejects(applyNeutralUninstall(plan, plan.plan_sha256), /Work is still running: run-0001 \(in_progress\)/);
  await checkCancelled(plan, "active_run");
  await fsp.rm(runFile);
  // The plan changed after it was shown.
  plan = await planNeutralUninstall({ target: root });
  await fsp.appendFile(path.join(root, ".review-bridge", "work-packages", "farm.md"), "改了\n");
  before.set("work-packages/farm.md", sha(await fsp.readFile(path.join(root, ".review-bridge", "work-packages", "farm.md"))));
  await assert.rejects(applyNeutralUninstall(plan, plan.plan_sha256), /changed after the plan was shown/);
  await checkCancelled(plan, "plan_changed");
  // The backup cannot be verified.
  plan = await planNeutralUninstall({ target: root });
  await assert.rejects(applyNeutralUninstall(plan, plan.plan_sha256, {
    afterBackup: async (dir) => fsp.appendFile(path.join(dir, "files", "work-packages", "farm.md"), "tampered"),
  }), /backup could not be verified; nothing was deleted/);
  await checkCancelled(plan, "backup_failed");
  // An original changed after the backup (B6).
  plan = await planNeutralUninstall({ target: root });
  await assert.rejects(applyNeutralUninstall(plan, plan.plan_sha256, {
    afterBackupVerified: async () => fsp.appendFile(path.join(root, ".review-bridge", "work-packages", "farm.md"), "newer\n"),
  }), /A file changed after the backup: work-packages\/farm\.md/);
  before.set("work-packages/farm.md", sha(await fsp.readFile(path.join(root, ".review-bridge", "work-packages", "farm.md"))));
  await checkCancelled(plan, "original_changed");
  // Each cancelled journal says why.
  const journals = [];
  for (const dir of await fsp.readdir(path.join(plan.backup_root))) {
    if (dir === "index.json" || dir.endsWith(".lock")) continue;
    for (const entry of await fsp.readdir(path.join(plan.backup_root, dir))) {
      const journal = await readJson(path.join(plan.backup_root, dir, entry, "journal.json")).catch(() => null);
      if (journal && journal.project === await fsp.realpath(root)) journals.push(journal);
    }
  }
  assert.deepEqual(journals.map((journal) => journal.cancel_reason).sort(), ["active_run", "backup_failed", "original_changed", "plan_changed"]);
  assert.ok(journals.every((journal) => journal.state === "cancelled"));
});

test("V3 maintenance blocks new work, and a run claimed as the marker appears is cancelled before any model call", async (t) => {
  const root = await workspace(t);
  await install(root);
  const runtimeRoot = path.join(packageRoot, "review-bridge");
  const { getBridgePaths } = await import(pathToFileURL(path.join(packageRoot, "review-bridge", "utils", "paths.mjs")).href);
  const { createWorkPackagePlan, authorizeWorkPackage, cancelIfMaintenance } = await import(pathToFileURL(path.join(packageRoot, "review-bridge", "features", "workOrder", "workPackage.mjs")).href);
  const { readRun } = await import(pathToFileURL(path.join(packageRoot, "review-bridge", "service", "records", "runStore.mjs")).href);
  const paths = getBridgePaths(root, runtimeRoot, { privateRootName: ".review-bridge" });
  const makePlan = async (id) => createWorkPackagePlan({
    paths, task: "Update package.json only.", owner: "o", workPackage: id, breakpoint: "b",
    allowedPaths: "package.json", rounds: 1, callTimeout: 60_000, outPath: path.join(paths.privateRoot, id + ".plan.json"),
  });
  const marker = path.join(root, ".review-bridge", ...MAINTENANCE_MARKER.split("/"));
  const blocked = await makePlan("blocked-1");
  await fsp.writeFile(marker, JSON.stringify({ operation: "uninstall", upgrade_id: "x" }));
  await assert.rejects(authorizeWorkPackage({ paths, planPath: blocked.plan_path, approval: blocked.plan_sha256, executionMode: "fake_cli" }), /Runtime upgrade is in progress/);
  await fsp.rm(marker);
  const raced = await makePlan("raced-1");
  const authorized = await authorizeWorkPackage({ paths, planPath: raced.plan_path, approval: raced.plan_sha256, executionMode: "fake_cli" });
  await fsp.writeFile(marker, JSON.stringify({ operation: "uninstall", upgrade_id: "x" }));
  await assert.rejects(cancelIfMaintenance(paths, authorized.run.run_id), /maintenance_in_progress/);
  const run = await readRun(paths, authorized.run.run_id);
  assert.equal(run.closed_reason, "cancelled");
  assert.equal(run.last_state.status, "maintenance_blocked");
  await fsp.rm(marker);
  // The cancelled run is not "in progress"; uninstall goes ahead.
  const { result } = await uninstall(root);
  assert.equal(result.ok, true);
});

test("approval binds the plan; invalid targets, held locks, foreign markers, inside backups and --yes are refused", async (t) => {
  const root = await workspace(t);
  await assert.rejects(planNeutralUninstall({ target: root }), /No Review Bridge installation here/);
  await install(root);
  const plan = await planNeutralUninstall({ target: root });
  await assert.rejects(applyNeutralUninstall(plan, "0".repeat(64)), /approval is invalid/);
  await assert.rejects(applyNeutralUninstall({ ...plan, file_count: 1 }, plan.plan_sha256), /approval is invalid/);
  await assert.rejects(planNeutralUninstall({ target: root, backupRoot: path.join(root, "backups") }), /must be outside the project/);
  await fsp.writeFile(path.join(root, ".review-bridge-install.lock"), JSON.stringify({ pid: process.pid }));
  await assert.rejects(applyNeutralUninstall(plan, plan.plan_sha256), /Another Bridge installation is active/);
  await fsp.rm(path.join(root, ".review-bridge-install.lock"));
  const marker = path.join(root, ".review-bridge", ...MAINTENANCE_MARKER.split("/"));
  await fsp.writeFile(marker, JSON.stringify({ operation: "upgrade", upgrade_id: "u" }));
  await assert.rejects(planNeutralUninstall({ target: root }), /interrupted Bridge upgrade .*upgrade --rollback/);
  await fsp.rm(marker);
  assert.ok(await exists(projectPaths(root).installManifestPath), "nothing was touched");
  // The CLI has no --yes, and a missing terminal is refused with the --plan route.
  const yes = spawnSync(process.execPath, [bridge, "uninstall", "--target", root, "--yes"], { cwd: packageRoot, encoding: "utf8", env: childEnv, windowsHide: true });
  assert.equal(yes.status, 2);
  assert.match(yes.stderr, /uninstall has no --yes/);
  const piped = spawnSync(process.execPath, [bridge, "uninstall", "--target", root], { cwd: packageRoot, encoding: "utf8", env: childEnv, windowsHide: true, input: "y\n" });
  assert.equal(piped.status, 2);
  assert.match(piped.stderr, /No terminal to confirm at/);
  // The --plan-out / --plan --approve route works end to end.
  const planFile = path.join(os.tmpdir(), "rb-uninstall-plan-" + process.pid + ".json");
  t.after(() => fsp.rm(planFile, { force: true }));
  const written = spawnSync(process.execPath, [bridge, "uninstall", "--target", root, "--plan-out", planFile], { cwd: packageRoot, encoding: "utf8", env: childEnv, windowsHide: true });
  assert.equal(written.status, 0, written.stderr);
  const { plan_sha256: approval } = JSON.parse(written.stdout);
  const applied = spawnSync(process.execPath, [bridge, "uninstall", "--target", root, "--plan", planFile, "--approve", approval], { cwd: packageRoot, encoding: "utf8", env: childEnv, windowsHide: true });
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /^已解除安裝\n備份在：.+\n要找回工單或結果，從備份資料夾複製回來\n$/);
  assert.equal(await exists(path.join(root, ".review-bridge")), false);
});

test("V8b / V8 during deletion the marker stays until the end, and the install lock is held throughout", async (t) => {
  const root = await workspace(t);
  await install(root);
  const seen = [];
  await uninstall(root, {}, {
    afterBackupVerified: async () => seen.push({ step: "backed_up", lock: await exists(path.join(root, ".review-bridge-install.lock")) }),
    beforeDelete: async (name) => seen.push({
      name,
      lock: await exists(path.join(root, ".review-bridge-install.lock")),
      marker: await exists(path.join(root, ".review-bridge", ...MAINTENANCE_MARKER.split("/"))),
    }),
    beforeVerify: async () => seen.push({ step: "verify", lock: await exists(path.join(root, ".review-bridge-install.lock")) }),
  });
  assert.ok(seen.length > 3);
  assert.ok(seen.every((entry) => entry.lock === true), "the install lock exists for the whole transaction");
  const deletions = seen.filter((entry) => entry.name);
  assert.ok(deletions.every((entry) => entry.marker === true), "the marker outlives the other deletions");
  assert.equal(await exists(path.join(root, ".review-bridge-install.lock")), false);
});

test("V8c / V8g a newer original stops deletion; the continue plan backs it up first and still empties the folder", async (t) => {
  const root = await workspace(t);
  await install(root);
  await addUserData(root);
  const workOrder = path.join(root, ".review-bridge", "work-packages", "farm.md");
  let touched = false;
  await assert.rejects(uninstall(root, {}, {
    beforeDelete: async () => { if (!touched) { touched = true; await fsp.appendFile(workOrder, "較新的一行\n"); } },
  }), /Stopped before deleting work-packages\/farm\.md: it differs from the backup/);
  const newerContent = await fsp.readFile(workOrder, "utf8");
  assert.match(newerContent, /較新的一行/);
  const plan = await planNeutralUninstall({ target: root });
  assert.equal(plan.kind, "continue");
  assert.deepEqual(plan.remaining_newer.map(([name]) => name), ["work-packages/farm.md"]);
  const result = await applyNeutralUninstall(plan, plan.plan_sha256);
  assert.equal(result.kind, "continue");
  assert.equal(await exists(path.join(root, ".review-bridge")), false);
  assert.equal(await fsp.readFile(path.join(result.backup_dir, "newer", "work-packages", "farm.md"), "utf8"), newerContent);
  assert.notEqual(await fsp.readFile(path.join(result.backup_dir, "files", "work-packages", "farm.md"), "utf8"), newerContent);
});

test("V8m a file rewritten after its hash was checked and before it was deleted is kept; the continue plan backs it up", async (t) => {
  const root = await workspace(t);
  await install(root);
  await addUserData(root);
  const workOrder = path.join(root, ".review-bridge", "work-packages", "farm.md");
  const original = await fsp.readFile(workOrder, "utf8");
  await assert.rejects(uninstall(root, {}, {
    afterDeleteCheck: async (name, file) => { if (name === "work-packages/farm.md") await fsp.writeFile(file, "檢查之後才寫的新內容\n"); },
  }), /work-packages\/farm\.md/);
  assert.equal(await fsp.readFile(workOrder, "utf8"), "檢查之後才寫的新內容\n", "the new content is still in the project");
  const plan = await planNeutralUninstall({ target: root });
  assert.equal(plan.kind, "continue");
  assert.deepEqual(plan.remaining_newer.map(([name]) => name), ["work-packages/farm.md"]);
  const result = await applyNeutralUninstall(plan, plan.plan_sha256);
  assert.equal(await exists(path.join(root, ".review-bridge")), false, "the project is emptied");
  assert.equal(await fsp.readFile(path.join(result.backup_dir, "newer", "work-packages", "farm.md"), "utf8"), "檢查之後才寫的新內容\n");
  assert.equal(await fsp.readFile(path.join(result.backup_dir, "files", "work-packages", "farm.md"), "utf8"), original);
});

test("V8d an uninstall interrupted mid-deletion continues under a new plan; a stale lock from the crash is taken over", async (t) => {
  const root = await workspace(t);
  const excludeBefore = await fsp.readFile(path.join(root, ".git", "info", "exclude"));
  await install(root);
  await addUserData(root);
  await crashAt(root, "beforeDelete", { count: 4 });
  const plan = await planNeutralUninstall({ target: root });
  assert.equal(plan.kind, "continue");
  assert.equal(plan.remaining_newer.length, 0);
  await applyNeutralUninstall(plan, plan.plan_sha256);
  assert.equal(await exists(path.join(root, ".review-bridge")), false);
  assert.deepEqual(await fsp.readFile(path.join(root, ".git", "info", "exclude")), excludeBefore);
});

test("V8f / V8j interrupted after the marker is gone: the index finds the journal, also for a custom backup root", async (t) => {
  // Default backup root.
  const root = await workspace(t);
  const excludeBefore = await fsp.readFile(path.join(root, ".git", "info", "exclude"));
  await install(root);
  await crashAt(root, "afterDelete");
  assert.equal(await exists(path.join(root, ".review-bridge")), false);
  assert.notDeepEqual(await fsp.readFile(path.join(root, ".git", "info", "exclude")), excludeBefore);
  let plan = await planNeutralUninstall({ target: root });
  assert.equal(plan.kind, "finish");
  await applyNeutralUninstall(plan, plan.plan_sha256);
  assert.deepEqual(await fsp.readFile(path.join(root, ".git", "info", "exclude")), excludeBefore);
  assert.equal((await readJson(plan.journal)).state, "complete");
  // Custom backup root, rerun without --backup-root: the default index points at it.
  const custom = await fsp.mkdtemp(path.join(os.tmpdir(), "rb-custom-backups-"));
  t.after(() => fsp.rm(custom, { recursive: true, force: true }));
  const second = await workspace(t);
  await install(second);
  await crashAt(second, "afterDelete", { backupRoot: custom });
  plan = await planNeutralUninstall({ target: second });
  assert.equal(plan.kind, "finish");
  assert.ok(plan.journal.startsWith(await fsp.realpath(custom)), "the journal lives under the custom root");
  await applyNeutralUninstall(plan, plan.plan_sha256);
  const project = await fsp.realpath(second);
  assert.equal((await readJson(path.join(custom, "index.json"))).open[project], undefined);
  assert.equal((await readJson(path.join(defaultBackupRoot(), "index.json"))).open[project], undefined);
  // The default index is lost: without --backup-root the message says to bring it; with it, it finishes.
  const third = await workspace(t);
  await install(third);
  await crashAt(third, "afterDelete", { backupRoot: custom });
  const defaultIndex = path.join(defaultBackupRoot(), "index.json");
  const index = await readJson(defaultIndex);
  delete index.open[await fsp.realpath(third)];
  await fsp.writeFile(defaultIndex, JSON.stringify(index));
  await assert.rejects(planNeutralUninstall({ target: third }), /run uninstall again with that --backup-root/);
  plan = await planNeutralUninstall({ target: third, backupRoot: custom });
  assert.equal(plan.kind, "finish");
  await applyNeutralUninstall(plan, plan.plan_sha256);
});

test("V6 / V8h / V8i / V8l with the page service running: stop before backup, restore it on cancel, and the journal exists before the stop", async (t) => {
  const root = await workspace(t);
  await installWithService(root);
  const marker = path.join(root, ".review-bridge", ...MAINTENANCE_MARKER.split("/"));
  // V8i: the journal and index are on disk before the service is stopped (the child dies right there).
  await crashAt(root, "afterJournal");
  const indexEntry = (await readJson(path.join(defaultBackupRoot(), "index.json"))).open[await fsp.realpath(root)];
  assert.ok(indexEntry, "the index names the transaction");
  assert.equal((await readJson(indexEntry.journal)).state, "started");
  assert.equal(await serviceRunning(root), true, "the service was not stopped yet");
  let plan = await planNeutralUninstall({ target: root });
  assert.equal(plan.kind, "cancel");
  assert.equal(plan.restart_service, false, "the service was never stopped");
  await applyNeutralUninstall(plan, plan.plan_sha256);
  assert.equal(await exists(marker), false);
  // V8i: the journal cannot be written: refused before the stop.
  await assert.rejects(uninstall(root, {}, { failJournal: true }), /nothing was stopped or deleted/);
  assert.equal(await exists(marker), false);
  assert.equal(await serviceRunning(root), true);
  // V8h: crash after the stop, before the backup: the cancel plan restarts the service.
  const before = await tree(path.join(root, ".review-bridge"));
  await crashAt(root, "afterServiceStop");
  assert.equal(await serviceRunning(root), false);
  plan = await planNeutralUninstall({ target: root });
  assert.equal(plan.kind, "cancel");
  assert.equal(plan.restart_service, true);
  const cancelled = await applyNeutralUninstall(plan, plan.plan_sha256);
  assert.equal(cancelled.service_restarted, true);
  assert.equal(await serviceRunning(root), true);
  assert.equal(await exists(marker), false);
  const after = await tree(path.join(root, ".review-bridge"));
  for (const [name, hash] of before) {
    if (["watch-session.json", "watch-url.txt"].includes(name) || name.startsWith("logs/")) continue;
    assert.equal(after.get(name), hash, name);
  }
  // V8l: crash while cancelling, after the journal says cancelled (and, second time, after the index is cleared).
  for (const clearIndex of [false, true]) {
    await crashAt(root, "afterServiceStop");
    const open = (await readJson(path.join(defaultBackupRoot(), "index.json"))).open[await fsp.realpath(root)];
    const journal = await readJson(open.journal);
    await fsp.writeFile(open.journal, JSON.stringify({ ...journal, state: "cancelled", cancel_reason: "simulated" }));
    if (clearIndex) {
      const indexFile = path.join(defaultBackupRoot(), "index.json");
      const index = await readJson(indexFile);
      delete index.open[await fsp.realpath(root)];
      await fsp.writeFile(indexFile, JSON.stringify(index));
    }
    plan = await planNeutralUninstall({ target: root });
    assert.equal(plan.kind, "cancel", "clearIndex=" + clearIndex);
    await applyNeutralUninstall(plan, plan.plan_sha256);
    assert.equal(await serviceRunning(root), true);
    assert.equal(await exists(marker), false);
    assert.equal((await readJson(path.join(defaultBackupRoot(), "index.json"))).open[await fsp.realpath(root)], undefined);
  }
  // V6: a successful uninstall stops the running service first.
  const fresh = await planNeutralUninstall({ target: root });
  assert.equal(fresh.service_running, true);
  await applyNeutralUninstall(fresh, fresh.plan_sha256);
  assert.equal(await exists(path.join(root, ".review-bridge")), false);
});

test("V6 a process that merely claims the session is never killed", async (t) => {
  const root = await workspace(t);
  await install(root);
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { windowsHide: true, stdio: "ignore" });
  t.after(() => { try { sleeper.kill(); } catch {} });
  await fsp.writeFile(projectPaths(root).watchSessionPath, JSON.stringify({ pid: sleeper.pid, port: await freePort(), url: "http://127.0.0.1:1/", service_id: "f".repeat(32), started_at: new Date().toISOString() }));
  const plan = await planNeutralUninstall({ target: root });
  assert.equal(plan.service_running, false);
  await applyNeutralUninstall(plan, plan.plan_sha256);
  assert.equal(sleeper.exitCode, null, "the unrelated process is still alive");
  assert.equal(await exists(path.join(root, ".review-bridge")), false);
});

test("V9 only the block the install appended is removed, and only while it is still at the end", async (t) => {
  const root = await workspace(t);
  await install(root);
  const excludePath = path.join(root, ".git", "info", "exclude");
  const withBlock = await fsp.readFile(excludePath, "utf8");
  await fsp.writeFile(excludePath, "# mine\n" + withBlock);
  await uninstall(root);
  assert.equal(await fsp.readFile(excludePath, "utf8"), "# mine\n# local\n*.swp\n");
  const second = await workspace(t);
  await install(second);
  const secondExclude = path.join(second, ".git", "info", "exclude");
  await fsp.appendFile(secondExclude, "added-later/\n");
  const changed = await fsp.readFile(secondExclude, "utf8");
  const { result } = await uninstall(second);
  assert.deepEqual(result.exclusion, { restored: false, reason: "changed_since_install" });
  assert.equal(await fsp.readFile(secondExclude, "utf8"), changed);
});

test("V10 install, uninstall, install, uninstall gives the same clean project", async (t) => {
  const root = await workspace(t);
  const excludeBefore = await fsp.readFile(path.join(root, ".git", "info", "exclude"));
  for (let round = 0; round < 2; round += 1) {
    await install(root);
    await uninstall(root);
    assert.equal(await exists(path.join(root, ".review-bridge")), false, "round " + round);
    assert.deepEqual(await fsp.readFile(path.join(root, ".git", "info", "exclude")), excludeBefore, "round " + round);
  }
});

test("V11 the default backup root is backups/installer under the person's data home, beside backups/database", () => {
  const home = path.join("H", "user");
  assert.equal(defaultBackupRoot({ platform: "win32", env: { LOCALAPPDATA: path.join("C", "AppData", "Local") }, home }), path.join("C", "AppData", "Local", "ReviewBridge", "backups", "installer"));
  assert.equal(defaultBackupRoot({ platform: "win32", env: {}, home }), path.join(home, "AppData", "Local", "ReviewBridge", "backups", "installer"));
  assert.equal(defaultBackupRoot({ platform: "darwin", env: {}, home }), path.join(home, "Library", "Application Support", "ReviewBridge", "backups", "installer"));
  // XDG's names are lower case: the same folder as the data home, not a second ReviewBridge beside it.
  assert.equal(defaultBackupRoot({ platform: "linux", env: {}, home }), path.join(home, ".local", "share", "review-bridge", "backups", "installer"));
  assert.equal(defaultBackupRoot({ platform: "linux", env: { XDG_DATA_HOME: path.join("X", "data") }, home }), path.join("X", "data", "review-bridge", "backups", "installer"));
  assert.equal(defaultBackupRoot({ platform: "linux", env: { REVIEW_BRIDGE_DATA_HOME: path.resolve("D") }, home }), path.join(path.resolve("D"), "backups", "installer"));
  assert.equal(path.dirname(defaultBackupRoot({ platform: "linux", env: {}, home })), path.dirname(databaseBackupsRoot(bridgeDataHome({ platform: "linux", env: {}, home }))));
});

test("L1 two processes racing to take over a stale install lock: exactly one enters", async (t) => {
  const root = await workspace(t);
  const lock = path.join(root, ".review-bridge-install.lock");
  const dead = spawnSync(process.execPath, ["-e", "0"], { windowsHide: true });
  await fsp.writeFile(lock, JSON.stringify({ pid: dead.pid, started_at: "2026-10-14T00:00:00.000Z" }));
  const log = path.join(root, "enter.log");
  const script = [
    "const m = await import(process.env.RB_MODULE);",
    "const fs = await import('node:fs/promises');",
    "try {",
    "  await m.withInstallLock(process.env.RB_TARGET, async () => {",
    "    await fs.appendFile(process.env.RB_LOG, 'enter ' + process.pid + ' ' + Date.now() + '\\n');",
    "    await new Promise((r) => setTimeout(r, 1500));",
    "    await fs.appendFile(process.env.RB_LOG, 'exit ' + process.pid + ' ' + Date.now() + '\\n');",
    "  });",
    "  process.exit(0);",
    "} catch (error) { process.stderr.write(error.message); process.exit(3); }",
  ].join("\n");
  const env = { ...childEnv, RB_MODULE: pathToFileURL(path.join(packageRoot, "installer", "neutral-install.mjs")).href, RB_TARGET: root, RB_LOG: log };
  const runOne = () => new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stderr }));
  });
  const results = await Promise.all([runOne(), runOne()]);
  const entries = (await fsp.readFile(log, "utf8")).trim().split("\n");
  assert.equal(entries.filter((line) => line.startsWith("enter")).length, 1, entries.join(" | "));
  assert.deepEqual(results.map((result) => result.code).sort(), [0, 3]);
  assert.match(results.find((result) => result.code === 3).stderr, /Another Bridge installation is active/);
  assert.equal(await exists(lock), false, "the winner released the lock");
  assert.equal(await exists(lock + ".takeover"), false);
});

test("L2 an interrupted takeover is not guessed at: the message names both files to check", async (t) => {
  const root = await workspace(t);
  await install(root);
  const lock = path.join(root, ".review-bridge-install.lock");
  const dead = spawnSync(process.execPath, ["-e", "0"], { windowsHide: true });
  await fsp.writeFile(lock, JSON.stringify({ pid: dead.pid }));
  await fsp.writeFile(lock + ".takeover", JSON.stringify({ pid: dead.pid }));
  const plan = await planNeutralUninstall({ target: root });
  await assert.rejects(applyNeutralUninstall(plan, plan.plan_sha256), (error) => {
    assert.match(error.message, /An earlier takeover of the install lock was interrupted/);
    assert.ok(error.message.includes(lock + ".takeover") && error.message.includes(lock));
    return true;
  });
  assert.ok(await exists(projectPaths(root).installManifestPath), "nothing was touched");
});

test("R1 a run record that cannot be read refuses and cancels cleanly", async (t) => {
  const root = await workspace(t);
  await install(root);
  await fsp.writeFile(path.join(projectPaths(root).runsDir, "broken.json"), "{");
  const plan = await planNeutralUninstall({ target: root });
  await assert.rejects(applyNeutralUninstall(plan, plan.plan_sha256), /Cannot confirm that no work is running: the run record broken\.json cannot be read/);
  assert.equal(await exists(path.join(root, ".review-bridge", ...MAINTENANCE_MARKER.split("/"))), false);
  assert.equal((await journalOf(plan)).indexed, null);
  assert.ok(await exists(projectPaths(root).installManifestPath));
  // A status this Bridge does not know is not "not running".
  await fsp.writeFile(path.join(projectPaths(root).runsDir, "broken.json"), JSON.stringify({ run_id: "run-odd", status: "paused_by_future_version" }));
  const second = await planNeutralUninstall({ target: root });
  await assert.rejects(applyNeutralUninstall(second, second.plan_sha256), /run run-odd \(broken\.json\) has a status this Bridge does not know: paused_by_future_version/);
  assert.equal(await exists(path.join(root, ".review-bridge", ...MAINTENANCE_MARKER.split("/"))), false);
  // Every status the state machine knows is either active or terminal; a terminal one lets uninstall go on.
  await fsp.writeFile(path.join(projectPaths(root).runsDir, "broken.json"), JSON.stringify({ run_id: "run-done", status: "completed", conclusion: "failure", closed_reason: "token_limit" }));
  const third = await planNeutralUninstall({ target: root });
  assert.equal((await applyNeutralUninstall(third, third.plan_sha256)).ok, true);
});

test("R2 an unexpected error after the journal exists still closes under M11", async (t) => {
  const root = await workspace(t);
  await install(root);
  const plan = await planNeutralUninstall({ target: root });
  await assert.rejects(applyNeutralUninstall(plan, plan.plan_sha256, { afterJournal: async () => { throw new Error("disk hiccup"); } }),
    /stopped before deleting anything and was cancelled: disk hiccup/);
  assert.equal(await exists(path.join(root, ".review-bridge", ...MAINTENANCE_MARKER.split("/"))), false);
  assert.equal((await journalOf(plan)).indexed, null);
  assert.equal(await exists(path.join(root, ".review-bridge-install.lock")), false);
  assert.equal((await planNeutralUninstall({ target: root })).kind, "fresh");
});

test("I1 a damaged index is never read as 'no transaction', and the message says to keep it", async (t) => {
  const root = await workspace(t);
  await install(root);
  const indexFile = path.join(defaultBackupRoot(), "index.json");
  await fsp.mkdir(path.dirname(indexFile), { recursive: true });
  const saved = await fsp.readFile(indexFile).catch(() => null);
  await fsp.writeFile(indexFile, "{ not json");
  t.after(async () => { if (saved) await fsp.writeFile(indexFile, saved); else await fsp.rm(indexFile, { force: true }); });
  await assert.rejects(planNeutralUninstall({ target: root }), (error) => {
    assert.match(error.message, /cannot be read/);
    assert.match(error.message, /Do not delete it/);
    assert.match(error.message, /check it against its backup/);
    return true;
  });
  // JSON null, an array and a missing "open" are damaged too; only a missing file means "no index".
  for (const content of ["null", "[]", "{\"schema_version\":1}"]) {
    await fsp.writeFile(indexFile, content);
    await assert.rejects(planNeutralUninstall({ target: root }), /cannot be read .*Do not delete it/, content);
  }
  if (saved) await fsp.writeFile(indexFile, saved); else await fsp.rm(indexFile, { force: true });
  assert.equal((await planNeutralUninstall({ target: root })).kind, "fresh");
});

test("I2 crashes while clearing the index: at every point the next run finds what is left", async (t) => {
  const custom = await fsp.mkdtemp(path.join(os.tmpdir(), "rb-custom-index-"));
  t.after(() => fsp.rm(custom, { recursive: true, force: true }));
  // Crash after the journal says complete, before any index entry is removed.
  const first = await workspace(t);
  await install(first);
  await crashAt(first, "beforeIndexRemoval", { count: 1, backupRoot: custom });
  assert.equal(await exists(path.join(first, ".review-bridge")), false);
  let plan = await planNeutralUninstall({ target: first });
  assert.equal(plan.kind, "cleanup");
  assert.equal(plan.indexes.length, 2);
  await applyNeutralUninstall(plan, plan.plan_sha256);
  const project1 = await fsp.realpath(first);
  assert.equal((await readJson(path.join(custom, "index.json"))).open[project1], undefined);
  assert.equal((await readJson(path.join(defaultBackupRoot(), "index.json"))).open[project1], undefined);
  // Crash after the custom entry is removed, before the default one: a rerun without --backup-root finds it.
  const second = await workspace(t);
  await install(second);
  await crashAt(second, "beforeIndexRemoval", { count: 2, backupRoot: custom });
  const project2 = await fsp.realpath(second);
  assert.equal((await readJson(path.join(custom, "index.json"))).open[project2], undefined);
  assert.ok((await readJson(path.join(defaultBackupRoot(), "index.json"))).open[project2]);
  plan = await planNeutralUninstall({ target: second });
  assert.equal(plan.kind, "cleanup");
  assert.equal(plan.indexes.length, 1);
  await applyNeutralUninstall(plan, plan.plan_sha256);
  assert.equal((await readJson(path.join(defaultBackupRoot(), "index.json"))).open[project2], undefined);
  assert.equal((await planNeutralUninstall({ target: second }).catch((error) => error)).message.includes("No Review Bridge installation here"), true);
});

test("I3 an index that cannot be cleared is reported as unfinished and retried; the same for a cancel", async (t) => {
  // After a complete uninstall.
  const root = await workspace(t);
  await install(root);
  const plan = await planNeutralUninstall({ target: root });
  await assert.rejects(applyNeutralUninstall(plan, plan.plan_sha256, { beforeIndexRemoval: async () => { throw new Error("index locked"); } }),
    /removed and verified \.review-bridge\/, but the backup index could not be cleared \(index locked\)\. Run uninstall again/);
  const retry = await planNeutralUninstall({ target: root });
  assert.equal(retry.kind, "cleanup");
  await applyNeutralUninstall(retry, retry.plan_sha256);
  assert.equal((await readJson(path.join(defaultBackupRoot(), "index.json"))).open[await fsp.realpath(root)], undefined);
  // During a cancel: the marker stays and the next run finishes the cancel.
  const second = await workspace(t);
  await install(second);
  const marker = path.join(second, ".review-bridge", ...MAINTENANCE_MARKER.split("/"));
  const cancelPlan = await planNeutralUninstall({ target: second });
  await fsp.appendFile(path.join(second, ".review-bridge", "rules.md"), "changed\n");
  await assert.rejects(applyNeutralUninstall(cancelPlan, cancelPlan.plan_sha256, { beforeIndexRemoval: async () => { throw new Error("index locked"); } }),
    /The cancel did not finish: the backup index could not be cleared \(index locked\)/);
  assert.equal(await exists(marker), true, "the marker stays");
  const again = await planNeutralUninstall({ target: second });
  assert.equal(again.kind, "cancel");
  await applyNeutralUninstall(again, again.plan_sha256);
  assert.equal(await exists(marker), false);
  assert.equal((await readJson(path.join(defaultBackupRoot(), "index.json"))).open[await fsp.realpath(second)], undefined);
});

test("S1 a cancel whose running page service does not come back keeps the marker, and the rerun restores it", async (t) => {
  const root = await workspace(t);
  await installWithService(root);
  const marker = path.join(root, ".review-bridge", ...MAINTENANCE_MARKER.split("/"));
  const plan = await planNeutralUninstall({ target: root });
  assert.equal(plan.service_running, true);
  // The backup fails after the service was stopped; the restart during the cancel fails too.
  await assert.rejects(applyNeutralUninstall(plan, plan.plan_sha256, {
    afterBackup: async (dir) => fsp.appendFile(path.join(dir, "files", "rules.md"), "tampered"),
    restartService: async () => false,
  }), /The cancel did not finish: the Bridge page service that was running did not restart/);
  assert.equal(await exists(marker), true, "the marker stays");
  assert.equal(await serviceRunning(root), false);
  const again = await planNeutralUninstall({ target: root });
  assert.equal(again.kind, "cancel");
  assert.equal(again.restart_service, true);
  await applyNeutralUninstall(again, again.plan_sha256);
  assert.equal(await serviceRunning(root), true);
  assert.equal(await exists(marker), false);
  assert.equal((await planNeutralUninstall({ target: root })).kind, "fresh");
});

test("S2 a stop that throws after the service is already down is still recovered by the cancel", async (t) => {
  const root = await workspace(t);
  await installWithService(root);
  const marker = path.join(root, ".review-bridge", ...MAINTENANCE_MARKER.split("/"));
  const bootstrap = path.join(packageRoot, "review-bridge", "bootstrap.mjs");
  const plan = await planNeutralUninstall({ target: root });
  assert.equal(plan.service_running, true);
  await assert.rejects(applyNeutralUninstall(plan, plan.plan_sha256, {
    stopService: async () => {
      spawnSync(process.execPath, [bootstrap, "down"], { cwd: root, windowsHide: true, stdio: "ignore" });
      throw new Error("status check failed after the stop");
    },
  }), /stopped before deleting anything and was cancelled: status check failed after the stop/);
  assert.equal(await serviceRunning(root), true, "the cancel brought the service back");
  assert.equal(await exists(marker), false);
  // The same throw, and the restart cannot be confirmed: the marker stays for a rerun.
  const second = await planNeutralUninstall({ target: root });
  await assert.rejects(applyNeutralUninstall(second, second.plan_sha256, {
    stopService: async () => {
      spawnSync(process.execPath, [bootstrap, "down"], { cwd: root, windowsHide: true, stdio: "ignore" });
      throw new Error("status check failed after the stop");
    },
    restartService: async () => false,
  }), /The cancel did not finish: the Bridge page service that was running did not restart/);
  assert.equal(await exists(marker), true);
  const again = await planNeutralUninstall({ target: root });
  assert.equal(again.kind, "cancel");
  await applyNeutralUninstall(again, again.plan_sha256);
  assert.equal(await serviceRunning(root), true);
  assert.equal(await exists(marker), false);
});

// RC3-LINUX-00: the cancel's restart failing with a reason keeps the marker and shows the reason.
test("a cancel whose page service fails to restart with a reason shows that reason", async (t) => {
  const root = await workspace(t);
  await installWithService(root);
  const marker = path.join(root, ".review-bridge", ...MAINTENANCE_MARKER.split("/"));
  const plan = await planNeutralUninstall({ target: root });
  await assert.rejects(applyNeutralUninstall(plan, plan.plan_sha256, {
    afterBackup: async (dir) => fsp.appendFile(path.join(dir, "files", "rules.md"), "tampered"),
    restartService: async () => ({ running: false, reason: "up exited 2 | port 4888 is taken" }),
  }), /The cancel did not finish: the Bridge page service that was running did not restart: up exited 2 \| port 4888 is taken\. Nothing was deleted/);
  assert.equal(await exists(marker), true, "the marker stays");
  const again = await planNeutralUninstall({ target: root });
  const finished = await applyNeutralUninstall(again, again.plan_sha256);
  assert.equal(finished.service_restarted, true);
  assert.equal(await serviceRunning(root), true);
});

// B3: what init added for agents goes with the uninstall; an edited part stays, and the check that
// .claude/ is unchanged still holds for everything else in it.
test("uninstall removes the /review-bridge command and the AGENTS.md note, restoring AGENTS.md byte for byte", async (t) => {
  const root = await workspace(t);
  const agents = Buffer.from("# Rules\n\nKeep this.\n");
  await fsp.writeFile(path.join(root, "AGENTS.md"), agents);
  const claudeBefore = await tree(path.join(root, ".claude"));
  await install(root);
  assert.equal(await exists(path.join(root, ".claude", "commands", "review-bridge.md")), true);
  const { plan, result } = await uninstall(root);
  assert.deepEqual(plan.agent_files_state, {
    command: { path: ".claude/commands/review-bridge.md", unchanged: true },
    agents: { path: "AGENTS.md", unchanged: true },
  });
  assert.deepEqual(result.agent_files, { command: "removed", agents: "removed" });
  assert.deepEqual(await fsp.readFile(path.join(root, "AGENTS.md")), agents);
  assert.deepEqual(await tree(path.join(root, ".claude")), claudeBefore);
  assert.equal(await exists(path.join(root, ".claude", "commands")), false);

  const edited = await workspace(t);
  await install(edited);
  await fsp.appendFile(path.join(edited, ".claude", "commands", "review-bridge.md"), "mine\n");
  const kept = await uninstall(edited);
  assert.deepEqual(kept.plan.agent_files_state.command, { path: ".claude/commands/review-bridge.md", unchanged: false });
  assert.deepEqual(kept.result.agent_files, { command: "kept_changed", agents: "removed" });
  assert.match(await fsp.readFile(path.join(edited, ".claude", "commands", "review-bridge.md"), "utf8"), /mine\n$/);
  assert.equal(await exists(path.join(edited, "AGENTS.md")), false, "an AGENTS.md init created is removed");
});

test("an uninstall that crashed after deleting finishes removing the agent files under the next plan", async (t) => {
  const root = await workspace(t);
  await install(root);
  await crashAt(root, "afterDelete");
  assert.equal(await exists(path.join(root, ".claude", "commands", "review-bridge.md")), true, "the crash came before the agent files");
  const plan = await planNeutralUninstall({ target: root });
  const result = await applyNeutralUninstall(plan, plan.plan_sha256);
  assert.deepEqual(result.agent_files, { command: "removed", agents: "removed" });
  assert.equal(await exists(path.join(root, ".claude", "commands")), false);
  assert.equal(await exists(path.join(root, "AGENTS.md")), false);
});
