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

import { addToUserPath, commandLink, pathPlan, userPathState } from "../installer/command-link.mjs";
import { runNpm } from "../installer/dependencies.mjs";
import { formatGuidePlan, formatGuideResult, installGuide, NO_AUTOMATIC_ROLLBACK, ROOT_REFUSAL, terminalUi } from "../installer/install-guide.mjs";
import { installedVersion, readDefaultRoles, saveInstall, settingsFile } from "../installer/personal-settings.mjs";
import { postgresPackageName } from "../review-bridge/service/database/platformPackages.mjs";
import { nodeTooOld } from "../review-bridge/utils/nodeVersion.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(fsSync.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
const signedIn = { cli_present: true, authenticated: true };
const noCli = { cli_present: false, authenticated: "unknown" };
const pathFound = { platform: process.platform, folder: "C:/npm", in_user_path: true, add_to_user_path: false, this_terminal: true, shell_line: null };

async function tempDir(t, prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

// A Guide run whose installers are stand-ins: they record what they were asked to do. The menu
// answers come from `answers`, in the order the Guide asks. The upgrade marker goes into a temporary
// folder, never into this repository.
async function guide(t, options, {
  answers = [], confirm = true, problems = ["pg is not installed"], link = { linked: false, points_to: null }, linkWorks = true,
  saved = null, previous = null, path: pathState = pathFound, asRoot = false, database = false, ensureFails = false,
} = {}) {
  const dataHome = await tempDir(t, "review-bridge-guide-home-");
  const markerPath = path.join(dataHome, "marker", "upgrade-in-progress.json");
  await fsp.mkdir(path.dirname(markerPath), { recursive: true });
  if (saved) await saveInstall({ roles: saved, location: path.join(os.tmpdir(), "another-bridge"), version: "9.9.9" }, { dataHome });
  if (previous) await saveInstall({ roles: saved || { writer: "claude", reviewer: "codex" }, location: packageRoot, version: previous }, { dataHome });
  const calls = { asked: [], prompts: [], installs: 0, links: 0, pathAdds: [], markerDuringInstall: null, written: "" };
  let linked = link;
  const ui = {
    async choose(title, choices, initial) {
      calls.asked.push({ title, choices: choices.map((choice) => choice.label), initial });
      return answers.shift();
    },
    async confirm(question) { calls.prompts.push(question); return confirm; },
  };
  const run = installGuide(packageRoot, options, {
    ui,
    write: (text) => { calls.written += text; },
    inspectProvider: async (provider) => (provider === "claude" ? signedIn : noCli),
    dataHome,
    markerPath,
    problemsOf: async () => problems,
    ensure: async () => {
      calls.installs += 1;
      calls.markerDuringInstall = fsSync.existsSync(markerPath);
      if (ensureFails) throw new Error("npm ci failed");
      return { installed: problems.length > 0 };
    },
    linkState: () => ({ command_folder: path.join(dataHome, "npm"), ...linked }),
    link: () => { calls.links += 1; if (linkWorks) linked = { linked: true, points_to: packageRoot }; },
    pathOf: (folder) => ({ ...pathState, folder }),
    addPath: (folder) => calls.pathAdds.push(folder),
    asRoot: () => asRoot,
    hasDatabase: () => database,
  });
  return { run, calls, dataHome, markerPath };
}

test("the Guide asks writer then reviewer, shows the plan, and installs only after yes", async (t) => {
  const { run, calls, dataHome } = await guide(t, {}, { answers: ["codex", "claude"] });
  const result = await run;
  assert.deepEqual(calls.asked.map((ask) => ask.title), ["選擇 writer", "選擇 reviewer"]);
  assert.deepEqual(calls.asked[0].choices, ["claude — 已登入", "codex — CLI 未安裝"]);
  assert.deepEqual(calls.prompts, ["開始安裝？[y/N] "]);
  assert.deepEqual([calls.installs, calls.links], [1, 1]);
  assert.equal(calls.markerDuringInstall, false, "a first install writes no upgrade marker");
  assert.deepEqual(result.roles, { writer: "codex", reviewer: "claude" });
  assert.deepEqual(await readDefaultRoles({ dataHome }), { writer: "codex", reviewer: "claude" });
  assert.equal(await installedVersion(packageRoot, { dataHome }), version, "the version installed here is recorded");
  assert.equal(result.next_step, "review-bridge init --target <專案資料夾>");
  // The plan names the install place, every locked package and where personal data goes.
  assert.ok(calls.written.includes("Review Bridge 會這樣安裝："));
  assert.ok(calls.written.includes("安裝位置：" + packageRoot));
  for (const name of ["pg 8.23.1", "embedded-postgres 18.4.0-beta.17", postgresPackageName()]) assert.ok(calls.written.includes(name), name);
  assert.ok(calls.written.includes("（PostgreSQL 執行檔）"));
  assert.ok(calls.written.includes("預設角色存在：" + settingsFile(dataHome)));
  assert.ok(calls.written.includes("註冊 review-bridge"));
  assert.ok(!calls.written.includes(NO_AUTOMATIC_ROLLBACK), "a first install is not an upgrade");
});

test("answering no installs nothing, registers nothing and saves nothing", async (t) => {
  const { run, calls, dataHome } = await guide(t, {}, { answers: ["claude", "codex"], confirm: false });
  await assert.rejects(run, /Installation cancelled by user/);
  assert.deepEqual([calls.installs, calls.links, calls.pathAdds.length], [0, 0, 0]);
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
  assert.ok(unconfirmed.calls.written.includes("Review Bridge 會這樣安裝："), "the refusal comes after the plan is shown");
  const fromDefaults = await guide(t, { yes: true }, { saved: { writer: "codex", reviewer: "claude" } });
  assert.deepEqual((await fromDefaults.run).roles, { writer: "codex", reviewer: "claude" });
  assert.deepEqual([fromDefaults.calls.asked.length, fromDefaults.calls.prompts.length], [0, 0]);
});

test("project options are refused by name: the Guide never sets up a project", async (t) => {
  for (const key of ["profile", "port", "fake-cli"]) {
    const { run, calls } = await guide(t, { [key]: "x", yes: true, writer: "claude", reviewer: "codex" });
    await assert.rejects(run, new RegExp("--" + key + " belongs to setting up a project"));
    assert.equal(calls.installs, 0);
  }
});

test("as root on macOS or Linux the Guide stops at the plan: PostgreSQL cannot run as root", async (t) => {
  const { run, calls } = await guide(t, { yes: true, writer: "claude", reviewer: "codex" }, { asRoot: true });
  await assert.rejects(run, new RegExp(ROOT_REFUSAL));
  assert.ok(calls.written.includes("Review Bridge 會這樣安裝："), "the plan was shown");
  assert.deepEqual([calls.installs, calls.links], [0, 0]);
});

test("an installed and registered Bridge is left alone; a command pointing at another copy is moved here", async (t) => {
  const done = await guide(t, { yes: true, writer: "claude", reviewer: "codex" }, { problems: [], link: { linked: true, points_to: packageRoot }, previous: version });
  const result = await done.run;
  assert.equal(result.dependencies_installed, false);
  assert.equal(result.upgraded, false);
  assert.equal(done.calls.links, 0);
  assert.match(done.calls.written, /依賴：已安裝，不用下載/);
  assert.match(done.calls.written, /指令：review-bridge 已註冊/);
  const elsewhere = path.join(os.tmpdir(), "another-bridge");
  const moved = await guide(t, { yes: true, writer: "claude", reviewer: "codex" }, { link: { linked: false, points_to: elsewhere } });
  await moved.run;
  assert.equal(moved.calls.links, 1);
  assert.ok(moved.calls.written.includes("目前指向另一份 Bridge（" + elsewhere + "），會改指向這份"));
});

test("a new version is an upgrade: the plan says from what to what, that no rollback is automatic, and commands are blocked while it runs", async (t) => {
  const { run, calls, dataHome, markerPath } = await guide(t, {}, { answers: ["claude", "codex"], previous: "0.0.1-old" });
  const result = await run;
  assert.ok(calls.written.includes("Review Bridge 會這樣升級："));
  assert.ok(calls.written.includes("升級：從 0.0.1-old 升到 " + version + "：先備份資料庫、更新依賴"));
  assert.ok(calls.written.includes("資料庫：還沒建立，不用備份"));
  assert.ok(calls.written.includes(NO_AUTOMATIC_ROLLBACK));
  assert.deepEqual(calls.prompts, ["開始升級？[y/N] "]);
  assert.equal(calls.markerDuringInstall, true, "the marker is there while dependencies are installed");
  assert.equal(fsSync.existsSync(markerPath), false, "and gone when the upgrade finished");
  assert.equal(result.upgraded, true);
  assert.equal(await installedVersion(packageRoot, { dataHome }), version);
  assert.match(formatGuideResult(result), new RegExp("Review Bridge 已升級到 " + version.replace(/[.]/g, "\\.")));
});

test("a failed upgrade keeps the marker and the old version on record; running the Guide again finishes it", async (t) => {
  const failing = await guide(t, { yes: true, writer: "claude", reviewer: "codex" }, { previous: "0.0.1-old", ensureFails: true });
  await assert.rejects(failing.run, /npm ci failed/);
  assert.equal(fsSync.existsSync(failing.markerPath), true, "every command stays blocked");
  assert.equal(await installedVersion(packageRoot, { dataHome: failing.dataHome }), "0.0.1-old");
});

test("an unfinished upgrade is named and redone", async (t) => {
  const { run, calls, markerPath } = await guide(t, { yes: true, writer: "claude", reviewer: "codex" }, { previous: version });
  await fsp.writeFile(markerPath, "{}");
  await run;
  assert.ok(calls.written.includes("上一次升級沒有完成，這次重做"));
  assert.equal(fsSync.existsSync(markerPath), false);
});

test("an existing database is not upgraded while there is no backup for it", async (t) => {
  const { run, calls } = await guide(t, { yes: true, writer: "claude", reviewer: "codex" }, { previous: "0.0.1-old", database: true });
  await assert.rejects(run, /已經有 Bridge 的資料庫，但這一版還不能在升級前備份它/);
  assert.ok(calls.written.includes("資料庫：已建立"));
  assert.equal(calls.installs, 0);
});

test("Windows: a folder missing from the user PATH is listed and added only after yes; macOS and Linux get the line to add", async (t) => {
  const windows = await guide(t, {}, { answers: ["claude", "codex"], path: { ...pathFound, platform: "win32", in_user_path: false, add_to_user_path: true, this_terminal: false } });
  const result = await windows.run;
  assert.ok(/PATH：把 .+ 加進你的使用者 PATH（只在尾端追加一項）/.test(windows.calls.written));
  assert.deepEqual(windows.calls.pathAdds, [result.path.folder]);
  assert.match(formatGuideResult(result), /已把 .+ 加進你的使用者 PATH。/);
  assert.match(formatGuideResult(result), /請開新的終端機，再打下一步的指令。/);
  const declined = await guide(t, {}, { answers: ["claude", "codex"], confirm: false, path: { ...pathFound, platform: "win32", in_user_path: false, add_to_user_path: true } });
  await assert.rejects(declined.run, /cancelled/);
  assert.deepEqual(declined.calls.pathAdds, []);
  const posix = await guide(t, { yes: true, writer: "claude", reviewer: "codex" }, { path: { ...pathFound, platform: "linux", in_user_path: null, this_terminal: false, shell_line: "export PATH=\"/npm/bin:$PATH\"" } });
  const posixResult = await posix.run;
  assert.ok(posix.calls.written.includes("export PATH=\"/npm/bin:$PATH\""));
  assert.deepEqual(posix.calls.pathAdds, [], "no shell file is edited");
  assert.match(formatGuideResult(posixResult), /請把這一行加進 shell 設定檔/);
});

test("pathPlan reads the persistent user PATH on Windows and this terminal's PATH elsewhere", () => {
  const folder = path.resolve("npm-global");
  const win = (has, terminal) => pathPlan(folder, { platform: "win32", readUserPath: () => ({ has_folder: has }), env: { Path: terminal ? folder + ";C:/x" : "C:/x" } });
  assert.deepEqual([win(true, true).add_to_user_path, win(true, true).this_terminal], [false, true]);
  assert.deepEqual([win(true, false).add_to_user_path, win(true, false).this_terminal], [false, false]);
  assert.equal(win(false, false).add_to_user_path, true);
  const posix = pathPlan("/home/a/.npm/bin", { platform: "linux", env: { PATH: "/usr/bin:/bin" } });
  assert.deepEqual([posix.add_to_user_path, posix.shell_line], [false, "export PATH=\"/home/a/.npm/bin:$PATH\""]);
  assert.equal(pathPlan("/usr/bin", { platform: "linux", env: { PATH: "/usr/bin:/bin" } }).shell_line, null);
});

test("Windows user PATH: entries are read unexpanded, compared expanded, and one entry is appended with the value's own type", { skip: process.platform !== "win32" }, (t) => {
  const key = "Software\\ReviewBridgeTest-" + process.pid;
  const powershell = (script) => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
  t.after(() => powershell("[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('" + key + "', $false)"));
  assert.equal(userPathState("C:\\nope", { key }).has_folder, false, "a missing key is an empty PATH");
  powershell("$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('" + key + "'); $k.SetValue('Path','%USERPROFILE%\\bin;C:\\tools',[Microsoft.Win32.RegistryValueKind]::ExpandString); $k.Close()");
  assert.equal(userPathState(path.join(process.env.USERPROFILE, "bin"), { key }).has_folder, true);
  assert.equal(userPathState("C:\\nope", { key }).has_folder, false);
  addToUserPath("C:\\nope", { key });
  const stored = userPathState("C:\\nope", { key });
  assert.equal(stored.has_folder, true);
  assert.equal(stored.value, "%USERPROFILE%\\bin;C:\\tools;C:\\nope", "the other entries are exactly as they were");
  assert.equal(stored.kind, "ExpandString");
});

test("saved settings round-trip, and a damaged settings file is refused instead of read as empty", async (t) => {
  const dataHome = await tempDir(t, "review-bridge-settings-");
  assert.equal(await readDefaultRoles({ dataHome }), null);
  assert.equal(await installedVersion("D:/bridge", { dataHome }), null);
  await saveInstall({ roles: { writer: "claude", reviewer: "codex" }, location: "D:/bridge", version: "1.0.0" }, { dataHome });
  await saveInstall({ roles: { writer: "codex", reviewer: "claude" }, location: "E:/other", version: "2.0.0" }, { dataHome });
  assert.deepEqual(await readDefaultRoles({ dataHome }), { writer: "codex", reviewer: "claude" });
  assert.equal(await installedVersion("D:/bridge", { dataHome }), "1.0.0", "each Bridge folder keeps its own version");
  assert.equal(await installedVersion("E:/other", { dataHome }), "2.0.0");
  assert.deepEqual(await fsp.readdir(dataHome), ["settings.json"]);
  for (const text of ["{", JSON.stringify({ schema_version: 2, default_roles: { writer: "claude", reviewer: "codex" } }),
    JSON.stringify({ schema_version: 1, default_roles: { writer: "gpt", reviewer: "codex" } }),
    JSON.stringify({ schema_version: 1, default_roles: { writer: "claude", reviewer: "codex" }, installed_versions: { "D:/bridge": 1 } })]) {
    await fsp.writeFile(settingsFile(dataHome), text);
    await assert.rejects(readDefaultRoles({ dataHome }), /settings are not readable/);
  }
  await assert.rejects(saveInstall({ roles: { writer: "claude", reviewer: "nobody" }, location: "D:/bridge", version: "1" }, { dataHome }), /settings are not readable|reviewer must be one of/);
});

test("the command state reads npm's global folder: linked here, elsewhere, or not at all", async (t) => {
  const prefix = await tempDir(t, "review-bridge-prefix-");
  const globalModules = process.platform === "win32" ? path.join(prefix, "node_modules") : path.join(prefix, "lib", "node_modules");
  const npm = (root, args) => ({ stdout: (args[0] === "root" ? globalModules : prefix) + "\n" });
  const commandFolder = process.platform === "win32" ? prefix : path.join(prefix, "bin");
  assert.deepEqual(commandLink(packageRoot, { npm }), { linked: false, points_to: null, command_folder: commandFolder });
  await fsp.mkdir(globalModules, { recursive: true });
  const name = JSON.parse(await fsp.readFile(path.join(packageRoot, "package.json"), "utf8")).name;
  await fsp.symlink(packageRoot, path.join(globalModules, name), "junction");
  t.after(() => fsp.unlink(path.join(globalModules, name)).catch(() => {}));
  assert.equal(commandLink(packageRoot, { npm }).linked, true);
  const other = await tempDir(t, "review-bridge-other-copy-");
  await fsp.writeFile(path.join(other, "package.json"), JSON.stringify({ name }));
  assert.equal(commandLink(other, { npm }).linked, false);
});

test("a Node older than 22 is named before anything else runs", () => {
  assert.equal(nodeTooOld("20.11.1"), true);
  assert.equal(nodeTooOld("22.0.0"), false);
  assert.equal(nodeTooOld("24.16.0"), false);
});

test("while Bridge itself is being upgraded every project command refuses and says how to finish", async (t) => {
  const folder = await tempDir(t, "review-bridge-upgrading-");
  await fsp.cp(path.join(packageRoot, "review-bridge"), path.join(folder, "review-bridge"), { recursive: true, filter: (source) => !source.includes(path.sep + "tests") });
  await fsp.writeFile(path.join(folder, "upgrade-in-progress.json"), "{}");
  const result = spawnSync(process.execPath, [path.join(folder, "review-bridge", "bootstrap.mjs"), "work-status"], { cwd: folder, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Bridge 正在升級，或上一次升級沒有完成：回 Bridge 資料夾再跑一次 npm start。/);
});

// From a clean copy with no node_modules, as a person gets it from clone: the one command installs
// the dependencies and registers review-bridge (into a temporary npm global folder and a temporary
// registry key, never the real ones), writes nothing into the copy but node_modules, and the printed
// next command runs. Setting up the project puts no runtime in it, and the project's commands find
// it from the current folder or from --project.
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

test("clean clone: npm start's command installs Bridge in place, the next command it prints works, and the project holds no runtime", { timeout: 300_000 }, async (t) => {
  const work = await tempDir(t, "review-bridge-clean-install-");
  const copy = path.join(work, "bridge");
  const prefix = path.join(work, "npm-global");
  const dataHome = path.join(work, "data-home");
  const project = path.join(work, "project");
  const home = path.join(work, "home");
  const registryKey = "Software\\ReviewBridgeTest-clean-" + process.pid;
  await Promise.all([prefix, project, home].map((dir) => fsp.mkdir(dir, { recursive: true })));
  await fsp.cp(packageRoot, copy, { recursive: true, filter: (source) => !/[\\/](\.git|node_modules|\.review-bridge|\.claude|\.tmp)([\\/]|$)/.test(source) });
  await fsp.writeFile(path.join(project, "package.json"), JSON.stringify({ name: "clean-app", private: true }) + "\n");
  const before = await listFiles(copy);
  // npm still needs the machine's proxy and certificate settings to reach the registry.
  const network = Object.fromEntries(["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"]
    .filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
  const env = {
    ...network,
    // npm runs install scripts through sh on POSIX; without it an optional package is silently skipped.
    PATH: [path.dirname(process.execPath), process.platform === "win32" ? prefix : path.join(prefix, "bin"),
      ...(process.platform === "win32" ? [process.env.SystemRoot && path.join(process.env.SystemRoot, "System32"), process.env.SystemRoot && path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0")] : ["/usr/bin", "/bin"])].filter(Boolean).join(path.delimiter),
    HOME: home, USERPROFILE: home, TEMP: os.tmpdir(), TMP: os.tmpdir(),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    REVIEW_BRIDGE_DATA_HOME: dataHome,
    REVIEW_BRIDGE_USER_PATH_KEY: registryKey,
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
  assert.equal(result.upgraded, false);
  if (process.platform === "win32") {
    assert.equal(result.path.added_to_user_path, true, "the npm folder was added to the (temporary) user PATH");
    assert.equal(userPathState(prefix, { key: registryKey }).has_folder, true);
  }
  // Only node_modules was added to the copy: no .review-bridge, no second runtime, no marker.
  assert.deepEqual(await listFiles(copy), before);
  assert.ok(fsSync.existsSync(path.join(copy, "node_modules", "pg", "package.json")));
  assert.deepEqual(await readDefaultRoles({ dataHome }), { writer: "claude", reviewer: "codex" });
  assert.equal(fsSync.realpathSync(path.join(process.platform === "win32" ? path.join(prefix, "node_modules") : path.join(prefix, "lib", "node_modules"), "codex-review-bridge-installer")), fsSync.realpathSync(copy));

  // Running it again installs nothing and adds nothing to PATH.
  const again = install("--yes", "--json");
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).dependencies_installed, false);
  assert.equal(JSON.parse(again.stdout).path.added_to_user_path, false);

  // The registered review-bridge: the printed next command, then the project's own commands.
  const shim = process.platform === "win32" ? path.join(prefix, "review-bridge.cmd") : path.join(prefix, "bin", "review-bridge");
  const command = (cwd, ...args) => (process.platform === "win32"
    ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "\"\"" + shim + "\" " + args.map((arg) => "\"" + arg + "\"").join(" ") + "\""], { cwd, encoding: "utf8", env, windowsHide: true, windowsVerbatimArguments: true, maxBuffer: 16 * 1024 * 1024 })
    : spawnSync(shim, args, { cwd, encoding: "utf8", env, maxBuffer: 16 * 1024 * 1024 }));
  let next;
  let stopped;
  try {
    next = command(project, "init", "--target", project, "--yes", "--json", "--fake-cli", "--port", String(await freePort()));
    assert.equal(next.status, 0, next.stderr);
    assert.deepEqual(JSON.parse(next.stdout).roles, { writer: "claude", reviewer: "codex" }, "the saved roles, not asked again");
    assert.equal(fsSync.existsSync(path.join(project, ".review-bridge", "tools")), false, "the project holds no runtime");
    assert.ok(fsSync.existsSync(path.join(project, ".review-bridge", "review-bridge", "bridge.json")));
    // The same project from its own folder and from elsewhere with --project.
    const here = command(project, "work-status");
    const elsewhere = command(work, "work-status", "--project", project);
    assert.equal(here.status, 0, here.stderr);
    assert.equal(elsewhere.status, 0, elsewhere.stderr);
    assert.equal(elsewhere.stdout, here.stdout);
    // Without --target, uninstall is about the command only, and needs a terminal to confirm at.
    const removing = command(work, "uninstall");
    assert.equal(removing.status, 2);
    assert.match(removing.stderr, /No terminal to confirm at/);
  } finally {
    // init started the project's page service; it must stop before the folder is removed. The
    // temporary registry key goes here too, so a folder that cannot be removed never keeps it.
    stopped = spawnSync(process.execPath, [path.join(copy, "review-bridge", "bootstrap.mjs"), "down", "--project", project], { cwd: work, encoding: "utf8", env, windowsHide: true });
    if (process.platform === "win32") {
      spawnSync("powershell.exe", ["-NoProfile", "-Command", "[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('" + registryKey + "', $false)"], { windowsHide: true });
    }
  }
  assert.equal(stopped.status, 0, "the page service did not stop: " + stopped.stdout + stopped.stderr);
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
    upgrade: null, unfinished_upgrade: false,
    dependencies: { install: false, folder: "", packages: [], postgres_package: "" }, data_home: "D", settings_file: "S",
    command: { linked: true }, path: pathFound,
  });
  assert.match(text, /依賴：已安裝，不用下載/);
  assert.match(text, /reviewer：codex（需要登入）/);
});
