// Imported first by every test file that runs Bridge commands: the person's data home (their one
// database for all projects) stays out of the tests. This file's tests get a temporary data home,
// inherited by every command they spawn; the PostgreSQL server a command started there is stopped
// when the file's tests end, and the folder is removed.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
// The language init speaks and writes into bridge.json is the person's, LANG before the system's, as
// create-vue reads it (i18n.mjs shellLocale): these tests read Bridge's English words on any machine.
process.env.LANG = "en_US.UTF-8";
// The commands Bridge prints name the package manager that ran it (bridgeCommand.mjs); npm test sets
// one and node --test does not. Without one the lines read `npx review-bridge …`, however the tests run.
delete process.env.npm_config_user_agent;
const { pg_ctl: pgCtl } = await postgresBinaries();

// The port this file's database starts from: one the system hands out, as the embedded-PostgreSQL libraries'
// test helpers take theirs (fergusstrange/embedded-postgres: "Test helpers and the CLI choose Port(0) by
// default", freePort listens on 127.0.0.1:0; zonky's detectPort opens a ServerSocket(0); ECOSYSTEM-REFERENCES
// K). Test files run at once and each starts a server; from one start port they found the same port free
// and the second died binding it (Windows CI, 2026-11-10). Written as the data home's database.port, which
// every command reads; nothing of the product changes, and nothing is left behind.
const systemPort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
// In the shape saveDefaultRoles writes (installer/personal-settings.mjs): a settings file is read for its
// roles whenever it is there, so it carries the built-in ones (claude writes, codex reviews) beside the port.
fs.writeFileSync(path.join(dataHome, "settings.json"), JSON.stringify({
  schema_version: 1, default_roles: { writer: "claude", reviewer: "codex" }, database: { port: await systemPort() },
}, null, 2) + "\n");

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

// A test's clean-up stops the page service init started for it the way Playwright's webServer teardown
// stops what it started: by the service's own record, never by asking Bridge to stop itself
// (ECOSYSTEM-REFERENCES K). `down` refuses while a run of the test is still open, and that left page
// services running with the test's folder as their working directory (2026-11-09). serviceDown kills
// only the pid the session names and that answers on its port as that service. The database is the
// file's: stopped by pg_ctl on this file's own data directory when the file's tests end (below).
export async function stopPage(root) {
  const runtime = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const { serviceDown } = await import("../../features/setupCheck/pageService.mjs");
  const { getBridgePaths } = await import("../../utils/paths.mjs");
  await serviceDown({ paths: getBridgePaths(root, runtime, { privateRootName: ".review-bridge" }), out: { write() {} } }).catch(() => {});
}

// One real init per test file and kind of project, and a copy of it for each test, as PostgreSQL's tests
// copy an initdb'd template instead of running initdb for each (Cluster.pm, INITDB_TEMPLATE) and as
// Bridge's own init self-tests copy .review-bridge/ under a new id (bridge.mjs runDisposableFakeScenarios;
// ECOSYSTEM-REFERENCES K). A test still gets a whole project of its own: the copy's new project_id makes
// it another project in this file's database, recorded at its first use. The template's page is stopped
// once it is made; a copy has no page, no graph and no install record, so a test of those runs init itself.
const templates = new Map();
const templateRoots = new Set();
export async function projectTemplate(key, make) {
  if (!templates.has(key)) {
    templates.set(key, (async () => {
      const root = await make();
      templateRoots.add(root);
      await stopPage(root);
      return root;
    })());
  }
  return await templates.get(key);
}

export async function copyProject(t, template, prefix) {
  // A path that does not exist yet, so the copy is the template's folder itself, as the self-tests copy.
  const root = path.join(os.tmpdir(), prefix + randomUUID().slice(0, 8));
  await fs.promises.cp(template, root, { recursive: true });
  const file = path.join(root, ".review-bridge", "bridge.json");
  const config = JSON.parse(await fs.promises.readFile(file, "utf8"));
  await fs.promises.writeFile(file, JSON.stringify({ ...config, project_id: randomUUID() }, null, 2) + "\n");
  t.after(async () => {
    await stopPage(root);
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });
  return root;
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
  // The templates' folders; what each test copied went at its own end. Retried as the copies are (a file
  // Windows still holds), and said when it cannot go, so nothing stays behind in Temp unsaid.
  for (const root of templateRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch (error) {
      process.stderr.write("A test template folder could not be removed: " + root + " (" + (error.code || error.message) + ")\n");
    }
  }
});
