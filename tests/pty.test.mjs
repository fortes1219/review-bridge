// Keeps the person's database out of these tests (see the fixture).
import { dataHome, queryRecords } from "../review-bridge/tests/fixtures/isolatedDataHome.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { KEYS, ptySkip, terminal } from "./pty.mjs";

// What a person sees at a real terminal: the Guide's three questions, start's card answered y or n,
// and Ctrl+C on the first question. The fake CLI does the work; no model is called. Skipped, with
// the reason, where no pseudo-terminal can be opened.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridge = path.join(packageRoot, "bridge.mjs");
const home = fsSync.mkdtempSync(path.join(os.tmpdir(), "review-bridge-pty-home-"));
process.on("exit", () => { try { fsSync.rmSync(home, { recursive: true, force: true }); } catch {} });

function env() {
  const system = process.platform === "win32" ? [process.env.SystemRoot && path.join(process.env.SystemRoot, "System32")] : ["/usr/bin", "/bin"];
  return {
    PATH: [path.dirname(process.execPath), ...system].filter(Boolean).join(path.delimiter),
    HOME: home, USERPROFILE: home, TEMP: os.tmpdir(), TMP: os.tmpdir(),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    CLAUDE_REVIEW_CLI: path.join(home, "absent", "claude"),
    CODEX_REVIEW_CLI: path.join(home, "absent", "codex"),
    REVIEW_BRIDGE_DATA_HOME: dataHome,
  };
}

async function folder(t, prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    spawnSync(process.execPath, [bridge, "down"], { cwd: dir, env: env(), windowsHide: true });
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return dir;
}

// A project set up without a terminal, with one work order in it.
async function project(t) {
  const root = await folder(t, "review-bridge-pty-project-");
  const init = spawnSync(process.execPath, [bridge, "init", "--yes", "--fake-cli"], { cwd: root, env: env(), encoding: "utf8", windowsHide: true });
  assert.equal(init.status, 0, init.stderr);
  const order = ".review-bridge/work-packages/hello.md";
  await fsp.writeFile(path.join(root, order), "# 工單：新增 README\n\n<!-- bridge:requested_work -->\n在專案根目錄加一個 README。\n\n<!-- bridge:acceptance -->\n## 驗收\n\n1. 專案根目錄存在 `README.md`。\n");
  return { root, order };
}

test("the Guide at a terminal: Enter on its three questions sets the folder up and ends with Done", { skip: ptySkip, timeout: 240_000 }, async (t) => {
  const root = await folder(t, "review-bridge-pty-guide-");
  const guide = terminal([bridge, "init", "--fake-cli"], { cwd: root, env: env() });
  t.after(() => guide.kill());
  for (const question of [/Select writer:/, /Select reviewer:/, /Select project type:/]) {
    await guide.waitFor(question);
    guide.press(KEYS.enter);
  }
  assert.equal(await guide.exited, 0, guide.text());
  assert.match(guide.text(), /Done\. Now:/);
  assert.match(guide.text(), /review-bridge start \.review-bridge\/work-packages\/<file>\.md/);
  const config = JSON.parse(await fsp.readFile(path.join(root, ".review-bridge", "review-bridge", "bridge.json"), "utf8"));
  assert.deepEqual([config.roles.writer.provider_id, config.roles.reviewer.provider_id], ["claude", "codex"]);
});

test("Ctrl+C on the Guide's first question cancels and sets nothing up", { skip: ptySkip, timeout: 120_000 }, async (t) => {
  const root = await folder(t, "review-bridge-pty-cancel-");
  const guide = terminal([bridge, "init", "--fake-cli"], { cwd: root, env: env() });
  t.after(() => guide.kill());
  await guide.waitFor(/Select writer:/);
  guide.press(KEYS.ctrlC);
  assert.equal(await guide.exited, 0, guide.text());
  assert.match(guide.text(), /Operation cancelled\./);
  assert.equal(await fsp.stat(path.join(root, ".review-bridge")).catch(() => null), null);
});

async function card(t, answer) {
  const { root, order } = await project(t);
  const start = terminal([bridge, "start", order, "--fake-cli"], { cwd: root, env: env() });
  t.after(() => start.kill());
  await start.waitFor(/Where should the work stop/);
  start.press(KEYS.enter);
  await start.waitFor(/Start this work\? \[y\/N\]/);
  start.press(answer + KEYS.enter);
  const code = await start.exited;
  const { project_id: projectId } = JSON.parse(await fsp.readFile(path.join(root, ".review-bridge", "review-bridge", "bridge.json"), "utf8"));
  return { code, text: start.text(), projectId };
}

test("start at a terminal: the card, y, and the work runs on the person's own yes", { skip: ptySkip, timeout: 240_000 }, async (t) => {
  const { code, text, projectId } = await card(t, "y");
  assert.equal(code, 0, text);
  assert.match(text, /New work order "工單：新增 README"/);
  assert.match(text, /Delivered: no tests configured, reviewer passed/);
  const rows = await queryRecords("select a.authorized_via from authorizations a join plans p using (plan_sha256) where p.project_id = $1", [projectId]);
  assert.deepEqual(rows, [{ authorized_via: "terminal" }]);
});

test("start at a terminal: the card, n, nothing starts and the card is withdrawn", { skip: ptySkip, timeout: 240_000 }, async (t) => {
  const { code, text, projectId } = await card(t, "n");
  assert.equal(code, 1, text);
  assert.match(text, /Not started\. Nothing was authorized\./);
  const [plan] = await queryRecords("select shown_at, withdrawn_at from plans where project_id = $1", [projectId]);
  assert.ok(plan.shown_at && plan.withdrawn_at, "shown, then answered no");
  assert.deepEqual(await queryRecords("select run_id from runs where project_id = $1", [projectId]), []);
});
