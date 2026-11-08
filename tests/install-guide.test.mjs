// Keeps the person's database out of these tests (see the fixture).
import "../review-bridge/tests/fixtures/isolatedDataHome.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CANCELLED, doneMessage, ROOT_REFUSAL, runGuide } from "../installer/install-guide.mjs";
import { readDefaultRoles, saveDefaultRoles, settingsFile } from "../installer/personal-settings.mjs";
import { readDatabasePort } from "../review-bridge/service/database/personalSettings.mjs";
import { listProfiles } from "../installer/project-profile.mjs";
import { COMMANDS, PROJECT_OPTION } from "../review-bridge/router/index.mjs";
import { nodeTooOld } from "../review-bridge/utils/nodeVersion.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridge = path.join(packageRoot, "bridge.mjs");
const version = JSON.parse(fsSync.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
const signedIn = { cli_present: true, authenticated: true };
const signInRequired = { cli_present: true, authenticated: false };

async function tempDir(t, prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

// A stand-in for @clack/prompts that records every call. A select or confirm is answered from
// `answers` in order; `undefined` (or running out) is Enter on the preselected option, and CANCEL is
// Ctrl+C. A prompt the Guide must never show (text) fails the test.
const CANCEL = Symbol("cancel");
const VSCODE_QUESTION = { confirm: "Add VS Code tasks to this project's .vscode/tasks.json?", initialValue: false };
function recordingUi(answers = []) {
  const calls = [];
  return {
    calls,
    intro: (title) => calls.push({ intro: title }),
    outro: (message) => calls.push({ outro: message }),
    cancel: (message) => calls.push({ cancel: message }),
    isCancel: (value) => value === CANCEL,
    async select({ message, options, initialValue }) {
      calls.push({ select: message, options: options.map((option) => option.label + (option.hint ? " (" + option.hint + ")" : "")), initialValue });
      const answer = answers.shift();
      return answer === undefined ? initialValue : answer;
    },
    async confirm({ message, initialValue }) {
      calls.push({ confirm: message, initialValue });
      const answer = answers.shift();
      return answer === undefined ? initialValue : answer;
    },
    async text() { throw new Error("the Guide asked for typed text"); },
    spinner() {
      return {
        start: (label) => calls.push({ start: label }),
        stop: (label) => calls.push({ done: label }),
        error: (label) => calls.push({ failed: label }),
      };
    },
  };
}

// How the stand-in setup reaches the database: what openDatabase's connection holds (no password).
const DATABASE = Object.freeze({ host: "127.0.0.1", port: 5433, database: "bridge", user: "bridge", passwordFile: path.join(os.tmpdir(), "home", "postgres", "secret") });
const DATABASE_LINES = "\n\n  database in VS Code: install Microsoft's PostgreSQL extension and add a connection with\n    Server 127.0.0.1  Port 5433  User bridge  Database bridge\n    Password: copy it from " + DATABASE.passwordFile;

// The project setup is a stand-in that runs four named steps; `fail` names one that throws.
function stubSetup({ fail = null } = {}) {
  const seen = [];
  const setUpProject = async (settings, step) => {
    seen.push(settings);
    for (const label of ["Setting up .review-bridge/", "Checking the setup", "Running the four fake self-tests", "Starting the local page"]) {
      await step(label, async () => {
        if (label === fail) throw new Error(label + " broke");
      });
    }
    return { ok: true, target: settings.target, roles: settings.roles, profile: settings.profileId === "none" ? null : settings.profileId, url: "http://localhost:8080/", database: DATABASE };
  };
  return { seen, setUpProject };
}

async function guide(t, options, { answers, interactive = true, files = {}, saved = null, asRoot = false, fail = null, setUp = true } = {}) {
  const project = await tempDir(t, "review-bridge-guide-project-");
  for (const [name, text] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(project, name)), { recursive: true });
    await fsp.writeFile(path.join(project, name), text);
  }
  const dataHome = await tempDir(t, "review-bridge-guide-home-");
  if (saved) await saveDefaultRoles(saved, { dataHome });
  const ui = recordingUi(answers);
  const setup = stubSetup({ fail });
  let written = "";
  const run = runGuide(options, {
    packageRoot, cwd: project, interactive, ui, dataHome, asRoot: () => asRoot,
    write: (text) => { written += text; },
    inspectProvider: async (provider) => (provider === "claude" ? signedIn : signInRequired),
    setUpProject: setUp ? setup.setUpProject : async () => { throw new Error("setup must not run"); },
  });
  return { project, dataHome, ui, setup, run, written: () => written };
}

test("the Guide asks writer, reviewer and project type, then works one step per line and ends with Done", async (t) => {
  const run = await guide(t, {}, { files: { "package.json": JSON.stringify({ name: "app" }) } });
  const result = await run.run;
  const profiles = (await listProfiles()).map((profile) => profile.profile_id);
  assert.deepEqual(run.ui.calls, [
    { intro: "review-bridge v" + version },
    { select: "Select writer:", options: ["claude (signed in)", "codex (sign-in required)"], initialValue: "claude" },
    { select: "Select reviewer:", options: ["claude (signed in)", "codex (sign-in required)"], initialValue: "codex" },
    {
      select: "Select project type:",
      options: [...profiles.map((id) => id + (id === "node-backend" ? " (detected)" : "")), "none (no project type)"],
      initialValue: "node-backend",
    },
    VSCODE_QUESTION,
    { start: "Setting up .review-bridge/" }, { done: "Setting up .review-bridge/" },
    { start: "Checking the setup" }, { done: "Checking the setup" },
    { start: "Running the four fake self-tests" }, { done: "Running the four fake self-tests" },
    { start: "Starting the local page" }, { done: "Starting the local page" },
    { outro: "Done. Now:\n\n  put a work order .md in .review-bridge/work-packages/, then in Claude Code type:\n    /review-bridge start .review-bridge/work-packages/<file>.md\n    (in Codex: $review-bridge start .review-bridge/work-packages/<file>.md)\n  at a terminal, for advanced use and CI:\n    review-bridge start .review-bridge/work-packages/<file>.md\n  page: http://localhost:8080/" + DATABASE_LINES },
  ]);
  assert.deepEqual(run.setup.seen.map(({ target, roles, profileId }) => ({ target, roles, profileId })),
    [{ target: run.project, roles: { writer: "claude", reviewer: "codex" }, profileId: "node-backend" }]);
  assert.equal(result.ok, true);
  assert.equal(result.printed, true);
  assert.equal(run.written(), "");
});

// RC3-VSCODE-01: the last question, before any work; nothing outside .review-bridge/ without a yes.
test("answering no, or Enter, to the VS Code question leaves no .vscode/", async (t) => {
  for (const answers of [[], [undefined, undefined, undefined, false]]) {
    const run = await guide(t, {}, { answers });
    await run.run;
    assert.equal(fsSync.existsSync(path.join(run.project, ".vscode")), false);
    assert.doesNotMatch(run.ui.calls.at(-1).outro, /VS Code \(/);
    const question = run.ui.calls.findIndex((call) => call.confirm);
    const firstStep = run.ui.calls.findIndex((call) => call.start);
    assert.ok(question >= 0 && question < firstStep, "asked before any work");
  }
});

test("answering yes writes the tasks after the setup, and the Done message says how to call them; Git sees the file", async (t) => {
  const run = await guide(t, {}, { answers: [undefined, undefined, undefined, true] });
  const result = await run.run;
  assert.equal(result.ok, true);
  const tasks = JSON.parse(await fsp.readFile(path.join(run.project, ".vscode", "tasks.json"), "utf8"));
  assert.deepEqual(tasks.tasks.map((task) => task.label), ["start", "stop", "resume", "clean", "status", "logs"].map((action) => "review-bridge: " + action));
  assert.ok(tasks.inputs.length > 0);
  const steps = run.ui.calls.filter((call) => call.start).map((call) => call.start);
  assert.equal(steps.at(-1), "Adding VS Code tasks");
  assert.match(run.ui.calls.at(-1).outro, /in VS Code \(\.vscode\/tasks\.json\): open Quick Open and type: task review-bridge/);
  const git = (...args) => spawnSync("git", args, { cwd: run.project, encoding: "utf8", windowsHide: true });
  assert.equal(git("init", "--quiet").status, 0);
  assert.match(git("status", "--porcelain", "--untracked-files=all").stdout, /\?\? \.vscode\/tasks\.json/);
});

test("Ctrl+C at the VS Code question stops before any work", async (t) => {
  const run = await guide(t, {}, { answers: [undefined, undefined, undefined, CANCEL], setUp: false });
  const result = await run.run;
  assert.equal(result.cancelled, true);
  assert.equal(fsSync.existsSync(path.join(run.project, ".vscode")), false);
});

test("without a terminal, or with --yes, the VS Code question is not asked and nothing is written", async (t) => {
  for (const options of [{}, { yes: true }, { json: true }]) {
    const run = await guide(t, options, { interactive: false });
    await run.run;
    assert.equal(run.ui.calls.some((call) => call.confirm), false);
    assert.equal(fsSync.existsSync(path.join(run.project, ".vscode")), false);
  }
});

test("a tasks file Bridge cannot read does not undo the setup: the file stays and the Done message says what to do", async (t) => {
  const broken = await guide(t, {}, { answers: [undefined, undefined, undefined, true], files: { ".vscode/tasks.json": "{ broken" } });
  const file = path.join(broken.project, ".vscode", "tasks.json");
  const result = await broken.run;
  assert.equal(result.ok, true);
  assert.equal(await fsp.readFile(file, "utf8"), "{ broken");
  assert.deepEqual(broken.ui.calls.find((call) => call.failed), { failed: "Adding VS Code tasks" });
  assert.match(broken.ui.calls.at(-1).outro, /VS Code tasks were not added: .*cannot be read as a tasks file.* Fix it, then run: review-bridge vscode/);
});

test("an empty folder preselects none, and none is set up as a project without a type", async (t) => {
  const run = await guide(t, {});
  await run.run;
  const typeQuestion = run.ui.calls.find((call) => call.select === "Select project type:");
  assert.equal(typeQuestion.initialValue, "none");
  assert.ok(typeQuestion.options.every((label) => !label.includes("(detected)")));
  assert.equal(run.setup.seen[0].profileId, "none");
});

test("what the person picks is what is set up, and becomes the saved default roles", async (t) => {
  const run = await guide(t, {}, { answers: ["codex", "claude", "vue-frontend"] });
  await run.run;
  assert.deepEqual(run.setup.seen[0].roles, { writer: "codex", reviewer: "claude" });
  assert.equal(run.setup.seen[0].profileId, "vue-frontend");
  assert.deepEqual(await readDefaultRoles({ dataHome: run.dataHome }), { writer: "codex", reviewer: "claude" });
});

test("saved default roles are preselected", async (t) => {
  const run = await guide(t, {}, { saved: { writer: "codex", reviewer: "claude" } });
  await run.run;
  assert.deepEqual(run.ui.calls.filter((call) => call.select && call.select !== "Select project type:").map((call) => call.initialValue), ["codex", "claude"]);
});

test("a question the command line answered is not asked", async (t) => {
  const run = await guide(t, { writer: "codex", reviewer: "codex", profile: "none" });
  await run.run;
  assert.deepEqual(run.ui.calls.filter((call) => call.select), []);
  assert.deepEqual(run.setup.seen[0].roles, { writer: "codex", reviewer: "codex" });
  assert.equal(run.setup.seen[0].profileId, "none");
});

for (const at of [0, 1, 2]) {
  test("Ctrl+C at question " + (at + 1) + " ends with " + CANCELLED + " and sets nothing up", async (t) => {
    const answers = [undefined, undefined, undefined];
    answers[at] = CANCEL;
    const run = await guide(t, {}, { answers, setUp: false });
    const result = await run.run;
    assert.deepEqual(run.ui.calls.at(-1), { cancel: CANCELLED });
    assert.equal(result.cancelled, true);
    assert.equal(fsSync.existsSync(settingsFile(run.dataHome)), false);
  });
}

test("without a terminal nothing is asked: the command line, then saved defaults, then claude and codex", async (t) => {
  const bare = await guide(t, {}, { interactive: false, files: { "package.json": "{}" } });
  await bare.run;
  assert.deepEqual(bare.ui.calls, []);
  assert.deepEqual(bare.setup.seen[0].roles, { writer: "claude", reviewer: "codex" });
  assert.equal(bare.setup.seen[0].profileId, "node-backend");
  assert.deepEqual(bare.written().split("\n").slice(0, 4), [
    "Setting up .review-bridge/...", "Checking the setup...", "Running the four fake self-tests...", "Starting the local page...",
  ]);
  assert.match(bare.written(), /^Done\. Now:$/m);

  const saved = await guide(t, { reviewer: "claude" }, { interactive: false, saved: { writer: "codex", reviewer: "codex" } });
  await saved.run;
  assert.deepEqual(saved.setup.seen[0].roles, { writer: "codex", reviewer: "claude" });
  assert.match(saved.written(), /^Using your default roles: writer codex, reviewer claude \(change with --writer\/--reviewer\)$/m);
});

test("--json asks nothing and prints nothing; the caller prints the result", async (t) => {
  const run = await guide(t, { json: true }, { interactive: false });
  const result = await run.run;
  assert.deepEqual(run.ui.calls, []);
  assert.equal(run.written(), "");
  assert.equal(result.printed, false);
});

test("a folder already set up, or root on macOS and Linux, is refused before any question", async (t) => {
  const done = await guide(t, {}, { setUp: false });
  await done.run.catch(() => {});
  await fsp.mkdir(path.join(done.project, ".review-bridge"));
  const again = runGuide({}, {
    packageRoot, cwd: done.project, interactive: true, ui: done.ui, dataHome: done.dataHome, asRoot: () => false,
    inspectProvider: async () => signedIn, setUpProject: async () => { throw new Error("setup must not run"); },
  });
  const before = done.ui.calls.length;
  await assert.rejects(again, /This folder is already set up .* review-bridge upgrade/);
  assert.equal(done.ui.calls.length, before);

  const root = await guide(t, {}, { asRoot: true, setUp: false });
  await assert.rejects(root.run, new RegExp(ROOT_REFUSAL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.deepEqual(root.ui.calls, []);
});

test("a step that fails is marked, its error goes on, and no default roles are saved", async (t) => {
  const run = await guide(t, {}, { fail: "Running the four fake self-tests" });
  await assert.rejects(run.run, /Running the four fake self-tests broke/);
  assert.deepEqual(run.ui.calls.at(-1), { failed: "Running the four fake self-tests" });
  assert.equal(run.ui.calls.some((call) => call.outro), false);
  assert.equal(fsSync.existsSync(settingsFile(run.dataHome)), false);
});

test("an option the Guide does not know is refused", async (t) => {
  const run = await guide(t, { "install-location": "x" }, { setUp: false });
  await assert.rejects(run.run, /Unknown option for init: --install-location/);
});

test("Done names cd when the project is not the current folder, then the agent's start, the terminal's start, the page and the database for VS Code", () => {
  const cwd = path.join(os.tmpdir(), "work");
  assert.equal(doneMessage(path.join(cwd, "my app"), cwd, "http://localhost:8081/", DATABASE),
    "Done. Now:\n\n  cd \"my app\"\n  put a work order .md in .review-bridge/work-packages/, then in Claude Code type:\n    /review-bridge start .review-bridge/work-packages/<file>.md\n    (in Codex: $review-bridge start .review-bridge/work-packages/<file>.md)\n  at a terminal, for advanced use and CI:\n    review-bridge start .review-bridge/work-packages/<file>.md\n  page: http://localhost:8081/" + DATABASE_LINES);
  assert.match(doneMessage(cwd, cwd, null, DATABASE), /\n  page: not running; start it with review-bridge up\n/);
});

test("--version prints the package version and --help describes the npm command", () => {
  const run = (...args) => spawnSync(process.execPath, [bridge, ...args], { cwd: packageRoot, encoding: "utf8", windowsHide: true });
  for (const flag of ["--version", "-v"]) {
    const result = run(flag);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, version + "\n");
  }
  const help = run("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: review-bridge <command> \[options\]/);
  assert.match(help.stdout, /npm i -g review-bridge@latest/);
  assert.match(help.stdout, /npm uninstall -g review-bridge/);
  assert.doesNotMatch(help.stdout, /npm start|SHA256|zip/i);
});

test("uninstall without --target says how npm removes Review Bridge", () => {
  const result = spawnSync(process.execPath, [bridge, "uninstall"], { cwd: packageRoot, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /uninstall needs --target <folder>\. To remove Review Bridge itself, run: npm uninstall -g review-bridge/);
});

// The minimum is 22.8 (utils/nodeVersion.mjs MINIMUM_NODE: util.styleText honours the colour variables from there).
test("Node older than 22.8 is named in one line", () => {
  assert.equal(nodeTooOld("20.11.0"), true);
  assert.equal(nodeTooOld("22.0.0"), true);
  assert.equal(nodeTooOld("22.7.9"), true);
  assert.equal(nodeTooOld("22.8.0"), false);
  assert.equal(nodeTooOld("24.0.0"), false);
});

test("an unreadable settings file is refused, never taken as nothing saved", async (t) => {
  const dataHome = await tempDir(t, "review-bridge-guide-home-");
  await fsp.mkdir(dataHome, { recursive: true });
  await fsp.writeFile(settingsFile(dataHome), "{ not json");
  await assert.rejects(readDefaultRoles({ dataHome }), /Your Review Bridge settings are not readable/);
  await assert.rejects(readDatabasePort({ dataHome }), /Your Review Bridge settings are not readable/);
});

test("the database's start port is read from settings.json, and saving the roles keeps it", async (t) => {
  const dataHome = await tempDir(t, "review-bridge-guide-home-");
  await fsp.mkdir(dataHome, { recursive: true });
  assert.equal(await readDatabasePort({ dataHome }), null, "no file");
  await saveDefaultRoles({ writer: "claude", reviewer: "codex" }, { dataHome });
  assert.equal(await readDatabasePort({ dataHome }), null, "a file without the field");
  const settings = JSON.parse(await fsp.readFile(settingsFile(dataHome), "utf8"));
  await fsp.writeFile(settingsFile(dataHome), JSON.stringify({ ...settings, database: { port: 5440 } }, null, 2) + "\n");
  assert.equal(await readDatabasePort({ dataHome }), 5440);
  await saveDefaultRoles({ writer: "codex", reviewer: "claude" }, { dataHome });
  assert.equal(await readDatabasePort({ dataHome }), 5440);
  assert.deepEqual(await readDefaultRoles({ dataHome }), { writer: "codex", reviewer: "claude" });
  assert.equal(JSON.parse(await fsp.readFile(settingsFile(dataHome), "utf8")).schema_version, 1);
});

// C1 / C3: every command's help comes from the command table, exits 0 and lists every option.
test("every command's --help exits 0 and lists each option with its type, default and help line", () => {
  const run = (...args) => spawnSync(process.execPath, [bridge, ...args], { cwd: packageRoot, encoding: "utf8", windowsHide: true });
  for (const [name, entry] of Object.entries(COMMANDS)) {
    const options = { ...entry.options, ...(entry.installer ? {} : PROJECT_OPTION) };
    const all = run(name, "--help", "--all");
    assert.equal(all.status, 0, name + ": " + all.stderr);
    assert.match(all.stdout, new RegExp("^Usage: review-bridge " + name), name);
    const lines = all.stdout.split("\n");
    for (const [flag, option] of Object.entries(options)) {
      const line = lines.findIndex((text) => text === "  " + flag + (option.value ? " " + option.value : ""));
      assert.ok(line >= 0, name + " " + flag + " is listed");
      const detail = lines[line + 1];
      assert.ok(detail.includes(option.help) && detail.includes(option.type), name + " " + flag + ": " + detail);
      if (option.default) assert.ok(detail.includes("default: " + option.default), name + " " + flag + " default");
    }
    const plain = run(name, "-h");
    assert.equal(plain.status, 0);
    const shown = plain.stdout.split("\n");
    for (const [flag, option] of Object.entries(options)) {
      assert.equal(shown.includes("  " + flag + (option.value ? " " + option.value : "")), !option.internal, name + " " + flag);
    }
  }
});

test("--help lists the commands for people; --help --all adds the ones for agents and scripts", () => {
  const run = (...args) => spawnSync(process.execPath, [bridge, ...args], { cwd: packageRoot, encoding: "utf8", windowsHide: true });
  const listed = (text) => text.split("\n").filter((line) => /^  [a-z]/.test(line)).map((line) => line.trim().split(/\s/)[0]);
  const human = ["init", "start", "stop", "resume", "clean", "status", "logs", "up", "down", "ps", "watch", "upgrade", "uninstall", "doctor", "backup"];
  const agent = ["work-plan", "work-start", "work-status", "work-cancel", "review", "bounded-resume", "wait", "prune", "rm", "roles-check"];
  assert.deepEqual(listed(run("--help").stdout), human);
  assert.deepEqual(listed(run("--help", "--all").stdout).sort(), [...human, ...agent].sort());
  assert.match(run("init", "--help").stdout, /\n\nAfterwards you start work through your agent: in Claude Code type \/review-bridge start <file>; in Codex, \$review-bridge start <file>\. review-bridge start <file> at a terminal is for advanced use and CI\.\n/);
  // status lists the runs from the database and no totals counted from files (Fortes 2026-11-08).
  const statusHelp = run("status", "--help").stdout;
  assert.match(statusHelp, /Show what Bridge is doing now: the page, this project's runs, and how to look at the database/);
  assert.doesNotMatch(statusHelp, /review queue/i);
  // up and down start and stop the database with the page, as docker compose up and down (RC3-DOWN-01);
  // ps shows the page's address and nothing counted.
  assert.match(run("up", "--help").stdout, /Start the database and the local page service in the background/);
  assert.match(run("down", "--help").stdout, /Stop the local page service and the database; refused while a run is running/);
  assert.match(run("ps", "--help").stdout, /Show whether the local page service is running, and its address/);
  assert.match(run("prune", "--help").stdout, /Same as clean without a run id/);
  assert.match(run("rm", "--help").stdout, /Same as clean <run_id>/);
});

test("README's Commands section is what the command table renders", () => {
  const check = spawnSync(process.execPath, [path.join(packageRoot, "scripts", "render-commands.mjs"), "--check"], { cwd: packageRoot, encoding: "utf8", windowsHide: true });
  assert.equal(check.status, 0, check.stderr);
});
