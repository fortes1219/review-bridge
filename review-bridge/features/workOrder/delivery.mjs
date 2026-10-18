// Delivery (T0-07): when a run reaches a terminal state, write one plain-language result
// file beside the work order, a per-run copy for the archive, one best-effort desktop
// notification, and three lines on stdout. Everything is composed from typed records; no
// model writes any of it.
import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  appendIoEvent,
  deliverRun,
  listJson,
  listRuns,
  loadControlView,
  readIoEvents,
  readJson,
  readRun,
  TERMINAL_RUN_STATUSES,
  tokenTotal,
} from "../../service/index.mjs";
import { createTranslator, resolveLocale } from "./i18n.mjs";
import { createWorkspaceDelta } from "./workspaceEvidence.mjs";

export const RESULT_MAX_BYTES = 64 * 1024;
export const RESULT_MAX_FINDINGS = 20;
export const RESULT_MAX_CHANGED = 200;
export const LOCK_RETRY_ATTEMPTS = 40;
export const LOCK_RETRY_DELAY_MS = 250;
export const LATE_DELIVERY_MS = 60_000;
export const OUTCOMES = Object.freeze(["delivered", "needs_fix", "needs_human", "token_limit", "quota", "stopped", "cancelled", "error"]);

// V1: the eight outcome codes, decided from the run record alone.
export function classifyOutcome(run) {
  switch (run?.status) {
    case "pass": return "delivered";
    case "call_budget_exhausted": return "needs_fix";
    case "hard_stop":
    case "needs_human":
    case "contract_unconfirmed": return "needs_human";
    case "token_limit":
    case "usage_unknown": return "token_limit";
    case "rate_limited": return "quota";
    case "stopped": return "stopped";
    case "cancelled": return "cancelled";
    default: return "error";
  }
}

// V2.4: one argument, quoted for the named shell by rule, never by hand.
export function shellQuote(value, shell) {
  const text = String(value ?? "");
  if (shell === "powershell") return "'" + text.replaceAll("'", "''") + "'";
  return "'" + text.replaceAll("'", "'\\''") + "'";
}

// Windows command-line quoting as the C runtime parses it: wrap in double quotes, write an
// embedded `"` as `\"`, and double the backslashes that sit before a quote or at the end.
// The PowerShell line is `node --% ...` so PowerShell passes this verbatim; Windows PowerShell
// 5.1 would otherwise drop embedded double quotes when calling a native program.
export function windowsArgQuote(value) {
  const text = String(value ?? "");
  if (text !== "" && !/[\s"]/.test(text)) return text;
  return '"' + text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1") + '"';
}

function posixRelative(from, to) {
  return path.relative(from, to).split(path.sep).join("/");
}

// V2.4: the work-plan line that rebuilds a plan from this run's own values.
export async function rebuildCommands({ paths, plan, workPackage }) {
  const taskFile = plan?.task_file || workPackage?.task_file || null;
  if (!taskFile) return null;
  const id = workPackage.work_package_id;
  let suffix = 2;
  let outName;
  for (;;) {
    outName = id + "-" + suffix + ".plan.json";
    const exists = await fsp.stat(path.join(paths.queueRoot, outName)).then(() => true, () => false);
    if (!exists) break;
    suffix += 1;
  }
  const outPath = posixRelative(paths.repoRoot, path.join(paths.queueRoot, outName));
  const bootstrap = posixRelative(paths.repoRoot, path.join(paths.bridgeRoot, "bootstrap.mjs"));
  const budget = workPackage.budget || {};
  const args = [
    "work-plan",
    "--task-file", taskFile,
    "--owner", plan?.owner ?? "",
    "--work-package", id,
    "--breakpoint", workPackage.breakpoint ?? "",
    "--change-types", (workPackage.scope?.change_types || []).join(","),
    // Codex 2026-10-14: a scope the human named explicitly must survive the rebuild; without it the
    // new plan would fall back to the references or the whole project.
    ...(workPackage.scope?.source === "explicit" ? ["--allow-paths", (workPackage.scope.allowed_paths || []).join(",")] : []),
    "--max-claude-calls", String(budget.max_claude_calls ?? ""),
    "--max-claude-minutes", String(budget.max_claude_minutes_per_call ?? ""),
    "--out", outPath,
    "--plain",
  ];
  const bare = (arg) => arg === "work-plan" || arg.startsWith("--");
  const sh = ["node", shellQuote(bootstrap, "sh"), ...args.map((arg) => (bare(arg) ? arg : shellQuote(arg, "sh")))].join(" ");
  const powershell = ["node", "--%", windowsArgQuote(bootstrap), ...args.map((arg) => (bare(arg) ? arg : windowsArgQuote(arg)))].join(" ");
  return { powershell, sh, out: outPath };
}

async function planForRun(paths, runId) {
  for (const file of await listJson(paths.queueRoot)) {
    if (!file.endsWith(".plan.json")) continue;
    const plan = await readJson(file).catch(() => null);
    if (plan?.proposed_run_id === runId) return plan;
  }
  return null;
}

function last(events, kind) {
  for (let index = events.length - 1; index >= 0; index -= 1) if (events[index].event === kind) return events[index];
  return null;
}

function lastLines(text, count) {
  return String(text || "").split(/\r?\n/).filter((line) => line.trim()).slice(-count);
}

function number(value) {
  return Number.isFinite(value) ? value : 0;
}

// V2.6: per-role sums straight from the usage events. A sum is shown only when every call of that
// role left a readable usage event; otherwise the row is unknown and says how many calls are
// missing (Codex 2026-10-14: a partial sum was presented as the whole). Calls are counted from
// the run's own records: one task.input per writer call, one review.input per review minus the
// reviews the controller decided itself (scope violations), which never called the reviewer.
export function tokenRows(events) {
  const count = (predicate) => events.filter(predicate).length;
  const expected = {
    writer: count((event) => event.event === "task.input"),
    reviewer: count((event) => event.event === "review.input") - count((event) => event.event === "review.result" && event.source === "controller"),
  };
  // Translating and checking the contract come before the writer's first call; each has a row only when it ran.
  for (const role of ["translator", "contract_checker"]) {
    const calls = count((event) => event.event === "usage" && event.role === role);
    if (calls) expected[role] = calls;
  }
  const rows = {};
  for (const role of Object.keys(expected)) {
    const usage = events.filter((event) => event.event === "usage" && event.role === role);
    const readable = usage.filter((event) => !event.parse_error);
    const calls = Math.max(expected[role], usage.length);
    const unreadable = (usage.length - readable.length) + Math.max(0, expected[role] - usage.length);
    if (unreadable > 0) { rows[role] = { calls, unreadable, complete: false }; continue; }
    const sum = (key) => readable.reduce((total, event) => total + number(event.tokens?.[key]), 0);
    const costs = readable.map((event) => event.cost_usd).filter((value) => Number.isFinite(value));
    rows[role] = {
      calls, unreadable: 0, complete: true,
      input: sum("input"), cache_read: sum("cache_read"), cache_write: sum("cache_write"), output: sum("output"),
      total: readable.reduce((total, event) => total + tokenTotal(event.tokens), 0),
      cost_usd: costs.length ? costs.reduce((total, value) => total + value, 0) : null,
    };
  }
  return rows;
}

function writerCalls(run, events) {
  const fromEvents = events.filter((event) => event.event === "task.input").length;
  return fromEvents || Number(run.last_state?.call || 0) || 0;
}

// V2.2–V2.6: the sections, as arrays of lines, from typed records only.
export function composeSections({ t, run, outcome, workPackage, plan, events, delta, limits = {}, deliveredAt = Date.now() }) {
  const name = workPackage?.task_file || workPackage?.work_package_id || run.work_package_id || run.run_id;
  const state = run.last_state || {};
  const calls = writerCalls(run, events);
  const gate = last(events, "gate_a_result");
  const review = last(events, "review.result");
  const writer = last(events, "writer.result");
  const stop = last(events, "stop");
  const failure = state.failure || null;

  const head = [];
  const subtitle = [];
  if (outcome === "needs_fix" && calls >= 2) subtitle.push(t("outcome.needs_fix.auto", { count: calls - 1 }));
  head.push("# " + t("outcome." + outcome) + (subtitle.length ? "（" + subtitle.join("；") + "）" : ""));
  head.push("");
  head.push(t("result.header", { name, run_id: run.run_id, ended_at: run.closed_at || run.updated_at || "", calls }));
  if (outcome === "delivered") {
    if (gate?.kind === "command") head.push(t("result.gate_a.passed", { command: gate.command }));
    else if (workPackage?.gate_a?.kind === "not_applicable" || gate?.kind === "not_applicable") head.push(t("result.gate_a.not_applicable"));
  }

  const why = [];
  let stderrTail = [];
  if (outcome === "delivered") {
    if (review?.verified?.length) { why.push(t("result.why.delivered.verified")); for (const item of review.verified) why.push("- " + item); }
    if (review?.not_run?.length) { why.push(t("result.why.delivered.not_run")); for (const item of review.not_run) why.push("- " + item); }
    if (!why.length) why.push(t("result.why.delivered.none"));
  } else if (outcome === "needs_fix") {
    if (gate?.kind === "command" && gate.passed === false && (!review || gate.sequence > review.sequence)) {
      why.push(t("result.why.gate_a_failed", { command: gate.command, exit_code: gate.exit_code, timed_out: gate.timed_out ? t("result.why.gate_a_failed.timed_out") : "" }));
      stderrTail = lastLines(gate.stderr_tail, 10);
      if (stderrTail.length) { why.push(t("result.why.stderr_tail")); why.push("```"); why.push(...stderrTail); why.push("```"); }
    } else if (review?.findings?.length) {
      why.push(t("result.why.findings"));
      for (const finding of review.findings) {
        why.push("- " + t("result.why.finding", { id: finding.id, severity: finding.severity, path: finding.path, line: finding.line, claim: finding.claim, fix: finding.fix }));
      }
    }
    why.push(t("result.why.budget", { max: workPackage?.budget?.max_claude_calls ?? run.budget?.max_claude_calls ?? "" }));
  } else if (outcome === "needs_human") {
    if (state.contract_questions?.length) {
      why.push(t("result.why.contract.questions"));
      for (const question of state.contract_questions) why.push("- " + question);
    }
    if (run.status === "contract_unconfirmed") {
      why.push(t("result.why.contract.unconfirmed"));
      for (const line of (state.contract_problems || []).slice(0, 10)) why.push("- " + line);
    }
    if (writer?.needs_human?.length) {
      why.push(t("result.why.needs_human.questions"));
      for (const item of writer.needs_human) why.push("- " + t("result.why.needs_human.question", { question: item.question, options: (item.options || []).join(" / ") }));
    }
    if (writer && writer.status && writer.status !== "done") why.push(t("result.why.needs_human.writer_status", { status: writer.status }));
    if (stop?.detail_ref?.startsWith("loop:")) why.push(t("result.why.needs_human.loop", { id: stop.detail_ref.slice(5) }));
    else if (stop?.detail_ref === "gate_a_loop") why.push(t("result.why.needs_human.gate_loop"));
    else if (state.hard_stop_reason || review?.hard_stop_reason) {
      const reason = state.hard_stop_reason || review.hard_stop_reason;
      why.push(t("result.why.needs_human.reviewer", { reason: t("result.why.hard_stop_reason." + reason) }));
    }
    if (review?.findings?.length) {
      why.push(t("result.why.findings"));
      for (const finding of review.findings) {
        why.push("- " + t("result.why.finding", { id: finding.id, severity: finding.severity, path: finding.path, line: finding.line, claim: finding.claim, fix: finding.fix }));
      }
    }
  } else if (outcome === "token_limit" && run.status === "usage_unknown") {
    why.push(t("result.why.usage_unknown", { role: t("result.tokens.role." + (state.token_limit_role || "writer")) }));
  } else if (outcome === "token_limit") {
    const role = state.token_limit_role || stop?.role || "writer";
    const which = state.token_limit === "per_run" ? "per_run" : "per_call";
    why.push(t("result.why.token_limit", {
      role: t("result.tokens.role." + role), which: t("result.why.token_limit." + which),
      limit: limits["max_tokens_" + which] ?? "", actual: which === "per_run" ? state.tokens_this_run : state.tokens_this_call,
    }));
  } else if (outcome === "quota") {
    const role = failure?.role || stop?.role || "writer";
    const provider = failure?.provider || stop?.provider || "";
    why.push(t("result.why.quota", { role: t("result.tokens.role." + role), provider }));
    if (failure?.reset_hint) why.push(t("result.why.quota.reset", { hint: failure.reset_hint }));
  } else if (outcome === "stopped") {
    if (stop?.role) why.push(t("result.why.stopped", { call: state.call ?? calls, role: t.has("result.tokens.role." + stop.role) ? t("result.tokens.role." + stop.role) : stop.role }));
    else why.push(t("result.why.stopped.unknown"));
  } else if (outcome === "cancelled") {
    why.push(t("result.why.cancelled"));
  } else {
    why.push(t("result.why.error", { reason: run.closed_reason || run.status }));
    for (const file of [state.stderr_path, state.claude_stderr_path, state.review_error_path, failure?.record_path].filter(Boolean)) why.push(t("result.why.error.log", { path: file }));
    if (state.error) why.push(String(state.error));
    if (Array.isArray(state.errors)) for (const line of state.errors.slice(0, 10)) why.push("- " + line);
    if (state.contract_problems?.length) {
      why.push(t("result.why.contract.problems"));
      for (const line of state.contract_problems.slice(0, 10)) why.push("- " + line);
    }
  }

  const next = [];
  if (outcome === "delivered") next.push(t("result.next.delivered"));
  else if (outcome === "quota") next.push(t("result.next.quota", { provider: failure?.provider || "", hint: failure?.reset_hint ? t("result.next.quota.hint", { hint: failure.reset_hint }) : "" }));
  else if (outcome === "error") {
    const log = state.stderr_path || state.claude_stderr_path || failure?.record_path || null;
    next.push(log ? t("result.next.error", { path: log }) : t("result.next.error.nolog"));
  } else next.push(t("result.next." + outcome));
  if (outcome !== "delivered") next.push(t("result.next.plan_used"));

  // The changed list is computed at delivery time. A late delivery (prune after a crash, days on)
  // would otherwise present the owner's later edits as the run's work; it says so instead.
  const closedMs = Date.parse(run.closed_at || run.updated_at || "");
  const changedNote = Number.isFinite(closedMs) && deliveredAt - closedMs > LATE_DELIVERY_MS
    ? t("result.changed.late", { at: new Date(deliveredAt).toISOString(), ended_at: run.closed_at || run.updated_at })
    : null;
  const changed = [];
  const violations = [];
  for (const entry of delta?.changed_files || []) {
    const line = "- " + entry.path + "（" + t("result.change." + entry.change) + "）";
    if ((delta.scope_violations || []).includes(entry.path)) violations.push(line);
    else changed.push(line);
  }

  const rows = tokenRows(events);
  const tokens = [t("result.tokens.header"), "|---|---|---|---|---|---|---|---|"];
  for (const role of Object.keys(rows)) {
    const row = rows[role];
    const label = t("result.tokens.role." + role);
    if (!row.complete) {
      tokens.push("| " + label + " | " + t("result.tokens.calls_unreadable", { calls: row.calls, unreadable: row.unreadable }) + " | " + Array(6).fill(t("result.tokens.unknown")).join(" | ") + " |");
      continue;
    }
    tokens.push("| " + [label, row.calls, row.input, row.cache_read, row.cache_write, row.output, row.total, row.cost_usd === null ? "" : row.cost_usd.toFixed(4) + " " + t("result.tokens.cost_unit")].join(" | ") + " |");
  }

  const line = oneLine({ t, outcome, review, gate, workPackage, state, failure, stop, run });
  return { name, head, why, stderrTail, next, changed, changedNote, violations, tokens, line, calls };
}

// V3.1: the one sentence after the title.
function oneLine({ t, outcome, review, gate, workPackage, state, failure, stop, run }) {
  switch (outcome) {
    case "delivered": return gate?.kind === "command" ? t("line.delivered") : t("line.delivered.docs");
    case "needs_fix":
      return gate?.kind === "command" && gate.passed === false && (!review || gate.sequence > review.sequence)
        ? t("line.needs_fix.gate")
        : t("line.needs_fix.findings", { count: review?.findings?.length ?? 0 });
    case "needs_human": return t("line.needs_human");
    case "token_limit": return t("line.token_limit", { role: t("result.tokens.role." + (state.token_limit_role || stop?.role || "writer")) });
    case "quota": return t("line.quota", { role: t("result.tokens.role." + (failure?.role || "writer")), provider: failure?.provider || "" });
    case "stopped": return t("line.stopped");
    case "cancelled": return t("line.cancelled");
    default: return t("line.error", { reason: run.closed_reason || run.status });
  }
}

// V2.1b: render within 64 KB. Trim stderr, then findings, then the changed and out-of-scope
// lists; the last step keeps only the title, a few why lines, the next step and the tokens.
// Codex 2026-10-14: the out-of-scope list was never capped and the last step was never checked.
export const LATEST_MARK = /^<!-- rb:latest run=(\S+) closed_at=(\S+) -->/;

function clipLine(line, max) {
  return max === Infinity || line.length <= max ? line : line.slice(0, max - 1) + "…";
}

export function renderResult({ t, sections, commands, runId, latest, closedAt = "" }) {
  const build = ({ stderr, findings, changed, whyMax = Infinity, clip = Infinity, withCommands = true, trimmed = false }) => {
    let why = [...sections.why];
    if (!stderr && sections.stderrTail.length) {
      const start = why.indexOf("```");
      if (start >= 0) why.splice(start, sections.stderrTail.length + 2);
    }
    const findingLines = why.filter((line) => line.startsWith("- F"));
    if (findingLines.length > findings) {
      const keep = new Set(findingLines.slice(0, findings));
      const dropped = findingLines.length - findings;
      let inserted = false;
      for (let index = why.length - 1; index >= 0; index -= 1) {
        if (why[index].startsWith("- F") && !keep.has(why[index])) {
          why.splice(index, 1);
          if (!inserted) { why.splice(index, 0, t("result.why.findings.more", { count: dropped })); inserted = true; }
        }
      }
    }
    if (why.length > whyMax) why = why.slice(0, whyMax);
    why = why.map((line) => clipLine(line, clip));
    const changedLines = sections.changed.slice(0, changed).map((line) => clipLine(line, clip));
    const violationLines = sections.violations.slice(0, changed).map((line) => clipLine(line, clip));
    const lines = [
      ...(latest ? ["<!-- rb:latest run=" + runId + " closed_at=" + (closedAt || "unknown") + " -->", t("result.latest_of_run", { run_id: runId }), ""] : []),
      ...sections.head.map((line) => clipLine(line, clip)),
      "",
      "## " + t("result.section.why"),
      ...why,
      ...(trimmed ? [t("result.content_trimmed")] : []),
      "",
      "## " + t("result.section.next"),
      ...sections.next,
      ...(commands && withCommands ? ["", t("result.next.command.powershell"), "", "```", commands.powershell, "```", "", t("result.next.command.sh"), "", "```", commands.sh, "```"] : []),
      "",
      "## " + t("result.section.changed"),
      ...(sections.changedNote ? [sections.changedNote, ""] : []),
      ...(changedLines.length ? changedLines : sections.changed.length ? [] : [t("result.changed.none")]),
      ...(sections.changed.length > changed ? [t("result.changed.more", { count: sections.changed.length - changed })] : []),
      ...(sections.violations.length ? ["", "### " + t("result.section.violations"), ...violationLines,
        ...(sections.violations.length > changed ? [t("result.violations.more", { count: sections.violations.length - changed })] : [])] : []),
      "",
      "## " + t("result.section.tokens"),
      ...sections.tokens,
      "",
    ];
    return lines.join("\n");
  };
  const steps = [
    { stderr: true, findings: Infinity, changed: Infinity },
    { stderr: false, findings: Infinity, changed: Infinity },
    { stderr: false, findings: RESULT_MAX_FINDINGS, changed: Infinity },
    { stderr: false, findings: RESULT_MAX_FINDINGS, changed: RESULT_MAX_CHANGED },
    { stderr: false, findings: 5, changed: 20 },
    { stderr: false, findings: 5, changed: 0, whyMax: 12, clip: 300, trimmed: true },
    { stderr: false, findings: 0, changed: 0, whyMax: 0, clip: 300, withCommands: false, trimmed: true },
  ];
  let text = "";
  for (const step of steps) {
    text = build(step);
    if (Buffer.byteLength(text, "utf8") <= RESULT_MAX_BYTES) return text;
  }
  // Unreachable with bounded headers; kept so the cap is a guarantee, not a hope.
  const bytes = Buffer.from(text, "utf8").subarray(0, RESULT_MAX_BYTES - 64);
  return bytes.toString("utf8").replace(/\uFFFD+$/, "") + "\n" + t("result.content_trimmed") + "\n";
}

function latestPathFor(paths, workPackage, plan) {
  const taskFile = plan?.task_file || workPackage?.task_file || null;
  if (taskFile) {
    const absolute = path.resolve(paths.repoRoot, ...taskFile.split("/"));
    return absolute.replace(/\.md$/i, "") + ".result.md";
  }
  return path.join(paths.privateRoot, "work-packages", workPackage.work_package_id + ".result.md");
}

async function writeAtomic(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + "." + randomUUID().slice(0, 8) + ".tmp";
  await fsp.writeFile(tmp, text, "utf8");
  await fsp.rename(tmp, file);
}

// A plain exclusive lock file beside the shared latest copy. Different runs hold different run
// locks, so the run lock cannot protect this file; this lock is always the innermost one.
async function withFileLock(file, callback, { attempts = 200, delayMs = 50, staleMs = 30_000 } = {}) {
  const lock = file + ".lock";
  await fsp.mkdir(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let handle = null;
    try {
      handle = await fsp.open(lock, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stat = await fsp.stat(lock).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > staleMs) await fsp.rm(lock, { force: true });
      else await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    await handle.close();
    try {
      return await callback();
    } finally {
      await fsp.rm(lock, { force: true });
    }
  }
  return null;
}

// Codex 2026-10-14: an older run delivered late must not overwrite a newer run's latest copy.
// Order is by the run's end time, then run id; returns whether this run's copy is now the latest.
export async function writeLatestIfNewer(latestPath, body, { runId, closedAt }) {
  const written = await withFileLock(latestPath, async () => {
    const current = await fsp.readFile(latestPath, "utf8").catch(() => null);
    const mark = current ? LATEST_MARK.exec(current) : null;
    if (mark && mark[1] !== runId) {
      const newer = closedAt > mark[2] || (closedAt === mark[2] && runId > mark[1]);
      if (!newer) return false;
    }
    await writeAtomic(latestPath, body);
    return true;
  });
  return written === true;
}

function isLockError(error) {
  return /already held|Could not acquire the run lock|lease was lost|lock advanced/.test(String(error?.message || ""));
}

// V2.7 / V2.8: idempotent delivery for one run; safe to call from work-start, stop and prune.
export async function deliverOutcome({ paths, runId, adapter = null, notify = true, now = Date.now, retry = { attempts: LOCK_RETRY_ATTEMPTS, delayMs: LOCK_RETRY_DELAY_MS }, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const locale = await resolveLocale(paths);
  const t = await createTranslator(locale);
  const run = await readRun(paths, runId);
  if (run.outcome) return { already: true, outcome: run.outcome, result_path: run.result_path, latest_path: run.latest_result_path, latest_written: run.latest_result_written !== false, t };
  if (!TERMINAL_RUN_STATUSES.includes(run.status)) throw new Error("Run is still active: " + runId);
  // Everything is gathered before the lock; the build step only writes.
  const control = await loadControlView(paths, runId);
  const workPackage = control.v4.work_package;
  const plan = await planForRun(paths, runId);
  const events = await readIoEvents(paths, runId);
  let delta = null;
  if (control.workspace_evidence?.baseline_path) {
    // One delta per attempt: concurrent deliverers must not race on the same file name.
    const evidence = await createWorkspaceDelta({ paths, baselinePath: control.workspace_evidence.baseline_path, deltaId: "result-" + runId + "-" + randomUUID().slice(0, 8) }).catch(() => null);
    if (evidence) delta = await readJson(evidence.delta_path).catch(() => null);
  }
  const outcome = classifyOutcome(run);
  const sections = composeSections({ t, run, outcome, workPackage, plan, events, delta, limits: control.v4.policy_snapshot?.effective_policy?.limits || {}, deliveredAt: now() });
  const commands = outcome === "delivered" ? null : await rebuildCommands({ paths, plan, workPackage });
  const runPath = path.join(paths.queueRoot, runId + ".result.md");
  const latestPath = latestPathFor(paths, workPackage, plan);
  const closedAt = run.closed_at || run.updated_at || "";
  const body = renderResult({ t, sections, commands, runId, latest: false, closedAt });
  const latestBody = renderResult({ t, sections, commands, runId, latest: true, closedAt });
  const sha256 = createHash("sha256").update(body).digest("hex");

  let delivered = null;
  for (let attempt = 0; attempt < retry.attempts; attempt += 1) {
    try {
      delivered = await deliverRun(paths, runId, async () => {
        await writeAtomic(runPath, body);
        const latestWritten = await writeLatestIfNewer(latestPath, latestBody, { runId, closedAt });
        return { outcome, result_path: runPath, latest_path: latestPath, latest_written: latestWritten, sha256 };
      });
      break;
    } catch (error) {
      if (!isLockError(error)) throw error;
      await sleep(retry.delayMs);
    }
  }
  if (!delivered) {
    await appendIoEvent(paths, runId, { event: "delivery_skipped", reason: "lock_held" }).catch(() => {});
    return { skipped: true, reason: "lock_held", outcome, t };
  }
  const result = {
    already: delivered.already, outcome: delivered.run.outcome, result_path: delivered.run.result_path, latest_path: delivered.run.latest_result_path,
    latest_written: delivered.run.latest_result_written !== false,
    title: t("outcome." + outcome), line: sections.line, name: sections.name, tokens: tokenRows(events), t,
  };
  // V3.1: a fake-cli run never raises a real desktop notification; the fake adapter may capture it.
  const allowNotify = notify && adapter?.notify && !(run.execution_mode === "fake_cli" && adapter.id !== "portable-fake-cli");
  if (!delivered.already && allowNotify) {
    const title = t("outcome." + outcome);
    try {
      const sent = await adapter.notify(title, t("notify.body", { name: sections.name, line: sections.line }));
      // An adapter may report that it sent nothing (the fake one does); that is not a failure.
      const detail = sent && typeof sent === "object" && sent.sent === false ? { sent: false, reason: sent.reason || "not_sent" } : { sent: true };
      await appendIoEvent(paths, runId, { event: "notified", ok: true, title, ...detail }).catch(() => {});
    } catch (error) {
      await appendIoEvent(paths, runId, { event: "notified", ok: false, title, error: String(error?.message || error).slice(0, 200) }).catch(() => {});
    }
  }
  return result;
}

// V2.8 (c): runs that ended without a delivery (a crash, a held lock) get one before pruning.
export async function deliverPendingRuns(paths, adapter = null) {
  const delivered = [];
  for (const run of await listRuns(paths)) {
    if (!TERMINAL_RUN_STATUSES.includes(run.status) || run.outcome || run.archived_at) continue;
    try {
      const result = await deliverOutcome({ paths, runId: run.run_id, adapter, notify: false });
      if (!result.skipped) delivered.push({ run_id: run.run_id, outcome: result.outcome });
    } catch {
      // A run that cannot be delivered is left for the next pass; pruning still proceeds.
    }
  }
  return delivered;
}

// V3.2: the three stdout lines.
export function stdoutLines(result) {
  const t = result.t;
  if (result.skipped) return [t("stdout.delivery_skipped", { reason: result.reason })];
  const count = (row) => (row?.complete ? String(row.total) : t("result.tokens.unknown"));
  return [
    t("stdout.result", { title: result.title, line: result.line }),
    // An older run whose latest copy was kept by a newer run points at its own per-run file.
    t("stdout.file", { path: result.latest_written === false ? result.result_path : result.latest_path }),
    t("stdout.tokens", { writer: count(result.tokens?.writer), reviewer: count(result.tokens?.reviewer) }),
  ];
}
