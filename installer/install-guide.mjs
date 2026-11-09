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

import { createTranslator, defaultTranslator, resolveLocale, systemLocale } from "../review-bridge/features/workOrder/i18n.mjs";
import { readDefaultRoles, saveDefaultRoles } from "./personal-settings.mjs";
import { listProfiles, matchingProfiles } from "./project-profile.mjs";
import { PROVIDERS, validateRoles } from "./role-readiness.mjs";
import { PROJECT_TASKS_RELATIVE, projectTasksFile, writeVscodeTasks } from "./vscode-tasks.mjs";

const GUIDE_OPTIONS = new Set(["target", "writer", "reviewer", "profile", "port", "yes", "json", "fake-cli"]);
const BUILT_IN_ROLES = Object.freeze({ writer: "claude", reviewer: "codex" });
// In the default language; what the Guide prints is in the person's (runGuide).
export const ROOT_REFUSAL = defaultTranslator()("init.root");
export const CANCELLED = defaultTranslator()("init.cancelled");

function readinessHint(check, t) {
  if (!check.cli_present) return t("init.readiness.no_cli");
  if (check.authenticated === true) return t("init.readiness.signed_in");
  if (check.authenticated === false) return t("init.readiness.sign_in_required");
  return t("init.readiness.unknown");
}

// PostgreSQL's initdb refuses to run as root on macOS and Linux.
export function runningAsRoot() {
  return process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0;
}

// `database` is how to reach Bridge's database (host, port, user, database, passwordFile); it is
// shown the way VS Code's PostgreSQL extension asks for it, and the password stays in its file.
// init's and upgrade's last lines both come from here; `t` is the language to say them in.
export function databaseLines(database, t = defaultTranslator()) {
  return [
    "  " + t("init.done.database"),
    "    " + t("database.vscode.connection", { host: database.host, port: database.port, user: database.user, database: database.database }),
    "    " + t("database.vscode.password", { file: database.passwordFile }),
  ];
}

// `vscodeTasks`: added to the project (`true`), or why that failed. Setup is done either way, and so
// with `graph`: the lines of what was mapped, or why the project's graph was not built. Everything is
// said in one language, `t`, as create-vue says its whole wizard in one (ECOSYSTEM-REFERENCES A).
export function doneMessage(target, cwd, url, database, vscodeTasks = null, graph = null, t = defaultTranslator()) {
  const lines = [...(graph ?? []), ...(graph?.length ? [""] : []), t("init.done.title"), ""];
  const relative = path.relative(cwd, target);
  if (relative) lines.push("  cd " + (relative.includes(" ") ? "\"" + relative + "\"" : relative));
  lines.push("  " + t("init.done.agent"));
  lines.push("    /review-bridge start .review-bridge/work-packages/<file>.md");
  lines.push("    " + t("init.done.codex"));
  lines.push("  " + t("init.done.terminal"));
  lines.push("    review-bridge start .review-bridge/work-packages/<file>.md");
  if (vscodeTasks === true) lines.push("  " + t("init.done.vscode_added", { file: PROJECT_TASKS_RELATIVE }));
  else if (vscodeTasks) lines.push("  " + t("init.done.vscode_failed", { reason: vscodeTasks }));
  lines.push("  " + (url ? t("init.done.page", { url }) : t("init.done.page_not_running")));
  lines.push("", ...databaseLines(database, t));
  return lines.join("\n");
}

// The language the Guide speaks: a folder already set up keeps its own (bridge.json); a new one is set up
// in the person's, the one setUpProject writes into bridge.json (systemLocale).
async function guideTranslator(target) {
  const bridgeConfigPath = path.join(target, ".review-bridge", "bridge.json");
  return await createTranslator(fs.existsSync(bridgeConfigPath) ? await resolveLocale({ bridgeConfigPath }) : await systemLocale());
}

// `ui` is @clack/prompts (or a stand-in with the same calls). `inspectProvider` reports one
// provider's CLI and sign-in state without a model call. `setUpProject(settings, step)` sets the
// project up, running each part through `step(label, work)`.
export async function runGuide(options, {
  packageRoot, cwd = process.cwd(), interactive, ui = clack, write = () => {},
  inspectProvider, setUpProject, dataHome, asRoot = runningAsRoot, reinitialize = async () => null,
}) {
  for (const key of Object.keys(options)) {
    if (!GUIDE_OPTIONS.has(key)) throw new Error("Unknown option for init: --" + key);
  }
  const version = JSON.parse(await fsp.readFile(path.join(packageRoot, "package.json"), "utf8")).version;
  const target = path.resolve(cwd, options.target ?? ".");
  const stat = await fsp.lstat(target).catch(() => null);
  const t = await guideTranslator(target);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(t("init.not_a_folder", { folder: target }));
  // A folder already set up: with its record in the data folder it is an install, which upgrade moves;
  // without it, init rebuilds the record and leaves everything else as it is, as git init reinitializes.
  if (fs.existsSync(path.join(target, ".review-bridge"))) {
    const reinitialized = await reinitialize(target, t);
    if (!reinitialized) throw new Error(t("init.already_set_up", { folder: path.join(target, ".review-bridge") }));
    if (!options.json) write(t("init.reinitialized", { folder: reinitialized.private_root }) + "\n" + (reinitialized.graph_lines ?? []).map((line) => line + "\n").join(""));
    return { ...reinitialized, printed: !options.json };
  }
  if (asRoot()) throw new Error(t("init.root"));

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
        message: t("init.select_role", { role }),
        options: PROVIDERS.map((provider) => ({ value: provider, label: provider, hint: readinessHint(readiness[provider], t) })),
        initialValue: preset,
      });
      if (ui.isCancel(answer)) return cancel(ui, t);
      roles[role] = answer;
    } else roles[role] = preset;
  }
  validateRoles(roles);
  if (!interactive && !options.json && saved && (!options.writer || !options.reviewer)) {
    write(t("init.default_roles", { writer: roles.writer, reviewer: roles.reviewer }) + "\n");
  }

  // The project type preselects what detection found; it can always be left as none.
  let profileId = options.profile;
  if (profileId === undefined) {
    const matched = (await matchingProfiles(target)).map((profile) => profile.profile_id);
    const preset = matched[0] ?? "none";
    if (interactive) {
      const answer = await ui.select({
        message: t("init.select_profile"),
        options: [
          ...(await listProfiles()).map((profile) => ({
            value: profile.profile_id, label: profile.profile_id, ...(matched.includes(profile.profile_id) ? { hint: t("init.profile.detected") } : {}),
          })),
          { value: "none", label: "none", hint: t("init.profile.none") },
        ],
        initialValue: preset,
      });
      if (ui.isCancel(answer)) return cancel(ui, t);
      profileId = answer;
    } else profileId = preset;
  }

  // The last question, still before any work. Writing into the project outside .review-bridge/ is the
  // person's yes to give, so nothing is written without one: no terminal, or --yes, means no.
  let addVscodeTasks = false;
  if (interactive) {
    const answer = await ui.confirm({ message: t("init.vscode_question", { file: PROJECT_TASKS_RELATIVE }), initialValue: false });
    if (ui.isCancel(answer)) return cancel(ui, t);
    addVscodeTasks = answer;
  }

  const step = interactive ? spinnerStep(ui) : options.json ? (label, work) => work(() => {}) : lineStep(write);
  const result = await setUpProject({
    target, roles, profileId, watchPort: options.port === undefined ? undefined : Number(options.port), fakeCli: Boolean(options["fake-cli"]), t,
  }, step);
  await saveDefaultRoles(roles, { dataHome });
  // The project is set up by now; a tasks file Bridge cannot read does not undo that.
  let vscodeTasks = null;
  if (addVscodeTasks) {
    vscodeTasks = await step(t("init.step.vscode"), () => writeVscodeTasks(projectTasksFile(target)))
      .then(() => true, (error) => error.message);
  }
  const message = doneMessage(target, cwd, result.url, result.database, vscodeTasks, result.graph_lines ?? null, t);
  if (interactive) ui.outro(message);
  else if (!options.json) write(message + "\n");
  return { ...result, printed: !options.json };
}

function cancel(ui, t) {
  ui.cancel(t("init.cancelled"));
  return { ok: false, cancelled: true, printed: true };
}

// One spinner line per step; a failed step is marked and its error goes on to the caller. A long step
// says how far it is on that line (`update`, clack's spinner message).
function spinnerStep(ui) {
  return async (label, work) => {
    const spin = ui.spinner();
    spin.start(label);
    try {
      const value = await work((text) => spin.message(label + ": " + text));
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
    return await work(() => {});
  };
}
