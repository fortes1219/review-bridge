// Which MCP servers a run's sessions keep (Owner 2026-11-05). The policy's reviewer.mcp_allow names the
// servers a person chose to let through; everything else is off. An allowed server is let through as it
// is: nothing here shows that it cannot write. That check is its own work (RC3-MCP-01).
import { projectMcpServers } from "./claude.mjs";
import { SIGN_IN_COMMANDS } from "./providers.mjs";

const missing = (names, have) => names.filter((name) => !have.has(name));

// A role's CLI that is not there or not signed in: what the person hears first, and all they hear.
export class RoleCliNotReadyError extends Error {
  constructor({ role, provider, nextAction }) {
    super("The " + role + " (" + provider + ") is not installed and signed in. " + (nextAction === "install_cli" ? "Install the " + provider + " CLI, then sign it in: " : "Sign it in: ") + SIGN_IN_COMMANDS[provider]);
    this.name = "RoleCliNotReadyError";
    this.role = role;
    this.provider = provider;
    this.nextAction = nextAction;
  }
}

// `reviewer` and `writer` are the providers filling those roles (a caller that only asks about one
// leaves the other out). Codex has no switch for "only these", so each server it would load is named
// and turned off; `listCodex` reads that list, once. Only the reviewer's calls keep what the person
// allowed, as with Claude Code: the writer and the translation keep nothing. `checkCodex` says whether
// its CLI is ready, and comes first: a person who has yet to install or sign in is told that, not
// about a list. A run with no Codex in it asks neither. Claude Code loads no server to begin with, so
// an allowed one must come from the project's .mcp.json: that is the only place its definition can be
// read from without opening the person's own settings.
export async function settleMcp({ writer = null, reviewer, allow, listCodex, checkCodex = null, cwd }) {
  let servers = [];
  if (writer === "codex" || reviewer === "codex") {
    const nextAction = checkCodex ? await checkCodex() : "none";
    if (nextAction !== "none") throw new RoleCliNotReadyError({ role: reviewer === "codex" ? "reviewer" : "writer", provider: "codex", nextAction });
    try {
      servers = await listCodex();
    } catch (error) {
      throw new Error("Bridge could not read Codex's MCP servers, so it cannot turn off the ones this work must not have, and nothing was started: " + error.message + " Run: codex mcp list --json");
    }
    if (reviewer === "codex") {
      const unavailable = missing(allow, new Set(servers.filter((server) => server.enabled !== false).map((server) => server.name)));
      if (unavailable.length) throw new Error("The policy's reviewer.mcp_allow names " + unavailable.join(", ") + ", which Codex does not load here (a plugin's or app's server is off in Bridge's sessions). Remove it from the list, or add it to Codex's config.");
    }
  }
  if (reviewer === "claude" && allow.length) {
    const unavailable = missing(allow, new Set(Object.keys(await projectMcpServers(cwd))));
    if (unavailable.length) throw new Error("The policy's reviewer.mcp_allow names " + unavailable.join(", ") + ", which is not in this project's .mcp.json; a Claude reviewer can only be given servers from there.");
  }
  const names = servers.map((server) => server.name);
  return {
    writerOff: writer === "codex" ? names : [],
    reviewerOff: reviewer === "codex" ? names.filter((name) => !allow.includes(name)) : [],
    reviewerMcp: [...allow],
  };
}
