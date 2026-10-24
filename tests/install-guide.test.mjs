import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { commandLink } from "../installer/command-link.mjs";
import { runNpm } from "../installer/dependencies.mjs";
import { formatGuidePlan, installGuide, terminalUi } from "../installer/install-guide.mjs";
import { readDefaultRoles, saveDefaultRoles, settingsFile } from "../installer/personal-settings.mjs";
import { postgresPackageName } from "../review-bridge/service/database/platformPackages.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const signedIn = { cli_present: true, authenticated: true };
const noCli = { cli_present: false, authenticated: "unknown" };

async function tempDir(t, prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

// A Guide run whose installers are stand-ins: they record what they were asked to do. The menu
// answers come from `answers`, in the order the Guide asks.
async function guide(t, options, { answers = [], confirm = true, problems = ["pg is not installed"], link = { linked: false, points_to: null }, linkWorks = true, saved = null } = {}) {
  const dataHome = await tempDir(t, "review-bridge-guide-home-");
  if (saved) await saveDefaultRoles(saved, { dataHome });
  const calls = { asked: [], confirmed: 0, installs: 0, links: 0, written: "" };
  let linked = link;
  const ui = {
    async choose(title, choices, initial) {
      calls.asked.push({ title, choices: choices.map((choice) => choice.label), initial });
      return answers.shift();
    },
    async confirm() { calls.confirmed += 1; return confirm; },
  };
  const run = installGuide(packageRoot, options, {
    ui,
    write: (text) => { calls.written += text; },
    inspectProvider: async (provider) => (provider === "claude" ? signedIn : noCli),
    dataHome,
    problemsOf: async () => problems,
    ensure: async () => { calls.installs += 1; return { installed: problems.length > 0 }; },
    linkState: () => ({ command_folder: path.join(dataHome, "npm"), on_path: true, ...linked }),
    link: () => { calls.links += 1; if (linkWorks) linked = { linked: true, points_to: packageRoot }; },
  });
  return { run, calls, dataHome };
}

test("the Guide asks writer then reviewer, shows the plan, and installs only after yes", async (t) => {
  const { run, calls, dataHome } = await guide(t, {}, { answers: ["codex", "claude"] });
  const result = await run;
  assert.deepEqual(calls.asked.map((ask) => ask.title), ["選擇 writer", "選擇 reviewer"]);
  assert.deepEqual(calls.asked[0].choices, ["claude — 已登入", "codex — CLI 未安裝"]);
  assert.equal(calls.confirmed, 1);
  assert.deepEqual([calls.installs, calls.links], [1, 1]);
  assert.deepEqual(result.roles, { writer: "codex", reviewer: "claude" });
  assert.deepEqual(await readDefaultRoles({ dataHome }), { writer: "codex", reviewer: "claude" });
  assert.equal(result.next_step, "review-bridge init --target <專案資料夾>");
  // The plan names the install place, every locked package and where personal data goes.
  assert.match(calls.written, new RegExp("安裝位置：" + packageRoot.replace(/[\\.]/g, "\\$&")));
  for (const name of ["pg 8.23.1", "embedded-postgres 18.4.0-beta.17", postgresPackageName()]) assert.ok(calls.written.includes(name), name);
  assert.ok(calls.written.includes("（PostgreSQL 執行檔）"));
  assert.ok(calls.written.includes("預設角色存在：" + settingsFile(dataHome)));
  assert.ok(calls.written.includes("註冊 review-bridge"));
  // The plan is shown before anything is installed.
  assert.ok(calls.written.indexOf("Review Bridge 會這樣安裝") >= 0);
});

test("answering no installs nothing, registers nothing and saves no defaults", async (t) => {
  const { run, calls, dataHome } = await guide(t, {}, { answers: ["claude", "codex"], confirm: false });
  await assert.rejects(run, /Installation cancelled by user/);
  assert.deepEqual([calls.installs, calls.links], [0, 0]);
  assert.equal(await readDefaultRoles({ dataHome }), null);
});

test("a role given on the command line is not asked again; a saved default is the menu's starting choice", async (t) => {
  const { run, calls } = await guide(t, { writer: "claude" }, { answers: ["codex"], saved: { writer: "codex", reviewer: "codex" } });
  assert.deepEqual((await run).roles, { writer: "claude", reviewer: "codex" });
  assert.deepEqual(calls.asked.map((ask) => [ask.title, ask.initial]), [["選擇 reviewer", "codex"]]);
});

test("a scripted install needs --yes, and roles from the command line or saved defaults", async (t) => {
  const missing = await guide(t, { yes: true });
  await assert.rejects(missing.run, /Select both --writer and --reviewer explicitly/);
  const unconfirmed = await guide(t, { writer: "claude", reviewer: "codex", json: true });
  await assert.rejects(unconfirmed.run, /No terminal to confirm at\. Add --yes/);
  assert.equal(unconfirmed.calls.installs, 0);
  const fromDefaults = await guide(t, { yes: true }, { saved: { writer: "codex", reviewer: "claude" } });
  assert.deepEqual((await fromDefaults.run).roles, { writer: "codex", reviewer: "claude" });
  assert.deepEqual([fromDefaults.calls.asked.length, fromDefaults.calls.confirmed], [0, 0]);
});

test("project options are refused by name: the Guide never sets up a project", async (t) => {
  for (const key of ["profile", "port", "fake-cli"]) {
    const { run, calls } = await guide(t, { [key]: "x", yes: true, writer: "claude", reviewer: "codex" });
    await assert.rejects(run, new RegExp("--" + key + " belongs to setting up a project"));
    assert.equal(calls.installs, 0);
  }
});

test("an installed and registered Bridge is left alone; a command pointing at another copy is moved here", async (t) => {
  const done = await guide(t, { yes: true, writer: "claude", reviewer: "codex" }, { problems: [], link: { linked: true, points_to: packageRoot } });
  const result = await done.run;
  assert.equal(result.dependencies_installed, false);
  assert.equal(done.calls.links, 0);
  assert.match(done.calls.written, /依賴：已安裝，不用下載/);
  assert.match(done.calls.written, /指令：review-bridge 已註冊/);
  const elsewhere = path.join(os.tmpdir(), "another-bridge");
  const moved = await guide(t, { yes: true, writer: "claude", reviewer: "codex" }, { link: { linked: false, points_to: elsewhere } });
  await moved.run;
  assert.equal(moved.calls.links, 1);
  assert.ok(moved.calls.written.includes("目前指向另一份 Bridge（" + elsewhere + "），會改指向這份"));
});

test("a link that does not end up pointing here fails, and no defaults are saved", async (t) => {
  const { run, dataHome } = await guide(t, { yes: true, writer: "claude", reviewer: "codex" }, { linkWorks: false });
  await assert.rejects(run, /review-bridge does not point at/);
  assert.equal(await readDefaultRoles({ dataHome }), null);
});

test("saved defaults round-trip, and a damaged settings file is refused instead of read as empty", async (t) => {
  const dataHome = await tempDir(t, "review-bridge-settings-");
  assert.equal(await readDefaultRoles({ dataHome }), null);
  await saveDefaultRoles({ writer: "claude", reviewer: "codex" }, { dataHome });
  assert.deepEqual(await readDefaultRoles({ dataHome }), { writer: "claude", reviewer: "codex" });
  assert.deepEqual(await fsp.readdir(dataHome), ["settings.json"]);
  for (const text of ["{", JSON.stringify({ schema_version: 2, default_roles: { writer: "claude", reviewer: "codex" } }), JSON.stringify({ schema_version: 1, default_roles: { writer: "gpt", reviewer: "codex" } })]) {
    await fsp.writeFile(settingsFile(dataHome), text);
    await assert.rejects(readDefaultRoles({ dataHome }), /settings are not readable/);
  }
  await assert.rejects(saveDefaultRoles({ writer: "claude", reviewer: "nobody" }, { dataHome }), /reviewer must be one of/);
});

test("the command state reads npm's global folder: linked here, elsewhere, or not at all, and whether PATH reaches it", async (t) => {
  const prefix = await tempDir(t, "review-bridge-prefix-");
  const globalModules = process.platform === "win32" ? path.join(prefix, "node_modules") : path.join(prefix, "lib", "node_modules");
  const npm = (root, args) => ({ stdout: (args[0] === "root" ? globalModules : prefix) + "\n" });
  const commandFolder = process.platform === "win32" ? prefix : path.join(prefix, "bin");
  assert.deepEqual(commandLink(packageRoot, { npm, env: { PATH: commandFolder } }), { linked: false, points_to: null, command_folder: commandFolder, on_path: true });
  await fsp.mkdir(globalModules, { recursive: true });
  const name = JSON.parse(await fsp.readFile(path.join(packageRoot, "package.json"), "utf8")).name;
  await fsp.symlink(packageRoot, path.join(globalModules, name), "junction");
  t.after(() => fsp.unlink(path.join(globalModules, name)).catch(() => {}));
  const here = commandLink(packageRoot, { npm, env: { PATH: "" } });
  assert.deepEqual([here.linked, here.on_path], [true, false]);
  const other = await tempDir(t, "review-bridge-other-copy-");
  await fsp.writeFile(path.join(other, "package.json"), JSON.stringify({ name }));
  assert.equal(commandLink(other, { npm, env: {} }).linked, false);
});

// From a clean copy with no node_modules, as a person gets it from clone: the one command installs
// the dependencies and registers review-bridge (into a temporary npm global folder, never the real
// one), writes nothing into the copy but node_modules, and the printed next command runs.
async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function listFiles(root, base = root) {
  const found = [];
  for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (root === base && entry.name === "node_modules") continue;
    if (entry.isDirectory()) found.push(...await listFiles(full, base));
    else found.push(path.relative(base, full));
  }
  return found.sort();
}

test("clean clone: npm start's command installs Bridge in place and the next command it prints works", { timeout: 300_000 }, async (t) => {
  const work = await tempDir(t, "review-bridge-clean-install-");
  const copy = path.join(work, "bridge");
  const prefix = path.join(work, "npm-global");
  const dataHome = path.join(work, "data-home");
  const project = path.join(work, "project");
  const home = path.join(work, "home");
  await Promise.all([prefix, project, home].map((dir) => fsp.mkdir(dir, { recursive: true })));
  await fsp.cp(packageRoot, copy, { recursive: true, filter: (source) => !/[\\/](\.git|node_modules|\.review-bridge|\.claude|\.tmp)([\\/]|$)/.test(source) });
  await fsp.writeFile(path.join(project, "package.json"), JSON.stringify({ name: "clean-app", private: true }) + "\n");
  const before = await listFiles(copy);
  // npm still needs the machine's proxy and certificate settings to reach the registry.
  const network = Object.fromEntries(["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"]
    .filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
  const env = {
    ...network,
    PATH: [path.dirname(process.execPath), process.platform === "win32" ? prefix : path.join(prefix, "bin"), process.env.SystemRoot && path.join(process.env.SystemRoot, "System32")].filter(Boolean).join(path.delimiter),
    HOME: home, USERPROFILE: home, TEMP: os.tmpdir(), TMP: os.tmpdir(),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    REVIEW_BRIDGE_DATA_HOME: dataHome,
    CLAUDE_REVIEW_CLI: path.join(home, "absent", "claude"),
    CODEX_REVIEW_CLI: path.join(home, "absent", "codex"),
    npm_config_prefix: prefix,
    npm_config_cache: runNpm(packageRoot, ["config", "get", "cache"]).stdout.trim(),
    npm_config_prefer_offline: "true",
  };
  const start = JSON.parse(await fsp.readFile(path.join(copy, "package.json"), "utf8")).scripts.start.split(" ");
  assert.deepEqual(start.slice(0, 3), ["node", "bridge.mjs", "init"]);
  const install = (...args) => spawnSync(process.execPath, [path.join(copy, "bridge.mjs"), ...start.slice(2), ...args], {
    cwd: copy, encoding: "utf8", env, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });

  const first = install("--writer", "claude", "--reviewer", "codex", "--yes", "--json");
  assert.equal(first.status, 0, first.stderr);
  const result = JSON.parse(first.stdout);
  assert.equal(result.dependencies_installed, true);
  assert.equal(result.install_location, copy);
  assert.equal(result.command.on_path, true);
  // Only node_modules was added to the copy: no .review-bridge, no second runtime.
  assert.deepEqual(await listFiles(copy), before);
  assert.ok(fsSync.existsSync(path.join(copy, "node_modules", "pg", "package.json")));
  assert.deepEqual(await readDefaultRoles({ dataHome }), { writer: "claude", reviewer: "codex" });
  assert.equal(fsSync.realpathSync(path.join(process.platform === "win32" ? path.join(prefix, "node_modules") : path.join(prefix, "lib", "node_modules"), "codex-review-bridge-installer")), fsSync.realpathSync(copy));

  // Running it again installs nothing.
  const again = install("--yes", "--json");
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).dependencies_installed, false);

  // The next command, through the registered review-bridge, takes the saved roles without asking.
  const shim = process.platform === "win32" ? path.join(prefix, "review-bridge.cmd") : path.join(prefix, "bin", "review-bridge");
  const port = String(await freePort());
  let next;
  try {
    next = process.platform === "win32"
      ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${shim}" init --target "${project}" --yes --json --fake-cli --port ${port}"`], { cwd: project, encoding: "utf8", env, windowsHide: true, windowsVerbatimArguments: true, maxBuffer: 16 * 1024 * 1024 })
      : spawnSync(shim, ["init", "--target", project, "--yes", "--json", "--fake-cli", "--port", port], { cwd: project, encoding: "utf8", env, maxBuffer: 16 * 1024 * 1024 });
  } finally {
    // init started the project's page service; it must stop before the folder is removed.
    spawnSync(process.execPath, [path.join(project, ".review-bridge", "tools", "review-bridge", "bootstrap.mjs"), "down"], { cwd: project, encoding: "utf8", env, windowsHide: true });
  }
  assert.equal(next.status, 0, next.stderr);
  assert.deepEqual(JSON.parse(next.stdout).roles, { writer: "claude", reviewer: "codex" });
});

// The menu reads raw key codes; a stand-in terminal stream sends them.
function fakeTerminal() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (on) => { input.isRaw = on; };
  const output = new PassThrough();
  let shown = "";
  output.on("data", (chunk) => { shown += chunk; });
  return { input, output, shown: () => shown };
}

test("the menu starts on the saved choice, moves with the arrow keys and takes Enter; Ctrl+C cancels", async () => {
  const terminal = fakeTerminal();
  const ui = terminalUi(terminal);
  const choices = [{ value: "claude", label: "claude — 已登入" }, { value: "codex", label: "codex — CLI 未安裝" }];
  const picked = ui.choose("選擇 writer", choices, "codex");
  terminal.input.write("\x1b[B");
  terminal.input.write("\x1b[B");
  terminal.input.write("\r");
  assert.equal(await picked, "codex");
  assert.equal(terminal.input.isRaw, false);
  assert.match(terminal.shown(), /選擇 writer（↑↓ 選擇，Enter 確定）\n {2}claude — 已登入\n> codex — CLI 未安裝/);
  const up = ui.choose("選擇 reviewer", choices, "codex");
  terminal.input.write("\x1b[A");
  terminal.input.write("\r");
  assert.equal(await up, "claude");
  const cancelled = ui.choose("選擇 reviewer", choices, null);
  terminal.input.write("\x03");
  await assert.rejects(cancelled, /Installation cancelled by user/);
  assert.equal(terminal.input.isRaw, false);
});

test("the plan text says when nothing needs downloading", () => {
  const text = formatGuidePlan({
    install_location: packageRoot, roles: { writer: "claude", reviewer: "codex" }, readiness: { writer: "已登入", reviewer: "需要登入" },
    dependencies: { install: false, folder: "", packages: [], postgres_package: "" }, data_home: "D", settings_file: "S",
    command: { linked: true },
  });
  assert.match(text, /依賴：已安裝，不用下載/);
  assert.match(text, /reviewer：codex（需要登入）/);
});
