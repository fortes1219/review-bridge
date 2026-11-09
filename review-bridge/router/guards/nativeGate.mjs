// When a model may be called for real (native mode). Owner 2026-10-25: the authorization is the
// person's yes to the card a start prints. The person says it at the terminal, or tells an agent,
// which runs the command again with --yes; authorized_via records "terminal" or "agent". An agent
// is the window most people work through, so the terminal requirement T0-08 once made is gone;
// what keeps an agent from acting on its own is the agent's own tool (its permission prompts), not
// Bridge. What Bridge still guarantees: no model is called before the reviewer read-only proof
// held by the running page service (below), and the commands other than the ones a person starts
// stay closed in native mode.

import { checkService } from "../../features/setupCheck/index.mjs";
import { bridgeRunner } from "../../utils/bridgeCommand.mjs";

export const NATIVE_MODEL_COMMANDS = Object.freeze(["start", "resume", "work-start", "review", "bounded-resume"]);
// The commands that start work on a person's yes.
const CONFIRMED_COMMANDS = Object.freeze(["start", "resume", "work-start"]);

const PREFIX = "Native execution is unavailable";

export function nativeGateDecision({ command, args = [] }) {
  if (args.includes("--fake-cli")) return { allowed: true, mode: "fake_cli" };
  if (!NATIVE_MODEL_COMMANDS.includes(command)) return { allowed: true, mode: "model_free" };
  if (!CONFIRMED_COMMANDS.includes(command)) {
    return { allowed: false, reason: "entry_point", message: PREFIX + " for " + command + ": only start and resume may call a model. Run: " + bridgeRunner() + " start <file>" };
  }
  return { allowed: true, mode: "native" };
}

export function assertNativeAllowed(input) {
  const decision = nativeGateDecision(input);
  if (!decision.allowed) {
    const error = new Error(decision.message);
    error.nativeGate = decision.reason;
    throw error;
  }
  return decision;
}

// N7: native execution needs the reviewer read-only proof (installer contract: native is
// blocked until the probe proves the reviewer cannot write). That proof deliberately lives only in
// the running page service's memory, so it cannot be forged by editing a file; a start asks that
// service over loopback after T0-01's identity check (session pid and service_id must match). The
// service recomputes its configuration fingerprint on every status call, so a changed CLI, adapter
// or probe turns the proof stale. This is an operating restriction: an agent under the same
// OS account could stand up a look-alike service.
export async function checkReviewerProof(paths, { check = checkService, reviewer = null, mcp = null } = {}) {
  const service = await check(paths, { reviewer, mcp });
  if (!service.running) {
    return { ok: false, reason: "watch_not_running", detail: service.reason, message: PREFIX + ": the Bridge page service is not running (" + service.reason + "). Run: " + bridgeRunner() + " start <file> (it starts the page and runs the check first)" };
  }
  const state = service.status?.reviewer_readonly?.state || "unknown";
  if (service.status?.reviewer_readonly_proven !== true || state !== "proven") {
    return { ok: false, reason: "reviewer_not_proven", detail: state, message: PREFIX + ": the reviewer read-only check has not passed (state: " + state + "). Run: " + bridgeRunner() + " start <file> (it runs the check first) or open " + service.url + " and press Check." };
  }
  return { ok: true, reason: "proven", detail: state };
}

export async function assertReviewerProof(paths, options) {
  const result = await checkReviewerProof(paths, options);
  if (!result.ok) {
    const error = new Error(result.message);
    error.nativeGate = result.reason;
    throw error;
  }
  return result;
}
