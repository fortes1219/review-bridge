// The run archive: one <state>/archive/<YYYY-MM-DD>.jsonl per local day, appended only.
import fsp from "node:fs/promises";
import path from "node:path";

import { localDateKey } from "../../utils/dates.mjs";
import { ensureDir } from "./fileStore.mjs";

export const ARCHIVE_SCHEMA_VERSION = 1;

export function archiveFileForDate(paths, value) {
  return path.join(paths.archiveDir, localDateKey(value) + ".jsonl");
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
