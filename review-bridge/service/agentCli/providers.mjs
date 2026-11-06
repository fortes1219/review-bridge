import { spawnSync } from "node:child_process";

export const PROVIDERS = Object.freeze(["claude", "codex"]);

export const STATUS_ARGS = Object.freeze({
  claude: ["auth", "status", "--json"],
  codex: ["login", "status"],
});

// How a person signs a provider's CLI in.
export const SIGN_IN_COMMANDS = Object.freeze({ claude: "claude auth login", codex: "codex login" });

// A model name each CLI takes. Claude's: an alias its --help names, or a full name (Bedrock's and
// Vertex's carry claude- inside). Codex's: OpenAI's model families. Anything else cannot be told to
// belong to the role's CLI, so it is refused rather than left for the CLI to fail on mid-run; a
// model from a custom Codex provider is set in Codex's own config, with model left out here.
const MODEL_NAMES = Object.freeze({
  claude: { pattern: /^(?:(?:fable|opus|sonnet|haiku)(?:\[1m\])?|.*claude-.+)$/, says: "an alias (fable, opus, sonnet, haiku) or a name with claude- in it" },
  codex: { pattern: /^(?:gpt-|codex-|o\d).*$/, says: "a name starting gpt-, codex- or o and a digit" },
});

// Why this model cannot go to this provider's CLI, or null. A model of null is the CLI's own default.
export function modelProblem(provider, model) {
  if (model === null || model === undefined) return null;
  const names = MODEL_NAMES[provider];
  if (!names) return "there is no provider " + provider;
  return names.pattern.test(model) ? null : model + " is not a " + provider + " model; " + provider + " takes " + names.says;
}

// Why the writer's disallowed tools cannot be held to, or null. Claude Code takes a list of tools to
// deny; Codex's app server has no such setting, so a policy that sets one refuses the start there
// instead of being ignored.
export function disallowedToolsProblem(provider, tools) {
  return provider === "codex" && tools?.length ? "the policy's writer.disallowed_tools (" + tools.join(", ") + ") cannot be held to with codex as the writer" : null;
}

// Which provider fills a role in this run. A run authorized before plans named them ran the only
// pairing that existed then, so that is a fact about those runs, not a default for new ones.
const PAIRING_BEFORE_ROLES = Object.freeze({ writer: "claude", reviewer: "codex" });
export function roleProvider(workPackage, role) {
  return workPackage?.[role]?.provider ?? PAIRING_BEFORE_ROLES[role];
}

function runStatus(executable, args) {
  return spawnSync(executable, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
}

function authentication(provider, result) {
  if (result.error) return "unknown";
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (provider === "claude") {
    try {
      const value = JSON.parse(result.stdout);
      if (value.loggedIn === true && result.status === 0) return true;
      if (value.loggedIn === false) return false;
    } catch {
      // Older or unexpected CLI output is unknown, never a positive result.
    }
    return "unknown";
  }
  if (/\bnot logged in\b/i.test(output)) return false;
  if (result.status === 0 && /\blogged in\b/i.test(output)) return true;
  return "unknown";
}

function nextAction(cliPresent, authenticated) {
  if (!cliPresent) return "install_cli";
  if (authenticated === false) return "sign_in";
  if (authenticated !== true) return "recheck_sign_in";
  return "none";
}

export function validateRoles({ writer, reviewer }) {
  for (const [role, provider] of Object.entries({ writer, reviewer })) {
    if (!PROVIDERS.includes(provider)) {
      throw new Error(`${role} must be one of: ${PROVIDERS.join(", ")}.`);
    }
  }
  return { writer, reviewer };
}

// Whether one provider's CLI is there and signed in. Calls no model.
export async function inspectProvider(provider, { adapter, statusProbe = runStatus } = {}) {
  let executable;
  try {
    executable = await adapter.resolveExecutable(provider);
  } catch {
    return { provider, cli_present: false, authenticated: "unknown", next_action: "install_cli" };
  }
  let authenticated = "unknown";
  try {
    authenticated = authentication(provider, statusProbe(executable, STATUS_ARGS[provider]));
  } catch {
    // A failed local probe cannot establish a login session.
  }
  return { provider, cli_present: true, authenticated, next_action: nextAction(true, authenticated) };
}

export async function inspectRoleReadiness(roles, { adapter, statusProbe = runStatus } = {}) {
  const selected = validateRoles(roles);
  if (!adapter || typeof adapter.resolveExecutable !== "function") {
    throw new Error("A platform adapter with resolveExecutable is required.");
  }
  const checks = {};
  for (const [role, provider] of Object.entries(selected)) checks[role] = await inspectProvider(provider, { adapter, statusProbe });
  return {
    roles: selected,
    checks,
    reviewer_readonly_proven: "not_run",
    ready_for_reviewer_probe: Object.values(checks).every(
      (check) => check.cli_present && check.authenticated === true,
    ),
    native_ready: false,
  };
}
