// Every fact a run writes also goes into the person's database (RC3-BLOCKER-01 step 3): the run, its
// one ordered timeline (state events and I/O events in one sequence), the tests, the review's verdicts
// and findings, Bridge's acceptance decision, the delivery. appendProjectionEvent and appendIoEvent
// hand each event to the recorder a command installed. The database is the run's record (DECISIONS
// 2026-11-03, B): every event keeps its file line there, numbered by the database, and the files are
// its copy, brought up to it by position (reconcileRunProjection, readIoEvents). The reads a person
// and an agent use (status, work-status, doctor) come from here too (step 4).
//
// One event is one transaction: the run's row is locked, the next sequence taken, the event and its
// facts written, and the run's state columns set from the same event, so they never disagree. A run
// the database does not know (started before Bridge kept its records there) is left to its files.
import fsp from "node:fs/promises";
import path from "node:path";

import { canonical } from "../../utils/digest.mjs";
import { appendJsonLineDurable, readLastLine } from "./fileStore.mjs";

// The person's database could not be reached: not started, gone mid-run, or refused at the door. A
// read says so and exits; a run stops with database_unavailable and calls no model after it.
export class DatabaseUnavailableError extends Error {
  constructor(cause, root = null) {
    super("Bridge's database " + (root ? "at " + root + " " : "") + "is not available: " + String(cause?.message || cause).trim().replace(/\.$/, "")
      + (root ? ". Run the command again; if it fails the same way, look at that folder (the server's log is in " + path.join(root, "data", "log") + ")" : ""));
    this.name = "DatabaseUnavailableError";
    this.cause = cause;
    this.root = root;
  }
}

// Fields each fact table holds; the rest of the event stays in run_events.payload, so every field
// is in one place.
const ENVELOPE = ["schema_version", "run_id", "sequence", "occurred_at", "event"];
const TEST_COLUMNS = ["call", "kind", "command", "passed", "exit_code", "timed_out", "duration_ms", "work_version", "stdout_tail", "stderr_tail"];
const REVIEW_COLUMNS = ["call", "gate", "hard_stop", "hard_stop_reason", "verified", "not_run", "source", "verdicts", "findings"];
const FINDING_COLUMNS = ["id", "severity", "path", "line", "reach", "claim", "evidence", "fix", "acceptance_ref", "source"];
const ACCEPTANCE_COLUMNS = ["call", "decision", "review_version", "rows"];

const without = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const orNull = (value) => (value === undefined ? null : value);
const json = (value) => (value === undefined || value === null ? null : JSON.stringify(value));
const text = (value) => (value === undefined || value === null ? null : String(value));

async function testFacts(client, runId, sequence, event) {
  await client.query(
    "insert into test_results (run_id, sequence, call, kind, command, passed, exit_code, timed_out, duration_ms, work_version, stdout_tail, stderr_tail)"
    + " values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
    [runId, sequence, orNull(event.call), event.kind, orNull(event.command), orNull(event.passed), orNull(event.exit_code),
      orNull(event.timed_out), orNull(event.duration_ms), json(event.work_version), orNull(event.stdout_tail), orNull(event.stderr_tail)],
  );
  return without(event, TEST_COLUMNS);
}

async function reviewFacts(client, runId, sequence, event) {
  await client.query(
    "insert into review_results (run_id, sequence, call, gate, hard_stop, hard_stop_reason, verified, not_run, source) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    [runId, sequence, orNull(event.call), orNull(event.gate), orNull(event.hard_stop), orNull(event.hard_stop_reason), json(event.verified), json(event.not_run), orNull(event.source)],
  );
  for (const verdict of event.verdicts || []) {
    await client.query("insert into review_verdicts (run_id, sequence, ac_id, verdict, evidence) values ($1, $2, $3, $4, $5)",
      [runId, sequence, verdict.id, verdict.verdict, orNull(verdict.evidence)]);
  }
  const extras = {};
  for (const finding of event.findings || []) {
    await client.query(
      "insert into review_findings (run_id, sequence, finding_id, severity, path, line, reach, claim, evidence, fix, acceptance_ref, source)"
      + " values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
      [runId, sequence, finding.id, orNull(finding.severity), orNull(finding.path), Number.isInteger(finding.line) ? finding.line : null, orNull(finding.reach),
        orNull(finding.claim), orNull(finding.evidence), orNull(finding.fix), text(finding.acceptance_ref), orNull(finding.source)],
    );
    const rest = without(finding, FINDING_COLUMNS);
    if (!Number.isInteger(finding.line) && finding.line !== undefined && finding.line !== null) rest.line = finding.line;
    if (Object.keys(rest).length) extras[finding.id] = rest;
  }
  const remainder = without(event, REVIEW_COLUMNS);
  return Object.keys(extras).length ? { ...remainder, finding_extras: extras } : remainder;
}

async function acceptanceFacts(client, runId, sequence, event) {
  await client.query("insert into acceptance_decisions (run_id, sequence, call, decision, review_version) values ($1, $2, $3, $4, $5)",
    [runId, sequence, orNull(event.call), event.decision, json(event.review_version)]);
  for (const row of event.rows || []) {
    await client.query(
      "insert into acceptance_rows (run_id, sequence, ac_id, statement, writer, verdict, test, result, evidence) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [runId, sequence, row.id, orNull(row.statement), orNull(row.writer), orNull(row.verdict), row.test, row.result, orNull(row.evidence)],
    );
  }
  return without(event, ACCEPTANCE_COLUMNS);
}

const FACTS = { test_result: testFacts, "review.result": reviewFacts, acceptance: acceptanceFacts };

// The run's state columns, from the run a state event left. superseded_by is not among them: a stop
// is recorded before the version that replaces it exists, and that start links it (recordStart).
const STATE = (run) => [run.status, orNull(run.closed_reason), orNull(run.closed_at), orNull(run.conclusion),
  orNull(run.run_deadline_at), orNull(run.contract_sha256)];

// The state events; every other type is an I/O event.
export const STATE_EVENT_TYPES = Object.freeze([
  "run_started", "state_recorded", "run_terminal", "contract_sealed", "session_rotated", "iteration_incremented", "run_delivered", "budget_extended",
]);

// One line of a run's event file, as the file and the database's record both hold it. Keys are
// sorted, so a file written again from the database holds the same value (DECISIONS 2026-11-03).
export function eventLine(record) {
  return JSON.stringify(canonical(record));
}

// A line with its sequence; a state event's run is at that sequence too.
export function numberedLine(line, sequence) {
  return line.projection
    ? { ...line, sequence, projection: { ...line.projection, last_event_sequence: sequence } }
    : { ...line, sequence };
}

// The database numbered an event other than the sequence it came with (a start's own events, or
// ones kept while the database was gone): nothing of it is written, and its transaction rolls back.
export class SequenceConflictError extends Error {
  constructor(runId, expected, assigned) {
    super("Run " + runId + ": an event numbered " + expected + " is event " + assigned + " in Bridge's database, so it was not written.");
    this.name = "SequenceConflictError";
  }
}

// The database numbers every event, as Temporal's server gives each history event its id: the
// run's row is locked, its last_event_sequence taken one further, and that is the event's sequence
// in the record and in the file line. An entry that already carries a sequence is written only when
// the database gives it the same one (Kafka's idempotent producer: the client sends its sequence,
// the broker checks it). Returns the numbered line, and for an I/O event the sequence of the run's
// I/O event before it (0 for none), so the file can tell whether it holds that one; null when the
// database does not know the run. `late`: written after the fact (replayUnrecorded), marked so on
// the event. A run_delivered event sets the run's delivered_at in the same update.
async function append(client, entry, { late = false } = {}) {
  const state = STATE_EVENT_TYPES.includes(entry.type);
  const sets = (state
    ? ", status = $3, closed_reason = $4, closed_at = $5, conclusion = $6, run_deadline_at = $7, contract_sha256 = $8"
    : "") + (entry.type === "run_delivered" ? ", delivered_at = $2" : "");
  const { rows } = await client.query(
    "update runs set last_event_sequence = last_event_sequence + 1, updated_at = $2" + sets + " where run_id = $1 returning last_event_sequence",
    [entry.runId, entry.occurredAt, ...(state ? STATE(entry.line.projection) : [])],
  );
  if (!rows.length) return null;
  const sequence = rows[0].last_event_sequence;
  if (entry.sequence !== undefined && entry.sequence !== sequence) throw new SequenceConflictError(entry.runId, entry.sequence, sequence);
  const record = numberedLine(entry.line, sequence);
  await client.query("insert into run_events (run_id, sequence, type, occurred_at, payload, recorded_late, record) values ($1, $2, $3, $4, null, $5, $6)",
    [entry.runId, sequence, entry.type, entry.occurredAt, late, record]);
  // A state event is written to its file under the run lock, right after the file was brought up to
  // the database, so it needs no previous one; its line is all it keeps.
  if (state) return { record };
  const body = without(record, ENVELOPE);
  const facts = FACTS[entry.type];
  const payload = facts ? await facts(client, entry.runId, sequence, body) : body;
  await client.query("update run_events set payload = $3 where run_id = $1 and sequence = $2",
    [entry.runId, sequence, Object.keys(payload).length ? payload : null]);
  const before = await client.query(
    "select sequence from run_events where run_id = $1 and sequence < $2 and not (type = any($3)) order by sequence desc limit 1",
    [entry.runId, sequence, STATE_EVENT_TYPES],
  );
  return { record, previous: before.rows.length ? before.rows[0].sequence : 0 };
}

// Events the database could not take while it was gone, kept beside the run's files until the next
// command that opens the database writes them there (replayUnrecorded), in the order they happened.
const unrecordedDir = (paths) => path.join(paths.queueRoot, "unrecorded");
const unrecordedFile = (paths, runId) => path.join(unrecordedDir(paths), runId + ".jsonl");

// The last sequence a run's two event files hold (runStore's eventFile, ioEvents' ioEventFile): every
// line was numbered by the database, so it is the database's last one this machine knows.
async function lastFileSequence(paths, runId) {
  let last = 0;
  for (const file of [path.join(paths.eventsDir, runId + ".jsonl"), path.join(paths.eventsDir, runId + ".io.jsonl")]) {
    const tail = await readLastLine(file);
    let sequence = NaN;
    try { sequence = tail && !tail.torn ? Number(JSON.parse(tail.line).sequence) : NaN; } catch { /* a broken file numbers nothing */ }
    if (Number.isInteger(sequence) && sequence > last) last = sequence;
  }
  return last;
}

// The recorder a command installs; `database` opens the person's database on the first event.
//
// Each event is handed over as its file line without a sequence; the database numbers it and the
// caller writes the numbered line to the file. While a start is being recorded (hold), the new run's
// own events wait for its row, which the start writes: until then nothing else can write to that
// run, so they are numbered from 1 here and written inside the start's transaction (flush), each only
// when the database gives it the same number. A start that does not happen lets them go (drop); its
// run never was in the database, and its files are its record.
//
// When the database is gone (only a run's closing and its delivery go on then), the event that found
// it gone, and every one after it, is numbered one past the last sequence this machine knows from the
// database and kept as unrecorded; the next command that opens the database writes them there, each
// only under the same number (replayUnrecorded). The first one returns `gone`: a step that does not
// close the run stops on it.
export function createRunRecorder(database) {
  let held = null;
  let gone = false;
  const known = new Map();
  const keep = async (paths, entry) => {
    await fsp.mkdir(unrecordedDir(paths), { recursive: true });
    await appendJsonLineDurable(unrecordedFile(paths, entry.runId), entry);
  };
  const write = async (paths, entry) => {
    if (held?.runId === entry.runId) {
      entry.sequence = held.entries.length + 1;
      held.entries.push(entry);
      return { record: numberedLine(entry.line, entry.sequence) };
    }
    let found = null;
    if (!gone) {
      try {
        const appended = await (await database()).transaction((tx) => append(tx, entry));
        if (appended) known.set(entry.runId, appended.record.sequence);
        return appended;
      } catch (error) {
        if (!(error instanceof DatabaseUnavailableError)) throw error;
        gone = true;
        found = error;
      }
    }
    const sequence = (known.has(entry.runId) ? known.get(entry.runId) : await lastFileSequence(paths, entry.runId)) + 1;
    known.set(entry.runId, sequence);
    entry.sequence = sequence;
    await keep(paths, entry);
    return { record: numberedLine(entry.line, sequence), gone: found };
  };
  return {
    // `line`: the event file's line without its sequence. Resolves to { record } (the numbered line),
    // with `previous` for an I/O event the database wrote and `gone` as said above; to null when the
    // database does not know the run, whose files number it.
    record: (paths, line) => write(paths, { runId: line.run_id, type: line.type ?? line.event, occurredAt: line.occurred_at, line }),
    hold(runId) { held = { runId, entries: [] }; },
    async flush(tx) {
      const entries = held?.entries || [];
      held = null;
      for (const entry of entries) {
        if (!(await append(tx, entry))) throw new Error("Run " + entry.runId + " has no row in Bridge's database; its start is refused.");
      }
    },
    drop() { held = null; },
  };
}

let installed = null;
let installedDatabase = null;
// The command's recorder and how it opens the database; null in a process that keeps no records (a
// unit test of the files alone, or a project set up before it had an id), which reads its files.
export function installRunRecorder(recorder, database = null) {
  installed = recorder;
  installedDatabase = database;
}
export function runRecorder() { return installed; }
export function recordsDatabase() { return installedDatabase; }

// Q12: a project's runs, newest first, one page; `after` is the last run id of the page before.
export async function projectRuns(db, projectId, { limit = 10, after = null } = {}) {
  const { rows } = await db.query(
    "select r.run_id, r.status, r.conclusion, r.closed_reason, r.created_at, r.closed_at, r.updated_at, p.source_file,"
    + " p.body->>'work_package_id' as work_package_id, a.authorized_via"
    + " from runs r join plans p using (plan_sha256) left join authorizations a on a.plan_sha256 = r.plan_sha256 and a.kind = 'start'"
    + " where r.project_id = $1 and ($3::uuid is null or (r.created_at, r.run_id) < (select created_at, run_id from runs where run_id = $3::uuid))"
    + " order by r.created_at desc, r.run_id desc limit $2",
    [projectId, limit + 1, after],
  );
  return { runs: rows.slice(0, limit), more: rows.length > limit };
}

// Q6: the project's running runs.
export async function activeRuns(db, projectId) {
  return (await db.query("select run_id, work_order_id, content_sha256, status from runs where project_id = $1 and status = 'in_progress' order by created_at", [projectId])).rows;
}

// The running runs of one work order (a start replaces them; an unchanged one refuses the start).
export async function activeRunsOfWorkOrder(db, workOrderId) {
  return (await db.query("select run_id, content_sha256 from runs where work_order_id = $1 and status = 'in_progress'", [workOrderId])).rows;
}

// A project's ended runs without a delivery, oldest first, at most `limit`.
export async function undeliveredRuns(db, projectId, { limit = 50 } = {}) {
  return (await db.query("select run_id from runs where project_id = $1 and status = 'completed' and delivered_at is null"
    + " order by closed_at limit $2", [projectId, limit])).rows;
}

// One run as work-status shows it: its state, its work order version and contract, the yes, the
// plan's stop point, scope and budget, and the last stop the controller recorded.
export async function runDetail(db, runId) {
  const { rows } = await db.query(
    "select r.run_id, r.status, r.conclusion, r.closed_reason, r.created_at, r.closed_at, r.updated_at, r.execution_mode, r.contract_sha256,"
    + " r.work_order_id, v.version_no, v.title, p.source_file, p.body->'breakpoint' as breakpoint, p.body->'scope' as scope, p.body->'budget' as budget,"
    + " p.body->'budget_source' as budget_source, p.body->'priority' as priority, p.body->'priority_source' as priority_source,"
    + " p.body->'effort' as effort, p.body->'effort_source' as effort_source, p.body->'test' as test, r.timeout_at,"
    + " a.authorized_by, a.authorized_via,"
    + " (select payload from run_events e where e.run_id = r.run_id and e.type = 'stop' order by sequence desc limit 1) as last_stop"
    + " from runs r join plans p using (plan_sha256) join work_order_versions v on v.work_order_id = r.work_order_id and v.content_sha256 = r.content_sha256"
    + " left join authorizations a on a.plan_sha256 = r.plan_sha256 and a.kind = 'start' where r.run_id = $1",
    [runId],
  );
  return rows[0] || null;
}

// The run's last sequence, by its primary key: the position its event files are compared with, as a
// Kafka consumer compares its offset with the log's end. null when the database does not know the run.
export async function lastEventSequence(db, runId) {
  const { rows } = await db.query("select last_event_sequence from runs where run_id = $1", [runId]);
  return rows.length ? rows[0].last_event_sequence : null;
}

// The lines one of a run's event files lacks after `after` (0: all of them), in order: its state
// events (`state`) or its I/O events. A file behind takes these; a missing or broken one is written
// again from all of them. null when one of them was written before events kept their line.
export async function eventRecordsAfter(db, runId, after, state) {
  const { rows } = await db.query(
    "select record from run_events where run_id = $1 and sequence > $2 and (type = any($3)) = $4 order by sequence",
    [runId, after, STATE_EVENT_TYPES, state],
  );
  return rows.every((row) => row.record !== null) ? rows.map((row) => row.record) : null;
}

// An entry kept before entries carried their file line (an older unrecorded file): the line made
// from what it kept, numbered by the database as it is written.
function keptEntry(entry) {
  if (entry.line) return entry;
  const { substantive, ...details } = entry.body || {};
  const line = entry.state
    ? { schema_version: 4, run_id: entry.runId, type: entry.type, occurred_at: entry.occurredAt, substantive: substantive !== false, details, projection: entry.state }
    : { schema_version: 1, run_id: entry.runId, occurred_at: entry.occurredAt, event: entry.type, ...(entry.body || {}) };
  return { runId: entry.runId, type: entry.type, occurredAt: entry.occurredAt, line };
}

// The events a run kept while the database was gone, written now in their order, each under the
// number it was kept with (Kafka's idempotent producer). Each file is moved aside before it is read,
// so a run still keeping events starts a new one that the next pass writes. A run the database does
// not know is left to its files.
//
// When the database numbers one of them otherwise (the files were behind it when it went), none of
// that run's events are written: the run's files are written again from the database (`rebuild`)
// and the events stay beside them as <run>.jsonl.refused-<time>, said on stderr. Returns how many
// events were written and runs refused, so a caller knows to read again.
export async function replayUnrecorded(db, paths, { rebuild = null } = {}) {
  let names;
  try {
    names = (await fsp.readdir(unrecordedDir(paths))).filter((name) => name.endsWith(".jsonl"));
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  let changed = 0;
  for (const name of names) {
    const original = path.join(unrecordedDir(paths), name);
    const taken = original + ".replaying-" + process.pid;
    try {
      await fsp.rename(original, taken);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const entries = (await fsp.readFile(taken, "utf8")).split("\n").filter((line) => line.trim()).map((line) => keptEntry(JSON.parse(line)));
    let written = 0;
    try {
      await db.transaction(async (tx) => {
        written = 0;
        for (const entry of entries) if (await append(tx, entry, { late: true })) written += 1;
      });
    } catch (error) {
      if (!(error instanceof SequenceConflictError)) throw error;
      const runId = name.slice(0, -".jsonl".length);
      try {
        await rebuild?.(runId);
      } catch (rebuildError) {
        // Tried again by the next command that opens the database, unless the run kept new events meanwhile.
        if (!(await fsp.access(original).then(() => true, () => false))) await fsp.rename(taken, original);
        throw rebuildError;
      }
      const refused = original + ".refused-" + Date.now();
      await fsp.rename(taken, refused);
      process.stderr.write(error.message + " The events this machine kept while Bridge's database was gone do not follow it; they were not"
        + " written, the run's files were written again from the database, and the events are kept in " + refused + "\n");
      changed += 1;
      continue;
    }
    changed += written;
    await fsp.rm(taken, { force: true });
  }
  return changed;
}

// clean <run_id>: the run and every row it owns, in one delete; its authorization and claim stay.
export async function deleteRunRecords(db, runId) {
  return (await db.query("delete from runs where run_id = $1", [runId])).rowCount;
}

// The new run's row, written by the start's transaction before its held events are flushed.
export async function insertRun(tx, { run, projectId, workOrderId, contentSha256, planSha256, repoRoot }) {
  await tx.query(
    "insert into runs (run_id, project_id, work_order_id, content_sha256, plan_sha256, effective_policy_sha256, repo_root, authorized_by,"
    + " execution_mode, budget, created_at, status, last_event_sequence, updated_at, timeout_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0, $11, $13)",
    [run.run_id, projectId, workOrderId, contentSha256, planSha256, run.effective_policy_sha256, repoRoot, run.authorized_by,
      run.execution_mode, run.budget, run.created_at, run.status, orNull(run.timeout_at)],
  );
}
