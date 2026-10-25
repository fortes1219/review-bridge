// Keeps the person's database out of these tests (see the fixture).
import { dataHome, queryRecords, stopServerIn } from "../review-bridge/tests/fixtures/isolatedDataHome.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridge = path.join(packageRoot, "bridge.mjs");

// Model-free environment: provider CLI overrides point at paths that do not exist, so the
// platform adapter fails closed instead of falling back to an installed, signed-in CLI.
const isolatedHome = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-no-cli-home-"));
process.on("exit", () => { try { fsSync.rmSync(isolatedHome, { recursive: true, force: true }); } catch {} });
// stop needs the OS process tools (ps on POSIX), so the system directories stay on PATH.
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

// init starts the resident page service; stop it before the workspace is removed.
function removeWorkspace(root) {
  spawnSync(process.execPath, [path.join(packageRoot, "review-bridge", "bootstrap.mjs"), "down"], {
    cwd: root, encoding: "utf8", windowsHide: true,
  });
  return fsp.rm(root, { recursive: true, force: true });
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
  assert.deepEqual(result.stdout.trimEnd().split(/\r?\n/), [
    "Setting up .review-bridge/...",
    "Checking the setup...",
    "Running the four fake self-tests...",
    "Starting the local page...",
    "Done. Now:",
    "",
    "  put a work order .md in .review-bridge/work-packages/",
    "  review-bridge start .review-bridge/work-packages/<file>.md",
    "  page: http://localhost:" + port + "/",
  ]);
  assert.doesNotMatch(result.stdout, /SHA-?256|plan_sha256|[0-9a-f]{64}|\[y\/N\]/i);
  const config = JSON.parse(await fsp.readFile(path.join(root, ".review-bridge", "review-bridge", "bridge.json"), "utf8"));
  assert.equal(config.profile_id, "vue-frontend");
});

test("R5 init keeps self-test artifacts disposable and installs TEMPLATE.md", async (t) => {
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
  await fsp.access(path.join(root, ".review-bridge", "review-bridge-install.json"));
  assert.deepEqual(await fsp.readdir(path.join(root, ".review-bridge", "work-packages")), ["TEMPLATE.md"]);
  const queueEntries = await fsp.readdir(path.join(root, ".review-bridge", "review-queue"), { withFileTypes: true });
  assert.deepEqual(queueEntries.filter((entry) => entry.isFile()).map((entry) => entry.name), []);

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
  assert.match(removed.stderr, /Unknown command: enqueue\. Run: review-bridge --help/);
  assert.deepEqual(await fsp.readdir(path.join(root, ".review-bridge", "review-queue", "authorizations")), []);
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
  // B3: the only addition is Bridge's own /review-bridge command.
  assert.deepEqual(await fsp.readdir(path.join(root, ".claude")), ["commands", "settings.local.json"]);
  assert.deepEqual(await fsp.readdir(path.join(root, ".claude", "commands")), ["review-bridge.md"]);
  assert.deepEqual(await fsp.readdir(path.join(root, ".codex")), ["config.toml"]);
  await fsp.access(path.join(root, ".review-bridge", "review-bridge-install.json"));
});

test("same provider for both roles remains blocked until separate sessions are proved", async (t) => {
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
  assert.equal(output.role_readiness.separate_sessions_proven, "not_run");
  assert.equal(output.real_mode.ready, false);
  const config = JSON.parse(await fsp.readFile(path.join(root, ".review-bridge", "review-bridge", "bridge.json")));
  assert.equal(config.roles.separate_sessions, true);
  assert.equal(config.roles.writer.provider_id, "codex");
  assert.equal(config.roles.reviewer.provider_id, "codex");
});

test("init without a terminal takes claude and codex when no role is given or saved, and sets up an empty folder as type none", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-default-roles-"));
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-default-roles-home-"));
  t.after(() => { stopServerIn(home); return Promise.all([removeWorkspace(root), fsp.rm(home, { recursive: true, force: true })]); });
  const env = isolatedEnv({ REVIEW_BRIDGE_DATA_HOME: home });
  const result = spawnSync(process.execPath, await scriptedInit(bridge, "init", "--target", root), {
    cwd: packageRoot, encoding: "utf8", env, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.roles, { writer: "claude", reviewer: "codex" });
  assert.equal(output.profile, null);
  const config = JSON.parse(await fsp.readFile(path.join(root, ".review-bridge", "review-bridge", "bridge.json"), "utf8"));
  assert.equal(config.profile_id, null);
  assert.deepEqual(config.gate_a, { profile_id: null, rules: [] });
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
  assert.deepEqual(result.stdout.trimEnd().split(/\r?\n/).slice(-6), [
    "Done. Now:",
    "",
    "  cd " + path.relative(packageRoot, root),
    "  put a work order .md in .review-bridge/work-packages/",
    "  review-bridge start .review-bridge/work-packages/<file>.md",
    "  page: " + url,
  ]);
  await fsp.access(workFolder);
  const config = JSON.parse(await fsp.readFile(path.join(root, ".review-bridge", "review-bridge", "bridge.json"), "utf8"));
  assert.deepEqual(config.watch, { port, strict_port: false });
  assert.equal((await fsp.readFile(path.join(root, ".review-bridge", "watch-url.txt"), "utf8")).trim(), url);
  assert.equal((await fetch(url)).status, 200);
  // B8: the URL init printed is the one the running service recorded and answers for.
  const session = JSON.parse(await fsp.readFile(path.join(root, ".review-bridge", "watch-session.json"), "utf8"));
  assert.equal(session.url, url);
  assert.equal((await (await fetch(url + "api/status")).json()).service_id, session.service_id);

  const bootstrap = path.join(packageRoot, "review-bridge", "bootstrap.mjs");
  const run = (...args) => spawnSync(process.execPath, [bootstrap, ...args], { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(run("up", "--fake-cli").stdout.trim(), "已在跑：" + url);
  assert.equal(run("down").status, 0);
  const ps = run("ps");
  assert.equal(ps.status, 1);
  assert.equal(ps.stdout.trim(), "Bridge 沒在跑，執行 review-bridge up");
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
  await fsp.writeFile(path.join(root, ".review-bridge", "work-packages", "add-readme.md"), "# Work order: add a README\n\nA README exists.\n");
  const file = ".review-bridge/work-packages/add-readme.md";
  const run = (...args) => spawnSync(process.execPath, [bridge, "work-plan", ...args], { cwd: root, encoding: "utf8", env: isolatedEnv(), windowsHide: true });

  // D4: two lines by default; JSON only with --json.
  const plain = run(file, "--breakpoint", "after the review", "--change-types", "docs");
  assert.equal(plain.status, 0, plain.stderr);
  const planFile = path.join(".review-bridge", "review-queue", "add-readme.plan.json");
  assert.deepEqual(plain.stdout.trimEnd().split(/\r?\n/), ["Plan written to " + planFile, "Next: review-bridge work-start --plan " + planFile]);
  const planned = run(file, "--breakpoint", "after the review", "--change-types", "docs", "--json");
  assert.equal(planned.status, 0, planned.stderr);
  const output = JSON.parse(planned.stdout);
  assert.equal(output.work_package, "add-readme");
  assert.equal(output.owner, os.userInfo().username);
  assert.equal(output.plan_path, path.join(root, ".review-bridge", "review-queue", "add-readme.plan.json"));
  await fsp.access(output.plan_path);

  // A type-none project has no Gate A rules: docs-only work needs none; other work is refused as before.
  assert.equal(output.gate_a.kind, "not_applicable");
  const code = run(file, "--breakpoint", "after the review", "--change-types", "code", "--json");
  assert.equal(code.status, 1);
  assert.deepEqual(JSON.parse(code.stdout), { valid: false, reason: "no_gate_a", checked: [] });
  const codePlain = run(file, "--breakpoint", "after the review", "--change-types", "code");
  assert.equal(codePlain.status, 1);
  assert.match(codePlain.stdout, /--change-types docs\n$/);

  // Without a terminal the breakpoint and the change types are still required, and the refusal
  // says what to add (C4).
  const bare = run(file);
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /A breakpoint is required\. Add --breakpoint "<where to stop>" or answer the prompt\./);
  const noTypes = run(file, "--breakpoint", "after the review");
  assert.equal(noTypes.status, 2);
  assert.match(noTypes.stderr, /The change types are required\. Add --change-types docs/);
  const twice = run(file, "--task-file", file, "--breakpoint", "x", "--change-types", "docs");
  assert.equal(twice.status, 2);
  assert.match(twice.stderr, /Give the work order once/);
});

// The Owner's case: an empty folder set up as vue-frontend. A chosen type is used as chosen;
// the mismatch stops code work at Gate A, not at setup.
test("a chosen project type that does not fit the folder is set up and stopped at Gate A", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-chosen-type-"));
  t.after(() => removeWorkspace(root));
  const init = spawnSync(process.execPath, await scriptedInit(bridge, "init", "--target", root, "--profile", "vue-frontend", "--yes"), {
    cwd: packageRoot, encoding: "utf8", env: isolatedEnv(), windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(init.status, 0, init.stderr);
  const config = JSON.parse(await fsp.readFile(path.join(root, ".review-bridge", "review-bridge", "bridge.json"), "utf8"));
  assert.equal(config.profile_id, "vue-frontend");
  assert.deepEqual(config.gate_a.rules, [{ command: "npm test", package_script: "test" }]);

  await fsp.writeFile(path.join(root, ".review-bridge", "work-packages", "fix.md"), "# Work order: fix\n\nIt works.\n");
  const run = (...args) => spawnSync(process.execPath, [bridge, "work-plan", ".review-bridge/work-packages/fix.md", ...args], {
    cwd: root, encoding: "utf8", env: isolatedEnv(), windowsHide: true,
  });
  const code = run("--breakpoint", "after the review", "--change-types", "code", "--json");
  assert.equal(code.status, 1);
  const refused = JSON.parse(code.stdout);
  assert.equal(refused.valid, false);
  assert.equal(refused.reason, "no_gate_a");
  assert.deepEqual(refused.checked.map((rule) => rule.command), ["npm test"]);
  assert.equal(run("--breakpoint", "after the review", "--change-types", "docs").status, 0);
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
  await fsp.writeFile(path.join(root, order), "# 工單：新增 README\n\n## 驗收\n\n1. 專案根目錄存在 `README.md`。\n");
  const start = (...args) => spawnSync(process.execPath, [bridge, "start", order, ...args], {
    cwd: root, encoding: "utf8", env: isolatedEnv(), windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(start("--fake-cli", "--breakpoint", "after the review", "--change-types", "docs").status, 1, "the card --yes is for");
  const done = start("--fake-cli", "--yes", "--breakpoint", "after the review", "--change-types", "docs");
  assert.equal(done.status, 0, done.stderr);
  const lines = done.stdout.trimEnd().split(/\r?\n/);
  assert.equal(lines[0], "Plan from the card: " + path.join(".review-bridge", "review-queue", "hello.plan.json"));
  assert.equal(lines[1], "Reviewer read-only check: not needed with the fake CLI (no model is called)");
  for (const line of ["Work order:   " + order, "Stops:        after the review", "Changes:      docs", "Gate A:       not needed for docs-only work",
    "Budget:       2 writer call(s), up to 8 minute(s) each", "  │ # 工單：新增 README", "  │ 1. 專案根目錄存在 `README.md`。"]) {
    assert.ok(lines.includes(line), line);
  }
  const steps = lines.filter((line) => /^ {2}[A-Z]/.test(line));
  assert.deepEqual(steps, [
    "  Writer (claude) turns the work order into a contract; reviewer (codex) checks it",
    "  Contract sealed",
    "  Writer working (call 1 of 2)",
    "  Gate A: not needed for docs-only work",
    "  Reviewer checking the work",
  ]);
  assert.match(done.stdout, /\nDelivered: .*\nResult file: .*hello\.result\.md\nTokens: /);
});

// E: four actions for people (start, stop, resume, clean) on three routes: a person at a terminal
// (the pty acceptance run), VS Code's terminal (the same CLI) and an agent with no terminal. An
// agent's start and resume print the card and stop; the agent runs them again with --yes once the
// person said yes. All with the fake CLI: no model is called.
async function fourActionsProject(t, prefix) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => removeWorkspace(root));
  const init = spawnSync(process.execPath, await scriptedInit(bridge, "init", "--target", root, "--yes"), {
    cwd: packageRoot, encoding: "utf8", env: isolatedEnv(), windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(init.status, 0, init.stderr);
  const order = ".review-bridge/work-packages/hello.md";
  await fsp.writeFile(path.join(root, order), "# 工單：新增 README\n\n## 驗收\n\n1. 專案根目錄存在 `README.md`。\n");
  const cli = (args, env = {}) => spawnSync(process.execPath, [bridge, ...args], {
    cwd: root, encoding: "utf8", env: isolatedEnv(env), windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  const queue = path.join(root, ".review-bridge", "review-queue");
  const listed = async (folder) => (await fsp.readdir(path.join(queue, folder)).catch(() => [])).filter((name) => name.endsWith(".json"));
  return { root, order, cli, queue, listed };
}

test("an agent's start prints the card and stops; with --yes it runs and records the yes as the agent's", async (t) => {
  const { root, order, cli, queue, listed } = await fourActionsProject(t, "review-bridge-agent-start-");
  const card = cli(["start", order, "--fake-cli"]);
  assert.equal(card.status, 1);
  const lines = card.stdout.trimEnd().split(/\r?\n/);
  for (const line of ["Stops:        after the review", "Changes:      docs", "Gate A:       not needed for docs-only work",
    "Budget:       2 writer call(s), up to 8 minute(s) each", "  │ # 工單：新增 README", "  │ 1. 專案根目錄存在 `README.md`。"]) {
    assert.ok(lines.includes(line), line);
  }
  assert.ok(lines.some((line) => line.startsWith("Contract:     ")) && lines.some((line) => line.startsWith("Valid until:  ")));
  assert.equal(lines.at(-1), "Needs authorization. If the person says yes, run again: review-bridge start " + order + " --fake-cli --yes");
  assert.deepEqual(await listed("runs"), [], "nothing started");
  assert.deepEqual(await listed("authorizations"), [], "nothing authorized");

  const yes = cli(["start", order, "--fake-cli", "--yes"]);
  assert.equal(yes.status, 0, yes.stderr);
  assert.match(yes.stdout, /\nDelivered: .*\nResult file: /);
  const [authorizationFile] = await listed("authorizations");
  const authorization = JSON.parse(await fsp.readFile(path.join(queue, "authorizations", authorizationFile), "utf8"));
  assert.equal(authorization.authorized_via, "agent");
  const text = await fsp.readFile(path.join(root, order), "utf8");
  const { createHash } = await import("node:crypto");
  assert.equal(authorization.work_order_sha256, createHash("sha256").update(text.trim()).digest("hex"));
  const [runFile] = await listed("runs");
  const run = JSON.parse(await fsp.readFile(path.join(queue, "runs", runFile), "utf8"));
  assert.equal(run.authorized_via, "agent");
  assert.match(run.contract_sha256, /^[0-9a-f]{64}$/, "the contract sealed under this yes is on the run");
});

// E8, E10: the yes is for the card the person saw, once. A work order edited between the card and
// --yes is refused, and stays refused until a new card is shown; --yes with no card shown, with an
// option the card did not show, or a second time on one card is refused too.
test("--yes is refused when the work order changed after the card, when no card was shown, or when the card was used", async (t) => {
  const { root, order, cli, listed } = await fourActionsProject(t, "review-bridge-card-changed-");
  const noCard = cli(["start", order, "--fake-cli", "--yes"]);
  assert.equal(noCard.status, 1, noCard.stderr);
  assert.equal(noCard.stdout, "No card was shown for this work order, so there is no yes to run on. Run: review-bridge start " + order + " --fake-cli and show the person the card.\n");

  assert.equal(cli(["start", order, "--fake-cli"]).status, 1);
  const file = path.join(root, order);
  await fsp.writeFile(file, (await fsp.readFile(file, "utf8")).replace("README", "READMe"));
  const refusal = "The work order changed after you saw the card. Run: review-bridge start " + order + " --fake-cli and look again.\n";
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
  const other = cli(["start", order, "--fake-cli", "--yes", "--change-types", "docs,code"]);
  assert.equal(other.status, 1, other.stderr);
  assert.equal(other.stdout, "--change-types is not what the card showed. Run: review-bridge start " + order + " --fake-cli --yes without it, or review-bridge start " + order + " --fake-cli to show the person a new card.\n");
  const yes = cli(["start", order, "--fake-cli", "--yes", "--change-types", "docs"]);
  assert.equal(yes.status, 0, yes.stdout + yes.stderr);
  assert.match(yes.stdout, /^Plan from the card: .*hello\.plan\.json\n/);
  assert.match(yes.stdout, /\nDelivered: .*\nResult file: /);
  // E10: one card, one yes.
  const again = cli(["start", order, "--fake-cli", "--yes"]);
  assert.equal(again.status, 1, again.stderr);
  assert.equal(again.stdout, "This card was already said yes to; one card starts one run. Run: review-bridge start " + order + " --fake-cli and show the person the new card.\n");
  assert.equal((await listed("runs")).length, 1, "one run from one card");
});

// RC3-BLOCKER-01 step 2: the card says which work order the yes starts (spec 2026-10-24), and the
// start lands in the person's database: the work order, its versions, one plan per card, one claim
// per yes, one contract per run.
test("the card names the work order: new, then updated, renamed or copied; the records are in the database", async (t) => {
  const { root, order, cli } = await fourActionsProject(t, "review-bridge-identity-");
  const { project_id: projectId } = JSON.parse(await fsp.readFile(path.join(root, ".review-bridge", "review-bridge", "bridge.json"), "utf8"));
  const decision = (args) => {
    const card = cli(["start", ...args, "--fake-cli"]);
    assert.equal(card.status, 1, card.stderr);
    return card.stdout.split(/\r?\n/)[card.stdout.split(/\r?\n/).findIndex((line) => line.startsWith("Work order:   ")) + 1].trim();
  };
  const yes = (file) => assert.equal(cli(["start", file, "--fake-cli", "--yes"]).status, 0);
  assert.equal(decision([order]), "New work order \"工單：新增 README\"");
  yes(order);
  await fsp.appendFile(path.join(root, order), "2. README 有專案名稱。\n");
  assert.equal(decision([order]), "Updates \"工單：新增 README\": version 1 → 2, 1 line(s) changed");
  yes(order);
  assert.equal(decision([order]), "Updates \"工單：新增 README\": still version 2, with new run settings");
  // A copy beside the original is a new work order, even with the same text; --update says otherwise.
  const copy = ".review-bridge/work-packages/hello-copy.md";
  await fsp.copyFile(path.join(root, order), path.join(root, copy));
  assert.equal(decision([copy]), "New work order \"工單：新增 README\"");
  const [{ work_order_id: original }] = await queryRecords("select work_order_id from work_orders where project_id = $1 and last_file_name = $2", [projectId, order]);
  assert.equal(decision([copy, "--update", original]), "Updates \"工單：新增 README\": still version 2, with new run settings");
  assert.equal(decision([order, "--as-new"]), "New work order \"工單：新增 README\"");
  // A renamed file (the old one gone, the text close) updates the work order it was.
  const renamed = ".review-bridge/work-packages/readme.md";
  await fsp.rm(path.join(root, copy));
  await fsp.rename(path.join(root, order), path.join(root, renamed));
  await fsp.appendFile(path.join(root, renamed), "3. 一行說明。\n");
  assert.equal(decision([renamed]), "Updates \"工單：新增 README\": version 2 → 3, 1 line(s) changed");
  yes(renamed);

  const rows = async (sql) => await queryRecords(sql, [projectId]);
  assert.deepEqual((await rows("select last_file_name from work_orders where project_id = $1")).map((row) => row.last_file_name), [renamed], "one work order, renamed");
  assert.deepEqual((await rows("select v.version_no from work_order_versions v join work_orders w using (work_order_id) where w.project_id = $1 order by 1"))
    .map((row) => row.version_no), [1, 2, 3]);
  assert.equal((await rows("select count(*)::int as n from plans where project_id = $1"))[0].n, 7, "one plan per card");
  const claims = await rows("select c.run_id from authorization_claims c join authorizations a using (authorization_id) join plans p using (plan_sha256) where p.project_id = $1");
  assert.equal(claims.length, 3, "one claim per yes");
  const authorizations = await rows("select a.authorized_via, p.content_sha256 from authorizations a join plans p using (plan_sha256) where p.project_id = $1");
  assert.ok(authorizations.every((row) => row.authorized_via === "agent" && /^[0-9a-f]{64}$/.test(row.content_sha256)));
  const contracts = await rows("select c.contract_sha256 from contracts c join work_orders w using (work_order_id) where w.project_id = $1");
  assert.equal(contracts.length, 3, "one contract per run");
  for (const { run_id: runId } of claims) {
    const run = JSON.parse(await fsp.readFile(path.join(root, ".review-bridge", "review-queue", "runs", runId + ".json"), "utf8"));
    assert.ok(contracts.some((row) => row.contract_sha256 === run.contract_sha256), "the run's contract is recorded");
  }
});

test("two --yes to one card at once start one run; clean --all clears the project's records", async (t) => {
  const { root, order, cli, listed } = await fourActionsProject(t, "review-bridge-two-yes-");
  const { project_id: projectId } = JSON.parse(await fsp.readFile(path.join(root, ".review-bridge", "review-bridge", "bridge.json"), "utf8"));
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
  assert.match(cleared.stdout, /^Cleared this project's records: 1 work order\(s\), 1 version\(s\), 1 plan\(s\), 1 authorization\(s\), 1 contract\(s\), 1 run\(s\)\.\n/);
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

// RC3-BLOCKER-01 step 3: the run, its one timeline, each condition's verdict, Gate A and the delivery
// are in the database; a stopped run is recorded as stopped; clean <run_id> is one delete that takes
// every row the run owns and keeps its authorization and claim.
test("a run's events, verdicts, Gate A and delivery are in the database; stop and clean <run_id> follow", async (t) => {
  const { order, cli, queue } = await fourActionsProject(t, "review-bridge-run-records-");
  assert.equal(cli(["start", order, "--fake-cli"]).status, 1);
  assert.equal(cli(["start", order, "--fake-cli", "--yes"]).status, 0);
  const [runFile] = (await fsp.readdir(path.join(queue, "runs"))).filter((name) => name.endsWith(".json"));
  const runId = runFile.slice(0, -5);
  const file = JSON.parse(await fsp.readFile(path.join(queue, "runs", runFile), "utf8"));
  const [run] = await queryRecords("select status, outcome, contract_sha256, last_event_sequence from runs where run_id = $1", [runId]);
  assert.deepEqual({ status: run.status, outcome: run.outcome, contract: run.contract_sha256 }, { status: "pass", outcome: "delivered", contract: file.contract_sha256 });
  const types = (await queryRecords("select type from run_events where run_id = $1 order by sequence", [runId])).map((row) => row.type);
  assert.equal(types.length, run.last_event_sequence, "one sequence, no gaps");
  for (const type of ["run_started", "contract_sealed", "task.input", "gate_a_result", "review.result", "acceptance", "run_terminal", "run_delivered"]) assert.ok(types.includes(type), type);
  assert.deepEqual(await queryRecords("select ac_id, verdict, result from acceptance_rows where run_id = $1", [runId]), [{ ac_id: "AC1", verdict: "pass", result: "proven" }]);
  assert.deepEqual(await queryRecords("select ac_id, verdict from review_verdicts where run_id = $1", [runId]), [{ ac_id: "AC1", verdict: "pass" }]);
  assert.deepEqual(await queryRecords("select kind, passed from gate_a_results where run_id = $1", [runId]), [{ kind: "not_applicable", passed: null }]);
  const [delivered] = await queryRecords("select payload from run_events where run_id = $1 and type = 'run_delivered'", [runId]);
  assert.equal(delivered.payload.outcome, "delivered");
  assert.equal(delivered.payload.sha256, file.result_sha256);

  // A run stopped from another process is recorded as stopped there too.
  assert.equal(cli(["start", order, "--fake-cli"]).status, 1);
  const { spawn } = await import("node:child_process");
  const slow = spawn(process.execPath, [bridge, "start", order, "--fake-cli", "--yes"], { cwd: path.dirname(path.dirname(queue)), env: isolatedEnv({ FAKE_CLAUDE_SLEEP_MS: "30000" }), windowsHide: true, stdio: "ignore" });
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
  const [stopped] = await queryRecords("select status, closed_reason from runs where run_id = $1", [stoppedId]);
  assert.equal(stopped.status, "stopped");

  // clean <run_id>: one delete takes the run's rows; its authorization and claim stay.
  const owned = async () => Object.fromEntries(await Promise.all(["runs", "run_events", "gate_a_results", "review_results", "review_verdicts", "acceptance_decisions", "acceptance_rows"]
    .map(async (table) => [table, (await queryRecords("select count(*)::int as n from " + table + " where run_id = $1", [runId]))[0].n])));
  assert.ok(Object.values(await owned()).every((n) => n > 0));
  assert.equal(cli(["clean", runId]).status, 0);
  assert.ok(Object.values(await owned()).every((n) => n === 0), JSON.stringify(await owned()));
  assert.equal((await queryRecords("select count(*)::int as n from authorization_claims where run_id = $1", [runId]))[0].n, 1, "the card stays used");
});

// E10: a card never shown because the reviewer check did not pass is withdrawn in the records, so no
// later --yes can start it (a card answered no at a terminal is withdrawn the same way; the pty run
// shows it). The card's "Valid until" is the plan's, as recorded.
test("a card not shown takes no later --yes; a card past its Valid until is refused", async (t) => {
  const { order, cli, listed } = await fourActionsProject(t, "review-bridge-card-once-");
  const notShown = cli(["start", order]);
  assert.equal(notShown.status, 1);
  assert.match(notShown.stdout, /\nReviewer read-only check: not passed /);
  const [withdrawn] = await queryRecords("select shown_at, withdrawn_at from plans order by created_at desc limit 1");
  assert.equal(withdrawn.shown_at, null, "the card was never shown");
  assert.ok(withdrawn.withdrawn_at, "and it is withdrawn");
  assert.match(cli(["start", order, "--fake-cli", "--yes"]).stdout, /^No card was shown /);

  assert.equal(cli(["start", order, "--fake-cli"]).status, 1);
  await queryRecords("update plans set authorization_expires_at = now() - interval '1 second' where shown_at is not null and withdrawn_at is null");
  const old = cli(["start", order, "--fake-cli", "--yes"]);
  assert.equal(old.status, 1, old.stderr);
  assert.match(old.stdout, /^The card was valid until .*\. Run: review-bridge start .* and show the person the new card\.\n$/);
  assert.deepEqual(await listed("runs"), []);
  assert.deepEqual(await listed("authorizations"), []);
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
  assert.equal(record.status, "stopped", "paused, and its record is kept");

  const status = cli(["status"]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, new RegExp("^Page: .*\\nWork: 0 running, 1 run\\(s\\) on record\\n  " + runId + "  stopped +  hello  ", "m"));
  assert.match(status.stdout, /\nReview queue: pending \d+, running \d+, done \d+, failed \d+\n/);

  const card = cli(["resume", runId, "--fake-cli"]);
  assert.equal(card.status, 1);
  assert.match(card.stdout, new RegExp("^Carrying on run " + runId + " \\(" + order.replaceAll(".", "\\.") + "\\) as a new run\\n"));
  assert.match(card.stdout, new RegExp("\\nNeeds authorization\\. If the person says yes, run again: review-bridge resume " + runId + " --fake-cli --yes\\n$"));
  const resumed = cli(["resume", runId, "--fake-cli", "--yes"]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /\nDelivered: .*\nResult file: /);
  const runs = await fsp.readdir(path.join(queue, "runs"));
  assert.equal(runs.length, 2);
  const carried = JSON.parse(await fsp.readFile(path.join(queue, "runs", runs.find((name) => name !== runId + ".json")), "utf8"));
  assert.equal(carried.status, "pass");
  assert.equal(carried.authorized_via, "agent");

  const cleaned = cli(["clean", runId]);
  assert.equal(cleaned.status, 0, cleaned.stdout + cleaned.stderr);
  assert.equal(await fsp.stat(path.join(queue, "runs", runId + ".json")).catch(() => null), null);
  const all = cli(["clean", "--json"]);
  assert.equal(all.status, 0, all.stderr);
  assert.equal(typeof JSON.parse(all.stdout), "object");
});

test("without the reviewer proof a real start is refused before any model call, with --yes or without", async (t) => {
  const { order, cli, listed } = await fourActionsProject(t, "review-bridge-no-proof-");
  // A card to say yes to (shown with the fake CLI, so the native --yes below has one).
  assert.equal(cli(["start", order, "--fake-cli"]).status, 1);
  const fakePage = /\nReviewer read-only check: not passed \(the Bridge page is running with the fake CLI\)\nRun: review-bridge down, then review-bridge start /;
  // The page init started runs the fake CLI, so it can never hold a proof.
  const refused = cli(["start", order, "--yes"]);
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stdout, fakePage);
  // No page at all: start starts one; with the CLIs absent the check cannot run, so nothing starts.
  cli(["down"]);
  const noPage = cli(["start", order, "--yes"]);
  assert.equal(noPage.status, 1, noPage.stderr);
  assert.match(noPage.stdout, /\nReviewer read-only check: not passed \((the reviewer CLI is not installed and signed in|this platform's adapter is not verified, so the check is not available here)\)\n/);
  assert.doesNotMatch(noPage.stdout, /Checking that the reviewer/);
  // work-start goes through the same gate: no running page, no start.
  cli(["down"]);
  const workStart = cli(["work-start", "--plan", ".review-bridge/review-queue/hello.plan.json", "--yes"]);
  assert.equal(workStart.status, 2);
  assert.match(workStart.stderr, /Native execution is unavailable: the Bridge page service is not running/);
  // And without --yes: refused at the check too.
  cli(["up", "--fake-cli"]);
  const asked = cli(["start", order]);
  assert.equal(asked.status, 1, asked.stderr);
  assert.match(asked.stdout, fakePage);
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
