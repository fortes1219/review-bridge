// RC3-VSCODE-01: Bridge's commands in VS Code's task list, and a tasks file that stays the person's.
import { separatePerson } from "../review-bridge/tests/fixtures/isolatedDataHome.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import jsonc from "jsonc-parser";

import {
  addBridgeTasks, BRIDGE_INPUTS, BRIDGE_TASKS, projectTasksFile, releaseVscodeTasks, removeBridgeTasks, userTasksFile, vscodeTasksOutcome, writeVscodeTasks,
} from "../installer/vscode-tasks.mjs";
import { COMMANDS } from "../review-bridge/router/index.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridge = path.join(packageRoot, "bridge.mjs");
const LABELS = ["start", "stop", "resume", "clean", "status", "logs"].map((action) => "review-bridge: " + action);

const read = (text) => {
  const errors = [];
  const value = jsonc.parse(text, errors, { allowTrailingComma: true });
  assert.deepEqual(errors, [], text);
  return value;
};

// The file of someone who keeps notes in it, with a comment in every place a comment can be in the way.
const THEIRS = `// my tasks
{
  "version": "2.0.0",
  /* build things */
  "tasks": [
    // compile first
    { "label": "build", "type": "shell", "command": "make" }, // keep me
    {
      "label": "test",
      "type": "shell",
      "command": "make test" // inner
    } // last one
    // nothing after this
  ],
  "inputs": [
    { "id": "mine", "type": "promptString", "description": "x" } // my input
  ] // end of inputs
}
`;

async function tempDir(t, prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  return dir;
}

function cli(args, { env = process.env, cwd = packageRoot } = {}) {
  return spawnSync(process.execPath, [bridge, ...args], { cwd, env, encoding: "utf8", windowsHide: true, timeout: 30_000 });
}

test("six shell tasks run the existing CLI, with the file and the run ids as arguments and the terminal focused", () => {
  assert.deepEqual(BRIDGE_TASKS.map((task) => task.label), LABELS);
  assert.deepEqual(BRIDGE_TASKS.map((task) => [task.command, ...task.args]), [
    ["review-bridge", "start", "${file}"],
    ["review-bridge", "stop", "${input:review-bridge-run-id}"],
    ["review-bridge", "resume", "${input:review-bridge-run-id}"],
    ["review-bridge", "clean", "${input:review-bridge-clean-run-id}"],
    ["review-bridge", "status"],
    ["review-bridge", "logs", "${input:review-bridge-logs-target}"],
  ]);
  for (const task of BRIDGE_TASKS) {
    assert.equal(task.type, "shell");
    assert.deepEqual(task.problemMatcher, []);
    assert.deepEqual(task.presentation, { focus: true });
    assert.doesNotMatch(JSON.stringify(task), /node|bootstrap\.mjs/);
    assert.ok(COMMANDS[task.args[0]], task.args[0] + " is a command of the CLI");
    assert.equal(COMMANDS[task.args[0]].audience, "human");
  }
  const used = new Set(BRIDGE_TASKS.flatMap((task) => task.args).flatMap((arg) => /\$\{input:(.+)\}/.exec(arg)?.[1] ?? []));
  assert.deepEqual(BRIDGE_INPUTS.map((input) => input.id).sort(), [...used].sort(), "every input is used, and every use has one");
  for (const input of BRIDGE_INPUTS) assert.equal(input.type, "promptString");
  assert.match(BRIDGE_INPUTS.find((input) => input.id.endsWith("clean-run-id")).description, /leave empty/);
});

test("a new file is the version, the tasks and the inputs", () => {
  for (const empty of ["", "  \n"]) {
    const value = read(addBridgeTasks(empty));
    assert.equal(value.version, "2.0.0");
    assert.deepEqual(value.tasks, BRIDGE_TASKS);
    assert.deepEqual(value.inputs, BRIDGE_INPUTS);
  }
});

test("the person's tasks, inputs, comments and layout stay exactly as they were, and taking Bridge's out restores the file", () => {
  const merged = addBridgeTasks(THEIRS);
  const value = read(merged);
  assert.deepEqual(value.tasks.map((task) => task.label), ["build", "test", ...LABELS]);
  assert.deepEqual(value.inputs.map((input) => input.id), ["mine", ...BRIDGE_INPUTS.map((input) => input.id)]);
  // Only commas beside the person's last items were added to their lines.
  for (const line of THEIRS.split("\n")) {
    assert.ok(merged.includes(line + "\n") || merged.includes(line.replace("} //", "}, //") + "\n"), "kept: " + line);
  }
  assert.match(merged, /\}, \/\/ last one\n/, "a comment stays on its own task's line");
  assert.match(merged, /"description": "x" \}, \/\/ my input\n/);
  assert.equal(addBridgeTasks(merged), merged, "running it again changes nothing");
  const removed = removeBridgeTasks(merged);
  assert.equal(removed.text, THEIRS, "byte for byte");
  assert.equal(removed.empty, false);
});

for (const [name, source] of Object.entries({
  "Windows line ends": THEIRS.replaceAll("\n", "\r\n"),
  "tabs": THEIRS.replaceAll("  ", "\t"),
  "a list that ends in a comma": `{\n  "version": "2.0.0",\n  "tasks": [\n    { "label": "a", "type": "shell", "command": "x" },\n  ],\n  "inputs": [],\n}\n`,
  "lists on one line": `{ "version": "2.0.0", "tasks": [{ "label": "a", "type": "shell", "command": "x" }] }\n`,
  "a list of someone else's before Bridge's": `{\n  "version": "2.0.0",\n  "tasks": [\n    { "label": "a", "type": "shell", "command": "x" } // mine\n  ]\n}\n`,
})) {
  test("merging and removing work with " + name, () => {
    const merged = addBridgeTasks(source);
    const value = read(merged);
    assert.deepEqual(value.tasks.map((task) => task.label).filter((label) => label.startsWith("review-bridge:")), LABELS);
    assert.deepEqual(value.tasks.filter((task) => !task.label.startsWith("review-bridge:")), (read(source).tasks));
    assert.equal(addBridgeTasks(merged), merged);
    if (source.includes("\r\n")) assert.doesNotMatch(merged.replaceAll("\r\n", ""), /\n/, "one kind of line end");
    const removed = removeBridgeTasks(merged);
    assert.deepEqual(read(removed.text).tasks ?? [], read(source).tasks);
    for (const comment of source.match(/\/\/.*|\/\*.*?\*\//g) || []) assert.ok(removed.text.includes(comment.trim()), comment);
  });
}

test("a file with an empty or absent list, and an empty object, get them; a version is added only where nothing depends on it", () => {
  assert.deepEqual(read(addBridgeTasks("{}")).version, "2.0.0");
  assert.deepEqual(read(addBridgeTasks("{}")).tasks.map((task) => task.label), LABELS);
  const noLists = addBridgeTasks(`{\n  "version": "2.0.0"\n}\n`);
  assert.deepEqual(read(noLists).tasks.map((task) => task.label), LABELS);
  assert.deepEqual(read(noLists).inputs, BRIDGE_INPUTS);
  const removed = removeBridgeTasks(noLists);
  assert.equal(removed.text, `{\n  "version": "2.0.0"\n}\n`);
  assert.equal(removed.empty, true);
  assert.deepEqual(read(addBridgeTasks(`{ "version": "2.0.0", "tasks": [], "inputs": [] }`)).inputs, BRIDGE_INPUTS);
});

test("an older copy of Bridge's task is replaced in place, a retired one is removed, and a duplicate goes", () => {
  const source = `{
  "version": "2.0.0",
  "tasks": [
    { "label": "review-bridge: start", "type": "shell", "command": "older" }, // beside start
    { "label": "review-bridge: retired", "type": "shell", "command": "gone" },
    { "label": "mine", "type": "shell", "command": "x" }, // mine
    { "label": "review-bridge: start", "type": "shell", "command": "twice" }
  ],
  "inputs": [{ "id": "review-bridge-retired", "type": "promptString", "description": "gone" }]
}
`;
  const merged = addBridgeTasks(source);
  const value = read(merged);
  assert.deepEqual(value.tasks.map((task) => task.label), ["review-bridge: start", "mine", ...LABELS.slice(1)]);
  assert.deepEqual(value.tasks[0], BRIDGE_TASKS[0]);
  assert.deepEqual(value.inputs, BRIDGE_INPUTS);
  assert.match(merged, /\/\/ beside start/);
  assert.match(merged, /\/\/ mine/);
  assert.equal(addBridgeTasks(merged), merged);
});

test("a file Bridge cannot safely change is refused and stays as it is", async (t) => {
  const dir = await tempDir(t, "review-bridge-vscode-refused-");
  for (const [source, reason] of [
    ["{ not json", /cannot be read/],
    ["[]", /cannot be read/],
    ["// only a comment\n", /cannot be read/],
    [`{ "version": "0.1.0", "tasks": [] }`, /uses tasks version 0\.1\.0/],
    [`{ "tasks": [] }`, /does not say its tasks version/],
    [`{ "version": "2.0.0", "tasks": {} }`, /"tasks" that is not a list/],
    [`{ "version": "2.0.0", "inputs": "x" }`, /"inputs" that is not a list/],
  ]) {
    const file = path.join(dir, "tasks.json");
    await fsp.writeFile(file, source);
    await assert.rejects(writeVscodeTasks(file), reason, source);
    assert.equal(await fsp.readFile(file, "utf8"), source);
    if (reason.source === "cannot be read") assert.equal(await vscodeTasksOutcome(file), "kept_unreadable");
  }
});

test("writing says what it did, and releasing leaves the person's file or takes a file that holds nothing else", async (t) => {
  const dir = await tempDir(t, "review-bridge-vscode-files-");
  const file = path.join(dir, "deep", "tasks.json");
  assert.equal(await writeVscodeTasks(file), "added");
  const first = await fsp.readFile(file, "utf8");
  assert.equal(await writeVscodeTasks(file), "unchanged");
  assert.equal(await fsp.readFile(file, "utf8"), first);
  assert.equal(await vscodeTasksOutcome(file, { inUse: true }), "kept_in_use");
  assert.equal(await releaseVscodeTasks(file, { inUse: true }), "kept_in_use");
  assert.equal(await fsp.readFile(file, "utf8"), first);
  assert.equal(await releaseVscodeTasks(file), "removed");
  assert.equal(await fsp.stat(file).catch(() => null), null);
  assert.equal(await releaseVscodeTasks(file), "absent", "running it again changes nothing");

  // A comment is the person's: it keeps the file.
  await fsp.writeFile(file, `// keep this\n{\n  "version": "2.0.0"\n}\n`);
  assert.equal(await writeVscodeTasks(file), "added");
  await fsp.writeFile(file, (await fsp.readFile(file, "utf8")).replace(`"command": "review-bridge",`, `"command": "older",`));
  assert.equal(await writeVscodeTasks(file), "updated");
  assert.equal(await releaseVscodeTasks(file), "removed");
  assert.equal(await fsp.readFile(file, "utf8"), `// keep this\n{\n  "version": "2.0.0"\n}\n`);

  // Nothing of Bridge's in it: nothing to do, not even for a file that holds only a version.
  await fsp.writeFile(file, `{ "version": "2.0.0" }\n`);
  assert.equal(await releaseVscodeTasks(file), "absent");
  assert.equal(await fsp.readFile(file, "utf8"), `{ "version": "2.0.0" }\n`);
});

test("the user tasks file is where VS Code opens it on each platform", () => {
  const home = path.resolve("H");
  assert.equal(userTasksFile({ platform: "win32", env: { APPDATA: path.resolve("A") }, home }), path.join(path.resolve("A"), "Code", "User", "tasks.json"));
  assert.equal(userTasksFile({ platform: "win32", env: {}, home }), path.join(home, "AppData", "Roaming", "Code", "User", "tasks.json"));
  assert.equal(userTasksFile({ platform: "darwin", env: {}, home }), path.join(home, "Library", "Application Support", "Code", "User", "tasks.json"));
  assert.equal(userTasksFile({ platform: "linux", env: {}, home }), path.join(home, ".config", "Code", "User", "tasks.json"));
  assert.equal(userTasksFile({ platform: "linux", env: { XDG_CONFIG_HOME: path.resolve("X") }, home }), path.join(path.resolve("X"), "Code", "User", "tasks.json"));
});

test("review-bridge vscode writes the project's file, which Git shows and Bridge does not exclude; other files stay", async (t) => {
  const root = await tempDir(t, "review-bridge vscode project ");
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(git("init", "--quiet").status, 0);
  const notSetUp = cli(["vscode", "--target", root]);
  assert.equal(notSetUp.status, 2);
  assert.match(notSetUp.stderr, /not set up/);
  assert.equal(await fsp.stat(path.join(root, ".vscode")).catch(() => null), null);

  await fsp.mkdir(path.join(root, ".review-bridge"));
  const written = cli(["vscode", "--target", root, "--json"]);
  assert.equal(written.status, 0, written.stderr);
  assert.deepEqual(JSON.parse(written.stdout), { ok: true, scope: "project", path: projectTasksFile(root), action: "added" });
  assert.match(git("status", "--porcelain", "--untracked-files=all").stdout, /\?\? \.vscode\/tasks\.json/);
  assert.deepEqual(read(await fsp.readFile(projectTasksFile(root), "utf8")).tasks.map((task) => task.label), LABELS);
  const again = cli(["vscode", "--target", root]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already in place/);
  assert.match(again.stdout, /task review-bridge/);
});

test("review-bridge vscode --user writes the user tasks under the home it is given, and needs no project", async (t) => {
  const me = separatePerson(t);
  const elsewhere = await tempDir(t, "review-bridge-vscode-user-");
  const file = userTasksFile();
  assert.ok(file.startsWith(me.home), file);
  const written = cli(["vscode", "--user"], { cwd: elsewhere });
  assert.equal(written.status, 0, written.stderr);
  assert.match(written.stdout, /VS Code tasks added/);
  assert.deepEqual(read(await fsp.readFile(file, "utf8")).tasks.map((task) => task.label), LABELS);
  assert.equal(await fsp.stat(path.join(elsewhere, ".vscode")).catch(() => null), null);
  const both = cli(["vscode", "--user", "--target", elsewhere], { cwd: elsewhere });
  assert.equal(both.status, 2);
  assert.match(both.stderr, /--user/);
});
