import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { assertUnder, samePath } from "../../utils/pathGuard.mjs";
import {
  acquireLock,
  claimStartAuthorization,
  consumeRun,
  createAuthorization,
  createImmutableWorkPackage,
  fileExists,
  isPidAlive,
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
import { processFile, startLockFile, workLockFile } from "./processRecords.mjs";
import { DEFAULT_WRITER_MODEL, stopRun } from "./writerLoop.mjs";

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

export async function createWorkPackagePlan({
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

const RUNNING_STATUSES = new Set(["running", "review_pending", "correction_pending", "interrupted"]);

// A work order is a place: the folder it is in and the name its entry has there (decision A,
// 2026-10-22). Two spellings of one entry (Abc and abc where names ignore case) are one place; two
// entries are two places, even two hard links to one file in one folder; a file replaced by an
// editor that saves by renaming stays in the same place, so editing it makes a new version, not
// another work order. Moving it to another folder or name makes another work order. The entry is
// the one with exactly the spelled name; only when there is none, yet the path still reaches a file
// (a folder that ignores case or Unicode form), the single entry whose name matches ignoring both.
// Either way it must be the very file the path reaches. Anything else cannot be told apart and is
// refused, never guessed. Null when nothing is at that path. No setting such as core.ignoreCase and
// no rule per operating system is consulted. `stat` and `readdir` are seams for tests.
export async function workOrderLocation(paths, taskFile, {
  stat = (target) => fsp.stat(target, { bigint: true }), readdir = (target) => fsp.readdir(target),
} = {}) {
  const absolute = path.resolve(paths.repoRoot, ...String(taskFile).split("/"));
  const folder = path.dirname(absolute);
  const spelled = path.basename(absolute);
  let file;
  try {
    file = await stat(absolute);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
  const where = await stat(folder);
  if (!file.isFile() || !file.ino || !file.dev || !where.ino || !where.dev) {
    throw new Error("The file system gives no file id for " + taskFile + ", so Bridge cannot tell which work order it is; the start is refused.");
  }
  const names = await readdir(folder);
  const fold = (name) => name.normalize("NFC").toLowerCase();
  const candidates = names.includes(spelled) ? [spelled] : names.filter((name) => fold(name) === fold(spelled));
  const unclear = "The work order " + taskFile + " cannot be told apart from the other entries in its folder; the start is refused.";
  if (candidates.length !== 1) throw new Error(unclear);
  const entry = await stat(path.join(folder, candidates[0]));
  if (entry.ino !== file.ino || entry.dev !== file.dev) throw new Error(unclear);
  return where.dev.toString() + ":" + where.ino.toString() + ":" + candidates[0];
}

// The runs of the same work order (the same place) still running, or stopped with a kill not yet confirmed.
// `unchanged` marks a running one sealed from the same work order text as this plan: that is not
// an older version, and a start must not stop it. Saving the file replaces nothing; only a start
// does. A running run whose record cannot be read refuses the start instead of being guessed at. A
// plan already used (its run exists) replaces nothing; the start refuses that plan later anyway.
export async function runningVersions(paths, plan) {
  if (!plan.task_file) return [];
  if (await readRun(paths, plan.proposed_run_id).then(() => true, () => false)) return [];
  const location = await workOrderLocation(paths, plan.task_file);
  if (!location) throw new Error("The work order " + plan.task_file + " is missing.");
  const found = [];
  for (const run of await listRuns(paths)) {
    const unresolved = run.status === "stopped" && await fileExists(processFile(paths, run.run_id));
    if (!RUNNING_STATUSES.has(run.status) && !unresolved) continue;
    let control;
    try {
      control = await loadControlView(paths, run.run_id);
    } catch {
      throw new Error("Run " + run.run_id + " is still running and its record cannot be read; stop it before starting " + plan.task_file + ".");
    }
    // The same place, however each start spelled its path; the same test as the start lock's key.
    const theirs = control.run?.work_package?.task_file;
    if (!theirs || (await workOrderLocation(paths, theirs)) !== location) continue;
    found.push({ runId: run.run_id, unchanged: RUNNING_STATUSES.has(run.status) && control.run.work_package.task === plan.task });
  }
  return found;
}

// A run's work lock is held by the work-start working it until its loop returns. A stopped
// version's work-start returns soon after its calls are killed; the new version waits for that.
export async function workLockReleased(paths, runId, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let holder;
    try {
      holder = await readJson(workLockFile(paths, runId));
    } catch (error) {
      if (error.code === "ENOENT") return true;
      holder = null; // being written or removed; look again
    }
    const pid = Number(holder?.pid);
    if (holder && Number.isInteger(pid) && pid > 0 && !isPidAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

// Called under the work order's start lock. The same work order text already running is refused
// and that run goes on; only a work order that changed replaces its running version. The old
// version's calls are stopped, and the stop confirmed, before anything of the new version is made.
// A stop that cannot be confirmed, or an old work-start that does not let go of its run, refuses
// the start; starting again retries it.
async function stopEarlierVersions(paths, plan) {
  const versions = await runningVersions(paths, plan);
  const unchanged = versions.find((version) => version.unchanged);
  if (unchanged) {
    throw new Error("This work order is already running unchanged as run " + unchanged.runId + "; nothing was created. Edit the work order to start a new version, or stop that run first.");
  }
  const stopped = [];
  for (const { runId } of versions) {
    const result = await stopRun(paths, runId, { supersededBy: plan.proposed_run_id });
    if (result.exitCode === 2) {
      throw new Error("The version still running from " + plan.task_file + " could not be stopped: run " + runId + " (" + result.reason + "). Start again to retry the stop; the new version does not start before the old one has stopped.");
    }
    if (result.exitCode === 0) stopped.push(runId);
  }
  for (const runId of stopped) {
    if (!(await workLockReleased(paths, runId))) {
      throw new Error("The old version of " + plan.task_file + " (run " + runId + ") is stopped, but its work-start has not finished closing. Start again in a moment.");
    }
  }
  return stopped;
}

// A run created by a start that then failed is closed, never left running.
async function closeFailedStart(paths, runId, error) {
  const message = String(error?.message || error);
  await recordRunState(paths, runId, { status: "controller_failure", error: message, updated_at: new Date().toISOString() }).catch(() => {});
  await consumeRun(paths, runId, "controller_failure", null).catch(() => {});
}

export async function authorizeWorkPackage({ paths, planPath, approval, executionMode = "native", authorizedVia = "approve_flag" }) {
  const resolvedPlan = assertUnder(path.resolve(planPath), paths.privateRoot, "Work plan");
  const plan = await readJson(resolvedPlan);
  if (plan.schema_version !== 4 || plan.operation !== "start_work_package") throw new Error("Unsupported work plan.");
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
  // One start of a work order at a time, from looking for its running version until the new run
  // exists; a second start meanwhile is refused and creates nothing.
  let startLock = null;
  let location = null;
  if (plan.task_file) {
    location = await workOrderLocation(paths, plan.task_file);
    if (!location) throw new Error("The work order " + plan.task_file + " is missing.");
    try {
      startLock = await acquireLock(startLockFile(paths, location));
    } catch (error) {
      throw new Error("Another start of " + plan.task_file + " is in progress; nothing was created. Try again in a moment (" + error.message + ").");
    }
  }
  // The place is checked again once the lock is held and once the run exists: a save by renaming
  // keeps it, but a work order deleted or moved meanwhile, or its folder replaced, does not, and
  // then another start may hold another lock for it. A change fails this start; its run, if made,
  // is closed.
  const samePlaceStill = async (moment) => {
    if (location && (await workOrderLocation(paths, plan.task_file)) !== location) {
      throw new Error("The work order " + plan.task_file + " is no longer where it was " + moment + "; this start is refused. Start again.");
    }
  };
  const letGoOfStart = async () => {
    const held = startLock;
    startLock = null;
    await held?.();
  };
  let superseded;
  let workLock;
  try {
    await samePlaceStill("as this start began");
    // Every refusal above leaves the running version alone. From here the start replaces it: nothing
    // of the old run (its authorization, contract or verdicts) is carried into the new one.
    superseded = await stopEarlierVersions(paths, plan);
    // The new run's work lock is taken before the run exists and handed to the loop that works it: a
    // start that cannot take it leaves nothing behind, and one plan cannot be started twice at once.
    try {
      workLock = await acquireLock(workLockFile(paths, plan.proposed_run_id));
    } catch (error) {
      throw new Error("This plan is already being started or worked by another process; nothing was created (" + error.message + ").");
    }
  } catch (error) {
    await letGoOfStart();
    throw error;
  }
  let started = null;
  try {
    // A used plan is refused before its baseline is rebuilt: that would overwrite the old run's proof.
    if (await readRun(paths, plan.proposed_run_id).then(() => true, () => false)) {
      throw new Error("Work plan already consumed, generate a new plan.");
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
    started = await claimStartAuthorization(paths, authorization.authorization_id, {
      runId: plan.proposed_run_id,
      sessionId: plan.proposed_session_id,
      executionMode,
      workspaceEvidence,
    });
    await samePlaceStill("while this start ran");
    // The new run exists: a later start of this work order finds it.
    await letGoOfStart();
    // T0-09 M2: maintenance (uninstall or upgrade) may have begun after the claim checked the marker.
    await cancelIfMaintenance(paths, started.run.run_id);
    const promptPath = path.join(paths.queueRoot, "authorized-" + authorization.authorization_id + ".txt");
    await writeText(promptPath, plan.task);
    return {
      plan,
      authorization,
      superseded,
      run: started.run,
      control: await loadControlView(paths, started.run.run_id),
      promptPath,
      workLock,
    };
  } catch (error) {
    if (started) await closeFailedStart(paths, started.run.run_id, error);
    await letGoOfStart();
    await workLock();
    throw error;
  }
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

export async function cancelWorkPackage({ paths, runId = null, reason = "cancelled_by_human_owner" }) {
  const active = await listRuns(paths, { activeOnly: true });
  const selected = runId ? active.find((run) => run.run_id === runId) : active.length === 1 ? active[0] : null;
  if (!selected) {
    throw new Error(runId ? "No active run " + runId + " to cancel."
      : active.length ? "Several runs are active; name the one to cancel with --run <run id>." : "No active run to cancel.");
  }
  await consumeRun(paths, selected.run_id, "cancelled", null);
  return { ...(await readRun(paths, selected.run_id)), cancel_reason: requiredText(reason, "Cancel reason", 160) };
}

export async function workPackageStatus(paths, runId = null) {
  const runs = await listRuns(paths);
  const ordered = [...runs].sort((left, right) => {
    const byTime = Date.parse(right.updated_at || right.created_at || 0)
      - Date.parse(left.updated_at || left.created_at || 0);
    return byTime || left.run_id.localeCompare(right.run_id);
  });
  const selected = runId ? runs.find((run) => run.run_id === runId) : ordered[0] || null;
  if (!selected) return { active_runs: 0, latest_run: null };
  const control = await loadControlView(paths, selected.run_id);
  return {
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
