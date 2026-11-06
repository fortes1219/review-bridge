import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { assertUnder, assertUnderOne, samePath } from "../../utils/pathGuard.mjs";
import {
  acquireLock,
  activeRunsOfWorkOrder,
  claimStartAuthorization,
  consumeRun,
  createAuthorization,
  createImmutableWorkPackage,
  disallowedToolsProblem,
  fileExists,
  isActiveRun,
  isPidAlive,
  isStoppedRun,
  listRuns,
  loadControlView,
  loadOrCreatePolicySnapshot,
  modelProblem,
  readJson,
  readRun,
  recordRunState,
  settleMcp,
  recordsDatabase,
  STOP_REASONS,
  validateRoles,
  writeJson,
  writeText,
} from "../../service/index.mjs";
import { digest } from "../../utils/digest.mjs";
import { nfc, workOrderNameProblem } from "../../utils/workOrderName.mjs";
import { createWorkspaceBaseline, matchesForbiddenPath } from "./workspaceEvidence.mjs";
import { recheckTest, selectTest } from "./test.mjs";
import { MAX_TRANSLATION_ATTEMPTS } from "./contract.mjs";
import { processFile, startLockFile, workLockFile } from "./processRecords.mjs";
import { priorityChoice } from "../../policy/policyRules.mjs";
import { BUDGET_KEYS, budgetProblems, MIN_CALL_TIMEOUT, parseWorkOrder, WorkOrderFormatError } from "./workOrderFormat.mjs";
import { stopRun } from "./writerLoop.mjs";

// The model calls that turn a work order into a contract run before any work, so the plan names
// them for the human to approve: who translates, who checks, how often, and for how long.
function contractSteps(settled) {
  return {
    translate: { role: "writer", provider: settled.writer.provider, model: settled.writer.model },
    check: { role: "reviewer", provider: settled.reviewer.provider },
    max_attempts: MAX_TRANSLATION_ATTEMPTS,
    call_timeout: settled.budget.call_timeout,
  };
}

// Who fills each role in this run: the flag given at the terminal, else bridge.json. The plan seals
// it, so changing bridge.json later only affects the next start (Owner 2026-11-04).
async function selectedRoles(paths, { writer: writerFlag, reviewer: reviewerFlag }) {
  const config = await readJson(paths.bridgeConfigPath).catch(() => ({}));
  const writer = writerFlag ?? config?.roles?.writer?.provider_id;
  const reviewer = reviewerFlag ?? config?.roles?.reviewer?.provider_id;
  if (!writer || !reviewer) throw new Error("The writer and reviewer roles are not set in bridge.json; a work order cannot be planned.");
  validateRoles({ writer, reviewer });
  return {
    writer: { provider: writer, source: writerFlag ? "cli" : "config" },
    reviewer: { provider: reviewer, source: reviewerFlag ? "cli" : "config" },
  };
}

// T0-03 C2.1: fixed, in code, listed in every plan. Never from a model.
export const FORBIDDEN_PATHS = Object.freeze([
  ".git/**", ".review-bridge/**", ".claude/**", ".codex/**", ".env", ".env.*",
  "**/*.pem", "**/*.key", "**/id_rsa*",
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "go.sum", "poetry.lock", "composer.lock", "Gemfile.lock",
  ".github/**", ".gitlab-ci.yml", "Jenkinsfile", "Dockerfile*", "docker-compose*", "**/*.tf",
]);
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
  const absolute = paths.rulesPath;
  const relative = path.relative(paths.repoRoot, absolute).split(path.sep).join("/");
  const text = await fsp.readFile(absolute, "utf8").catch(() => null);
  if (text === null) throw new Error("規則摘要檔不見了：" + relative + "。從 project-templates/rules.md 復原後再建 plan。");
  if (!text.trim()) throw new Error("規則摘要檔是空的：" + relative + "。寫回內容或從 project-templates/rules.md 復原。");
  if (text.length > RULES_MAX_CHARS) throw new Error("規則摘要檔超過 " + RULES_MAX_CHARS + " 字：" + relative + "。縮短後再建 plan。");
  return { path: relative, sha256: sha256Of(text), text };
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

// Refused here, before any card: at the yes it would be too late to say. Not trimmed first: a file whose
// name starts with a space is not the file without it.
function workPackageIdOf(value) {
  if (!String(value || "").trim()) throw new Error("Work package id is required.");
  const problem = workOrderNameProblem(value);
  if (problem) throw new Error("The work order's name " + JSON.stringify(String(value)) + " " + problem + ". Rename the file, or give --work-package.");
  return nfc(value);
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

// A plan is content-addressed, as a policy snapshot is, so one made by an older Bridge (its budget in
// calls and minutes, or its change types) is never rewritten; it is refused where it is read, and a
// new card is made.
export const PLAN_SCHEMA_VERSION = 9;

export function assertCurrentPlan(plan) {
  if (plan?.operation !== "start_work_package") throw new Error("Unsupported work plan.");
  if ([4, 5, 6, 7].includes(plan.schema_version)) throw new Error("This plan was made by an older Bridge and is not read again. Run: review-bridge start <file> to make a new card");
  if (plan.schema_version !== PLAN_SCHEMA_VERSION) throw new Error("Unsupported work plan.");
}

// Every budget value a plan settled, wherever it came from, within the policy: a positive whole
// number no larger than the limit of the same name; a call gets at least a minute.
function validateBudget(policy, budget) {
  for (const key of BUDGET_KEYS) {
    const value = budget[key];
    if (!Number.isInteger(value) || value < 1) throw new Error("The budget's " + key + " must be a positive whole number; it is " + value + ".");
    if (value > policy.limits[key]) throw new Error("The budget's " + key + " is " + value + ", over the policy limit " + policy.limits[key] + ".");
  }
  if (budget.call_timeout < MIN_CALL_TIMEOUT) throw new Error("The budget's call_timeout must be at least " + MIN_CALL_TIMEOUT + " ms.");
  return Object.fromEntries(BUDGET_KEYS.map((key) => [key, budget[key]]));
}

// What one role runs with: its provider, and its model and effort from the work order's block over
// the priority table, each with the layer it came from. A model that does not belong to the role's
// provider stops here, before any card, wherever it was written.
function settleRole(name, selected, written, table, problems) {
  const fromOrder = "model" in written;
  const model = fromOrder ? written.model : table.model;
  const problem = modelProblem(selected.provider, model);
  if (problem) problems.push((fromOrder ? "line " + written.lines.model + ": " + name + ".model: " : "The policy's priority table gives the " + name + " a model: ") + problem);
  return {
    provider: selected.provider,
    provider_source: selected.source,
    model,
    model_source: fromOrder ? "work_order" : "priority",
    effort: written.effort ?? table.effort,
    effort_source: written.effort ? "work_order" : "priority",
  };
}

// Each value the work runs with and the layer it came from, in a fixed order: a flag given at the
// terminal, then the work order's frontmatter, then the policy's priority table, then the config.
// The work order may only go below the config's limits; each refusal names its line.
function settleWorkOrder(policy, format, { rounds, callTimeout, roles }) {
  const frontmatter = format?.frontmatter || { priority: null, writer: { effort: null, lines: {} }, reviewer: { effort: null, lines: {} }, budget: null, lines: {}, budget_lines: {} };
  const problems = [
    ...budgetProblems(frontmatter.budget, policy.limits, (key) => frontmatter.budget_lines[key]),
    ...(format?.runs || []).flatMap((run) => budgetProblems(run.budget, policy.limits, () => run.line, "run " + run.name + " budget")),
  ];
  const priority = frontmatter.priority ?? policy.priority.default;
  const choice = priorityChoice(policy, priority);
  const writer = settleRole("writer", roles.writer, frontmatter.writer, choice.writer, problems);
  const reviewer = settleRole("reviewer", roles.reviewer, frontmatter.reviewer, choice.reviewer, problems);
  if (problems.length) throw new WorkOrderFormatError(problems);
  const refused = disallowedToolsProblem(writer.provider, policy.writer.disallowed_tools);
  if (refused) throw new Error("This work cannot start: " + refused + ". Choose another writer or remove them from the project's policy.");
  const flags = { rounds, call_timeout: callTimeout };
  const budget = {};
  const budgetSource = {};
  for (const key of BUDGET_KEYS) {
    if (flags[key] !== undefined) { budget[key] = Number(flags[key]); budgetSource[key] = "cli"; }
    else if (frontmatter.budget?.[key] !== undefined) { budget[key] = frontmatter.budget[key]; budgetSource[key] = "work_order"; }
    else { budget[key] = policy.limits[key]; budgetSource[key] = "config"; }
  }
  return {
    priority,
    priority_source: frontmatter.priority ? "work_order" : "config",
    // The writer's values hold for every writer call (the work, each fix, the translation), the
    // reviewer's for every reviewer call (the contract check, each review).
    writer,
    reviewer,
    budget: validateBudget(policy, budget),
    budget_source: budgetSource,
  };
}

// Why one file of a directory cannot be run, in a line of the card, or null. Asked before any plan is
// made: a plan seals how many are on the card. What is wrong with the setting itself and not the
// file (a flag over the policy's limit, a policy no writer can hold to) is thrown, as at a single start.
export async function workOrderChecker(paths, { writer, reviewer, rounds, callTimeout }) {
  const { snapshot } = await loadOrCreatePolicySnapshot(paths);
  const roles = await selectedRoles(paths, { writer, reviewer });
  return (fileName, text) => {
    // What init puts there to copy from.
    if (/^TEMPLATE.*\.md$/.test(fileName)) return "it is a template to copy from";
    // The work package's id is its file name, and a run's records are named after it.
    const nameProblem = workOrderNameProblem(path.basename(fileName, path.extname(fileName)));
    if (nameProblem) return "its file name " + nameProblem;
    let taskText;
    try {
      taskText = requiredText(text, "Task", 40_000);
    } catch (error) {
      return error.message.replace(/\.$/, "");
    }
    try {
      // No acceptance is no reason: Bridge gives the orders and verifies, so the reviewer proposes some.
      const format = parseWorkOrder(taskText);
      settleWorkOrder(snapshot.effective_policy, format, { rounds, callTimeout, roles });
    } catch (error) {
      if (error instanceof WorkOrderFormatError) return error.problems[0];
      throw error;
    }
    return null;
  };
}

export async function createWorkPackagePlan({
  paths,
  task,
  taskFile,
  owner,
  workPackage,
  breakpoint,
  allowedPaths,
  rounds,
  callTimeout,
  // Who fills each role, when the terminal says so; otherwise bridge.json.
  writer,
  reviewer,
  // Reads the MCP servers Codex would load, when a role is Codex's. Asked once, here: the plan seals
  // the answer, and every call of the run takes it from there. `checkCodex` comes before it.
  listCodexMcp,
  checkCodex = null,
  // Where the plan is written. Without one it goes to the log folder of the run it proposes, as
  // <planName or work package>.plan.json.
  outPath,
  planName,
  // Which work order this file is (Q13), as the card shows it; sealed with the plan, so the yes
  // approves it too.
  workOrder = null,
  // Where this plan stands on a directory's card: { id, directory, position, total, step }. The plans of
  // one card share the id, as one migrate shares Knex's batch number; there is no table of cards.
  line = null,
  // What was asked and answered on the way to this version (RC3-ASK-01): { round, ai_decides, open_refs,
  // history }. Null for a plain start, which is a new start whatever was asked before.
  clarify = null,
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
  // the person's first yes; inline --task text is the legacy/test path and needs --allow-paths.
  const workOrderFile = Boolean(taskFile);
  // The work order's own format is read before anything else; a work order Bridge cannot split
  // starts nothing, and the refusal names the lines.
  const format = workOrderFile ? parseWorkOrder(taskText) : null;
  const { snapshot } = await loadOrCreatePolicySnapshot(paths);
  const roles = await selectedRoles(paths, { writer, reviewer });
  const settled = settleWorkOrder(snapshot.effective_policy, format, { rounds, callTimeout, roles });
  const mcp = await settleMcp({
    writer: settled.writer.provider, reviewer: settled.reviewer.provider, allow: snapshot.effective_policy.reviewer.mcp_allow, listCodex: listCodexMcp, checkCodex, cwd: paths.repoRoot,
  });
  settled.writer.mcp_off = mcp.writerOff;
  settled.reviewer.mcp_off = mcp.reviewerOff;
  settled.reviewer.mcp = mcp.reviewerMcp;
  const scope = await resolveScope({ paths, workOrderFile, allowedPaths });
  const rules = workOrderFile ? await snapshotRules(paths) : null;
  const contract = workOrderFile ? contractSteps(settled) : null;
  // T0-06 G2: the verification is decided here, from the installed rules, and sealed for approval.
  const test = await selectTest({ paths, repoRoot: paths.repoRoot, bridgeConfig: await readJson(paths.bridgeConfigPath).catch(() => ({})) });
  const plan = {
    schema_version: PLAN_SCHEMA_VERSION,
    operation: "start_work_package",
    created_at: new Date().toISOString(),
    repo_root: paths.repoRoot,
    proposed_run_id: randomUUID(),
    proposed_session_id: randomUUID(),
    work_package_id: workPackageIdOf(workPackage),
    owner: requiredText(owner, "Owner", 80),
    breakpoint: requiredText(breakpoint, "Breakpoint", 160),
    task: taskText,
    task_sha256: digest(taskText),
    task_file: taskFileRelative,
    ...(workOrder ? { work_order: workOrder } : {}),
    ...(line ? { line } : {}),
    ...(clarify ? { clarify } : {}),
    rules,
    ...(contract ? { contract_steps: contract } : {}),
    scope,
    test,
    // What every call of this run will use, each with the layer it came from (settleWorkOrder).
    ...settled,
    effective_policy_sha256: snapshot.effective_policy_sha256,
    authorization_expires_at: new Date(
      Date.now() + snapshot.effective_policy.limits.authorization_ttl,
    ).toISOString(),
  };
  plan.plan_sha256 = planDigest(plan);
  const resolvedOut = assertUnderOne(path.resolve(outPath || planFilePath(paths, plan, planName)), [paths.logRoot, paths.privateRoot], "Work plan output");
  await writeJson(resolvedOut, plan);
  return { ...plan, plan_path: resolvedOut };
}

// The second card's plan: the first one's, with the sealed contract in what its SHA-256 is over, so the yes
// to it covers the contract (Terraform's saved plan is what apply takes, and only that). It proposes a run of
// its own, is valid for as long as any card from now, and names the version that was sealed: that exists
// now, so the yes takes nothing new about which work order this is.
export async function sealPlan(paths, plan, { contractSha256, gathering, workOrderId, versionNo, line = null, planName = null }) {
  const { snapshot } = await loadOrCreatePolicySnapshot(paths);
  const { plan_path: _path, plan_sha256: _sha, ...rest } = plan;
  const sealed = {
    ...rest,
    created_at: new Date().toISOString(),
    proposed_run_id: randomUUID(),
    proposed_session_id: randomUUID(),
    contract_sha256: contractSha256,
    contract_gathering: gathering,
    work_order: { ...plan.work_order, decision: "same", work_order_id: workOrderId, from_version: versionNo, to_version: versionNo, changed_lines: 0 },
    ...(line ? { line } : {}),
    authorization_expires_at: new Date(Date.now() + snapshot.effective_policy.limits.authorization_ttl).toISOString(),
  };
  sealed.plan_sha256 = planDigest(sealed);
  const file = planFilePath(paths, sealed, planName);
  await writeJson(file, sealed);
  return { ...sealed, plan_path: file };
}

// The plan's file in the log folder of the run it proposes: a copy of the card, the database holds it.
export function planFilePath(paths, plan, planName = null) {
  return path.join(paths.runLogDir(plan.proposed_run_id), (planName || plan.work_package_id) + ".plan.json");
}

// E8: whether the work-order file still reads as the plan sealed it (the SHA-256 the card showed).
export async function workOrderUnchanged(plan, taskFile) {
  const now = await fsp.readFile(path.resolve(taskFile), "utf8").catch(() => null);
  return now !== null && digest(now.trim()) === plan.task_sha256;
}

// E10: the first option given beside --yes that is not what the card showed, or null. The card is
// the plan; --yes takes it as it is, so a different value is a conflict, never a change.
export function optionAgainstCard(plan, options) {
  const list = (value) => [...new Set(String(value).split(",").map((entry) => entry.trim()).filter(Boolean))].sort();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const scope = plan.scope || {};
  if (options.breakpoint !== undefined && String(options.breakpoint).trim() !== plan.breakpoint) return "--breakpoint";
  if (options.allowedPaths !== undefined && !(scope.source === "explicit" && same(list(String(options.allowedPaths).replaceAll("\\", "/")), scope.allowed_paths))) return "--allow-paths";
  if (options.owner !== undefined && String(options.owner).trim() !== plan.owner) return "--owner";
  if (options.rounds !== undefined && Number(options.rounds) !== plan.budget?.rounds) return "--rounds";
  if (options.callTimeout !== undefined && Number(options.callTimeout) !== plan.budget?.call_timeout) return "--call-timeout";
  if (options.writer !== undefined && options.writer !== plan.writer?.provider) return "--writer";
  if (options.reviewer !== undefined && options.reviewer !== plan.reviewer?.provider) return "--reviewer";
  if (options.asNew && plan.work_order?.decision !== "new") return "--as-new";
  if (options.update !== undefined && plan.work_order?.work_order_id !== options.update) return "--update";
  return null;
}

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
  const database = recordsDatabase();
  if (database && plan.work_order) return await runningVersionsOf(paths, plan, await database());
  const location = await workOrderLocation(paths, plan.task_file);
  if (!location) throw new Error("The work order " + plan.task_file + " is missing.");
  const found = [];
  for (const run of await listRuns(paths)) {
    const unresolved = isStoppedRun(run) && await fileExists(processFile(paths, run.run_id));
    if (!isActiveRun(run) && !unresolved) continue;
    let control;
    try {
      control = await loadControlView(paths, run.run_id);
    } catch {
      throw new Error("Run " + run.run_id + " is still running and its record cannot be read; stop it before starting " + plan.task_file + ".");
    }
    // The same place, however each start spelled its path; the same test as the start lock's key.
    const theirs = control.run?.work_package?.task_file;
    if (!theirs || (await workOrderLocation(paths, theirs)) !== location) continue;
    found.push({ runId: run.run_id, unchanged: isActiveRun(run) && control.run.work_package.task === plan.task });
  }
  return found;
}

// With records (RC3-BLOCKER-01 step 4) the same question is asked of the work order's id, not its
// place: its running runs from the database, and a stopped one whose kill is not confirmed yet
// (its process record is still there; there are only as many as processes alive). A new work order
// has none.
async function runningVersionsOf(paths, plan, db) {
  const workOrderId = plan.work_order.work_order_id;
  if (!workOrderId) return [];
  const found = (await activeRunsOfWorkOrder(db, workOrderId))
    .map((row) => ({ runId: row.run_id, unchanged: row.content_sha256 === plan.task_sha256 }));
  const unconfirmed = (await fsp.readdir(paths.runLocksDir).catch(() => []))
    .filter((name) => name.endsWith(".process.json")).map((name) => name.slice(0, -".process.json".length))
    .filter((runId) => !found.some((run) => run.runId === runId));
  if (unconfirmed.length) {
    const { rows } = await db.query("select run_id from runs where run_id = any($1::uuid[]) and work_order_id = $2 and status = 'completed' and closed_reason = any($3::text[])",
      [unconfirmed.filter((runId) => /^[0-9a-f-]{36}$/.test(runId)), workOrderId, STOP_REASONS]);
    found.push(...rows.map((row) => ({ runId: row.run_id, unchanged: false })));
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

// The immutable work package and the authorization one plan starts from. The authorization's id is the
// plan's, so a directory's yes writes it first and that plan's start finds the same one here.
async function planAuthorization(paths, plan, { authorizedVia, ttl, clock = Date.now }) {
  const workPackage = await createImmutableWorkPackage(paths, {
    work_package_id: plan.work_package_id,
    task: plan.task,
    acceptance_criteria: [],
    scope: plan.scope,
    budget: plan.budget,
    breakpoint: plan.breakpoint,
    rules: plan.rules || null,
    contract_steps: plan.contract_steps || null,
    clarify: plan.clarify || null,
    contract_sha256: plan.contract_sha256 || null,
    test: plan.test || null,
    task_file: plan.task_file || null,
    priority: plan.priority,
    writer: plan.writer,
    reviewer: plan.reviewer,
  }, () => Date.parse(plan.created_at));
  return await createAuthorization(paths, {
    authorizationId: "plan-" + plan.plan_sha256,
    kind: "start",
    // C4: the OS user running work-start, never the name typed into the plan.
    authorizedBy: os.userInfo().username,
    authorizedVia,
    workOrderSha256: plan.task_file ? plan.task_sha256 : null,
    workPackageSha256: workPackage.record.content_sha256,
    policySha256: plan.effective_policy_sha256,
    ttl,
    sourcePlanSha256: plan.plan_sha256,
  }, clock);
}

// One yes to a directory's card: an authorization per plan, with one moment and one way of saying yes.
// A policy changed since the card refuses the yes whole. Each plan's own checks run when its turn comes.
export async function authorizeCard(paths, plans, { authorizedVia, clock = Date.now }) {
  const { snapshot } = await loadOrCreatePolicySnapshot(paths);
  const stale = plans.find((plan) => plan.effective_policy_sha256 !== snapshot.effective_policy_sha256);
  if (stale) throw new Error("The policy changed after the card was shown: Bridge was upgraded or its policy changed. Nothing was authorized. Run start again.");
  const moment = clock();
  const authorizations = [];
  for (const plan of plans) {
    authorizations.push({
      planSha256: plan.plan_sha256,
      authorization: await planAuthorization(paths, plan, { authorizedVia, ttl: snapshot.effective_policy.limits.authorization_ttl, clock: () => moment }),
    });
  }
  return authorizations;
}

// A run created by a start that then failed is closed, never left running.
export async function closeFailedStart(paths, runId, error) {
  const message = String(error?.message || error);
  await recordRunState(paths, runId, { status: "controller_failure", error: message, updated_at: new Date().toISOString() }).catch(() => {});
  await consumeRun(paths, runId, "controller_failure", null).catch(() => {});
}

export async function authorizeWorkPackage({ paths, planPath, approval, executionMode = "native", authorizedVia = "approve_flag" }) {
  const resolvedPlan = assertUnderOne(path.resolve(planPath), [paths.logRoot, paths.privateRoot], "Work plan");
  const plan = await readJson(resolvedPlan);
  assertCurrentPlan(plan);
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
  validateBudget(snapshot.effective_policy, plan.budget);
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
  if (plan.test) {
    const recheck = await recheckTest(paths.repoRoot, plan.test);
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
    const authorization = await planAuthorization(paths, plan, { authorizedVia, ttl: snapshot.effective_policy.limits.authorization_ttl });
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
    const promptPath = path.join(paths.runLogDir(started.run.run_id), "authorized-" + authorization.authorization_id + ".txt");
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

// The run asked for, or the newest one, in detail, with one page of the project's runs (listRuns)
// and how many are running.
export async function workPackageStatus(paths, runId = null) {
  const runs = await listRuns(paths);
  const ordered = [...runs].sort((left, right) => {
    const byTime = new Date(right.updated_at || right.created_at || 0).getTime()
      - new Date(left.updated_at || left.created_at || 0).getTime();
    return byTime || left.run_id.localeCompare(right.run_id);
  });
  const chosen = runId || ordered[0]?.run_id;
  const selected = chosen ? await readRun(paths, chosen).catch(() => null) : null;
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
    session_present: Boolean(selected.writer_session_id),
    execution_mode: selected.execution_mode,
    conclusion: selected.conclusion || null,
    closed_reason: selected.closed_reason || null,
    latest_state: selected.last_state,
    stop_reason: selected.last_state?.failure || null,
    active_runs: (await listRuns(paths, { activeOnly: true })).length,
    runs: ordered.map((run) => ({
      run_id: run.run_id,
      work_package: run.work_package_id || null,
      status: run.status,
      conclusion: run.conclusion || null,
      updated_at: run.updated_at || run.created_at || null,
    })),
  };
}
