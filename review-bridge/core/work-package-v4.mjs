import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { assertUnder, fileExists, readJson, samePath, writeJson, writeText } from "./io.mjs";
import { digest, loadOrCreatePolicySnapshot } from "./policy-v4.mjs";
import {
  claimStartAuthorization,
  consumeRun,
  createAuthorization,
  createImmutableWorkPackage,
  listRuns,
  loadControlView,
  readRun,
} from "./state-v4.mjs";
import { createWorkspaceBaseline } from "./workspace-evidence.mjs";

const allowedChangeTypes = new Set([
  "docs", "code", "tests", "config", "contract", "schema", "migration", "external-behavior",
]);

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
  const values = [...new Set(String(value || "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean))];
  if (!values.length) throw new Error("At least one change type is required.");
  for (const entry of values) if (!allowedChangeTypes.has(entry)) throw new Error("Unsupported change type: " + entry);
  return values.sort();
}

function parseAllowedPaths(value) {
  const values = [...new Set(String(value || "").split(",").map((entry) => entry.trim().replaceAll("\\", "/")).filter(Boolean))];
  if (!values.length) throw new Error("At least one allowed path is required.");
  for (const entry of values) {
    if (entry.startsWith("/") || /^[A-Za-z]:/.test(entry) || entry.includes("\0")) {
      throw new Error("Allowed paths must be workspace-relative: " + entry);
    }
    const normalized = path.posix.normalize(entry);
    if (normalized === ".." || normalized.startsWith("../")) throw new Error("Allowed path escapes the workspace.");
    if (/^(\.git|\.env(?:\.|$)|\.claude\/(?:review-queue|reviews))(?:\/|$)/i.test(normalized)) {
      throw new Error("Runtime, Git, and environment paths cannot be authorized: " + entry);
    }
  }
  return values.sort();
}

function validateBudget(policy, maxCalls, maxMinutes) {
  const calls = Number(maxCalls);
  const minutes = Number(maxMinutes);
  if (!Number.isInteger(calls) || calls < 1 || calls > policy.limits.max_claude_calls) {
    throw new Error("Claude call budget exceeds policy.");
  }
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > policy.limits.max_claude_minutes_per_call) {
    throw new Error("Claude minute budget exceeds policy.");
  }
  return { max_claude_calls: calls, max_claude_minutes_per_call: minutes };
}

export async function createV4WorkPackagePlan({
  paths,
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
  if (Boolean(task) === Boolean(taskFile)) throw new Error("Provide exactly one of --task or --task-file.");
  let taskText = task;
  if (taskFile) {
    const resolved = assertUnder(path.resolve(taskFile), paths.privateRoot, "Task file");
    if (!(await fileExists(resolved))) throw new Error("Task file is missing.");
    taskText = await fsp.readFile(resolved, "utf8");
  }
  taskText = requiredText(taskText, "Task", 40_000);
  const { snapshot } = await loadOrCreatePolicySnapshot(paths);
  const budget = validateBudget(snapshot.effective_policy, maxCalls, maxMinutes);
  const plan = {
    schema_version: 4,
    operation: "start_work_package",
    created_at: new Date().toISOString(),
    repo_root: paths.repoRoot,
    proposed_run_id: randomUUID(),
    proposed_session_id: randomUUID(),
    work_package_id: requiredText(workPackage, "Work package id", 80),
    owner: requiredText(owner, "Owner", 80),
    breakpoint: requiredText(breakpoint, "Breakpoint", 160),
    task: taskText,
    task_sha256: digest(taskText),
    scope: {
      change_types: parseChangeTypes(changeTypes),
      allowed_paths: parseAllowedPaths(allowedPaths),
    },
    budget,
    effective_policy_sha256: snapshot.effective_policy_sha256,
    authorization_expires_at: new Date(
      Date.now() + snapshot.effective_policy.limits.authorization_ttl_seconds * 1000,
    ).toISOString(),
  };
  plan.plan_sha256 = planDigest(plan);
  const resolvedOut = assertUnder(path.resolve(outPath), paths.privateRoot, "Work plan output");
  await writeJson(resolvedOut, plan);
  return { ...plan, plan_path: resolvedOut };
}

export async function authorizeV4WorkPackage({ paths, planPath, approval, executionMode = "native" }) {
  const resolvedPlan = assertUnder(path.resolve(planPath), paths.privateRoot, "Work plan");
  const plan = await readJson(resolvedPlan);
  if (plan.schema_version !== 4 || plan.operation !== "start_work_package") throw new Error("Unsupported v4 work plan.");
  const actual = planDigest(plan);
  if (plan.plan_sha256 !== actual || String(approval || "").toLowerCase() !== actual) {
    throw new Error("Work plan approval checksum is invalid.");
  }
  if (!samePath(plan.repo_root, paths.repoRoot)) throw new Error("Work plan targets another workspace.");
  if (!['native', 'fake_cli'].includes(executionMode)) throw new Error("Unsupported execution mode.");
  if (digest(plan.task) !== plan.task_sha256) throw new Error("Task checksum is invalid.");
  const { snapshot } = await loadOrCreatePolicySnapshot(paths);
  if (snapshot.effective_policy_sha256 !== plan.effective_policy_sha256) {
    throw new Error("Work plan is stale because effective policy changed.");
  }
  validateBudget(snapshot.effective_policy, plan.budget.max_claude_calls, plan.budget.max_claude_minutes_per_call);
  const workPackage = await createImmutableWorkPackage(paths, {
    work_package_id: plan.work_package_id,
    task: plan.task,
    acceptance_criteria: [],
    scope: plan.scope,
    budget: plan.budget,
    breakpoint: plan.breakpoint,
  }, () => Date.parse(plan.created_at));
  const authorization = await createAuthorization(paths, {
    authorizationId: "plan-" + plan.plan_sha256,
    kind: "start",
    authorizedBy: plan.owner,
    workPackageSha256: workPackage.record.content_sha256,
    policySha256: snapshot.effective_policy_sha256,
    ttlSeconds: snapshot.effective_policy.limits.authorization_ttl_seconds,
    sourcePlanSha256: plan.plan_sha256,
  });
  const workspaceEvidence = await createWorkspaceBaseline({
    paths,
    planSha256: plan.plan_sha256,
    allowedPaths: plan.scope.allowed_paths,
  });
  const started = await claimStartAuthorization(paths, authorization.authorization_id, {
    runId: plan.proposed_run_id,
    sessionId: plan.proposed_session_id,
    executionMode,
    workspaceEvidence,
  });
  const promptPath = path.join(paths.queueRoot, "authorized-" + authorization.authorization_id + ".txt");
  await writeText(promptPath, plan.task);
  return {
    plan,
    authorization,
    run: started.run,
    control: await loadControlView(paths, started.run.run_id),
    promptPath,
  };
}

export async function cancelV4WorkPackage({ paths, runId = null, reason = "cancelled_by_human_owner" }) {
  const active = await listRuns(paths, { activeOnly: true });
  const selected = runId ? active.find((run) => run.run_id === runId) : active.length === 1 ? active[0] : null;
  if (!selected) throw new Error("Specify exactly one active run to cancel.");
  await consumeRun(paths, selected.run_id, "cancelled", null);
  return { ...(await readRun(paths, selected.run_id)), cancel_reason: requiredText(reason, "Cancel reason", 160) };
}

export async function v4WorkPackageStatus(paths, runId = null) {
  const runs = await listRuns(paths);
  const ordered = [...runs].sort((left, right) => {
    const byTime = Date.parse(right.updated_at || right.created_at || 0)
      - Date.parse(left.updated_at || left.created_at || 0);
    return byTime || left.run_id.localeCompare(right.run_id);
  });
  const selected = runId ? runs.find((run) => run.run_id === runId) : ordered[0] || null;
  if (!selected) return { state_contract: "v4", active_runs: 0, latest_run: null };
  const control = await loadControlView(paths, selected.run_id);
  return {
    state_contract: "v4",
    run_id: selected.run_id,
    work_package: control.work_package,
    authorization_status: control.authorization_status,
    owner: control.authorized_by,
    breakpoint: control.breakpoint,
    scope: control.authorized_scope,
    iteration: selected.iteration,
    session_present: Boolean(selected.claude_session_id),
    execution_mode: selected.execution_mode,
    closed_reason: selected.closed_reason || null,
    latest_state: selected.last_state,
    stop_reason: selected.last_state?.failure || null,
    active_runs: runs.filter((run) => ["running", "review_pending", "correction_pending", "interrupted"].includes(run.status)).length,
    runs: ordered.map((run) => ({
      run_id: run.run_id,
      work_package: run.work_package_id || null,
      status: run.status,
      updated_at: run.updated_at || run.created_at || null,
    })),
  };
}
