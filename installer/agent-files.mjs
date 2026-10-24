// The two files init adds so an agent knows how a work order is run: Claude Code's /review-bridge
// command (.claude/commands/review-bridge.md) and the same note in AGENTS.md. Both come from
// project-templates/agent-guide.md. A command file the project already has is left alone; an
// AGENTS.md gets the note appended between markers, never overwritten. What was written is
// recorded so a rollback or an uninstall removes exactly that, and only while it is unchanged.
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const AGENT_COMMAND_RELATIVE = ".claude/commands/review-bridge.md";
export const AGENTS_RELATIVE = "AGENTS.md";
const SECTION_START = "<!-- review-bridge:start -->";
const SECTION_END = "<!-- review-bridge:end -->";

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

export async function agentFileTexts() {
  const guide = await fsp.readFile(path.join(packageRoot, "project-templates", "agent-guide.md"), "utf8");
  return {
    command: [
      "---",
      "description: Run a Review Bridge work order; the person answers the start question",
      "argument-hint: <work order .md>",
      "---",
      "",
      guide.replaceAll("{{file}}", "$ARGUMENTS"),
    ].join("\n"),
    section: [SECTION_START, "## Review Bridge", "", guide.replaceAll("{{file}}", "<file>").trimEnd(), SECTION_END, ""].join("\n"),
  };
}

// What init will do with each file; part of the sealed install plan.
export async function planAgentFiles(root) {
  const command = await readOptional(absolute(root, AGENT_COMMAND_RELATIVE));
  const agents = await readOptional(absolute(root, AGENTS_RELATIVE));
  return {
    command: { path: AGENT_COMMAND_RELATIVE, action: command === null ? "create" : "keep" },
    agents: { path: AGENTS_RELATIVE, action: agents === null ? "create" : agents.toString("utf8").includes(SECTION_START) ? "keep" : "append" },
  };
}

function appendedText(record, section) {
  return (record.added_prefix_newline ? "\n" : "") + (record.created_file ? "" : "\n") + section;
}

// Writes what the plan says; a failure part way undoes this function's own writes first.
export async function writeAgentFiles(root, planned) {
  const { command, section } = await agentFileTexts();
  const record = { command: null, agents: null };
  try {
    if (planned.command.action === "create") {
      const file = absolute(root, AGENT_COMMAND_RELATIVE);
      const createdDirs = [];
      for (const dir of [path.join(root, ".claude"), path.dirname(file)]) {
        if (!(await fsp.stat(dir).catch(() => null))) createdDirs.push(path.relative(root, dir).split(path.sep).join("/"));
      }
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const handle = await fsp.open(file, "wx");
      try { await handle.writeFile(command, "utf8"); } finally { await handle.close(); }
      record.command = { path: AGENT_COMMAND_RELATIVE, sha256: sha256(Buffer.from(command, "utf8")), created_dirs: createdDirs };
    }
    if (planned.agents.action !== "keep") {
      const file = absolute(root, AGENTS_RELATIVE);
      const before = await readOptional(file);
      const created = before === null;
      const prefix = Boolean(before && before.length && before[before.length - 1] !== 10);
      const agents = { path: AGENTS_RELATIVE, created_file: created, added_prefix_newline: prefix };
      const added = Buffer.from(appendedText(agents, section), "utf8");
      if (created) {
        const handle = await fsp.open(file, "wx");
        try { await handle.writeFile(added); } finally { await handle.close(); }
      } else {
        await fsp.appendFile(file, added);
      }
      record.agents = { ...agents, added_sha256: sha256(added), added_length: added.length };
    }
    return record;
  } catch (error) {
    await undoAgentFiles(root, record).catch(() => {});
    throw error;
  }
}

// Removes what init wrote, each part only while it is still exactly as written; an edited file
// is the person's and stays. Running it again after it finished changes nothing.
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

// For an uninstall plan: whether each part is still what init wrote.
export async function agentFilesState(root, record) {
  const state = {};
  if (record?.command) {
    const current = await readOptional(absolute(root, record.command.path));
    state.command = { path: record.command.path, unchanged: current !== null && sha256(current) === record.command.sha256 };
  }
  if (record?.agents) {
    const current = await readOptional(absolute(root, record.agents.path));
    const length = record.agents.added_length;
    state.agents = {
      path: record.agents.path,
      unchanged: current !== null && current.length >= length && sha256(current.subarray(current.length - length)) === record.agents.added_sha256,
    };
  }
  return state;
}
