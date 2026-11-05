// The install Guide: `review-bridge init`, run in the project folder (or --target <folder>). It
// follows create-vite: every question has a default and is asked only when the command line did not
// answer it, all questions come first, then the work runs one step per line, then "Done. Now:" and
// the next commands. Nothing is confirmed and no plan is printed. Without a terminal (or with --yes
// or --json) nothing is asked: command line, then saved defaults, then built-in defaults.
// Bridge itself is installed by npm; the Guide sets up one project.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import * as clack from "@clack/prompts";

import { readDefaultRoles, saveDefaultRoles } from "./personal-settings.mjs";
import { listProfiles, matchingProfiles } from "./project-profile.mjs";
import { PROVIDERS, validateRoles } from "./role-readiness.mjs";
import { PROJECT_TASKS_RELATIVE, projectTasksFile, writeVscodeTasks } from "./vscode-tasks.mjs";

const GUIDE_OPTIONS = new Set(["target", "writer", "reviewer", "profile", "port", "yes", "json", "fake-cli"]);
const BUILT_IN_ROLES = Object.freeze({ writer: "claude", reviewer: "codex" });
export const ROOT_REFUSAL = "PostgreSQL cannot run as root. Run Review Bridge as a regular user.";
export const CANCELLED = "Operation cancelled.";

function readinessHint(check) {
  if (!check.cli_present) return "CLI not found";
  if (check.authenticated === true) return "signed in";
  if (check.authenticated === false) return "sign-in required";
  return "sign-in status unknown";
}

// PostgreSQL's initdb refuses to run as root on macOS and Linux.
export function runningAsRoot() {
  return process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0;
}

// `database` is how to reach Bridge's database (host, port, user, database, passwordFile); it is
// shown the way VS Code's PostgreSQL extension asks for it, and the password stays in its file.
// init's and upgrade's last lines both come from here.
export function databaseLines(database) {
  return [
    "  database in VS Code: install Microsoft's PostgreSQL extension and add a connection with",
    "    Server " + database.host + "  Port " + database.port + "  User " + database.user + "  Database " + database.database,
    "    Password: copy it from " + database.passwordFile,
  ];
}

// `vscodeTasks`: added to the project (`true`), or why that failed. Setup is done either way.
export function doneMessage(target, cwd, url, database, vscodeTasks = null) {
  const lines = ["Done. Now:", ""];
  const relative = path.relative(cwd, target);
  if (relative) lines.push("  cd " + (relative.includes(" ") ? "\"" + relative + "\"" : relative));
  lines.push("  put a work order .md in .review-bridge/work-packages/, then in Claude Code type:");
  lines.push("    /review-bridge start .review-bridge/work-packages/<file>.md");
  lines.push("    (in Codex: $review-bridge start .review-bridge/work-packages/<file>.md)");
  lines.push("  at a terminal, for advanced use and CI:");
  lines.push("    review-bridge start .review-bridge/work-packages/<file>.md");
  if (vscodeTasks === true) lines.push("  in VS Code (" + PROJECT_TASKS_RELATIVE + "): open Quick Open and type: task review-bridge");
  else if (vscodeTasks) lines.push("  VS Code tasks were not added: " + vscodeTasks + " Fix it, then run: review-bridge vscode");
  lines.push("  page: " + (url || "not running; start it with review-bridge up"));
  lines.push("", ...databaseLines(database));
  return lines.join("\n");
}

// `ui` is @clack/prompts (or a stand-in with the same calls). `inspectProvider` reports one
// provider's CLI and sign-in state without a model call. `setUpProject(settings, step)` sets the
// project up, running each part through `step(label, work)`.
export async function runGuide(options, {
  packageRoot, cwd = process.cwd(), interactive, ui = clack, write = () => {},
  inspectProvider, setUpProject, dataHome, asRoot = runningAsRoot,
}) {
  for (const key of Object.keys(options)) {
    if (!GUIDE_OPTIONS.has(key)) throw new Error("Unknown option for init: --" + key);
  }
  const version = JSON.parse(await fsp.readFile(path.join(packageRoot, "package.json"), "utf8")).version;
  const target = path.resolve(cwd, options.target ?? ".");
  const stat = await fsp.lstat(target).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error("The project folder must be an existing, non-symlink folder: " + target);
  if (fs.existsSync(path.join(target, ".review-bridge"))) {
    throw new Error("This folder is already set up (" + path.join(target, ".review-bridge") + "). To move it to this version, run: review-bridge upgrade");
  }
  if (asRoot()) throw new Error(ROOT_REFUSAL);

  if (interactive) ui.intro("review-bridge v" + version);
  const saved = await readDefaultRoles({ dataHome });
  const readiness = {};
  for (const provider of PROVIDERS) readiness[provider] = await inspectProvider(provider);
  const roles = {};
  for (const role of ["writer", "reviewer"]) {
    const preset = saved?.[role] ?? BUILT_IN_ROLES[role];
    if (options[role]) roles[role] = options[role];
    else if (interactive) {
      const answer = await ui.select({
        message: "Select " + role + ":",
        options: PROVIDERS.map((provider) => ({ value: provider, label: provider, hint: readinessHint(readiness[provider]) })),
        initialValue: preset,
      });
      if (ui.isCancel(answer)) return cancel(ui);
      roles[role] = answer;
    } else roles[role] = preset;
  }
  validateRoles(roles);
  if (!interactive && !options.json && saved && (!options.writer || !options.reviewer)) {
    write("Using your default roles: writer " + roles.writer + ", reviewer " + roles.reviewer + " (change with --writer/--reviewer)\n");
  }

  // The project type preselects what detection found; it can always be left as none.
  let profileId = options.profile;
  if (profileId === undefined) {
    const matched = (await matchingProfiles(target)).map((profile) => profile.profile_id);
    const preset = matched[0] ?? "none";
    if (interactive) {
      const answer = await ui.select({
        message: "Select project type:",
        options: [
          ...(await listProfiles()).map((profile) => ({
            value: profile.profile_id, label: profile.profile_id, ...(matched.includes(profile.profile_id) ? { hint: "detected" } : {}),
          })),
          { value: "none", label: "none", hint: "no project type" },
        ],
        initialValue: preset,
      });
      if (ui.isCancel(answer)) return cancel(ui);
      profileId = answer;
    } else profileId = preset;
  }

  // The last question, still before any work. Writing into the project outside .review-bridge/ is the
  // person's yes to give, so nothing is written without one: no terminal, or --yes, means no.
  let addVscodeTasks = false;
  if (interactive) {
    const answer = await ui.confirm({ message: "Add VS Code tasks to this project's " + PROJECT_TASKS_RELATIVE + "?", initialValue: false });
    if (ui.isCancel(answer)) return cancel(ui);
    addVscodeTasks = answer;
  }

  const step = interactive ? spinnerStep(ui) : options.json ? (label, work) => work() : lineStep(write);
  const result = await setUpProject({
    target, roles, profileId, watchPort: options.port === undefined ? undefined : Number(options.port), fakeCli: Boolean(options["fake-cli"]),
  }, step);
  await saveDefaultRoles(roles, { dataHome });
  // The project is set up by now; a tasks file Bridge cannot read does not undo that.
  let vscodeTasks = null;
  if (addVscodeTasks) {
    vscodeTasks = await step("Adding VS Code tasks", () => writeVscodeTasks(projectTasksFile(target)))
      .then(() => true, (error) => error.message);
  }
  const message = doneMessage(target, cwd, result.url, result.database, vscodeTasks);
  if (interactive) ui.outro(message);
  else if (!options.json) write(message + "\n");
  return { ...result, printed: !options.json };
}

function cancel(ui) {
  ui.cancel(CANCELLED);
  return { ok: false, cancelled: true, printed: true };
}

// One spinner line per step; a failed step is marked and its error goes on to the caller.
function spinnerStep(ui) {
  return async (label, work) => {
    const spin = ui.spinner();
    spin.start(label);
    try {
      const value = await work();
      spin.stop(label);
      return value;
    } catch (error) {
      spin.error(label);
      throw error;
    }
  };
}

function lineStep(write) {
  return async (label, work) => {
    write(label + "...\n");
    return await work();
  };
}
