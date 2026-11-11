// The person's database, as the commands use it: the cluster is created on first use, the server is
// started when it is not running (it stays running for later commands), the `bridge` database is
// created once, and the migrations are applied. One pool per process; it lets the process exit when
// it is idle, so a command never has to close it.
import pg from "pg";

import { BackupRefusedError, backupDatabase, runLines, runningRuns } from "./backup.mjs";
import { bridgeDataHome, databaseRoot } from "./dataHome.mjs";
import { applyMigrations, migrationState, MIGRATIONS_DIR } from "./migrate.mjs";
import { DatabaseUnavailableError } from "../records/runRecords.mjs";
import { databaseBackedUp } from "./notices.mjs";
import { UnknownMigrationsError } from "./serverErrors.mjs";
import {
  clearOldServer, clusterPaths, connect, connectionSettings, dataDirectoryProblem, ensureCluster, postgresBinaries, serverState, startServer, stopServer,
} from "./postgresServer.mjs";
import { bridgeRunner } from "../../utils/bridgeCommand.mjs";

export const DATABASE_NAME = "bridge";
const opened = new Map();

// Several commands may open the database for the first time at once (two page services, up and start).
// The look and the create run under a session-level advisory lock on the admin connection, as
// supabase/cli creates its webhook schema (apps/cli db-setup.ts:636-664: pg_advisory_lock(hashtext(...)),
// check, create only when missing, unlock): the one that waits finds the database made. CREATE DATABASE
// cannot run in a transaction, so the lock is the session's, released before the connection ends.
const CREATE_DATABASE_LOCK = "review-bridge.create-database";
async function ensureDatabase(root) {
  const admin = await connect(root);
  try {
    await admin.query("select pg_advisory_lock(hashtext($1))", [CREATE_DATABASE_LOCK]);
    try {
      const { rows } = await admin.query("select 1 from pg_database where datname = $1", [DATABASE_NAME]);
      if (!rows.length) await admin.query("create database " + DATABASE_NAME);
    } finally {
      await admin.query("select pg_advisory_unlock(hashtext($1))", [CREATE_DATABASE_LOCK]).catch(() => {});
    }
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
      + " Let it end, or stop it with " + bridgeRunner() + " stop <run_id> in its project, then run the command again.\n" + runLines(error.runs), error.runs);
  }
}

async function open(dataHome, dir) {
  const root = databaseRoot(dataHome);
  const binaries = await postgresBinaries();
  await ensureCluster(root, { binaries });
  await startServer(root, { binaries });
  await ensureDatabase(root);
  const backup = await backUpBeforeMigrating(root, { dataHome, dir });
  // One line, in the project's language when the command entry gave it (notices.mjs).
  if (backup) await databaseBackedUp(backup);
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
      // A refusal to upgrade while a run is running, or to open a database a newer Bridge migrated, is said
      // as it is, not as a database gone away.
      if (error instanceof BackupRefusedError || error instanceof UnknownMigrationsError) throw error;
      throw new DatabaseUnavailableError(error, databaseRoot(dataHome));
    }));
  }
  return await opened.get(dataHome);
}

// The person's database for reading only, as Bridge's MCP server reads the graph: nothing is started,
// created or migrated, and every transaction is read-only with a server-side time limit
// (default_transaction_read_only and statement_timeout, PostgreSQL's runtime-config-client; postgres-mcp
// reads in a READ ONLY transaction the same way). A statement past the limit is ended by the server,
// so none is left running when the reader goes. A server that is not running is an error to the caller.
export async function openReadOnlyDatabase({ dataHome = bridgeDataHome(), statementTimeoutMs = 10_000 } = {}) {
  const root = databaseRoot(dataHome);
  const pool = new pg.Pool({
    ...(await connectionSettings(root, { database: DATABASE_NAME })),
    options: "-c default_transaction_read_only=on -c statement_timeout=" + statementTimeoutMs,
    max: 2, allowExitOnIdle: true, idleTimeoutMillis: 1000,
  });
  pool.on("error", () => {});
  return { query: (sql, values) => pool.query(sql, values).catch((error) => { throw unavailable(error); }), close: () => pool.end() };
}

// A server that is not running answers a connection this way: no postmaster.pid (or no port in it) to read
// its port from, a refused connection, one still starting up, or no Bridge database in it yet.
const SERVER_DOWN = new Set(["ENOENT", "ECONNREFUSED", "57P03", "3D000"]);
const serverDown = (error) => SERVER_DOWN.has(error?.code) || /postmaster\.pid has no port/.test(String(error?.message));

// A session-level advisory lock on the person's database (PostgreSQL mvcc.sgml, Advisory Locks: "held
// until explicitly released or the session ends", "automatically cleaned up by the server at the end of the
// session"), on its own connection: que's "a connection to the database for locking purposes"
// (docs/README.md:101). Taken with pg_try_advisory_lock, which answers at once, as node-pg-migrate takes its
// lock (src/runner.ts `lock`). The keys are hashtext() of two names, as supabase/cli names its locks
// (apps/cli db-setup.ts:636; packages/stack DatabaseBootstrap.ts:83). Nothing is started here: whoever takes
// a lock has opened the database first. Null when another session holds it.
export async function takeAdvisoryLock(space, key, { dataHome = bridgeDataHome() } = {}) {
  const client = await connect(databaseRoot(dataHome), { database: DATABASE_NAME });
  try {
    const { rows } = await client.query("select pg_try_advisory_lock(hashtext($1), hashtext($2)) as taken", [space, key]);
    if (rows[0].taken === true) return client;
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
  await client.end().catch(() => {});
  return null;
}

// Whether a session holds that lock, read from pg_locks without taking it: two int4 keys are listed with the
// first in classid, the second in objid and objsubid 2, and an advisory lock is local to its database
// (PostgreSQL view-pg-locks). Null when the server is not running: nothing is started to answer.
export async function openAdvisoryLockReader({ dataHome = bridgeDataHome() } = {}) {
  let client;
  try {
    client = await connect(databaseRoot(dataHome), { database: DATABASE_NAME });
  } catch (error) {
    if (serverDown(error)) return null;
    throw error;
  }
  client.on("error", () => {});
  return {
    async held(space, key) {
      const { rows } = await client.query(
        "select exists (select 1 from pg_locks where locktype = 'advisory' and granted and objsubid = 2"
        + " and database = (select oid from pg_database where datname = current_database())"
        + " and classid = hashtext($1)::oid and objid = hashtext($2)::oid) as held",
        [space, key],
      );
      return rows[0].held === true;
    },
    close: () => client.end().catch(() => {}),
  };
}

// The person's database as `status` says it, nothing started: `running`, `stopped`, or `unusable` with
// what pg_ctl status would say about its data directory (dataDirectoryProblem) and where it is.
export async function databaseStatus({ dataHome = bridgeDataHome() } = {}) {
  const root = databaseRoot(dataHome);
  const unusable = await dataDirectoryProblem(root);
  if (unusable) return { state: "unusable", ...unusable };
  return { state: (await serverState(root, { binaries: await postgresBinaries() })).running ? "running" : "stopped" };
}

// The database half of `review-bridge down`, in the order docker compose down takes (the page first,
// then what it uses). `runsRunning` is asked before anything is stopped, since a running run writes to
// this server whichever project it is in. `stopDatabase` then stops a running server with pg_ctl's fast
// shutdown, or clears what a server that is gone left behind (clearOldServer; nothing is listed when it
// stopped cleanly). `server` replaces the server calls in tests.
const serverCalls = async (server) => server ?? {
  binaries: await postgresBinaries(), state: serverState, runs: runningRuns, stop: stopServer, clear: clearOldServer,
};

export async function runsRunning({ dataHome = bridgeDataHome(), server = null } = {}) {
  const root = databaseRoot(dataHome);
  const calls = await serverCalls(server);
  if (!(await calls.state(root, { binaries: calls.binaries })).running) return [];
  return await calls.runs(root);
}

export async function stopDatabase({ dataHome = bridgeDataHome(), server = null } = {}) {
  const root = databaseRoot(dataHome);
  const calls = await serverCalls(server);
  const state = await calls.state(root, { binaries: calls.binaries });
  if (!state.cluster) return { database: "none" };
  if (state.running) {
    await calls.stop(root, { binaries: calls.binaries });
    opened.delete(dataHome);
    return { database: "stopped" };
  }
  const cleared = await calls.clear(root, { binaries: calls.binaries });
  if (cleared.cleared === "in_use") return { database: "in_use", pid: cleared.pid };
  return { database: cleared.cleared === "nothing" ? "not_running" : "cleared" };
}

export { runLines };
