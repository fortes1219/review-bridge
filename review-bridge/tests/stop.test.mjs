import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readIoEvents } from "../service/records/ioEvents.mjs";
import { readJson } from "../service/records/fileStore.mjs";
import { getBridgePaths } from "../utils/paths.mjs";

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
  // These checks read the Chinese pack; English, the product default, is covered by the delivery tests.
  const config = await readJson(paths.bridgeConfigPath);
  await fsp.writeFile(paths.bridgeConfigPath, JSON.stringify({ ...config, locale: "zh-TW" }, null, 2) + "\n");
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

async function planFakeWork(root, bridge, name = "stop") {
  const order = path.join(root, ".review-bridge", "work-packages", name + ".md");
  await fsp.copyFile(path.join(root, ".review-bridge", "work-packages", "TEMPLATE.md"), order);
  await fsp.appendFile(order, "- package.json\n");
  const id = name + "-1";
  const planArg = ".review-bridge/review-queue/" + id + ".plan.json";
  const planned = bridge(["work-plan", "--task-file", ".review-bridge/work-packages/" + name + ".md", "--owner", "Fortes", "--work-package", id,
    "--breakpoint", "return after review", "--change-types", "code", "--max-claude-calls", "1", "--max-claude-minutes", "2",
    "--out", planArg]);
  assert.equal(planned.status, 0, planned.stderr);
  const plan = await readJson(path.join(root, planArg));
  return { plan, planArg };
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
    // The contract translation runs first and briefly; the sleeping call is the writer's.
    if (record?.pid && record.role === "writer") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(record?.pid, "writer process was never recorded");
  assert.equal(record.role, "writer");

  const stopped = bridge(["stop", runId]);
  assert.equal(stopped.status, 0, stopped.stderr);
  // The first line is stop's own; when stop wins the race to deliver it adds the three result lines.
  const stopLines = stopped.stdout.trim().split(/\r?\n/);
  assert.equal(stopLines[0], "已停止 " + runId);
  if (stopLines.length > 1) {
    assert.equal(stopLines.length, 4);
    assert.equal(stopLines[1], "已停止：被 stop 指令停下");
    assert.match(stopLines[3], /^token：writer 未知，/); // the killed call left no usage
  }
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
  // The stopped call has no final result; what it spent is still recorded, marked partial.
  const spent = events.filter((event) => event.event === "usage" && event.role === "writer");
  assert.equal(spent.length, 1);
  assert.equal(spent[0].partial, true);
  assert.deepEqual(spent[0].missing, ["final_result"]);

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
  const started = bridge(["work-start", "--plan", planArg, "--approve", plan.plan_sha256, "--fake-cli", "--json"]);
  assert.equal(started.status, 0, started.stderr + started.stdout);
  const events = await readIoEvents(paths, plan.proposed_run_id);
  const kinds = events.map((event) => event.event);
  assert.ok(kinds.includes("task.input"));
  assert.ok(kinds.includes("read"));
  assert.ok(kinds.includes("usage"));
  const reads = events.filter((event) => event.event === "read");
  // The first call has no read list (no files are injected), so its reads are recorded unjudged.
  assert.ok(reads.some((event) => event.role !== "reviewer" && event.outside_list === null));
  const usage = events.find((event) => event.event === "usage" && event.role === "writer");
  assert.equal(usage.tokens.cache_read, 150346);
  // The work order became a sealed contract before the writer's first call.
  assert.deepEqual(kinds.slice(0, 5), ["usage", "contract.translation", "usage", "contract.check", "contract.sealed"]);
  assert.equal(events[0].role, "translator");
  const run = await readJson(path.join(paths.runsDir, plan.proposed_run_id + ".json"));
  const contractSha = events.find((event) => event.event === "contract.sealed").contract_sha256;
  assert.equal(run.contract_sha256, contractSha);
  // T0-05: typed results on both sides, the reviewer packet, and the reviewer's own usage and read.
  assert.deepEqual(kinds.filter((kind) => /result|input$/.test(kind)), ["task.input", "writer.result", "gate_a_result", "review.input", "review.result"]);
  const gateEvent = events.find((event) => event.event === "gate_a_result");
  assert.equal(gateEvent.command, "npm test");
  assert.equal(gateEvent.passed, true);
  const writerResult = events.find((event) => event.event === "writer.result");
  assert.equal(writerResult.work_order, "stop-1");
  assert.equal(writerResult.status, "done");
  assert.equal(writerResult.contract_sha256, contractSha);
  // The reviewer reads the same sealed contract the writer got.
  const taskInput = events.find((event) => event.event === "task.input");
  const reviewInput = events.find((event) => event.event === "review.input");
  assert.equal(taskInput.contract_sha256, contractSha);
  assert.equal(reviewInput.contract_sha256, contractSha);
  assert.deepEqual(reviewInput.contract, taskInput.contract);
  assert.ok(reviewInput.contract.acceptance.length > 0);
  assert.deepEqual(reviewInput.writer_claim_mismatch.claimed_not_in_delta, ["README.md"]);
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
  assert.match(prompt, new RegExp("Contract: " + contractSha));
  // A path named in the work order is context for the writer, not a file Bridge injects.
  assert.doesNotMatch(prompt, /=== package\.json \([0-9a-f]{12}\) ===/);
  assert.equal((await readJson(path.join(paths.runsDir, plan.proposed_run_id + ".json"))).status, "pass");
});

test("S7 / S5 live: work-start prints three plain lines, writes the result beside the work order, and the fake notification is captured", async (t) => {
  const { root, bridge, paths } = await install(t);
  const { plan, planArg } = await planFakeWork(root, bridge);
  const notifyFile = path.join(root, ".review-bridge", "review-queue", "notifications.jsonl");
  const started = bridge(["work-start", "--plan", planArg, "--approve", plan.plan_sha256, "--fake-cli"], { FAKE_NOTIFY_FILE: notifyFile });
  assert.equal(started.status, 0, started.stderr + started.stdout);
  const lines = started.stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, 3, started.stdout);
  assert.doesNotMatch(started.stdout, /^\s*[{[]/);
  assert.match(lines[0], /^已交付：現有測試通過，reviewer 通過$/);
  assert.match(lines[1], /^結果檔：.*stop\.result\.md$/);
  assert.match(lines[2], /^token：writer \d+，reviewer \d+$/);
  const latest = await fsp.readFile(path.join(root, ".review-bridge", "work-packages", "stop.result.md"), "utf8");
  assert.match(latest, /^<!-- rb:latest run=\S+ closed_at=\S+ -->\n這是 run /);
  assert.match(latest, /\n# 已交付\n/);
  assert.match(latest, /現有測試通過：npm test/);
  assert.doesNotMatch(latest, /功能驗過|全部驗過/);
  for (const heading of ["## 為什麼", "## 下一步", "## 改了哪些檔", "## token"]) assert.ok(latest.includes(heading), heading);
  assert.match(latest, /\| writer \| 1 \| /);
  const notices = (await fsp.readFile(notifyFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].title, "已交付");
  assert.match(notices[0].message, /^\.review-bridge\/work-packages\/stop\.md：現有測試通過，reviewer 通過$/); // the work-order file, then the one line
  const events = await readIoEvents(paths, plan.proposed_run_id);
  assert.equal(events.find((event) => event.event === "notified").ok, true);
  assert.equal(events.find((event) => event.event === "notified").sent, true);
  // --json keeps the machine output.
  const { plan: plan2, planArg: planArg2 } = await planFakeWork(root, bridge, "stop-json");
  const json = bridge(["work-start", "--plan", planArg2, "--approve", plan2.plan_sha256, "--fake-cli", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).latest_state.status, "pass");
});

test("S7b a failing notification never touches the result or the exit code", async (t) => {
  const { root, bridge, paths } = await install(t);
  const { plan, planArg } = await planFakeWork(root, bridge, "stop-notify");
  const started = bridge(["work-start", "--plan", planArg, "--approve", plan.plan_sha256, "--fake-cli"], { FAKE_NOTIFY_FAIL: "1" });
  assert.equal(started.status, 0, started.stderr + started.stdout);
  assert.ok(await fsp.stat(path.join(root, ".review-bridge", "work-packages", "stop-notify.result.md")));
  const notified = (await readIoEvents(paths, plan.proposed_run_id)).find((event) => event.event === "notified");
  assert.equal(notified.ok, false);
  assert.match(notified.error, /fake notification failure/);
});

test("S4b the rebuild commands in a needs-fix result run as written in sh and in PowerShell and build a new plan", async (t) => {
  const { root, bridge, paths } = await install(t);
  const breakpoint = "it's \"quoted\" $x `y` 中文 done";
  const order = path.join(root, ".review-bridge", "work-packages", "quote.md");
  await fsp.copyFile(path.join(root, ".review-bridge", "work-packages", "TEMPLATE.md"), order);
  await fsp.appendFile(order, "- package.json\n");
  const planned = bridge(["work-plan", "--task-file", ".review-bridge/work-packages/quote.md", "--owner", "Fortes O'Neil", "--work-package", "quote-1",
    "--breakpoint", breakpoint, "--change-types", "code", "--allow-paths", "package.json", "--max-claude-calls", "1", "--max-claude-minutes", "2",
    "--out", ".review-bridge/review-queue/quote-1.plan.json"]);
  assert.equal(planned.status, 0, planned.stderr);
  const plan = await readJson(path.join(root, ".review-bridge", "review-queue", "quote-1.plan.json"));
  assert.equal(plan.breakpoint, breakpoint);
  const started = bridge(["work-start", "--plan", ".review-bridge/review-queue/quote-1.plan.json", "--approve", plan.plan_sha256, "--fake-cli"], { FAKE_GATE_EXIT: "2" });
  assert.equal(started.status, 76, started.stderr + started.stdout);
  assert.match(started.stdout, /^需修正：現有測試沒過/m);
  const result = await fsp.readFile(path.join(root, ".review-bridge", "work-packages", "quote.result.md"), "utf8");
  assert.match(result, /重新 work-plan 建新 plan/);
  const sh = /sh：\n\n```\n(.+)\n```/.exec(result)?.[1];
  const ps = /PowerShell：\n\n```\n(.+)\n```/.exec(result)?.[1];
  assert.ok(sh && ps, result);
  assert.match(sh, /--out '\.review-bridge\/review-queue\/quote-1-2\.plan\.json'/);
  // Both lines were generated together, so both name the same --out; each shell must create it on its own.
  const out = path.join(root, ".review-bridge", "review-queue", "quote-1-2.plan.json");
  const shells = [
    { name: "sh", exe: "sh", args: ["-c", sh] },
    { name: "powershell", exe: "powershell.exe", args: ["-NoProfile", "-Command", ps] },
  ];
  // One subtest per shell: a missing shell shows up as a skip in the report, never as a pass.
  for (const shell of shells) {
    const probe = spawnSync(shell.exe, shell.name === "sh" ? ["-c", "exit 0"] : ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8", windowsHide: true });
    await t.test(shell.name, { skip: probe.error ? shell.name + " is not available here" : false }, async () => {
      await fsp.rm(out, { force: true });
      const run = spawnSync(shell.exe, shell.args, { cwd: root, encoding: "utf8", windowsHide: true, env: process.env });
      assert.equal(run.status, 0, shell.name + "\n" + run.stdout + run.stderr);
      assert.match(run.stdout, /驗收：會跑 npm test（profile 核准）/);
      const rebuilt = await readJson(out);
      assert.equal(rebuilt.task_file, plan.task_file);
      assert.equal(rebuilt.owner, "Fortes O'Neil");
      assert.equal(rebuilt.breakpoint, breakpoint);
      assert.deepEqual(rebuilt.scope.change_types, plan.scope.change_types);
      // Codex 2026-10-14: the explicit scope survives the rebuild instead of widening.
      assert.equal(rebuilt.scope.source, "explicit");
      assert.deepEqual(rebuilt.scope.allowed_paths, ["package.json"]);
      assert.deepEqual(rebuilt.budget, plan.budget);
    });
  }
  // A fake run raises no desktop notification; the event says so instead of claiming one was sent.
  const notified = (await readIoEvents(paths, plan.proposed_run_id)).filter((event) => event.event === "notified");
  assert.equal(notified.length, 1);
  assert.equal(notified[0].sent, false);
  assert.equal(notified[0].reason, "fake_cli");
});

test("S1e an external stop before the writer enqueued still lists the files changed so far", async (t) => {
  const { root, bootstrap, bridge, paths } = await install(t);
  const { plan, planArg } = await planFakeWork(root, bridge, "stop-early");
  const runId = plan.proposed_run_id;
  const child = spawn(process.execPath, [bootstrap, "work-start", "--plan", planArg, "--approve", plan.plan_sha256, "--fake-cli"], {
    cwd: root, windowsHide: true, env: { ...process.env, FAKE_CLAUDE_SLEEP_MS: "30000" }, stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = new Promise((resolve) => child.once("close", (code) => resolve(code)));
  const processFile = path.join(paths.runLocksDir, runId + ".process.json");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !(await readJson(processFile).catch(() => null))?.pid) await new Promise((resolve) => setTimeout(resolve, 100));
  await fsp.writeFile(path.join(root, "package.json"), (await fsp.readFile(path.join(root, "package.json"), "utf8")) + "\n");
  const stopped = bridge(["stop", runId]);
  assert.equal(stopped.status, 0, stopped.stderr);
  await exit;
  const run = await readJson(path.join(paths.runsDir, runId + ".json"));
  assert.equal(run.status, "stopped");
  assert.equal(run.outcome, "stopped");
  const result = await fsp.readFile(run.result_path, "utf8");
  assert.match(result, /^# 已停止/m);
  assert.match(result, /- package\.json（修改）/);
  const delivered = (await fsp.readFile(path.join(paths.eventsDir, runId + ".jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.type === "run_delivered");
  assert.equal(delivered.length, 1);
});

test("S1c the prune command delivers a run whose delivery was lost, then folds it with its result", async (t) => {
  const { root, bridge, paths } = await install(t);
  const { plan, planArg } = await planFakeWork(root, bridge, "stop-lost");
  const runId = plan.proposed_run_id;
  const started = bridge(["work-start", "--plan", planArg, "--approve", plan.plan_sha256, "--fake-cli", "--json"]);
  assert.equal(started.status, 0, started.stderr);
  // Simulate a crash before delivery: drop the run_delivered event, roll the projection back, remove the files.
  const eventsFile = path.join(paths.eventsDir, runId + ".jsonl");
  const kept = (await fsp.readFile(eventsFile, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.type !== "run_delivered");
  await fsp.writeFile(eventsFile, kept.map((event) => JSON.stringify(event)).join("\n") + "\n");
  await fsp.writeFile(path.join(paths.runsDir, runId + ".json"), JSON.stringify(kept.at(-1).projection));
  await fsp.rm(path.join(paths.queueRoot, runId + ".result.md"), { force: true });
  await fsp.rm(path.join(root, ".review-bridge", "work-packages", "stop-lost.result.md"), { force: true });
  const pruned = bridge(["prune"]);
  assert.equal(pruned.status, 0, pruned.stderr + pruned.stdout);
  const run = JSON.parse(await fsp.readFile(path.join(paths.runsDir, runId + ".json"), "utf8"));
  assert.equal(run.outcome, "delivered");
  assert.ok(run.archived_at);
  assert.match(await fsp.readFile(path.join(root, ".review-bridge", "work-packages", "stop-lost.result.md"), "utf8"), /\n# 已交付\n/);
  const day = (await fsp.readFile(run.archive_file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(day.some((line) => line.type === "artifact" && line.kind === "result" && line.run_id === runId));
});
