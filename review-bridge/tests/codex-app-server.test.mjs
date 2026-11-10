// Keeps the person's database out of these tests (see the fixture).
import "./fixtures/isolatedDataHome.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createThreadUsageTracker,
  runCodexAppServerTurn,
  writerUsageFromThreads,
} from "../service/agentCli/codexAppServer.mjs";
import { isPidAlive } from "../service/agentCli/process.mjs";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fakeServer = path.join(fixtures, "fake-codex-app-server.mjs");

// Recorded with codex-cli 0.162.0-alpha.17.2 on 2026-10-17; ids are synthetic, token counts real.
function load(name) {
  const [header, ...events] = fs.readFileSync(path.join(fixtures, name), "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  return { root: header.root_thread_id, events };
}

function fake(fixture, mode, record = os.devNull) {
  return { command: process.execPath, args: [fakeServer, path.join(fixtures, fixture), mode, record] };
}

async function recordFile(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "rb-app-server-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return path.join(dir, "interrupts.jsonl");
}

const interruptedTurns = (record) => (fs.existsSync(record) ? fs.readFileSync(record, "utf8") : "")
  .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line).turnId).sort();

test("nested sub-agents: every thread's latest cumulative total is added once", () => {
  const { root, events } = load("codex-app-server-nested.jsonl");
  const tracker = createThreadUsageTracker(root);
  for (const event of events) tracker.observe(event);
  const summary = tracker.summary();
  // root → a → a/b, linked by subAgentActivity, not by thread/started (none is sent for sub-agents).
  const byId = new Map(summary.threads.map((thread) => [thread.id, thread]));
  assert.deepEqual([...byId.keys()].sort(), ["thread-a", "thread-a-b", "thread-root"]);
  assert.equal(byId.get("thread-root").parent, null);
  assert.equal(byId.get("thread-a").parent, "thread-root");
  assert.equal(byId.get("thread-a-b").parent, "thread-a");
  assert.deepEqual([...byId.values()].map((thread) => thread.total.totalTokens).sort((a, b) => a - b), [19678, 51866, 59349]);
  assert.equal(summary.total_tokens, 130893);
  assert.equal(summary.complete, true);
  assert.equal(tracker.finalMessage(), "DONE");
  assert.deepEqual(tracker.activeTurns(), []);
  const usage = writerUsageFromThreads(summary, { call: 1, durationMs: 1 });
  assert.equal(usage.partial, undefined);
  assert.equal(usage.threads, 3);
  // Adding every update instead of the latest per thread would count a thread more than once.
  const everyUpdate = events.filter((event) => event.method === "thread/tokenUsage/updated").reduce((total, event) => total + event.params.tokenUsage.total.totalTokens, 0);
  assert.notEqual(everyUpdate, summary.total_tokens);
});

test("a total reported while a turn still runs is never complete, at any point of the recording", () => {
  const { root, events } = load("codex-app-server-nested.jsonl");
  const tracker = createThreadUsageTracker(root);
  let checked = 0;
  for (const event of events) {
    tracker.observe(event);
    const summary = tracker.summary();
    if (tracker.activeTurns().length) {
      assert.equal(summary.complete, false, "complete while " + tracker.activeTurns().length + " turn(s) run, after " + event.method);
      assert.equal(writerUsageFromThreads(summary, { call: 1, durationMs: 1 }).partial, true);
      checked += 1;
    }
  }
  assert.ok(checked > 10);
});

test("interrupted root: the running sub-agent has no usage yet, so the record is partial", () => {
  const { root, events } = load("codex-app-server-interrupt.jsonl");
  const tracker = createThreadUsageTracker(root);
  for (const event of events) tracker.observe(event);
  const summary = tracker.summary();
  assert.equal(summary.threads.length, 2);
  assert.equal(summary.complete, false);
  assert.deepEqual(summary.missing, ["thread-sleep_task"]);
  assert.deepEqual(summary.running, ["thread-sleep_task"]);
  // Interrupting the root left the sub-agent's turn running.
  assert.deepEqual(tracker.activeTurns(), [{ threadId: "thread-sleep_task", turnId: "turn-sleep_task" }]);
  const usage = writerUsageFromThreads(summary, { call: 2, durationMs: 1 });
  assert.equal(usage.partial, true);
  assert.equal(usage.parse_error, true);
  assert.deepEqual(usage.missing, ["thread:thread-sleep_task", "running:thread-sleep_task", "interrupted:thread-root"]);
});

test("the server's stderr is always read: a flood neither stalls it nor is lost", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "rb-app-server-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  const stderrPath = path.join(dir, "stderr.log");
  const bytes = 1024 * 1024;
  const flooding = (file) => ({ command: process.execPath, args: ["-e", [
    "process.stderr.write('x'.repeat(" + bytes + "), () => {",
    "  const rl = require('node:readline').createInterface({ input: process.stdin });",
    "  const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "  rl.on('line', (line) => {",
    "    const m = JSON.parse(line);",
    "    if (m.method === 'initialize') send({ id: m.id, result: {} });",
    "    if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 't' } } });",
    "    if (m.method === 'turn/start') {",
    "      send({ id: m.id, result: { turn: { id: 'u' } } });",
    "      send({ method: 'turn/started', params: { threadId: 't', turn: { id: 'u' } } });",
    "      send({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'u', status: 'completed' } } });",
    "    }",
    "  });",
    "});",
    "setInterval(() => {}, 1000);",
  ].join("\n")] });
  const written = await runCodexAppServerTurn({ invocation: flooding(), cwd: os.tmpdir(), prompt: "x", timeoutMs: 20_000, stderrPath });
  assert.equal(written.status, "completed");
  assert.equal((await fsp.stat(stderrPath)).size, bytes, "all of it reached the file, and the file is closed");
  const unlogged = await runCodexAppServerTurn({ invocation: flooding(), cwd: os.tmpdir(), prompt: "x", timeoutMs: 20_000 });
  assert.equal(unlogged.status, "completed", "without a file it is read and dropped");
});

test("what the server says went wrong comes back for the caller to classify", async () => {
  const failing = { command: process.execPath, args: ["-e", [
    "const rl = require('node:readline').createInterface({ input: process.stdin });",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "rl.on('line', (line) => {",
    "  const m = JSON.parse(line);",
    "  if (m.method === 'initialize') send({ id: m.id, result: {} });",
    "  if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 't' } } });",
    "  if (m.method === 'turn/start') {",
    "    send({ id: m.id, result: { turn: { id: 'u' } } });",
    "    send({ method: 'turn/started', params: { threadId: 't', turn: { id: 'u' } } });",
    "    send({ method: 'error', params: { threadId: 't', turnId: 'u', willRetry: false, error: { message: 'usage limit reached' } } });",
    "    send({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'u', status: 'failed', error: { message: 'usage limit reached' } } } });",
    "  }",
    "});",
    "setInterval(() => {}, 1000);",
  ].join("\n")] };
  const result = await runCodexAppServerTurn({ invocation: failing, cwd: os.tmpdir(), prompt: "x", timeoutMs: 20_000 });
  assert.equal(result.status, "failed");
  assert.deepEqual(result.errors, ["usage limit reached"], "said twice, kept once");
  assert.equal(result.errorCode, null, "this error names no code");
});

test("the server's codexErrorInfo comes back as the error's code; an error it will retry is not an error yet", async () => {
  const failing = { command: process.execPath, args: ["-e", [
    "const rl = require('node:readline').createInterface({ input: process.stdin });",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "rl.on('line', (line) => {",
    "  const m = JSON.parse(line);",
    "  if (m.method === 'initialize') send({ id: m.id, result: {} });",
    "  if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 't' } } });",
    "  if (m.method === 'turn/start') {",
    "    send({ id: m.id, result: { turn: { id: 'u' } } });",
    "    send({ method: 'turn/started', params: { threadId: 't', turn: { id: 'u' } } });",
    "    send({ method: 'error', params: { threadId: 't', turnId: 'u', willRetry: true, error: { message: 'Reconnecting... 1/5', codexErrorInfo: 'unauthorized' } } });",
    "    send({ method: 'error', params: { threadId: 't', turnId: 'u', willRetry: false, error: { message: 'stream broke', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } } } } });",
    "    send({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'u', status: 'failed', error: { message: 'out of usage', codexErrorInfo: 'usageLimitExceeded' } } } });",
    "  }",
    "});",
    "setInterval(() => {}, 1000);",
  ].join("\n")] };
  const result = await runCodexAppServerTurn({ invocation: failing, cwd: os.tmpdir(), prompt: "x", timeoutMs: 20_000 });
  assert.equal(result.status, "failed");
  assert.deepEqual(result.errors, ["stream broke", "out of usage"]);
  assert.equal(result.errorCode, "usageLimitExceeded");
});

test("a completed run returns once every thread has ended, with all usage, and stops the server", async () => {
  const result = await runCodexAppServerTurn({ invocation: fake("codex-app-server-nested.jsonl", "replay"), cwd: os.tmpdir(), prompt: "nested", timeoutMs: 20_000 });
  assert.equal(result.status, "completed");
  assert.equal(result.finalMessage, "DONE");
  assert.equal(result.summary.total_tokens, 130893);
  assert.equal(result.summary.complete, true);
  assert.equal(isPidAlive(result.pid), false);
});

test("a root that completed while a sub-agent still runs does not end the call; the sub-agent is interrupted at the timeout", async (t) => {
  const record = await recordFile(t);
  const result = await runCodexAppServerTurn({ invocation: fake("codex-app-server-interrupt.jsonl", "replay+root=completed", record), cwd: os.tmpdir(), prompt: "x", timeoutMs: 1_500 });
  assert.equal(result.status, "timed_out");
  assert.deepEqual(interruptedTurns(record), ["turn-sleep_task"]);
  assert.equal(result.summary.complete, false);
  assert.equal(isPidAlive(result.pid), false);
});

test("an interrupted root is reported as interrupted, never completed, and its running sub-agent is interrupted", async (t) => {
  const record = await recordFile(t);
  const started = Date.now();
  const result = await runCodexAppServerTurn({ invocation: fake("codex-app-server-interrupt.jsonl", "replay", record), cwd: os.tmpdir(), prompt: "x", timeoutMs: 20_000 });
  assert.equal(result.status, "interrupted");
  assert.ok(Date.now() - started < 10_000, "ended at the root's end, not at the timeout");
  assert.deepEqual(interruptedTurns(record), ["turn-sleep_task"]);
  assert.equal(result.summary.complete, false);
  assert.equal(isPidAlive(result.pid), false);
});

test("a failed root is reported as failed even when every sub-agent completed", async () => {
  const result = await runCodexAppServerTurn({ invocation: fake("codex-app-server-nested.jsonl", "replay+root=failed"), cwd: os.tmpdir(), prompt: "x", timeoutMs: 20_000 });
  assert.equal(result.status, "failed");
  assert.equal(result.summary.complete, false);
  assert.deepEqual(result.summary.ended_early, [{ id: "thread-root", status: "failed" }]);
  assert.equal(isPidAlive(result.pid), false);
});

test("usage of an interrupted or failed turn is partial even when every thread reported a total", async () => {
  // The nested recording with only the root's end changed: every thread has a total, all turns ended.
  for (const status of ["interrupted", "failed"]) {
    const { root, events } = load("codex-app-server-nested.jsonl");
    const tracker = createThreadUsageTracker(root);
    for (const event of events) {
      const endsRoot = event.method === "turn/completed" && event.params.threadId === root;
      tracker.observe(endsRoot ? { ...event, params: { ...event.params, turn: { ...event.params.turn, status } } } : event);
    }
    const summary = tracker.summary();
    assert.deepEqual(summary.missing, []);
    assert.deepEqual(summary.running, []);
    assert.equal(summary.complete, false, status);
    const usage = writerUsageFromThreads(summary, { call: 1, durationMs: 1 });
    assert.equal(usage.partial, true, status);
    assert.deepEqual(usage.missing, [status + ":thread-root"]);
  }
  // Through the server: the call is interrupted and its usage is partial, not complete.
  const result = await runCodexAppServerTurn({ invocation: fake("codex-app-server-nested.jsonl", "replay+root=interrupted"), cwd: os.tmpdir(), prompt: "x", timeoutMs: 20_000 });
  assert.equal(result.status, "interrupted");
  assert.equal(result.summary.complete, false);
  assert.equal(writerUsageFromThreads(result.summary, { call: 1, durationMs: 1 }).partial, true);
});

test("a sub-agent announced but not yet started is not settled: the call is not completed", async (t) => {
  // Announced by subAgentActivity, no turn/started yet, then the root is interrupted.
  const { root, events } = load("codex-app-server-interrupt.jsonl");
  const tracker = createThreadUsageTracker(root);
  for (const event of events.filter((e) => !(e.method === "turn/started" && e.params.threadId !== root))) tracker.observe(event);
  assert.equal(tracker.rootStatus(), "interrupted");
  assert.equal(tracker.allSettled(), false);
  assert.deepEqual(tracker.activeTurns(), []);
  assert.deepEqual(tracker.summary().running, ["thread-sleep_task"]);
  assert.equal(tracker.summary().complete, false);
  // The same with a completed root: the run still waits for the announced sub-agent.
  const record = await recordFile(t);
  const result = await runCodexAppServerTurn({ invocation: fake("codex-app-server-interrupt.jsonl", "replay+root=completed+no-child-turn", record), cwd: os.tmpdir(), prompt: "x", timeoutMs: 1_500 });
  assert.equal(result.status, "timed_out");
  assert.equal(result.summary.complete, false);
  assert.deepEqual(result.summary.running, ["thread-sleep_task"]);
  assert.equal(isPidAlive(result.pid), false);
});

test("onSpawn runs under the timeout: a hung pid record is cut off and the server is stopped", async () => {
  const result = await runCodexAppServerTurn({
    invocation: fake("codex-app-server-nested.jsonl", "replay"), cwd: os.tmpdir(), prompt: "x", timeoutMs: 1_000,
    onSpawn: () => new Promise(() => {}),
  });
  assert.equal(result.status, "timed_out");
  assert.equal(isPidAlive(result.pid), false);
});

test("onSpawn throwing is a failed call and the started server is stopped", async () => {
  const result = await runCodexAppServerTurn({
    invocation: fake("codex-app-server-nested.jsonl", "replay"), cwd: os.tmpdir(), prompt: "x", timeoutMs: 5_000,
    onSpawn: () => { throw new Error("pid record failed"); },
  });
  assert.equal(result.status, "failed");
  assert.match(result.error.message, /pid record failed/);
  assert.equal(isPidAlive(result.pid), false);
});

test("a timed-out run interrupts the root and every running sub-agent turn, then ends the server", async (t) => {
  const record = await recordFile(t);
  const result = await runCodexAppServerTurn({ invocation: fake("codex-app-server-interrupt.jsonl", "hang", record), cwd: os.tmpdir(), prompt: "x", timeoutMs: 1_500 });
  assert.equal(result.status, "timed_out");
  assert.deepEqual(interruptedTurns(record), ["turn-root", "turn-sleep_task"]);
  assert.equal(result.summary.complete, false);
  assert.equal(result.tree_kill.killed, true);
  assert.equal(isPidAlive(result.pid), false);
});

test("interrupts go out together: unanswered ones cost one grace period, not one per turn", async (t) => {
  const record = await recordFile(t);
  const started = Date.now();
  const result = await runCodexAppServerTurn({ invocation: fake("codex-app-server-interrupt.jsonl", "deaf", record), cwd: os.tmpdir(), prompt: "x", timeoutMs: 1_000 });
  const elapsed = Date.now() - started;
  assert.equal(result.status, "timed_out");
  assert.deepEqual(interruptedTurns(record), ["turn-root", "turn-sleep_task"]);
  // timeout 1 s + one 2 s grace + the kill; two sequential graces would pass 5 s.
  assert.ok(elapsed < 4_500, "took " + elapsed + " ms");
  assert.equal(isPidAlive(result.pid), false);
});

test("the timeout also covers startup: a server that never answers initialize is stopped", async () => {
  const started = Date.now();
  const result = await runCodexAppServerTurn({ invocation: fake("codex-app-server-nested.jsonl", "stall-init"), cwd: os.tmpdir(), prompt: "x", timeoutMs: 1_000 });
  assert.equal(result.status, "timed_out");
  assert.equal(result.summary.complete, false);
  assert.ok(Date.now() - started < 4_500);
  assert.equal(isPidAlive(result.pid), false);
});

test("an abort before the server answers ends the call as interrupted", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const result = await runCodexAppServerTurn({ invocation: fake("codex-app-server-nested.jsonl", "stall-init"), cwd: os.tmpdir(), prompt: "x", signal: controller.signal });
  assert.equal(result.status, "interrupted");
  assert.equal(isPidAlive(result.pid), false);
});

test("a server that cannot start is a failed call, not a hang", async () => {
  const result = await runCodexAppServerTurn({ invocation: { command: path.join(os.tmpdir(), "no-such-codex-binary-for-review-bridge"), args: [] }, cwd: os.tmpdir(), prompt: "x", timeoutMs: 5_000 });
  assert.equal(result.status, "failed");
  assert.ok(result.error);
  assert.equal(result.summary.complete, false);
});
