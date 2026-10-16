import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridge = path.join(packageRoot, "bridge.mjs");

// Model-free environment: provider CLI overrides point at paths that do not exist, so the
// platform adapter fails closed instead of falling back to an installed, signed-in CLI.
const isolatedHome = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-no-cli-home-"));
process.on("exit", () => { try { fsSync.rmSync(isolatedHome, { recursive: true, force: true }); } catch {} });
function isolatedEnv(overrides = {}) {
  const env = {
    PATH: [path.dirname(process.execPath), process.env.SystemRoot && path.join(process.env.SystemRoot, "System32")]
      .filter(Boolean).join(path.delimiter),
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    TEMP: os.tmpdir(),
    TMP: os.tmpdir(),
    CLAUDE_REVIEW_CLI: path.join(isolatedHome, "absent", "claude"),
    CODEX_REVIEW_CLI: path.join(isolatedHome, "absent", "codex"),
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
  spawnSync(process.execPath, [path.join(root, ".review-bridge", "tools", "review-bridge", "bootstrap.mjs"), "down"], {
    cwd: root, encoding: "utf8", windowsHide: true,
  });
  return fsp.rm(root, { recursive: true, force: true });
}

// Scripted init: JSON output, fake service adapter, and a free port instead of the default.
async function scriptedInit(...args) {
  return [...args, "--json", "--fake-cli", "--port", String(await freePort())];
}

test("init fails closed with one readable line when release integrity is damaged", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-integrity-target-"));
  const damagedPackage = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-integrity-package-"));
  t.after(() => Promise.all([
    fsp.rm(root, { recursive: true, force: true }),
    fsp.rm(damagedPackage, { recursive: true, force: true }),
  ]));
  await fsp.cp(packageRoot, damagedPackage, { recursive: true });
  await fsp.appendFile(path.join(damagedPackage, "README.md"), "\ndamaged after packaging\n", "utf8");

  const result = spawnSync(process.execPath, [path.join(damagedPackage, "bridge.mjs"), "init", "--target", root, "--yes"], {
    cwd: damagedPackage,
    encoding: "utf8",
    env: isolatedEnv(),
    windowsHide: true,
  });

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), "Review Bridge init failed closed: Release integrity check failed. Download and extract a fresh package.");
  assert.equal(await fsp.stat(path.join(root, ".review-bridge")).catch(() => null), null);
});

test("human init approval shows actionable scope without exposing internal checksum", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-human-init-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "clean-vue-app",
    private: true,
    dependencies: { vue: "latest" },
    devDependencies: { typescript: "latest", vite: "latest" },
  }, null, 2) + "\n", "utf8");

  const result = spawnSync(process.execPath, [bridge, "init", "--target", root, "--writer", "claude", "--reviewer", "codex"], {
    cwd: packageRoot,
    encoding: "utf8",
    env: isolatedEnv(),
    input: "n\n",
    windowsHide: true,
  });

  assert.equal(result.status, 2);
  assert.match(result.stdout, new RegExp(`Target workspace: ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(result.stdout, /Operation: install/);
  assert.match(result.stdout, /Detected profile: Vue and TypeScript frontend \(vue-frontend\)/);
  assert.doesNotMatch(result.stdout, /SHA-?256|plan_sha256|[0-9a-f]{64}/i);
  assert.match(result.stdout, /Planned changes:/);
  assert.match(result.stdout, /PASS, FAIL_THEN_PASS, HARD_STOP, and RATE_LIMIT with fake CLIs/);
  assert.match(result.stderr, /Installation cancelled by user/);
  assert.equal(await fsp.stat(path.join(root, ".review-bridge")).catch(() => null), null);
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

  const bootstrap = path.join(root, ".review-bridge", "tools", "review-bridge", "bootstrap.mjs");
  const doctor = spawnSync(process.execPath, [bootstrap, "doctor", "--fake-cli"], {
    cwd: root, encoding: "utf8", env: isolatedEnv(), windowsHide: true,
  });
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).native_readiness.ready, false);
  assert.equal(JSON.parse(doctor.stdout).native_readiness.reviewer_readonly_proven, "not_run");
  // T0-08 G2: native work-start only at an interactive terminal; every other model entry point closed.
  for (const { args, input, reason } of [
    { args: ["work-start", "--plan", "anything", "--approve", "anything"], reason: /with --approve or --yes/ },
    { args: ["work-start", "--plan", "anything", "--yes"], reason: /with --approve or --yes/ },
    { args: ["work-start", "--plan", "anything"], input: "y\n", reason: /must run at an interactive terminal/ },
    { args: ["review"], reason: /for review: only work-start/ },
    { args: ["bounded-resume"], reason: /for bounded-resume: only work-start/ },
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
  assert.match(removed.stderr, /Unsupported review bridge command: enqueue/);
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
  assert.deepEqual(await fsp.readdir(path.join(root, ".claude")), ["settings.local.json"]);
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

test("non-interactive init requires an explicit writer and reviewer", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-roles-required-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [bridge, "init", "--target", root, "--yes"], {
    cwd: packageRoot, encoding: "utf8", env: isolatedEnv(), windowsHide: true,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Select both --writer and --reviewer explicitly/);
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
    path.join(root, ".review-bridge", "tools", "review-bridge", "bootstrap.mjs"), "work-start", "--plan", "x", "--approve", "x", "--yes",
  ], { cwd: root, encoding: "utf8", env: isolatedEnv(), windowsHide: true });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /Native execution is unavailable/);
});

test("interactive init shows the missing step instead of labelling roles ready", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-no-cli-prompt-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [bridge, "init", "--target", root, "--writer", "codex", "--reviewer", "claude"], {
    cwd: packageRoot, encoding: "utf8", env: isolatedEnv(), input: "n\n", windowsHide: true,
  });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /writer: codex — CLI not found/);
  assert.match(result.stdout, /Next: install the codex CLI/);
  assert.match(result.stdout, /Selected roles are not ready/);
  assert.doesNotMatch(result.stdout, /\bsigned in\b(?! required)/);
  assert.deepEqual(await fsp.readdir(root), []);
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

test("init starts the resident service and prints exactly three plain lines", async (t) => {
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
  assert.deepEqual(result.stdout.trimEnd().split(/\r?\n/), [
    "工作資料夾：" + path.join(root, ".review-bridge", "work-packages"),
    "網頁：" + url,
    "下一步：在 VS Code 打開 .review-bridge/work-packages/TEMPLATE.md",
  ]);
  const config = JSON.parse(await fsp.readFile(path.join(root, ".review-bridge", "review-bridge", "bridge.json"), "utf8"));
  assert.deepEqual(config.watch, { port, strict_port: false });
  assert.equal((await fsp.readFile(path.join(root, ".review-bridge", "watch-url.txt"), "utf8")).trim(), url);
  assert.equal((await fetch(url)).status, 200);
  // B8: the URL init printed is the one the running service recorded and answers for.
  const session = JSON.parse(await fsp.readFile(path.join(root, ".review-bridge", "watch-session.json"), "utf8"));
  assert.equal(session.url, url);
  assert.equal((await (await fetch(url + "api/status")).json()).service_id, session.service_id);

  const bootstrap = path.join(root, ".review-bridge", "tools", "review-bridge", "bootstrap.mjs");
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
