import { spawnSync } from "node:child_process";

export const PROVIDERS = Object.freeze(["claude", "codex"]);

export const STATUS_ARGS = Object.freeze({
  claude: ["auth", "status", "--json"],
  codex: ["login", "status"],
});

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

export async function inspectRoleReadiness(roles, { adapter, statusProbe = runStatus } = {}) {
  const selected = validateRoles(roles);
  if (!adapter || typeof adapter.resolveExecutable !== "function") {
    throw new Error("A platform adapter with resolveExecutable is required.");
  }
  const checks = {};
  for (const [role, provider] of Object.entries(selected)) {
    let executable;
    try {
      executable = await adapter.resolveExecutable(provider);
    } catch {
      checks[role] = {
        provider, cli_present: false, authenticated: "unknown", next_action: "install_cli",
      };
      continue;
    }
    let authenticated = "unknown";
    try {
      authenticated = authentication(provider, statusProbe(executable, STATUS_ARGS[provider]));
    } catch {
      // A failed local probe cannot establish a login session.
    }
    checks[role] = {
      provider,
      cli_present: true,
      authenticated,
      next_action: nextAction(true, authenticated),
    };
  }
  return {
    roles: selected,
    checks,
    reviewer_readonly_proven: "not_run",
    separate_sessions_proven: "not_run",
    ready_for_reviewer_probe: Object.values(checks).every(
      (check) => check.cli_present && check.authenticated === true,
    ),
    native_ready: false,
  };
}
