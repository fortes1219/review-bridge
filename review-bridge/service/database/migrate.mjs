// Brings a database to the tables this Bridge expects. Each file in migrations/ is applied once, in
// name order, inside its own transaction: one that fails is rolled back whole and leaves the database
// as it was. A file already applied must still have the SHA-256 it had then; one changed afterwards
// stops everything, because the tables it made are no longer what it says.
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
const MIGRATION_NAME = /^\d{4}-\d{2}-\d{2}-\d{4}-[a-z0-9-]+\.sql$/;
// One key for every Bridge that migrates this database, so two processes never apply one file twice.
const MIGRATION_LOCK = 7_420_251;

export async function migrationFiles(dir = MIGRATIONS_DIR) {
  const names = (await fsp.readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  const files = [];
  for (const name of names) {
    if (!MIGRATION_NAME.test(name)) throw new Error("Migration file name is not <yyyy-mm-dd-hhmm>-<what>.sql: " + name);
    const sql = await fsp.readFile(path.join(dir, name), "utf8");
    files.push({ name, sql, sha256: createHash("sha256").update(sql, "utf8").digest("hex") });
  }
  return files;
}

// Returns the names applied by this call.
export async function applyMigrations(client, { dir = MIGRATIONS_DIR } = {}) {
  const files = await migrationFiles(dir);
  await client.query("create table if not exists schema_migrations ("
    + "name text primary key, sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'), applied_at timestamptz not null default now())");
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
