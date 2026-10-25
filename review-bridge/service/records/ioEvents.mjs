// Per-run I/O event log (T0-04 D6): task.input, handoff, read, usage, stop.
// Kept apart from the projection event log, which has its own sequence contract.
// Append-only, fsynced, one JSON line per event.
import fsp from "node:fs/promises";
import path from "node:path";

import { appendJsonLineDurable } from "./fileStore.mjs";
import { DatabaseUnavailableError, runRecorder } from "./runRecords.mjs";

export const IO_EVENT_SCHEMA_VERSION = 1;
export const IO_EVENT_TYPES = Object.freeze([
  "task.input", "handoff", "read", "usage", "stop",
  "writer.result", "review.input", "review.result", "recheck",
  "gate_a_result", "fix.input", "contract.translation", "contract.check", "contract.sealed", "acceptance",
  "notified", "delivery_skipped",
]);

export function ioEventFile(paths, runId) {
  if (!/^[A-Za-z0-9-]{8,80}$/.test(String(runId || ""))) throw new Error("Invalid run id for I/O events.");
  return path.join(paths.eventsDir, runId + ".io.jsonl");
}

export async function readIoEvents(paths, runId) {
  const text = await fsp.readFile(ioEventFile(paths, runId), "utf8").catch(() => "");
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* a torn tail is ignored; the next append continues the sequence */ }
  }
  return events;
}

export async function appendIoEvent(paths, runId, event, clock = Date.now) {
  if (!IO_EVENT_TYPES.includes(event?.event)) throw new Error("Unknown I/O event type: " + String(event?.event));
  const previous = await readIoEvents(paths, runId);
  const record = {
    schema_version: IO_EVENT_SCHEMA_VERSION,
    run_id: runId,
    sequence: previous.length + 1,
    occurred_at: new Date(clock()).toISOString(),
    ...event,
  };
  // The database first (RC3-BLOCKER-01 step 3); the file line is the running copy. When the database
  // is gone the line is still written, then the run is told (it stops).
  let gone = null;
  try {
    await runRecorder()?.io(paths, record);
  } catch (error) {
    if (!(error instanceof DatabaseUnavailableError)) throw error;
    gone = error;
  }
  await appendJsonLineDurable(ioEventFile(paths, runId), record);
  if (gone) throw gone;
  return record;
}

// Token total the ceilings are measured against (D4.1).
export function tokenTotal(tokens) {
  return ["input", "cache_write", "cache_read", "output"]
    .map((key) => (Number.isFinite(tokens?.[key]) ? tokens[key] : 0))
    .reduce((sum, value) => sum + value, 0);
}

// T0-05 D5.3: the per-run ceiling counts writer and reviewer together unless a role is given.
export async function usageTotalForRun(paths, runId, role = null) {
  const events = await readIoEvents(paths, runId);
  return events
    .filter((event) => event.event === "usage" && (role === null || event.role === role))
    .reduce((sum, event) => sum + tokenTotal(event.tokens), 0);
}
