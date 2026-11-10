import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  appendTextDurable,
  ensureDir,
  fileExists,
  listJson,
  parseJson,
  readJson,
  readLastLine,
  writeJsonAtomicDurable,
  writeJsonExclusiveDurable,
  writeTextAtomicDurable,
} from "./fileStore.mjs";
import { priorityChoice, reviewerPolicyFromSnapshot } from "../../policy/policyRules.mjs";
import { digest } from "../../utils/digest.mjs";
import { nfc, workOrderNameProblem } from "../../utils/workOrderName.mjs";
import { loadOrCreatePolicySnapshot } from "./policySnapshots.mjs";
import {
  activeRuns, DatabaseUnavailableError, eventLine, eventRecordsAfter, lastEventSequence, numberedLine, projectRuns, recordsDatabase,
  replayUnrecorded, runRecorder,
} from "./runRecords.mjs";
import { bridgeRunner } from "../../utils/bridgeCommand.mjs";

// A run's status and conclusion, as GitHub Actions has them for a workflow run; why it closed is
// its closed_reason. The one list of closed reasons; retention and the CLI read it from here so a
// new one cannot be forgotten by the archive again.
export const RUN_STATUSES = Object.freeze(["in_progress", "completed"]);
export const CLOSED_REASONS = Object.freeze([
  "review_pass", "review_hard_stop", "runtime_policy_identity_changed", "stopped", "superseded", "database_unavailable",
  "rate_limited", "cancelled", "policy_failure",
  "rounds_exhausted", "writer_timeout", "writer_failed", "reviewer_failed", "controller_failure",
  "token_limit", "reference_changed", "contract_rejected", "contract_changed", "usage_unknown", "acceptance_unverified", "start_point_lost", "evidence_changed", "version_changed", "evidence_unconfirmable", "scope_unverified",
  "needs_human", "malformed_writer_result", "malformed_review_result", "run_timeout", "evidence_unavailable",
]);
// Closed by the stop command, by a start of a newer version, because the database went away, or
// because the run reached its own time limit (run_timeout).
export const STOP_REASONS = Object.freeze(["stopped", "superseded", "database_unavailable", "run_timeout"]);
// A reviewer PASS, a hard stop or a quota stop is recorded on the run's last state before the run
// closes; from then on the run is settled, and a stop cannot take it over.
const SETTLING_STATES = new Set(["pass", "hard_stop", "rate_limited"]);
const ACTION_REQUIRED = new Set([
  "hard_stop", "needs_human", "rounds_exhausted", "acceptance_unverified",
  "start_point_lost", "evidence_changed", "version_changed", "evidence_unconfirmable", "scope_unverified",
]);

export function isActiveRun(run) {
  return run?.status === "in_progress";
}

export function isStoppedRun(run) {
  return run?.status === "completed" && STOP_REASONS.includes(run.closed_reason);
}

function settledState(run) {
  return SETTLING_STATES.has(run.last_state?.status) ? run.last_state.status : null;
}

// A closing run's conclusion: from the state it settled in, else the gate, else the reason itself.
function conclusionOf(run, reason, gate) {
  const settled = settledState(run)
    ?? (gate?.review_gate === "PASS" ? "pass"
      : gate?.hard_stop_required ? "hard_stop"
        : CLOSED_REASONS.includes(reason) ? reason : "policy_failure");
  if (settled === "pass") return "success";
  if (settled === "writer_timeout" || settled === "run_timeout") return "timed_out";
  if (settled === "cancelled" || STOP_REASONS.includes(settled)) return "cancelled";
  if (ACTION_REQUIRED.has(settled)) return "action_required";
  return "failure";
}

// A run recorded under an older policy shape is neither resumed nor delivered.
export function assertCurrentPolicy(policySchemaVersion, runId) {
  if (policySchemaVersion !== 5) {
    throw new Error("This run's policy is from an older Bridge; run: " + bridgeRunner() + " clean " + runId);
  }
}

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function plusMs(source, milliseconds) {
  return new Date(Date.parse(source) + milliseconds).toISOString();
}

function assertId(value, label) {
  const text = String(value || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(text)) throw new Error(label + " is invalid.");
  return text;
}

// The one id that is a person's word, not a hash or a uuid: the work order's file name.
function assertWorkPackageId(value) {
  const problem = workOrderNameProblem(String(value || ""));
  if (problem || !value) throw new Error("Work package id " + (problem || "is required") + ": " + JSON.stringify(value));
  return nfc(value);
}

function workPackageFile(paths, id, sha256) {
  return path.join(paths.workPackagesDir, assertWorkPackageId(id), sha256 + ".json");
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
    if (isGone(error)) return null;
    throw error;
  }
}

function isGone(error) {
  return error?.code === "ENOENT" || (process.platform === "win32" && error?.code === "EPERM");
}

// A lock file is created empty and written after (exclusive create, then write), as PostgreSQL's
// CreateLockFile does (miscinit.c:1270-1275); a reader can land in between and find it empty or half
// written. That is a lock being written, not a broken one (miscinit.c:1311-1316), so it is held; its age
// is the file's modification time, as proper-lockfile judges a lock that has no content
// (lib/lockfile.js:51-85). A file that is gone is null, as in readOptional.
async function readLockFile(file) {
  let text;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (error) {
    if (isGone(error)) return null;
    throw error;
  }
  let record;
  try {
    record = parseJson(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  // Content that parses but is not a record (`null`, a number, a list) has no fields to read either.
  if (record !== null && typeof record === "object" && !Array.isArray(record)) return { record };
  try {
    return { unwritten: true, modifiedAt: (await fsp.stat(file)).mtimeMs };
  } catch (error) {
    if (isGone(error)) return null;
    throw error;
  }
}

// What a takeover compares before and after its wait: the holder's nonce and heartbeat, or, for a
// file with no readable content, its modification time.
function lockMark(found) {
  return found.unwritten ? "unwritten " + found.modifiedAt : found.record.lock_nonce + " " + found.record.heartbeat_at;
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
      expires_at: plusMs(acquiredAt, policy.limits.reconcile_guard_ttl),
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
      const guardFound = await readLockFile(file);
      if (!guardFound) continue;
      // A guard with no readable content lives as long as a written one: reconcile_guard_ttl from its creation.
      const expired = guardFound.unwritten
        ? clock() - guardFound.modifiedAt >= policy.limits.reconcile_guard_ttl
        : Date.parse(guardFound.record.expires_at) <= clock();
      if (!expired) throw new Error("Run reconciliation is already in progress.");
      const moved = await moveExpiredRecord(file, guardFound.record?.guard_nonce || "unknown");
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
      }, policy.limits.heartbeat_interval);
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
      const found = await readLockFile(file);
      if (!found) continue;
      if (found.unwritten) {
        // Being written, or left by a holder that died before writing it: held until it is lock_stale old.
        if (clock() - found.modifiedAt < policy.limits.lock_stale || !allowReconcile) throw new Error("Run lock is already held.");
      } else {
        const existing = found.record;
        const heartbeatExpired = clock() - Date.parse(existing.heartbeat_at)
          >= policy.limits.lock_stale;
        const live = await pidAlive(Number(existing.pid)) && !heartbeatExpired;
        if (live || !heartbeatExpired || !allowReconcile) throw new Error("Run lock is already held.");
      }
      const guard = await acquireReconcileGuard(paths, runId, policy, { clock });
      try {
        const originalMark = lockMark(found);
        await sleep(policy.limits.reconcile_grace);
        await guard.assertOwner();
        const reread = await readLockFile(file);
        if (!reread) continue;
        if (lockMark(reread) !== originalMark) {
          throw new Error("Stale-lock takeover aborted because the lock advanced.");
        }
        const moved = await moveExpiredRecord(file, found.record?.lock_nonce || "unknown");
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

// `closing`: a step that closes or delivers the run, which goes on without the database (its event
// waits in unrecorded); any other step is told the database is gone, and the run stops.
async function appendProjectionEvent(paths, previous, next, type, details, clock, substantive = true, { closing = false } = {}) {
  const occurredAt = nowIso(clock);
  const projected = {
    ...next,
    updated_at: occurredAt,
  };
  if (substantive && isActiveRun(projected)) {
    projected.run_deadline_at = plusMs(
      occurredAt,
      projected.recovery_window,
    );
  }
  // The database first (RC3-BLOCKER-01 step 3): it numbers the event and records it with the state it
  // sets, in one transaction; the file takes the numbered line. A run the database does not know, and
  // a process that keeps no records, number it from the run's own files. When the database is gone the
  // line is numbered provisionally and still written, then the run is told (it stops), unless this
  // step closes or delivers it.
  const line = { schema_version: 4, run_id: projected.run_id, type, occurred_at: occurredAt, substantive, details, projection: projected };
  const recorded = await runRecorder()?.record(paths, line);
  const record = recorded?.record ?? numberedLine(line, Number(previous?.last_event_sequence || 0) + 1);
  await appendTextDurable(eventFile(paths, projected.run_id), eventLine(record) + "\n");
  await writeJsonAtomicDurable(runFile(paths, projected.run_id), record.projection);
  if (recorded?.gone && !closing) throw recorded.gone;
  return record.projection;
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
    work_package_id: assertWorkPackageId(input.work_package_id),
    source: input.source || null,
    task: String(input.task || ""),
    acceptance_criteria: input.acceptance_criteria || [],
    scope: structuredClone(input.scope),
    budget: structuredClone(input.budget),
    breakpoint: String(input.breakpoint || ""),
    // T0-03/T0-04: what the writer will be shown travels with the immutable package.
    ...(input.rules !== undefined ? { rules: structuredClone(input.rules) } : {}),
    ...(input.references !== undefined ? { references: structuredClone(input.references) } : {}),
    ...(input.test !== undefined ? { test: structuredClone(input.test) } : {}),
    ...(input.task_file !== undefined ? { task_file: input.task_file } : {}),
    // The contract the yes covered: code cut it from the work order when the plan was made.
    ...(input.contract_sha256 ? { contract_sha256: input.contract_sha256 } : {}),
    // The priority this work runs at, and each role's model and effort, as the plan settled them.
    ...(input.priority ? { priority: input.priority, writer: structuredClone(input.writer), reviewer: structuredClone(input.reviewer) } : {}),
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
  // The sealed work-order text the person said yes to (start's card shows it line by line).
  workOrderSha256 = null,
  workPackageSha256,
  policySha256,
  ttl,
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
    expires_at: plusMs(authorizedAt, ttl),
    work_package_sha256: workPackageSha256,
    effective_policy_sha256: policySha256,
  };
  if (workOrderSha256) record.work_order_sha256 = workOrderSha256;
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
    writer_session_id: assertId(sessionId, "Session id"),
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
        || existing.writer_session_id !== claim.writer_session_id
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
  // One reading of the clock for the run's start: its deadlines are counted from the moment it records as
  // its creation (three readings left timeout_at a millisecond short of run_timeout, Windows 2026-11-09).
  const startedAt = nowIso(clock);
  const run = {
    schema_version: 4,
    run_id: claim.run_id,
    work_package_sha256: authorization.work_package_sha256,
    authorization_ids: [authorization.authorization_id],
    effective_policy_sha256: authorization.effective_policy_sha256,
    policy_schema_version: snapshot.policy_schema_version,
    package_default_policy_sha256: snapshot.package_default_policy_sha256,
    writer_session_id: assertId(sessionId, "Session id"),
    authorized_by: authorization.authorized_by,
    authorized_via: authorization.authorized_via || null,
    status: "in_progress",
    transition_sequence: 0,
    iteration: 0,
    execution_mode: executionMode,
    budget: { ...structuredClone(workPackage.budget), consumed_rounds: 0 },
    recovery_window: snapshot.effective_policy.limits.recovery_window,
    run_deadline_at: plusMs(startedAt, snapshot.effective_policy.limits.recovery_window),
    // The run's own time limit, counted from its start; checked where the run already checks for a stop.
    timeout_at: workPackage.budget.run_timeout ? plusMs(startedAt, workPackage.budget.run_timeout) : null,
    workspace_evidence: workspaceEvidence,
    last_state: null,
    created_at: startedAt,
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

// `databaseGone`, `locked`: as reconcileRunProjection.
export async function readRun(paths, runId, options) {
  return await reconcileRunProjection(paths, runId, options);
}

// With records, the project's runs come from the database: one page of them, newest first
// (projectRuns; `limit` and `after` as there), or every running one (activeRuns). Each is its row
// there (its id, status and what that query selects), not its run.json. When the database cannot be
// reached, and in a process that keeps no records, every run.json, as before.
export async function listRuns(paths, { activeOnly = false, limit = 10, after = null } = {}) {
  const database = recordsDatabase();
  const projectId = database ? (await readOptional(paths.bridgeConfigPath))?.project_id : null;
  if (projectId) {
    try {
      const db = await database();
      return activeOnly ? await activeRuns(db, projectId) : (await projectRuns(db, projectId, { limit, after })).runs;
    } catch (error) {
      if (!(error instanceof DatabaseUnavailableError)) throw error;
    }
  }
  const files = await listJson(paths.runsDir);
  const runs = await Promise.all(files.map((file) => readJson(file)));
  return activeOnly ? runs.filter(isActiveRun) : runs;
}

// The run's files say they are further on than the database: events the database never took. The
// database is the record (DECISIONS 2026-11-03, B), so they are not used. `kind` is the event file's:
// "state event", or "I/O event" for the I/O event file.
export class RunFilesAheadError extends Error {
  constructor(runId, fileSequence, recordedSequence, file, kind = "state event") {
    super("Run " + runId + ": its files are at " + kind + " " + fileSequence + " but Bridge's database is at " + recordedSequence
      + "; event" + (fileSequence - recordedSequence > 1 ? "s " + (recordedSequence + 1) + " to " + fileSequence + " are" : " " + fileSequence + " is")
      + " only in the files (" + file + "). The database is the record, so Bridge does not use them.");
    this.name = "RunFilesAheadError";
  }
}

// The run as its files have it, checked against each other: the event file's last line, with
// run.json brought up to it. An archived terminal run has had its event log folded into the day file
// (T0-02); its projection is final and is served as-is.
async function fileProjection(paths, runId) {
  const archived = await readOptional(runFile(paths, runId));
  if (archived?.archived_at && !(await fileExists(eventFile(paths, runId)))) return archived;
  const latest = (await fileEvents(paths, runId)).at(-1).projection;
  const current = await readOptional(runFile(paths, runId));
  if (!current || current.last_event_sequence < latest.last_event_sequence) {
    await writeJsonAtomicDurable(runFile(paths, runId), latest);
  } else if (current.last_event_sequence > latest.last_event_sequence) {
    throw new Error("Run projection is ahead of durable events.");
  }
  return latest;
}

// Sequences only grow: the database numbers a run's state events and I/O events in one sequence, so
// a state event file has gaps where the I/O events are.
async function fileEvents(paths, runId) {
  const source = await fsp.readFile(eventFile(paths, runId), "utf8");
  const lines = source.split("\n");
  if (lines.at(-1) !== "") throw new Error("Event log has a partial tail.");
  const events = lines.slice(0, -1).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error("Event log is malformed at line " + (index + 1) + "."); }
  });
  for (const [index, event] of events.entries()) {
    if (!Number.isInteger(event.sequence) || event.sequence <= (events[index - 1]?.sequence ?? 0) || event.run_id !== runId) throw new Error("Event sequence is invalid.");
  }
  if (!events.length) throw new Error("Run has no event history.");
  return events;
}

// The run lock, for a write of the run's files by a caller that does not hold it; null when another
// process holds it.
export async function tryRunLock(paths, runId) {
  try {
    const { snapshot } = await loadOrCreatePolicySnapshot(paths);
    return await acquireRunLock(paths, runId, snapshot.effective_policy, { allowReconcile: false });
  } catch {
    return null;
  }
}

// `write` under the run lock (`locked`: the caller holds it). Without it nothing is written: the
// next step that holds the lock brings the files up.
export async function writeUnderRunLock(paths, runId, locked, write) {
  if (locked) return await write();
  const lease = await tryRunLock(paths, runId);
  if (!lease) return;
  try {
    await write();
  } finally {
    await lease.release();
  }
}

const eventText = (records) => records.map((record) => eventLine(record) + "\n").join("");

// Where the state event file stands: the sequence of its last line, read from the file's end, and the
// run that line left; null when the file is missing or its last line is torn or unreadable. An
// archived run's event file was folded away on purpose; its run.json stands for it.
async function stateFilePosition(paths, runId) {
  const run = await readOptional(runFile(paths, runId)).catch(() => null);
  const tail = await readLastLine(eventFile(paths, runId));
  if (!tail && run?.archived_at) return { run, position: run.last_event_sequence, latest: run, archived: true };
  let line = null;
  try { line = tail && !tail.torn ? JSON.parse(tail.line) : null; } catch { /* unreadable: written again */ }
  if (!line || line.run_id !== runId || !Number.isInteger(line.sequence) || !line.projection) return { run, position: null, latest: null };
  return { run, position: line.sequence, latest: line.projection };
}

// DECISIONS 2026-11-03 (B): the database is the run's record; run.json and the event file are its
// copy, kept by position the way a Temporal worker keeps its sticky history and a Kafka consumer its
// offset. A read asks the database for the run's last sequence (one query by primary key) and reads
// the event file's last line:
// - the same sequence: the file is used as it is;
// - behind: only the state events after the file's last line are asked for and appended (none means
//   the events since are I/O events, and the file is used);
// - missing, torn or unreadable: every state event is asked for and the file written again whole;
// - ahead: the events kept while the database was gone are written to it first; still ahead is
//   refused.
// run.json follows the event file's last line.
//
// `databaseGone` is what a read does when the database cannot be reached: "files" uses them
// unchecked, for closing a run (stop, a terminal state) and delivering it; "refuse" throws, for
// anything that would carry the run on (resume, a new state). `locked`: the caller holds the run lock;
// otherwise the files are written only when the lock can be taken, and the database's run is returned
// either way. A process that keeps no records, a run the database does not know, and one with state
// events from before they kept their line are read from their files, as before.
export async function reconcileRunProjection(paths, runId, { databaseGone = "files", locked = false } = {}) {
  const database = recordsDatabase();
  if (!database) return await fileProjection(paths, runId);
  let db;
  let last;
  try {
    db = await database();
    last = await lastEventSequence(db, runId);
  } catch (error) {
    if (!(error instanceof DatabaseUnavailableError) || databaseGone === "refuse") throw error;
    return await fileProjection(paths, runId);
  }
  if (last === null) return await fileProjection(paths, runId);
  let files = await stateFilePosition(paths, runId);
  const fileSequence = () => Math.max(files.run?.last_event_sequence ?? 0, files.position ?? 0);
  if (fileSequence() > last && await replayUnrecorded(db, paths, { rebuild: (id) => rebuildRunFiles(paths, id, db) })) {
    last = await lastEventSequence(db, runId);
    files = await stateFilePosition(paths, runId);
  }
  if (fileSequence() > last) {
    throw new RunFilesAheadError(runId, fileSequence(), last, files.position === fileSequence() ? eventFile(paths, runId) : runFile(paths, runId));
  }
  let records = files.position === last ? [] : await eventRecordsAfter(db, runId, files.position ?? 0, true);
  if (records === null) return await fileProjection(paths, runId);
  if (files.position !== null && !records.length) {
    if (files.archived) return files.run;
    if (files.run?.last_event_sequence !== files.position) await writeUnderRunLock(paths, runId, locked, () => writeJsonAtomicDurable(runFile(paths, runId), files.latest));
    return files.latest;
  }
  // An archived run whose folded events were followed by more is written again whole.
  if (files.archived) records = await eventRecordsAfter(db, runId, 0, true);
  if (!records?.length) throw new Error("Run " + runId + ": Bridge's database holds none of its state events, so its files cannot be written again.");
  const latest = records.at(-1).projection;
  await writeUnderRunLock(paths, runId, locked, async () => {
    if (files.position === null || files.archived) await writeTextAtomicDurable(eventFile(paths, runId), eventText(records));
    else await appendTextDurable(eventFile(paths, runId), eventText(records));
    await writeJsonAtomicDurable(runFile(paths, runId), latest);
  });
  return latest;
}

// Every file of a run written again whole from the database: the events this machine kept while the
// database was gone did not follow it (replayUnrecorded), so the lines numbered then are not the
// database's. Under the run lock; when another process holds it this throws, and the next command
// that opens the database tries again.
export async function rebuildRunFiles(paths, runId, db) {
  const { ioEventFile } = await import("./ioEvents.mjs");
  const lease = await tryRunLock(paths, runId);
  if (!lease) throw new Error("Run " + runId + " is held by another process; its files are written again from Bridge's database by the next command.");
  try {
    const states = await eventRecordsAfter(db, runId, 0, true);
    const io = await eventRecordsAfter(db, runId, 0, false);
    if (!states?.length || io === null) throw new Error("Run " + runId + ": Bridge's database does not hold every line of it, so its files cannot be written again.");
    await writeTextAtomicDurable(eventFile(paths, runId), eventText(states));
    await writeJsonAtomicDurable(runFile(paths, runId), states.at(-1).projection);
    await writeTextAtomicDurable(ioEventFile(paths, runId), eventText(io));
  } finally {
    await lease.release();
  }
}

// A mutator that returns null leaves the run as it is: no event, no new projection. Without the
// database only a step that closes the run (databaseGone: "files") goes on, from the files.
async function mutateRun(paths, runId, type, details, mutator, { substantive = true, clock = Date.now, duringMaintenance = false, databaseGone = "refuse" } = {}) {
  const { snapshot } = await loadOrCreatePolicySnapshot(paths);
  return await withRunLock(paths, runId, snapshot.effective_policy, async (lease) => {
    await lease.assertOwner();
    const current = await reconcileRunProjection(paths, runId, { databaseGone, locked: true });
    const next = await mutator(structuredClone(current));
    if (next === null) return current;
    await lease.assertOwner();
    return await appendProjectionEvent(paths, current, next, type, details, clock, substantive, { closing: databaseGone === "files" });
  }, { duringMaintenance });
}

// T0-07 V2.7: delivery has its own locked path. Inside the lease: a run that already has a
// result returns at once with no event and no file written; otherwise `build` writes the
// result files and exactly one `run_delivered` projection event records them.
export async function deliverRun(paths, runId, build, { clock = Date.now } = {}) {
  const { snapshot } = await loadOrCreatePolicySnapshot(paths);
  return await withRunLock(paths, runId, snapshot.effective_policy, async (lease) => {
    await lease.assertOwner();
    const current = await reconcileRunProjection(paths, runId, { databaseGone: "files", locked: true });
    if (current.result_sha256) return { already: true, run: current };
    if (current.status !== "completed") throw new Error("Run is still active: " + runId);
    const written = await build(structuredClone(current));
    await lease.assertOwner();
    const next = {
      ...current,
      result_path: written.result_path,
      latest_result_path: written.latest_path,
      latest_result_written: written.latest_written !== false,
      result_sha256: written.sha256,
    };
    const projected = await appendProjectionEvent(paths, current, next, "run_delivered", {
      result_path: written.result_path, sha256: written.sha256,
    }, clock, false, { closing: true });
    return { already: false, run: projected };
  });
}

// Closing a run: whoever closes it first wins. A run with closed_at keeps its status, reason and
// time; a PASS that arrives after a stop is refused, and a stop that arrives after a PASS (even one
// not yet closed) is refused, so the PASS can still close normally. Decided inside the run lock.
export class RunClosedError extends Error {
  constructor(runId) {
    super("Run " + runId + " is already closed.");
    this.name = "RunClosedError";
  }
}

// `reason` is the closed run's closed_reason, or the state a settled run is closing with.
export class RunEndedError extends Error {
  constructor(reason) {
    super("The run has already ended: " + reason + ".");
    this.name = "RunEndedError";
    this.reason = reason;
  }
}

// `closedReason` is "stopped" for the stop command and "superseded" when the work order is started
// again; the conclusion is "cancelled" either way. `supersededBy`, the new start's run id, is written in
// the same locked step, so whoever delivers the stopped run can name it.
export async function stopRunRecord(paths, runId, { closedReason = "stopped", supersededBy = null, ...options } = {}) {
  const details = { reason: closedReason, gate: null, ...(supersededBy ? { superseded_by: supersededBy } : {}) };
  return await mutateRun(paths, runId, "run_terminal", details, (run) => {
    if (run.closed_at || run.status === "completed" || settledState(run)) throw new RunEndedError(run.closed_reason || settledState(run));
    run.status = "completed";
    run.conclusion = closedReason === "run_timeout" ? "timed_out" : "cancelled";
    run.closed_reason = closedReason;
    if (supersededBy) run.superseded_by = supersededBy;
    run.closed_at = nowIso(options.clock || Date.now);
    run.review_gate = null;
    return run;
  }, { databaseGone: "files", ...options });
}

export async function recordRunState(paths, runId, state, options = {}) {
  return await mutateRun(paths, runId, "state_recorded", { status: state.status }, (run) => {
    if (run.closed_at) throw new RunClosedError(runId);
    run.last_state = structuredClone(state);
    // T0-06 G3.7: both halves of PASS are kept on the run, not only the reviewer's.
    if (typeof state.test_passed === "boolean" || state.test_passed === null) run.test_passed = state.test_passed;
    return run;
  }, options);
}

export async function consumeRun(paths, runId, reason, gate = null, options = {}) {
  return await mutateRun(paths, runId, "run_terminal", { reason, gate }, (run) => {
    // Already closed (by a stop, or an earlier close): its conclusion and reason stand.
    if (run.closed_at) return null;
    run.status = "completed";
    run.conclusion = conclusionOf(run, reason, gate);
    run.closed_reason = reason;
    run.closed_at = nowIso(options.clock || Date.now);
    run.review_gate = gate || null;
    return run;
  }, { databaseGone: "files", ...options });
}

// The run's contract is fixed once; a second, different hash for the same run is refused.
export async function recordRunContract(paths, runId, sha256, options = {}) {
  return await mutateRun(paths, runId, "contract_sealed", { contract_sha256: sha256 }, (run) => {
    if (run.contract_sha256 && run.contract_sha256 !== sha256) throw new Error("Run already has a different contract.");
    run.contract_sha256 = sha256;
    return run;
  }, options);
}

// T0-04 D2.1: every writer call runs in a fresh session; the run records each one.
export async function rotateRunSession(paths, runId, sessionId, options = {}) {
  return await mutateRun(paths, runId, "session_rotated", { session_id: sessionId }, (run) => {
    const history = Array.isArray(run.writer_session_ids) ? run.writer_session_ids : [run.writer_session_id];
    run.writer_session_ids = [...history, assertId(sessionId, "Session id")];
    run.writer_session_id = assertId(sessionId, "Session id");
    return run;
  }, { ...options, substantive: false });
}

export async function incrementRunIteration(paths, runId, options = {}) {
  return await mutateRun(paths, runId, "iteration_incremented", {}, (run) => {
    run.iteration = Number(run.iteration || 0) + 1;
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
    const run = await reconcileRunProjection(paths, authorization.run_id, { databaseGone: "refuse", locked: true });
    if (!isActiveRun(run)) throw new Error("Budget extension requires an active run.");
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
    const addedCalls = Number(authorization.additional_budget?.rounds || 0);
    const nextCalls = Number(run.budget.rounds) + addedCalls;
    if (!Number.isInteger(addedCalls) || addedCalls < 1
        || nextCalls > snapshot.effective_policy.limits.rounds) {
      throw new Error("Budget extension exceeds the effective policy ceiling.");
    }
    if (!existingClaim) await writeJsonExclusiveDurable(claimFile(paths, authorization.authorization_id), claim);
    await lease.assertOwner();
    run.authorization_ids.push(authorization.authorization_id);
    run.budget.rounds = nextCalls;
    return await appendProjectionEvent(paths, await readRun(paths, run.run_id, { databaseGone: "refuse", locked: true }), run, "budget_extended", {
      authorization_id: authorization.authorization_id,
      added_calls: addedCalls,
    }, clock);
  }, options);
}

export async function loadControlView(paths, runId, options) {
  const run = await reconcileRunProjection(paths, runId, options);
  const workPackage = await findWorkPackageBySha(paths, run.work_package_sha256);
  const authorization = await readJson(authorizationFile(paths, run.authorization_ids[0]));
  const snapshot = await readJson(path.join(paths.policySnapshotsDir, run.effective_policy_sha256 + ".json"));
  const policy = snapshot.effective_policy;
  return {
    schema_version: 4,
    authorization_status: isActiveRun(run) ? "active" : "consumed",
    mode: "bounded_standing_correction",
    work_package: workPackage.work_package_id,
    authorized_by: authorization.authorized_by,
    authorized_at: authorization.authorized_at,
    authorization_plan_sha256: authorization.authorization_sha256,
    breakpoint: workPackage.breakpoint,
    execution_mode: run.execution_mode,
    authorized_scope: structuredClone(workPackage.scope),
    workspace_evidence: run.workspace_evidence,
    active_writer_session: run.writer_session_id,
    iteration: run.iteration,
    dispatch_transport: "writer_cli_resume_same_session",
    // The plan settled the priority and each role's model and effort for this work order.
    reviewer_policy: workPackage.priority
      ? { priority: workPackage.priority, model: workPackage.reviewer.model, effort: workPackage.reviewer.effort }
      : reviewerPolicyFromSnapshot(snapshot),
    token_policy: {
      writer_disallowed_tools: structuredClone(policy.writer.disallowed_tools),
      writer_mode: policy.writer.mode,
      writer_effort: workPackage.priority ? workPackage.writer.effort : priorityChoice(policy).writer.effort,
      writer_self_review: policy.writer.self_review,
      full_reconstruction_on_correction: false,
      full_reconstruction_requires_human: true,
      rounds_per_resume: run.budget.rounds,
      call_timeout: run.budget.call_timeout,
    },
    run: { run_id: run.run_id, policy_snapshot: snapshot, work_package: workPackage, contract_sha256: run.contract_sha256 || null },
  };
}

export async function loadSingleActiveControlView(paths) {
  const runs = await listRuns(paths, { activeOnly: true });
  if (runs.length !== 1) throw new Error("Expected exactly one active run.");
  return await loadControlView(paths, runs[0].run_id);
}

export async function assertRunResumable(paths, runId, { clock = Date.now } = {}) {
  if (await fileExists(paths.upgradeMarkerPath)) throw new Error("Runtime upgrade is in progress.");
  const run = await reconcileRunProjection(paths, runId, { databaseGone: "refuse" });
  if (!isActiveRun(run)) throw new Error("Terminal run cannot resume.");
  assertCurrentPolicy(run.policy_schema_version, runId);
  if (Date.parse(run.run_deadline_at) <= clock()) throw new Error("Run recovery deadline is expired.");
  if (Number(run.budget.consumed_rounds || 0) >= Number(run.budget.rounds || 0)) {
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
    async recordContract(sha256) {
      return await recordRunContract(paths, runId, sha256);
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

// T0-10: the policy identity an unclaimed authorization must still match after an upgrade.
export function policyIdentity(defaults) {
  return { policy_schema_version: defaults.policy_schema_version, package_default_policy_sha256: digest(defaults) };
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
