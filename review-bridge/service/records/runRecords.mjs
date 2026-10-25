// Every fact a run writes also goes into the person's database (RC3-BLOCKER-01 step 3): the run, its
// one ordered timeline (state events and I/O events in one sequence), Gate A, the review's verdicts
// and findings, Bridge's acceptance decision, the delivery. appendProjectionEvent and appendIoEvent
// hand each event to the recorder a command installed; the files stay the running copy and are still
// what is read until step 4.
//
// One event is one transaction: the run's row is locked, the next sequence taken, the event and its
// facts written, and the run's state columns set from the same event, so they never disagree. A run
// the database does not know (started before Bridge kept its records there) is left to its files.

// Fields each fact table holds; the rest of the event stays in run_events.payload, so every field
// is in one place.
const ENVELOPE = ["schema_version", "run_id", "sequence", "occurred_at", "event"];
const GATE_A_COLUMNS = ["call", "kind", "command", "passed", "exit_code", "timed_out", "duration_ms", "work_version", "stdout_tail", "stderr_tail"];
const REVIEW_COLUMNS = ["call", "gate", "hard_stop", "hard_stop_reason", "verified", "not_run", "source", "verdicts", "findings"];
const FINDING_COLUMNS = ["id", "severity", "path", "line", "reach", "claim", "evidence", "fix", "acceptance_ref", "source"];
const ACCEPTANCE_COLUMNS = ["call", "decision", "review_version", "rows"];

const without = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const orNull = (value) => (value === undefined ? null : value);
const json = (value) => (value === undefined || value === null ? null : JSON.stringify(value));
const text = (value) => (value === undefined || value === null ? null : String(value));

async function gateAFacts(client, runId, sequence, event) {
  await client.query(
    "insert into gate_a_results (run_id, sequence, call, kind, command, passed, exit_code, timed_out, duration_ms, work_version, stdout_tail, stderr_tail)"
    + " values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
    [runId, sequence, orNull(event.call), event.kind, orNull(event.command), orNull(event.passed), orNull(event.exit_code),
      orNull(event.timed_out), orNull(event.duration_ms), json(event.work_version), orNull(event.stdout_tail), orNull(event.stderr_tail)],
  );
  return without(event, GATE_A_COLUMNS);
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
      "insert into acceptance_rows (run_id, sequence, ac_id, statement, writer, verdict, gate_a, result, evidence) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [runId, sequence, row.id, orNull(row.statement), orNull(row.writer), orNull(row.verdict), row.gate_a, row.result, orNull(row.evidence)],
    );
  }
  return without(event, ACCEPTANCE_COLUMNS);
}

const FACTS = { gate_a_result: gateAFacts, "review.result": reviewFacts, acceptance: acceptanceFacts };

// The run's state columns, from the projection the state event wrote.
const STATE = (run) => [run.status, orNull(run.closed_reason), orNull(run.closed_at), orNull(run.superseded_by), orNull(run.outcome),
  orNull(run.run_deadline_at), orNull(run.contract_sha256)];

async function append(client, entry) {
  const sets = entry.state
    ? ", status = $3, closed_reason = $4, closed_at = $5, superseded_by = $6, outcome = $7, run_deadline_at = $8, contract_sha256 = $9"
    : "";
  const { rows } = await client.query(
    "update runs set last_event_sequence = last_event_sequence + 1, updated_at = $2" + sets + " where run_id = $1 returning last_event_sequence",
    [entry.runId, entry.occurredAt, ...(entry.state ? STATE(entry.state) : [])],
  );
  if (!rows.length) return false;
  const sequence = rows[0].last_event_sequence;
  await client.query("insert into run_events (run_id, sequence, type, occurred_at, payload) values ($1, $2, $3, $4, null)",
    [entry.runId, sequence, entry.type, entry.occurredAt]);
  const facts = FACTS[entry.type];
  const payload = facts ? await facts(client, entry.runId, sequence, entry.body) : entry.body;
  await client.query("update run_events set payload = $3 where run_id = $1 and sequence = $2",
    [entry.runId, sequence, Object.keys(payload).length ? payload : null]);
  return true;
}

// The recorder a command installs; `database` opens the person's database on the first event. While a
// start is being recorded (hold), events are kept and written inside the start's own transaction
// once the new run's row exists (flush): an earlier version's run is closed as superseded by it in
// the same transaction.
export function createRunRecorder(database) {
  let held = null;
  const write = async (entry) => {
    if (held) {
      held.push(entry);
      return;
    }
    await (await database()).transaction((tx) => append(tx, entry));
  };
  return {
    projection: ({ run, type, details, occurredAt, substantive }) => write({
      runId: run.run_id, type, occurredAt, state: run, body: { ...(details || {}), ...(substantive ? {} : { substantive: false }) },
    }),
    io: (record) => write({ runId: record.run_id, type: record.event, occurredAt: record.occurred_at, state: null, body: without(record, ENVELOPE) }),
    hold() { held = []; },
    async flush(tx) {
      const entries = held || [];
      held = null;
      for (const entry of entries) await append(tx, entry);
    },
    drop() { held = null; },
  };
}

let installed = null;
// The command's recorder; null in a process that keeps no records (a unit test of the files alone).
export function installRunRecorder(recorder) { installed = recorder; }
export function runRecorder() { return installed; }

// clean <run_id>: the run and every row it owns, in one delete; its authorization and claim stay.
export async function deleteRunRecords(db, runId) {
  return (await db.query("delete from runs where run_id = $1", [runId])).rowCount;
}

// The new run's row, written by the start's transaction before its held events are flushed.
export async function insertRun(tx, { run, projectId, workOrderId, contentSha256, planSha256, repoRoot }) {
  await tx.query(
    "insert into runs (run_id, project_id, work_order_id, content_sha256, plan_sha256, effective_policy_sha256, repo_root, authorized_by,"
    + " execution_mode, budget, created_at, status, last_event_sequence, updated_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0, $11)",
    [run.run_id, projectId, workOrderId, contentSha256, planSha256, run.effective_policy_sha256, repoRoot, run.authorized_by,
      run.execution_mode, run.budget, run.created_at, run.status],
  );
}
