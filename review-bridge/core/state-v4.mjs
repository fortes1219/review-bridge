import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  appendJsonLineDurable,
  ensureDir,
  fileExists,
  listJson,
  readJson,
  writeJsonAtomicDurable,
  writeJsonExclusiveDurable,
} from "./io.mjs";
import {
  classificationProfileFromSnapshot,
  codexPolicyFromSnapshot,
  digest,
  loadOrCreatePolicySnapshot,
} from "./policy-v4.mjs";

// The one list of run statuses; retention and the CLI read it from here so a new terminal
// status cannot be forgotten by the archive again.
export const ACTIVE_RUN_STATUSES = Object.freeze(["running", "review_pending", "correction_pending", "interrupted"]);
export const TERMINAL_RUN_STATUSES = Object.freeze([
  "pass", "hard_stop", "rate_limited", "cancelled", "policy_failure",
  "call_budget_exhausted", "claude_timeout", "claude_failed", "reviewer_failed", "controller_failure",
  "token_limit", "stopped", "reference_changed",
  "needs_human", "malformed_writer_result", "malformed_review_result",
]);
const activeStatuses = new Set(ACTIVE_RUN_STATUSES);
const terminalStatuses = new Set(TERMINAL_RUN_STATUSES);

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function plusSeconds(source, seconds) {
  return new Date(Date.parse(source) + seconds * 1000).toISOString();
}

function assertId(value, label) {
  const text = String(value || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(text)) throw new Error(label + " is invalid.");
  return text;
}

function workPackageFile(paths, id, sha256) {
  return path.join(paths.workPackagesDir, assertId(id, "Work package id"), sha256 + ".json");
}

function authorizationFile(paths, authorizationId) {
  return path.join(paths.authorizationsDir, assertId(authorizationId, "Authorization id") + ".json");
}

function claimFile(paths, claimKey) {
  return path.join(paths.authorizationClaimsDir, assertId(claimKey, "Authorization claim key") + ".json");
}

function claimKeyForAuthorization(authorization) {
  return authorization.source_plan_sha256
    ? "plan-" + authorization.source_plan_sha256
    : authorization.authorization_id;
}

function runFile(paths, runId) {
  return path.join(paths.runsDir, assertId(runId, "Run id") + ".json");
}

function eventFile(paths, runId) {
  return path.join(paths.eventsDir, assertId(runId, "Run id") + ".jsonl");
}

function lockFile(paths, runId) {
  return path.join(paths.runLocksDir, assertId(runId, "Run id") + ".json");
}

function guardFile(paths, runId) {
  return path.join(paths.reconcileGuardsDir, assertId(runId, "Run id") + ".json");
}

// Read, and treat a file that is gone (or, on Windows, being deleted) as absent. A check-then-read
// left a window in which a released lock made the read throw (found by the T0-07 lock race test).
async function readOptional(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error?.code === "ENOENT" || (process.platform === "win32" && error?.code === "EPERM")) return null;
    throw error;
  }
}

async function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

async function moveExpiredRecord(file, tombstoneSuffix) {
  const tombstone = file + ".stale-" + tombstoneSuffix + "-" + randomUUID();
  try {
    await fsp.rename(file, tombstone);
    return tombstone;
  } catch (error) {
    if (["ENOENT", "EEXIST", "EPERM"].includes(error.code)) return null;
    throw error;
  }
}

async function acquireReconcileGuard(paths, runId, policy, { clock }) {
  await ensureDir(paths.reconcileGuardsDir);
  const file = guardFile(paths, runId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const acquiredAt = nowIso(clock);
    const record = {
      schema_version: 4,
      run_id: runId,
      guard_nonce: randomUUID(),
      owner_pid: process.pid,
      acquired_at: acquiredAt,
      expires_at: plusSeconds(acquiredAt, policy.limits.reconcile_guard_ttl_seconds),
    };
    try {
      await writeJsonExclusiveDurable(file, record);
      return {
        record,
        async assertOwner() {
          const current = await readOptional(file);
          if (current?.guard_nonce !== record.guard_nonce || Date.parse(current.expires_at) <= clock()) {
            throw new Error("Reconcile guard lease was lost.");
          }
        },
        async release() {
          const current = await readOptional(file);
          if (current?.guard_nonce === record.guard_nonce) await fsp.rm(file, { force: true });
        },
      };
    } catch (error) {
      if (isTransientCreateError(error)) { await new Promise((resolve) => setTimeout(resolve, 25)); continue; }
      if (error.code !== "EEXIST") throw error;
      // The holder may release between our failed create and this read; that is a free guard, so try again.
      const existing = await readOptional(file);
      if (!existing) continue;
      if (Date.parse(existing.expires_at) > clock()) throw new Error("Run reconciliation is already in progress.");
      const moved = await moveExpiredRecord(file, existing.guard_nonce || "unknown");
      if (!moved) continue;
    }
  }
  throw new Error("Could not acquire the reconcile guard.");
}

function isTransientCreateError(error) {
  return process.platform === "win32" && ["EPERM", "ENOENT", "EBUSY"].includes(error?.code);
}

async function heartbeatLock(file, lease, clock) {
  const current = await readOptional(file);
  if (current?.lock_nonce !== lease.lock_nonce) throw new Error("Run lock lease was lost.");
  current.heartbeat_at = nowIso(clock);
  await writeJsonAtomicDurable(file, current);
}

export async function acquireRunLock(paths, runId, policy, {
  allowReconcile = true,
  clock = Date.now,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  // T0-09 M2: only the step that closes a run caught by maintenance may lock while the marker exists.
  duringMaintenance = false,
} = {}) {
  if (!duringMaintenance && await fileExists(paths.upgradeMarkerPath)) throw new Error("Runtime upgrade is in progress.");
  await ensureDir(paths.runLocksDir);
  const file = lockFile(paths, runId);
  let lastTransient = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const acquiredAt = nowIso(clock);
    const record = {
      schema_version: 4,
      run_id: runId,
      lock_nonce: randomUUID(),
      pid: process.pid,
      acquired_at: acquiredAt,
      heartbeat_at: acquiredAt,
    };
    try {
      await writeJsonExclusiveDurable(file, record);
      let heartbeatFailure = null;
      const interval = setInterval(() => {
        heartbeatLock(file, record, clock).catch((error) => { heartbeatFailure = error; });
      }, policy.limits.heartbeat_interval_seconds * 1000);
      interval.unref?.();
      return {
        ...record,
        async assertOwner() {
          if (heartbeatFailure) throw heartbeatFailure;
          const current = await readOptional(file);
          if (current?.lock_nonce !== record.lock_nonce) throw new Error("Run lock lease was lost.");
        },
        async release() {
          clearInterval(interval);
          const current = await readOptional(file);
          if (current?.lock_nonce === record.lock_nonce) await fsp.rm(file, { force: true });
        },
      };
    } catch (error) {
      // On Windows a lock file that is being deleted can refuse an exclusive create with EPERM,
      // ENOENT or EBUSY instead of EEXIST; that is a lock in transit, not a failure.
      if (isTransientCreateError(error)) { lastTransient = error.code; await new Promise((resolve) => setTimeout(resolve, 25)); continue; }
      if (error.code !== "EEXIST") throw error;
      // The holder may release between our failed create and this read; that is a free lock, so try again.
      const existing = await readOptional(file);
      if (!existing) continue;
      const heartbeatExpired = clock() - Date.parse(existing.heartbeat_at)
        >= policy.limits.lock_stale_seconds * 1000;
      const live = await pidAlive(Number(existing.pid)) && !heartbeatExpired;
      if (live || !heartbeatExpired || !allowReconcile) throw new Error("Run lock is already held.");
      const guard = await acquireReconcileGuard(paths, runId, policy, { clock });
      try {
        const originalNonce = existing.lock_nonce;
        const originalHeartbeat = existing.heartbeat_at;
        await sleep(policy.limits.reconcile_grace_seconds * 1000);
        await guard.assertOwner();
        const reread = await readOptional(file);
        if (!reread) continue;
        if (reread.lock_nonce !== originalNonce || reread.heartbeat_at !== originalHeartbeat) {
          throw new Error("Stale-lock takeover aborted because the lock advanced.");
        }
        const moved = await moveExpiredRecord(file, originalNonce || "unknown");
        if (!moved) continue;
      } finally {
        await guard.release();
      }
    }
  }
  throw new Error("Could not acquire the run lock." + (lastTransient ? " (" + lastTransient + ")" : ""));
}

export async function withRunLock(paths, runId, policy, callback, options) {
  const lease = await acquireRunLock(paths, runId, policy, options);
  try {
    return await callback(lease);
  } finally {
    await lease.release();
  }
}

async function appendProjectionEvent(paths, previous, next, type, details, clock, substantive = true) {
  const sequence = Number(previous?.last_event_sequence || 0) + 1;
  const occurredAt = nowIso(clock);
  const projected = {
    ...next,
    last_event_sequence: sequence,
    updated_at: occurredAt,
  };
  if (substantive && activeStatuses.has(projected.status)) {
    projected.run_deadline_at = plusSeconds(
      occurredAt,
      projected.recovery_window_seconds,
    );
  }
  await appendJsonLineDurable(eventFile(paths, projected.run_id), {
    schema_version: 4,
    run_id: projected.run_id,
    sequence,
    type,
    occurred_at: occurredAt,
    substantive,
    details,
    projection: projected,
  });
  await writeJsonAtomicDurable(runFile(paths, projected.run_id), projected);
  return projected;
}

// T0-10 W4: during an upgrade or uninstall a new start writes nothing into the project, not even
// the package and authorization that come before the claim.
async function assertNoMaintenance(paths) {
  if (await fileExists(paths.upgradeMarkerPath)) throw new Error("Runtime upgrade is in progress.");
}

export async function createImmutableWorkPackage(paths, input, clock = Date.now) {
  await assertNoMaintenance(paths);
  const record = {
    schema_version: 4,
    work_package_id: assertId(input.work_package_id, "Work package id"),
    source: input.source || null,
    task: String(input.task || ""),
    acceptance_criteria: input.acceptance_criteria || [],
    scope: structuredClone(input.scope),
    budget: structuredClone(input.budget),
    breakpoint: String(input.breakpoint || ""),
    // T0-03/T0-04: what the writer will be shown travels with the immutable package.
    ...(input.work_order !== undefined ? { work_order: structuredClone(input.work_order) } : {}),
    ...(input.rules !== undefined ? { rules: structuredClone(input.rules) } : {}),
    ...(input.references !== undefined ? { references: structuredClone(input.references) } : {}),
    ...(input.gate_a !== undefined ? { gate_a: structuredClone(input.gate_a) } : {}),
    ...(input.task_file !== undefined ? { task_file: input.task_file } : {}),
    created_at: nowIso(clock),
  };
  if (!record.task.trim() || !record.breakpoint.trim()) throw new Error("Work package task and breakpoint are required.");
  record.content_sha256 = digest(record);
  const file = workPackageFile(paths, record.work_package_id, record.content_sha256);
  await ensureDir(path.dirname(file));
  if (!(await fileExists(file))) await writeJsonExclusiveDurable(file, record);
  else if (digest(await readJson(file)) !== digest(record)) throw new Error("Work package checksum collision.");
  return { record, path: file };
}

export async function createAuthorization(paths, {
  authorizationId = null,
  kind = "start",
  authorizedBy,
  authorizedVia = null,
  workPackageSha256,
  policySha256,
  ttlSeconds,
  runId = null,
  additionalBudget = null,
  sourceRunId = null,
  sourceEvidence = null,
  sourcePlanSha256 = null,
}, clock = Date.now) {
  await assertNoMaintenance(paths);
  if (!['start', 'budget_extension', 'rollback'].includes(kind)) throw new Error("Unsupported authorization kind.");
  const resolvedAuthorizationId = authorizationId
    ? assertId(authorizationId, "Authorization id")
    : randomUUID();
  const file = authorizationFile(paths, resolvedAuthorizationId);
  if (authorizationId && await fileExists(file)) {
    const existing = await readJson(file);
    if (existing.source_plan_sha256 !== sourcePlanSha256
        || existing.work_package_sha256 !== workPackageSha256
        || existing.effective_policy_sha256 !== policySha256
        || existing.authorized_by !== String(authorizedBy || "")) {
      throw new Error("Deterministic authorization id is already bound to another plan.");
    }
    return existing;
  }
  const authorizedAt = nowIso(clock);
  const record = {
    schema_version: 4,
    authorization_id: resolvedAuthorizationId,
    kind,
    authorized_by: String(authorizedBy || ""),
    ...(authorizedVia ? { authorized_via: String(authorizedVia) } : {}),
    authorized_at: authorizedAt,
    expires_at: plusSeconds(authorizedAt, ttlSeconds),
    work_package_sha256: workPackageSha256,
    effective_policy_sha256: policySha256,
  };
  if (sourcePlanSha256) record.source_plan_sha256 = sourcePlanSha256;
  if (!record.authorized_by) throw new Error("Authorization owner is required.");
  if (kind === "budget_extension") {
    record.run_id = assertId(runId, "Run id");
    record.additional_budget = structuredClone(additionalBudget);
  }
  if (kind === "rollback") {
    record.source_run_id = assertId(sourceRunId, "Source run id");
    if (!sourceEvidence) throw new Error("Rollback authorization requires source evidence.");
    record.source_evidence = sourceEvidence;
  }
  record.authorization_sha256 = digest(record);
  await ensureDir(paths.authorizationsDir);
  try {
    await writeJsonExclusiveDurable(file, record);
  } catch (error) {
    if (error.code !== "EEXIST" || !authorizationId) throw error;
    const existing = await readJson(file);
    if (existing.source_plan_sha256 !== sourcePlanSha256
        || existing.work_package_sha256 !== workPackageSha256
        || existing.effective_policy_sha256 !== policySha256
        || existing.authorized_by !== String(authorizedBy || "")) {
      throw new Error("Deterministic authorization id is already bound to another plan.");
    }
    return existing;
  }
  return record;
}

async function findWorkPackageBySha(paths, sha256) {
  const directories = await fsp.readdir(paths.workPackagesDir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const candidate = path.join(paths.workPackagesDir, directory.name, sha256 + ".json");
    if (await fileExists(candidate)) return await readJson(candidate);
  }
  throw new Error("Work package checksum does not exist.");
}

export async function claimStartAuthorization(paths, authorizationId, {
  runId = randomUUID(),
  sessionId = randomUUID(),
  executionMode = "native",
  workspaceEvidence = null,
  clock = Date.now,
} = {}) {
  if (await fileExists(paths.upgradeMarkerPath)) throw new Error("Runtime upgrade is in progress.");
  const authorization = await readJson(authorizationFile(paths, authorizationId));
  if (!['start', 'rollback'].includes(authorization.kind)) throw new Error("Authorization cannot start a run.");
  const sourcePlanClaim = Boolean(authorization.source_plan_sha256);
  const claimKey = claimKeyForAuthorization(authorization);
  const existingPlanClaim = sourcePlanClaim
    ? await readOptional(claimFile(paths, claimKey))
    : null;
  if (existingPlanClaim && await fileExists(runFile(paths, existingPlanClaim.run_id))) {
    throw new Error("Work plan already consumed, generate a new plan.");
  }
  if (Date.parse(authorization.expires_at) <= clock()) throw new Error("Authorization is expired.");
  const { snapshot } = await loadOrCreatePolicySnapshot(paths);
  if (snapshot.effective_policy_sha256 !== authorization.effective_policy_sha256) {
    throw new Error("Authorization policy snapshot is not current: Bridge was upgraded or its policy changed. Make a new plan with work-plan.");
  }
  const workPackage = await findWorkPackageBySha(paths, authorization.work_package_sha256);
  const claim = {
    schema_version: 4,
    authorization_id: authorization.authorization_id,
    authorization_sha256: authorization.authorization_sha256,
    run_id: assertId(runId, "Run id"),
    claude_session_id: assertId(sessionId, "Session id"),
    execution_mode: executionMode,
    claimed_at: nowIso(clock),
    claim_kind: authorization.kind,
    claim_key: claimKey,
  };
  await ensureDir(paths.authorizationClaimsDir);
  try {
    await writeJsonExclusiveDurable(claimFile(paths, claimKey), claim);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await readJson(claimFile(paths, claimKey));
    if (existing.run_id !== claim.run_id
        || existing.claude_session_id !== claim.claude_session_id
        || existing.authorization_sha256 !== claim.authorization_sha256) {
      if (sourcePlanClaim) throw new Error("Work plan already consumed, generate a new plan.");
      throw new Error("Authorization is already claimed by another run or session.");
    }
    if (await fileExists(runFile(paths, claim.run_id))) {
      if (sourcePlanClaim) throw new Error("Work plan already consumed, generate a new plan.");
      return {
        authorization,
        claim: existing,
        run: await reconcileRunProjection(paths, claim.run_id),
        workPackage,
        snapshot,
      };
    }
  }
  const run = {
    schema_version: 4,
    run_id: claim.run_id,
    work_package_sha256: authorization.work_package_sha256,
    authorization_ids: [authorization.authorization_id],
    effective_policy_sha256: authorization.effective_policy_sha256,
    policy_schema_version: snapshot.policy_schema_version,
    package_default_policy_sha256: snapshot.package_default_policy_sha256,
    claude_session_id: assertId(sessionId, "Session id"),
    authorized_by: authorization.authorized_by,
    authorized_via: authorization.authorized_via || null,
    status: "running",
    transition_sequence: 0,
    iteration: 0,
    execution_mode: executionMode,
    budget: {
      max_claude_calls: workPackage.budget.max_claude_calls,
      max_claude_minutes_per_call: workPackage.budget.max_claude_minutes_per_call,
      consumed_claude_calls: 0,
    },
    recovery_window_seconds: snapshot.effective_policy.limits.recovery_window_seconds,
    run_deadline_at: plusSeconds(nowIso(clock), snapshot.effective_policy.limits.recovery_window_seconds),
    workspace_evidence: workspaceEvidence,
    last_state: null,
    created_at: nowIso(clock),
    work_package_id: workPackage.work_package_id,
    last_event_sequence: 0,
    updated_at: nowIso(clock),
  };
  try {
    await writeJsonExclusiveDurable(runFile(paths, run.run_id), run);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (sourcePlanClaim) throw new Error("Work plan already consumed, generate a new plan.");
    throw new Error("Run id already exists.");
  }
  const projected = await appendProjectionEvent(paths, run, run, "run_started", {
    authorization_id: authorization.authorization_id,
  }, clock);
  return { authorization, claim, run: projected, workPackage, snapshot };
}

export async function readRun(paths, runId) {
  return await readJson(runFile(paths, runId));
}

export async function listRuns(paths, { activeOnly = false } = {}) {
  const files = await listJson(paths.runsDir);
  const runs = await Promise.all(files.map((file) => readJson(file)));
  return activeOnly ? runs.filter((run) => activeStatuses.has(run.status)) : runs;
}

export async function reconcileRunProjection(paths, runId) {
  // An archived terminal run has had its event log folded into the day file (T0-02);
  // its projection is final and is served as-is.
  const archived = await readOptional(runFile(paths, runId));
  if (archived?.archived_at && !(await fileExists(eventFile(paths, runId)))) return archived;
  const source = await fsp.readFile(eventFile(paths, runId), "utf8");
  const lines = source.split("\n");
  if (lines.at(-1) !== "") throw new Error("Event log has a partial tail.");
  const events = lines.slice(0, -1).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error("Event log is malformed at sequence " + (index + 1) + "."); }
  });
  for (const [index, event] of events.entries()) {
    if (event.sequence !== index + 1 || event.run_id !== runId) throw new Error("Event sequence is invalid.");
  }
  if (!events.length) throw new Error("Run has no event history.");
  const latest = events.at(-1).projection;
  const current = await readOptional(runFile(paths, runId));
  if (!current || current.last_event_sequence < latest.last_event_sequence) {
    await writeJsonAtomicDurable(runFile(paths, runId), latest);
  } else if (current.last_event_sequence > latest.last_event_sequence) {
    throw new Error("Run projection is ahead of durable events.");
  }
  return latest;
}

async function mutateRun(paths, runId, type, details, mutator, { substantive = true, clock = Date.now, duringMaintenance = false } = {}) {
  const { snapshot } = await loadOrCreatePolicySnapshot(paths);
  return await withRunLock(paths, runId, snapshot.effective_policy, async (lease) => {
    await lease.assertOwner();
    const current = await reconcileRunProjection(paths, runId);
    const next = await mutator(structuredClone(current));
    await lease.assertOwner();
    return await appendProjectionEvent(paths, current, next, type, details, clock, substantive);
  }, { duringMaintenance });
}

// T0-07 V2.7: delivery has its own locked path. Inside the lease: a run that already has an
// outcome returns at once with no event and no file written; otherwise `build` writes the
// result files and exactly one `run_delivered` projection event records them.
export async function deliverRun(paths, runId, build, { clock = Date.now } = {}) {
  const { snapshot } = await loadOrCreatePolicySnapshot(paths);
  return await withRunLock(paths, runId, snapshot.effective_policy, async (lease) => {
    await lease.assertOwner();
    const current = await reconcileRunProjection(paths, runId);
    if (current.outcome) return { already: true, run: current };
    if (!terminalStatuses.has(current.status)) throw new Error("Run is still active: " + runId);
    const written = await build(structuredClone(current));
    await lease.assertOwner();
    const next = {
      ...current,
      outcome: written.outcome,
      result_path: written.result_path,
      latest_result_path: written.latest_path,
      latest_result_written: written.latest_written !== false,
      result_sha256: written.sha256,
    };
    const projected = await appendProjectionEvent(paths, current, next, "run_delivered", {
      outcome: written.outcome, result_path: written.result_path, sha256: written.sha256,
    }, clock, false);
    return { already: false, run: projected };
  });
}

export async function recordRunState(paths, runId, state, options = {}) {
  return await mutateRun(paths, runId, "state_recorded", { status: state.status }, (run) => {
    run.last_state = structuredClone(state);
    // T0-06 G3.7: both halves of PASS are kept on the run, not only the reviewer's.
    if (typeof state.gate_a_passed === "boolean" || state.gate_a_passed === null) run.gate_a_passed = state.gate_a_passed;
    if (state.status === "correction_required" || state.status === "gate_a_failed") run.status = "correction_pending";
    else if (state.status === "pass") run.status = "pass";
    else if (state.status === "hard_stop") run.status = "hard_stop";
    else if (state.status === "rate_limited") run.status = "rate_limited";
    return run;
  }, options);
}

export async function consumeRun(paths, runId, reason, gate = null, options = {}) {
  return await mutateRun(paths, runId, "run_terminal", { reason, gate }, (run) => {
    if (!terminalStatuses.has(run.status)) {
      run.status = gate?.review_gate === "PASS" ? "pass"
        : gate?.hard_stop_required ? "hard_stop"
          : terminalStatuses.has(reason) ? reason : "policy_failure";
    }
    run.closed_reason = reason;
    run.closed_at = nowIso(options.clock || Date.now);
    run.review_gate = gate || null;
    return run;
  }, options);
}

// T0-04 D2.1: every writer call runs in a fresh Claude session; the run records each one.
export async function rotateRunSession(paths, runId, sessionId, options = {}) {
  return await mutateRun(paths, runId, "session_rotated", { session_id: sessionId }, (run) => {
    const history = Array.isArray(run.claude_session_ids) ? run.claude_session_ids : [run.claude_session_id];
    run.claude_session_ids = [...history, assertId(sessionId, "Session id")];
    run.claude_session_id = assertId(sessionId, "Session id");
    return run;
  }, { ...options, substantive: false });
}

export async function incrementRunIteration(paths, runId, options = {}) {
  return await mutateRun(paths, runId, "iteration_incremented", {}, (run) => {
    run.iteration = Number(run.iteration || 0) + 1;
    run.status = "correction_pending";
    return run;
  }, options);
}

export async function applyBudgetExtension(paths, authorizationId, options = {}) {
  const authorization = await readJson(authorizationFile(paths, authorizationId));
  if (authorization.kind !== "budget_extension") throw new Error("Authorization is not a budget extension.");
  const clock = options.clock || Date.now;
  if (Date.parse(authorization.expires_at) <= clock()) throw new Error("Authorization is expired.");
  const { snapshot } = await loadOrCreatePolicySnapshot(paths);
  return await withRunLock(paths, authorization.run_id, snapshot.effective_policy, async (lease) => {
    await lease.assertOwner();
    const run = await reconcileRunProjection(paths, authorization.run_id);
    if (!activeStatuses.has(run.status)) throw new Error("Budget extension requires an active run.");
    if (run.work_package_sha256 !== authorization.work_package_sha256
        || run.effective_policy_sha256 !== authorization.effective_policy_sha256) {
      throw new Error("Budget extension does not match the run.");
    }
    const claim = {
      schema_version: 4,
      authorization_id: authorization.authorization_id,
      authorization_sha256: authorization.authorization_sha256,
      run_id: run.run_id,
      claimed_at: nowIso(clock),
      claim_kind: "budget_extension",
    };
    const existingClaim = await readOptional(claimFile(paths, authorization.authorization_id));
    if (existingClaim) {
      if (existingClaim.run_id !== claim.run_id
          || existingClaim.authorization_sha256 !== claim.authorization_sha256
          || existingClaim.claim_kind !== claim.claim_kind) {
        throw new Error("Budget-extension authorization is already claimed by another run.");
      }
      if (run.authorization_ids.includes(authorization.authorization_id)) return run;
    }
    const addedCalls = Number(authorization.additional_budget?.max_claude_calls || 0);
    const nextCalls = Number(run.budget.max_claude_calls) + addedCalls;
    if (!Number.isInteger(addedCalls) || addedCalls < 1
        || nextCalls > snapshot.effective_policy.limits.max_claude_calls) {
      throw new Error("Budget extension exceeds the effective policy ceiling.");
    }
    if (!existingClaim) await writeJsonExclusiveDurable(claimFile(paths, authorization.authorization_id), claim);
    await lease.assertOwner();
    run.authorization_ids.push(authorization.authorization_id);
    run.budget.max_claude_calls = nextCalls;
    return await appendProjectionEvent(paths, await readRun(paths, run.run_id), run, "budget_extended", {
      authorization_id: authorization.authorization_id,
      added_calls: addedCalls,
    }, clock);
  }, options);
}

export async function loadControlView(paths, runId) {
  const run = await reconcileRunProjection(paths, runId);
  const workPackage = await findWorkPackageBySha(paths, run.work_package_sha256);
  const authorization = await readJson(authorizationFile(paths, run.authorization_ids[0]));
  const snapshot = await readJson(path.join(paths.policySnapshotsDir, run.effective_policy_sha256 + ".json"));
  const policy = snapshot.effective_policy;
  return {
    schema_version: 4,
    authorization_status: activeStatuses.has(run.status) ? "active" : "consumed",
    mode: "bounded_standing_correction",
    work_package: workPackage.work_package_id,
    authorized_by: authorization.authorized_by,
    authorized_at: authorization.authorized_at,
    authorization_plan_sha256: authorization.authorization_sha256,
    breakpoint: workPackage.breakpoint,
    execution_mode: run.execution_mode,
    authorized_scope: structuredClone(workPackage.scope),
    workspace_evidence: run.workspace_evidence,
    active_claude_session: run.claude_session_id,
    iteration: run.iteration,
    dispatch_transport: "claude_cli_resume_same_session",
    hard_stops: structuredClone(policy.hard_stops),
    codex_policy: codexPolicyFromSnapshot(snapshot),
    token_policy: {
      claude_disallowed_tools: structuredClone(policy.writer.disallowed_tools),
      claude_mode: policy.writer.mode,
      claude_effort: policy.writer.effort,
      independent_semantic_reviewer: policy.writer.independent_reviewer,
      claude_self_review: policy.writer.self_review,
      full_reconstruction_on_correction: false,
      full_reconstruction_requires_human: true,
      max_claude_calls_per_resume: run.budget.max_claude_calls,
      max_claude_minutes_per_call: run.budget.max_claude_minutes_per_call,
    },
    v4: { run_id: run.run_id, policy_snapshot: snapshot, work_package: workPackage },
  };
}

export async function loadControlViewBySession(paths, sessionId) {
  const matches = (await listRuns(paths, { activeOnly: true }))
    .filter((run) => run.claude_session_id === sessionId);
  if (matches.length !== 1) throw new Error("Expected exactly one active run for the Claude session.");
  return await loadControlView(paths, matches[0].run_id);
}

export async function loadSingleActiveControlView(paths) {
  const runs = await listRuns(paths, { activeOnly: true });
  if (runs.length !== 1) throw new Error("Expected exactly one active run.");
  return await loadControlView(paths, runs[0].run_id);
}

export async function assertRunResumable(paths, runId, { clock = Date.now } = {}) {
  if (await fileExists(paths.upgradeMarkerPath)) throw new Error("Runtime upgrade is in progress.");
  const run = await reconcileRunProjection(paths, runId);
  if (!activeStatuses.has(run.status)) throw new Error("Terminal run cannot resume.");
  if (Date.parse(run.run_deadline_at) <= clock()) throw new Error("Run recovery deadline is expired.");
  if (Number(run.budget.consumed_claude_calls || 0) >= Number(run.budget.max_claude_calls || 0)) {
    throw new Error("Run has no remaining budget.");
  }
  const authorization = await readJson(authorizationFile(paths, run.authorization_ids[0]));
  const claim = await readJson(claimFile(paths, claimKeyForAuthorization(authorization)));
  if (claim.run_id !== run.run_id) throw new Error("Run claim ownership is invalid.");
  const { snapshot: current } = await loadOrCreatePolicySnapshot(paths);
  if (run.policy_schema_version !== current.policy_schema_version
      || run.package_default_policy_sha256 !== current.package_default_policy_sha256) {
    await consumeRun(paths, runId, "runtime_policy_identity_changed", {
      review_gate: "FAIL",
      hard_stop_required: true,
    }, { clock });
    throw new Error("Run policy identity is not current; human hard stop required.");
  }
  return run;
}

export async function currentClassificationProfile(paths, control) {
  return classificationProfileFromSnapshot(control.v4.policy_snapshot);
}

export function createRunRuntimeState(paths, runId) {
  return {
    runId,
    async loadControl() {
      return await loadControlView(paths, runId);
    },
    async recordState(state) {
      return await recordRunState(paths, runId, state);
    },
    async consume(reason, gate) {
      return await consumeRun(paths, runId, reason, gate);
    },
    async incrementIteration() {
      return await incrementRunIteration(paths, runId);
    },
    async rotateSession(sessionId) {
      return await rotateRunSession(paths, runId, sessionId);
    },
    async getState() {
      return (await readRun(paths, runId)).last_state;
    },
  };
}

// T0-09 M1: the maintenance marker is the upgrade marker with an `operation` field.
export async function readMaintenanceMarker(paths) {
  return await readOptional(paths.upgradeMarkerPath);
}

export async function beginUpgrade(paths, metadata) {
  const marker = {
    schema_version: 4,
    upgrade_id: randomUUID(),
    started_at: new Date().toISOString(),
    ...metadata,
  };
  await writeJsonExclusiveDurable(paths.upgradeMarkerPath, marker);
  return marker;
}

export async function completeUpgrade(paths) {
  await fsp.rm(paths.upgradeMarkerPath, { force: true });
}

// T0-10: the policy identity an unclaimed authorization must still match after an upgrade.
export function policyIdentity(defaults) {
  return { policy_schema_version: defaults.policy_schema_version, package_default_policy_sha256: digest(defaults) };
}

export async function reportUpgradeInvalidations(paths, { clock = Date.now } = {}) {
  const { snapshot: current } = await loadOrCreatePolicySnapshot(paths);
  const { records, report } = await planUpgradeInvalidations(paths, current, { clock });
  for (const { authorization_id: id, record } of records) {
    await ensureDir(paths.authorizationInvalidationsDir);
    const target = path.join(paths.authorizationInvalidationsDir, id + ".json");
    if (!(await fileExists(target))) await writeJsonExclusiveDurable(target, record);
  }
  await ensureDir(paths.upgradeReportsDir);
  await writeJsonExclusiveDurable(path.join(paths.upgradeReportsDir, report.report_id + ".json"), report);
  return report;
}

// T0-10 D5: what an upgrade invalidates, computed without writing anything, so the neutral
// upgrade can record each file it is about to write before it writes it.
export async function planUpgradeInvalidations(paths, current, { clock = Date.now } = {}) {
  const records = [];
  const invalidated = [];
  for (const file of await listJson(paths.authorizationsDir)) {
    const authorization = await readJson(file);
    if (await fileExists(claimFile(paths, claimKeyForAuthorization(authorization)))) continue;
    const snapshot = await readJson(path.join(
      paths.policySnapshotsDir,
      authorization.effective_policy_sha256 + ".json",
    ));
    if (snapshot.policy_schema_version === current.policy_schema_version
        && snapshot.package_default_policy_sha256 === current.package_default_policy_sha256) continue;
    const record = {
      schema_version: 4,
      authorization_id: authorization.authorization_id,
      invalidated_at: nowIso(clock),
      reason: "runtime_policy_identity_changed",
      recorded_policy_schema_version: snapshot.policy_schema_version,
      recorded_package_default_policy_sha256: snapshot.package_default_policy_sha256,
      active_policy_schema_version: current.policy_schema_version,
      active_package_default_policy_sha256: current.package_default_policy_sha256,
    };
    records.push({ authorization_id: authorization.authorization_id, record });
    invalidated.push(authorization.authorization_id);
  }
  const report = {
    schema_version: 4,
    report_id: randomUUID(),
    created_at: nowIso(clock),
    invalidated_authorization_ids: invalidated.sort(),
    invalidated_count: invalidated.length,
  };
  return { records, report };
}
