// How an agent learns to run a work order: one file of Bridge's own where each agent CLI looks for
// a person's commands or skills, so every project sees it and no project holds it (Owner 2026-11-04,
// 2026-11-05). Both come from project-templates/agent-guide.md. The places are the ones the CLIs read:
// CLAUDE_CONFIG_DIR or ~/.claude for Claude Code; the home directory's .agents/skills for Codex, whose
// $CODEX_HOME/skills is deprecated (openai/codex ext/skills/src/host_roots.rs).
//
// What Bridge wrote is recorded with its hash in the data home, the way get-shit-done keeps
// gsd-file-manifest.json beside what it installs: only a file still matching the record is Bridge's
// to replace or remove. Anything else at that path is the person's and stays.
//
// The second half of this file is for projects set up before that: an earlier Bridge wrote the
// command and an AGENTS.md section into the project and recorded them in its install record.
import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bridgeDataHome } from "../review-bridge/service/database/dataHome.mjs";
import { bridgeRunner } from "../review-bridge/utils/bridgeCommand.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY_NAME = "review-bridge";
const ENTRY_DESCRIPTION = "Start, pause, carry on or clear a Review Bridge work order; the person says yes to the card";
const RECORD_NAME = "agent-entries.json";
export const AGENT_COMMAND_RELATIVE = ".claude/commands/review-bridge.md";

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function readOptional(file) {
  return await fsp.readFile(file).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

function absolute(root, relative) {
  return path.join(root, ...relative.split("/"));
}

// `folder`: the entry is a whole folder of Bridge's, the way a skill is, not a file among the person's.
export function agentEntryFiles({ env = process.env, home = os.homedir() } = {}) {
  const skill = path.join(home, ".agents", "skills", ENTRY_NAME);
  return [
    { provider: "claude", file: path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "commands", ENTRY_NAME + ".md") },
    { provider: "codex", file: path.join(skill, "SKILL.md"), folder: skill },
  ];
}

// A Claude Code command gets the words after its name through $ARGUMENTS. A Codex skill has no such
// thing: `$review-bridge start <file>` stays in the person's message and the skill arrives beside it.
const ENTRY_TEXT = {
  claude: (guide) => [
    "---",
    "description: " + ENTRY_DESCRIPTION,
    "argument-hint: start <file> | stop <run_id> | resume <run_id> | clean [<run_id>]",
    "---",
    "",
    guide.replaceAll("{{args}}", "$ARGUMENTS"),
  ],
  codex: (guide) => [
    "---",
    "name: " + ENTRY_NAME,
    "description: " + ENTRY_DESCRIPTION,
    "---",
    "",
    guide.replaceAll(" ({{args}})", ""),
  ],
};

export async function agentEntryText(provider) {
  // How the person runs Bridge, as init was run (bridgeRunner); a global install runs under npx too.
  const guide = (await fsp.readFile(path.join(packageRoot, "project-templates", "agent-guide.md"), "utf8")).replaceAll("{{bridge}}", bridgeRunner());
  return ENTRY_TEXT[provider](guide).join("\n");
}

async function readRecord(dataHome) {
  const file = path.join(dataHome, RECORD_NAME);
  const bytes = await readOptional(file);
  if (bytes === null) return [];
  try {
    return JSON.parse(bytes.toString("utf8")).entries;
  } catch (error) {
    throw new Error("Bridge's record of its agent entries cannot be read: " + file + " (" + error.message + ").");
  }
}

// A whole file or none: written beside its place, then renamed over it.
export async function writeWhole(file, text) {
  const temp = file + "." + randomUUID().slice(0, 8) + ".tmp";
  await fsp.writeFile(temp, text, "utf8");
  await fsp.rename(temp, file);
}

async function saveRecord(dataHome, entries) {
  await fsp.mkdir(dataHome, { recursive: true });
  await writeWhole(path.join(dataHome, RECORD_NAME), JSON.stringify({ schema_version: 1, entries }, null, 2) + "\n");
}

// What installing would do with each file: add, replace Bridge's older copy, nothing because it is
// already this one, or keep because it is the person's.
export async function planAgentEntries({ dataHome = bridgeDataHome(), env = process.env, home = os.homedir() } = {}) {
  const record = await readRecord(dataHome);
  const planned = [];
  for (const { provider, file } of agentEntryFiles({ env, home })) {
    const wanted = sha256(Buffer.from(await agentEntryText(provider), "utf8"));
    const bytes = await readOptional(file);
    const current = bytes === null ? null : sha256(bytes);
    const action = current === null ? "add"
      : current === wanted ? "unchanged"
        : current === record.find((entry) => entry.path === file)?.sha256 ? "replace" : "keep";
    planned.push({ provider, path: file, action });
  }
  return planned;
}

export const agentEntriesPending = (planned) => planned.some((entry) => entry.action === "add" || entry.action === "replace");

// The folders mkdir would make for this file, deepest first, so that removing it can take them too.
async function missingFolders(file) {
  const missing = [];
  let current = path.dirname(file);
  while (!(await fsp.stat(current).catch(() => null))) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return missing;
}

// Installs what the plan says as of now, so running it again after an interruption finishes the job.
// The record learns each file before it is written: a failure leaves nothing Bridge cannot name.
export async function writeAgentEntries({ dataHome = bridgeDataHome(), env = process.env, home = os.homedir() } = {}) {
  const planned = await planAgentEntries({ dataHome, env, home });
  const entries = await readRecord(dataHome);
  const places = agentEntryFiles({ env, home });
  for (const { provider, path: file, action } of planned) {
    if (action === "keep") continue;
    const text = await agentEntryText(provider);
    const known = entries.find((entry) => entry.path === file);
    // Still Bridge's when the last try made these and stopped before the file.
    const createdDirs = [...new Set([...(action === "add" ? await missingFolders(file) : []), ...(known?.created_dirs || [])])];
    const { folder } = places.find((place) => place.file === file);
    // Only a folder Bridge made is Bridge's to take whole: one that was already there is the person's.
    const entry = { provider, path: file, sha256: sha256(Buffer.from(text, "utf8")), created_dirs: createdDirs, owned_folder: createdDirs.includes(folder) ? folder : null };
    if (known) Object.assign(known, entry);
    else entries.push(entry);
    await saveRecord(dataHome, entries);
    if (action === "unchanged") continue;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    if (action === "replace") {
      await writeWhole(file, text);
    } else {
      // Never over a file that appeared after the plan.
      const handle = await fsp.open(file, "wx");
      try { await handle.writeFile(text, "utf8"); } finally { await handle.close(); }
    }
  }
  return planned;
}

// What removing them means: `inUse` when another set-up project still relies on them (Homebrew's
// uninstall asks the same of a keg's installed dependents).
export async function agentEntriesState({ dataHome = bridgeDataHome(), inUse = false } = {}) {
  const state = [];
  for (const { provider, path: file, sha256: recorded, owned_folder: folder } of await readRecord(dataHome)) {
    const bytes = await readOptional(file);
    const outcome = bytes === null ? "absent" : sha256(bytes) !== recorded ? "kept_changed" : inUse ? "kept_in_use" : "removed";
    state.push({ provider, path: file, outcome, ...(folder ? { folder } : {}) });
  }
  return state;
}

// Removes each file only while it is still what Bridge wrote, a skill folder Bridge made along with
// it, and the other folders Bridge made for it while they hold nothing else. Running it again after
// it finished changes nothing.
export async function releaseAgentEntries({ dataHome = bridgeDataHome(), inUse = false } = {}) {
  const state = await agentEntriesState({ dataHome, inUse });
  if (inUse) return state;
  const record = await readRecord(dataHome);
  for (const { path: file, outcome } of state) {
    if (outcome !== "removed") continue;
    const entry = record.find((known) => known.path === file);
    await fsp.rm(file, { force: true });
    if (entry.owned_folder) await fsp.rm(entry.owned_folder, { recursive: true, force: true });
    for (const folder of entry.created_dirs) await fsp.rmdir(folder).catch(() => {});
  }
  await fsp.rm(path.join(dataHome, RECORD_NAME), { force: true });
  return state;
}

// Removes what an earlier Bridge wrote into the project, each part only while it is still exactly as
// written; an edited file is the person's and stays. Running it again after it finished changes nothing.
export async function undoAgentFiles(root, record) {
  const outcome = { command: "none", agents: "none" };
  if (record?.command) {
    const file = absolute(root, record.command.path);
    const current = await readOptional(file);
    if (current === null) outcome.command = "absent";
    else if (sha256(current) !== record.command.sha256) outcome.command = "kept_changed";
    else {
      await fsp.rm(file, { force: true });
      for (const dir of [...(record.command.created_dirs || [])].reverse()) {
        await fsp.rmdir(absolute(root, dir)).catch(() => {});
      }
      outcome.command = "removed";
    }
  }
  if (record?.agents) {
    const file = absolute(root, record.agents.path);
    const current = await readOptional(file);
    const length = record.agents.added_length;
    if (current === null) outcome.agents = "absent";
    else if (current.length < length || sha256(current.subarray(current.length - length)) !== record.agents.added_sha256) outcome.agents = "kept_changed";
    else {
      const remaining = current.subarray(0, current.length - length);
      if (remaining.length === 0 && record.agents.created_file) await fsp.rm(file, { force: true });
      else await fsp.writeFile(file, remaining);
      outcome.agents = "removed";
    }
  }
  return outcome;
}

// For an uninstall or upgrade plan: whether each part an earlier Bridge wrote is still as written. A
// file that is gone has nothing left to report.
export async function agentFilesState(root, record) {
  const state = {};
  if (record?.command) {
    const current = await readOptional(absolute(root, record.command.path));
    if (current !== null) state.command = { path: record.command.path, unchanged: sha256(current) === record.command.sha256 };
  }
  if (record?.agents) {
    const current = await readOptional(absolute(root, record.agents.path));
    const length = record.agents.added_length;
    if (current !== null) {
      state.agents = {
        path: record.agents.path,
        unchanged: current.length >= length && sha256(current.subarray(current.length - length)) === record.agents.added_sha256,
      };
    }
  }
  return state;
}
