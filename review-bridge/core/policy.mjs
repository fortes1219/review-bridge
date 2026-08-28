function compilePattern(source, label) {
  if (typeof source !== "string" || !source.trim()) {
    throw new Error("Classification profile has an empty pattern in " + label + ".");
  }
  try {
    return new RegExp(source, "i");
  } catch (error) {
    throw new Error("Invalid classification pattern in " + label + ": " + error.message);
  }
}

export function validateClassificationProfile(profile, control) {
  if (!profile || profile.schema_version !== 1 || typeof profile.profile_id !== "string") {
    throw new Error("Classification profile is missing or has an unsupported schema.");
  }
  const expected = control.codex_policy?.classification_profile;
  if (!expected || profile.profile_id !== expected) {
    throw new Error("Classification profile does not match CONTROL.");
  }
  if (!Array.isArray(profile.rules) || profile.rules.length === 0) {
    throw new Error("Classification profile has no ordered rules.");
  }
  const allowed = control.codex_policy?.allowed_review_levels || [];
  for (const [index, rule] of profile.rules.entries()) {
    const label = "rule " + (index + 1);
    if (!rule || !allowed.includes(rule.level)) {
      throw new Error("Classification profile has an invalid level in " + label + ".");
    }
    if (typeof rule.reason !== "string" || !rule.reason.trim()) {
      throw new Error("Classification profile has no reason in " + label + ".");
    }
    if (!Array.isArray(rule.any) || rule.any.length === 0) {
      throw new Error("Classification profile has no positive patterns in " + label + ".");
    }
    for (const pattern of rule.any) compilePattern(pattern, label + " any");
    for (const pattern of rule.none || []) compilePattern(pattern, label + " none");
  }
  return true;
}

function matchesAny(text, sources, label) {
  return sources.some((source) => compilePattern(source, label).test(text));
}

export function classifyReview(message, control, profile) {
  validateClassificationProfile(profile, control);
  const text = String(message).slice(0, 2500);
  let reviewLevel = String(control.codex_policy?.default_review_level || "");
  let reason = "default scoped review";
  const rank = new Map([
    ["LIGHT", 1], ["STANDARD", 2], ["FULL", 3], ["SECURITY", 4], ["FINAL_CLOSURE", 5],
  ]);
  let selectedRank = 0;
  let selectedPriority = -Infinity;
  for (const [index, rule] of profile.rules.entries()) {
    const positive = matchesAny(text, rule.any, "rule " + (index + 1) + " any");
    const excluded = matchesAny(text, rule.none || [], "rule " + (index + 1) + " none");
    const candidateRank = rank.get(rule.level) || 0;
    const candidatePriority = Number(rule.priority ?? 0);
    if (positive && !excluded
        && (candidateRank > selectedRank
          || (candidateRank === selectedRank && candidatePriority > selectedPriority))) {
      reviewLevel = rule.level;
      reason = rule.reason;
      selectedRank = candidateRank;
      selectedPriority = candidatePriority;
    }
  }
  const allowed = control.codex_policy?.allowed_review_levels || [];
  if (!allowed.includes(reviewLevel)) {
    throw new Error("Review classifier produced unsupported level: " + reviewLevel);
  }
  const effort = control.codex_policy?.effort_by_level?.[reviewLevel];
  if (!["low", "medium", "high"].includes(effort)) {
    throw new Error("Invalid reasoning effort for " + reviewLevel);
  }
  return {
    review_level: reviewLevel,
    reasoning_effort: effort,
    classification_reasons: [reason],
    classification_profile: profile.profile_id,
  };
}

export function validateJobPolicy(job, control) {
  const allowed = control.codex_policy?.allowed_review_levels || [];
  if (!allowed.includes(job.review_level)) {
    throw new Error("Review job has unsupported level: " + job.review_level);
  }
  if (control.codex_policy?.effort_by_level?.[job.review_level] !== job.reasoning_effort) {
    throw new Error("Review job effort does not match CONTROL policy.");
  }
  if (job.classification_profile !== control.codex_policy?.classification_profile) {
    throw new Error("Review job classification profile does not match CONTROL.");
  }
  if (job.session_id !== control.active_claude_session) {
    throw new Error("Review job session does not match CONTROL.");
  }
  if (String(job.authorization?.plan_sha256 || "")
      !== String(control.authorization_plan_sha256 || "")) {
    throw new Error("Review job authorization does not match CONTROL.");
  }
}

export function validateWriterPolicy(control, maxCalls, maxMinutes) {
  const policy = control.token_policy || {};
  const reconstructionRequiresHuman = policy.full_reconstruction_requires_human;
  const valid = control.authorization_status === "active"
    && control.mode === "bounded_standing_correction"
    && Boolean(control.active_claude_session)
    && control.dispatch_transport === "claude_cli_resume_same_session"
    && policy.claude_mode === "writer_only"
    && policy.claude_effort === "low"
    && (policy.claude_disallowed_tools || []).includes("Agent")
    && policy.independent_semantic_reviewer === "Codex"
    && policy.claude_self_review === "one_local_consistency_pass"
    && policy.full_reconstruction_on_correction === false
    && reconstructionRequiresHuman === true;
  if (!valid) {
    if (control.authorization_status === "consumed") {
      throw new Error("CONTROL authorization is consumed; the human owner must issue a new authorization.");
    }
    throw new Error("CONTROL does not enforce an active writer-only bounded authorization.");
  }
  if (Number(policy.max_claude_calls_per_resume) !== maxCalls) {
    throw new Error("max Claude calls does not match CONTROL.");
  }
  if (Number(policy.max_claude_minutes_per_call) !== maxMinutes) {
    throw new Error("max Claude minutes does not match CONTROL.");
  }
}
