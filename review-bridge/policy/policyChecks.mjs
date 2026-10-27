export function validateJobPolicy(job, control) {
  if (job.priority !== control.reviewer_policy?.priority) {
    throw new Error("Review job priority does not match CONTROL policy.");
  }
  if (control.reviewer_policy?.effort !== job.reasoning_effort) {
    throw new Error("Review job effort does not match CONTROL policy.");
  }
  if (job.session_id !== control.active_writer_session) {
    throw new Error("Review job session does not match CONTROL.");
  }
  if (String(job.authorization?.plan_sha256 || "")
      !== String(control.authorization_plan_sha256 || "")) {
    throw new Error("Review job authorization does not match CONTROL.");
  }
}

export function validateWriterPolicy(control, rounds, callTimeout) {
  const policy = control.token_policy || {};
  const reconstructionRequiresHuman = policy.full_reconstruction_requires_human;
  const valid = control.authorization_status === "active"
    && control.mode === "bounded_standing_correction"
    && Boolean(control.active_writer_session)
    && control.dispatch_transport === "writer_cli_resume_same_session"
    && policy.writer_mode === "writer_only"
    && ["low", "medium", "high"].includes(policy.writer_effort)
    && Array.isArray(policy.writer_disallowed_tools)
    && policy.writer_self_review === "one_local_consistency_pass"
    && policy.full_reconstruction_on_correction === false
    && reconstructionRequiresHuman === true;
  if (!valid) {
    if (control.authorization_status === "consumed") {
      throw new Error("CONTROL authorization is consumed; the human owner must issue a new authorization.");
    }
    throw new Error("CONTROL does not enforce an active writer-only bounded authorization.");
  }
  if (Number(policy.rounds_per_resume) !== rounds) {
    throw new Error("Writer rounds do not match CONTROL.");
  }
  if (Number(policy.call_timeout) !== callTimeout) {
    throw new Error("Writer call timeout does not match CONTROL.");
  }
}
