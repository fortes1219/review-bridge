import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
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
  recordRunState,
} from "./state-v4.mjs";
import { hasWorkOrderMarkers, MESSAGES as ORDER_MESSAGES, parseWorkOrder, WorkOrderError } from "./work-order.mjs";
import { createWorkspaceBaseline, matchesForbiddenPath } from "./workspace-evidence.mjs";
import { recheckGateA, selectGateA } from "./gate-a.mjs";

// T0-03 C2.1: fixed, in code, listed in every plan. Never from a model.
export const FORBIDDEN_PATHS = Object.freeze([
  ".git/**", ".review-bridge/**", ".claude/**", ".codex/**", ".env", ".env.*",
  "**/*.pem", "**/*.key", "**/id_rsa*",
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "go.sum", "poetry.lock", "composer.lock", "Gemfile.lock",
  ".github/**", ".gitlab-ci.yml", "Jenkinsfile", "Dockerfile*", "docker-compose*", "**/*.tf",
]);
const RULES_RELATIVE = "review-bridge/rules.md";
const RULES_MAX_CHARS = 4_000;
const REFERENCE_MAX_FILES = 200;
const REFERENCE_MAX_BYTES = 2 * 1024 * 1024;
const SKIPPED_DIRS = new Set([".git", "node_modules", "dist", "coverage", "target", ".nuxt", ".output"]);

function sha256Of(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function pathExists(paths, relative) {
  const absolute = path.resolve(paths.repoRoot, ...relative.split("/"));
  return await fsp.stat(absolute).then((stat) => ({ absolute, directory: stat.isDirectory() })).catch(() => null);
}

// C2: scope from references (narrowed), from --allow-paths (explicit, must be a subset), or the default.
async function resolveScope({ paths, workOrder, allowedPaths }) {
  const referencePaths = workOrder ? workOrder.references.filter((entry) => entry.kind === "path") : [];
  const forbidden = [...FORBIDDEN_PATHS];
  if (allowedPaths) {
    const explicit = parseAllowedPaths(allowedPaths);
    for (const entry of explicit) {
      // C2.4 existence applies to human work orders; the legacy inline/test path keeps shape checks only.
      if (workOrder && !(await pathExists(paths, entry))) throw new Error("允許路徑不存在：" + entry);
      if (matchesForbiddenPath(entry, forbidden)) throw new Error("允許路徑在禁改清單內：" + entry);
      if (referencePaths.length && !referencePaths.some((ref) => entry === ref.path || entry.startsWith(ref.path + "/"))) {
        throw new Error("允許路徑不在參考資料的範圍內：" + entry);
      }
    }
    return { allowed_paths: explicit, forbidden_paths: forbidden, source: "explicit" };
  }
  if (referencePaths.length) {
    const narrowed = [...new Set(referencePaths.map((ref) => ref.path))].sort();
    for (const entry of narrowed) {
      if (matchesForbiddenPath(entry, forbidden)) throw new Error("參考資料的路徑在禁改清單內：" + entry);
    }
    return { allowed_paths: narrowed, forbidden_paths: forbidden, source: "references" };
  }
  if (!workOrder) throw new Error("At least one allowed path is required.");
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

// C3.4: every referenced file by hash; contents are verified at startup, not copied here.
export async function snapshotReferences(paths, workOrder) {
  const records = [];
  let totalFiles = 0;
  let totalBytes = 0;
  const count = (bytes) => {
    totalFiles += 1;
    totalBytes += bytes;
    if (totalFiles > REFERENCE_MAX_FILES || totalBytes > REFERENCE_MAX_BYTES) {
      throw new Error("參考資料太多：超過 " + REFERENCE_MAX_FILES + " 個檔或 2 MiB，請把路徑收窄。");
    }
  };
  for (const reference of (workOrder?.references || []).filter((entry) => entry.kind === "path")) {
    const found = await pathExists(paths, reference.path);
    if (!found) throw new Error("參考資料裡這條路徑不存在：" + reference.path);
    if (!found.directory) {
      const buffer = await fsp.readFile(found.absolute);
      count(buffer.length);
      records.push({ path: reference.path, sha256: sha256Of(buffer), bytes: buffer.length });
      continue;
    }
    const files = [];
    async function walk(directory, prefix) {
      const entries = await fsp.readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink()) continue;
        const relative = prefix + "/" + entry.name;
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRS.has(entry.name)) await walk(path.join(directory, entry.name), relative);
          continue;
        }
        if (!entry.isFile()) continue;
        const buffer = await fsp.readFile(path.join(directory, entry.name));
        count(buffer.length);
        files.push({ path: relative, sha256: sha256Of(buffer), bytes: buffer.length });
      }
    }
    await walk(found.absolute, reference.path);
    records.push({ path: reference.path, files });
  }
  return records;
}

function referenceDigest(records) {
  return sha256Of(JSON.stringify(records));
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
  let taskFileRelative = null;
  if (taskFile) {
    const resolved = assertUnder(path.resolve(taskFile), paths.privateRoot, "Task file");
    if (!(await fileExists(resolved))) throw new Error("Task file is missing.");
    taskText = await fsp.readFile(resolved, "utf8");
    // T0-07 V2.1: the result file is written beside this path later.
    taskFileRelative = path.relative(paths.repoRoot, resolved).split(path.sep).join("/");
  }
  taskText = requiredText(taskText, "Task", 40_000);
  // A human work order (from a file, or any text carrying rb: markers) is parsed by fixed rules;
  // inline --task text without markers is the legacy/test path and keeps requiring --allow-paths.
  const workOrder = hasWorkOrderMarkers(taskText) ? await parseWorkOrder(taskText, { repoRoot: paths.repoRoot }) : null;
  // A file without markers is not a work order; it is accepted only as the legacy path with an explicit scope.
  if (!workOrder && taskFile && !allowedPaths) throw new WorkOrderError([ORDER_MESSAGES.no_markers()]);
  const { snapshot } = await loadOrCreatePolicySnapshot(paths);
  const budget = validateBudget(snapshot.effective_policy, maxCalls, maxMinutes);
  const scope = await resolveScope({ paths, workOrder, allowedPaths });
  const rules = workOrder ? await snapshotRules(paths) : null;
  const references = workOrder ? await snapshotReferences(paths, workOrder) : [];
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
    work_order: workOrder,
    rules,
    references,
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
  if (plan.work_order) {
    const current = await snapshotReferences(paths, plan.work_order);
    if (referenceDigest(current) !== referenceDigest(plan.references || [])) {
      const changed = current.find((entry, index) => JSON.stringify(entry) !== JSON.stringify((plan.references || [])[index]));
      throw new Error("批准後 " + (changed ? changed.path : "參考資料") + " 變了，重新建 plan");
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
    work_order: plan.work_order || null,
    rules: plan.rules || null,
    references: plan.references || [],
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
