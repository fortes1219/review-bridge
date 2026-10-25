// Keeps the person's database out of these tests (see the fixture).
import "../review-bridge/tests/fixtures/isolatedDataHome.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyNeutralInstall, planNeutralInstall, rollbackFreshNeutralInstall, verifyNeutralInstall } from "../installer/neutral-install.mjs";

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
  const ignored = spawnSync("git", ["check-ignore", "-q", "--no-index", ".review-bridge/review-bridge-install.json"], {
    cwd: root, windowsHide: true,
  });
  assert.equal(ignored.status, 0);
  assert.equal(await fsp.readFile(path.join(root, ".gitignore"), "utf8"), "dist/\n");
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
  const ignored = spawnSync("git", ["check-ignore", "-q", "--no-index", ".review-bridge/review-bridge-install.json"], { cwd: root, windowsHide: true });
  assert.equal(ignored.status, 0);
  assert.equal((await verifyNeutralInstall(root)).valid, true);
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
  const ignored = spawnSync("git", ["check-ignore", "-q", "--no-index", ".review-bridge/review-bridge-install.json"], {
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
  const configPath = path.join(root, ".review-bridge", "review-bridge", "bridge.json");
  const config = JSON.parse(await fsp.readFile(configPath, "utf8"));
  assert.deepEqual(config.watch, { port, strict_port: false });
  // T0-02 R3.1: retention ships with the 15-day default and is owner-editable.
  assert.deepEqual(plan.retention, { days: 15 });
  assert.deepEqual(config.retention, { days: 15 });
  // The work-order template is the packaged one, for people to fill in; rules.md is installed and owner-editable.
  const template = await fsp.readFile(path.join(root, ".review-bridge", "work-packages", "TEMPLATE.md"), "utf8");
  assert.equal(template, await fsp.readFile(new URL("../project-templates/work-package.md", import.meta.url), "utf8"));
  assert.match(template, /^## Acceptance$/m);
  const rulesPath = path.join(root, ".review-bridge", "review-bridge", "rules.md");
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

// B3: init adds Claude Code's /review-bridge command and the same note in AGENTS.md.
test("install adds the /review-bridge command and appends to AGENTS.md; a project's own command file is kept", async (t) => {
  const root = await workspace(t);
  const agents = Buffer.from("# Project rules\r\n\r\nNo trailing newline here.");
  await fsp.writeFile(path.join(root, "AGENTS.md"), agents);
  const plan = await planNeutralInstall({ target: root, roles: { writer: "claude", reviewer: "codex" } });
  assert.deepEqual(plan.agent_files, {
    command: { path: ".claude/commands/review-bridge.md", action: "create" },
    agents: { path: "AGENTS.md", action: "append" },
  });
  await applyNeutralInstall(plan, plan.plan_sha256);
  const command = await fsp.readFile(path.join(root, ".claude", "commands", "review-bridge.md"), "utf8");
  assert.match(command, /^---\ndescription: .+\nargument-hint: .+\n---\n/);
  assert.match(command, /^argument-hint: start <file> \| stop <run_id> \| resume <run_id> \| clean \[<run_id>\]$/m);
  assert.match(command, /four actions \(\$ARGUMENTS\)/);
  assert.match(command, /show the\s+person the card exactly as printed[\s\S]*Only if the person says yes, run the same command again with `--yes`/);
  const after = await fsp.readFile(path.join(root, "AGENTS.md"));
  assert.deepEqual(after.subarray(0, agents.length), agents, "the existing text is kept byte for byte");
  assert.match(after.subarray(agents.length).toString("utf8"), /^\n\n<!-- review-bridge:start -->\n## Review Bridge\n[\s\S]*`review-bridge <action> <file\|run_id>`[\s\S]*<!-- review-bridge:end -->\n$/);
  assert.equal((await verifyNeutralInstall(root)).valid, true);

  const second = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-neutral-test-"));
  t.after(() => fsp.rm(second, { recursive: true, force: true }));
  await fsp.mkdir(path.join(second, ".claude", "commands"), { recursive: true });
  await fsp.writeFile(path.join(second, ".claude", "commands", "review-bridge.md"), "my own command\n");
  await fsp.writeFile(path.join(second, "AGENTS.md"), after);
  const kept = await planNeutralInstall({ target: second, profileId: "none", roles: { writer: "claude", reviewer: "codex" } });
  assert.deepEqual(kept.agent_files, {
    command: { path: ".claude/commands/review-bridge.md", action: "keep" },
    agents: { path: "AGENTS.md", action: "keep" },
  });
  await applyNeutralInstall(kept, kept.plan_sha256);
  assert.equal(await fsp.readFile(path.join(second, ".claude", "commands", "review-bridge.md"), "utf8"), "my own command\n");
  assert.deepEqual(await fsp.readFile(path.join(second, "AGENTS.md")), after);
});

test("install rollback removes the agent files it wrote and restores AGENTS.md; an edited one is kept", async (t) => {
  const root = await workspace(t);
  const plan = await planNeutralInstall({ target: root, roles: { writer: "claude", reviewer: "codex" } });
  await applyNeutralInstall(plan, plan.plan_sha256);
  const rolled = await rollbackFreshNeutralInstall(plan);
  assert.deepEqual(rolled.agent_files, { command: "removed", agents: "removed" });
  assert.equal(await fsp.stat(path.join(root, ".claude")).catch(() => null), null, "the folders init made are gone too");
  assert.equal(await fsp.stat(path.join(root, "AGENTS.md")).catch(() => null), null, "an AGENTS.md init created is gone");

  const edited = await workspace(t);
  await fsp.writeFile(path.join(edited, "AGENTS.md"), "# Rules\n");
  const again = await planNeutralInstall({ target: edited, roles: { writer: "claude", reviewer: "codex" } });
  await applyNeutralInstall(again, again.plan_sha256);
  await fsp.appendFile(path.join(edited, "AGENTS.md"), "My own line.\n");
  await fsp.appendFile(path.join(edited, ".claude", "commands", "review-bridge.md"), "edited\n");
  assert.deepEqual((await rollbackFreshNeutralInstall(again)).agent_files, { command: "kept_changed", agents: "kept_changed" });
  assert.match(await fsp.readFile(path.join(edited, "AGENTS.md"), "utf8"), /My own line\.\n$/);
  assert.match(await fsp.readFile(path.join(edited, ".claude", "commands", "review-bridge.md"), "utf8"), /edited\n$/);
});
