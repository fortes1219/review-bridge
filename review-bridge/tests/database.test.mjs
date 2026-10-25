import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyMigrations, migrationFiles, MIGRATIONS_DIR } from "../service/database/migrate.mjs";
import { connect, ensureCluster, postgresBinaries, startServer, stopServer } from "../service/database/postgresServer.mjs";

// RC3-BLOCKER-01 step 2: the migrations bring an empty database to the tables the records use; a
// failing one leaves the database as it was, and one changed after it was applied stops everything.
// A real server in a temporary folder; no model is called.
const binaries = await postgresBinaries();

async function database(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-migrate-"));
  let client = null;
  t.after(async () => {
    await client?.end().catch(() => {});
    await stopServer(root, { binaries }).catch(() => {});
    await fsp.rm(root, { recursive: true, force: true });
  });
  await ensureCluster(root, { binaries });
  await startServer(root, { binaries });
  client = await connect(root);
  return { root, client };
}

async function migrationCopy(t, extra = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-migrations-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  for (const file of await migrationFiles()) await fsp.writeFile(path.join(dir, file.name), file.sql);
  for (const [name, sql] of Object.entries(extra)) await fsp.writeFile(path.join(dir, name), sql);
  return dir;
}

const tables = async (client) => (await client.query("select tablename from pg_tables where schemaname = 'public' order by 1")).rows.map((row) => row.tablename);

test("the migrations make the records' tables once, in name order", { timeout: 120_000 }, async (t) => {
  const { client } = await database(t);
  const names = (await migrationFiles()).map((file) => file.name);
  assert.deepEqual(await applyMigrations(client), names);
  assert.deepEqual(await tables(client), [
    "acceptance_decisions", "acceptance_rows", "authorization_claims", "authorizations", "contracts", "gate_a_results", "plans", "policy_snapshots",
    "projects", "review_findings", "review_results", "review_verdicts", "run_events", "runs", "schema_migrations", "work_order_versions", "work_orders",
  ]);
  assert.deepEqual(await applyMigrations(client), [], "nothing is applied twice");
  assert.deepEqual((await client.query("select name from schema_migrations order by name")).rows.map((row) => row.name), names);
  assert.equal(path.basename(MIGRATIONS_DIR), "migrations");
});

test("a migration that fails is rolled back whole; the ones before it stay", { timeout: 120_000 }, async (t) => {
  const { client } = await database(t);
  const dir = await migrationCopy(t, { "2099-01-01-0000-broken.sql": "create table half_made (id int);\nselect * from no_such_table;\n" });
  await assert.rejects(applyMigrations(client, { dir }), /Migration 2099-01-01-0000-broken\.sql failed and was rolled back: relation "no_such_table" does not exist/);
  assert.ok(!(await tables(client)).includes("half_made"), "nothing of the failed migration is left");
  assert.ok((await tables(client)).includes("contracts"), "the migrations before it are kept");
  assert.equal((await client.query("select count(*)::int as n from schema_migrations where name like '2099%'")).rows[0].n, 0);
});

test("a migration changed after it was applied stops every later migration", { timeout: 120_000 }, async (t) => {
  const { client } = await database(t);
  const dir = await migrationCopy(t);
  await applyMigrations(client, { dir });
  const first = (await migrationFiles(dir))[0].name;
  await fsp.appendFile(path.join(dir, first), "\n-- edited later\n");
  await fsp.writeFile(path.join(dir, "2099-01-01-0000-later.sql"), "create table later (id int);\n");
  await assert.rejects(applyMigrations(client, { dir }), new RegExp("Migration " + first.replaceAll(".", "\\.") + " changed after it was applied"));
  assert.ok(!(await tables(client)).includes("later"));
});

test("a migration file not named <yyyy-mm-dd-hhmm>-<what>.sql is refused", async (t) => {
  const dir = await migrationCopy(t, { "v5-add-things.sql": "select 1;\n" });
  await assert.rejects(migrationFiles(dir), /Migration file name is not <yyyy-mm-dd-hhmm>-<what>\.sql: v5-add-things\.sql/);
});
