import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  assertUnder,
  ensureDir,
  fileExists,
  listJson,
  readJson,
  samePath,
  timestampId,
  writeJsonAtomic,
} from "./io.mjs";
import { appendArchiveLine } from "./retention.mjs";
import { classifyReview } from "./policy.mjs";
import { createWorkspaceDelta } from "./workspace-evidence.mjs";

export function detectMarker(message) {
  const explicit = /^\s*CODEX_REVIEW_REQUIRED\s*:\s*true\s*$/im.test(message);
  const legacyHeader = /^\s*\[\s*Claude\s*(?:->|\u2192)\s*Codex[^\]]*\]/im.test(message);
  const reviewWords = /(submit|handoff|report|review|re-review|Codex review|\u4ea4\u4ed8|\u56de\u5831|\u5be9\u67e5|\u4fee\u6b63)/i;
  const handoffPattern = /^\s*\u53efhandoff\u7d66codex\s*:/im;
  const handoffLabel = handoffPattern.test(message);
  const handoffBody = message.replace(handoffPattern, "");
  return {
    explicit,
    legacy: legacyHeader && reviewWords.test(message),
    handoff: handoffLabel && reviewWords.test(handoffBody),
  };
}

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

// T0-05 D2.4: the classifier reads the work text and the writer's typed claims, not prose.
function classificationText(control, writerResult) {
  const order = control.v4?.work_package?.work_order;
  const work = order ? order.work : control.v4?.work_package?.task || "";
  const claims = (writerResult.changed || []).map((entry) => entry.path + " " + entry.summary);
  return [work, ...claims].join("\n");
}

export async function enqueueReview({
  payload,
  paths,
  control,
  classificationProfile = null,
  validateOnly = false,
  writerResult = null,
  call = null,
  openFindings = [],
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
  if (String(payload.session_id) !== String(control.active_claude_session || "")) {
    return { accepted: false, reason: "session_mismatch" };
  }
  const message = payload.last_assistant_message;
  if (!message.trim()) return { accepted: false, reason: "empty_message" };
  // T0-05 D1.6: a v4 run is driven by the harness; a Stop-hook message is not a submission.
  if (control.v4 && !writerResult) return { accepted: false, reason: "harness_driven" };
  const marker = writerResult
    ? { explicit: false, legacy: false, handoff: false, typed: true }
    : { ...detectMarker(message), typed: false };
  if (!marker.typed && !marker.explicit && !marker.legacy && !marker.handoff) {
    return { accepted: false, reason: "no_review_marker" };
  }

  const profile = classificationProfile || await readJson(paths.classificationProfilePath);
  const policy = classifyReview(writerResult ? classificationText(control, writerResult) : message, control, profile);
  const sessionId = String(payload.session_id || "");
  const hash = createHash("sha256").update(sessionId + "\n" + message, "utf8").digest("hex");
  const shortHash = hash.slice(0, 16);
  const validation = {
    accepted: true,
    explicit_marker: marker.explicit,
    legacy_marker: marker.legacy,
    handoff_marker: marker.handoff,
    repo_root: paths.repoRoot,
    message_hash: shortHash,
    ...policy,
  };
  if (validateOnly) return validation;

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
  });
  const jobId = timestampId() + "-" + shortHash;
  const jobPath = assertUnder(path.join(paths.pendingDir, jobId + ".json"), paths.queueRoot, "Queue job");
  const job = {
    schema_version: control.schema_version === 4 ? 4 : 2,
    job_id: jobId,
    session_id: sessionId,
    cwd: paths.repoRoot,
    enqueued_at: new Date().toISOString(),
    message_sha256: hash,
    trigger: marker.typed ? "writer_result" : marker.explicit ? "explicit-marker" : marker.handoff ? "handoff-label" : "legacy-report-marker",
    ...(writerResult ? { call, writer_result: writerResult, open_findings: openFindings } : {}),
    authorization: {
      plan_sha256: control.authorization_plan_sha256 || null,
      work_package: control.work_package || null,
      authorized_by: control.authorized_by || null,
      breakpoint: control.breakpoint || null,
      scope: control.authorized_scope || null,
      execution_mode: control.execution_mode || "native",
      run_id: control.v4?.run_id || null,
      effective_policy_sha256: control.v4?.policy_snapshot?.effective_policy_sha256 || null,
    },
    workspace_evidence: workspaceEvidence,
    ...policy,
    last_assistant_message: message,
  };
  await writeJsonAtomic(jobPath, job);
  return { accepted: true, duplicate: false, job, jobPath };
}

// Hook errors are lines in the day file (T0-02 R5.2); there is no separate log.
export async function writeHookError(paths, error) {
  await appendArchiveLine(paths, { type: "hook_error", level: "error", message: String(error?.message || error) });
}

export async function writeHookWarning(paths, result) {
  const safeFields = Array.isArray(result?.invalid_fields)
    ? result.invalid_fields.filter((field) => [
      "payload", "session_id", "cwd", "last_assistant_message", "stop_hook_active",
    ].includes(field))
    : [];
  const suffix = safeFields.length ? " fields=" + safeFields.join(",") : "";
  await appendArchiveLine(paths, {
    type: "hook_error",
    level: "warning",
    message: "enqueue_rejected reason=" + String(result?.reason || "unknown") + suffix,
  });
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
  let latestReviewLevel = null;
  let latestReasoningEffort = null;
  const done = await listJson(paths.doneDir);
  if (done.length) {
    const latest = await readJson(done.at(-1));
    latestReviewLevel = latest.review_level || "LEGACY_UNRECORDED";
    latestReasoningEffort = latest.reasoning_effort || "LEGACY_UNRECORDED";
  }
  return {
    ...counts,
    latest_review: latestReview,
    latest_review_level: latestReviewLevel,
    latest_reasoning_effort: latestReasoningEffort,
  };
}

export async function hasPendingMessageHash(paths, messageHash) {
  if (!/^[0-9a-f]{16}$/.test(String(messageHash))) return false;
  const suffix = "-" + messageHash + ".json";
  const jobs = await listJson(paths.pendingDir);
  return jobs.some((file) => path.basename(file).endsWith(suffix));
}

export async function waitForPending(paths, timeoutMinutes = 120) {
  const deadline = Date.now() + timeoutMinutes * 60_000;
  await ensureDir(paths.pendingDir);
  while (Date.now() < deadline) {
    const jobs = await listJson(paths.pendingDir);
    if (jobs.length) return jobs[0];
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("No Claude review submission arrived within " + timeoutMinutes + " minutes.");
}
