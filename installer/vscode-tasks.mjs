// Bridge's commands in VS Code's task list: six shell tasks that run the existing CLI in the integrated
// terminal, in a project's .vscode/tasks.json or in the person's user tasks. VS Code gives a CLI no
// other way into its command list; only an extension could add a command (Owner 2026-11-05).
//
// A tasks file belongs to the person: what is theirs stays as it is, comments and layout included.
// Bridge's own are the tasks labelled "review-bridge:" and the inputs with an id starting
// "review-bridge-". jsonc-parser reads the file and applies the edits, but its modify() cannot add or
// remove a list item here: adding moves a comment after the last item onto the new one, and removing
// takes the comments around the item (src/impl/edit.ts). So those edits are worked out below, from the
// offsets it gives, and touch only Bridge's items and the one comma beside them.
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import jsonc from "jsonc-parser";

import { writeWhole } from "./agent-files.mjs";

const TASK_PREFIX = "review-bridge:";
const INPUT_PREFIX = "review-bridge-";
const VERSION = "2.0.0";

const RUN_ID = { id: INPUT_PREFIX + "run-id", type: "promptString", description: "Run id" };
const CLEAN_RUN_ID = { id: INPUT_PREFIX + "clean-run-id", type: "promptString", description: "Run id to remove; leave empty to fold all finished runs" };
const LOGS_TARGET = { id: INPUT_PREFIX + "logs-target", type: "promptString", description: "Run id or work order file" };
const input = (value) => "${input:" + value.id + "}";

// command and args apart, so that VS Code quotes a path with spaces for the shell in use. focus puts
// the person's y in the terminal rather than the editor; an empty problemMatcher keeps VS Code from
// asking whether to scan the output.
const task = (action, ...args) => ({
  label: TASK_PREFIX + " " + action,
  type: "shell",
  command: "review-bridge",
  args: [action, ...args],
  problemMatcher: [],
  presentation: { focus: true },
});

export const BRIDGE_TASKS = Object.freeze([
  task("start", "${file}"),
  task("stop", input(RUN_ID)),
  task("resume", input(RUN_ID)),
  task("clean", input(CLEAN_RUN_ID)),
  task("status"),
  task("logs", input(LOGS_TARGET)),
]);
export const BRIDGE_INPUTS = Object.freeze([RUN_ID, CLEAN_RUN_ID, LOGS_TARGET]);

const LISTS = [
  { key: "tasks", wanted: BRIDGE_TASKS, name: (item) => item?.label, prefix: TASK_PREFIX },
  { key: "inputs", wanted: BRIDGE_INPUTS, name: (item) => item?.id, prefix: INPUT_PREFIX },
];
const isOwn = (list, item) => typeof list.name(item) === "string" && list.name(item).startsWith(list.prefix);

export const PROJECT_TASKS_RELATIVE = ".vscode/tasks.json";
export const projectTasksFile = (root) => path.join(root, ".vscode", "tasks.json");

// The file `Tasks: Open User Tasks` opens in the default profile; the folder is VS Code's own
// getDefaultUserDataPath (src/vs/platform/environment/node/userDataPath.ts).
export function userTasksFile({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const base = platform === "win32" ? env.APPDATA || path.join(home, "AppData", "Roaming")
    : platform === "darwin" ? path.join(home, "Library", "Application Support")
      : env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(base, "Code", "User", "tasks.json");
}

function parse(text, file) {
  const errors = [];
  const root = jsonc.parseTree(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || root?.type !== "object") throw new Error(file + " cannot be read as a tasks file; it was left as it is.");
  return root;
}

const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");

function indentUnit(text) {
  const first = /\n([ \t]+)\S/.exec(text);
  return first ? (first[1].startsWith("\t") ? "\t" : first[1]) : "  ";
}

function lineStart(text, offset) {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

function lineIndent(text, offset) {
  return /^[ \t]*/.exec(text.slice(lineStart(text, offset), offset))[0];
}

// The next token after `offset`, comments skipped: the offset of a comma, or -1.
function commaAfter(text, offset) {
  const scanner = jsonc.createScanner(text, true);
  scanner.setPosition(offset);
  return scanner.scan() === jsonc.SyntaxKind.CommaToken ? scanner.getTokenOffset() : -1;
}

function hasComment(text, offset = 0, length = text.length) {
  const scanner = jsonc.createScanner(text.slice(offset, offset + length), false);
  for (let token = scanner.scan(); token !== jsonc.SyntaxKind.EOF; token = scanner.scan()) {
    if (token === jsonc.SyntaxKind.LineCommentTrivia || token === jsonc.SyntaxKind.BlockCommentTrivia) return true;
  }
  return false;
}

function rendered(value, indent, text, prefix = "") {
  const lines = (prefix + JSON.stringify(value, null, indentUnit(text))).split("\n");
  return lines.map((line) => indent + line).join(eolOf(text));
}

// Adds items at the end of an array or object: a comma after what is last now, so a comment on its
// line stays with it, and the new items on their own lines before the closing bracket.
function append(text, container, items) {
  const eol = eolOf(text);
  const close = container.offset + container.length - 1;
  const last = container.children?.at(-1);
  const edits = [];
  // A list that ends in a comma keeps ending in one, so taking the items out again restores it.
  const endsInComma = Boolean(last) && commaAfter(text, last.offset + last.length) >= 0;
  if (last && !endsInComma) edits.push({ offset: last.offset + last.length, length: 0, content: "," });
  const outer = lineIndent(text, container.offset);
  const before = lineStart(text, close);
  const closeOnOwnLine = /^[ \t]*$/.test(text.slice(before, close));
  const inner = last && closeOnOwnLine && lineStart(text, last.offset) !== lineStart(text, container.offset)
    ? lineIndent(text, last.offset) : outer + indentUnit(text);
  const body = items.map((item) => rendered(item.value, inner, text, item.prefix)).join("," + eol) + (endsInComma ? "," : "");
  if (closeOnOwnLine) edits.push({ offset: before, length: 0, content: body + eol });
  else {
    const spaceStart = close - /[ \t]*$/.exec(text.slice(container.offset, close))[0].length;
    edits.push({ offset: spaceStart, length: close - spaceStart, content: eol + body + eol + outer });
  }
  return jsonc.applyEdits(text, edits);
}

// Removes one item of an array or object and the one comma that goes with it; a comment beside it
// stays. An item that had its lines to itself takes those lines along.
function removeItem(text, siblings, index) {
  const item = siblings[index];
  let start = item.offset;
  let end = item.offset + item.length;
  const edits = [];
  const next = commaAfter(text, end);
  if (next >= 0 && /^\s*$/.test(text.slice(end, next))) end = next + 1;
  else if (next >= 0) edits.push({ offset: next, length: 1, content: "" });
  else if (index > 0) {
    const previous = siblings[index - 1];
    const comma = commaAfter(text, previous.offset + previous.length);
    if (comma >= 0) edits.push({ offset: comma, length: 1, content: "" });
  }
  const from = lineStart(text, start);
  const trailing = /^[ \t]*(\r?\n)/.exec(text.slice(end));
  if (trailing && /^[ \t]*$/.test(text.slice(from, start))) {
    start = from;
    end += trailing[0].length;
  }
  edits.push({ offset: start, length: end - start, content: "" });
  return jsonc.applyEdits(text, edits);
}

const listNode = (root, key, file) => {
  const node = jsonc.findNodeAtLocation(root, [key]);
  if (node && node.type !== "array") throw new Error(file + " has a \"" + key + "\" that is not a list; it was left as it is.");
  return node;
};

const FORMAT = (text) => ({
  formattingOptions: { insertSpaces: !indentUnit(text).startsWith("\t"), tabSize: indentUnit(text).startsWith("\t") ? 1 : indentUnit(text).length, eol: eolOf(text) },
});

function syncList(source, list, file) {
  let text = source;
  const wantedNames = list.wanted.map(list.name);
  // Bridge's items that are no longer wanted, or there twice, go first, from the end so that the
  // earlier ones keep their place.
  const seen = new Set();
  const stale = [];
  const items = listNode(parse(text, file), list.key, file)?.children || [];
  items.forEach((node, index) => {
    const value = jsonc.getNodeValue(node);
    if (!isOwn(list, value)) return;
    if (!wantedNames.includes(list.name(value)) || seen.has(list.name(value))) stale.push(index);
    seen.add(list.name(value));
  });
  for (const index of stale.reverse()) text = removeItem(text, listNode(parse(text, file), list.key, file).children, index);

  const missing = [];
  for (const value of list.wanted) {
    const nodes = listNode(parse(text, file), list.key, file)?.children || [];
    const index = nodes.findIndex((node) => list.name(jsonc.getNodeValue(node)) === list.name(value));
    if (index < 0) missing.push({ value });
    else if (!isDeepStrictEqual(jsonc.getNodeValue(nodes[index]), value)) {
      text = jsonc.applyEdits(text, jsonc.modify(text, [list.key, index], value, FORMAT(text)));
    }
  }
  if (missing.length === 0) return text;
  const root = parse(text, file);
  const node = listNode(root, list.key, file);
  return node
    ? append(text, node, missing)
    : append(text, root, [{ value: list.wanted, prefix: JSON.stringify(list.key) + ": " }]);
}

// The file's text with Bridge's tasks in it. A file VS Code would not run them from is refused, not
// rewritten: its tasks use another version of the format.
export function addBridgeTasks(source, file = "tasks.json") {
  if (source.trim() === "") {
    return JSON.stringify({ version: VERSION, tasks: BRIDGE_TASKS, inputs: BRIDGE_INPUTS }, null, 2) + "\n";
  }
  let text = source;
  const root = parse(text, file);
  const version = jsonc.findNodeAtLocation(root, ["version"]);
  if (version && jsonc.getNodeValue(version) !== VERSION) throw new Error(file + " uses tasks version " + jsonc.getNodeValue(version) + ", and VS Code runs these only from " + VERSION + "; it was left as it is.");
  if (!version) {
    if (jsonc.findNodeAtLocation(root, ["tasks"])) throw new Error(file + " does not say its tasks version, and VS Code runs these only from " + VERSION + "; it was left as it is.");
    text = append(text, root, [{ value: VERSION, prefix: "\"version\": " }]);
  }
  for (const list of LISTS) text = syncList(text, list, file);
  return text;
}

// The file's text without Bridge's tasks; `empty` when nothing else is left in it, no comment either.
export function removeBridgeTasks(source, file = "tasks.json") {
  let text = source;
  let changed = false;
  for (const list of LISTS) {
    const items = listNode(parse(text, file), list.key, file)?.children || [];
    let removedHere = false;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (!isOwn(list, jsonc.getNodeValue(items[index]))) continue;
      text = removeItem(text, listNode(parse(text, file), list.key, file).children, index);
      removedHere = true;
    }
    changed = changed || removedHere;
    // A list Bridge emptied goes too, unless a comment of the person's is in it.
    const root = parse(text, file);
    const node = listNode(root, list.key, file);
    if (removedHere && node.children.length === 0 && !hasComment(text, node.offset, node.length)) {
      text = removeItem(text, root.children, root.children.indexOf(node.parent));
    }
  }
  if (!changed) return { text: source, changed: false, empty: false };
  const left = parse(text, file).children.map((property) => property.children[0].value);
  return { text, changed: true, empty: left.every((name) => name === "version") && !hasComment(text) };
}

const readOptional = (file) => fsp.readFile(file, "utf8").catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});

// Written through a link: a tasks file kept in a dotfiles folder stays where it is.
const realFile = (file) => fsp.realpath(file).catch(() => file);

// Returns what happened: added, updated or unchanged. Running it again changes nothing.
export async function writeVscodeTasks(file) {
  const current = await readOptional(file);
  const next = addBridgeTasks(current ?? "", file);
  if (next === current) return "unchanged";
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await writeWhole(await realFile(file), next);
  const hadBridge = current !== null && current.trim() !== "" && removeBridgeTasks(current, file).changed;
  return hadBridge ? "updated" : "added";
}

// For an uninstall plan: `inUse` when other projects still rely on the file (the user tasks).
export async function vscodeTasksOutcome(file, { inUse = false } = {}) {
  const current = await readOptional(file);
  if (current === null || current.trim() === "") return "absent";
  let found;
  try {
    found = removeBridgeTasks(current, file).changed;
  } catch {
    return "kept_unreadable";
  }
  return !found ? "absent" : inUse ? "kept_in_use" : "removed";
}

// Takes Bridge's tasks out of the file, and the file if nothing else is in it. Running it again after
// it finished changes nothing; a file that cannot be read stays, and uninstall goes on.
export async function releaseVscodeTasks(file, { inUse = false } = {}) {
  const outcome = await vscodeTasksOutcome(file, { inUse });
  if (outcome !== "removed") return outcome;
  const removed = removeBridgeTasks(await readOptional(file), file);
  if (removed.empty) await fsp.rm(await realFile(file), { force: true });
  else await writeWhole(await realFile(file), removed.text);
  return outcome;
}

// What uninstalling a project does: its own file goes with it; the user tasks stay while another
// project is set up, the same as the agent entries.
export const vscodeTaskFiles = (root) => [
  { scope: "project", path: projectTasksFile(root) },
  { scope: "user", path: userTasksFile() },
];

export async function vscodeTasksState(root, { inUse = false } = {}) {
  const state = [];
  for (const { scope, path: file } of vscodeTaskFiles(root)) {
    state.push({ scope, path: file, outcome: await vscodeTasksOutcome(file, { inUse: scope === "user" && inUse }) });
  }
  return state;
}

export async function releaseAllVscodeTasks(root, { inUse = false } = {}) {
  const state = [];
  for (const { scope, path: file } of vscodeTaskFiles(root)) {
    const outcome = await releaseVscodeTasks(file, { inUse: scope === "user" && inUse });
    state.push({ scope, path: file, outcome });
    // Only the project's folder, and only if nothing is left in it: the user's belongs to VS Code.
    if (scope === "project" && outcome === "removed") await fsp.rmdir(path.dirname(file)).catch(() => {});
  }
  return state;
}
