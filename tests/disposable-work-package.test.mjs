import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(packageRoot, "installer", "install.mjs");

function run(command, args, cwd, expectedStatus = 0) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    windowsHide: true,
  });
  assert.equal(
    result.status,
    expectedStatus,
    [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n"),
  );
  return result;
}

async function installDisposable() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-disposable-"));
  const target = path.join(root, "target");
  const backup = path.join(root, "backup");
  const installPlan = path.join(root, "install-plan.json");
  await fsp.mkdir(target, { recursive: true });
  await fsp.writeFile(path.join(target, "AGENTS.md"), [
    "# Test Workspace",
    "",
    "Claude is the writer. Codex is the reviewer.",
    "Never commit, push, deploy, or expand scope without the human owner.",
    "",
  ].join("\n"), "utf8");
  await fsp.writeFile(path.join(target, "package.json"), JSON.stringify({
    name: "review-bridge-disposable",
    private: true,
    scripts: { test: "vitest run", build: "vite build", typecheck: "vue-tsc --noEmit" },
    dependencies: { vue: "latest" },
    devDependencies: { typescript: "latest", vite: "latest", vitest: "latest" },
  }, null, 2) + "\n", "utf8");
  await fsp.writeFile(path.join(target, "README.md"), "# Disposable Vue workspace\n", "utf8");

  const planned = run(process.execPath, [
    installer,
    "plan",
    "--target", target,
    "--profile", "auto",
    "--fake-cli",
    "--json",
    "--backup-root", backup,
    "--out", installPlan,
  ], packageRoot);
  const plan = JSON.parse(planned.stdout);
  assert.equal(plan.execution_mode, "fake_cli");
  assert.equal(plan.profile.id, "vue-frontend");
  assert.equal(plan.target.workspace_mode, "snapshot");
  assert.equal(plan.target.git_root, null);
  run(process.execPath, [
    installer,
    "apply",
    "--target", target,
    "--plan", installPlan,
    "--approve", plan.plan_sha256,
  ], packageRoot);
  const verified = run(process.execPath, [
    installer,
    "verify",
    "--target", target,
    "--fake-cli",
  ], packageRoot);
  assert.equal(JSON.parse(verified.stdout).execution_mode, "fake_cli");
  return { root, target };
}

test("installed no-Git Vue workspace completes every public fake scenario", async () => {
  const runtime = await installDisposable();
  try {
    const bootstrap = path.join(
      runtime.target,
      ".claude",
      "tools",
      "review-bridge",
      "bootstrap.mjs",
    );
    const scenarios = [
      { name: "PASS", exit: 0, status: "pass", call: 1 },
      { name: "FAIL_THEN_PASS", exit: 0, status: "pass", call: 2 },
      { name: "HARD_STOP", exit: 0, status: "hard_stop", call: 1 },
      { name: "RATE_LIMIT", exit: 75, status: "rate_limited", call: 1 },
    ];

    for (const [index, scenario] of scenarios.entries()) {
      const id = "disposable-" + String(index + 1);
      const taskDir = path.join(runtime.target, ".claude", "work-packages");
      const taskPath = path.join(taskDir, id + ".md");
      const planPath = path.join(runtime.target, ".claude", "review-queue", id + ".plan.json");
      await fsp.mkdir(taskDir, { recursive: true });
      await fsp.writeFile(taskPath, "Update README.md only. Do not commit or push.\n", "utf8");

      const planned = run(process.execPath, [
        bootstrap,
        "work-plan",
        "--task-file", taskPath,
        "--owner", "Disposable Human Owner",
        "--work-package", id,
        "--breakpoint", "return after Codex review",
        "--change-types", "docs",
        "--allow-paths", "README.md",
        "--max-claude-calls", "2",
        "--max-claude-minutes", "1",
        "--out", planPath,
      ], runtime.target);
      const workPlan = JSON.parse(planned.stdout);
      assert.equal(Object.hasOwn(workPlan, "plan_sha256"), false);
      assert.equal(workPlan.next_command, "work-start --plan <plan_path>");
      const startArgs = [
        bootstrap,
        "work-start",
        "--plan", planPath,
        "--fake-cli",
        "--fake-scenario", scenario.name,
      ];
      const started = index === 0
        ? spawnSync(process.execPath, startArgs, {
            cwd: runtime.target,
            encoding: "utf8",
            env: process.env,
            input: "y\n",
            windowsHide: true,
          })
        : run(process.execPath, [...startArgs, "--yes"], runtime.target, scenario.exit);
      if (index === 0) {
        assert.equal(started.status, scenario.exit, [started.stdout, started.stderr].join("\n"));
        assert.match(started.stdout, /Authorize this work package\? \[y\/N\]/);
        assert.doesNotMatch(started.stdout, /SHA-?256|plan_sha256|[0-9a-f]{64}/i);
      }
      const status = JSON.parse(index === 0
        ? started.stdout.slice(started.stdout.indexOf("{\n"))
        : started.stdout);
      assert.equal(status.execution_mode, "fake_cli");
      assert.equal(status.authorization_status, "consumed");
      assert.equal(status.latest_state.status, scenario.status);
      assert.equal(status.latest_state.call, scenario.call);
      const runNames = await fsp.readdir(path.join(runtime.target, ".claude", "review-queue", "runs"));
      const latestRun = JSON.parse(await fsp.readFile(path.join(
        runtime.target,
        ".claude",
        "review-queue",
        "runs",
        runNames.sort().at(-1),
      ), "utf8"));
      assert.equal(latestRun.workspace_evidence.mode, "workspace_snapshot");
    }
  } finally {
    await fsp.rm(runtime.root, { recursive: true, force: true });
  }
});
