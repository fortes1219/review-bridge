// T0-08: when a model may be called for real (native mode).
//
// This is an operating restriction, not proof of a human. Native execution is allowed only for
// `work-start` confirmed at an interactive terminal: no --approve, no --yes, and stdin and stdout
// both a TTY, so a confirmation piped into stdin (how an earlier unauthorised run was started) is
// refused. An agent running under the same OS account can still drive a terminal; authorized_by
// records that account and authorized_via records how it was confirmed, neither proves who pressed
// the key. Every other model entry point stays closed in native mode.

import { checkService } from "../../features/setupCheck/index.mjs";

export const NATIVE_MODEL_COMMANDS = Object.freeze(["work-start", "review", "bounded-resume"]);

const PREFIX = "Native execution is unavailable";

export function nativeGateDecision({ command, args = [], stdinIsTTY = false, stdoutIsTTY = false }) {
  if (args.includes("--fake-cli")) return { allowed: true, mode: "fake_cli" };
  if (!NATIVE_MODEL_COMMANDS.includes(command)) return { allowed: true, mode: "model_free" };
  if (command !== "work-start") {
    return { allowed: false, reason: "entry_point", message: PREFIX + " for " + command + ": only work-start, confirmed at an interactive terminal, may call a model." };
  }
  if (args.includes("--approve") || args.includes("--yes")) {
    return { allowed: false, reason: "flag_confirmation", message: PREFIX + " with --approve or --yes: run work-start without them and confirm at an interactive terminal." };
  }
  if (!stdinIsTTY || !stdoutIsTTY) {
    return { allowed: false, reason: "not_a_terminal", message: PREFIX + ": work-start must run at an interactive terminal (stdin and stdout); piped input is refused." };
  }
  return { allowed: true, mode: "native_terminal" };
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

// T0-08 N7: native execution also needs the reviewer read-only proof (installer contract: native is
// blocked until the probe proves the reviewer cannot write). That proof deliberately lives only in
// the running page service's memory, so it cannot be forged by editing a file; work-start asks that
// service over loopback after T0-01's identity check (session pid and service_id must match). The
// service recomputes its configuration fingerprint on every status call, so a changed CLI, adapter
// or probe turns the proof stale. Like N1 this is an operating restriction: an agent under the same
// OS account could stand up a look-alike service.
export async function checkReviewerProof(paths, { check = checkService } = {}) {
  const service = await check(paths);
  if (!service.running) {
    return { ok: false, reason: "watch_not_running", detail: service.reason, message: PREFIX + ": the Bridge page service is not running (" + service.reason + "). Run up, open the page and pass the reviewer read-only check." };
  }
  const state = service.status?.reviewer_readonly?.state || "unknown";
  if (service.status?.reviewer_readonly_proven !== true || state !== "proven") {
    return { ok: false, reason: "reviewer_not_proven", detail: state, message: PREFIX + ": the reviewer read-only check has not passed in the running Bridge page (state: " + state + "). Open the page and run the check." };
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
