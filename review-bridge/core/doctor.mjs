import fsp from "node:fs/promises";
import path from "node:path";

import { fileExists, listJson, readJson } from "./io.mjs";
import { validateClassificationProfile } from "./policy.mjs";
import {
  classificationProfileFromSnapshot,
  codexPolicyFromSnapshot,
  loadOrCreatePolicySnapshot,
} from "./policy-v4.mjs";
import { listRuns } from "./state-v4.mjs";
import { inspectStateFilesystem } from "./filesystem-v4.mjs";

async function readOptionalJson(file) {
  if (!(await fileExists(file))) return null;
  return await readJson(file);
}

async function inspectLock(file) {
  if (!(await fileExists(file))) {
    return { present: false, status: "clear" };
  }
  try {
    const metadata = await readJson(file);
    const pid = Number(metadata.pid);
    if (!Number.isInteger(pid) || pid < 1) {
      return { present: true, status: "invalid_metadata" };
    }
    try {
      process.kill(pid, 0);
      return { present: true, status: "held", pid, started_at: metadata.started_at || null };
    } catch (error) {
      if (error.code === "ESRCH") {
        return { present: true, status: "stale", pid, started_at: metadata.started_at || null };
      }
      if (error.code === "EPERM") {
        return { present: true, status: "held_unverifiable", pid, started_at: metadata.started_at || null };
      }
      return { present: true, status: "probe_failed", pid, error: error.code || error.message };
    }
  } catch (error) {
    return { present: true, status: "invalid_metadata", error: error.message };
  }
}

async function listLegacyWarnings(paths) {
  const warnings = [];
  const currentLocks = new Set([
    path.basename(paths.workerLockPath),
    path.basename(paths.boundedLockPath),
  ]);
  try {
    const rootEntries = await fsp.readdir(paths.queueRoot, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (entry.isFile() && entry.name.endsWith(".lock") && !currentLocks.has(entry.name)) {
        warnings.push("legacy lock: " + entry.name);
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const [state, directory] of Object.entries({
    pending: paths.pendingDir,
    running: paths.runningDir,
    done: paths.doneDir,
    failed: paths.failedDir,
  })) {
    try {
      const entries = await fsp.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && !entry.name.endsWith(".json")) {
          warnings.push("non-json " + state + " artifact: " + entry.name);
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return warnings;
}

export async function inspectDoctor({ paths, adapter, manifest, nodeVersion = process.version }) {
  if (await fileExists(paths.bridgeConfigPath)) {
    const bridgeConfig = await readJson(paths.bridgeConfigPath);
    const neutralLayout = path.basename(paths.privateRoot) === ".review-bridge";
    const { snapshot } = await loadOrCreatePolicySnapshot(paths);
    const profile = classificationProfileFromSnapshot(snapshot);
    const control = { codex_policy: codexPolicyFromSnapshot(snapshot) };
    let profileValid = true;
    let profileError = null;
    try {
      validateClassificationProfile(profile, control);
    } catch (error) {
      profileValid = false;
      profileError = error.message;
    }
    const runs = await listRuns(paths);
    const active = runs.filter((run) => ["running", "review_pending", "correction_pending", "interrupted"].includes(run.status));
    const queue = {};
    for (const [state, directory] of Object.entries({
      pending: paths.pendingDir, running: paths.runningDir, done: paths.doneDir, failed: paths.failedDir,
    })) queue[state] = (await listJson(directory)).length;
    return {
      valid: profileValid,
      state_contract: "v4",
      native_readiness: neutralLayout ? {
        ready: false,
        roles: bridgeConfig.roles || null,
        // doctor is a separate process: it cannot attest a proof held in watch memory
        // and never reads the editable audit file or a stored Boolean as proof.
        reviewer_readonly_proven: "not_run",
        reviewer_readonly_authority: "watch_session_only",
        reason: "Stage 2 UV-backed authorization is not installed yet.",
      } : null,
      state_filesystem: inspectStateFilesystem(paths.repoRoot),
      platform: {
        target: adapter.target,
        adapter: adapter.id,
        commands: manifest.commands,
        node: nodeVersion,
      },
      authorization: {
        schema_version: 4,
        status: active.length ? "active" : "inactive",
        active_run_count: active.length,
      },
      classification: {
        expected_profile: profile.profile_id,
        loaded_profile: profile.profile_id,
        valid: profileValid,
        error: profileError,
        effective_policy_sha256: snapshot.effective_policy_sha256,
      },
      queue,
      warnings: active.length ? [] : ["no active run; create and authorize a work package to begin"],
      bounded_resume_ready: active.length === 1 && queue.pending === 0 && queue.running === 0,
    };
  }
  const control = await readJson(paths.controlPath);
  const profile = await readOptionalJson(paths.classificationProfilePath);
  let profileValid = true;
  let profileError = null;
  try {
    validateClassificationProfile(profile, control);
  } catch (error) {
    profileValid = false;
    profileError = error.message;
  }
  const boundedState = await readOptionalJson(paths.boundedStatePath);
  const queue = {};
  for (const [state, directory] of Object.entries({
    pending: paths.pendingDir,
    running: paths.runningDir,
    done: paths.doneDir,
    failed: paths.failedDir,
  })) {
    queue[state] = (await listJson(directory)).length;
  }
  const locks = {
    worker: await inspectLock(paths.workerLockPath),
    bounded_resume: await inspectLock(paths.boundedLockPath),
  };
  const authorizedAt = Date.parse(control.authorized_at);
  const legacyWarnings = await listLegacyWarnings(paths);
  const warnings = [];
  if (control.authorization_status !== "active") {
    warnings.push("standing authorization is not active; the human owner must issue a new authorization");
  }
  if (!profileValid) warnings.push("classification profile is invalid");
  const lockReady = Object.values(locks).every((lock) => lock.status === "clear");
  return {
    valid: true,
    platform: {
      target: adapter.target,
      adapter: adapter.id,
      commands: manifest.commands,
      node: nodeVersion,
    },
    authorization: {
      schema_version: control.schema_version,
      work_package: control.work_package,
      status: control.authorization_status || "missing",
      authorized_at: control.authorized_at || null,
      age_seconds: Number.isFinite(authorizedAt)
        ? Math.max(0, Math.floor((Date.now() - authorizedAt) / 1000))
        : null,
      breakpoint: control.breakpoint || null,
      closed_at: control.closed_at || null,
      closed_reason: control.closed_reason || null,
    },
    classification: {
      expected_profile: control.codex_policy?.classification_profile || null,
      loaded_profile: profile?.profile_id || null,
      valid: profileValid,
      error: profileError,
    },
    bounded_resume_state: boundedState
      ? {
          status: boundedState.status || null,
          updated_at: boundedState.updated_at || null,
          review_gate: boundedState.review_gate || null,
          hard_stop_required: boundedState.hard_stop_required ?? null,
        }
      : null,
    queue,
    locks,
    warnings,
    legacy_warnings: legacyWarnings,
    bounded_resume_ready: control.authorization_status === "active"
      && profileValid
      && queue.pending === 0
      && queue.running === 0
      && lockReady,
  };
}
