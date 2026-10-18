import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { assertUnder, samePath } from "../../utils/pathGuard.mjs";
import {
  claimStartAuthorization,
  consumeRun,
  createAuthorization,
  createImmutableWorkPackage,
  fileExists,
  listRuns,
  loadControlView,
  loadOrCreatePolicySnapshot,
  readJson,
  readRun,
  recordRunState,
  writeJson,
  writeText,
} from "../../service/index.mjs";
import { digest } from "../../utils/digest.mjs";
import { createWorkspaceBaseline, matchesForbiddenPath } from "./workspaceEvidence.mjs";
import { recheckGateA, selectGateA } from "./gateA.mjs";
import { MAX_TRANSLATION_ATTEMPTS } from "./contract.mjs";
import { DEFAULT_WRITER_MODEL } from "./writerLoop.mjs";

// The model calls that turn a work order into a contract run before any work, so the plan names
// them for the human to approve: who translates, who checks, how often, and for how long. The
// providers are the configured roles as they are; a native run refuses one it cannot call yet.
async function contractSteps(paths, snapshot, budget) {
  const config = await readJson(paths.bridgeConfigPath).catch(() => ({}));
  const writer = config?.roles?.writer?.provider_id;
  const reviewer = config?.roles?.reviewer?.provider_id;
  if (!writer || !reviewer) throw new Error("The writer and reviewer roles are not set in bridge.json; a work order cannot be planned.");
  return {
    translate: { role: "writer", provider: writer, model: snapshot.effective_policy?.writer?.model || DEFAULT_WRITER_MODEL },
    check: { role: "reviewer", provider: reviewer },
    max_attempts: MAX_TRANSLATION_ATTEMPTS,
    minutes_per_call: budget.max_claude_minutes_per_call,
  };
}

// T0-03 C2.1: fixed, in code, listed in every plan. Never from a model.
export const FORBIDDEN_PATHS = Object.freeze([
  ".git/**", ".review-bridge/**", ".claude/**", ".codex/**", ".env", ".env.*",
  "**/*.pem", "**/*.key", "**/id_rsa*",
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "go.sum", "poetry.lock", "composer.lock", "Gemfile.lock",
  ".github/**", ".gitlab-ci.yml", "Jenkinsfile", "Dockerfile*", "docker-compose*", "**/*.tf",
]);
const RULES_RELATIVE = "review-bridge/rules.md";
const RULES_MAX_CHARS = 4_000;

function sha256Of(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function pathExists(paths, relative) {
  const absolute = path.resolve(paths.repoRoot, ...relative.split("/"));
  return await fsp.stat(absolute).then((stat) => ({ absolute, directory: stat.isDirectory() })).catch(() => null);
}

// C2: scope from --allow-paths (explicit) or, for a work-order file, the default. Paths written
// in a work order are context for the writer, never permission, so they do not narrow or widen it.
async function resolveScope({ paths, workOrderFile, allowedPaths }) {
  const forbidden = [...FORBIDDEN_PATHS];
  if (allowedPaths) {
    const explicit = parseAllowedPaths(allowedPaths);
    for (const entry of explicit) {
      // C2.4 existence applies to human work orders; the legacy inline/test path keeps shape checks only.
      if (workOrderFile && !(await pathExists(paths, entry))) throw new Error("允許路徑不存在：" + entry);
      if (matchesForbiddenPath(entry, forbidden)) throw new Error("允許路徑在禁改清單內：" + entry);
    }
    return { allowed_paths: explicit, forbidden_paths: forbidden, source: "explicit" };
  }
  if (!workOrderFile) throw new Error("At least one allowed path is required.");
  return { allowed_paths: ["**"], forbidden_paths: forbidden, source: "default" };
}

// C3.3: the rules digest the writer will be shown, sealed into the plan.
export async function snapshotRules(paths) {
  const absolute = path.join(paths.configRoot, "rules.md");
  const relative = path.basename(paths.privateRoot) + "/" + RULES_RELATIVE;
  const text = await fsp.readFile(absolute, "utf8").catch(() => null);
  if (text === null) throw new Error("規則摘要檔不見了：" + relative + "。從 project-templates/rules.md 復原後再建 plan。");
  if (!text.trim()) throw new Error("規則摘要檔是空的：" + relative + "。寫回內容或從 project-templates/rules.md 復原。");
  if (text.length > RULES_MAX_CHARS) throw new Error("規則摘要檔超過 " + RULES_MAX_CHARS + " 字：" + relative + "。縮短後再建 plan。");
  return { path: relative, sha256: sha256Of(text), text };
}

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
    if (/^(\.git|\.env(?:\.|$)|\.review-bridge)(?:\/|$)/i.test(normalized)) {
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
  let taskFileRelative = null;
  if (taskFile) {
    const resolved = assertUnder(path.resolve(taskFile), paths.privateRoot, "Task file");
    if (!(await fileExists(resolved))) throw new Error("Task file is missing.");
    taskText = await fsp.readFile(resolved, "utf8");
    // T0-07 V2.1: the result file is written beside this path later.
    taskFileRelative = path.relative(paths.repoRoot, resolved).split(path.sep).join("/");
  }
  taskText = requiredText(taskText, "Task", 40_000);
  // A work-order file is sealed as text here and turned into a contract by the model only after
  // the human starts the work; inline --task text is the legacy/test path and needs --allow-paths.
  const workOrderFile = Boolean(taskFile);
  const { snapshot } = await loadOrCreatePolicySnapshot(paths);
  const budget = validateBudget(snapshot.effective_policy, maxCalls, maxMinutes);
  const scope = await resolveScope({ paths, workOrderFile, allowedPaths });
  const rules = workOrderFile ? await snapshotRules(paths) : null;
  const contract = workOrderFile ? await contractSteps(paths, snapshot, budget) : null;
  const changeTypeList = parseChangeTypes(changeTypes);
  // T0-06 G2: the verification is decided here, from the installed rules, and sealed for approval.
  const gateA = await selectGateA({ paths, repoRoot: paths.repoRoot, bridgeConfig: await readJson(paths.bridgeConfigPath).catch(() => ({})), changeTypes: changeTypeList });
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
    task_file: taskFileRelative,
    rules,
    ...(contract ? { contract_steps: contract } : {}),
    scope: {
      change_types: changeTypeList,
      ...scope,
    },
    gate_a: gateA,
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

export async function authorizeV4WorkPackage({ paths, planPath, approval, executionMode = "native", authorizedVia = "approve_flag" }) {
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
    throw new Error("Work plan is stale because effective policy changed: Bridge was upgraded or its policy changed. Make a new plan with work-plan.");
  }
  validateBudget(snapshot.effective_policy, plan.budget.max_claude_calls, plan.budget.max_claude_minutes_per_call);
  // C3.7: what the model will be shown must still be what the Owner approved.
  if (plan.rules) {
    const current = await snapshotRules(paths);
    if (current.sha256 !== plan.rules.sha256) throw new Error("批准後 " + plan.rules.path + " 變了，重新建 plan");
  }
  // Starting authorizes the work order as it is now; one edited since the plan is not what was sealed.
  if (plan.task_file) {
    const current = await fsp.readFile(path.resolve(paths.repoRoot, ...plan.task_file.split("/")), "utf8").catch(() => null);
    if (current === null || digest(current.trim()) !== plan.task_sha256) {
      throw new Error("The work order " + plan.task_file + " changed after the plan was built. Build a new plan.");
    }
  }
  // T0-06 G2.5: the sealed test entry point must still exist when the human approves.
  if (plan.gate_a) {
    const recheck = await recheckGateA(paths.repoRoot, plan.gate_a);
    if (!recheck.ok) throw new Error("批准後專案的測試入口變了（" + recheck.reasons.join("；") + "），重新建 plan");
  }
  const workPackage = await createImmutableWorkPackage(paths, {
    work_package_id: plan.work_package_id,
    task: plan.task,
    acceptance_criteria: [],
    scope: plan.scope,
    budget: plan.budget,
    breakpoint: plan.breakpoint,
    rules: plan.rules || null,
    contract_steps: plan.contract_steps || null,
    gate_a: plan.gate_a || null,
    task_file: plan.task_file || null,
  }, () => Date.parse(plan.created_at));
  const authorization = await createAuthorization(paths, {
    authorizationId: "plan-" + plan.plan_sha256,
    kind: "start",
    // C4: the OS user running work-start, never the name typed into the plan.
    authorizedBy: os.userInfo().username,
    authorizedVia,
    workPackageSha256: workPackage.record.content_sha256,
    policySha256: snapshot.effective_policy_sha256,
    ttlSeconds: snapshot.effective_policy.limits.authorization_ttl_seconds,
    sourcePlanSha256: plan.plan_sha256,
  });
  const workspaceEvidence = await createWorkspaceBaseline({
    paths,
    planSha256: plan.plan_sha256,
    runId: plan.proposed_run_id,
    allowedPaths: plan.scope.allowed_paths,
    forbiddenPaths: plan.scope.forbidden_paths || [],
  });
  const started = await claimStartAuthorization(paths, authorization.authorization_id, {
    runId: plan.proposed_run_id,
    sessionId: plan.proposed_session_id,
    executionMode,
    workspaceEvidence,
  });
  // T0-09 M2: maintenance (uninstall or upgrade) may have begun after the claim checked the marker.
  await cancelIfMaintenance(paths, started.run.run_id);
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

// T0-09 M2: a run claimed while the maintenance marker appeared is closed as cancelled before any
// model call, so an uninstall or upgrade that checks runs after writing its marker never races it.
export async function cancelIfMaintenance(paths, runId) {
  if (!(await fileExists(paths.upgradeMarkerPath))) return false;
  await recordRunState(paths, runId, {
    status: "maintenance_blocked", reason: "maintenance_in_progress", updated_at: new Date().toISOString(),
  }, { duringMaintenance: true });
  await consumeRun(paths, runId, "cancelled", null, { duringMaintenance: true });
  throw new Error("Bridge maintenance (uninstall or upgrade) started while this work was being authorized; the run was cancelled before any model call (maintenance_in_progress).");
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
