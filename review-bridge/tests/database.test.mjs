import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { recordCard } from "../features/workOrder/workOrderRecords.mjs";
import { createTranslator } from "../features/workOrder/i18n.mjs";
import { applyMigrations, MIGRATION_LOCK, migrationFiles, migrationState, MIGRATIONS_DIR } from "../service/database/migrate.mjs";
import { failureLine, UNKNOWN_MIGRATIONS_CODE, UnknownMigrationsError } from "../service/database/serverErrors.mjs";
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
    // On Windows a stopped server's files stay locked for a moment (EBUSY, 2026-11-09); Node's rm retries
    // EBUSY and EPERM with maxRetries, as the other tests' clean-ups do.
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
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
  for (const file of await migrationFiles()) if (file.name < "20261108012648_drop_contract_gatherings.sql") await fsp.writeFile(path.join(before, file.name), file.sql);
  await applyMigrations(client, { dir: before });
  assert.ok((await tables(client)).includes("contract_gatherings"));
  const at = new Date().toISOString();
  await client.query("insert into projects (project_id, root_path, name, created_at, last_activity_at) values ('00000000-0000-4000-8000-000000000001', 'C:/farm', 'farm', $1, $1)", [at]);
  assert.deepEqual(await applyMigrations(client), ["20261108012648_drop_contract_gatherings.sql", "20261108195620_project_graph.sql", "20261108201337_graph_update_event.sql"]);
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
  const dir = await migrationCopy(t, { "20990101000000_broken.sql": "create table half_made (id int);\nselect * from no_such_table;\n" });
  await assert.rejects(applyMigrations(client, { dir }), /Migration 20990101000000_broken\.sql failed and was rolled back: relation "no_such_table" does not exist/);
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
  await fsp.writeFile(path.join(dir, "20990101000000_later.sql"), "create table later (id int);\n");
  await assert.rejects(applyMigrations(client, { dir }), new RegExp("Migration " + first.replaceAll(".", "\\.") + " changed after it was applied"));
  assert.ok(!(await tables(client)).includes("later"));
});

// Named as Knex and Prisma name theirs: a 14-digit UTC time, an underscore, the name in Rails's characters.
test("a migration file not named <yyyymmddhhmmss>_<what>.sql is refused, the earlier dated names among them", async (t) => {
  for (const name of ["v5-add-things.sql", "2026-11-09-1000-project-graph.sql", "202611081956_short.sql", "20261108195620-dash.sql", "20261108195620_Upper.sql"]) {
    const dir = await migrationCopy(t, { [name]: "select 1;\n" });
    await assert.rejects(migrationFiles(dir), new RegExp("Migration file name is not <yyyymmddhhmmss>_<what>\\.sql \\(UTC\\): " + name.replaceAll(".", "\\.")), name);
  }
});

// Owner 2026-11-09: a released migration is never renamed or removed, so a database that has had one this
// Bridge does not have was opened by a newer Bridge. Refused before anything is backed up or applied, as
// Knex's validateMigrationList refuses before it migrates; said in the project's language.
test("a database that has had a migration this Bridge does not have is refused before any backup or migration, and said in the project's language", async (t) => {
  const dir = await migrationCopy(t);
  const names = (await migrationFiles(dir)).map((file) => file.name);
  const sent = [];
  const client = (applied) => ({
    query: async (sql) => {
      sent.push(sql);
      if (sql.startsWith("select to_regclass")) return { rows: [{ name: "schema_migrations" }] };
      if (sql.startsWith("select name from schema_migrations")) return { rows: applied.map((name) => ({ name })) };
      throw new Error("nothing else may be sent: " + sql);
    },
  });
  const newer = [...names, "20991231235959_from_a_newer_bridge.sql"];
  for (const call of [() => migrationState(client(newer), { dir }), () => applyMigrations(client(newer), { dir })]) {
    sent.length = 0;
    await assert.rejects(call(), (error) => error instanceof UnknownMigrationsError && error.code === UNKNOWN_MIGRATIONS_CODE
      && deepEqualNames(error.names, ["20991231235959_from_a_newer_bridge.sql"]));
    assert.deepEqual(sent.filter((sql) => !/^select (to_regclass|name from schema_migrations)/.test(sql)), [], "nothing created, locked or applied");
  }
  assert.deepEqual(await migrationState(client(names.slice(0, 3)), { dir }), { applied: 3, pending: names.slice(3) }, "an older database is an upgrade, as before");
  const error = new UnknownMigrationsError(["20991231235959_from_a_newer_bridge.sql"]);
  assert.equal(failureLine(error, await createTranslator("zh-TW")), "這個資料庫被較新版的 Review Bridge 改過（遷移 20991231235959_from_a_newer_bridge.sql，這一版沒有），所以這一版不開它，裡面什麼都沒動。請重新安裝較新的版本：npm i -g review-bridge@latest");
  assert.match(failureLine(error, await createTranslator("en")), /^This database was changed by a newer Review Bridge \(migrations 20991231235959_from_a_newer_bridge\.sql, which this version does not have\)/);
  assert.match(failureLine(new Error("wrapped", { cause: error }), null), /^Review bridge failed closed: wrapped/, "without the translations, the message as it is");
});
const deepEqualNames = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);

test("the migrations are named in time order: each one's 14 digits follow the one before it", async () => {
  const names = (await migrationFiles()).map((file) => file.name);
  assert.ok(names.length > 0);
  for (const [index, name] of names.entries()) {
    assert.match(name, /^\d{14}_[a-z0-9_]+\.sql$/);
    if (index) assert.ok(name.slice(0, 14) > names[index - 1].slice(0, 14), name + " comes after " + names[index - 1]);
  }
});

// RC3.1-PAGE-03: several commands opening a new database at once. Each test starts its own server in its
// own data home, without the Bridge database, and opens the database from child processes, as separate
// commands do (openDatabase keeps one per process). The situation is made by the test: it holds the lock
// the commands should wait at, and sees them wait in pg_locks, so a command that does not wait fails the
// test every time, not only when the timing happens to collide. Watching for a session blocked on a lock
// from a control connection is how PostgreSQL's own isolation tests see it (src/test/isolation/
// isolationtester.c, REL_18_STABLE: the wait query :213-224, checked every 10 ms :867).
const indexUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "service", "database", "index.mjs")).href;

async function serverWithoutBridge(t) {
  const dataHome = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-open-"));
  const root = path.join(dataHome, "postgres");
  const started = new Set();
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.end().catch(() => {});
    for (const child of started) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await stopServer(root, { binaries }).catch(() => {});
    await fsp.rm(dataHome, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });
  await ensureCluster(root, { binaries });
  await startServer(root, { binaries });
  const session = async (options) => {
    const client = await connect(root, options);
    client.on("error", () => {});
    clients.push(client);
    return client;
  };
  // A command of its own: opens the person's database in this data home and says how it went.
  const open = () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e",
      "const m = await import(process.env.RB_INDEX); const db = await m.openDatabase({ dataHome: process.env.RB_DATA_HOME }); await db.close();"],
    { windowsHide: true, env: { ...process.env, RB_INDEX: indexUrl, RB_DATA_HOME: dataHome }, stdio: ["ignore", "ignore", "pipe"] });
    started.add(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const done = new Promise((resolve) => child.once("close", (code) => resolve({ code, stderr })));
    return { child, done };
  };
  return { dataHome, root, session, open };
}

// The sessions waiting for an advisory lock: in a server of the test's own, only the commands it started.
const waitingForAdvisory = async (client) => {
  try {
    return Number((await client.query("select count(*) as n from pg_locks where locktype = 'advisory' and not granted")).rows[0].n);
  } catch {
    return -1;
  }
};
// True once `count` commands wait for a lock; false once they have all ended without that. Checked every
// 10 ms, as isolationtester checks for lock waits.
async function waitedFor(client, count, commands) {
  for (;;) {
    if ((await waitingForAdvisory(client)) === count) return true;
    if (commands.every(({ child }) => child.exitCode !== null || child.signalCode !== null)) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const backedUp = async (dataHome) => (await fsp.readdir(path.join(dataHome, "backups", "database")).catch(() => [])).length > 0;

test("commands creating the Bridge database at once wait for one another, and every migration is applied once", { timeout: 180_000 }, async (t) => {
  const { dataHome, session, open } = await serverWithoutBridge(t);
  const admin = await session();
  // The lock the commands take before they look for the database (index.mjs ensureDatabase).
  await admin.query("select pg_advisory_lock(hashtext($1))", ["review-bridge.create-database"]);
  const commands = [1, 2, 3].map(() => open());
  const waited = await waitedFor(admin, 3, commands);
  assert.equal(waited, true, "the three commands waited for the lock before they looked for the database");
  assert.equal((await admin.query("select 1 from pg_database where datname = 'bridge'")).rows.length, 0);
  await admin.query("select pg_advisory_unlock(hashtext($1))", ["review-bridge.create-database"]);
  for (const result of await Promise.all(commands.map(({ done }) => done))) assert.equal(result.code, 0, result.stderr);
  const bridge = await session({ database: "bridge" });
  assert.deepEqual((await bridge.query("select name from schema_migrations order by name")).rows.map((row) => row.name), (await migrationFiles()).map((file) => file.name));
  assert.equal(await backedUp(dataHome), false, "a new database is not backed up");
});

test("a command that comes while another applies the migrations waits for its whole run and backs nothing up", { timeout: 180_000 }, async (t) => {
  const { dataHome, session, open } = await serverWithoutBridge(t);
  await (await session()).query("create database bridge");
  const first = await session({ database: "bridge" });
  // The first command, part way: it holds the migration lock for its whole run and has applied three files.
  const files = await migrationFiles();
  const partial = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-migrations-"));
  t.after(() => fsp.rm(partial, { recursive: true, force: true }));
  for (const file of files.slice(0, 3)) await fsp.writeFile(path.join(partial, file.name), file.sql);
  await first.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
  await applyMigrations(first, { dir: partial });
  const second = open();
  const waited = await waitedFor(first, 1, [second]);
  assert.equal(waited, true, "the second command waited for the first's whole run");
  await applyMigrations(first);
  await first.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK]);
  const result = await second.done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await backedUp(dataHome), false, "a database half migrated by another command is not taken for an upgrade");
  assert.deepEqual((await first.query("select name from schema_migrations order by name")).rows.map((row) => row.name), files.map((file) => file.name));
});
