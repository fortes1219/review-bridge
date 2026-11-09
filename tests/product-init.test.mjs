// Keeps the person's database out of these tests (see the fixture).
import { copyProject, dataHome, projectTemplate, queryRecords, stopServerIn } from "../review-bridge/tests/fixtures/isolatedDataHome.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTranslator, resolveLocale } from "../review-bridge/features/workOrder/i18n.mjs";
import { sealedText } from "../review-bridge/features/workOrder/workOrderFormat.mjs";
import { localTimestamp } from "../review-bridge/utils/dates.mjs";
import { getBridgePaths } from "../review-bridge/utils/paths.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridge = path.join(packageRoot, "bridge.mjs");

// Model-free environment: provider CLI overrides point at paths that do not exist, so the
// platform adapter fails closed instead of falling back to an installed, signed-in CLI.
const isolatedHome = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-no-cli-home-"));
process.on("exit", () => { try { fsSync.rmSync(isolatedHome, { recursive: true, force: true }); } catch {} });
// stop needs the OS process tools (ps on POSIX), so the system directories stay on PATH.
// The project's state and logs, outside the project (RC3-FIX-02), where the commands these tests run find them.
function projectPaths(root, overrides = {}) {
  return getBridgePaths(root, path.join(packageRoot, "review-bridge"), { privateRootName: ".review-bridge", env: isolatedEnv(overrides) });
}
const readJsonFile = async (file) => JSON.parse(await fsp.readFile(file, "utf8"));

function isolatedEnv(overrides = {}) {
  const system = process.platform === "win32"
    ? [process.env.SystemRoot && path.join(process.env.SystemRoot, "System32")]
    : ["/usr/bin", "/bin"];
  const env = {
    PATH: [path.dirname(process.execPath), ...system].filter(Boolean).join(path.delimiter),
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    TEMP: os.tmpdir(),
    TMP: os.tmpdir(),
    CLAUDE_REVIEW_CLI: path.join(isolatedHome, "absent", "claude"),
    CODEX_REVIEW_CLI: path.join(isolatedHome, "absent", "codex"),
    REVIEW_BRIDGE_DATA_HOME: dataHome,
    // init speaks LANG's language, as create-vue does (i18n.mjs shellLocale): English on any machine.
    LANG: "en_US.UTF-8",
    ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
    ...overrides,
  };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return env;
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// The lines init and status end with for VS Code: the running server's port, from its own
// postmaster.pid, and the password file. The password is read only to show it is not printed.
async function databaseLines(indent = "  ") {
  const port = Number((await fsp.readFile(path.join(dataHome, "postgres", "data", "postmaster.pid"), "utf8")).split(/\r?\n/)[3]);
  return [
    "",
    indent + (indent ? "database" : "Database") + " in VS Code: install Microsoft's PostgreSQL extension and add a connection with",
    indent + "  Server 127.0.0.1  Port " + port + "  User bridge  Database bridge",
    indent + "  Password: copy it from " + path.join(dataHome, "postgres", "secret"),
  ];
}
const databasePassword = async () => (await fsp.readFile(path.join(dataHome, "postgres", "secret"), "utf8")).trim();

// init starts the resident page service; it is stopped before the workspace is removed, by serviceDown,
// the way `down` stops the page. The database is left running: `down` stops the person's database too
// (RC3-DOWN-01) and refuses while any project has a run running, and this process's own pool (inProcess)
// keeps pointing at that server; the fixture stops it when the file's tests end.
const { serviceDown } = await import("../review-bridge/features/setupCheck/pageService.mjs");
async function removeWorkspace(root, env = isolatedEnv()) {
  const paths = getBridgePaths(root, path.join(packageRoot, "review-bridge"), { privateRootName: ".review-bridge", env });
  await serviceDown({ paths, out: { write() {} } }).catch(() => {});
  await fsp.rm(root, { recursive: true, force: true });
}

// Scripted init: JSON output, fake service adapter, and a free port instead of the default.
async function scriptedInit(...args) {
  return [...args, "--json", "--fake-cli", "--port", String(await freePort())];
}

test("init without a terminal asks nothing, prints no plan, and ends with the next commands", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-plain-init-"));
  t.after(() => removeWorkspace(root));
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "clean-vue-app",
    private: true,
    dependencies: { vue: "latest" },
    devDependencies: { typescript: "latest", vite: "latest" },
  }, null, 2) + "\n", "utf8");

  const port = await freePort();
  const result = spawnSync(process.execPath, [bridge, "init", "--writer", "claude", "--reviewer", "codex", "--fake-cli", "--port", String(port)], {
    cwd: root,
    encoding: "utf8",
    env: isolatedEnv(),
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });

  assert.equal(result.status, 0, result.stderr);
  // The graph's line is in the project's language, the machine's that init wrote into bridge.json.
  const words = await createTranslator(await resolveLocale(projectPaths(root)));
  assert.deepEqual(result.stdout.trimEnd().split(/\r?\n/), [
    "Setting up .review-bridge/...",
    "Checking the setup...",
    "Running the four fake self-tests...",
    "Starting the local page...",
    // T0-GRAPH-01: init reads the project into its graph and says how much it read; this one holds no code.
    "Mapping the project...",
    words("graph.mapped", { files: 0, definitions: 0, references: 0, imports: 0 }),
    "",
    "Done. Now:",
    "",
    "  put a work order .md in .review-bridge/work-packages/, then in Claude Code type:",
    "    /review-bridge start .review-bridge/work-packages/<file>.md",
    "    (in Codex: $review-bridge start .review-bridge/work-packages/<file>.md)",
    "  at a terminal, for advanced use and CI:",
    "    npx review-bridge start .review-bridge/work-packages/<file>.md",
    "  page: http://localhost:" + port + "/",
    ...(await databaseLines()),
  ]);
  assert.doesNotMatch(result.stdout, /SHA-?256|plan_sha256|[0-9a-f]{64}|\[y\/N\]/i);
  assert.equal(result.stdout.includes(await databasePassword()), false, "the password itself is not printed");
  const config = JSON.parse(await fsp.readFile(path.join(root, ".review-bridge", "bridge.json"), "utf8"));
  assert.equal(config.profile_id, "vue-frontend");
});

test("R5 init keeps self-test artifacts disposable and installs both work-order templates", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-product-init-"));
  t.after(() => removeWorkspace(root));
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "clean-vite-vue-ts",
    private: true,
    scripts: { build: "vite build", typecheck: "vue-tsc --noEmit" },
    dependencies: { vue: "latest" },
    devDependencies: { typescript: "latest", vite: "latest" },
  }, null, 2) + "\n", "utf8");
  await fsp.writeFile(path.join(root, "README.md"), "# Clean Vue workspace\n", "utf8");

  const result = spawnSync(process.execPath, await scriptedInit(bridge, "init", "--target", root, "--writer", "claude", "--reviewer", "codex", "--yes"), {
    cwd: packageRoot,
    encoding: "utf8",
    env: isolatedEnv(),
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.profile, "vue-frontend");
  assert.equal(output.workspace_mode, "snapshot");
  assert.equal(output.git_required, false);
  assert.deepEqual(output.roles, { writer: "claude", reviewer: "codex" });
  assert.equal(output.role_readiness.native_ready, false);
  assert.equal(output.real_mode.ready, false);
  assert.equal(output.real_mode.authorization_ready, false);
  assert.deepEqual(output.fake_self_tests, [
    { scenario: "PASS", status: "pass" },
    { scenario: "FAIL_THEN_PASS", status: "pass" },
    { scenario: "HARD_STOP", status: "hard_stop" },
    { scenario: "RATE_LIMIT", status: "rate_limited" },
  ]);
  await fsp.access(path.join(projectPaths(root).stateRoot, "review-bridge-install.json"));
  assert.deepEqual(await fsp.readdir(path.join(root, ".review-bridge", "work-packages")), ["TEMPLATE.md", "TEMPLATE.zh-TW.md"]);
  // The project keeps only its settings and work orders; the run state lives outside it.
  assert.deepEqual((await fsp.readdir(path.join(root, ".review-bridge"))).sort(), ["bridge.json", "policy.override.json", "rules.md", "work-packages"]);

  const bootstrap = path.join(packageRoot, "review-bridge", "bootstrap.mjs");
  const doctor = spawnSync(process.execPath, [bootstrap, "doctor", "--fake-cli"], {
    cwd: root, encoding: "utf8", env: isolatedEnv(), windowsHide: true,
  });
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).native_readiness.ready, false);
  assert.equal(JSON.parse(doctor.stdout).native_readiness.reviewer_readonly_proven, "not_run");
  // Native work-start needs the reviewer proof, which a page started with the fake CLI never holds,
  // whichever way the yes comes; every other model entry point is closed.
  for (const { args, input, reason } of [
    { args: ["work-start", "--plan", "anything", "--approve", "anything"], reason: /the reviewer read-only check has not passed/ },
    { args: ["work-start", "--plan", "anything", "--yes"], reason: /the reviewer read-only check has not passed/ },
    { args: ["work-start", "--plan", "anything"], input: "y\n", reason: /the reviewer read-only check has not passed/ },
    { args: ["review"], reason: /for review: only start/ },
    { args: ["bounded-resume"], reason: /for bounded-resume: only start/ },
  ]) {
    const blocked = spawnSync(process.execPath, [bootstrap, ...args], {
      cwd: root,
      encoding: "utf8",
      env: isolatedEnv(),
      windowsHide: true,
      ...(input ? { input } : {}),
    });
    assert.equal(blocked.status, 2, `${args.join(" ")} should reject native execution`);
    assert.match(blocked.stderr, /Native execution is unavailable/);
    assert.match(blocked.stderr, reason);
  }
  // The v3 Stop-hook intake is gone: enqueue is no longer a command at all.
  const removed = spawnSync(process.execPath, [bootstrap, "enqueue", "--no-start"], {
    cwd: root, encoding: "utf8", env: isolatedEnv(), windowsHide: true,
  });
  assert.equal(removed.status, 2);
  assert.match(removed.stderr, /Unknown command: enqueue\. Run: npx review-bridge --help/);
  assert.deepEqual(await fsp.readdir(projectPaths(root).authorizationsDir), []);
});

test("role-first init supports either provider pairing without touching existing agent settings", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-roles-first-"));
  t.after(() => removeWorkspace(root));
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "clean-vue-app", dependencies: { vue: "latest" }, devDependencies: { vite: "latest", typescript: "latest" },
  }));
  await fsp.mkdir(path.join(root, ".claude"));
  await fsp.mkdir(path.join(root, ".codex"));
  await fsp.writeFile(path.join(root, ".claude", "settings.local.json"), "{\"keep\":true}\n");
  await fsp.writeFile(path.join(root, ".codex", "config.toml"), "keep = true\n");
  const result = spawnSync(process.execPath, await scriptedInit(
    bridge, "init", "--target", root, "--writer", "codex", "--reviewer", "claude", "--yes",
  ), { cwd: packageRoot, encoding: "utf8", env: isolatedEnv(), windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).roles, { writer: "codex", reviewer: "claude" });
  assert.equal(await fsp.readFile(path.join(root, ".claude", "settings.local.json"), "utf8"), "{\"keep\":true}\n");
  assert.equal(await fsp.readFile(path.join(root, ".codex", "config.toml"), "utf8"), "keep = true\n");
  // RC3-ENTRY-02: nothing of an agent's is added to the project; the entries are at user level.
  assert.deepEqual(await fsp.readdir(path.join(root, ".claude")), ["settings.local.json"]);
  assert.deepEqual(await fsp.readdir(path.join(root, ".codex")), ["config.toml"]);
  await fsp.access(path.join(isolatedHome, ".claude", "commands", "review-bridge.md"));
  await fsp.access(path.join(isolatedHome, ".agents", "skills", "review-bridge", "SKILL.md"));
  await fsp.access(path.join(projectPaths(root).stateRoot, "review-bridge-install.json"));
});

test("init takes one provider for both roles: each role is its own CLI process", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-same-provider-"));
  t.after(() => removeWorkspace(root));
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "same-provider-vue", dependencies: { vue: "latest" },
    devDependencies: { vite: "latest", typescript: "latest" },
  }));
  const result = spawnSync(process.execPath, await scriptedInit(
    bridge, "init", "--target", root, "--writer", "codex", "--reviewer", "codex", "--yes",
  ), { cwd: packageRoot, encoding: "utf8", env: isolatedEnv(), windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  // What stands between this folder and real work is the reviewer's own check, not the pairing.
  assert.deepEqual(Object.values(output.role_readiness.checks).map((check) => check.provider), ["codex", "codex"]);
  assert.equal(output.role_readiness.reviewer_readonly_proven, "not_run");
  const config = JSON.parse(await fsp.readFile(path.join(root, ".review-bridge", "bridge.json")));
  assert.equal(config.roles.writer.provider_id, "codex");
  assert.equal(config.roles.reviewer.provider_id, "codex");
});

test("init without a terminal takes claude and codex when no role is given or saved, and sets up an empty folder as type none", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-default-roles-"));
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-default-roles-home-"));
  const env = isolatedEnv({ REVIEW_BRIDGE_DATA_HOME: home });
  // The page's session is in that data home, so down looks there.
  t.after(async () => { await removeWorkspace(root, env); stopServerIn(home); await fsp.rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); });
  const result = spawnSync(process.execPath, await scriptedInit(bridge, "init", "--target", root), {
    cwd: packageRoot, encoding: "utf8", env, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.roles, { writer: "claude", reviewer: "codex" });
  assert.equal(output.profile, null);
  const config = JSON.parse(await fsp.readFile(path.join(root, ".review-bridge", "bridge.json"), "utf8"));
  assert.equal(config.profile_id, null);
  assert.deepEqual(config.test, { profile_id: null, rules: [] });
});

test("init with an unknown --profile is refused and writes nothing", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-unknown-profile-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [bridge, "init", "--target", root, "--profile", "cobol-mainframe", "--yes"], {
    cwd: packageRoot, encoding: "utf8", env: isolatedEnv(), windowsHide: true,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unsupported profile: cobol-mainframe/);
  assert.deepEqual(await fsp.readdir(root), []);
});

test("init without installed or signed-in CLIs completes fake setup but stays visibly not ready", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-no-cli-init-"));
  t.after(() => removeWorkspace(root));
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "no-cli-app", private: true }) + "\n");
  const result = spawnSync(process.execPath, await scriptedInit(
    bridge, "init", "--target", root, "--writer", "claude", "--reviewer", "codex", "--yes",
  ), { cwd: packageRoot, encoding: "utf8", env: isolatedEnv(), windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.role_readiness.checks.writer.cli_present, false);
  assert.equal(output.role_readiness.checks.reviewer.cli_present, false);
  assert.equal(output.role_readiness.ready_for_reviewer_probe, false);
  assert.equal(output.role_readiness.native_ready, false);
  assert.deepEqual(output.role_next_steps, [
    { role: "writer", provider: "claude", next_action: "install_cli" },
    { role: "reviewer", provider: "codex", next_action: "install_cli" },
  ]);
  assert.equal(output.real_mode.ready, false);
  assert.equal(output.real_mode.cli_available, false);
  assert.equal(output.fake_self_tests.length, 4);
  const blocked = spawnSync(process.execPath, [
    path.join(packageRoot, "review-bridge", "bootstrap.mjs"), "work-start", "--plan", "x", "--approve", "x", "--yes",
  ], { cwd: root, encoding: "utf8", env: isolatedEnv(), windowsHide: true });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /Native execution is unavailable/);
});

test("roles-check with an unprobeable CLI reports sign-in unknown, never ready", async (t) => {
  const fakeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-fake-cli-"));
  t.after(() => fsp.rm(fakeDir, { recursive: true, force: true }));
  const notExecutable = path.join(fakeDir, "not-a-cli.txt");
  await fsp.writeFile(notExecutable, "not executable\n");
  const result = spawnSync(process.execPath, [bridge, "roles-check", "--writer", "claude", "--reviewer", "codex", "--json"], {
    cwd: packageRoot, encoding: "utf8", windowsHide: true,
    env: isolatedEnv({ CLAUDE_REVIEW_CLI: notExecutable, CODEX_REVIEW_CLI: notExecutable }),
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  for (const role of ["writer", "reviewer"]) {
    assert.equal(output.checks[role].cli_present, true);
    assert.equal(output.checks[role].authenticated, "unknown");
    assert.equal(output.checks[role].next_action, "recheck_sign_in");
  }
  assert.equal(output.ready_for_reviewer_probe, false);
  assert.equal(output.native_ready, false);
});

test("init starts the resident service and ends with cd, the work folder, the start command and the page", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-service-init-"));
  t.after(() => removeWorkspace(root));
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "service-vue", dependencies: { vue: "latest" }, devDependencies: { vite: "latest", typescript: "latest" },
  }));
  const port = await freePort();
  const url = `http://localhost:${port}/`;
  const result = spawnSync(process.execPath, [
    bridge, "init", "--target", root, "--writer", "claude", "--reviewer", "codex", "--yes", "--fake-cli", "--port", String(port),
  ], { cwd: packageRoot, encoding: "utf8", env: isolatedEnv(), windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const workFolder = path.join(root, ".review-bridge", "work-packages");
  assert.deepEqual(result.stdout.trimEnd().split(/\r?\n/).slice(-13), [
    "Done. Now:",
    "",
    "  cd " + path.relative(packageRoot, root),
    "  put a work order .md in .review-bridge/work-packages/, then in Claude Code type:",
    "    /review-bridge start .review-bridge/work-packages/<file>.md",
    "    (in Codex: $review-bridge start .review-bridge/work-packages/<file>.md)",
    "  at a terminal, for advanced use and CI:",
    "    npx review-bridge start .review-bridge/work-packages/<file>.md",
    "  page: " + url,
    ...(await databaseLines()),
  ]);
  assert.equal(result.stdout.includes(await databasePassword()), false, "the password itself is not printed");
  await fsp.access(workFolder);
  const config = JSON.parse(await fsp.readFile(path.join(root, ".review-bridge", "bridge.json"), "utf8"));
  assert.deepEqual(config.watch, { port, strict_port: false });
  assert.equal((await fsp.readFile(projectPaths(root).watchUrlPath, "utf8")).trim(), url);
  assert.equal((await fetch(url)).status, 200);
  // B8: the URL init printed is the one the running service recorded and answers for.
  const session = JSON.parse(await fsp.readFile(projectPaths(root).watchSessionPath, "utf8"));
  assert.equal(session.url, url);
  assert.equal((await (await fetch(url + "api/status")).json()).service_id, session.service_id);

  const bootstrap = path.join(packageRoot, "review-bridge", "bootstrap.mjs");
  const run = (...args) => spawnSync(process.execPath, [bootstrap, ...args], { cwd: root, encoding: "utf8", windowsHide: true });
  // up says the database's line, then the page's, both in the language init gave the project (the
  // system's: English in the Linux container, Chinese on a Chinese Windows).
  const words = await createTranslator(await resolveLocale(projectPaths(root)));
  const databasePort = Number((await fsp.readFile(path.join(dataHome, "postgres", "data", "postmaster.pid"), "utf8")).split(/\r?\n/)[3]);
  assert.deepEqual(run("up", "--fake-cli").stdout.trim().split(/\r?\n/), [words("up.database", { port: databasePort }), words("page.up.already_running", { url })]);
  // ps prints the page's address and nothing counted from files (Fortes 2026-11-09).
  const running = run("ps");
  assert.equal(running.status, 0, running.stderr);
  assert.deepEqual(running.stdout.trim().split(/\r?\n/), [url]);
  // down stops the page and then the database, as docker compose down stops what up started.
  const down = run("down");
  assert.equal(down.status, 0, down.stdout + down.stderr);
  assert.deepEqual(down.stdout.trim().split(/\r?\n/), [words("down.page.stopped"), words("down.database.stopped")]);
  assert.equal(await fsp.stat(path.join(dataHome, "postgres", "data", "postmaster.pid")).catch(() => null), null, "the database is stopped");
  const ps = run("ps");
  assert.equal(ps.status, 1);
  assert.equal(ps.stdout.trim(), words("page.not_running"));
});

test("init --json adds the service URL", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-service-json-"));
  t.after(() => removeWorkspace(root));
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "json-app", private: true }) + "\n");
  const args = await scriptedInit(bridge, "init", "--target", root, "--writer", "claude", "--reviewer", "codex", "--yes");
  const result = spawnSync(process.execPath, args, {
    cwd: packageRoot, encoding: "utf8", env: isolatedEnv(), windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.url, `http://localhost:${args.at(-1)}/`);
  assert.equal(output.service_started, true);
  assert.equal(output.service_reason, "running");
  assert.equal(output.next_step.path, ".review-bridge/work-packages/TEMPLATE.md");
});

test("work-plan <file> plans a work order with the file name, the OS user and the queue as defaults", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-work-plan-file-"));
  t.after(() => removeWorkspace(root));
  const init = spawnSync(process.execPath, await scriptedInit(bridge, "init", "--target", root, "--yes"), {
    cwd: packageRoot, encoding: "utf8", env: isolatedEnv(), windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(init.status, 0, init.stderr);
  // A work order says what to do and gives an acceptance list (the form check, DECISIONS 2026-11-08).
  await fsp.writeFile(path.join(root, ".review-bridge", "work-packages", "add-readme.md"), "# Work order: add a README\n\n<!-- bridge:requested_work -->\nAdd a README.\n\n<!-- bridge:acceptance -->\n- A README exists.\n");
  const file = ".review-bridge/work-packages/add-readme.md";
  const run = (...args) => spawnSync(process.execPath, [bridge, "work-plan", ...args, "--fake-cli"], { cwd: root, encoding: "utf8", env: isolatedEnv(), windowsHide: true });

  // Without them it is not a contract, and no plan is written: the form check, not a model, says so.
  const loose = ".review-bridge/work-packages/loose.md";
  await fsp.writeFile(path.join(root, loose), "# Work order: add a README\n\nA README exists.\n");
  const refused = run(loose, "--breakpoint", "after the review");
  assert.equal(refused.status, 2, refused.stdout);
  assert.match(refused.stderr, /The work order lacks what it must say:/);
  assert.match(refused.stderr, / requested_work is empty or missing;/);
  assert.match(refused.stderr, / acceptance is empty or missing;/);
  assert.equal(refused.stdout, "");

  // D4: two lines by default; JSON only with --json.
  const plain = run(file, "--breakpoint", "after the review");
  assert.equal(plain.status, 0, plain.stderr);
  const [, planFile] = /^Plan written to (.+)\n/.exec(plain.stdout) || [];
  assert.ok(planFile?.startsWith(projectPaths(root).logRoot) && planFile.endsWith("add-readme.plan.json"), plain.stdout);
  assert.deepEqual(plain.stdout.trimEnd().split(/\r?\n/), ["Plan written to " + planFile, "Next: npx review-bridge work-start --plan " + planFile]);
  const planned = run(file, "--breakpoint", "after the review", "--json");
  assert.equal(planned.status, 0, planned.stderr);
  const output = JSON.parse(planned.stdout);
  assert.equal(output.work_package, "add-readme");
  assert.equal(output.owner, os.userInfo().username);
  assert.equal(output.plan_path, path.join(projectPaths(root).runLogDir((await readJsonFile(output.plan_path)).proposed_run_id), "add-readme.plan.json"));
  await fsp.access(output.plan_path);

  // A type-none project has no test rules: the work still plans, and its tests are not configured.
  assert.deepEqual(output.test, { kind: "not_configured", command: null, label: "沒有設定測試", checked: [] });
  // Priority, effort and budget come from the policy when the work order says nothing, each with its layer.
  assert.equal(output.priority, "medium");
  assert.equal(output.writer.effort, "medium");
  assert.deepEqual(output.budget, { tokens: 4_000_000, tokens_per_call: 1_500_000, call_timeout: 900_000, test_timeout: 600_000, run_timeout: 21_600_000, rounds: 2 });
  assert.ok(Object.values(output.budget_source).every((source) => source === "config"));

  // Without a terminal the breakpoint is still required, and the refusal says what to add (C4).
  const bare = run(file);
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /A breakpoint is required\. Add --breakpoint "<where to stop>" or answer the prompt\./);
  const twice = run(file, "--task-file", file, "--breakpoint", "x");
  assert.equal(twice.status, 2);
  assert.match(twice.stderr, /Give the work order once/);
});

// The Owner's case: an empty folder set up as vue-frontend. A chosen type is used as chosen; its
// rule finds no test script, so the work starts and every record says its tests are not configured.
test("a chosen project type that does not fit the folder is set up, and its work plans with the tests not configured", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-chosen-type-"));
  t.after(() => removeWorkspace(root));
  const init = spawnSync(process.execPath, await scriptedInit(bridge, "init", "--target", root, "--profile", "vue-frontend", "--yes"), {
    cwd: packageRoot, encoding: "utf8", env: isolatedEnv(), windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(init.status, 0, init.stderr);
  const config = JSON.parse(await fsp.readFile(path.join(root, ".review-bridge", "bridge.json"), "utf8"));
  assert.equal(config.profile_id, "vue-frontend");
  assert.deepEqual(config.test.rules, [{ command: "npm test", package_script: "test" }]);

  await fsp.writeFile(path.join(root, ".review-bridge", "work-packages", "fix.md"), "# Work order: fix\n\n<!-- bridge:requested_work -->\nFix it.\n\n<!-- bridge:acceptance -->\n- It works.\n");
  const run = (...args) => spawnSync(process.execPath, [bridge, "work-plan", ".review-bridge/work-packages/fix.md", "--fake-cli", ...args], {
    cwd: root, encoding: "utf8", env: isolatedEnv(), windowsHide: true,
  });
  const planned = run("--breakpoint", "after the review", "--json");
  assert.equal(planned.status, 0, planned.stderr);
  const { test: sealed } = JSON.parse(planned.stdout);
  assert.equal(sealed.kind, "not_configured");
  assert.deepEqual(sealed.checked.map((rule) => rule.command), ["npm test"]);
});

test("init with a project type whose test rule fits passes its four self-tests: they check Bridge's paths, not the project's tests", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-tested-type-"));
  t.after(() => removeWorkspace(root));
  // The test script needs the project's dependencies, which the self-tests' copy does not have.
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "tested-vue-app", private: true, scripts: { test: "vitest run" }, dependencies: { vue: "latest" }, devDependencies: { vitest: "latest" },
  }, null, 2) + "\n", "utf8");
  const init = spawnSync(process.execPath, await scriptedInit(bridge, "init", "--target", root, "--profile", "vue-frontend", "--yes"), {
    cwd: packageRoot, encoding: "utf8", env: isolatedEnv(), windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  assert.deepEqual(JSON.parse(init.stdout).fake_self_tests.map((entry) => entry.status), ["pass", "pass", "hard_stop", "rate_limited"]);
  // The project keeps its test rule; only the self-tests' copy runs without one.
  const config = JSON.parse(await fsp.readFile(path.join(root, ".review-bridge", "bridge.json"), "utf8"));
  assert.deepEqual(config.test.rules, [{ command: "npm test", package_script: "test" }]);
});

// B1: one command from a work order to its result. With the fake CLI the reviewer check is not
// needed and --yes, after the card, stands in for the person's answer.
test("start plans a Chinese work order, shows the card, runs one line per step and ends with the result file", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-start-"));
  t.after(() => removeWorkspace(root));
  const init = spawnSync(process.execPath, await scriptedInit(bridge, "init", "--target", root, "--yes"), {
    cwd: packageRoot, encoding: "utf8", env: isolatedEnv(), windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(init.status, 0, init.stderr);
  const order = ".review-bridge/work-packages/hello.md";
  await fsp.writeFile(path.join(root, order), "# 工單：新增 README\n\n<!-- bridge:requested_work -->\n在專案根目錄加一個 README。\n\n<!-- bridge:acceptance -->\n## 驗收\n\n1. 專案根目錄存在 `README.md`。\n");
  const start = (...args) => spawnSync(process.execPath, [bridge, "start", order, ...args], {
    cwd: root, encoding: "utf8", env: isolatedEnv(), windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(start("--fake-cli", "--breakpoint", "after the review").status, 1, "the card --yes is for");
  const done = start("--fake-cli", "--yes", "--breakpoint", "after the review");
  assert.equal(done.status, 0, done.stderr);
  const lines = done.stdout.trimEnd().split(/\r?\n/);
  assert.match(lines[0], /^Plan from the card: .+[\\/]hello\.plan\.json$/);
  assert.ok(lines[0].slice("Plan from the card: ".length).startsWith(projectPaths(root).logRoot), lines[0]);
  assert.ok(lines.includes("Reviewer read-only check: not needed with the fake CLI (no model is called)"));
  for (const line of ["Work order:   " + order, "Stops:        after the review", "Tests:        not configured (no test rule matched; the work starts without tests)",
    "Priority:     medium (config)",
    "Writer:       claude (config), model the CLI's default (priority table), effort medium (priority table)",
    "Reviewer:     codex (config), model the CLI's default (priority table), effort medium (priority table)",
    "Reviewer MCP: none",
    "Budget:       tokens 4000000 (config), tokens_per_call 1500000 (config), call_timeout 900000 (config), test_timeout 600000 (config), run_timeout 21600000 (config), rounds 2 (config)", "  │ # 工單：新增 README", "  │ 1. 專案根目錄存在 `README.md`。"]) {
    assert.ok(lines.includes(line), line);
  }
  // The contract was cut from the work order when the plan was made; the card names it, and nothing was translated.
  assert.ok(lines.some((line) => /^Contract: {5}sha256 [0-9a-f]{64}, 1 condition\(s\) cut from the acceptance list$/.test(line)), done.stdout);
  assert.doesNotMatch(done.stdout, /turning it into a contract/);
  const steps = lines.filter((line) => /^ {2}[A-Z]/.test(line));
  assert.deepEqual(steps, [
    "  Writer working (call 1 of 2)",
    "  Tests: not configured for this project",
    "  Reviewer checking the work",
  ]);
  assert.match(done.stdout, /\nDelivered: .*\nResult file: .*[\\/]\.review-bridge[\\/]results[\\/]hello[\\/]hello \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2} success\.md\nTokens: /);
});

// T0-GRAPH-01: init reads a Git project's code into its graph in the person's database and writes nothing
// in the project; a start re-reads only the file that changed since. The file Git sees as changed and the
// file whose content is new are the same here; a file left as it was keeps the time it was parsed.
test("init maps a Git project's code into its graph and leaves git status as it was; a start re-reads only the changed file", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-graph-init-"));
  t.after(() => removeWorkspace(root));
  const gitDir = path.dirname(spawnSync(process.platform === "win32" ? "where.exe" : "which", ["git"], { encoding: "utf8" }).stdout.split(/\r?\n/)[0].trim());
  const env = (overrides = {}) => isolatedEnv({ PATH: isolatedEnv().PATH + path.delimiter + gitDir, ...overrides });
  const git = (...args) => {
    const done = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root, encoding: "utf8", windowsHide: true });
    assert.equal(done.status, 0, done.stderr);
    return done.stdout;
  };
  await fsp.mkdir(path.join(root, "src"));
  await fsp.writeFile(path.join(root, "src", "a.ts"), "import { b } from \"./b\";\nexport function a() {\n  return b();\n}\n");
  await fsp.writeFile(path.join(root, "src", "b.ts"), "export function b() {\n  return 1;\n}\n");
  await fsp.writeFile(path.join(root, "src", "broken.ts"), "export function broken( {\n");
  await fsp.writeFile(path.join(root, "notes.md"), "# not code\n");
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "start");
  const statusBefore = git("status", "--porcelain=v1", "--untracked-files=all");

  const init = spawnSync(process.execPath, await scriptedInit(bridge, "init", "--target", root, "--yes"), {
    cwd: packageRoot, encoding: "utf8", env: env(), windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(init.status, 0, init.stderr);
  const output = JSON.parse(init.stdout);
  assert.equal(output.graph.files, 3, "three TypeScript files; notes.md is not read");
  assert.deepEqual(output.graph.incomplete, [{ path: "src/broken.ts", parse_status: "parsed", error_count: 1 }]);
  assert.equal(git("status", "--porcelain=v1", "--untracked-files=all"), statusBefore, "nothing outside .review-bridge/, which Git does not see");

  const projectId = projectPaths(root).projectId;
  assert.deepEqual(await queryRecords("select f.path, d.kind from graph_definitions d join graph_files f using (file_id) where d.project_id = $1 and d.name = 'b'", [projectId]), [{ path: "src/b.ts", kind: "function" }]);
  assert.deepEqual(await queryRecords("select f.path, r.line from graph_references r join graph_files f using (file_id) where r.project_id = $1 and r.name = 'b'", [projectId]), [{ path: "src/a.ts", line: 3 }]);
  assert.deepEqual(await queryRecords("select f.path, i.status, i.target_path from graph_imports i join graph_files f using (file_id) where i.project_id = $1", [projectId]), [{ path: "src/a.ts", status: "resolved", target_path: "src/b.ts" }]);
  const parsedAt = async () => Object.fromEntries((await queryRecords("select path, parsed_at from graph_files where project_id = $1", [projectId])).map((row) => [row.path, row.parsed_at.toISOString()]));
  const before = await parsedAt();

  await fsp.writeFile(path.join(root, "src", "b.ts"), "export function b() {\n  return 1;\n}\nexport function c() {\n  return 2;\n}\n");
  const order = ".review-bridge/work-packages/hello.md";
  await fsp.writeFile(path.join(root, order), "# Add a README\n\n<!-- bridge:requested_work -->\nAdd a README.\n\n<!-- bridge:acceptance -->\n## Acceptance\n\n1. README.md exists.\n");
  // A yes needs the card it answers: the first start shows it and stops, the second says yes to it.
  const start = (...args) => spawnSync(process.execPath, [bridge, "start", order, "--fake-cli", "--breakpoint", "after the review", ...args], {
    cwd: root, encoding: "utf8", env: env(), windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  const card = start();
  assert.equal(card.status, 1, card.stdout + card.stderr);
  assert.match(card.stdout, /Needs authorization/);
  const started = start("--yes");
  assert.equal(started.status, 0, started.stdout + started.stderr);
  const after = await parsedAt();
  assert.equal(after["src/a.ts"], before["src/a.ts"], "a file that did not change is not read again");
  assert.equal(after["src/broken.ts"], before["src/broken.ts"]);
  assert.notEqual(after["src/b.ts"], before["src/b.ts"], "the changed file is read again");
  assert.deepEqual(await queryRecords("select f.path from graph_definitions d join graph_files f using (file_id) where d.project_id = $1 and d.name = 'c'", [projectId]), [{ path: "src/b.ts" }]);

  // Bridge read the graph itself and put it into the prompts (Fortes 2026-11-09): this work order names
  // nothing the graph defines, so the writer gets the project's folders; the reviewer gets what the change
  // touched; the result counts the statements and the tokens.
  const [{ run_id: runId }] = await queryRecords("select run_id from runs where project_id = $1 order by created_at desc limit 1", [projectId]);
  const logs = projectPaths(root).runLogDir(runId);
  const promptFile = (await fsp.readdir(logs)).find((name) => name.endsWith("-writer-only-prompt.txt"));
  const prompt = await fsp.readFile(path.join(logs, promptFile), "utf8");
  assert.match(prompt, /=== PROJECT \(review-bridge-graph\) ===\nProject graph: no name or file in the work order is in the project's index of 3 file\(s\)\. Its folders, largest first:\n- src \(3 file\(s\)\)/);
  const inputs = await queryRecords("select type, payload from run_events where run_id = $1 and type in ('task.input', 'review.input') order by sequence", [runId]);
  assert.deepEqual(inputs.map((row) => row.type), ["task.input", "review.input"]);
  assert.ok(inputs.every((row) => row.payload.graph && row.payload.graph.tokens > 0), JSON.stringify(inputs.map((row) => row.payload.graph)));
  assert.match(inputs[1].payload.project_graph, /^Project graph: /, "the reviewer's packet carries its section");
  const result = await fsp.readFile(path.join(root, ".review-bridge", "results", "hello", (await fsp.readdir(path.join(root, ".review-bridge", "results", "hello"))).find((name) => name.endsWith(".md") && !name.startsWith("contract"))), "utf8");
  assert.match(result, /^\| graph lookups \| \d+ SQL \| about \d+ prompt tokens \|/m);
});

// init on a folder whose install record is gone rebuilds the record, as git init reinitializes, and reads
// the project into its graph again, as a first init does (Fortes 2026-11-09).
test("init that reinitializes a set-up folder reads the project into its graph again and says what it read", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-graph-reinit-"));
  t.after(() => removeWorkspace(root));
  await fsp.mkdir(path.join(root, "src"));
  await fsp.writeFile(path.join(root, "src", "a.ts"), "export function a() {\n  return 1;\n}\n");
  const first = spawnSync(process.execPath, await scriptedInit(bridge, "init", "--target", root, "--yes"), {
    cwd: packageRoot, encoding: "utf8", env: isolatedEnv(), windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(first.status, 0, first.stderr);
  // The page is stopped while its session file is still there; then the install record goes.
  await serviceDown({ paths: projectPaths(root), out: { write() {} } });
  await fsp.writeFile(path.join(root, "src", "b.ts"), "export class B {}\n");
  await fsp.rm(projectPaths(root).stateRoot, { recursive: true, force: true });
  const again = spawnSync(process.execPath, [bridge, "init", "--target", root, "--yes", "--fake-cli"], {
    cwd: packageRoot, encoding: "utf8", env: isolatedEnv(), windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(again.status, 0, again.stderr);
  // The graph line is in the project's language, the machine's that init wrote into bridge.json.
  const words = await createTranslator(await resolveLocale(projectPaths(root)));
  assert.deepEqual(again.stdout.trimEnd().split(/\r?\n/).slice(1), [words("graph.mapped", { files: 2, definitions: 2, references: 0, imports: 0 })]);
  assert.match(again.stdout, /^Reinitialized existing Review Bridge setup in /);
  const projectId = projectPaths(root).projectId;
  assert.deepEqual((await queryRecords("select path from graph_files where project_id = $1 order by path", [projectId])).map((row) => row.path), ["src/a.ts", "src/b.ts"]);
});

// An agent's one yes, to the card the start before it printed (Owner 2026-11-08: one card, one yes).
function yesTo(cli, order, args = [], env = {}) {
  return cli(["start", order, "--fake-cli", ...args, "--yes"], env);
}

// E: four actions for people (start, stop, resume, clean) on three routes: a person at a terminal
// (the pty acceptance run), VS Code's terminal (the same CLI) and an agent with no terminal. An
// agent's start and resume print the card and stop; the agent runs them again with --yes once the
// person said yes. All with the fake CLI: no model is called.
// The project is a copy of one real init made for this file (isolatedDataHome.mjs copyProject), with a
// new id, as PostgreSQL's tests copy an initdb'd template; a test that needs the page init itself started
// asks for `ownInit`.
async function fourActionsInit(prefix) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  const init = spawnSync(process.execPath, await scriptedInit(bridge, "init", "--target", root, "--yes"), {
    cwd: packageRoot, encoding: "utf8", env: isolatedEnv(), windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(init.status, 0, init.stderr);
  return root;
}

async function fourActionsProject(t, prefix, { ownInit = false } = {}) {
  let root;
  if (ownInit) {
    root = await fourActionsInit(prefix);
    t.after(() => removeWorkspace(root));
  } else {
    root = await copyProject(t, await projectTemplate("four-actions", () => fourActionsInit("review-bridge-four-actions-template-")), prefix);
  }
  const order = ".review-bridge/work-packages/hello.md";
  await fsp.writeFile(path.join(root, order), "# 工單：新增 README\n\n<!-- bridge:requested_work -->\n在專案根目錄加一個 README。\n\n<!-- bridge:acceptance -->\n## 驗收\n\n1. 專案根目錄存在 `README.md`。\n");
  const cli = (args, env = {}) => spawnSync(process.execPath, [bridge, ...args], {
    cwd: root, encoding: "utf8", env: isolatedEnv(env), windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  const queue = projectPaths(root).stateRoot;
  const listed = async (folder) => (await fsp.readdir(path.join(queue, folder)).catch(() => [])).filter((name) => name.endsWith(".json"));
  return { root, order, cli, queue, listed };
}

test("an agent's start prints the card and stops; with --yes it runs, and records the yes as the agent's", async (t) => {
  const { root, order, cli, queue, listed } = await fourActionsProject(t, "review-bridge-agent-start-");
  const card = cli(["start", order, "--fake-cli"]);
  assert.equal(card.status, 1);
  const lines = card.stdout.trimEnd().split(/\r?\n/);
  for (const line of ["Stops:        after the review", "Tests:        not configured (no test rule matched; the work starts without tests)",
    "Budget:       tokens 4000000 (config), tokens_per_call 1500000 (config), call_timeout 900000 (config), test_timeout 600000 (config), run_timeout 21600000 (config), rounds 2 (config)", "  │ # 工單：新增 README", "  │ 1. 專案根目錄存在 `README.md`。"]) {
    assert.ok(lines.includes(line), line);
  }
  assert.ok(lines.some((line) => line.startsWith("Contract:     ")) && lines.some((line) => line.startsWith("Valid until:  ")));
  assert.equal(lines.at(-1), "Needs authorization. If the person says yes, run again: npx review-bridge start " + order + " --fake-cli --yes");
  assert.deepEqual(await listed("runs"), [], "nothing started");
  assert.deepEqual(await listed("authorizations"), [], "nothing authorized");

  const yes = yesTo(cli, order);
  assert.equal(yes.status, 0, yes.stderr);
  assert.match(yes.stdout, /\nDelivered: .*\nResult file: /);
  const [authorizationFile] = await listed("authorizations");
  const authorization = JSON.parse(await fsp.readFile(path.join(queue, "authorizations", authorizationFile), "utf8"));
  assert.equal(authorization.authorized_via, "agent");
  // The yes wrote the work order's id into the front matter; the hash is of what the person wrote, without it.
  const text = await fsp.readFile(path.join(root, order), "utf8");
  assert.match(text, /^---\nid: [0-9a-f-]{36}\n---\n/);
  const { createHash } = await import("node:crypto");
  assert.equal(authorization.work_order_sha256, createHash("sha256").update(sealedText(text).trim()).digest("hex"));
  const [runFile] = await listed("runs");
  const run = JSON.parse(await fsp.readFile(path.join(queue, "runs", runFile), "utf8"));
  assert.equal(run.authorized_via, "agent");
  assert.match(run.contract_sha256, /^[0-9a-f]{64}$/, "the contract sealed under this yes is on the run");
});

// An agent runs start without a terminal. Nothing is planned quietly as docs any more: when the
// project's rules give a test command, the card names it and the tests run after the writer.
test("an agent's start --yes runs the project's tests when its rules give a command", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-agent-tests-"));
  t.after(() => removeWorkspace(root));
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "agent-tests", dependencies: { express: "4.0.0" }, scripts: { test: "node -e \"process.exit(0)\"" } }) + "\n");
  const init = spawnSync(process.execPath, await scriptedInit(bridge, "init", "--target", root, "--yes"), {
    cwd: packageRoot, encoding: "utf8", env: isolatedEnv(), windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(init.status, 0, init.stderr);
  const order = ".review-bridge/work-packages/hello.md";
  await fsp.writeFile(path.join(root, order), "# 工單：新增 README\n\n<!-- bridge:requested_work -->\n在專案根目錄加一個 README。\n\n<!-- bridge:acceptance -->\n## 驗收\n\n1. 專案根目錄存在 `README.md`。\n");
  const cli = (args) => spawnSync(process.execPath, [bridge, ...args], { cwd: root, encoding: "utf8", env: isolatedEnv(), windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const card = cli(["start", order, "--fake-cli"]);
  assert.equal(card.status, 1, card.stderr);
  assert.ok(card.stdout.split(/\r?\n/).includes("Tests:        runs npm test after each writer call"), card.stdout);
  const yes = yesTo(cli, order);
  assert.equal(yes.status, 0, yes.stdout + yes.stderr);
  assert.match(yes.stdout, /\n {2}Tests: running npm test\n {2}Tests passed\n/);
  const [runFile] = (await fsp.readdir(projectPaths(root).runsDir)).filter((name) => name.endsWith(".json"));
  assert.deepEqual(await queryRecords("select kind, passed from test_results where run_id = $1", [runFile.slice(0, -5)]), [{ kind: "command", passed: true }]);
});

// E8, E10: the yes is for the card the person saw, once. A work order edited between the card and
// --yes is refused, and stays refused until a new card is shown; --yes with no card shown, with an
// option the card did not show, or a second time on one card is refused too.
test("--yes is refused when the work order changed after the card, when no card was shown, or when the card was used", async (t) => {
  const { root, order, cli, listed } = await fourActionsProject(t, "review-bridge-card-changed-");
  const noCard = cli(["start", order, "--fake-cli", "--yes"]);
  assert.equal(noCard.status, 1, noCard.stderr);
  assert.equal(noCard.stdout, "No card was shown for this work order, so there is no yes to run on. Run: npx review-bridge start " + order + " --fake-cli and show the person the card.\n");

  assert.equal(cli(["start", order, "--fake-cli"]).status, 1);
  const file = path.join(root, order);
  await fsp.writeFile(file, (await fsp.readFile(file, "utf8")).replace("README", "READMe"));
  const refusal = "The work order changed after you saw the card. Run: npx review-bridge start " + order + " --fake-cli and look again.\n";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const changed = cli(["start", order, "--fake-cli", "--yes"]);
    assert.equal(changed.status, 1, changed.stderr);
    assert.equal(changed.stdout, refusal, "refused again: the card's plan was left as it was");
  }
  assert.deepEqual(await listed("runs"), [], "nothing started");
  assert.deepEqual(await listed("authorizations"), [], "nothing authorized");

  const card = cli(["start", order, "--fake-cli"]);
  assert.equal(card.status, 1);
  assert.match(card.stdout, /\n {2}│ # 工單：新增 READMe\n/, "the new card shows the edit");
  const other = cli(["start", order, "--fake-cli", "--yes", "--rounds", "1"]);
  assert.equal(other.status, 1, other.stderr);
  assert.equal(other.stdout, "--rounds is not what the card showed. Run: npx review-bridge start " + order + " --fake-cli --yes without it, or npx review-bridge start " + order + " --fake-cli to show the person a new card.\n");
  const yes = yesTo(cli, order, ["--rounds", "2"]);
  assert.equal(yes.status, 0, yes.stdout + yes.stderr);
  assert.match(yes.stdout, /^Plan from the card: .*hello\.plan\.json\n/);
  assert.match(yes.stdout, /\nDelivered: .*\nResult file: /);
  // E10: one card, one yes.
  const again = cli(["start", order, "--fake-cli", "--yes"]);
  assert.equal(again.status, 1, again.stderr);
  assert.equal(again.stdout, "This card was already said yes to; one card starts one run. Run: npx review-bridge start " + order + " --fake-cli and show the person the new card.\n");
  assert.equal((await listed("runs")).length, 1, "one run from one card");
});

// RC3-BLOCKER-01 step 2: the card says which work order the yes starts (spec 2026-10-24), and the
// start lands in the person's database: the work order, its versions, one plan per card, one claim
// per yes, one contract per run.
// The work order is the id Bridge writes into its front matter on the first yes (DECISIONS 2026-11-08 10:4x),
// as Docusaurus and Astro read a document's id there: no content is compared.
test("the card names the work order by its id: new, updated, moved or copied; a no writes nothing; the records are in the database", async (t) => {
  const { root, order, cli } = await fourActionsProject(t, "review-bridge-identity-");
  const { project_id: projectId } = JSON.parse(await fsp.readFile(path.join(root, ".review-bridge", "bridge.json"), "utf8"));
  const decision = (args) => {
    const card = cli(["start", ...args, "--fake-cli"]);
    assert.equal(card.status, 1, card.stderr);
    return card.stdout.split(/\r?\n/)[card.stdout.split(/\r?\n/).findIndex((line) => line.startsWith("Work order:   ")) + 1].trim();
  };
  const yes = (file) => assert.equal(yesTo(cli, file).status, 0);
  const read = (file) => fsp.readFile(path.join(root, file), "utf8");
  const idOf = async (file) => /^---\r?\nid: ([0-9a-f-]{36})\r?\n/.exec(await read(file))?.[1] ?? null;
  const original = await read(order);
  assert.equal(decision([order]), "New work order \"工單：新增 README\"");
  assert.equal(await read(order), original, "a card, and no yes, writes nothing");
  yes(order);
  const id = await idOf(order);
  assert.ok(id, "the yes wrote the id");
  assert.equal(await read(order), "---\nid: " + id + "\n---\n" + original, "only the id lines were added");
  const [{ work_order_id: recorded }] = await queryRecords("select work_order_id from work_orders where project_id = $1", [projectId]);
  assert.equal(recorded, id);
  await fsp.appendFile(path.join(root, order), "2. README 有專案名稱。\n");
  assert.equal(decision([order]), "Updates \"工單：新增 README\": version 1 → 2, 1 line(s) changed");
  yes(order);
  assert.equal(decision([order]), "Updates \"工單：新增 README\": still version 2, with new run settings", "the id line is not part of the text");
  // A copy holds the original's id: it is a new work order, and its yes gives it its own id.
  const copy = ".review-bridge/work-packages/hello-copy.md";
  await fsp.copyFile(path.join(root, order), path.join(root, copy));
  await fsp.appendFile(path.join(root, copy), "3. 另一個版本。\n");
  assert.equal(decision([copy]), "A copy of .review-bridge/work-packages/hello.md: recorded as a new work order \"工單：新增 README\"");
  yes(copy);
  assert.notEqual(await idOf(copy), id);
  assert.equal(await idOf(order), id, "the original keeps its id");
  // Moved and renamed: the same work order, by its id; new text is its next version.
  const moved = ".review-bridge/work-packages/readme.md";
  await fsp.rename(path.join(root, order), path.join(root, moved));
  await fsp.appendFile(path.join(root, moved), "3. 一行說明。\n");
  assert.equal(decision([moved]), "Updates \"工單：新增 README\": version 2 → 3, 1 line(s) changed (was at .review-bridge/work-packages/hello.md)");
  yes(moved);
  // Written over without its id (a whole text pasted in): a new work order at the card, and its yes is
  // taken, though the records last saw another work order under that name (Fortes 2026-11-09).
  await fsp.writeFile(path.join(root, moved), (await read(moved)).replace(/^---\nid: [0-9a-f-]{36}\n---\n/, ""));
  assert.equal(await idOf(moved), null);
  assert.equal(decision([moved]), "New work order \"工單：新增 README\"");
  yes(moved);
  const pasted = await idOf(moved);
  assert.ok(pasted && pasted !== id, "its yes gave it an id of its own");
  // Two short work orders from one template, without ids or source_id: two new work orders, never a rename.
  const twin = (name, sentence) => fsp.writeFile(path.join(root, ".review-bridge/work-packages", name), "# 工單\n\n<!-- bridge:requested_work -->\n" + sentence + "\n\n<!-- bridge:acceptance -->\n- 做好了。\n");
  await twin("one.md", "加一行。");
  await twin("two.md", "刪一行。");
  await fsp.rm(path.join(root, ".review-bridge/work-packages/one.md"));
  assert.equal(decision([".review-bridge/work-packages/two.md"]), "New work order \"工單\"");

  const rows = async (sql) => await queryRecords(sql, [projectId]);
  assert.deepEqual((await rows("select work_order_id, last_file_name from work_orders where project_id = $1 order by created_at")).map((row) => [row.work_order_id === id ? "original" : row.work_order_id === pasted ? "pasted" : "copy", row.last_file_name]),
    [["original", moved], ["copy", copy], ["pasted", moved]]);
  // This one names its work order in the SQL and takes no parameter.
  assert.deepEqual((await queryRecords("select v.version_no from work_order_versions v where v.work_order_id = '" + id + "' order by 1")).map((row) => row.version_no), [1, 2, 3]);
  const claims = await rows("select c.run_id from authorization_claims c join authorizations a using (authorization_id) join plans p using (plan_sha256) where p.project_id = $1");
  assert.equal(claims.length, 5, "one claim per yes");
  const contracts = await rows("select c.contract_sha256 from contracts c join work_orders w using (work_order_id) where w.project_id = $1");
  for (const { run_id: runId } of claims) {
    const run = JSON.parse(await fsp.readFile(path.join(projectPaths(root).runsDir, runId + ".json"), "utf8"));
    assert.ok(contracts.some((row) => row.contract_sha256 === run.contract_sha256), "the run's contract is recorded");
  }
});

test("two --yes to one card at once start one run; clean --all clears the project's records", async (t) => {
  const { root, order, cli, listed } = await fourActionsProject(t, "review-bridge-two-yes-");
  const { project_id: projectId } = JSON.parse(await fsp.readFile(path.join(root, ".review-bridge", "bridge.json"), "utf8"));
  assert.equal(cli(["start", order, "--fake-cli"]).status, 1);
  const { spawn } = await import("node:child_process");
  const yes = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [bridge, "start", order, "--fake-cli", "--yes"], { cwd: root, env: isolatedEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("close", (code) => resolve({ code, output }));
  });
  const results = await Promise.all([yes(), yes()]);
  assert.deepEqual(results.map((result) => result.code === 0).sort(), [false, true], results.map((result) => result.output).join("\n----\n"));
  assert.match(results.find((result) => result.code !== 0).output, /already said yes to|already being started|in progress|already consumed/);
  assert.equal((await listed("runs")).length, 1);
  assert.equal((await queryRecords("select count(*)::int as n from authorization_claims c join authorizations a using (authorization_id) join plans p using (plan_sha256) where p.project_id = $1", [projectId]))[0].n, 1);

  const cleared = cli(["clean", "--all"]);
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.match(cleared.stdout, /^Cleared this project's records: 1 work order\(s\), 1 version\(s\), 1 plan\(s\), 1 authorization\(s\), 1 contract\(s\), 1 run\(s\), \d+ graph file\(s\)\.\n/);
  assert.equal((await queryRecords("select count(*)::int as n from plans where project_id = $1", [projectId]))[0].n, 0);
  assert.ok((await queryRecords("select cleared_at from projects where project_id = $1", [projectId]))[0].cleared_at);
  const after = cli(["start", order, "--fake-cli"]);
  assert.equal(after.status, 2);
  assert.match(after.stderr, /records were cleared \(clean --all\)/);
  // --project <folder> keeps its one meaning: the folder to work on, here with clean --all too.
  const elsewhere = spawnSync(process.execPath, [bridge, "clean", "--all", "--project", root], { cwd: os.tmpdir(), encoding: "utf8", env: isolatedEnv(), windowsHide: true });
  assert.equal(elsewhere.status, 2);
  assert.match(elsewhere.stderr, /records were cleared \(clean --all\)/, "the project named by --project was the one looked at");
});

// RC3-BLOCKER-01 step 3: the run, its one timeline, each condition's verdict, the tests and the delivery
// are in the database; a stopped run is recorded as stopped; clean <run_id> is one delete that takes
// every row the run owns and keeps its authorization and claim.
test("a run's events, verdicts, tests and delivery are in the database; stop and clean <run_id> follow", async (t) => {
  const { root, order, cli, queue } = await fourActionsProject(t, "review-bridge-run-records-");
  assert.equal(cli(["start", order, "--fake-cli"]).status, 1);
  assert.equal(yesTo(cli, order).status, 0);
  const [runFile] = (await fsp.readdir(path.join(queue, "runs"))).filter((name) => name.endsWith(".json"));
  const runId = runFile.slice(0, -5);
  const file = JSON.parse(await fsp.readFile(path.join(queue, "runs", runFile), "utf8"));
  const [run] = await queryRecords("select status, conclusion, closed_reason, contract_sha256, last_event_sequence from runs where run_id = $1", [runId]);
  assert.deepEqual({ status: run.status, conclusion: run.conclusion, closed_reason: run.closed_reason, contract: run.contract_sha256 },
    { status: "completed", conclusion: "success", closed_reason: "review_pass", contract: file.contract_sha256 });
  const types = (await queryRecords("select type from run_events where run_id = $1 order by sequence", [runId])).map((row) => row.type);
  assert.equal(types.length, run.last_event_sequence, "one sequence, no gaps");
  for (const type of ["run_started", "contract_sealed", "task.input", "test_result", "review.result", "acceptance", "run_terminal", "run_delivered"]) assert.ok(types.includes(type), type);
  assert.deepEqual(await queryRecords("select ac_id, verdict, result from acceptance_rows where run_id = $1", [runId]), [{ ac_id: "AC1", verdict: "pass", result: "proven" }]);
  assert.deepEqual(await queryRecords("select ac_id, verdict from review_verdicts where run_id = $1", [runId]), [{ ac_id: "AC1", verdict: "pass" }]);
  assert.deepEqual(await queryRecords("select kind, passed from test_results where run_id = $1", [runId]), [{ kind: "not_configured", passed: null }]);
  // The plan keeps each settled value with its layer, and the run its own deadline; both by SQL.
  const [planned] = await queryRecords("select p.body->>'priority' as priority, p.body->>'priority_source' as priority_source, p.body->'writer'->>'effort_source' as effort_source,"
    + " p.body->'budget_source'->>'run_timeout' as run_timeout_source, (r.timeout_at - r.created_at) as timeout from runs r join plans p using (plan_sha256) where r.run_id = $1", [runId]);
  assert.deepEqual({ ...planned, timeout: planned.timeout.hours }, { priority: "medium", priority_source: "config", effort_source: "priority", run_timeout_source: "config", timeout: 6 });
  // A state event keeps its details with the run it left, in its record; its payload is null.
  const [delivered] = await queryRecords("select payload, record->'details' as details from run_events where run_id = $1 and type = 'run_delivered'", [runId]);
  assert.equal(delivered.details.sha256, file.result_sha256);
  assert.equal(delivered.payload, null);

  // A run stopped from another process is recorded as stopped there too.
  assert.equal(cli(["start", order, "--fake-cli"]).status, 1);
  const { spawn } = await import("node:child_process");
  const slow = spawn(process.execPath, [bridge, "start", order, "--fake-cli", "--yes"], { cwd: root, env: isolatedEnv({ FAKE_CLAUDE_SLEEP_MS: "30000" }), windowsHide: true, stdio: "ignore" });
  const ended = new Promise((resolve) => slow.once("close", resolve));
  let stoppedId = null;
  for (const until = Date.now() + 30_000; !stoppedId && Date.now() < until;) {
    for (const name of await fsp.readdir(path.join(queue, "run-locks")).catch(() => [])) {
      if (!name.endsWith(".process.json")) continue;
      const record = JSON.parse(await fsp.readFile(path.join(queue, "run-locks", name), "utf8").catch(() => "{}"));
      if (record.role === "writer") stoppedId = name.replace(".process.json", "");
    }
    if (!stoppedId) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(stoppedId, "the writer never started");
  assert.equal(cli(["stop", stoppedId]).status, 0);
  await ended;
  const [stopped] = await queryRecords("select status, conclusion, closed_reason from runs where run_id = $1", [stoppedId]);
  assert.deepEqual(stopped, { status: "completed", conclusion: "cancelled", closed_reason: "stopped" });

  // clean <run_id>: one delete takes the run's rows; its authorization and claim stay.
  const owned = async () => Object.fromEntries(await Promise.all(["runs", "run_events", "test_results", "review_results", "review_verdicts", "acceptance_decisions", "acceptance_rows"]
    .map(async (table) => [table, (await queryRecords("select count(*)::int as n from " + table + " where run_id = $1", [runId]))[0].n])));
  assert.ok(Object.values(await owned()).every((n) => n > 0));
  assert.equal(cli(["clean", runId]).status, 0);
  assert.ok(Object.values(await owned()).every((n) => n === 0), JSON.stringify(await owned()));
  assert.equal((await queryRecords("select count(*)::int as n from authorization_claims where run_id = $1", [runId]))[0].n, 1, "the card stays used");
});

// RC3-BLOCKER-01 step 4: the database is the one record. A run that loses it mid-way stops with
// database_unavailable and calls no model after that; once the database is back, status shows the
// run as it ended. A read that cannot open the database says why and where to look, and exits non-0.
test("a run whose database goes away stops as database_unavailable; reads without a database say why", async (t) => {
  const { root, order, cli, queue } = await fourActionsProject(t, "review-bridge-database-gone-");
  assert.equal(cli(["start", order, "--fake-cli"]).status, 1);
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [bridge, "start", order, "--fake-cli", "--yes"], { cwd: root, env: isolatedEnv({ FAKE_CLAUDE_SLEEP_MS: "6000" }), windowsHide: true, stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("close", resolve));
  let runId = null;
  for (const until = Date.now() + 30_000; !runId && Date.now() < until;) {
    for (const name of await fsp.readdir(path.join(queue, "run-locks")).catch(() => [])) {
      if (!name.endsWith(".process.json")) continue;
      const record = JSON.parse(await fsp.readFile(path.join(queue, "run-locks", name), "utf8").catch(() => "{}"));
      if (record.role === "writer") runId = name.replace(".process.json", "");
    }
    if (!runId) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(runId, "the writer never started");
  stopServerIn(dataHome);
  assert.equal(await exited, 69, "the run stops: its database is gone");
  const events = (await fsp.readFile(path.join(queue, "events", runId + ".io.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const lost = events.findIndex((event) => event.event === "stop" && event.status === "database_unavailable");
  assert.ok(lost > 0, "the stop is recorded");
  // The writer's and the reviewer's calls are the only model calls (the contract is a form check).
  assert.equal(events.slice(lost).some((event) => ["task.input", "review.input"].includes(event.event)), false, "no model call after it");
  const file = JSON.parse(await fsp.readFile(path.join(queue, "runs", runId + ".json"), "utf8"));
  assert.deepEqual([file.status, file.conclusion, file.closed_reason], ["completed", "cancelled", "database_unavailable"]);
  // status only looks (RC3-DOWN-01): the database is stopped, it says so in the project's language and
  // starts nothing; the runs are shown once the database is up again.
  const words = await createTranslator(await resolveLocale(projectPaths(root)));
  const looked = cli(["status"]);
  assert.equal(looked.status, 0, looked.stderr);
  assert.ok(looked.stdout.split(/\r?\n/).includes(words("status.database.stopped")), looked.stdout);
  assert.equal(looked.stdout.includes(runId), false, looked.stdout);
  assert.equal(await fsp.stat(path.join(dataHome, "postgres", "data", "postmaster.pid")).catch(() => null), null, "status did not start it");
  // up starts it again; the next status writes what the run kept meanwhile and lists the run as it ended.
  const up = cli(["up", "--fake-cli"]);
  assert.equal(up.status, 0, up.stdout + up.stderr);
  assert.equal(up.stdout.split(/\r?\n/)[0], words("up.database", { port: Number((await fsp.readFile(path.join(dataHome, "postgres", "data", "postmaster.pid"), "utf8")).split(/\r?\n/)[3]) }));
  const status = cli(["status"]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, new RegExp("\\n  " + runId + "  completed +  cancelled +  database_unavailable +\\.review-bridge/work-packages/hello\\.md  "));
  const [row] = await queryRecords("select status, conclusion, closed_reason from runs where run_id = $1", [runId]);
  assert.deepEqual(row, { status: "completed", conclusion: "cancelled", closed_reason: "database_unavailable" });
  // Its delivery was written after the fact too.
  assert.equal((await queryRecords("select count(*)::int as n from run_events where run_id = $1 and type = 'run_delivered'", [runId]))[0].n, 1);
  // What was written after the fact says so; what was written as it happened does not.
  const timeline = await queryRecords("select type, recorded_late from run_events where run_id = $1 order by sequence", [runId]);
  assert.equal(timeline.find((event) => event.type === "run_started").recorded_late, false);
  assert.equal(timeline.find((event) => event.type === "run_terminal").recorded_late, true);
  assert.deepEqual(timeline.slice(timeline.findIndex((event) => event.recorded_late)).filter((event) => !event.recorded_late), [], "the late ones are the tail");

  // A database that cannot be opened: each read says why and where, and exits non-0.
  const broken = path.join(root, "..", path.basename(root) + "-broken-home");
  await fsp.mkdir(path.join(broken, "postgres"), { recursive: true });
  await fsp.writeFile(path.join(broken, "postgres", "notes.txt"), "not a cluster\n");
  await reachSameState(broken);
  t.after(() => leaveBrokenHome(broken));
  // status only looks, as pg_ctl status does (Fortes 2026-11-09): the data directory it would use does not
  // exist, so it says so with where, exits 4, starts and creates nothing, and never says up would start it.
  const data = path.join(broken, "postgres", "data");
  const unusable = cli(["status"], { REVIEW_BRIDGE_DATA_HOME: broken });
  assert.equal(unusable.status, 4, unusable.stdout + unusable.stderr);
  assert.ok(unusable.stdout.split(/\r?\n/).includes(words("status.database.missing", { path: data })), unusable.stdout);
  assert.equal(unusable.stdout.includes(words("status.database.stopped")), false);
  assert.equal(await fsp.stat(data).then(() => true, () => false), false, "status created no data directory");
  // The reads that open the database say why it cannot be opened, and exit 2.
  for (const command of ["work-status", "doctor"]) {
    const read = cli([command], { REVIEW_BRIDGE_DATA_HOME: broken });
    assert.equal(read.status, 2, command + ": " + read.stdout);
    assert.match(read.stderr, /^Review bridge failed closed: Bridge's database at .*postgres is not available: The folder .* holds files but no PostgreSQL cluster; Bridge will not touch it\. Run the command again; if it fails the same way, look at that folder \(the server's log is in .*log\)\n$/, command);
  }
});

// A Bridge command's view of a project, in this process: its records go to the same database the
// commands use. The recorder is taken out again when the test ends.
async function inProcess(t, root) {
  const { getBridgePaths } = await import("../review-bridge/utils/paths.mjs");
  const service = await import("../review-bridge/service/index.mjs");
  const { openDatabase } = await import("../review-bridge/service/database/index.mjs");
  const { deliverOutcome } = await import("../review-bridge/features/workOrder/delivery.mjs");
  const database = () => openDatabase();
  service.installRunRecorder(service.createRunRecorder(database), database);
  t.after(() => service.installRunRecorder(null));
  const paths = getBridgePaths(root, path.join(packageRoot, "review-bridge"), { privateRootName: ".review-bridge" });
  return {
    readRun: (runId) => service.readRun(paths, runId),
    readIoEvents: (runId) => service.readIoEvents(paths, runId),
    deliver: (runId) => deliverOutcome({ paths, runId, notify: false }),
    replay: async () => {
      const db = await database();
      return await service.replayUnrecorded(db, paths, { rebuild: (runId) => service.rebuildRunFiles(paths, runId, db) });
    },
    RunFilesAheadError: service.RunFilesAheadError,
  };
}

// The writer of a run started in the background, once it is running.
async function runningWriter(queue) {
  for (const until = Date.now() + 30_000; Date.now() < until;) {
    for (const name of await fsp.readdir(path.join(queue, "run-locks")).catch(() => [])) {
      if (!name.endsWith(".process.json")) continue;
      const record = JSON.parse(await fsp.readFile(path.join(queue, "run-locks", name), "utf8").catch(() => "{}"));
      if (record.role === "writer") return name.replace(".process.json", "");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("the writer never started");
}

// The lines of an event file, each as its value.
const eventValues = (text) => (text === null ? null : text.split("\n").filter(Boolean).map((line) => JSON.parse(line)));

// DECISIONS 2026-11-03 (B): the database is a run's record; its run.json and event file are the copy.
// Missing or behind, they are written again from the database with the same values (the database
// keeps each line as jsonb, so not the same bytes); ahead of it, refused.
test("a run's files are written again from the database when they are missing or behind, and refused when they are ahead", async (t) => {
  const { root, order, cli, queue } = await fourActionsProject(t, "review-bridge-files-copy-");
  assert.equal(cli(["start", order, "--fake-cli"]).status, 1);
  assert.equal(yesTo(cli, order).status, 0);
  const [name] = (await fsp.readdir(path.join(queue, "runs"))).filter((entry) => entry.endsWith(".json"));
  const runId = name.slice(0, -5);
  const runFile = path.join(queue, "runs", name);
  const eventFile = path.join(queue, "events", runId + ".jsonl");
  const texts = async () => ({ run: await fsp.readFile(runFile, "utf8").catch(() => null), events: await fsp.readFile(eventFile, "utf8").catch(() => null) });
  const valuesOf = ({ run, events }) => ({ run: run === null ? null : JSON.parse(run), events: eventValues(events) });
  const originalText = await texts();
  const original = valuesOf(originalText);
  const files = async () => valuesOf(await texts());
  const remove = () => Promise.all([fsp.rm(runFile), fsp.rm(eventFile)]);
  const bridgeHere = await inProcess(t, root);

  // Missing: status and work-status read the database; stop finds the run, and its files come back.
  await remove();
  const status = cli(["status"]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, new RegExp("\\n  " + runId + "  completed +  success +  review_pass +  \\.review-bridge/work-packages/hello\\.md  "));
  const workStatus = cli(["work-status"]);
  assert.equal(workStatus.status, 0, workStatus.stderr);
  assert.equal(JSON.parse(workStatus.stdout).latest_run.run_id, runId);
  const stop = cli(["stop", runId]);
  assert.equal(stop.status, 1, stop.stderr);
  assert.equal(stop.stdout, "已經結束：review_pass\n");
  assert.deepEqual(await files(), original);
  // A delivery finds the run delivered, and writes its files again the same way.
  await remove();
  const delivered = await bridgeHere.deliver(runId);
  assert.equal(delivered.already, true);
  assert.equal(delivered.closed_reason, "review_pass");
  assert.deepEqual(await files(), original);

  // One event behind: the read gets the database's run (delivered), and only the missing line is appended.
  const lines = originalText.events.split("\n").filter(Boolean);
  await fsp.writeFile(eventFile, lines.slice(0, -1).map((line) => line + "\n").join(""));
  await fsp.writeFile(runFile, JSON.stringify(JSON.parse(lines.at(-2)).projection, null, 2) + "\n");
  assert.equal(JSON.parse(await fsp.readFile(runFile, "utf8")).result_sha256, undefined, "the file is one event short of the delivery");
  assert.deepEqual(await bridgeHere.readRun(runId), original.run);
  assert.deepEqual(await files(), original);
  assert.equal((await fsp.readFile(eventFile, "utf8")).startsWith(lines.slice(0, -1).join("\n") + "\n"), true, "the lines it had are left as they were");

  // Numbered by the database: one sequence for the run's state and I/O events, so the state event
  // file has gaps, and its last line is not always the run's last event.
  const [{ last_event_sequence: last }] = await queryRecords("select last_event_sequence from runs where run_id = $1", [runId]);
  const sequences = original.events.map((event) => event.sequence);
  assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
  assert.ok(sequences.at(-1) <= last && sequences.length < last, "state events " + sequences + ", run at " + last);

  // Kept while the database was gone under a number the database has already given to another event
  // (the files were behind it then): not written, the run's files are written again from the
  // database, and the kept event stays beside them, said on stderr.
  const ioFile = path.join(queue, "events", runId + ".io.jsonl");
  const originalIo = eventValues(await fsp.readFile(ioFile, "utf8"));
  const kept = { ...original.events.at(-1), type: "state_recorded", substantive: false, details: {} };
  delete kept.sequence;
  await fsp.mkdir(path.join(queue, "unrecorded"), { recursive: true });
  await fsp.writeFile(path.join(queue, "unrecorded", runId + ".jsonl"),
    JSON.stringify({ runId, type: kept.type, occurredAt: kept.occurred_at, line: kept, sequence: last }) + "\n");
  await fsp.appendFile(eventFile, JSON.stringify({ ...kept, sequence: last }) + "\n");
  await fsp.writeFile(ioFile, "");
  assert.equal(await bridgeHere.replay(), 1);
  assert.deepEqual(await files(), original);
  assert.deepEqual(eventValues(await fsp.readFile(ioFile, "utf8")), originalIo);
  const aside = await fsp.readdir(path.join(queue, "unrecorded"));
  assert.equal(aside.length, 1);
  assert.match(aside[0], new RegExp("^" + runId + "\\.jsonl\\.refused-\\d+$"));
  assert.deepEqual(await queryRecords("select last_event_sequence, (select count(*)::int from run_events where run_id = $1 and recorded_late) as late from runs where run_id = $1", [runId]),
    [{ last_event_sequence: last, late: 0 }]);

  // One event ahead: an event the database never took is refused, by its number, and not used.
  const extra = { ...original.events.at(-1), sequence: last + 1 };
  extra.projection = { ...extra.projection, last_event_sequence: extra.sequence, conclusion: "failure" };
  await fsp.appendFile(eventFile, JSON.stringify(extra) + "\n");
  const ahead = await fsp.readFile(eventFile, "utf8");
  const message = new RegExp("its files are at state event " + extra.sequence + " but Bridge's database is at " + last + "; event " + extra.sequence + " is only in the files");
  await assert.rejects(bridgeHere.readRun(runId), (error) => error instanceof bridgeHere.RunFilesAheadError && message.test(error.message));
  const refused = cli(["stop", runId]);
  assert.equal(refused.status, 2, refused.stdout);
  assert.match(refused.stderr, message);
  assert.equal(await fsp.readFile(eventFile, "utf8"), ahead, "the refused files are left as they are");
});

// The I/O event file is the database's copy too: an ended run that was never delivered on this
// machine is delivered in full from the database's lines, and its file comes back as it was.
test("an ended, undelivered run without its I/O event file is delivered in full from the database, and a file with a line more is refused", async (t) => {
  const { root, order, cli, queue } = await fourActionsProject(t, "review-bridge-io-copy-");
  assert.equal(cli(["start", order, "--fake-cli"]).status, 1);
  assert.equal(yesTo(cli, order).status, 0);
  const [name] = (await fsp.readdir(path.join(queue, "runs"))).filter((entry) => entry.endsWith(".json"));
  const runId = name.slice(0, -5);
  const runFile = path.join(queue, "runs", name);
  const eventFile = path.join(queue, "events", runId + ".jsonl");
  const ioFile = path.join(queue, "events", runId + ".io.jsonl");
  const originalIo = await fsp.readFile(ioFile, "utf8");
  const bridgeHere = await inProcess(t, root);
  // As if the run ended and its delivery never happened: neither the database nor the files have it.
  const undeliver = async () => {
    await queryRecords("delete from run_events where run_id = $1 and type = 'run_delivered'", [runId]);
    await queryRecords("update runs set delivered_at = null where run_id = $1", [runId]);
    const lines = (await fsp.readFile(eventFile, "utf8")).split("\n").filter(Boolean).filter((line) => JSON.parse(line).type !== "run_delivered");
    await fsp.writeFile(eventFile, lines.map((line) => line + "\n").join(""));
    await fsp.writeFile(runFile, JSON.stringify(JSON.parse(lines.at(-1)).projection, null, 2) + "\n");
    await fsp.rm(path.join(queue, runId + ".result.md"), { force: true });
  };
  // The time of the delivery is the one thing two deliveries of one run differ in.
  const untimed = (text) => text.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<time>");

  await undeliver();
  const withFile = await bridgeHere.deliver(runId);
  assert.equal(withFile.already, false);
  const expected = await fsp.readFile(withFile.result_path, "utf8");
  for (const part of [/reviewer passed|審查通過|PASS/i, /AC1/, /Tokens|token/i]) assert.match(expected, part);

  await undeliver();
  await fsp.rm(ioFile);
  const withoutFile = await bridgeHere.deliver(runId);
  assert.equal(withoutFile.already, false);
  assert.equal(untimed(await fsp.readFile(withoutFile.result_path, "utf8")), untimed(expected));
  assert.deepEqual(withoutFile.tokens, withFile.tokens);
  assert.deepEqual(eventValues(await fsp.readFile(ioFile, "utf8")), eventValues(originalIo), "the I/O event file came back with the same lines");

  // Behind: only the lines after its last one are asked for and appended; the ones it had stay as they were.
  const lines = originalIo.split("\n").filter(Boolean);
  await fsp.writeFile(ioFile, lines.slice(0, -2).map((line) => line + "\n").join(""));
  assert.deepEqual(await bridgeHere.readIoEvents(runId), eventValues(originalIo));
  const caughtUp = await fsp.readFile(ioFile, "utf8");
  assert.equal(caughtUp.startsWith(lines.slice(0, -2).join("\n") + "\n"), true);
  assert.deepEqual(eventValues(caughtUp), eventValues(originalIo));

  // One line more than the database: refused by its number, and the file is left as it is.
  const [{ last_event_sequence: last }] = await queryRecords("select last_event_sequence from runs where run_id = $1", [runId]);
  const extra = { ...JSON.parse(lines.at(-1)), sequence: last + 1 };
  await fsp.appendFile(ioFile, JSON.stringify(extra) + "\n");
  const ahead = await fsp.readFile(ioFile, "utf8");
  const message = new RegExp("its files are at I/O event " + (last + 1) + " but Bridge's database is at " + last + "; event " + (last + 1) + " is only in the files");
  await assert.rejects(bridgeHere.readIoEvents(runId), (error) => error instanceof bridgeHere.RunFilesAheadError && message.test(error.message));
  assert.equal(await fsp.readFile(ioFile, "utf8"), ahead);
});

// Without the database a run can only be closed and delivered (from its files; the events wait
// beside them and are written once the database is back); nothing starts or carries a run on.
test("without the database a running run is stopped and delivered from its files, start and resume are refused, and the stop is recorded once the database is back", async (t) => {
  const { root, order, cli, queue } = await fourActionsProject(t, "review-bridge-no-database-");
  const broken = path.join(root, "..", path.basename(root) + "-broken-home");
  await fsp.mkdir(path.join(broken, "postgres"), { recursive: true });
  await fsp.writeFile(path.join(broken, "postgres", "notes.txt"), "not a cluster\n");
  await reachSameState(broken);
  t.after(() => leaveBrokenHome(broken));
  const unavailable = /^Review bridge failed closed: Bridge's database at .*postgres is not available: /;
  assert.equal(cli(["start", order, "--fake-cli"]).status, 1);
  const { spawn } = await import("node:child_process");
  // The runtime's bootstrap itself, not bridge.mjs: that is a launcher that hands start to it
  // (bridge.mjs spawnSync), and killing the launcher leaves the start's loop running on Linux.
  const child = spawn(process.execPath, [path.join(packageRoot, "review-bridge", "bootstrap.mjs"), "start", order, "--fake-cli", "--yes"],
    { cwd: root, env: isolatedEnv({ FAKE_CLAUDE_SLEEP_MS: "30000" }), windowsHide: true, stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("close", resolve));
  t.after(() => { try { process.kill(child.pid, "SIGKILL"); } catch {} });
  const runId = await runningWriter(queue);
  // The start's own process goes down first, as in a crash: only the stop command can close and
  // deliver the run now, on every platform, from its files.
  child.kill("SIGKILL");
  await exited;
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" }, "the start's process is gone");

  const stop = cli(["stop", runId], { REVIEW_BRIDGE_DATA_HOME: broken });
  assert.equal(stop.status, 0, stop.stdout + stop.stderr);
  assert.match(stop.stdout, new RegExp("^已停止 " + runId + "\\n.*\\n.*\\n.*\\n$"));
  const file = JSON.parse(await fsp.readFile(path.join(queue, "runs", runId + ".json"), "utf8"));
  assert.deepEqual([file.status, file.conclusion, file.closed_reason, Boolean(file.result_sha256)], ["completed", "cancelled", "stopped", true]);
  const start = cli(["start", order, "--fake-cli", "--yes"], { REVIEW_BRIDGE_DATA_HOME: broken });
  assert.equal(start.status, 2, start.stdout);
  assert.match(start.stderr, unavailable);
  const resume = cli(["resume", runId, "--fake-cli", "--yes"], { REVIEW_BRIDGE_DATA_HOME: broken });
  assert.equal(resume.status, 2, resume.stdout);
  assert.match(resume.stderr, unavailable);
  assert.deepEqual((await fsp.readdir(path.join(queue, "runs"))).filter((entry) => entry.endsWith(".json")), [runId + ".json"], "nothing started");

  // The database back: the stop and the delivery the stop command kept are written to it, after the fact.
  const status = cli(["status"]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, new RegExp("\\n  " + runId + "  completed +  cancelled +  stopped +  "));
  const [row] = await queryRecords("select status, conclusion, closed_reason, delivered_at is not null as delivered from runs where run_id = $1", [runId]);
  assert.deepEqual(row, { status: "completed", conclusion: "cancelled", closed_reason: "stopped", delivered: true });
  const late = (await queryRecords("select type from run_events where run_id = $1 and recorded_late order by sequence", [runId])).map((event) => event.type);
  assert.deepEqual(late, ["run_terminal", "stop", "run_delivered"]);
  // From then on the database and the files are the same run.
  const eventFile = path.join(queue, "events", runId + ".jsonl");
  const before = await fsp.readFile(eventFile, "utf8");
  await fsp.rm(eventFile);
  assert.deepEqual(await (await inProcess(t, root)).readRun(runId), file);
  assert.equal(await fsp.readFile(eventFile, "utf8"), before);
});

// E10: a card never shown because the reviewer check did not pass is withdrawn in the records, so no
// later --yes can start it (a card answered no at a terminal is withdrawn the same way; the pty run
// shows it). The card's "Valid until" is the plan's, as recorded.
test("a card past its Valid until is refused, and a card's yes is taken once", async (t) => {
  const { root, order, cli, listed } = await fourActionsProject(t, "review-bridge-card-once-");
  assert.match(cli(["start", order, "--fake-cli", "--yes"]).stdout, /^No card was shown /);

  assert.equal(cli(["start", order, "--fake-cli"]).status, 1);
  await queryRecords("update plans set authorization_expires_at = now() - interval '1 second' where shown_at is not null and withdrawn_at is null");
  const old = cli(["start", order, "--fake-cli", "--yes"]);
  assert.equal(old.status, 1, old.stderr);
  assert.match(old.stdout, /^The card was valid until .*\. Run: npx review-bridge start .* and show the person the new card\.\n$/);
  assert.deepEqual(await listed("runs"), []);
  assert.deepEqual(await listed("authorizations"), []);

  // One card, one yes: said once, it is not there to say again.
  assert.equal(cli(["start", order, "--fake-cli"]).status, 1);
  assert.equal(cli(["start", order, "--fake-cli", "--yes"]).status, 0);
  const spent = cli(["start", order, "--fake-cli", "--yes"]);
  assert.equal(spent.status, 1, spent.stderr);
  assert.match(spent.stdout, /This card was already said yes to/);
  assert.equal((await listed("runs")).length, 1);
});

test("stop pauses a run and keeps its records, resume carries the work order on, clean clears records and refuses a running run", async (t) => {
  const { root, order, cli, queue } = await fourActionsProject(t, "review-bridge-four-actions-");
  assert.equal(cli(["start", order, "--fake-cli"]).status, 1, "the card the yes below is for");
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [bridge, "start", order, "--fake-cli", "--yes"], {
    cwd: root, env: isolatedEnv({ FAKE_CLAUDE_SLEEP_MS: "30000" }), windowsHide: true, stdio: "ignore",
  });
  const exited = new Promise((resolve) => child.once("close", resolve));
  let runId = null;
  for (const until = Date.now() + 30_000; !runId && Date.now() < until;) {
    for (const name of await fsp.readdir(path.join(queue, "run-locks")).catch(() => [])) {
      if (!name.endsWith(".process.json")) continue;
      const record = JSON.parse(await fsp.readFile(path.join(queue, "run-locks", name), "utf8").catch(() => "{}"));
      if (record.role === "writer") runId = name.replace(".process.json", "");
    }
    if (!runId) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(runId, "the writer never started");

  const busy = cli(["clean", runId]);
  assert.equal(busy.status, 1);
  assert.match(busy.stdout, /進行中，先 stop/);
  const stopped = cli(["stop", runId]);
  assert.equal(stopped.status, 0, stopped.stderr);
  await exited;
  const record = JSON.parse(await fsp.readFile(path.join(queue, "runs", runId + ".json"), "utf8"));
  assert.equal(record.conclusion, "cancelled", "paused, and its record is kept");

  const status = cli(["status"]);
  assert.equal(status.status, 0, status.stderr);
  // From the database: the page, the database's line in the project's language, the runs listed and not
  // totalled (gh run list), each with its status, why it stopped, its work order file and when it began.
  const words = await createTranslator(await resolveLocale(projectPaths(root)));
  const databaseRunning = words("status.database.running").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(status.stdout, new RegExp("^Page: .*\\n" + databaseRunning + "\\nWork: 0 running\\n  " + runId + "  completed +  cancelled +  stopped +  \\.review-bridge/work-packages/hello\\.md  \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d [+-]\\d{4}\\n", "m"));
  // No counts from the page service's queue folders (they went back to 0 when it restarted).
  assert.doesNotMatch(status.stdout, /Review queue/);
  assert.ok(status.stdout.endsWith("\n" + (await databaseLines("")).slice(1).join("\n") + "\n"), status.stdout);
  assert.equal(status.stdout.includes(await databasePassword()), false, "the password itself is not printed");

  const card = cli(["resume", runId, "--fake-cli"]);
  assert.equal(card.status, 1);
  assert.match(card.stdout, new RegExp("^Carrying on run " + runId + " \\(" + order.replaceAll(".", "\\.") + "\\) as a new run\\n"));
  assert.match(card.stdout, new RegExp("\\nNeeds authorization\\. If the person says yes, run again: npx review-bridge resume " + runId + " --fake-cli --yes\\n$"));
  const resumed = cli(["resume", runId, "--fake-cli", "--yes"]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /\nDelivered: .*\nResult file: /);
  const runs = await fsp.readdir(path.join(queue, "runs"));
  assert.equal(runs.length, 2);
  const carried = JSON.parse(await fsp.readFile(path.join(queue, "runs", runs.find((name) => name !== runId + ".json")), "utf8"));
  assert.equal(carried.conclusion, "success");
  assert.equal(carried.authorized_via, "agent");

  const cleaned = cli(["clean", runId]);
  assert.equal(cleaned.status, 0, cleaned.stdout + cleaned.stderr);
  assert.equal(await fsp.stat(path.join(queue, "runs", runId + ".json")).catch(() => null), null);
  const all = cli(["clean", "--json"]);
  assert.equal(all.status, 0, all.stderr);
  assert.equal(typeof JSON.parse(all.stdout), "object");
});

test("without the reviewer proof a real start is refused before any model call, with --yes or without", async (t) => {
  const { order, cli, listed } = await fourActionsProject(t, "review-bridge-no-proof-", { ownInit: true });
  // A card to say yes to (shown with the fake CLI, so the native --yes below has one).
  assert.equal(cli(["start", order, "--fake-cli"]).status, 1);
  const fakePage = /\nReviewer read-only check: not passed \(the Bridge page is running with the fake CLI\)\nRun: npx review-bridge down, then npx review-bridge start /;
  // The page init started runs the fake CLI, so it can never hold a proof.
  const refused = cli(["start", order, "--yes"]);
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stdout, fakePage);
  // No page at all: start starts one; with the CLIs absent the check cannot run, so nothing starts.
  // down stops the page and the database; no run is running anywhere, so it is not refused.
  const down = cli(["down"]);
  assert.equal(down.status, 0, down.stdout + down.stderr);
  const noPage = cli(["start", order, "--yes"]);
  assert.equal(noPage.status, 1, noPage.stderr);
  assert.match(noPage.stdout, /\nReviewer read-only check: not passed \((the reviewer CLI is not installed and signed in|this platform's adapter is not verified, so the check is not available here)\)\n/);
  assert.doesNotMatch(noPage.stdout, /Checking that the reviewer/);
  // work-start goes through the same gate: no running page, no start.
  assert.equal(cli(["down"]).status, 0);
  const workStart = cli(["work-start", "--plan", ".review-bridge/review-queue/hello.plan.json", "--yes"]);
  assert.equal(workStart.status, 2);
  assert.match(workStart.stderr, /Native execution is unavailable: the Bridge page service is not running/);
  // A new card with no Codex here: the person hears what to install and sign in to, and nothing else.
  const noCli = cli(["start", order]);
  assert.equal(noCli.status, 1, noCli.stderr);
  assert.match(noCli.stdout, /^Reviewer read-only check: not passed \(the reviewer CLI is not installed and signed in\)\n(?:Install the codex CLI and sign it in|Sign the reviewer in) \(codex login\), then run: npx review-bridge start /m);
  assert.doesNotMatch(noCli.stdout + noCli.stderr, /MCP/);
  // And without --yes: the card, and no model call, the check's among them, before a yes.
  cli(["up", "--fake-cli"]);
  const asked = cli(["start", order, "--writer", "claude", "--reviewer", "claude"]);
  assert.equal(asked.status, 1, asked.stderr);
  assert.match(asked.stdout, /Needs authorization/);
  assert.doesNotMatch(asked.stdout, /Reviewer read-only check|Checking that the reviewer/);
  assert.deepEqual(await listed("runs"), []);
  assert.deepEqual(await listed("authorizations"), []);
});

// RC3-LINUX-00: a page started with the fake CLI (as init starts it) can never hold the reviewer
// proof that a native work-start asks the running page for. The fake work itself still runs.
function post(url, { headers, body }) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: target.port, method: "POST", path: target.pathname, headers: { Host: target.host, ...headers } }, (response) => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: data }));
    });
    request.once("error", reject);
    request.end(body);
  });
}

function get(url) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: target.port, path: target.pathname, headers: { Host: target.host } }, (response) => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => resolve(data));
    }).once("error", reject);
  });
}

test("a page started with the fake CLI cannot give a native work-start the reviewer proof, and fake work still runs", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-fake-page-"));
  t.after(() => removeWorkspace(root));
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fake-page-app", private: true }) + "\n");
  const result = spawnSync(process.execPath, await scriptedInit(
    bridge, "init", "--target", root, "--writer", "claude", "--reviewer", "codex", "--yes",
  ), { cwd: packageRoot, encoding: "utf8", env: isolatedEnv(), windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  // The fake work runs as before.
  assert.deepEqual(JSON.parse(result.stdout).fake_self_tests.map((entry) => entry.status), ["pass", "pass", "hard_stop", "rate_limited"]);
  const runtime = path.join(packageRoot, "review-bridge");
  const load = (relative) => import(pathToFileURL(path.join(runtime, ...relative.split("/"))).href);
  const { getBridgePaths } = await load("utils/paths.mjs");
  const { checkService } = await load("features/setupCheck/index.mjs");
  const { checkReviewerProof } = await load("router/guards/nativeGate.mjs");
  const paths = getBridgePaths(root, runtime, { privateRootName: ".review-bridge" });
  const service = await checkService(paths);
  assert.equal(service.running, true, service.reason);
  assert.deepEqual([service.status.platform_eligible, service.status.platform_status, service.status.probe_available], [false, "fake", false]);
  // Pressing the check on that page, with a request the page accepts, starts nothing.
  const token = /name="review-bridge-session" content="([0-9a-f]+)"/.exec(await get(service.url))[1];
  const origin = service.url.replace(/\/$/, "");
  const pressed = await post(origin + "/api/reviewer-probe", {
    headers: { Origin: origin, "Content-Type": "application/json", "x-review-bridge-token": token },
    body: JSON.stringify({ confirm: "one_model_call", request_id: "0123456789abcdef-0301" }),
  });
  assert.equal(pressed.status, 409, pressed.body);
  assert.equal(JSON.parse(pressed.body).error, "adapter_not_verified");
  // So the proof a native work-start asks the running page for is not there.
  const proof = await checkReviewerProof(paths);
  assert.equal(proof.ok, false);
  assert.equal(proof.reason, "reviewer_not_proven");
});

// RC3-LINUX-00: a copy of the package whose manifest marks this platform unverified, or does not
// define it at all.
async function packageForPlatform(t, change) {
  const copy = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-platform-package-"));
  t.after(async () => {
    await fsp.unlink(path.join(copy, "node_modules")).catch(() => {});
    await fsp.rm(copy, { recursive: true, force: true });
  });
  await fsp.cp(packageRoot, copy, { recursive: true, filter: (source) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(source) });
  // The copy uses this package's installed dependencies, as npm would have installed them.
  await fsp.symlink(path.join(packageRoot, "node_modules"), path.join(copy, "node_modules"), "junction");
  const manifestFile = path.join(copy, "review-bridge", "manifest.json");
  const manifest = JSON.parse(await fsp.readFile(manifestFile, "utf8"));
  change(manifest.adapters, process.platform + "-" + process.arch);
  const text = JSON.stringify(manifest, null, 2) + "\n";
  await fsp.writeFile(manifestFile, text);
  return copy;
}

for (const [label, change, adapterStatus] of [
  ["marks this platform experimental", (adapters, key) => { adapters[key].status = "experimental"; }, "experimental"],
  ["has no definition for this platform", (adapters, key) => { delete adapters[key]; }, "unsupported"],
]) {
  test("init and roles-check where the manifest " + label + ": every readiness key is there, and nothing is ready", async (t) => {
    const copy = await packageForPlatform(t, change);
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-platform-init-"));
    t.after(() => removeWorkspace(root));
    await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "platform-app", private: true }) + "\n");
    const result = spawnSync(process.execPath, await scriptedInit(
      path.join(copy, "bridge.mjs"), "init", "--target", root, "--writer", "claude", "--reviewer", "codex", "--yes",
    ), { cwd: copy, encoding: "utf8", env: isolatedEnv(), windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    const realMode = JSON.parse(result.stdout).real_mode;
    for (const key of ["ready", "cli_available", "authorization_ready", "reason", "platform", "adapter_status", "runtime_verified", "missing"]) {
      assert.ok(Object.hasOwn(realMode, key), "real_mode." + key);
    }
    assert.deepEqual([realMode.ready, realMode.cli_available, realMode.authorization_ready], [false, false, false]);
    assert.equal(realMode.adapter_status, adapterStatus);
    assert.equal(realMode.missing[0], "verified platform adapter");
    // roles-check: with an adapter the CLI is really looked for; without one it is reported missing.
    const fakeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-platform-cli-"));
    t.after(() => fsp.rm(fakeDir, { recursive: true, force: true }));
    const notExecutable = path.join(fakeDir, "not-a-cli.txt");
    await fsp.writeFile(notExecutable, "not executable\n");
    const check = spawnSync(process.execPath, [path.join(copy, "bridge.mjs"), "roles-check", "--writer", "claude", "--reviewer", "codex", "--json"], {
      cwd: copy, encoding: "utf8", windowsHide: true, env: isolatedEnv({ CLAUDE_REVIEW_CLI: notExecutable, CODEX_REVIEW_CLI: notExecutable }),
    });
    assert.equal(check.status, 0, check.stderr);
    const roles = JSON.parse(check.stdout);
    for (const role of ["writer", "reviewer"]) {
      if (adapterStatus === "unsupported") {
        assert.equal(roles.checks[role].cli_present, false);
        assert.equal(roles.checks[role].next_action, "install_cli");
      } else {
        assert.equal(roles.checks[role].cli_present, true);
        assert.equal(roles.checks[role].authenticated, "unknown");
      }
    }
    assert.equal(roles.native_ready, false);
  });
}

// The local date and time a result file is named by: 2026-11-03 23-48-12.
function localName(at) {
  const date = new Date(at);
  const two = (number) => String(number).padStart(2, "0");
  return date.getFullYear() + "-" + two(date.getMonth() + 1) + "-" + two(date.getDate()) + " "
    + two(date.getHours()) + "-" + two(date.getMinutes()) + "-" + two(date.getSeconds());
}

// RC3-FIX-01 (DECISIONS 2026-11-03): a run's result is a file of its own in .review-bridge/results/,
// named after the work order and the time the run closed, never in work-packages/; clean leaves the
// results alone, and folds away the events the database refused to take late.
test("each run's result is its own file in .review-bridge/results/, never in work-packages/; clean keeps them and takes refused events", async (t) => {
  const { root, order, cli, queue } = await fourActionsProject(t, "review-bridge-results-");
  const { resultCopies } = await import("../review-bridge/tests/fixtures/resultCopies.mjs");
  // Once its contract is sealed, the card is the sealed one: one yes.
  const runOnce = () => {
    const card = cli(["start", order, "--fake-cli"]);
    assert.equal(card.status, 1);
    const started = yesTo(cli, order);
    assert.equal(started.status, 0, started.stderr);
    return started;
  };
  const first = runOnce();
  const second = runOnce();
  const { project_id: projectId } = JSON.parse(await fsp.readFile(path.join(root, ".review-bridge", "bridge.json"), "utf8"));
  const runs = await queryRecords("select run_id, closed_at, conclusion from runs where project_id = $1 order by closed_at", [projectId]);
  assert.equal(runs.length, 2);
  const expected = runs.map((run) => path.join(root, ".review-bridge", "results", "hello", "hello " + localName(run.closed_at) + " " + run.conclusion + ".md"));
  assert.deepEqual(await resultCopies(root, "hello"), expected);
  assert.deepEqual((await fsp.readdir(path.join(root, ".review-bridge", "work-packages"))).filter((name) => name.endsWith(".result.md")), []);
  for (const [started, copy] of [[first, expected[0]], [second, expected[1]]]) assert.ok(started.stdout.includes(copy), "the run says where its result is: " + copy);

  const refused = path.join(queue, "unrecorded", runs[0].run_id + ".jsonl.refused-1762156800000");
  await fsp.mkdir(path.dirname(refused), { recursive: true });
  await fsp.writeFile(refused, "{}\n");
  const clean = cli(["clean"]);
  assert.equal(clean.status, 0, clean.stderr);
  assert.deepEqual(await resultCopies(root, "hello"), expected, "clean leaves the results");
  assert.deepEqual((await fsp.readdir(path.join(queue, "unrecorded"))).filter((name) => name.includes(".refused-")), []);
  const archive = projectPaths(root).archiveDir;
  const dayLines = (await Promise.all((await fsp.readdir(archive)).map((name) => fsp.readFile(path.join(archive, name), "utf8")))).join("");
  assert.match(dayLines, new RegExp("\"run_id\":\"" + runs[0].run_id + "\"[^\n]*\"type\":\"refused_unrecorded\""));
});

// RC3-FIX-01 round 2: an auditor holding the ticket number finds the result by its file name, and the
// head of the result names the sealed version, the contract, the run and the commit as the database
// holds them; the person's copy and <run_id>.result.md in the run's log folder are the same text.
test("a result is named by its source_id and opens with who it is about, as the database has it", async (t) => {
  const { root, order, cli, queue } = await fourActionsProject(t, "review-bridge-result-identity-");
  await fsp.writeFile(path.join(root, order), "---\nsource_id: CANARY-1\n---\n" + await fsp.readFile(path.join(root, order), "utf8"));
  assert.equal(cli(["start", order, "--fake-cli"]).status, 1);
  const started = yesTo(cli, order);
  assert.equal(started.status, 0, started.stderr);
  const { project_id: projectId } = JSON.parse(await fsp.readFile(path.join(root, ".review-bridge", "bridge.json"), "utf8"));
  const [row] = await queryRecords("select r.run_id, r.closed_at, r.conclusion, r.contract_sha256, v.version_no, v.title, p.source_file,"
    + " (select d.review_version->>'head' from acceptance_decisions d where d.run_id = r.run_id order by d.sequence desc limit 1) as commit"
    + " from runs r join work_order_versions v using (work_order_id, content_sha256) join plans p using (plan_sha256) where r.project_id = $1", [projectId]);
  const copy = path.join(root, ".review-bridge", "results", "hello", "CANARY-1 hello " + localName(row.closed_at) + " " + row.conclusion + ".md");
  assert.ok(started.stdout.includes("Result file: " + copy), started.stdout);
  const result = await fsp.readFile(copy, "utf8");
  assert.equal(result, await fsp.readFile(path.join(projectPaths(root).runLogDir(row.run_id), row.run_id + ".result.md"), "utf8"), "both copies are the same text");
  const [, front, rest] = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(result);
  const { parse } = createRequire(import.meta.url)("yaml");
  assert.deepEqual(parse(front), {
    source_id: "CANARY-1", title: row.title, source_file: row.source_file, version_no: row.version_no,
    contract_sha256: row.contract_sha256, run_id: row.run_id, commit: row.commit,
    writer: { provider: "claude", model: null, effort: "medium" },
    reviewer: { provider: "codex", model: null, effort: "medium", mcp: [] },
  });
  assert.deepEqual(front.split("\n").filter((line) => !line.startsWith(" ")).map((line) => line.split(":")[0]), ["source_id", "title", "source_file", "version_no", "contract_sha256", "run_id", "commit", "writer", "reviewer"]);
  assert.match(front, /\nversion_no: 1 {2}# the sealed version this result is about, not the \.md on disk now\n/);
  assert.match(row.contract_sha256, /^[0-9a-f]{64}$/);
  assert.match(rest, /^# Delivered\n/);
});

// RC3-FIX-01: the budget check reads the run's running total by primary key; it never fetches the
// run's usage events, and the total is what they add up to.
// A data home whose database is broken but whose project state and logs are the test data home's
// (junctions on Windows, links elsewhere), so a command there misses only the database.
async function reachSameState(broken) {
  for (const folder of ["projects", "logs"]) {
    await fsp.mkdir(path.join(dataHome, folder), { recursive: true });
    await fsp.symlink(path.join(dataHome, folder), path.join(broken, folder), "junction");
  }
}
async function leaveBrokenHome(broken) {
  // The links go first, so removing the folder never reaches what they point to.
  for (const folder of ["projects", "logs"]) await fsp.unlink(path.join(broken, folder)).catch(() => fsp.rmdir(path.join(broken, folder)).catch(() => {}));
  for (const folder of ["projects", "logs"]) if (await fsp.lstat(path.join(broken, folder)).catch(() => null)) return;
  await fsp.rm(broken, { recursive: true, force: true });
}

// The files under a folder, relative and with "/", walked with a stack; .git is Git's own.
async function filesUnder(root) {
  const files = [];
  const stack = [""];
  while (stack.length) {
    const relative = stack.pop();
    for (const entry of await fsp.readdir(path.join(root, relative), { withFileTypes: true })) {
      const next = relative ? relative + "/" + entry.name : entry.name;
      if (entry.isDirectory()) { if (next !== ".git") stack.push(next); } else files.push(next);
    }
  }
  return files.sort();
}

// RC3-FIX-02 (Owner 2026-11-04): Bridge is a backend service, and a backend service keeps its state
// and logs off the customer's folder. After a run the project holds its settings, its work orders and
// the work order's results folder; the run's logs are in the log folder under <project_id>/<run_id>/,
// which logs and status name; clean <run_id> takes it; the database stays the record.
test("after a run the project holds only its settings, work orders and results/<work order>/; the logs are outside it and logs, status and clean find them", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-run-folder-"));
  t.after(() => removeWorkspace(root));
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "run-folder", dependencies: { express: "4.0.0" }, scripts: { test: "node -e \"process.exit(0)\"" } }) + "\n");
  await fsp.writeFile(path.join(root, ".gitignore"), "node_modules/\n");
  const init = spawnSync(process.execPath, await scriptedInit(bridge, "init", "--target", root, "--yes"), {
    cwd: packageRoot, encoding: "utf8", env: isolatedEnv(), windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(init.status, 0, init.stderr);
  // init leaves the person's tracked files alone; .review-bridge/, results included, is excluded locally.
  assert.equal(await fsp.readFile(path.join(root, ".gitignore"), "utf8"), "node_modules/\n");
  const order = ".review-bridge/work-packages/hello.md";
  await fsp.writeFile(path.join(root, order), "---\nsource_id: SHOP-412\n---\n# 工單：新增 README\n\n<!-- bridge:requested_work -->\n在專案根目錄加一個 README。\n\n<!-- bridge:acceptance -->\n## 驗收\n\n1. 專案根目錄存在 `README.md`。\n");
  const cli = (args) => spawnSync(process.execPath, [bridge, ...args], { cwd: root, encoding: "utf8", env: isolatedEnv(), windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  // Once its contract is sealed, the card is the sealed one: one yes.
  const runOnce = () => {
    const card = cli(["start", order, "--fake-cli"]);
    assert.equal(card.status, 1);
    const started = yesTo(cli, order);
    assert.equal(started.status, 0, started.stdout + started.stderr);
  };
  runOnce();
  const paths = projectPaths(root);
  const [run] = await queryRecords("select r.run_id, r.contract_sha256, r.plan_sha256 from runs r where r.project_id = $1", [paths.projectId]);

  // The project: three settings, the work orders, and one folder of results with the contract and the result.
  const project = await filesUnder(path.join(root, ".review-bridge"));
  const results = project.filter((name) => name.startsWith("results/"));
  assert.deepEqual(project.filter((name) => !name.startsWith("results/")), ["bridge.json", "policy.override.json", "rules.md", "work-packages/TEMPLATE.md", "work-packages/TEMPLATE.zh-TW.md", "work-packages/hello.md"]);
  assert.equal(results.length, 2, results.join(", "));
  assert.ok(results.includes("results/hello/contract.v1." + run.contract_sha256.slice(0, 7) + ".json"), results.join(", "));
  assert.equal(await fsp.readFile(path.join(root, ".review-bridge", "results", "hello", "contract.v1." + run.contract_sha256.slice(0, 7) + ".json"), "utf8"),
    await fsp.readFile(path.join(paths.contractsDir, run.contract_sha256 + ".json"), "utf8"), "the sealed contract, as it was sealed");
  assert.ok(results.some((name) => /^results\/hello\/SHOP-412 hello \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2} success\.md$/.test(name)), results.join(", "));
  assert.deepEqual((await filesUnder(root)).filter((name) => /\.(jsonl|log|lock)$/.test(name)), [], "no event, log or lock file in the project");
  assert.equal(await fsp.stat(path.join(root, ".review-bridge", "review-queue")).catch(() => null), null);

  // The run's log folder: the plan, the card it ran on, each call's prompt, stream and stderr, the test output.
  const folder = paths.runLogDir(run.run_id);
  assert.equal(folder, path.join(dataHome, "logs", paths.projectId, run.run_id));
  const logs = await fsp.readdir(folder);
  for (const pattern of [/^hello\.plan\.json$/, /^authorized-plan-[0-9a-f]{64}\.txt$/, /-writer-only-prompt\.txt$/, /-writer\.stream\.jsonl$/, /-writer\.stderr\.log$/, /-test\.stdout\.log$/, /-test\.stderr\.log$/,
    /-reviewer\.stdout\.log$/, /-reviewer\.stderr\.log$/, new RegExp("^" + run.run_id + "\\.result\\.md$")]) {
    assert.ok(logs.some((name) => pattern.test(name)), pattern + " in " + logs.join(", "));
  }

  // logs <run_id> names the folder and every file in it; status names where the logs are.
  const shown = cli(["logs", run.run_id]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.stdout.split("\n")[0], "Logs of run " + run.run_id + " (success): " + folder);
  for (const name of logs) assert.ok(shown.stdout.includes(name), name);
  assert.equal(logs.some((name) => /-contract/.test(name)), false, "no call turned the work order into a contract");
  assert.match(shown.stdout, /\n {2}call \d {3}controller {2}test {12}stdout {14}\S+-test\.stdout\.log\n/);
  const listed = JSON.parse(cli(["logs", run.run_id, "--json"]).stdout);
  assert.deepEqual(listed.files.map((file) => file.name).sort(), [...logs].sort());
  const status = cli(["status"]);
  assert.ok(status.stdout.split("\n").includes("Logs: " + paths.logRoot), status.stdout);

  // A second run; logs <file>, logs <bare name> and logs <source_id> list both, newest first, with the
  // run fields work-status uses and each run's log folder.
  runOnce();
  const ordered = (await queryRecords("select run_id from runs where project_id = $1 order by created_at desc", [paths.projectId])).map((row) => row.run_id);
  const workStatus = JSON.parse(cli(["work-status"]).stdout);
  for (const name of [order, "hello", "SHOP-412"]) {
    const byName = cli(["logs", name, "--json"]);
    assert.equal(byName.status, 0, name + ": " + byName.stderr);
    const parsed = JSON.parse(byName.stdout);
    assert.deepEqual(parsed.runs.map((entry) => entry.run_id), ordered, name);
    assert.deepEqual(Object.keys(parsed.runs[0]), [...Object.keys(workStatus.runs[0]), "log_path"], name + ": the work-status fields, then the log folder");
    assert.equal(parsed.runs[0].log_path, paths.runLogDir(ordered[0]));
    const plain = cli(["logs", name]).stdout.split("\n");
    assert.equal(plain[0], "Runs of " + name + ", newest first:");
    assert.ok(plain[1].startsWith("  " + ordered[0] + "  ") && plain[1].endsWith(paths.runLogDir(ordered[0])), plain[1]);
    // People read local time with its offset; --json keeps the ISO value.
    assert.match(parsed.runs[0].created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(plain[1].includes("  " + localTimestamp(parsed.runs[0].created_at) + "  "), plain[1]);
  }
  const statusLine = cli(["status"]).stdout.split("\n").find((line) => line.startsWith("  " + ordered[0] + "  "));
  assert.ok(statusLine?.endsWith("  " + localTimestamp(workStatus.runs.find((entry) => entry.run_id === ordered[0]).created_at)), statusLine);
  assert.equal(cli(["logs", "NOT-THERE"]).status, 2);

  // The database is the record: without the logs and the results, status still lists both runs and a
  // new run writes its result and contract again.
  await fsp.rm(paths.logRoot, { recursive: true, force: true });
  await fsp.rm(path.join(root, ".review-bridge", "results"), { recursive: true, force: true });
  const after = cli(["status"]);
  assert.equal(after.status, 0, after.stderr);
  for (const runId of ordered) assert.ok(after.stdout.includes("  " + runId + "  completed"), after.stdout);
  assert.match(cli(["logs", ordered[0]]).stdout, /\n {2}None: they were removed after the retention days, or by clean /);
  runOnce();
  assert.equal((await fsp.readdir(path.join(root, ".review-bridge", "results", "hello"))).length, 2, "a result and its contract");
  // clean <run_id> takes the run's log folder with it.
  const [newest] = (await queryRecords("select run_id from runs where project_id = $1 order by created_at desc limit 1", [paths.projectId])).map((row) => row.run_id);
  assert.equal(await fsp.stat(paths.runLogDir(newest)).then(() => true, () => false), true);
  assert.equal(cli(["clean", newest]).status, 0);
  assert.equal(await fsp.stat(paths.runLogDir(newest)).catch(() => null), null);
});

// The budget is the writer's (Owner 2026-11-08): what its calls read new, wrote to the cache and wrote
// out; what it read back from the cache and what the reviewer used are recorded and count against nothing.
test("the budget check asks the database for one number by primary key: the writer's usage without cache reads", async (t) => {
  const { root, order, cli } = await fourActionsProject(t, "review-bridge-usage-total-");
  assert.equal(cli(["start", order, "--fake-cli"]).status, 1);
  assert.equal(yesTo(cli, order).status, 0);
  const [{ run_id: runId }] = await queryRecords("select run_id from runs order by created_at desc limit 1");
  const { getBridgePaths } = await import("../review-bridge/utils/paths.mjs");
  const service = await import("../review-bridge/service/index.mjs");
  const { openDatabase } = await import("../review-bridge/service/database/index.mjs");
  const db = await openDatabase();
  const asked = [];
  const watched = Object.create(db, { query: { value: (sql, values) => { asked.push(sql); return db.query(sql, values); } } });
  service.installRunRecorder(service.createRunRecorder(async () => watched), async () => watched);
  t.after(() => service.installRunRecorder(null));
  const paths = getBridgePaths(root, path.join(packageRoot, "review-bridge"), { privateRootName: ".review-bridge" });
  const total = await service.usageTotalForRun(paths, runId);
  assert.deepEqual(asked, ["select tokens_used from runs where run_id = $1"]);
  const usage = (await queryRecords("select payload from run_events where run_id = $1 and type = 'usage' order by sequence", [runId])).map((row) => row.payload);
  const writer = usage.filter((event) => event.role === "writer");
  const reviewer = usage.filter((event) => event.role === "reviewer");
  assert.ok(writer.length >= 1 && reviewer.length >= 1, "the writer and the reviewer each used tokens");
  assert.equal(total, writer.reduce((sum, event) => sum + service.budgetTokens(event.tokens), 0));
  assert.ok(total > 0);
  // The fake writer reads most of its context back from the cache: recorded, not counted.
  assert.ok(writer.every((event) => event.tokens.cache_read > 0), JSON.stringify(writer));
  assert.equal(total, writer.reduce((sum, event) => sum + event.tokens.input + event.tokens.cache_write + event.tokens.output, 0));
  assert.ok(total < usage.reduce((sum, event) => sum + service.tokenTotal(event.tokens), 0), "the reviewer's tokens and the cache reads are left out");
});
