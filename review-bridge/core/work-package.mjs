import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  assertUnder,
  fileExists,
  listJson,
  readJson,
  samePath,
  writeJson,
  writeJsonAtomic,
  writeText,
} from "./io.mjs";
import { validateClassificationProfile } from "./policy.mjs";
import { createWorkspaceBaseline } from "./workspace-evidence.mjs";

const allowedChangeTypes = new Set([
  "docs",
  "code",
  "tests",
  "config",
  "contract",
  "schema",
  "migration",
  "external-behavior",
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function digest(value) {
  const source = typeof value === "string"
    ? value
    : JSON.stringify(canonical(value));
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function planDigest(plan) {
  const copy = structuredClone(plan);
  delete copy.plan_sha256;
  return digest(copy);
}

function requiredText(value, label, maximum) {
  const text = String(value || "").trim();
  if (!text) throw new Error(label + " is required.");
  if (text.length > maximum) throw new Error(label + " exceeds " + maximum + " characters.");
  const unsupportedControls = text.replace(/[\n\r\t]/g, "");
  if (/\p{Cc}/u.test(unsupportedControls)) throw new Error(label + " contains control characters.");
  return text;
}

function parseChangeTypes(value) {
  const values = String(value || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (!values.length) throw new Error("At least one --change-types value is required.");
  const unique = [...new Set(values)];
  for (const entry of unique) {
    if (!allowedChangeTypes.has(entry)) throw new Error("Unsupported change type: " + entry);
  }
  return unique.sort();
}

function parseAllowedPaths(value) {
  const values = String(value || "")
    .split(",")
    .map((entry) => entry.trim().replaceAll("\\", "/"))
    .filter(Boolean);
  if (!values.length) throw new Error("At least one --allow-paths value is required.");
  const unique = [...new Set(values)];
  for (const entry of unique) {
    if (entry.startsWith("/") || /^[A-Za-z]:/.test(entry) || entry.includes("\0")) {
      throw new Error("Allowed paths must be repository-relative: " + entry);
    }
    const normalized = path.posix.normalize(entry);
    if (normalized === ".." || normalized.startsWith("../")) {
      throw new Error("Allowed path escapes the repository: " + entry);
    }
    if (/^(\.git|\.env(?:\.|$)|\.claude\/(?:review-queue|reviews))(?:\/|$)/i.test(normalized)) {
      throw new Error("Runtime, Git, and environment paths cannot be authorized: " + entry);
    }
  }
  return unique.sort();
}

function validateWorkPackageId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id)) {
    throw new Error("--work-package must be 1-80 characters using letters, numbers, dot, underscore, or dash.");
  }
  return id;
}

function validateBudget(maxCalls, maxMinutes) {
  const calls = Number(maxCalls);
  const minutes = Number(maxMinutes);
  if (!Number.isInteger(calls) || calls < 1 || calls > 2) {
    throw new Error("--max-claude-calls must be 1 or 2.");
  }
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 15) {
    throw new Error("--max-claude-minutes must be 1 through 15.");
  }
  return { maxCalls: calls, maxMinutes: minutes };
}

async function assertQueueIdle(paths) {
  const pending = await listJson(paths.pendingDir);
  const running = await listJson(paths.runningDir);
  if (pending.length || running.length) {
    throw new Error("Review queue must be idle before authorizing a work package.");
  }
}

function hardStops(changeTypes) {
  const stops = [
    "new human decision required",
    "approved or ratified decision must be reopened",
    "scope expansion, a path outside allowed_paths, or another work package",
    "commit, push, deploy, release, adapter activation, or history rewrite",
    "malformed or missing machine-readable review gate",
    "token, call-count, or wall-clock budget exhausted",
  ];
  for (const type of allowedChangeTypes) {
    if (!changeTypes.includes(type)) stops.push("unapproved change type: " + type);
  }
  return stops;
}

export async function createWorkPackagePlan({
  paths,
  control,
  task,
  taskFile,
  owner,
  workPackage,
  breakpoint,
  changeTypes,
  allowedPaths,
  maxCalls = 2,
  maxMinutes = 8,
  outPath,
}) {
  if (control.authorization_status === "active") {
    throw new Error("An active work package already exists. Complete or cancel it first.");
  }
  await assertQueueIdle(paths);
  const profile = await readJson(paths.classificationProfilePath);
  validateClassificationProfile(profile, control);

  if (Boolean(task) === Boolean(taskFile)) {
    throw new Error("Provide exactly one of --task or --task-file.");
  }
  let taskText;
  if (taskFile) {
    const resolvedTask = assertUnder(path.resolve(taskFile), paths.privateRoot, "Task file");
    if (!(await fileExists(resolvedTask))) throw new Error("Task file is missing.");
    taskText = await fsp.readFile(resolvedTask, "utf8");
  } else {
    taskText = String(task);
  }
  taskText = requiredText(taskText, "Task", 40_000);

  const budget = validateBudget(maxCalls, maxMinutes);
  const resolvedOut = assertUnder(path.resolve(outPath), paths.privateRoot, "Work plan output");
  const plan = {
    schema_version: 1,
    operation: "start_work_package",
    created_at: new Date().toISOString(),
    repo_root: paths.repoRoot,
    session_id: randomUUID(),
    work_package: validateWorkPackageId(workPackage),
    owner: requiredText(owner, "Owner", 80),
    breakpoint: requiredText(breakpoint, "Breakpoint", 160),
    task: taskText,
    task_sha256: digest(taskText),
    scope: {
      change_types: parseChangeTypes(changeTypes),
      allowed_paths: parseAllowedPaths(allowedPaths),
    },
    budget: {
      max_claude_calls: budget.maxCalls,
      max_claude_minutes_per_call: budget.maxMinutes,
    },
    classification_profile: profile.profile_id,
    classification_sha256: digest(profile),
    control_before_sha256: digest(control),
  };
  plan.plan_sha256 = planDigest(plan);
  await writeJson(resolvedOut, plan);
  return { ...plan, plan_path: resolvedOut };
}

export async function authorizeWorkPackage({
  paths,
  planPath,
  approval,
  executionMode = "native",
}) {
  const resolvedPlan = assertUnder(path.resolve(planPath), paths.privateRoot, "Work plan");
  const plan = await readJson(resolvedPlan);
  if (plan.schema_version !== 1 || plan.operation !== "start_work_package") {
    throw new Error("Unsupported work package plan.");
  }
  const actualPlanDigest = planDigest(plan);
  if (plan.plan_sha256 !== actualPlanDigest) throw new Error("Work package plan checksum is invalid.");
  if (String(approval || "").toLowerCase() !== actualPlanDigest) {
    throw new Error("--approve must equal the exact work package plan SHA-256.");
  }
  if (!["native", "fake_cli"].includes(executionMode)) {
    throw new Error("Unsupported execution mode.");
  }
  if (!samePath(plan.repo_root, paths.repoRoot)) throw new Error("Work package plan targets another repository.");
  validateBudget(plan.budget?.max_claude_calls, plan.budget?.max_claude_minutes_per_call);
  validateWorkPackageId(plan.work_package);
  requiredText(plan.owner, "Owner", 80);
  requiredText(plan.breakpoint, "Breakpoint", 160);
  if (digest(String(plan.task || "")) !== plan.task_sha256) throw new Error("Task checksum is invalid.");
  parseChangeTypes((plan.scope?.change_types || []).join(","));
  parseAllowedPaths((plan.scope?.allowed_paths || []).join(","));

  const control = await readJson(paths.controlPath);
  if (control.authorization_status === "active") throw new Error("An active work package already exists.");
  if (digest(control) !== plan.control_before_sha256) {
    throw new Error("Work package plan is stale because CONTROL changed.");
  }
  const profile = await readJson(paths.classificationProfilePath);
  validateClassificationProfile(profile, control);
  if (profile.profile_id !== plan.classification_profile || digest(profile) !== plan.classification_sha256) {
    throw new Error("Work package plan is stale because classification policy changed.");
  }
  await assertQueueIdle(paths);

  const now = new Date().toISOString();
  const workspaceEvidence = await createWorkspaceBaseline({
    paths,
    planSha256: actualPlanDigest,
    allowedPaths: plan.scope.allowed_paths,
  });
  const promptPath = path.join(paths.queueRoot, "authorized-" + actualPlanDigest.slice(0, 16) + ".txt");
  await writeText(promptPath, String(plan.task));
  const nextControl = {
    ...control,
    schema_version: Math.max(Number(control.schema_version || 0), 3),
    authorization_status: "active",
    mode: "bounded_standing_correction",
    work_package: plan.work_package,
    authorized_by: plan.owner,
    authorized_at: now,
    breakpoint: plan.breakpoint,
    closed_at: null,
    closed_by_breakpoint: null,
    closed_reason: null,
    auto_dispatch_on_review_fail: true,
    authorization_plan_sha256: actualPlanDigest,
    execution_mode: executionMode,
    authorized_prompt_path: promptPath,
    authorized_scope: structuredClone(plan.scope),
    workspace_evidence: workspaceEvidence,
    active_claude_session: plan.session_id,
    previous_claude_session: control.active_claude_session || null,
    iteration: 0,
    failed_dispatch_attempts: 0,
    failed_fresh_session: null,
    dispatch_transport: "claude_cli_resume_same_session",
    hard_stops: hardStops(plan.scope.change_types),
    codex_policy: {
      ...control.codex_policy,
      classification_profile: plan.classification_profile,
      authorized_by: plan.owner,
      updated_at: now,
    },
    token_policy: {
      ...control.token_policy,
      claude_disallowed_tools: ["Agent"],
      token_policy_authorized_by: plan.owner,
      token_policy_updated_at: now,
      claude_mode: "writer_only",
      claude_effort: "low",
      independent_semantic_reviewer: "Codex",
      claude_self_review: "one_local_consistency_pass",
      full_reconstruction_on_correction: false,
      full_reconstruction_requires_human: true,
      max_claude_calls_per_resume: plan.budget.max_claude_calls,
      max_claude_minutes_per_call: plan.budget.max_claude_minutes_per_call,
    },
  };
  await writeJsonAtomic(paths.controlPath, nextControl);
  return { plan, control: nextControl, promptPath };
}

export async function cancelWorkPackage({ paths, reason = "cancelled_by_human_owner" }) {
  const control = await readJson(paths.controlPath);
  if (control.authorization_status !== "active") throw new Error("There is no active work package to cancel.");
  const safeReason = requiredText(reason, "Cancel reason", 160);
  const now = new Date().toISOString();
  control.authorization_status = "consumed";
  control.closed_at = now;
  control.closed_by_breakpoint = String(control.breakpoint || "human_cancel");
  control.closed_reason = safeReason;
  await writeJsonAtomic(paths.controlPath, control);
  await writeJson(paths.boundedStatePath, {
    status: "cancelled",
    session_id: control.active_claude_session,
    work_package: control.work_package,
    updated_at: now,
    reason: safeReason,
  });
  return control;
}

export async function workPackageStatus(paths) {
  const control = await readJson(paths.controlPath);
  const state = await fileExists(paths.boundedStatePath)
    ? await readJson(paths.boundedStatePath)
    : null;
  return {
    work_package: control.work_package || null,
    authorization_status: control.authorization_status || "missing",
    owner: control.authorized_by || null,
    breakpoint: control.breakpoint || null,
    scope: control.authorized_scope || null,
    iteration: Number(control.iteration || 0),
    session_present: Boolean(control.active_claude_session),
    execution_mode: control.execution_mode || null,
    closed_reason: control.closed_reason || null,
    latest_state: state,
  };
}
