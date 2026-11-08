// The database failure a person can act on, kept apart from the server module so the command entry can
// recognise it without loading pg or the server binaries. PostgreSQL's own words stay in the file pg_ctl
// wrote them to (its -l file in the cluster's folder); the person reads one sentence in the project's
// language that points first at Bridge's own command and only then at a restart (Owner 2026-11-07 15:2x).
export const OLD_SERVER_CODE = "BRIDGE_OLD_SERVER";

export class OldServerError extends Error {
  constructor(logFile, detail = "") {
    super("PostgreSQL did not start: the server was not shut down properly last time and processes it left are still running;"
      + " Bridge cannot clear them safely. Restart the computer and run this again"
      + (detail ? " (" + detail + ")" : "") + ". Details are in " + logFile + ".");
    this.name = "OldServerError";
    this.code = OLD_SERVER_CODE;
    this.logFile = logFile;
  }
}

// The old-server failure in `error`, itself or as the cause openDatabase wrapped it in.
export const oldServerIn = (error) => [error, error?.cause].find((entry) => entry?.code === OLD_SERVER_CODE) ?? null;

// The line the entry prints for a failure: the translated sentence for this one, the message otherwise.
export function failureLine(error, t) {
  const old = oldServerIn(error);
  if (old && t) return t("database.old_server", { file: old.logFile });
  return "Review bridge failed closed: " + (error?.message ?? String(error));
}
