// <YYYY-MM-DD>.jsonl day files: how long they are kept and how old ones go.
import fsp from "node:fs/promises";
import path from "node:path";

import { localDateKey, olderThan } from "../../utils/dates.mjs";
import { listFiles } from "./fileStore.mjs";

export const DEFAULT_RETENTION_DAYS = 15;

export class RetentionConfigError extends Error {}

// bridge.json `retention.days`: how many days of day files are kept.
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

// Deletes <YYYY-MM-DD>.jsonl day files whose whole day ended more than `days` ago; never today's.
export async function pruneDayFiles(directory, days, now) {
  const today = localDateKey(now);
  let deleted = 0;
  for (const file of await listFiles(directory)) {
    const key = path.basename(file, ".jsonl");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || key === today || !file.endsWith(".jsonl")) continue;
    if (olderThan(key + "T23:59:59", days, now)) { await fsp.rm(file, { force: true }); deleted += 1; }
  }
  return deleted;
}
