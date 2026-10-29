// `backup`: a copy of the person's database, for all their projects (RC3-BLOCKER-01 step 5). The
// database modules load pg and the server binaries, so they are imported only when this runs.
export async function backupDatabase({ out = process.stdout } = {}) {
  const { BackupRefusedError, backupDatabase: backup } = await import("../../service/database/backup.mjs");
  try {
    const result = await backup();
    out.write([
      "Backed up the database to " + result.path,
      "To restore it, copy its postgres folder into an empty folder, set REVIEW_BRIDGE_DATA_HOME to that folder, and run Bridge.",
      "",
    ].join("\n"));
    return 0;
  } catch (error) {
    if (!(error instanceof BackupRefusedError)) throw error;
    out.write(error.message + "\n");
    return 1;
  }
}
