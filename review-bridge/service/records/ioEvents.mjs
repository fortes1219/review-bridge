// Per-run I/O event log (T0-04 D6): task.input, handoff, read, usage, stop.
// Kept apart from the projection event log; the database numbers both in the run's one sequence.
// Append-only, fsynced, one JSON line per event. The database keeps every line (DECISIONS
// 2026-11-03, B): the file is its copy, brought up to it by position on every read.
import fsp from "node:fs/promises";
import path from "node:path";

import { appendTextDurable, readLastLine, writeTextAtomicDurable } from "./fileStore.mjs";
import {
  DatabaseUnavailableError, eventLine, eventRecordsAfter, lastEventSequence, numberedLine, recordsDatabase, replayUnrecorded, runRecorder,
  runUsageTotal, tokenTotal,
} from "./runRecords.mjs";
import { rebuildRunFiles, RunFilesAheadError, writeUnderRunLock } from "./runStore.mjs";

export const IO_EVENT_SCHEMA_VERSION = 1;
export const IO_EVENT_TYPES = Object.freeze([
  "task.input", "handoff", "read", "usage", "stop",
  "writer.result", "review.input", "review.result", "recheck",
  "test_result", "fix.input", "contract.translation", "contract.check", "contract.sealed", "acceptance",
  "notified", "delivery_skipped",
]);

export function ioEventFile(paths, runId) {
  if (!/^[A-Za-z0-9-]{8,80}$/.test(String(runId || ""))) throw new Error("Invalid run id for I/O events.");
  return path.join(paths.eventsDir, runId + ".io.jsonl");
}

// The file's events, and where it stands: the sequence of its last line (0 when it has none), or
// null when it is broken (a torn or unreadable line, or a sequence that does not grow).
function parseFile(text) {
  const events = [];
  let broken = text !== "" && !text.endsWith("\n");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (!Number.isInteger(event.sequence) || event.sequence <= (events.at(-1)?.sequence ?? 0)) broken = true;
      events.push(event);
    } catch {
      broken = true;
    }
  }
  return { events, position: broken ? null : events.at(-1)?.sequence ?? 0 };
}

const fileText = (paths, runId) => fsp.readFile(ioEventFile(paths, runId), "utf8").catch(() => "");
const eventText = (records) => records.map((record) => eventLine(record) + "\n").join("");

// The run's I/O events. With records, the file is kept by position, as the state event file is
// (reconcileRunProjection): the run's last sequence is asked for by primary key; a file at it is used
// as it is; one behind takes only the I/O events after its last line (none: the events since are
// state events); a missing one takes them all; a broken one is written again whole; one ahead is
// refused, after the events kept while the database was gone are written to it. The file is written
// under the run lock (`locked`: the caller holds it), or not at all when another process holds it;
// the database's events are returned either way. Without the database (`databaseGone: "files"`, the
// default) the file is read unchecked; "refuse" throws. A process that keeps no records, a run the
// database does not know, and one with I/O events from before they kept their line read the file.
export async function readIoEvents(paths, runId, { databaseGone = "files", locked = false } = {}) {
  const database = recordsDatabase();
  let file = parseFile(await fileText(paths, runId));
  if (!database) return file.events;
  let db;
  let last;
  try {
    db = await database();
    last = await lastEventSequence(db, runId);
  } catch (error) {
    if (!(error instanceof DatabaseUnavailableError) || databaseGone === "refuse") throw error;
    return file.events;
  }
  if (last === null) return file.events;
  if (file.position > last && await replayUnrecorded(db, paths, { rebuild: (id) => rebuildRunFiles(paths, id, db) })) {
    last = await lastEventSequence(db, runId);
    file = parseFile(await fileText(paths, runId));
  }
  if (file.position > last) throw new RunFilesAheadError(runId, file.position, last, ioEventFile(paths, runId), "I/O event");
  if (file.position === last) return file.events;
  const records = await eventRecordsAfter(db, runId, file.position ?? 0, false);
  if (records === null || (file.position !== null && !records.length)) return file.events;
  await writeUnderRunLock(paths, runId, locked, () => (file.position === null
    ? writeTextAtomicDurable(ioEventFile(paths, runId), eventText(records))
    : appendTextDurable(ioEventFile(paths, runId), eventText(records))));
  return file.position === null ? records : [...file.events, ...records];
}

// The sequence of the file's last line, read from its end: 0 when it has none, null when it is torn
// or unreadable.
async function lastSequence(file) {
  const tail = await readLastLine(file);
  if (!tail) return 0;
  try {
    const sequence = tail.torn ? null : JSON.parse(tail.line).sequence;
    return Number.isInteger(sequence) ? sequence : null;
  } catch {
    return null;
  }
}

export async function appendIoEvent(paths, runId, event, clock = Date.now) {
  if (!IO_EVENT_TYPES.includes(event?.event)) throw new Error("Unknown I/O event type: " + String(event?.event));
  const file = ioEventFile(paths, runId);
  const line = {
    schema_version: IO_EVENT_SCHEMA_VERSION,
    run_id: runId,
    occurred_at: new Date(clock()).toISOString(),
    ...event,
  };
  // The database first (RC3-BLOCKER-01 step 3): it numbers the event; the file takes the numbered
  // line. A run the database does not know, and a process that keeps no records, number it from the
  // file. When the database is gone the line is numbered provisionally and still written, then the
  // run is told (it stops).
  const recorded = await runRecorder()?.record(paths, line);
  const record = recorded?.record ?? numberedLine(line, (parseFile(await fileText(paths, runId)).events.at(-1)?.sequence ?? 0) + 1);
  if (recorded?.previous === undefined) {
    await appendTextDurable(file, eventLine(record) + "\n");
  } else {
    // The file takes the line only right after the I/O event before it (Kafka's idempotent producer):
    // a line it already holds (a read brought it up from the database) is not written twice, and a
    // file missing lines before it is brought up from the database, this line with them.
    const position = await lastSequence(file);
    if (position === recorded.previous) await appendTextDurable(file, eventLine(record) + "\n");
    else if (position === null || position < record.sequence) await readIoEvents(paths, runId);
  }
  if (recorded?.gone) throw recorded.gone;
  return record;
}

// T0-05 D5.3: the per-run ceiling counts writer and reviewer together. With records it is the run's
// running total, read by primary key (RC3-FIX-01); a process that keeps no records, a run the database
// does not know, and a database that cannot be reached sum the file's usage events, as before.
export async function usageTotalForRun(paths, runId) {
  const database = recordsDatabase();
  if (database) {
    try {
      const total = await runUsageTotal(await database(), runId);
      if (total !== null) return total;
    } catch (error) {
      if (!(error instanceof DatabaseUnavailableError)) throw error;
    }
  }
  const events = parseFile(await fileText(paths, runId)).events;
  return events.filter((event) => event.event === "usage").reduce((sum, event) => sum + tokenTotal(event.tokens), 0);
}
