// Why a work order stopped when the controller, not a provider, ended it; and the short form the
// run state keeps for any stop.

export function budgetStop({ phase, maxCalls, observedAt = new Date().toISOString() }) {
  return {
    schema_version: 1,
    role: "controller",
    provider: "review-bridge",
    phase,
    reason: "work_package_call_budget",
    observed_at: observedAt,
    exit_code: null,
    reset_hint: null,
    reset_hint_source: null,
    max_calls: maxCalls,
  };
}

export function controllerError({ phase, observedAt = new Date().toISOString() }) {
  return {
    schema_version: 1,
    role: "controller",
    provider: "review-bridge",
    phase,
    reason: "controller_error",
    observed_at: observedAt,
    exit_code: null,
    reset_hint: null,
    reset_hint_source: null,
  };
}

export function failureSummary(failure, recordPath = null) {
  if (!failure) return null;
  return {
    role: failure.role,
    provider: failure.provider,
    phase: failure.phase,
    reason: failure.reason,
    observed_at: failure.observed_at,
    exit_code: failure.exit_code,
    reset_hint: failure.reset_hint,
    record_path: recordPath,
  };
}
