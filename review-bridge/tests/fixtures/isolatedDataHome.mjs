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
// The person's agent folders too: init puts the /review-bridge entries there. Codex's is under the
// home directory and no variable moves it, so the home directory moves (USERPROFILE on Windows).
process.env.CLAUDE_CONFIG_DIR = path.join(dataHome, "claude-config");
process.env.HOME = process.env.USERPROFILE = path.join(dataHome, "home");
fs.mkdirSync(process.env.HOME);
// VS Code's user tasks: an uninstall reads them and may edit them.
process.env.APPDATA = path.join(dataHome, "home", "AppData", "Roaming");
process.env.XDG_CONFIG_HOME = path.join(dataHome, "home", ".config");
const { pg_ctl: pgCtl } = await postgresBinaries();

// For a test about what belongs to the person, shared by all their projects: a machine of its own,
// whose data home holds no other test's projects, for this test only.
export function separatePerson(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rb-test-person-"));
  const claudeHome = path.join(home, ".claude");
  const codexHome = path.join(home, ".codex");
  const skillFolder = path.join(home, ".agents", "skills", "review-bridge");
  const env = {
    REVIEW_BRIDGE_DATA_HOME: path.join(home, "data"), CLAUDE_CONFIG_DIR: claudeHome, HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"), XDG_CONFIG_HOME: path.join(home, ".config"),
  };
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    Object.assign(process.env, saved);
    fs.rmSync(home, { recursive: true, force: true });
  });
  return {
    env, home, claudeHome, codexHome, skillFolder, record: path.join(env.REVIEW_BRIDGE_DATA_HOME, "agent-entries.json"),
    claudeEntry: path.join(claudeHome, "commands", "review-bridge.md"), codexEntry: path.join(skillFolder, "SKILL.md"),
  };
}

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
