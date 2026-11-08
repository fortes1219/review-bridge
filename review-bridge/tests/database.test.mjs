import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { recordCard } from "../features/workOrder/workOrderRecords.mjs";
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
    "acceptance_decisions", "acceptance_rows", "authorization_claims", "authorizations", "contracts",
    "graph_definitions", "graph_files", "graph_imports", "graph_references", "graph_states", "plans", "policy_snapshots",
    "projects", "review_findings", "review_results", "review_verdicts", "run_events", "runs", "schema_migrations", "test_results", "work_order_versions", "work_orders",
  ]);
  assert.deepEqual(await applyMigrations(client), [], "nothing is applied twice");
  assert.deepEqual((await client.query("select name from schema_migrations order by name")).rows.map((row) => row.name), names);
  assert.equal(path.basename(MIGRATIONS_DIR), "migrations");
});

// RC3-COST-01 (Owner 2026-11-08): a database that gathered contracts before that day loses the two tables
// and nothing else when it is upgraded.
test("an upgrade from a database with the contract gatherings drops those two tables and keeps every other row", { timeout: 120_000 }, async (t) => {
  const { client } = await database(t);
  const before = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-migrations-before-"));
  t.after(() => fsp.rm(before, { recursive: true, force: true }));
  for (const file of await migrationFiles()) if (file.name < "2026-11-08") await fsp.writeFile(path.join(before, file.name), file.sql);
  await applyMigrations(client, { dir: before });
  assert.ok((await tables(client)).includes("contract_gatherings"));
  const at = new Date().toISOString();
  await client.query("insert into projects (project_id, root_path, name, created_at, last_activity_at) values ('00000000-0000-4000-8000-000000000001', 'C:/farm', 'farm', $1, $1)", [at]);
  assert.deepEqual(await applyMigrations(client), ["2026-11-08-1000-drop-contract-gatherings.sql"]);
  const after = await tables(client);
  assert.equal(after.includes("contract_gatherings") || after.includes("contract_gathering_events"), false);
  assert.deepEqual((await client.query("select name, root_path from projects")).rows, [{ name: "farm", root_path: "C:/farm" }]);
});

// The 2026-11-08 canary: a card for a work order without an id failed on plans_work_order_id_fkey, because
// the id made with the card was written as the plan's work order before any work order existed. A card
// names no work order until the yes records it (the column's null always meant a new one).
test("cards for new work orders print without pointing at a work order; with no yes there is no work order", { timeout: 120_000 }, async (t) => {
  const { client } = await database(t);
  await applyMigrations(client);
  const projectId = randomUUID();
  const now = new Date().toISOString();
  await client.query("insert into projects (project_id, root_path, name, created_at, last_activity_at) values ($1, 'C:/farm', 'farm', $2, $2)", [projectId, now]);
  const snapshot = { effective_policy_sha256: "a".repeat(64), policy_schema_version: 5, package_default_policy_sha256: "b".repeat(64), project_override_sha256: null, effective_policy: {} };
  // One card for a file, and two of a directory's card: each a new work order with the id its yes will use.
  for (const [index, file] of ["farm.md", "line/01-a.md", "line/02-b.md"].entries()) {
    const plan = {
      plan_sha256: String(index).repeat(64), task_sha256: "d".repeat(64), task_file: ".review-bridge/work-packages/" + file, proposed_run_id: randomUUID(),
      effective_policy_sha256: snapshot.effective_policy_sha256, repo_root: "C:/farm", authorization_expires_at: now, created_at: now,
      work_order: { decision: "new", work_order_id: randomUUID(), title: "Farm", file: ".review-bridge/work-packages/" + file },
    };
    await recordCard(client, { projectId, plan, snapshot, shown: true });
  }
  const plans = (await client.query("select work_order_id, body->'work_order'->>'work_order_id' as card_id from plans order by source_file")).rows;
  assert.equal(plans.length, 3);
  assert.ok(plans.every((row) => row.work_order_id === null && /^[0-9a-f-]{36}$/.test(row.card_id)), "the id the yes will use is in the card, not in the column");
  assert.equal((await client.query("select count(*)::int as n from work_orders")).rows[0].n, 0, "no yes, no work order");
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
