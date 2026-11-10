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

// The database has had migrations this Bridge does not have: a newer Bridge opened it, or a file was taken
// away. As Knex's validateMigrationList refuses ("The migration directory is corrupt, the following files
// are missing"), nothing is opened, backed up or applied (Owner 2026-11-09: never downgrade).
export const UNKNOWN_MIGRATIONS_CODE = "BRIDGE_UNKNOWN_MIGRATIONS";

export class UnknownMigrationsError extends Error {
  constructor(names) {
    super("This database has had migrations this Review Bridge does not have (" + names.join(", ") + "): a newer Review Bridge opened it,"
      + " or a migration file was removed. Nothing in it was changed. Install the newer version again: npm i -g review-bridge@latest");
    this.name = "UnknownMigrationsError";
    this.code = UNKNOWN_MIGRATIONS_CODE;
    this.names = names;
  }
}

// A failure the person can act on, in `error` itself or as the cause openDatabase wrapped it in.
const failureIn = (error, code) => [error, error?.cause].find((entry) => entry?.code === code) ?? null;
export const oldServerIn = (error) => failureIn(error, OLD_SERVER_CODE);
export const unknownMigrationsIn = (error) => failureIn(error, UNKNOWN_MIGRATIONS_CODE);
export const translatedFailure = (error) => Boolean(oldServerIn(error) || unknownMigrationsIn(error));

// The line the entry prints for a failure: the translated sentence for these, the message otherwise.
export function failureLine(error, t) {
  const old = oldServerIn(error);
  if (old && t) return t("database.old_server", { file: old.logFile });
  const unknown = unknownMigrationsIn(error);
  if (unknown && t) return t("database.unknown_migrations", { names: unknown.names.join(", ") });
  return "Review bridge failed closed: " + (error?.message ?? String(error));
}
