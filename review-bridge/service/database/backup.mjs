// A backup of the person's database (RC3-BLOCKER-01 step 5): PostgreSQL's file system level backup.
// The server is stopped with a fast shutdown, the cluster folder is copied whole (the data, its
// password and its port), and the server is started again. Restoring is the same copy the other way:
// the folder becomes `postgres` in a data home, and Bridge is started there (REVIEW_BRIDGE_DATA_HOME).
import { createHash, randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { bridgeDataHome, databaseRoot } from "./dataHome.mjs";
import { clusterPaths, connect, postgresBinaries, serverRunning, startServer, stopServer } from "./postgresServer.mjs";

const DATABASE_NAME = "bridge";
// pg_ctl's words from its last call: not part of the cluster.
const NOT_COPIED = new Set(["pg_ctl.out"]);

export function databaseBackupsRoot(dataHome = bridgeDataHome()) {
  return path.join(dataHome, "backups", "database");
}

export class BackupRefusedError extends Error {
  constructor(message) {
    super(message);
    this.name = "BackupRefusedError";
  }
}

// The runs still running in any project: the server they write to is about to stop.
async function runningRuns(root) {
  let client;
  try {
    client = await connect(root, { database: DATABASE_NAME });
  } catch (error) {
    // 3D000: the `bridge` database was never made, so nothing has run.
    if (error.code === "3D000") return [];
    throw error;
  }
  try {
    if (!(await client.query("select to_regclass('public.runs') as runs")).rows[0].runs) return [];
    return (await client.query("select r.run_id, p.root_path from runs r join projects p on p.project_id = r.project_id"
      + " where r.status = 'in_progress' order by r.created_at limit 10")).rows;
  } finally {
    await client.end();
  }
}

// pg_control changes whenever a server starts or stops, so the same bytes before and after the copy
// show that no server ran on the cluster while it was copied.
async function controlFingerprint(paths) {
  return createHash("sha256").update(await fsp.readFile(path.join(paths.data, "global", "pg_control"))).digest("hex");
}

// `duringCopy` is for tests: it runs once the copy is made, before it is checked.
export async function backupDatabase({ dataHome = bridgeDataHome(), now = new Date(), duringCopy = null } = {}) {
  const root = databaseRoot(dataHome);
  const paths = clusterPaths(root);
  if (!(await fsp.access(path.join(paths.data, "PG_VERSION")).then(() => true, () => false))) {
    throw new BackupRefusedError("There is no database at " + root + " yet; nothing to back up.");
  }
  const binaries = await postgresBinaries();
  await startServer(root, { binaries });
  const running = await runningRuns(root);
  if (running.length) {
    throw new BackupRefusedError("Not backed up: a run is running. Stop it with review-bridge stop <run_id> in its project, or let it end, then back up again.\n"
      + running.map((run) => "  " + run.run_id + "  " + run.root_path).join("\n"));
  }
  const backupsRoot = databaseBackupsRoot(dataHome);
  const target = path.join(backupsRoot, now.toISOString().replace(/[:.]/g, "-"));
  // Copied beside its final name and renamed when whole, so a backup cut short never looks finished.
  const partial = target + ".partial-" + process.pid + "-" + randomBytes(4).toString("hex");
  await stopServer(root, { binaries });
  let failure = null;
  try {
    const before = await controlFingerprint(paths);
    await fsp.mkdir(backupsRoot, { recursive: true });
    await fsp.cp(root, path.join(partial, "postgres"), {
      recursive: true,
      errorOnExist: true,
      filter: (source) => !NOT_COPIED.has(path.relative(root, source)),
    });
    await duringCopy?.();
    if (await serverRunning(root, { binaries }) || (await controlFingerprint(paths)) !== before) {
      throw new Error("The database was started by another Bridge command while it was being copied; the copy was discarded. Back up again.");
    }
    await fsp.rename(partial, target);
  } catch (error) {
    await fsp.rm(partial, { recursive: true, force: true });
    failure = error;
  }
  // The server comes back whatever happened, so the page and later commands find it as before.
  try {
    await startServer(root, { binaries });
  } catch (error) {
    throw new Error((failure ? failure.message : "Backed up to " + target + ".") + " The database did not start again: " + error.message);
  }
  if (failure) throw failure;
  return { path: target, root };
}
