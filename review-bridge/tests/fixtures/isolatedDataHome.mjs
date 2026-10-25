// Imported first by every test file that runs Bridge commands: the person's data home (their one
// database for all projects) stays out of the tests. This file's tests get a temporary data home,
// inherited by every command they spawn; the PostgreSQL server a command started there is stopped
// when the file's tests end, and the folder is removed.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { connect, postgresBinaries } from "../../service/database/postgresServer.mjs";

export const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "rb-test-data-home-"));
process.env.REVIEW_BRIDGE_DATA_HOME = dataHome;
const { pg_ctl: pgCtl } = await postgresBinaries();

// The rows a query returns from the records a command wrote (the server is running by then).
export async function queryRecords(sql, values = [], home = dataHome) {
  const client = await connect(path.join(home, "postgres"), { database: "bridge" });
  try {
    return (await client.query(sql, values)).rows;
  } finally {
    await client.end();
  }
}

// For a test that uses a data home of its own: stops the server a command started there.
export function stopServerIn(home) {
  const data = path.join(home, "postgres", "data");
  if (fs.existsSync(path.join(data, "postmaster.pid"))) {
    spawnSync(pgCtl, ["stop", "-D", data, "-m", "fast", "-w", "-t", "60"], { windowsHide: true, stdio: "ignore" });
  }
}

process.on("exit", () => {
  stopServerIn(dataHome);
  try { fs.rmSync(dataHome, { recursive: true, force: true }); } catch {}
});
