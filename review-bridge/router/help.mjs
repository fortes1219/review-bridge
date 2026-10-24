// Help text, generated from the command table (index.mjs); nothing here lists a command or an
// option by hand. The README's command list is rendered from the same functions.
import { COMMANDS, PROJECT_OPTION } from "./index.mjs";

const HUMAN_ORDER = ["init", "start", "status", "stop", "up", "down", "ps", "watch", "upgrade", "uninstall", "doctor"];

function commandsFor(audience) {
  const names = Object.keys(COMMANDS).filter((name) => COMMANDS[name].audience === audience);
  return audience === "human" ? HUMAN_ORDER.filter((name) => names.includes(name)) : names;
}

function usageOf(name) {
  return name + (COMMANDS[name].usage ? " " + COMMANDS[name].usage : "");
}

function commandRows(names) {
  const width = Math.max(...names.map((name) => usageOf(name).length)) + 2;
  return names.map((name) => "  " + usageOf(name).padEnd(width) + COMMANDS[name].summary);
}

export function renderMainHelp({ all = false } = {}) {
  return [
    "Usage: review-bridge <command> [options]",
    "",
    "Commands:",
    ...commandRows(commandsFor("human")),
    ...(all ? ["", "For agents and scripts:", ...commandRows(commandsFor("agent"))] : []),
    "",
    "Options:",
    "  -v, --version   Print the version",
    "  -h, --help      Print this help; --help --all also lists the commands for agents and scripts",
    "",
    "Run review-bridge <command> --help for a command's options.",
    "Update Review Bridge: npm i -g review-bridge@latest",
    "Remove Review Bridge: npm uninstall -g review-bridge",
    "",
  ].join("\n");
}

// Every option of a command: name, type, default and one line of help. Options for tests and
// agents (`internal`) are listed only with --all.
export function commandOptions(name, { all = false } = {}) {
  const entry = COMMANDS[name];
  const own = Object.entries(entry.options);
  const shared = entry.installer ? [] : Object.entries(PROJECT_OPTION);
  return [...own, ...shared].filter(([, option]) => all || !option.internal);
}

export function renderCommandHelp(name, { all = false } = {}) {
  const entry = COMMANDS[name];
  const options = commandOptions(name, { all });
  const lines = [
    "Usage: review-bridge " + usageOf(name) + (options.length ? " [options]" : ""),
    "",
    entry.summary,
  ];
  if (options.length) {
    lines.push("", "Options:");
    for (const [flag, option] of options) {
      const facts = [option.type, option.required ? "required" : option.default ? "default: " + option.default : null].filter(Boolean).join("; ");
      lines.push("  " + flag + (option.value ? " " + option.value : ""), "      " + option.help + " (" + facts + ")");
    }
  }
  const hidden = commandOptions(name, { all: true }).length - options.length;
  if (hidden > 0) lines.push("", hidden + " more option(s) for tests and agents: review-bridge " + name + " --help --all");
  return lines.join("\n") + "\n";
}
