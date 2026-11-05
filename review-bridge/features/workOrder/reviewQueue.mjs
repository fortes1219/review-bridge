import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { assertUnder, samePath } from "../../utils/pathGuard.mjs";
import { ensureDir, fileExists, listJson, readJson, writeJsonAtomic } from "../../service/index.mjs";
import { timestampId } from "../../utils/dates.mjs";
import { createWorkspaceDelta } from "./workspaceEvidence.mjs";

export function validateHookPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { valid: false, invalid_fields: ["payload"] };
  }
  const invalidFields = [];
  if (typeof payload.session_id !== "string" || !payload.session_id.trim()) {
    invalidFields.push("session_id");
  }
  if (typeof payload.cwd !== "string" || !payload.cwd.trim()) {
    invalidFields.push("cwd");
  }
  if (typeof payload.last_assistant_message !== "string") {
    invalidFields.push("last_assistant_message");
  }
  if (typeof payload.stop_hook_active !== "boolean") {
    invalidFields.push("stop_hook_active");
  }
  return { valid: invalidFields.length === 0, invalid_fields: invalidFields };
}

export async function enqueueReview({
  payload,
  paths,
  control,
  writerResult = null,
  call = null,
  openFindings = [],
  testResult = null,
  workVersion = null,
  sealedEvidence = null,
}) {
  const shape = validateHookPayload(payload);
  if (!shape.valid) {
    return { accepted: false, reason: "invalid_payload", invalid_fields: shape.invalid_fields };
  }
  if (payload.stop_hook_active === true) {
    return { accepted: false, reason: "stop_hook_active" };
  }
  if (!samePath(payload.cwd, paths.repoRoot)) {
    return { accepted: false, reason: "cwd_mismatch" };
  }
  if (control.authorization_status !== "active") {
    return { accepted: false, reason: "authorization_inactive" };
  }
  if (String(payload.session_id) !== String(control.active_writer_session || "")) {
    return { accepted: false, reason: "session_mismatch" };
  }
  const message = payload.last_assistant_message;
  if (!message.trim()) return { accepted: false, reason: "empty_message" };
  // T0-05 D1.6: a run is driven by the harness; only its typed writer result is a submission.
  if (!writerResult) return { accepted: false, reason: "harness_driven" };

  // The reviewer's priority and effort come from the policy's table, never from the work order's words.
  const policy = { priority: control.reviewer_policy?.priority, reasoning_effort: control.reviewer_policy?.effort };
  const sessionId = String(payload.session_id || "");
  const hash = createHash("sha256").update(sessionId + "\n" + message, "utf8").digest("hex");
  const shortHash = hash.slice(0, 16);

  for (const directory of [paths.pendingDir, paths.runningDir, paths.doneDir]) {
    const jobs = await listJson(directory);
    if (jobs.some((file) => path.basename(file).endsWith("-" + shortHash + ".json"))) {
      return { accepted: true, duplicate: true, message_hash: shortHash };
    }
  }
  await ensureDir(paths.pendingDir);
  if (!control.workspace_evidence?.baseline_path) {
    throw new Error("Active work package has no workspace evidence baseline.");
  }
  const workspaceEvidence = await createWorkspaceDelta({
    paths,
    baselinePath: control.workspace_evidence.baseline_path,
    deltaId: shortHash,
    sealed: sealedEvidence,
  });
  const jobId = timestampId() + "-" + shortHash;
  const jobPath = assertUnder(path.join(paths.pendingDir, jobId + ".json"), paths.stateRoot, "Queue job");
  const job = {
    schema_version: 4,
    job_id: jobId,
    session_id: sessionId,
    cwd: paths.repoRoot,
    enqueued_at: new Date().toISOString(),
    message_sha256: hash,
    trigger: "writer_result",
    call,
    writer_result: writerResult,
    open_findings: openFindings,
    test_result: testResult,
    // The version of the work the reviewer reads (RC3-BLOCKER-00).
    work_version: workVersion,
    authorization: {
      plan_sha256: control.authorization_plan_sha256 || null,
      work_package: control.work_package || null,
      authorized_by: control.authorized_by || null,
      breakpoint: control.breakpoint || null,
      scope: control.authorized_scope || null,
      execution_mode: control.execution_mode || "native",
      run_id: control.run?.run_id || null,
      effective_policy_sha256: control.run?.policy_snapshot?.effective_policy_sha256 || null,
    },
    workspace_evidence: workspaceEvidence,
    ...policy,
    last_assistant_message: message,
  };
  await writeJsonAtomic(jobPath, job);
  return { accepted: true, duplicate: false, job, jobPath };
}

export async function queueStatus(paths) {
  const counts = {};
  for (const [state, directory] of Object.entries({
    pending: paths.pendingDir,
    running: paths.runningDir,
    done: paths.doneDir,
    failed: paths.failedDir,
  })) {
    counts[state] = (await listJson(directory)).length;
  }

  let latestReview = null;
  if (await fileExists(paths.latestPath)) {
    latestReview = (await fsp.readFile(paths.latestPath, "utf8")).trim();
  }
  let latestPriority = null;
  let latestReasoningEffort = null;
  const done = await listJson(paths.doneDir);
  if (done.length) {
    const latest = await readJson(done.at(-1));
    latestPriority = latest.priority || "LEGACY_UNRECORDED";
    latestReasoningEffort = latest.reasoning_effort || "LEGACY_UNRECORDED";
  }
  return {
    ...counts,
    latest_review: latestReview,
    latest_priority: latestPriority,
    latest_reasoning_effort: latestReasoningEffort,
  };
}

export async function hasPendingMessageHash(paths, messageHash) {
  if (!/^[0-9a-f]{16}$/.test(String(messageHash))) return false;
  const suffix = "-" + messageHash + ".json";
  const jobs = await listJson(paths.pendingDir);
  return jobs.some((file) => path.basename(file).endsWith(suffix));
}

export async function waitForPending(paths, timeout = 7_200_000) {
  const deadline = Date.now() + timeout;
  await ensureDir(paths.pendingDir);
  while (Date.now() < deadline) {
    const jobs = await listJson(paths.pendingDir);
    if (jobs.length) return jobs[0];
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("No writer review submission arrived within " + timeout + " ms.");
}
