// Run-record retention (T0-02): one archive file per day, kept for a fixed number
// of days, with merge (run -> day file), prune, and rm. Zero model involvement.
//
// A terminal run's artifacts are folded into <privateRoot>/archive/<YYYY-MM-DD>.jsonl
// as one JSON line each, then deleted. Small per-run records (projection,
// authorization, claim, lock, guard) stay until the run is older than the
// retention window. Nothing that belongs to an active run is ever touched.
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { ensureDir, fileExists, listJson, readJson, writeJsonAtomicDurable } from "./io.mjs";

export const DEFAULT_RETENTION_DAYS = 15;
export const ARCHIVE_SCHEMA_VERSION = 1;
const MAX_ARCHIVED_TEXT_BYTES = 256 * 1024;
const DAY_MS = 86_400_000;

const terminalStatuses = new Set([
  "pass", "hard_stop", "rate_limited", "cancelled", "policy_failure",
  "call_budget_exhausted", "claude_timeout", "claude_failed", "reviewer_failed", "controller_failure",
]);
const activeStatuses = new Set(["running", "review_pending", "correction_pending", "interrupted"]);

// Files directly in the queue or reviews root that are part of the Bridge's own
// control surface; never archived as orphans.
const PROTECTED_ROOT_FILES = new Set([
  "CONTROL.json",
  "classification-policy.json",
  "bounded-resume-state.json",
  "upgrade-in-progress.json",
  "worker.node.lock",
  "bounded-resume.node.lock",
  "LATEST.txt",
]);

export class RetentionConfigError extends Error {}

export function retentionDays(config) {
  const block = config?.retention;
  if (block === undefined || block === null) return DEFAULT_RETENTION_DAYS;
  if (typeof block !== "object") throw new RetentionConfigError("retention must be an object with days.");
  const days = block.days;
  if (days === undefined) return DEFAULT_RETENTION_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new RetentionConfigError("retention.days must be a whole number from 1 to 365.");
  }
  return days;
}

// Local calendar day, because the person reads these next to their own clock.
export function localDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid date for archive.");
  const pad = (n) => String(n).padStart(2, "0");
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
}

export function archiveFileForDate(paths, value) {
  return path.join(paths.archiveDir, localDateKey(value) + ".jsonl");
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function readOptionalJson(file) {
  try { return await readJson(file); } catch { return null; }
}

async function readOptionalText(file) {
  try { return await fsp.readFile(file, "utf8"); } catch { return null; }
}

async function listFiles(directory) {
  try {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => path.join(directory, entry.name));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

// Append several lines with one open and one fsync so a run's record lands together.
export async function appendArchiveLines(file, lines) {
  if (!lines.length) return;
  await ensureDir(path.dirname(file));
  const handle = await fsp.open(file, "a");
  try {
    await handle.writeFile(lines.map((line) => JSON.stringify(line) + "\n").join(""), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function appendArchiveLine(paths, record, clock = Date.now) {
  const archivedAt = new Date(clock()).toISOString();
  await appendArchiveLines(archiveFileForDate(paths, archivedAt), [{
    schema_version: ARCHIVE_SCHEMA_VERSION,
    archived_at: archivedAt,
    run_id: null,
    ...record,
  }]);
}

// --- usage parsing (R1.6): fixed shapes, never throws ---------------------

export function parseWriterUsage(stdoutText, { call = null } = {}) {
  try {
    const parsed = JSON.parse(stdoutText);
    const result = Array.isArray(parsed) ? parsed.at(-1) : parsed;
    if (!result || typeof result !== "object") return { role: "writer", call, parse_error: true };
    const usage = result.usage && typeof result.usage === "object" ? result.usage : null;
    const models = result.modelUsage && typeof result.modelUsage === "object" ? Object.keys(result.modelUsage) : [];
    const number = (value) => (Number.isFinite(value) ? value : null);
    return {
      role: "writer",
      call,
      model: models.length ? models.join(",") : null,
      num_turns: number(result.num_turns),
      input_tokens: number(usage?.input_tokens),
      cache_read_input_tokens: number(usage?.cache_read_input_tokens),
      cache_creation_input_tokens: number(usage?.cache_creation_input_tokens),
      output_tokens: number(usage?.output_tokens),
      total_cost_usd: number(result.total_cost_usd),
      ...(usage ? {} : { parse_error: true }),
    };
  } catch {
    return { role: "writer", call, parse_error: true };
  }
}

export function parseReviewerUsage(stderrText, { jobId = null } = {}) {
  const match = /tokens used\s*\r?\n\s*([\d,]+)\s*$/i.exec(String(stderrText || "").trimEnd());
  if (!match) return { role: "reviewer", job_id: jobId, parse_error: true };
  const tokens = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(tokens)) return { role: "reviewer", job_id: jobId, parse_error: true };
  return { role: "reviewer", job_id: jobId, tokens_used: tokens };
}

// --- mapping artifacts to a run (R2.3): by recorded ids and paths, never by time ---

function stampOf(filePath) {
  const base = path.basename(String(filePath || ""));
  const match = /^(\d{8}T\d{9}Z)-/.exec(base);
  return match ? match[1] : null;
}

function statePaths(state) {
  if (!state || typeof state !== "object") return [];
  return [state.stdout_path, state.stderr_path, state.claude_stdout_path, state.claude_stderr_path, state.review_path]
    .filter((value) => typeof value === "string" && value);
}

async function readEvents(paths, runId) {
  const file = path.join(paths.eventsDir, runId + ".jsonl");
  const text = await readOptionalText(file);
  if (text === null) return { file, events: [], present: false };
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { events.push({ unparsable: line }); }
  }
  return { file, events, present: true };
}

async function reviewJobsForRun(paths, runId) {
  const jobs = [];
  for (const directory of [paths.pendingDir, paths.runningDir, paths.doneDir, paths.failedDir]) {
    for (const file of await listJson(directory)) {
      const job = await readOptionalJson(file);
      if (job?.authorization?.run_id === runId) jobs.push({ file, job, jobId: path.basename(file, ".json") });
    }
  }
  return jobs;
}

function reviewKind(base) {
  if (base.endsWith("-codex-review.md")) return "review_result";
  if (base.endsWith("-claude-report.md")) return "writer_report";
  if (base.endsWith("-review-prompt.md")) return "review_prompt";
  if (base.endsWith("-codex.stdout.log")) return "reviewer_stdout";
  if (base.endsWith("-codex.stderr.log")) return "reviewer_stderr";
  if (base.endsWith("-job.json")) return "review_job_copy";
  return "review_other";
}

function writerKind(base) {
  if (base.endsWith("-claude.stdout.json")) return "writer_stdout";
  if (base.endsWith("-claude.stderr.log")) return "writer_stderr";
  if (base.endsWith("-stop-payload.json")) return "stop_payload";
  if (base.endsWith("-writer-only-prompt.txt")) return "writer_prompt";
  if (base.endsWith("-bounded-correction.txt")) return "correction_prompt";
  return "writer_other";
}

export async function collectRunArtifacts(paths, run) {
  const runId = run.run_id;
  const { file: eventFile, events, present } = await readEvents(paths, runId);
  const artifacts = new Map();
  const add = (kind, file) => { if (file && !artifacts.has(file)) artifacts.set(file, kind); };
  const directories = new Set();

  const authorizationIds = [
    ...(Array.isArray(run.authorization_ids) ? run.authorization_ids : []),
    ...(run.authorization_id ? [run.authorization_id] : []),
  ];
  for (const authorizationId of authorizationIds) {
    add("authorized_plan", path.join(paths.queueRoot, "authorized-" + authorizationId + ".txt"));
    if (authorizationId.startsWith("plan-")) directories.add(path.join(paths.evidenceRoot, authorizationId.slice(5, 37)));
  }
  for (const file of await listJson(paths.queueRoot)) {
    if (!file.endsWith(".plan.json")) continue;
    const plan = await readOptionalJson(file);
    if (plan?.proposed_run_id === runId) add("plan", file);
  }
  const stamps = new Set();
  const candidates = [...statePaths(run.last_state), ...events.flatMap((event) => statePaths(event?.projection?.last_state))];
  for (const candidate of candidates) {
    const stamp = stampOf(candidate);
    if (stamp) stamps.add(stamp);
  }
  if (stamps.size) {
    for (const file of await listFiles(paths.queueRoot)) {
      const stamp = stampOf(file);
      if (stamp && stamps.has(stamp)) add(writerKind(path.basename(file)), file);
    }
  }
  const jobs = await reviewJobsForRun(paths, runId);
  for (const { file, job, jobId } of jobs) {
    add("review_job", file);
    for (const reviewFile of await listFiles(paths.reviewsRoot)) {
      if (path.basename(reviewFile).startsWith(jobId + "-")) add(reviewKind(path.basename(reviewFile)), reviewFile);
    }
    const evidence = job.workspace_evidence;
    if (evidence?.delta_path) add("evidence_delta", evidence.delta_path);
    if (evidence?.evidence_dir) directories.add(evidence.evidence_dir);
    if (evidence?.baseline_path) directories.add(path.dirname(evidence.baseline_path));
  }
  for (const directory of directories) {
    for (const file of await listFiles(directory)) {
      if (path.basename(file).startsWith("delta-")) add("evidence_delta", file);
    }
  }
  const ioFile = path.join(paths.eventsDir, runId + ".io.jsonl");
  const ioText = await readOptionalText(ioFile);
  const ioEvents = [];
  for (const line of (ioText || "").split("\n")) {
    if (!line.trim()) continue;
    try { ioEvents.push(JSON.parse(line)); } catch { ioEvents.push({ unparsable: line }); }
  }
  return { eventFile, eventsPresent: present, events, artifacts, directories: [...directories], jobs, ioFile, ioPresent: ioText !== null, ioEvents };
}

async function artifactLine(kind, file) {
  const buffer = await fsp.readFile(file);
  const text = buffer.length <= MAX_ARCHIVED_TEXT_BYTES ? buffer.toString("utf8") : undefined;
  return {
    type: "artifact",
    kind,
    name: path.basename(file),
    source_path: file,
    sha256: sha256(buffer),
    bytes: buffer.length,
    ...(text === undefined ? { truncated: true } : { text }),
  };
}

export function isTerminalRun(run) {
  return Boolean(run) && terminalStatuses.has(run.status);
}

export function isActiveRun(run) {
  return Boolean(run) && activeStatuses.has(run.status);
}

function runTerminalAt(run) {
  return run.closed_at || run.updated_at || run.created_at || new Date().toISOString();
}

// R2: fold one terminal run into its day file, then delete what was folded.
export async function mergeRun(paths, runId, { clock = Date.now } = {}) {
  const projectionFile = path.join(paths.runsDir, runId + ".json");
  const run = await readOptionalJson(projectionFile);
  if (!run) throw new Error("Run does not exist: " + runId);
  if (!isTerminalRun(run)) throw new Error("Run is still active: " + runId);
  if (run.archived_at) return { run_id: runId, archive_file: run.archive_file, already_archived: true, lines: 0, deleted: 0 };

  const collected = await collectRunArtifacts(paths, run);
  const archivedAt = new Date(clock()).toISOString();
  const terminalAt = runTerminalAt(run);
  const archiveFile = archiveFileForDate(paths, terminalAt);
  const base = { schema_version: ARCHIVE_SCHEMA_VERSION, archived_at: archivedAt, run_id: runId };
  const lines = [{ ...base, type: "run", terminal_at: terminalAt, run: { ...run } }];
  for (const event of collected.events) lines.push({ ...base, type: "event", event });
  for (const event of collected.ioEvents) lines.push({ ...base, type: "io_event", event });
  // T0-05 D5.4: when the run recorded usage as I/O events those are the usage lines;
  // the transcript and stderr-trailer parsers are only the fallback for runs without them.
  const ioUsageRoles = new Set(collected.ioEvents.filter((event) => event.event === "usage" && !event.parse_error).map((event) => event.role));
  let call = 0;
  for (const [file, kind] of collected.artifacts) {
    if (!(await fileExists(file))) { collected.artifacts.delete(file); continue; } // recorded path already gone
    if (kind === "writer_stdout") {
      call += 1;
      if (!ioUsageRoles.has("writer")) lines.push({ ...base, type: "usage", ...parseWriterUsage(await fsp.readFile(file, "utf8"), { call }) });
      continue; // R1.7: the full transcript is not archived, only its usage.
    }
    const line = await artifactLine(kind, file);
    lines.push({ ...base, ...line });
    if (kind === "reviewer_stderr" && !ioUsageRoles.has("reviewer")) {
      const jobId = path.basename(file).replace(/-codex\.stderr\.log$/, "");
      lines.push({ ...base, type: "usage", ...parseReviewerUsage(line.text || "", { jobId }) });
    }
  }

  try {
    await appendArchiveLines(archiveFile, lines);
  } catch (error) {
    // R2.4: nothing deleted; the projection says why so prune retries later.
    await writeJsonAtomicDurable(projectionFile, { ...run, archive_error: String(error.message || error) }).catch(() => {});
    throw error;
  }
  const { archive_error: _dropped, ...rest } = run;
  await writeJsonAtomicDurable(projectionFile, { ...rest, archived_at: archivedAt, archive_file: archiveFile });

  let deleted = 0;
  for (const file of collected.artifacts.keys()) {
    await fsp.rm(file, { force: true });
    deleted += 1;
  }
  for (const directory of collected.directories) {
    if (await fileExists(directory)) { await fsp.rm(directory, { recursive: true, force: true }); deleted += 1; }
  }
  if (collected.eventsPresent) { await fsp.rm(collected.eventFile, { force: true }); deleted += 1; }
  if (collected.ioPresent) { await fsp.rm(collected.ioFile, { force: true }); deleted += 1; }
  await fsp.rm(path.join(paths.runLocksDir, runId + ".process.json"), { force: true });
  return { run_id: runId, archive_file: archiveFile, already_archived: false, lines: lines.length, deleted };
}

// --- prune (R3) -------------------------------------------------------------

function olderThan(iso, days, now) {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return false;
  return now - time > days * DAY_MS;
}

async function activeReferences(paths, runs) {
  const stamps = new Set();
  const jobIds = new Set();
  for (const run of runs) {
    if (!isActiveRun(run)) continue;
    for (const candidate of statePaths(run.last_state)) {
      const stamp = stampOf(candidate);
      if (stamp) stamps.add(stamp);
    }
    for (const { jobId } of await reviewJobsForRun(paths, run.run_id)) jobIds.add(jobId);
  }
  return { stamps, jobIds };
}

export async function prune(paths, { config, clock = Date.now, ttlSeconds = 86_400 } = {}) {
  const days = retentionDays(config); // RetentionConfigError here means nothing is deleted
  const now = clock();
  const summary = {
    days,
    merged_runs: 0,
    merge_errors: [],
    archive_files_deleted: 0,
    run_records_deleted: 0,
    authorizations_deleted: 0,
    job_files_deleted: 0,
    orphans_archived: 0,
  };
  const runs = [];
  for (const file of await listJson(paths.runsDir)) {
    const run = await readOptionalJson(file);
    if (run?.run_id) runs.push(run);
  }
  const activeIds = new Set(runs.filter(isActiveRun).map((run) => run.run_id));

  // 1. Fold every terminal run that is not folded yet.
  for (const run of runs) {
    if (!isTerminalRun(run) || run.archived_at) continue;
    try {
      await mergeRun(paths, run.run_id, { clock });
      run.archived_at = new Date(now).toISOString();
      summary.merged_runs += 1;
    } catch (error) {
      summary.merge_errors.push({ run_id: run.run_id, error: String(error.message || error) });
    }
  }

  // 2. Day files older than the window; never today's.
  const today = localDateKey(now);
  for (const file of await listFiles(paths.archiveDir)) {
    const key = path.basename(file, ".jsonl");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || key === today) continue;
    if (olderThan(key + "T23:59:59", days, now)) { await fsp.rm(file, { force: true }); summary.archive_files_deleted += 1; }
  }

  // 3. Small per-run records of runs that ended more than `days` ago.
  const expiredRunIds = new Set();
  for (const run of runs) {
    if (!isTerminalRun(run) || !run.archived_at || !olderThan(runTerminalAt(run), days, now)) continue;
    expiredRunIds.add(run.run_id);
    for (const directory of [paths.runsDir, paths.runLocksDir, paths.reconcileGuardsDir]) {
      const file = path.join(directory, run.run_id + ".json");
      if (await fileExists(file)) { await fsp.rm(file, { force: true }); summary.run_records_deleted += 1; }
    }
  }
  // Authorizations, claims and invalidations go when their run is gone, or when
  // their TTL passed, they are older than the window, and no active run holds them.
  const knownRunIds = new Set(runs.map((run) => run.run_id));
  for (const directory of [paths.authorizationClaimsDir, paths.authorizationsDir, paths.authorizationInvalidationsDir]) {
    for (const file of await listJson(directory)) {
      const record = await readOptionalJson(file);
      const runId = record?.run_id || null;
      if (runId && activeIds.has(runId)) continue;
      const stampedAt = record?.claimed_at || record?.authorized_at || record?.invalidated_at || null;
      const ttlPassed = stampedAt ? now - Date.parse(stampedAt) > ttlSeconds * 1000 : false;
      const runGone = runId ? !knownRunIds.has(runId) || expiredRunIds.has(runId) : false;
      if (runGone || (ttlPassed && olderThan(stampedAt, days, now))) {
        await fsp.rm(file, { force: true });
        summary.authorizations_deleted += 1;
      }
    }
  }

  // 4. Review job files and upgrade reports older than the window that no active run references.
  const { stamps: activeStamps, jobIds: activeJobIds } = await activeReferences(paths, runs);
  for (const directory of [paths.pendingDir, paths.runningDir, paths.doneDir, paths.failedDir, paths.upgradeReportsDir]) {
    for (const file of await listFiles(directory)) {
      if (activeJobIds.has(path.basename(file, ".json"))) continue;
      const stat = await fsp.stat(file).catch(() => null);
      if (stat && now - stat.mtimeMs > days * DAY_MS) { await fsp.rm(file, { force: true }); summary.job_files_deleted += 1; }
    }
  }

  // 5. Orphans directly under the queue and reviews roots (R1.9).
  for (const root of [paths.queueRoot, paths.reviewsRoot]) {
    for (const file of await listFiles(root)) {
      const base = path.basename(file);
      if (PROTECTED_ROOT_FILES.has(base)) continue;
      const stamp = stampOf(file);
      if (stamp && activeStamps.has(stamp)) continue;
      if (base.endsWith(".plan.json")) {
        const plan = await readOptionalJson(file);
        if (plan?.proposed_run_id && activeIds.has(plan.proposed_run_id)) continue;
        if (plan?.proposed_run_id && !knownRunIds.has(plan.proposed_run_id)
          && plan.authorization_expires_at && Date.parse(plan.authorization_expires_at) > now) continue; // not started yet
      }
      if (base.startsWith("authorized-plan-")) {
        const authorizationId = base.replace(/^authorized-/, "").replace(/\.txt$/, "");
        const owner = runs.find((run) => (run.authorization_ids || []).includes(authorizationId));
        if (owner && (isActiveRun(owner) || !owner.archived_at)) continue;
      }
      if (root === paths.reviewsRoot) {
        const jobId = base.replace(/-(job\.json|review-prompt\.md|claude-report\.md|codex-review\.md|codex\.stdout\.log|codex\.stderr\.log|error\.txt)$/, "");
        if (activeJobIds.has(jobId)) continue;
      }
      const stat = await fsp.stat(file).catch(() => null);
      if (!stat) continue;
      const line = await artifactLine("orphan", file);
      await appendArchiveLines(archiveFileForDate(paths, stat.mtime), [{
        schema_version: ARCHIVE_SCHEMA_VERSION,
        archived_at: new Date(now).toISOString(),
        run_id: null,
        ...line,
        type: "orphan",
      }]);
      await fsp.rm(file, { force: true });
      summary.orphans_archived += 1;
    }
  }
  return summary;
}

export function formatPruneSummary(summary) {
  const parts = [];
  if (summary.merged_runs) parts.push("合併 " + summary.merged_runs + " 條紀錄");
  if (summary.archive_files_deleted) parts.push("清掉 " + summary.archive_files_deleted + " 天份紀錄");
  if (summary.run_records_deleted) parts.push(summary.run_records_deleted + " 個過期 run 記錄");
  if (summary.authorizations_deleted) parts.push(summary.authorizations_deleted + " 個過期授權");
  if (summary.job_files_deleted) parts.push(summary.job_files_deleted + " 個過期審查檔");
  if (summary.orphans_archived) parts.push(summary.orphans_archived + " 個殘留檔");
  const line = parts.length ? parts.join("、") : "沒有要清的";
  const errors = summary.merge_errors.map((entry) => "合併失敗 " + entry.run_id + "：" + entry.error);
  return [line + "（保留 " + summary.days + " 天）", ...errors].join("\n");
}

// --- rm (R4) ----------------------------------------------------------------

export async function removeRun(paths, runId, { clock = Date.now } = {}) {
  if (!/^[A-Za-z0-9-]{8,80}$/.test(String(runId || ""))) return { exitCode: 1, line: "沒有這條", reason: "unknown" };
  const projectionFile = path.join(paths.runsDir, runId + ".json");
  const run = await readOptionalJson(projectionFile);
  if (!run) return { exitCode: 1, line: "沒有這條", reason: "unknown" };
  if (isActiveRun(run)) return { exitCode: 1, line: "進行中，先 stop", reason: "active" };
  let merged = null;
  if (!run.archived_at) merged = await mergeRun(paths, runId, { clock });
  for (const directory of [paths.runsDir, paths.runLocksDir, paths.reconcileGuardsDir]) {
    await fsp.rm(path.join(directory, runId + ".json"), { force: true });
  }
  return { exitCode: 0, line: "已移除 " + runId, reason: merged ? "merged_and_removed" : "removed", archive_file: (merged || run).archive_file };
}
