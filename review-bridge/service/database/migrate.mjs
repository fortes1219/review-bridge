// Brings a database to the tables this Bridge expects. Each file in migrations/ is applied once, in
// name order, inside its own transaction: one that fails is rolled back whole and leaves the database
// as it was. A file already applied must still have the SHA-256 it had then; one changed afterwards
// stops everything, because the tables it made are no longer what it says.
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { UnknownMigrationsError } from "./serverErrors.mjs";

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
// <UTC yyyymmddhhmmss>_<what>.sql, as Knex (util/timestamp.js, MigrationGenerator `_getNewMigrationName`)
// and Prisma (schema-engine create_migration.rs, `{timestamp}_{migration_name}`) name theirs; the name
// takes Rails's characters (MigrationFilenameRegexp `[_a-z0-9]*`). Two made in one second take the next
// second, as Rails's next_migration_number does. Name order is time order.
const MIGRATION_NAME = /^\d{14}_[a-z0-9_]+\.sql$/;
// One key for every Bridge that migrates this database, so two processes never apply one file twice.
const MIGRATION_LOCK = 7_420_251;

export async function migrationFiles(dir = MIGRATIONS_DIR) {
  const names = (await fsp.readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  const files = [];
  for (const name of names) {
    if (!MIGRATION_NAME.test(name)) throw new Error("Migration file name is not <yyyymmddhhmmss>_<what>.sql (UTC): " + name);
    const sql = await fsp.readFile(path.join(dir, name), "utf8");
    files.push({ name, sql, sha256: createHash("sha256").update(sql, "utf8").digest("hex") });
  }
  return files;
}

// The names the database has had and this Bridge does not have refuse it before anything else, as Knex's
// validateMigrationList does before it migrates (Migrator.js `latest`): a released migration is never
// renamed or removed, so such a name means a newer Bridge used this database.
function refuseUnknown(files, appliedNames) {
  const known = new Set(files.map((file) => file.name));
  const unknown = appliedNames.filter((name) => !known.has(name)).sort();
  if (unknown.length) throw new UnknownMigrationsError(unknown);
}

async function appliedNames(client) {
  const table = (await client.query("select to_regclass('public.schema_migrations') as name")).rows[0].name;
  return table ? (await client.query("select name from schema_migrations")).rows.map((row) => row.name) : [];
}

// The migration files this database has not had yet, and how many it has had: one that has had none
// is new, so an upgrade is a database with some applied and some still to apply.
export async function migrationState(client, { dir = MIGRATIONS_DIR } = {}) {
  const files = await migrationFiles(dir);
  const names = await appliedNames(client);
  refuseUnknown(files, names);
  const applied = new Set(names);
  return { applied: applied.size, pending: files.filter((file) => !applied.has(file.name)).map((file) => file.name) };
}

// Returns the names applied by this call.
export async function applyMigrations(client, { dir = MIGRATIONS_DIR } = {}) {
  const files = await migrationFiles(dir);
  refuseUnknown(files, await appliedNames(client));
  // The table is made under the same lock as each migration: two commands opening a new database at once
  // both reach `create table if not exists`, which is not safe against itself (the loser hits
  // pg_type_typname_nsp_index). node-pg-migrate takes its lock before it ensures its table
  // (src/runner.ts:1145-1147, then :1168).
  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await client.query("create table if not exists schema_migrations ("
      + "name text primary key, sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'), applied_at timestamptz not null default now())");
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
  const applied = [];
  for (const file of files) {
    await client.query("begin");
    try {
      await client.query("select pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
      const { rows } = await client.query("select sha256 from schema_migrations where name = $1", [file.name]);
      if (rows.length) {
        if (rows[0].sha256 !== file.sha256) throw new Error("Migration " + file.name + " changed after it was applied; the database no longer matches it.");
        await client.query("commit");
        continue;
      }
      await client.query(file.sql);
      await client.query("insert into schema_migrations (name, sha256) values ($1, $2)", [file.name, file.sha256]);
      await client.query("commit");
      applied.push(file.name);
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw new Error("Migration " + file.name + " failed and was rolled back: " + error.message);
    }
  }
  return applied;
}
