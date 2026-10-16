import path from "node:path";

import { fileExists, listJson, listRuns, loadOrCreatePolicySnapshot, readJson } from "../../service/index.mjs";
import { validateClassificationProfile } from "../../policy/policyChecks.mjs";
import { classificationProfileFromSnapshot, codexPolicyFromSnapshot } from "../../policy/policyRules.mjs";
import { inspectStateFilesystem } from "../../utils/filesystem.mjs";

export async function inspectDoctor({ paths, adapter, manifest, nodeVersion = process.version }) {
  if (!(await fileExists(paths.bridgeConfigPath))) {
    throw new Error("doctor requires the v4 runtime configuration created by init.");
  }
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
      reason: "Native work-start needs an interactive terminal confirmation and a reviewer read-only check passed in the running Bridge page; doctor cannot see that proof.",
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
