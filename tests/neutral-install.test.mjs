// Keeps the person's database out of these tests (see the fixture).
import { separatePerson } from "../review-bridge/tests/fixtures/isolatedDataHome.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getBridgePaths } from "../review-bridge/utils/paths.mjs";
import { agentEntryFiles } from "../installer/agent-files.mjs";
import {
  applyNeutralInstall,
  fileSnapshot,
  planNeutralInstall,
  reinitializeNeutralInstall,
  removeEmptyDirectories,
  rollbackFreshNeutralInstall,
  runtimeFingerprint,
  verifyNeutralInstall,
} from "../installer/neutral-install.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function workspace(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-neutral-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "vue-test", dependencies: { vue: "latest" },
    devDependencies: { vite: "latest", typescript: "latest" },
  }));
  return root;
}

test("neutral install keeps existing agent settings byte-for-byte, verifies, and puts no runtime in the project", async (t) => {
  const root = await workspace(t);
  await fsp.mkdir(path.join(root, ".claude"));
  await fsp.mkdir(path.join(root, ".codex"));
  const claude = Buffer.from("{\"hooks\":{\"Stop\":[]}}\r\n");
  const codex = Buffer.from("model = 'test'\r\n");
  await fsp.writeFile(path.join(root, ".claude", "settings.local.json"), claude);
  await fsp.writeFile(path.join(root, ".codex", "config.toml"), codex);
  const plan = await planNeutralInstall({ target: root, roles: { writer: "codex", reviewer: "claude" } });
  assert.equal((await applyNeutralInstall(plan, plan.plan_sha256)).ok, true);
  assert.equal((await verifyNeutralInstall(root)).valid, true);
  assert.deepEqual(await fsp.readFile(path.join(root, ".claude", "settings.local.json")), claude);
  assert.deepEqual(await fsp.readFile(path.join(root, ".codex", "config.toml")), codex);
  await assert.rejects(planNeutralInstall({ target: root, roles: plan.roles }), /already exists/);
  // The project holds settings, the template and state; the runtime stays in the Bridge folder.
  assert.equal(await fsp.stat(path.join(root, ".review-bridge", "tools")).catch(() => null), null);
});

test("Git project gets local private exclusion without changing tracked ignore or agent settings", async (t) => {
  const root = await workspace(t);
  const init = spawnSync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
  assert.equal(init.status, 0);
  await fsp.writeFile(path.join(root, ".gitignore"), "dist/\n");
  const plan = await planNeutralInstall({ target: root, roles: { writer: "claude", reviewer: "codex" } });
  assert.equal(plan.git.repository, true);
  assert.equal(plan.git.ignored, false);
  await applyNeutralInstall(plan, plan.plan_sha256);
  const ignored = spawnSync("git", ["check-ignore", "-q", "--no-index", ".review-bridge/bridge.json"], {
    cwd: root, windowsHide: true,
  });
  assert.equal(ignored.status, 0);
  // Bridge touches no file the person tracks: .review-bridge/, results included, is excluded locally.
  assert.equal(await fsp.readFile(path.join(root, ".gitignore"), "utf8"), "dist/\n");
  assert.equal(spawnSync("git", ["check-ignore", "-q", "--no-index", ".review-bridge/results/a.md"], { cwd: root, windowsHide: true }).status, 0);
  assert.equal((await verifyNeutralInstall(root)).valid, true);
});

// CI's Windows runner has an 8.3 TEMP (C:\Users\RUNNER~1\...), while Git names its folder in full.
function shortName(folder) {
  const result = spawnSync("cmd.exe", ["/d", "/s", "/c", "\"for %I in (\"" + folder + "\") do @echo %~sI\""], {
    encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

test("a Git project named by its Windows short path is set up and excluded like any other", { skip: process.platform !== "win32" && "8.3 short names are Windows only" }, async (t) => {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-long-folder-name-"));
  t.after(() => fsp.rm(parent, { recursive: true, force: true }));
  const short = shortName(parent);
  if (!short || !short.includes("~")) return t.skip("this volume makes no 8.3 short names");
  const root = path.join(short, "my-app");
  await fsp.mkdir(root);
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: root, windowsHide: true }).status, 0);
  const plan = await planNeutralInstall({ target: root, roles: { writer: "claude", reviewer: "codex" } });
  assert.equal(plan.git.repository, true);
  await applyNeutralInstall(plan, plan.plan_sha256);
  const ignored = spawnSync("git", ["check-ignore", "-q", "--no-index", ".review-bridge/bridge.json"], { cwd: root, windowsHide: true });
  assert.equal(ignored.status, 0);
  assert.equal((await verifyNeutralInstall(root)).valid, true);
});

// git init in an existing repository reinitializes it (git setup.c): what is missing is made, nothing is
// overwritten. Here the data folder lost the install record (deleted, another machine).
test("reinit: .review-bridge/ without its install record gets the record back and keeps every file of the person's", async (t) => {
  const root = await workspace(t);
  const plan = await planNeutralInstall({ target: root, roles: { writer: "claude", reviewer: "codex" } });
  await applyNeutralInstall(plan, plan.plan_sha256);
  const privateRoot = path.join(root, ".review-bridge");
  assert.equal(await reinitializeNeutralInstall({ target: root }), null, "with its record it is an install, which upgrade moves");
  await fsp.appendFile(path.join(privateRoot, "rules.md"), "- Mine.\n");
  await fsp.writeFile(path.join(privateRoot, "work-packages", "farm.md"), "<!-- bridge:requested_work -->\nBuild a farm.\n\n<!-- bridge:acceptance -->\n- The farm shows.\n");
  await fsp.rm(path.join(privateRoot, "work-packages", "TEMPLATE.md"));
  const configText = await fsp.readFile(path.join(privateRoot, "bridge.json"), "utf8");
  const paths = getBridgePaths(root, path.join(packageRoot, "review-bridge"), { privateRootName: ".review-bridge" });
  await fsp.rm(paths.stateRoot, { recursive: true, force: true });
  const before = new Map(await fileSnapshot(privateRoot));

  const done = await reinitializeNeutralInstall({ target: root });
  assert.deepEqual(done.wrote, ["work-packages/TEMPLATE.md"], "only what was missing is made");
  const after = new Map(await fileSnapshot(privateRoot));
  for (const [name, hash] of before) assert.equal(after.get(name), hash, name + " is as it was");
  assert.equal(await fsp.readFile(path.join(privateRoot, "bridge.json"), "utf8"), configText);
  const record = JSON.parse(await fsp.readFile(path.join(paths.stateRoot, "review-bridge-install.json"), "utf8"));
  const installed = record.installed_files.map(([name]) => name);
  assert.ok(installed.includes("work-packages/TEMPLATE.md") && installed.includes("work-packages/TEMPLATE.zh-TW.md"), installed.join(", "));
  for (const mine of ["rules.md", "work-packages/farm.md", "bridge.json"]) assert.equal(installed.includes(mine), false, mine + " is the person's, so upgrade and uninstall keep it");
  assert.ok(record.reinitialized_at);
  await verifyNeutralInstall(root);
  assert.equal(await reinitializeNeutralInstall({ target: root }), null, "once rebuilt, it is an install again");
});

test("stale or modified plan cannot create neutral state", async (t) => {
  const root = await workspace(t);
  const plan = await planNeutralInstall({ target: root, roles: { writer: "codex", reviewer: "claude" } });
  await assert.rejects(applyNeutralInstall({ ...plan, roles: { writer: "claude", reviewer: "codex" } }, plan.plan_sha256), /approval is invalid/);
  await fsp.rm(path.join(root, "package.json"));
  await assert.rejects(applyNeutralInstall(plan, plan.plan_sha256));
  assert.equal(await fsp.stat(path.join(root, ".review-bridge")).catch(() => null), null);
});

test("fresh setup rollback removes only unchanged Bridge state", async (t) => {
  const root = await workspace(t);
  const init = spawnSync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
  assert.equal(init.status, 0);
  const excludePath = path.join(root, ".git", "info", "exclude");
  await fsp.writeFile(excludePath, "# preserve exactly");
  const plan = await planNeutralInstall({ target: root, roles: { writer: "claude", reviewer: "codex" } });
  await applyNeutralInstall(plan, plan.plan_sha256);
  assert.equal((await rollbackFreshNeutralInstall(plan)).rolled_back, true);
  assert.equal(await fsp.stat(path.join(root, ".review-bridge")).catch(() => null), null);
  const ignored = spawnSync("git", ["check-ignore", "-q", "--no-index", ".review-bridge/bridge.json"], {
    cwd: root, windowsHide: true,
  });
  assert.equal(ignored.status, 1);
  assert.equal(await fsp.readFile(excludePath, "utf8"), "# preserve exactly");
  assert.equal(await fsp.stat(path.join(root, "package.json")).then((value) => value.isFile()), true);
});

test("install lock prevents concurrent or stale setup from changing target", async (t) => {
  const root = await workspace(t);
  const lockPath = path.join(root, ".review-bridge-install.lock");
  await fsp.writeFile(lockPath, "someone else owns this lock\n");
  const plan = await planNeutralInstall({ target: root, roles: { writer: "claude", reviewer: "codex" } });
  await assert.rejects(applyNeutralInstall(plan, plan.plan_sha256), /install lock/);
  assert.equal(await fsp.readFile(lockPath, "utf8"), "someone else owns this lock\n");
  assert.equal(await fsp.stat(path.join(root, ".review-bridge")).catch(() => null), null);
});

test("fresh setup rollback refuses to remove later user state", async (t) => {
  const root = await workspace(t);
  const plan = await planNeutralInstall({ target: root, roles: { writer: "claude", reviewer: "codex" } });
  await applyNeutralInstall(plan, plan.plan_sha256);
  const extra = path.join(root, ".review-bridge", "work-packages", "user.md");
  await fsp.writeFile(extra, "user state\n");
  await assert.rejects(rollbackFreshNeutralInstall(plan), /state changed/);
  assert.equal(await fsp.readFile(extra, "utf8"), "user state\n");
});

test("bridge.json carries an owner-editable watch block that verify checks for shape only", async (t) => {
  const root = await workspace(t);
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const plan = await planNeutralInstall({ target: root, roles: { writer: "claude", reviewer: "codex" }, watchPort: port });
  assert.deepEqual(plan.watch, { port, strict_port: false });
  await applyNeutralInstall(plan, plan.plan_sha256);
  const configPath = path.join(root, ".review-bridge", "bridge.json");
  const config = JSON.parse(await fsp.readFile(configPath, "utf8"));
  assert.deepEqual(config.watch, { port, strict_port: false });
  // T0-02 R3.1: retention ships with the 15-day default and is owner-editable.
  assert.deepEqual(plan.retention, { days: 15 });
  assert.deepEqual(config.retention, { days: 15 });
  // The work-order templates are the packaged ones, in English and Chinese, for people to fill in;
  // the install records each one's hash. rules.md is installed and owner-editable.
  const template = await fsp.readFile(path.join(root, ".review-bridge", "work-packages", "TEMPLATE.md"), "utf8");
  assert.equal(template, await fsp.readFile(new URL("../project-templates/work-package.md", import.meta.url), "utf8"));
  // A work order becomes a contract by form check: what to do and an acceptance list are the two blocks
  // every work order needs, and each template says so on their headings.
  assert.match(template, /^<!-- bridge:requested_work -->\n## Work \(required\)$/m);
  assert.match(template, /^<!-- bridge:acceptance -->\n## Acceptance \(required: one result per item, each starting with "- "/m);
  const chinese = await fsp.readFile(path.join(root, ".review-bridge", "work-packages", "TEMPLATE.zh-TW.md"), "utf8");
  assert.equal(chinese, await fsp.readFile(new URL("../project-templates/work-package.zh-TW.md", import.meta.url), "utf8"));
  assert.match(chinese, /^<!-- bridge:requested_work -->\n## 要做的事（必填）$/m);
  assert.match(chinese, /^<!-- bridge:acceptance -->\n## 驗收（必填：一條一個結果，每條用「- 」開頭/m);
  const { createHash } = await import("node:crypto");
  const hashOf = (text) => createHash("sha256").update(text).digest("hex");
  assert.deepEqual(JSON.parse(await fsp.readFile(getBridgePaths(root, path.join(packageRoot, "review-bridge"), { privateRootName: ".review-bridge" }).installManifestPath, "utf8")).work_template_sha256, {
    "work-packages/TEMPLATE.md": hashOf(template), "work-packages/TEMPLATE.zh-TW.md": hashOf(chinese),
  });
  // Each template the install recorded has to exist.
  await fsp.rm(path.join(root, ".review-bridge", "work-packages", "TEMPLATE.zh-TW.md"));
  await assert.rejects(verifyNeutralInstall(root), /Neutral work template is missing or empty \(\.review-bridge\/work-packages\/TEMPLATE\.zh-TW\.md\)/);
  await fsp.writeFile(path.join(root, ".review-bridge", "work-packages", "TEMPLATE.zh-TW.md"), chinese);
  const rulesPath = path.join(root, ".review-bridge", "rules.md");
  assert.ok((await fsp.readFile(rulesPath, "utf8")).length > 0);
  await fsp.writeFile(rulesPath, "# 我的規則\n不要動測試。\n");
  await verifyNeutralInstall(root);
  await fsp.writeFile(rulesPath, "");
  await assert.rejects(verifyNeutralInstall(root), /rules digest/);
  await fsp.writeFile(rulesPath, "# 規則\n");
  assert.equal((await verifyNeutralInstall(root)).valid, true);
  await fsp.writeFile(configPath, JSON.stringify({ ...config, watch: { port: port + 1, strict_port: true } }));
  assert.equal((await verifyNeutralInstall(root)).valid, true);
  await fsp.writeFile(configPath, JSON.stringify({ ...config, retention: { days: 30 } }));
  await verifyNeutralInstall(root);
  await fsp.writeFile(configPath, JSON.stringify({ ...config, retention: { days: 0 } }));
  await assert.rejects(verifyNeutralInstall(root), /retention\.days/);
  await fsp.writeFile(configPath, JSON.stringify({ ...config, watch: { port: "eighty", strict_port: false } }));
  await assert.rejects(verifyNeutralInstall(root), /Watch port/);
  await assert.rejects(planNeutralInstall({ target: root, roles: plan.roles, watchPort: 70000 }));
});

// RC3-ENTRY-02: the project keeps nothing of an agent's; each agent's entry is at user level.
test("init leaves a clean Git project clean: no .claude/, AGENTS.md or CLAUDE.md change, and git status shows nothing", async (t) => {
  separatePerson(t);
  const root = await workspace(t);
  const git = (...args) => spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8", windowsHide: true });
  const agents = Buffer.from("# Rules\r\n\r\nNo trailing newline here.");
  const claude = Buffer.from("# Claude rules\n");
  await fsp.writeFile(path.join(root, "AGENTS.md"), agents);
  await fsp.writeFile(path.join(root, "CLAUDE.md"), claude);
  assert.equal(git("init", "--quiet").status, 0);
  assert.equal(git("add", "-A").status, 0);
  assert.equal(git("commit", "--quiet", "-m", "start").status, 0);
  const plan = await planNeutralInstall({ target: root, roles: { writer: "claude", reviewer: "codex" } });
  await applyNeutralInstall(plan, plan.plan_sha256);
  assert.equal(git("status", "--porcelain", "--untracked-files=all", "--ignored=no").stdout, "");
  assert.deepEqual(await fsp.readFile(path.join(root, "AGENTS.md")), agents);
  assert.deepEqual(await fsp.readFile(path.join(root, "CLAUDE.md")), claude);
  assert.equal(await fsp.stat(path.join(root, ".claude")).catch(() => null), null);
  assert.equal(await fsp.stat(path.join(root, ".codex")).catch(() => null), null);
  assert.equal(await fsp.stat(path.join(root, ".gitignore")).catch(() => null), null);

  const bare = await workspace(t);
  const again = await planNeutralInstall({ target: bare, roles: { writer: "claude", reviewer: "codex" } });
  await applyNeutralInstall(again, again.plan_sha256);
  assert.equal(await fsp.stat(path.join(bare, "AGENTS.md")).catch(() => null), null, "no AGENTS.md is created");
});

test("init puts each agent's /review-bridge entry where its CLI looks; the person's other files there stay", async (t) => {
  const me = separatePerson(t);
  const root = await workspace(t);
  const theirs = Buffer.from("# My global rules\n");
  await fsp.mkdir(me.codexHome, { recursive: true });
  await fsp.writeFile(path.join(me.codexHome, "AGENTS.md"), theirs);
  const plan = await planNeutralInstall({ target: root, roles: { writer: "claude", reviewer: "codex" } });
  assert.deepEqual(plan.agent_entries, [
    { provider: "claude", path: me.claudeEntry, action: "add" },
    { provider: "codex", path: me.codexEntry, action: "add" },
  ]);
  await applyNeutralInstall(plan, plan.plan_sha256);
  const command = await fsp.readFile(me.claudeEntry, "utf8");
  assert.match(command, /^---\ndescription: .+\nargument-hint: .+\n---\n/);
  assert.match(command, /^argument-hint: start <file> \| stop <run_id> \| resume <run_id> \| clean \[<run_id>\]$/m);
  assert.match(command, /four actions \(\$ARGUMENTS\)/);
  assert.match(command, /show the\s+person the card exactly as printed[\s\S]*Only if the person says yes, run the same command again with .--yes./);
  // Codex takes a skill: it requires the description, and it expands no arguments, so none is promised.
  const skill = await fsp.readFile(me.codexEntry, "utf8");
  assert.match(skill, /^---\nname: review-bridge\ndescription: .+\n---\n/);
  assert.doesNotMatch(skill, /\$ARGUMENTS|\{\{args\}\}|argument-hint/);
  assert.match(skill, /one of\nfour actions:/);
  assert.match(skill, /show the\s+person the card exactly as printed[\s\S]*Only if the person says yes, run the same command again with .--yes./);
  assert.deepEqual(await fsp.readFile(path.join(me.codexHome, "AGENTS.md")), theirs);
  assert.equal((await verifyNeutralInstall(root)).valid, true);

  // The places are the ones the CLIs read. Codex's user skills are under the home directory,
  // wherever CODEX_HOME points (openai/codex ext/skills/src/host_roots.rs).
  const home = path.resolve("H");
  assert.deepEqual(agentEntryFiles({ env: {}, home }).map((entry) => entry.file), [
    path.join(home, ".claude", "commands", "review-bridge.md"),
    path.join(home, ".agents", "skills", "review-bridge", "SKILL.md"),
  ]);
  assert.deepEqual(agentEntryFiles({ env: { CLAUDE_CONFIG_DIR: path.resolve("C"), CODEX_HOME: path.resolve("X") }, home }).map((entry) => entry.file), [
    path.join(path.resolve("C"), "commands", "review-bridge.md"),
    path.join(home, ".agents", "skills", "review-bridge", "SKILL.md"),
  ]);
});

test("a file of the person's at an entry's path is left alone; Bridge's older copy is replaced; this one is left as it is", async (t) => {
  const me = separatePerson(t);
  const first = await workspace(t);
  await fsp.mkdir(path.dirname(me.claudeEntry), { recursive: true });
  await fsp.writeFile(me.claudeEntry, "my own command\n");
  const plan = await planNeutralInstall({ target: first, roles: { writer: "claude", reviewer: "codex" } });
  assert.deepEqual(plan.agent_entries.map((entry) => entry.action), ["keep", "add"]);
  await applyNeutralInstall(plan, plan.plan_sha256);
  assert.equal(await fsp.readFile(me.claudeEntry, "utf8"), "my own command\n");
  const current = await fsp.readFile(me.codexEntry, "utf8");

  // What an older Bridge wrote: the record names it, so it is Bridge's to replace.
  const older = "older steps\n";
  await fsp.writeFile(me.codexEntry, older);
  const record = JSON.parse(await fsp.readFile(me.record, "utf8"));
  assert.deepEqual(record.entries.map((entry) => entry.path), [me.codexEntry], "only what Bridge wrote is recorded");
  record.entries[0].sha256 = createHash("sha256").update(older).digest("hex");
  await fsp.writeFile(me.record, JSON.stringify(record));
  const second = await workspace(t);
  const next = await planNeutralInstall({ target: second, roles: { writer: "claude", reviewer: "codex" } });
  assert.deepEqual(next.agent_entries.map((entry) => entry.action), ["keep", "replace"]);
  await applyNeutralInstall(next, next.plan_sha256);
  assert.equal(await fsp.readFile(me.codexEntry, "utf8"), current);

  const third = await workspace(t);
  const same = await planNeutralInstall({ target: third, roles: { writer: "claude", reviewer: "codex" } });
  assert.deepEqual(same.agent_entries.map((entry) => entry.action), ["keep", "unchanged"]);
});

test("install rollback takes the entries back unless another project uses them or they were edited", async (t) => {
  const me = separatePerson(t);
  const roles = { writer: "claude", reviewer: "codex" };
  const root = await workspace(t);
  const plan = await planNeutralInstall({ target: root, roles });
  await applyNeutralInstall(plan, plan.plan_sha256);
  const rolled = await rollbackFreshNeutralInstall(plan);
  assert.deepEqual(rolled.agent_entries.map((entry) => entry.outcome), ["removed", "removed"]);
  for (const gone of [me.claudeHome, path.join(me.home, ".agents"), me.record]) assert.equal(await fsp.stat(gone).catch(() => null), null, gone + " is gone");

  const staying = await workspace(t);
  const stayingPlan = await planNeutralInstall({ target: staying, roles });
  await applyNeutralInstall(stayingPlan, stayingPlan.plan_sha256);
  const leaving = await workspace(t);
  const leavingPlan = await planNeutralInstall({ target: leaving, roles });
  await applyNeutralInstall(leavingPlan, leavingPlan.plan_sha256);
  assert.deepEqual((await rollbackFreshNeutralInstall(leavingPlan)).agent_entries.map((entry) => entry.outcome), ["kept_in_use", "kept_in_use"]);
  assert.ok(await fsp.stat(me.claudeEntry));

  await fsp.appendFile(me.claudeEntry, "edited\n");
  assert.deepEqual((await rollbackFreshNeutralInstall(stayingPlan)).agent_entries.map((entry) => entry.outcome), ["kept_changed", "removed"]);
  assert.match(await fsp.readFile(me.claudeEntry, "utf8"), /edited\n$/);
  assert.equal(await fsp.stat(me.codexEntry).catch(() => null), null);
});

async function tree(t, files, directories = []) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-tree-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  for (const directory of directories) await fsp.mkdir(path.join(root, ...directory.split("/")), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(root, ...name.split("/"))), { recursive: true });
    await fsp.writeFile(path.join(root, ...name.split("/")), text);
  }
  return root;
}

// The expected values were recorded when these walks called themselves; the queue and stack
// versions are held to the same output.
const NESTED_FILES = { "B.txt": "b\n", "a.txt": "a\n", "a/x.txt": "ax\n", "a/b/c/deep.txt": "deep\n", "a-b/z.txt": "z\n", "é.txt": "e\n" };

test("a nested folder has the same runtime fingerprint and file snapshot as before the walk used a queue", async (t) => {
  const root = await tree(t, NESTED_FILES, ["a/b/empty"]);
  assert.equal(await runtimeFingerprint(root), "27a5bdb30a18abc5c20bc3ace360e026fc5d00e3fa447a1dfd5527e37fe2e9bb");
  assert.deepEqual(await fileSnapshot(root), [
    ["a-b/z.txt", "c865f6c5ab8d1b0bcd383a5e1e3879d22681c96bf462c269b7581d523fbe70ab"],
    ["a.txt", "87428fc522803d31065e7bce3cf03fe475096631e5e07bbd7a0fde60c4cf25c7"],
    ["a/b/c/deep.txt", "64896f89fd11190013b70103e603a1c5826e56b7fb7d2197ab279b0690043599"],
    ["a/x.txt", "18b22c496be9a73d8aceeed68339bb1e93487725bedb32a8df0bc5a694a9854a"],
    ["B.txt", "0263829989b6fd954f72baaf2fc64bc2e2f01d692d4de72986ea808f6e99813f"],
    ["é.txt", "a2bbdb2de53523b8099b37013f251546f3d65dbe7a0774fa41af0a4176992fd4"],
  ]);
});

test("empty folders are removed deepest first, and the folder itself when nothing is left", async (t) => {
  const mixed = await tree(t, { "keep/file.txt": "k\n" }, ["keep/empty1/empty2", "gone/g1/g2", "gone2"]);
  await removeEmptyDirectories(mixed);
  assert.deepEqual(await fsp.readdir(mixed, { recursive: true }).then((names) => names.map((name) => name.replaceAll("\\", "/")).sort()), ["keep","keep/file.txt"]);
  const empty = await tree(t, {}, ["e1/e2/e3"]);
  await removeEmptyDirectories(empty);
  assert.equal(await fsp.stat(empty).then(() => "kept", () => "removed"), "removed");
});
