// The person's database, as the commands use it: the cluster is created on first use, the server is
// started when it is not running (it stays running for later commands), the `bridge` database is
// created once, and the migrations are applied. One pool per process; it lets the process exit when
// it is idle, so a command never has to close it.
import pg from "pg";

import { bridgeDataHome, databaseRoot } from "./dataHome.mjs";
import { applyMigrations } from "./migrate.mjs";
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

async function open(dataHome) {
  const root = databaseRoot(dataHome);
  const binaries = await postgresBinaries();
  await ensureCluster(root, { binaries });
  await startServer(root, { binaries });
  await ensureDatabase(root);
  const pool = new pg.Pool({ ...(await connectionSettings(root, { database: DATABASE_NAME })), max: 4, allowExitOnIdle: true, idleTimeoutMillis: 1000 });
  // A connection the server ends between queries is reported here; the next query reports it again.
  pool.on("error", () => {});
  const client = await pool.connect();
  try {
    await applyMigrations(client);
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

// Fails closed: without the database no work order is planned or started.
export async function openDatabase({ dataHome = bridgeDataHome() } = {}) {
  if (!opened.has(dataHome)) {
    opened.set(dataHome, open(dataHome).catch((error) => {
      opened.delete(dataHome);
      throw new DatabaseUnavailableError(error, databaseRoot(dataHome));
    }));
  }
  return await opened.get(dataHome);
}
