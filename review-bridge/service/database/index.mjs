// The person's database, as the commands use it: the cluster is created on first use, the server is
// started when it is not running (it stays running for later commands), the `bridge` database is
// created once, and the migrations are applied. One pool per process; it lets the process exit when
// it is idle, so a command never has to close it.
import pg from "pg";

import { BackupRefusedError, backupDatabase, runLines } from "./backup.mjs";
import { bridgeDataHome, databaseRoot } from "./dataHome.mjs";
import { applyMigrations, migrationState, MIGRATIONS_DIR } from "./migrate.mjs";
import { DatabaseUnavailableError } from "../records/runRecords.mjs";
import { clusterPaths, connect, connectionSettings, ensureCluster, postgresBinaries, startServer } from "./postgresServer.mjs";

export const DATABASE_NAME = "bridge";
const opened = new Map();

async function ensureDatabase(root) {
  const admin = await connect(root);
  try {
    const { rows } = await admin.query("select 1 from pg_database where datname = $1", [DATABASE_NAME]);
    if (rows.length) return;
    // Two commands may create it at once; the loser sees 42P04 and uses the winner's.
    await admin.query("create database " + DATABASE_NAME).catch((error) => { if (error.code !== "42P04") throw error; });
  } finally {
    await admin.end();
  }
}

// An upgraded Bridge backs up the database before its first new migration (Owner 2026-10-29): a
// database that has had migrations and is about to get more. A new database has nothing to keep,
// and a running run refuses it, so no table changes before the copy exists. Returns the backup's
// folder, or null when there was nothing to back up.
export async function backUpBeforeMigrating(root, { dataHome, dir = MIGRATIONS_DIR } = {}) {
  const client = await connect(root, { database: DATABASE_NAME });
  let state;
  try {
    state = await migrationState(client, { dir });
  } finally {
    await client.end();
  }
  if (!state.applied || !state.pending.length) return null;
  try {
    return (await backupDatabase({ dataHome })).path;
  } catch (error) {
    if (!(error instanceof BackupRefusedError) || !error.runs.length) throw error;
    throw new BackupRefusedError("Bridge backs up the database before it applies " + state.pending.length + " new migration(s), and a run is running."
      + " Let it end, or stop it with review-bridge stop <run_id> in its project, then run the command again.\n" + runLines(error.runs), error.runs);
  }
}

async function open(dataHome, dir) {
  const root = databaseRoot(dataHome);
  const binaries = await postgresBinaries();
  await ensureCluster(root, { binaries });
  await startServer(root, { binaries });
  await ensureDatabase(root);
  const backup = await backUpBeforeMigrating(root, { dataHome, dir });
  // stderr: a command's stdout may be JSON.
  if (backup) process.stderr.write("Backed up the database to " + backup + " before upgrading it.\n");
  const pool = new pg.Pool({ ...(await connectionSettings(root, { database: DATABASE_NAME })), max: 4, allowExitOnIdle: true, idleTimeoutMillis: 1000 });
  // A connection the server ends between queries is reported here; the next query reports it again.
  pool.on("error", () => {});
  const client = await pool.connect();
  try {
    await applyMigrations(client, { dir });
  } finally {
    client.release();
  }
  const settings = await connectionSettings(root, { database: DATABASE_NAME });
  return {
    root,
    // What a person needs to look at the tables (VS Code's PostgreSQL extension, psql); the
    // password stays in its owner-only file.
    connection: { host: settings.host, port: settings.port, database: DATABASE_NAME, user: settings.user, passwordFile: clusterPaths(root).secret },
    query: (sql, values) => pool.query(sql, values).catch((error) => { throw unavailable(error); }),
    // fn gets a client inside begin/commit; anything it throws rolls the whole transaction back.
    async transaction(fn) {
      const tx = await pool.connect().catch((error) => { throw unavailable(error); });
      try {
        await tx.query("begin");
        const result = await fn(tx);
        await tx.query("commit");
        return result;
      } catch (error) {
        await tx.query("rollback").catch(() => {});
        throw unavailable(error);
      } finally {
        tx.release();
      }
    },
    close: () => pool.end(),
  };
}

// A server that is gone, stopping or not answering (as opposed to a refused statement).
const GONE = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "57P01", "57P02", "57P03"]);
function unavailable(error) {
  const gone = GONE.has(error?.code) || /^08/.test(String(error?.code || "")) || /Connection terminated|connection.*(ended|closed)/i.test(String(error?.message));
  return gone && !(error instanceof DatabaseUnavailableError) ? new DatabaseUnavailableError(error) : error;
}

// Fails closed: without the database no work order is planned or started. `migrationsDir` is for tests.
export async function openDatabase({ dataHome = bridgeDataHome(), migrationsDir = MIGRATIONS_DIR } = {}) {
  if (!opened.has(dataHome)) {
    opened.set(dataHome, open(dataHome, migrationsDir).catch((error) => {
      opened.delete(dataHome);
      // A refusal to upgrade while a run is running is said as it is, not as a database gone away.
      if (error instanceof BackupRefusedError) throw error;
      throw new DatabaseUnavailableError(error, databaseRoot(dataHome));
    }));
  }
  return await opened.get(dataHome);
}
