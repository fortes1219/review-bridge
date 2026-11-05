import fsp from "node:fs/promises";
import path from "node:path";

import { pruneDayFiles } from "./dayFiles.mjs";
import { DAY_MS } from "../../utils/dates.mjs";

// T0-11 C3: reviewer read-only check records, one day file per local day like the run archive.
export function probeAuditDir(paths) {
  return paths.probeAuditDir;
}

// The reviewer check records: the day files, and the single file versions before T0-11 wrote
// (reviewer-probe-audit.json next to the folder), which goes once it is older than the window.
export async function pruneProbeRecords(auditDir, days, now) {
  let deleted = await pruneDayFiles(auditDir, days, now);
  const legacy = path.join(path.dirname(auditDir), "reviewer-probe-audit.json");
  const stat = await fsp.stat(legacy).catch(() => null);
  if (stat?.isFile() && now - stat.mtimeMs > days * DAY_MS) {
    await fsp.rm(legacy, { force: true });
    deleted += 1;
  }
  return deleted;
}
