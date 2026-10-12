import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readIoEvents } from "../core/io-events.mjs";
import { readJson } from "../core/io.mjs";
import { getBridgePaths } from "../core/paths.mjs";

const runtimeSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.resolve(runtimeSource, "..");

// A neutral install made by the real init in fake mode, so work-start --fake-cli is usable.
async function install(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-stop-"));
  // T0-06: a code work order needs an approved test entry point; the script exits 0 unless FAKE_GATE_EXIT says otherwise.
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "stop-demo", dependencies: { express: "4.0.0" }, scripts: { test: "node -e \"process.exit(Number(process.env.FAKE_GATE_EXIT||0))\"" } }));
  const port = await freePort();
  const init = spawnSync(process.execPath, [
    path.join(packageRoot, "bridge.mjs"), "init", "--target", root, "--writer", "claude", "--reviewer", "codex", "--yes", "--fake-cli", "--port", String(port),
  ], { cwd: packageRoot, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(init.status, 0, init.stderr);
  const runtime = path.join(root, ".review-bridge", "tools", "review-bridge");
  const bootstrap = path.join(runtime, "bootstrap.mjs");
  const bridge = (args, env = {}) => spawnSync(process.execPath, [bootstrap, ...args], {
    cwd: root, encoding: "utf8", windowsHide: true, env: { ...process.env, ...env },
  });
  t.after(async () => {
    bridge(["down"]);
    await fsp.rm(root, { recursive: true, force: true });
  });
  const paths = getBridgePaths(root, runtime, { privateRootName: ".review-bridge" });
  return { root, bootstrap, bridge, paths };
}

async function freePort() {
  const net = await import("node:net");
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function planFakeWork(root, bridge) {
  const order = path.join(root, ".review-bridge", "work-packages", "stop.md");
  await fsp.copyFile(path.join(root, ".review-bridge", "work-packages", "TEMPLATE.md"), order);
  await fsp.appendFile(order, "- package.json\n");
  const planned = bridge(["work-plan", "--task-file", ".review-bridge/work-packages/stop.md", "--owner", "Fortes", "--work-package", "stop-1",
    "--breakpoint", "return after review", "--change-types", "code", "--max-claude-calls", "1", "--max-claude-minutes", "2",
    "--out", ".review-bridge/review-queue/stop-1.plan.json"]);
  assert.equal(planned.status, 0, planned.stderr);
  const plan = await readJson(path.join(root, ".review-bridge", "review-queue", "stop-1.plan.json"));
  return { plan, planArg: ".review-bridge/review-queue/stop-1.plan.json" };
}

test("P7 stop: unknown and finished runs exit 1; a running writer is killed and the run is closed as stopped", async (t) => {
  const { root, bootstrap, bridge, paths } = await install(t);
  const unknown = bridge(["stop", "run-missing-0001"]);
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stdout.trim(), "沒有這條");

  const { plan, planArg } = await planFakeWork(root, bridge);
  const runId = plan.proposed_run_id;
  // The fake writer sleeps so the run is observably in progress.
  const child = spawn(process.execPath, [bootstrap, "work-start", "--plan", planArg, "--approve", plan.plan_sha256, "--fake-cli"], {
    cwd: root, windowsHide: true, env: { ...process.env, FAKE_CLAUDE_SLEEP_MS: "30000" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const exit = new Promise((resolve) => child.once("close", (code) => resolve(code)));
  const processFile = path.join(paths.runLocksDir, runId + ".process.json");
  const deadline = Date.now() + 20_000;
  let record = null;
  while (Date.now() < deadline) {
    record = await readJson(processFile).catch(() => null);
    if (record?.pid) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(record?.pid, "writer process was never recorded");
  assert.equal(record.role, "writer");

  const stopped = bridge(["stop", runId]);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(stopped.stdout.trim(), "已停止 " + runId);
  const code = await exit;
  assert.equal(code, 130, stdout);
  const run = await readJson(path.join(paths.runsDir, runId + ".json"));
  assert.equal(run.status, "stopped");
  assert.equal(run.closed_reason, "stopped");
  assert.equal(await fsp.stat(processFile).catch(() => null), null);
  const events = await readIoEvents(paths, runId);
  const stop = events.find((event) => event.event === "stop");
  assert.equal(stop.status, "stopped");
  assert.match(stop.detail_ref, /^pid:\d+:killed$/);
  assert.ok(events.some((event) => event.event === "task.input"));

  const again = bridge(["stop", runId]);
  assert.equal(again.status, 1);
  assert.match(again.stdout, /已經結束：stopped/);
});

test("live: a fake work-start leaves task.input, read and usage events and an injected prompt", async (t) => {
  const { root, bridge, paths } = await install(t);
  const { plan, planArg } = await planFakeWork(root, bridge);
  // T0-06 R1/R3 on the CLI: the plain summary names the sealed command; JSON carries it; no entry point refuses.
  assert.equal(plan.gate_a.command, "npm test");
  const plainOut = bridge(["work-plan", "--task-file", ".review-bridge/work-packages/stop.md", "--owner", "Fortes", "--work-package", "stop-plain",
    "--breakpoint", "return after review", "--change-types", "code", "--max-claude-calls", "1", "--max-claude-minutes", "2",
    "--out", ".review-bridge/review-queue/stop-plain.plan.json", "--plain"]);
  assert.equal(plainOut.status, 0, plainOut.stderr);
  assert.match(plainOut.stdout, /驗收：會跑 npm test（profile 核准）/);
  const manifest = await fsp.readFile(path.join(root, "package.json"), "utf8");
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "stop-demo" }));
  const refused = bridge(["work-plan", "--task-file", ".review-bridge/work-packages/stop.md", "--owner", "Fortes", "--work-package", "stop-refused",
    "--breakpoint", "return after review", "--change-types", "code", "--max-claude-calls", "1", "--max-claude-minutes", "2",
    "--out", ".review-bridge/review-queue/stop-refused.plan.json", "--plain"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /沒找到 profile 核准的測試入口/);
  assert.match(refused.stdout, /npm test：package\.json 沒有 scripts\.test/);
  assert.equal(await fsp.stat(path.join(root, ".review-bridge", "review-queue", "stop-refused.plan.json")).catch(() => null), null);
  await fsp.writeFile(path.join(root, "package.json"), manifest);
  const started = bridge(["work-start", "--plan", planArg, "--approve", plan.plan_sha256, "--fake-cli"]);
  assert.equal(started.status, 0, started.stderr + started.stdout);
  const events = await readIoEvents(paths, plan.proposed_run_id);
  const kinds = events.map((event) => event.event);
  assert.ok(kinds.includes("task.input"));
  assert.ok(kinds.includes("read"));
  assert.ok(kinds.includes("usage"));
  const reads = events.filter((event) => event.event === "read");
  assert.ok(reads.some((event) => event.outside_list === false));
  assert.ok(reads.some((event) => event.outside_list === true));
  const usage = events.find((event) => event.event === "usage");
  assert.equal(usage.tokens.cache_read, 150346);
  // T0-05: typed results on both sides, the reviewer packet, and the reviewer's own usage and read.
  assert.deepEqual(kinds.filter((kind) => /result|input$/.test(kind)), ["task.input", "writer.result", "gate_a_result", "review.input", "review.result"]);
  const gateEvent = events.find((event) => event.event === "gate_a_result");
  assert.equal(gateEvent.command, "npm test");
  assert.equal(gateEvent.passed, true);
  const writerResult = events.find((event) => event.event === "writer.result");
  assert.equal(writerResult.work_order, "stop-1");
  assert.equal(writerResult.status, "done");
  const reviewInput = events.find((event) => event.event === "review.input");
  assert.equal(reviewInput.work, (await readJson(path.join(paths.queueRoot, "stop-1.plan.json"))).work_order.work);
  assert.ok(Array.isArray(reviewInput.acceptance) && reviewInput.acceptance.length > 0);
  assert.deepEqual(reviewInput.writer_claim_mismatch.claimed_not_in_delta, ["package.json"]);
  const reviewResult = events.find((event) => event.event === "review.result");
  assert.equal(reviewResult.gate, "PASS");
  const reviewerUsage = events.find((event) => event.event === "usage" && event.role === "reviewer");
  assert.equal(reviewerUsage.source, "cli_json");
  assert.equal(reviewerUsage.tokens.input + reviewerUsage.tokens.cache_read, 59990);
  assert.ok(reads.some((event) => event.role === "reviewer" && event.tool === "command"));
  const reviewFiles = await fsp.readdir(paths.reviewsRoot);
  const promptName = reviewFiles.find((name) => name.endsWith("-review-prompt.md"));
  const reviewPrompt = await fsp.readFile(path.join(paths.reviewsRoot, promptName), "utf8");
  assert.match(reviewPrompt, /=== review\.input ===/);
  assert.doesNotMatch(reviewPrompt, /AGENTS\.md|CURRENT_HANDOFF|go read|Required procedure/i);
  const files = await fsp.readdir(paths.queueRoot);
  const promptFile = files.find((name) => name.endsWith("-writer-only-prompt.txt"));
  const prompt = await fsp.readFile(path.join(paths.queueRoot, promptFile), "utf8");
  assert.match(prompt, /=== RULES \(rules\.md\) ===/);
  assert.match(prompt, /=== package\.json \([0-9a-f]{12}\) ===/);
  assert.match(prompt, /"express"/);
  const run = await readJson(path.join(paths.runsDir, plan.proposed_run_id + ".json"));
  assert.equal(run.status, "pass");
});
