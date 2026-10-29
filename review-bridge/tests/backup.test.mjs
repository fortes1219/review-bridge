// Keeps the person's database out of these tests (see the fixture).
import { dataHome, queryRecords, stopServerIn } from "./fixtures/isolatedDataHome.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { backupDatabase, databaseBackupsRoot } from "../service/database/backup.mjs";
import { connect, postgresBinaries, serverRunning, startServer } from "../service/database/postgresServer.mjs";
import { readJson } from "../service/records/fileStore.mjs";

// RC3-BLOCKER-01 step 5: PostgreSQL's file system level backup of the person's database, and its
// restore into a new data home. A real server in a temporary data home; every model call is the fake CLI.
const runtimeSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.resolve(runtimeSource, "..");
const binaries = await postgresBinaries();
const databaseRoot = path.join(dataHome, "postgres");
const backups = databaseBackupsRoot(dataHome);

async function freePort() {
  const net = await import("node:net");
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const ORDER = "# Work order: greeting\n\n<!-- bridge:requested_work -->\n## Work\nPrint a greeting.\n\n<!-- bridge:acceptance -->\n## Acceptance\n- The greeting is printed.\n";

// One project with one delivered run, so the database holds a work order, its contract, the run,
// its events, test result, verdicts and acceptance.
let project = null;
async function projectWithRun() {
  if (project) return project;
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-backup-"));
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "backup-demo", scripts: { test: "node -e \"process.exit(0)\"" } }));
  const init = spawnSync(process.execPath, [
    path.join(packageRoot, "bridge.mjs"), "init", "--target", root, "--writer", "claude", "--reviewer", "codex", "--yes", "--fake-cli", "--port", String(await freePort()),
  ], { cwd: packageRoot, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(init.status, 0, init.stderr);
  const bridge = (args) => spawnSync(process.execPath, [path.join(runtimeSource, "bootstrap.mjs"), ...args], { cwd: root, encoding: "utf8", windowsHide: true });
  const order = ".review-bridge/work-packages/greeting.md";
  await fsp.writeFile(path.join(root, order), ORDER);
  const planArg = ".review-bridge/review-queue/greeting.plan.json";
  const planned = bridge(["work-plan", "--task-file", order, "--owner", "Fortes", "--work-package", "greeting", "--breakpoint", "return after review",
    "--rounds", "1", "--call-timeout", "120000", "--out", planArg]);
  assert.equal(planned.status, 0, planned.stderr);
  const plan = await readJson(path.join(root, planArg));
  const started = bridge(["work-start", "--plan", planArg, "--approve", plan.plan_sha256, "--fake-cli", "--json"]);
  assert.equal(started.status, 0, started.stdout + started.stderr);
  project = { root, bridge, runId: plan.proposed_run_id };
  return project;
}

test.after(async () => {
  if (!project) return;
  project.bridge(["down"]);
  await fsp.rm(project.root, { recursive: true, force: true });
});

const backupFolders = async () => (await fsp.readdir(backups).catch(() => [])).sort();

// Every row of every table, as one hash per table: the restored database must hold the same.
async function tableHashes(client) {
  const tables = (await client.query("select tablename from pg_tables where schemaname = 'public' order by 1")).rows.map((row) => row.tablename);
  const hashes = {};
  for (const table of tables) {
    hashes[table] = (await client.query("select count(*)::int as rows, coalesce(md5(string_agg(t::text, E'\\n' order by t::text)), '') as hash from " + table + " t")).rows[0];
  }
  return hashes;
}

test("backup refuses while a run is running, and leaves the server running and no copy", { timeout: 300_000 }, async () => {
  const { bridge, runId } = await projectWithRun();
  const before = await backupFolders();
  await queryRecords("update runs set status = 'in_progress' where run_id = $1", [runId]);
  try {
    const refused = bridge(["backup"]);
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stdout, /^Not backed up: a run is running\./);
    assert.match(refused.stdout, new RegExp(runId));
  } finally {
    await queryRecords("update runs set status = 'completed' where run_id = $1", [runId]);
  }
  assert.deepEqual(await backupFolders(), before, "no backup, finished or partial");
  assert.equal(await serverRunning(databaseRoot, { binaries }), true);
});

test("backup stops the database, copies it whole and starts it again; a restore into a new data home keeps every row, contract and link", { timeout: 300_000 }, async (t) => {
  const { bridge, runId } = await projectWithRun();
  const done = bridge(["backup"]);
  assert.equal(done.status, 0, done.stdout + done.stderr);
  const [folder] = (await backupFolders()).filter((name) => !name.includes(".partial-"));
  const backup = path.join(backups, folder);
  assert.equal(done.stdout.split("\n")[0], "Backed up the database to " + backup);
  assert.match(done.stdout, /set REVIEW_BRIDGE_DATA_HOME to that folder/);
  // The whole cluster with its password and port, closed cleanly: no server's pid file, no pg_ctl words.
  for (const file of ["data/PG_VERSION", "data/global/pg_control", "secret", "server.json"]) {
    assert.ok(await fsp.stat(path.join(backup, "postgres", file)).catch(() => null), file);
  }
  for (const file of ["data/postmaster.pid", "pg_ctl.out"]) assert.equal(await fsp.stat(path.join(backup, "postgres", file)).catch(() => null), null, file);
  // The database is back for the next command.
  assert.equal(await serverRunning(databaseRoot, { binaries }), true);
  const live = await connect(databaseRoot, { database: "bridge" });
  const expected = await tableHashes(live).finally(() => live.end());

  // Restore: the copy becomes the postgres folder of a new data home, and the server starts there.
  const newHome = await fsp.mkdtemp(path.join(os.tmpdir(), "rb-restored-home-"));
  t.after(async () => {
    stopServerIn(newHome);
    // On Windows the stopped server's folder can stay held for a moment.
    await fsp.rm(newHome, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });
  await fsp.cp(path.join(backup, "postgres"), path.join(newHome, "postgres"), { recursive: true });
  await startServer(path.join(newHome, "postgres"), { binaries });
  const restored = await connect(path.join(newHome, "postgres"), { database: "bridge" });
  try {
    assert.deepEqual(await tableHashes(restored), expected);
    assert.ok(expected.contracts.rows >= 1 && expected.run_events.rows >= 1 && expected.review_verdicts.rows >= 1, JSON.stringify(expected));
    // Each contract still hashes to its fingerprint, and the run, its version and its contract still meet.
    for (const row of (await restored.query("select contract_sha256, canonical_text from contracts")).rows) {
      assert.equal(createHash("sha256").update(row.canonical_text, "utf8").digest("hex"), row.contract_sha256);
    }
    const linked = (await restored.query(
      "select r.run_id, c.contract_sha256, v.version_no, count(e.*)::int as events from runs r"
      + " join contracts c on c.contract_sha256 = r.contract_sha256 and c.work_order_id = r.work_order_id and c.content_sha256 = r.content_sha256"
      + " join work_order_versions v on v.work_order_id = r.work_order_id and v.content_sha256 = r.content_sha256"
      + " join run_events e on e.run_id = r.run_id where r.run_id = $1 group by r.run_id, c.contract_sha256, v.version_no", [runId])).rows;
    assert.equal(linked.length, 1);
    assert.ok(linked[0].events >= 1);
  } finally {
    await restored.end();
  }
});

test("a server started while the copy was made discards the copy; the server is left running", { timeout: 300_000 }, async () => {
  await projectWithRun();
  const before = await backupFolders();
  await assert.rejects(
    backupDatabase({ dataHome, duringCopy: () => startServer(databaseRoot, { binaries }) }),
    /started by another Bridge command while it was being copied; the copy was discarded/,
  );
  assert.deepEqual(await backupFolders(), before, "no backup, finished or partial");
  assert.equal(await serverRunning(databaseRoot, { binaries }), true);
});

test("backup with no database yet says so and makes nothing", { timeout: 60_000 }, async (t) => {
  const empty = await fsp.mkdtemp(path.join(os.tmpdir(), "rb-empty-home-"));
  t.after(() => fsp.rm(empty, { recursive: true, force: true }));
  await assert.rejects(backupDatabase({ dataHome: empty }), /There is no database at .* yet; nothing to back up\./);
  assert.deepEqual(await fsp.readdir(empty), []);
});
