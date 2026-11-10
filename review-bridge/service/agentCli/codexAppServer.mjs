// Codex as a writer through `codex app-server`, which OpenAI marks experimental. What this module
// relies on was measured with codex-cli 0.162.0-alpha.17.2 on 2026-10-17:
// - a sub-agent's thread sends no thread/started; its parent thread sends an item of type
//   subAgentActivity naming the child (agentThreadId, kind started / completed), and every turn of
//   one run carries the root turn's id as rootTurnId;
// - thread/tokenUsage/updated carries each thread's cumulative total, sent before that thread's
//   turn/completed; the latest one per thread is kept and the threads are added once (never every
//   update, never turn/completed again);
// - turn/interrupt on the root turn leaves sub-agent turns running, so every active turn is
//   interrupted and the caller then terminates the app-server process tree.
// `codex exec --ephemeral` cannot start sub-agents (no rollout), and `codex exec --json` shows
// neither the spawn nor the sub-agents' usage; that is why the writer does not use exec.
import { spawn } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";

import { killProcessTree } from "./process.mjs";

export const CODEX_APP_SERVER_VERIFIED_VERSION = "0.162.0-alpha.17.2";

const BREAKDOWN_FIELDS = Object.freeze(["inputTokens", "cachedInputTokens", "outputTokens"]);
const INTERRUPT_GRACE_MS = 2_000;

// Follows one run (one root thread) through the app-server notifications.
export function createThreadUsageTracker(rootThreadId) {
  const threads = new Map();
  const ensure = (id, parent = null) => {
    if (!threads.has(id)) threads.set(id, { parent, turnId: null, turnStatus: null, total: null });
    const thread = threads.get(id);
    if (parent && !thread.parent) thread.parent = parent;
    return thread;
  };
  ensure(rootThreadId);
  let rootTurnId = null;
  let finalMessage = null;

  const subAgentActivity = (params) => {
    const item = params.item || {};
    if (item.type !== "subAgentActivity" || !item.agentThreadId) return;
    ensure(item.agentThreadId, params.threadId);
  };
  const handlers = {
    "turn/started": (params) => {
      const turn = params.turn || {};
      if (params.threadId === rootThreadId) rootTurnId = turn.id;
      // A turn of another run (a different root turn) is not this run's.
      if (turn.rootTurnId && rootTurnId && turn.rootTurnId !== rootTurnId) return;
      Object.assign(ensure(params.threadId), { turnId: turn.id, turnStatus: null });
    },
    "turn/completed": (params) => {
      if (threads.has(params.threadId)) threads.get(params.threadId).turnStatus = params.turn?.status || "completed";
    },
    "item/started": subAgentActivity,
    "item/completed": (params) => {
      subAgentActivity(params);
      const item = params.item || {};
      if (params.threadId === rootThreadId && item.type === "agentMessage") finalMessage = item.text ?? finalMessage;
    },
    "thread/tokenUsage/updated": (params) => {
      ensure(params.threadId).total = params.tokenUsage?.total || null;
    },
  };

  // A thread is settled only once its turn has ended (completed, interrupted or failed). A sub-agent
  // announced by subAgentActivity whose turn has not started yet is not settled.
  const settled = (thread) => thread.turnStatus !== null && thread.turnStatus !== "inProgress";

  return {
    observe(message) {
      handlers[message?.method]?.(message.params || {});
    },
    finalMessage: () => finalMessage,
    // null while the root turn runs; then "completed", "interrupted" or "failed".
    rootStatus: () => (settled(threads.get(rootThreadId)) ? threads.get(rootThreadId).turnStatus : null),
    allSettled: () => [...threads.values()].every(settled),
    // Turns that have started and not ended, root first; these are what an interrupt can reach.
    activeTurns() {
      return [...threads].filter(([, t]) => t.turnId && !settled(t)).map(([threadId, t]) => ({ threadId, turnId: t.turnId }));
    },
    // Complete only when every thread's turn completed and every thread reported its total. A total
    // seen while a turn still runs, or one left by a turn that was interrupted or failed (its last
    // request may never have been reported), is a lower bound, not the call's usage.
    summary() {
      const list = [...threads].map(([id, t]) => ({ id, parent: t.parent, turn_status: t.turnStatus, total: t.total }));
      const noUsage = list.filter((t) => !t.total || BREAKDOWN_FIELDS.some((field) => !Number.isFinite(t.total[field]))).map((t) => t.id);
      const running = [...threads].filter(([, t]) => !settled(t)).map(([id]) => id);
      const endedEarly = [...threads].filter(([, t]) => settled(t) && t.turnStatus !== "completed").map(([id, t]) => ({ id, status: t.turnStatus }));
      const sum = (field) => list.reduce((total, t) => total + (Number.isFinite(t.total?.[field]) ? t.total[field] : 0), 0);
      // Same split as the reviewer's exec usage: Codex's input count includes cached reads and writes.
      const input = sum("inputTokens");
      const cached = sum("cachedInputTokens");
      const cacheWrite = sum("cacheWriteInputTokens");
      return {
        threads: list,
        tokens: { input: Math.max(0, input - cached - cacheWrite), cache_write: cacheWrite, cache_read: cached, output: sum("outputTokens") },
        total_tokens: sum("totalTokens"),
        complete: noUsage.length === 0 && running.length === 0 && endedEarly.length === 0,
        missing: noUsage,
        running,
        ended_early: endedEarly,
      };
    },
  };
}

// The usage record for one writer call: every thread of the run, or partial when a thread has not
// reported or has not finished.
export function writerUsageFromThreads(summary, { call, durationMs }) {
  return {
    event: "usage",
    role: "writer",
    provider: "codex",
    call,
    duration_ms: durationMs,
    tokens: { ...summary.tokens },
    threads: summary.threads.length,
    cost_usd: null,
    source: "app_server_thread_usage",
    ...(summary.complete ? {} : {
      partial: true,
      parse_error: true,
      missing: [
        ...summary.missing.map((id) => "thread:" + id),
        ...summary.running.map((id) => "running:" + id),
        ...summary.ended_early.map(({ id, status }) => status + ":" + id),
      ],
    }),
  };
}

// One writer call: start the app server, open a thread, run one turn, and follow every thread it
// starts until all of them have ended. The timeout and `signal` cover the whole call, startup
// included. On timeout, abort, a failed request or the server ending early, every active turn is
// interrupted at once and the process tree is terminated. `invocation` is the platform adapter's
// command for `codex app-server`.
export async function runCodexAppServerTurn({
  invocation, cwd, prompt, thread = {}, effort = null, outputSchema = null,
  timeoutMs = 0, signal = null, eventsPath = null, stderrPath = null, onSpawn = null,
}) {
  const server = spawn(invocation.command, invocation.args, {
    cwd, env: invocation.env || process.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const log = eventsPath ? fs.createWriteStream(eventsPath) : null;
  // stderr is always read: an unread pipe fills up and the server stalls on its next write.
  const stderrLog = stderrPath ? fs.createWriteStream(stderrPath) : null;
  if (stderrLog) {
    stderrLog.on("error", () => {});
    server.stderr.pipe(stderrLog);
  } else {
    server.stderr.resume();
  }
  // What the server said went wrong, in its own typed messages, for the caller to classify.
  const errors = [];
  // The last error's codexErrorInfo (app-server-protocol's TurnError, rust-v0.166.0) when it is a plain
  // word: "unauthorized", "usageLimitExceeded" and so on. Some carry an object, which nothing reads.
  let errorCode = null;
  const noteError = (error) => {
    const message = error?.message;
    if (typeof message === "string" && message && !errors.includes(message)) errors.push(message);
    if (typeof error?.codexErrorInfo === "string") errorCode = error.codexErrorInfo;
  };
  const pending = new Map();
  let nextId = 1;
  let tracker = null;
  let notifySettled = null;

  // Everything that can end the call early, armed before the first request.
  const timers = [];
  const ended = new Promise((resolve) => {
    server.once("error", (error) => resolve({ status: "failed", error }));
    server.once("exit", (code) => resolve({ status: "failed", error: new Error("codex app-server exited (" + code + ")") }));
  });
  const deadline = new Promise((resolve) => {
    if (timeoutMs > 0) timers.push(setTimeout(() => resolve({ status: "timed_out" }), timeoutMs));
  });
  const aborted = new Promise((resolve) => {
    if (!signal) return;
    if (signal.aborted) resolve({ status: "interrupted" });
    else signal.addEventListener("abort", () => resolve({ status: "interrupted" }), { once: true });
  });
  const interruption = Promise.race([ended, deadline, aborted]);

  const send = (message) => {
    try { server.stdin.write(JSON.stringify(message) + "\n"); } catch {}
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
  // A step either answers or loses to whatever ended the call.
  const step = (method, params) => Promise.race([
    request(method, params).then((value) => ({ status: "ok", value }), (error) => ({ status: "failed", error })),
    interruption,
  ]);

  readline.createInterface({ input: server.stdout }).on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    log?.write(line + "\n");
    if (message.id !== undefined && pending.has(message.id) && (message.result !== undefined || message.error)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
      else resolve(message.result);
      return;
    }
    // The writer runs with approvals off; any request the server makes is declined, never granted.
    if (message.id !== undefined && message.method) {
      send({ id: message.id, error: { code: -32000, message: "Review Bridge does not grant requests from the writer." } });
      return;
    }
    // willRetry: "the error is transient ... this will not interrupt a turn" (ErrorNotification).
    if (message.method === "error" && !message.params?.willRetry) noteError(message.params?.error);
    if (message.method === "turn/completed") noteError(message.params?.turn?.error);
    tracker?.observe(message);
    if (tracker) settle();
  });

  // The call ends successfully only when the root turn completed and every thread has ended. A
  // root that was interrupted or failed ends the call at once, through the stop path below.
  const settle = () => {
    const root = tracker.rootStatus();
    if (root && root !== "completed") notifySettled?.({ status: root === "interrupted" ? "interrupted" : "failed", error: new Error("root turn " + root) });
    else if (root === "completed" && tracker.allSettled()) notifySettled?.({ status: "completed" });
  };

  // The caller's pid record runs under the same timeout and abort as every other step.
  let outcome = { status: "ok" };
  if (onSpawn && Number.isInteger(server.pid)) {
    outcome = await Promise.race([
      Promise.resolve().then(() => onSpawn(server.pid)).then(() => ({ status: "ok" }), (error) => ({ status: "failed", error })),
      interruption,
    ]);
  }
  if (outcome.status === "ok") outcome = await step("initialize", { clientInfo: { name: "review-bridge", version: "rc3" }, capabilities: { experimentalApi: true } });
  if (outcome.status === "ok") {
    send({ method: "initialized" });
    outcome = await step("thread/start", { cwd, ...thread });
  }
  if (outcome.status === "ok") {
    tracker = createThreadUsageTracker(outcome.value.thread.id);
    outcome = await step("turn/start", {
      threadId: outcome.value.thread.id,
      input: [{ type: "text", text: prompt }],
      ...(effort ? { effort } : {}),
      ...(outputSchema ? { outputSchema } : {}),
    });
  }
  if (outcome.status === "ok") {
    // The root ending is not the end of the call: sub-agent turns may still run and spend tokens.
    const allSettled = new Promise((resolve) => { notifySettled = resolve; });
    settle();
    outcome = await Promise.race([allSettled, interruption]);
  }
  for (const timer of timers) clearTimeout(timer);

  let treeKill;
  if (outcome.status === "completed") {
    try { server.stdin.end(); } catch {}
    treeKill = await killProcessTree(server.pid);
  } else {
    // Every active turn at once, one short grace for all of them, then the whole tree.
    const interrupts = (tracker ? tracker.activeTurns() : []).map(({ threadId, turnId }) => request("turn/interrupt", { threadId, turnId }).catch(() => null));
    await Promise.race([Promise.all(interrupts), new Promise((resolve) => setTimeout(resolve, INTERRUPT_GRACE_MS))]);
    treeKill = await killProcessTree(server.pid);
  }
  // Both files are closed before the caller reads them. The pipe closes stderr's itself when the
  // server's stderr ends, which may already have happened; a process left holding that pipe is cut
  // off here, so nothing is written to a closed file.
  if (stderrLog) server.stderr.unpipe(stderrLog);
  const closed = (stream) => (stream && !stream.closed ? new Promise((resolve) => {
    stream.once("close", resolve);
    stream.end();
  }) : null);
  await Promise.all([closed(log), closed(stderrLog)]);
  const summary = tracker
    ? tracker.summary()
    : { threads: [], tokens: { input: 0, cache_write: 0, cache_read: 0, output: 0 }, total_tokens: 0, complete: false, missing: ["root"], running: [], ended_early: [] };
  return {
    status: outcome.status,
    error: outcome.error || null,
    errors,
    errorCode,
    finalMessage: tracker?.finalMessage() ?? null,
    summary,
    tree_kill: treeKill,
    pid: server.pid,
  };
}
