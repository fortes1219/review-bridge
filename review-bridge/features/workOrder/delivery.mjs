// Delivery (T0-07): when a run reaches a terminal state, write one plain-language result
// file in the run's log folder and the person's copy in results/<work order>/, one best-effort desktop
// notification, and three lines on stdout. Everything is composed from typed records; no
// model writes any of it.
import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import {
  appendIoEvent,
  assertCurrentPolicy,
  deliverRun,
  listJson,
  listRuns,
  recordsDatabase,
  undeliveredRuns,
  loadControlView,
  readIoEvents,
  readJson,
  readRun,
  tokenTotal,
} from "../../service/index.mjs";
import { digest } from "../../utils/digest.mjs";
import { workOrderDirectory } from "../../utils/paths.mjs";
import { nfc } from "../../utils/workOrderName.mjs";
import { acceptanceRows } from "./acceptance.mjs";
import { contractPath, loadContract } from "./contract.mjs";
import { createTranslator, resolveLocale } from "./i18n.mjs";
import { parseWorkOrder, sealedText, UNTITLED } from "./workOrderFormat.mjs";
import { resultIdentity } from "./workOrderRecords.mjs";
import { createWorkspaceDelta } from "./workspaceEvidence.mjs";

const require = createRequire(import.meta.url);

export const RESULT_MAX_BYTES = 64 * 1024;
export const RESULT_MAX_FINDINGS = 20;
export const RESULT_MAX_CHANGED = 200;
export const LOCK_RETRY_ATTEMPTS = 40;
export const LOCK_RETRY_DELAY_MS = 250;
export const LATE_DELIVERY_MS = 60_000;

export const ORDER_CHANGE_MAX_LINES = 20;

// The result's Next step for a run that did not succeed, by closed reason; any reason not named is
// "start it again" (Owner 2026-11-04).
const NEXT_STEP = Object.freeze({
  rate_limited: "result.next.quota", token_limit: "result.next.quota",
  review_hard_stop: "result.next.findings", rounds_exhausted: "result.next.findings", acceptance_unverified: "result.next.findings",
  run_timeout: "result.next.timeout", writer_timeout: "result.next.timeout",
  needs_human: "result.next.needs_human",
});

// The work order as sealed at the start against the file as it is now. Null when they match
// (outer blank lines aside), { missing } when the file is gone; otherwise the lines that left and
// the lines that came, each in its own order, blank lines ignored. The fence is longer than any
// run of backticks in those lines, so a code block inside the work order cannot close it.
export function workOrderChange(sealed, current) {
  if (current === null) return { missing: true };
  if (String(sealed).trim() === String(current).trim()) return null;
  const lines = (text) => String(text).split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim());
  const left = lines(sealed);
  const right = lines(current);
  const unmatched = (from, against) => {
    const pool = new Map();
    for (const line of against) pool.set(line, (pool.get(line) || 0) + 1);
    return from.filter((line) => {
      const count = pool.get(line) || 0;
      if (count) { pool.set(line, count - 1); return false; }
      return true;
    });
  };
  const removed = unmatched(left, right);
  const added = unmatched(right, left);
  const longest = Math.max(0, ...[...removed, ...added].map((line) => Math.max(0, ...(line.match(/`+/g) || []).map((run) => run.length))));
  return { removed, added, fence: "`".repeat(Math.max(3, longest + 1)) };
}

async function currentWorkOrder(paths, taskFile) {
  try {
    return sealedText(await fsp.readFile(path.resolve(paths.repoRoot, ...taskFile.split("/")), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return { unreadable: error.code || "error" };
  }
}

function orderChangeLines(t, change) {
  if (!change) return [];
  if (change.unreadable) return [t("result.order_changed.unreadable", { code: change.unreadable })];
  if (change.missing) return [t("result.order_changed.missing")];
  const shown = (lines, mark) => [
    ...lines.slice(0, ORDER_CHANGE_MAX_LINES).map((line) => mark + " " + line),
    ...(lines.length > ORDER_CHANGE_MAX_LINES ? [mark + " " + t("result.order_changed.more", { count: lines.length - ORDER_CHANGE_MAX_LINES })] : []),
  ];
  const diff = [...shown(change.removed, "-"), ...shown(change.added, "+")];
  return [t("result.order_changed.note"), ...(diff.length ? ["", change.fence + "diff", ...diff, change.fence] : [])];
}

// V1: the title and the next step are keyed by the run's conclusion and, where the reason it closed
// changes what to say, by its closed_reason too ("outcome.failure.rate_limited").
export function resultKey(t, prefix, run) {
  const specific = prefix + "." + run.conclusion + "." + run.closed_reason;
  return t.has(specific) ? specific : prefix + "." + run.conclusion;
}

// Which part of the result a run's conclusion and closed reason call for.
function resultCase(run) {
  const reason = run.closed_reason;
  switch (run.conclusion) {
    case "success": return "success";
    case "action_required": return reason === "rounds_exhausted" ? "rounds_exhausted" : "action_required";
    case "cancelled": return reason === "cancelled" ? "cancelled" : "stopped";
    case "timed_out": return reason === "run_timeout" ? "run_timeout" : "failure";
    case "failure":
      if (reason === "token_limit" || reason === "usage_unknown") return "token_limit";
      if (reason === "rate_limited") return "rate_limited";
      return "failure";
    default: return "failure";
  }
}

// The plan the run was started from: its copy in the run's own log folder.
async function planForRun(paths, runId) {
  for (const file of await listJson(paths.runLogDir(runId))) {
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
// The contract has a row of its own, always: code cuts it from the work order, so it spent nothing (Owner
// 2026-11-08). A run from before that day shows what translating and checking it spent.
const CONTRACT_ROLES = Object.freeze(["translator", "contract_checker"]);
const rowOf = (event) => (CONTRACT_ROLES.includes(event.role) ? "contract" : event.role);

export function tokenRows(events) {
  const count = (predicate) => events.filter(predicate).length;
  const expected = {
    contract: count((event) => event.event === "usage" && rowOf(event) === "contract"),
    writer: count((event) => event.event === "task.input"),
    reviewer: count((event) => event.event === "review.input") - count((event) => event.event === "review.result" && event.source === "controller"),
  };
  const rows = {};
  for (const role of Object.keys(expected)) {
    const usage = events.filter((event) => event.event === "usage" && rowOf(event) === role);
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

// The graph's statements and prompt tokens over the writer's and reviewer's prompts; null when none read it.
export function graphTotals(events) {
  const read = events.filter((event) => (event.event === "task.input" || event.event === "review.input") && event.graph);
  if (!read.length) return null;
  return {
    queries: read.reduce((total, event) => total + number(event.graph.queries), 0),
    tokens: read.reduce((total, event) => total + number(event.graph.tokens), 0),
  };
}

function writerCalls(run, events) {
  const fromEvents = events.filter((event) => event.event === "task.input").length;
  return fromEvents || Number(run.last_state?.call || 0) || 0;
}

// A heading and its lines, when there are any, cut to the same limit as the changed list.
function listSection(title, lines = [], limit, clip, t) {
  if (!lines.length) return [];
  return ["", "### " + title, ...lines.slice(0, limit).map((line) => clipLine(line, clip)),
    ...(lines.length > limit ? [t("result.changed.more", { count: lines.length - limit })] : [])];
}

// V2.2–V2.6: the sections, as arrays of lines, from typed records only.
export function composeSections({ t, run, workPackage, plan, events, delta, uncommittedAtStart = [], contract = null, orderChange = null, successorExists = false, limits = {}, deliveredAt = Date.now() }) {
  const name = workPackage?.task_file || workPackage?.work_package_id || run.work_package_id || run.run_id;
  const state = run.last_state || {};
  const calls = writerCalls(run, events);
  const gate = last(events, "test_result");
  const review = last(events, "review.result");
  const writer = last(events, "writer.result");
  const stop = last(events, "stop");
  const failure = state.failure || null;
  const acceptance = acceptanceSection({ t, contract, events, writer, review, gate });
  const kind = resultCase(run);

  const head = [];
  const subtitle = [];
  if (kind === "rounds_exhausted" && calls >= 2) subtitle.push(t("outcome.action_required.rounds_exhausted.auto", { count: calls - 1 }));
  head.push("# " + t(resultKey(t, "outcome", run)) + (subtitle.length ? "（" + subtitle.join("；") + "）" : ""));
  head.push("");
  head.push(t("result.header", { name, run_id: run.run_id, ended_at: run.closed_at || run.updated_at || "", calls }));
  if (kind === "success" && gate?.kind === "command") head.push(t("result.test.passed", { command: gate.command }));
  // A project whose rules give no test command says so in every result, whatever the outcome.
  if (workPackage?.test?.kind === "not_configured" || gate?.kind === "not_configured") head.push(t("result.test.not_configured"));

  const why = [];
  let stderrTail = [];
  if (kind === "success") {
    if (review?.verified?.length) { why.push(t("result.why.delivered.verified")); for (const item of review.verified) why.push("- " + item); }
    if (review?.not_run?.length) { why.push(t("result.why.delivered.not_run")); for (const item of review.not_run) why.push("- " + item); }
    if (!why.length) why.push(t("result.why.delivered.none"));
  } else if (kind === "rounds_exhausted") {
    if (gate?.kind === "command" && gate.passed === false && (!review || gate.sequence > review.sequence)) {
      why.push(t("result.why.test_failed", { command: gate.command, exit_code: gate.exit_code, timed_out: gate.timed_out ? t("result.why.test_failed.timed_out") : "" }));
      stderrTail = lastLines(gate.stderr_tail, 10);
      if (stderrTail.length) { why.push(t("result.why.stderr_tail")); why.push("```"); why.push(...stderrTail); why.push("```"); }
    } else if (review?.findings?.length) {
      why.push(t("result.why.findings"));
      for (const finding of review.findings) {
        why.push("- " + t("result.why.finding", { id: finding.id, severity: finding.severity, path: finding.path, line: finding.line, claim: finding.claim, fix: finding.fix }));
      }
    }
    why.push(t("result.why.budget", { max: workPackage?.budget?.rounds ?? run.budget?.rounds ?? "" }));
  } else if (kind === "action_required") {
    if (run.closed_reason === "acceptance_unverified") why.push(t("result.why.acceptance_unverified"));
    if (run.closed_reason === "start_point_lost") why.push(t("result.why.start_point_lost"));
    if (run.closed_reason === "evidence_changed") why.push(t("result.why.evidence_changed"));
    if (run.closed_reason === "version_changed") why.push(t(state.changed_after === "test" ? "result.why.version_changed.test" : "result.why.version_changed"));
    if (run.closed_reason === "evidence_unconfirmable") why.push(t("result.why.evidence_unconfirmable"));
    if (run.closed_reason === "scope_unverified") why.push(t("result.why.scope_unverified"));
    // The writer stopped for the person (Owner 2026-11-06: a person stopped is met on their own document,
    // in their words): what is theirs to decide, and that the work order is where they answer it.
    if (run.closed_reason === "needs_human") why.push(t("result.why.needs_human.decide", { file: workPackage?.task_file || name }));
    if (writer?.needs_human?.length) {
      why.push(t("result.why.needs_human.questions"));
      for (const item of writer.needs_human) why.push("- " + t("result.why.needs_human.question", { question: item.question, options: (item.options || []).join(" / ") }));
    }
    if (writer && writer.status && writer.status !== "done") why.push(t("result.why.needs_human.writer_status", { status: writer.status }));
    // Why the writer stopped, in its own words; what is true of the work is in the sections around this.
    if (writer && (writer.status !== "done" || writer.needs_human?.length)) {
      if (writer.unverified?.length) {
        why.push(t("result.why.writer.unverified"));
        for (const line of writer.unverified) why.push("- " + line);
      }
      if (writer.criteria?.length) {
        why.push(t("result.why.writer.criteria"));
        for (const item of writer.criteria) why.push("- " + item.id + " " + item.status + (item.note ? ": " + item.note : ""));
      }
    }
    if (stop?.detail_ref?.startsWith("loop:")) why.push(t("result.why.needs_human.loop", { id: stop.detail_ref.slice(5) }));
    else if (stop?.detail_ref === "test_loop") why.push(t("result.why.needs_human.gate_loop"));
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
  } else if (kind === "token_limit" && run.closed_reason === "usage_unknown") {
    why.push(t("result.why.usage_unknown", { role: t("result.tokens.role." + (state.token_limit_role || "writer")) }));
  } else if (kind === "token_limit") {
    const role = state.token_limit_role || stop?.role || "writer";
    const which = state.token_limit === "per_run" ? "per_run" : "per_call";
    why.push(t("result.why.token_limit", {
      role: t("result.tokens.role." + role), which: t("result.why.token_limit." + which),
      limit: (which === "per_run" ? limits.tokens : limits.tokens_per_call) ?? "", actual: which === "per_run" ? state.tokens_this_run : state.tokens_this_call,
    }));
  } else if (kind === "rate_limited") {
    const role = failure?.role || stop?.role || "writer";
    const provider = failure?.provider || stop?.provider || "";
    why.push(t("result.why.quota", { role: t("result.tokens.role." + role), provider }));
    if (failure?.reset_hint) why.push(t("result.why.quota.reset", { hint: failure.reset_hint }));
  } else if (kind === "stopped") {
    // The new run is named from the run record, written with the stop; it is said to have replaced
    // this one only if it existed when this result was written.
    if (run.closed_reason === "superseded") why.push(t(successorExists ? "result.why.superseded" : "result.why.superseded.pending", { run_id: run.superseded_by || t("result.acceptance.none") }));
    else if (run.closed_reason === "database_unavailable") why.push(t("result.why.database_unavailable"));
    else if (stop?.role) why.push(t("result.why.stopped", { call: state.call ?? calls, role: t.has("result.tokens.role." + stop.role) ? t("result.tokens.role." + stop.role) : stop.role }));
    else why.push(t("result.why.stopped.unknown"));
  } else if (kind === "cancelled") {
    why.push(t("result.why.cancelled"));
  } else if (kind === "run_timeout") {
    why.push(t("result.why.run_timeout", { limit: workPackage?.budget?.run_timeout ?? run.budget?.run_timeout ?? "" }));
  } else {
    if (run.closed_reason === "evidence_unavailable") why.push(t("result.why.evidence_unavailable"));
    // An answer that broke the agreed format is said in words first, with what was wrong in it (a
    // missing condition named); the reason code and the logs come after.
    const malformed = { malformed_review_result: "reviewer", malformed_writer_result: "writer" }[run.closed_reason];
    const errors = Array.isArray(state.errors) ? state.errors.slice(0, 10).map((line) => {
      const missing = malformed && /^\$\.(?:verdicts|criteria): missing (.+)$/.exec(line);
      return "- " + (missing ? t("result.why.malformed.missing", { ids: missing[1] }) : line);
    }) : [];
    if (malformed) why.push(t("result.why.malformed." + malformed), ...errors);
    why.push(t("result.why.error", { reason: run.closed_reason || run.conclusion }));
    for (const file of [state.stderr_path, state.writer_stderr_path, state.review_error_path, failure?.record_path].filter(Boolean)) why.push(t("result.why.error.log", { path: file }));
    if (state.error) why.push(String(state.error));
    if (!malformed) why.push(...errors);
    if (state.contract_problems?.length) {
      why.push(t("result.why.contract.problems"));
      for (const line of state.contract_problems.slice(0, 10)) why.push("- " + line);
    }
  }

  // Every way a run ends short of success is met by starting the work order again, said in one line
  // with no command; the closed reason only picks what to do first (Owner 2026-11-04).
  // The work order is named by its file name only: the next step is plain words, with no path or command.
  const next = [t(kind === "success" ? "result.next.success" : NEXT_STEP[run.closed_reason] || "result.next.start_again", { file: path.basename(workPackage?.task_file || name) })];

  // The changed list is computed at delivery time. A late delivery (prune after a crash, days on)
  // would otherwise present the owner's later edits as the run's work; it says so instead.
  const closedMs = Date.parse(run.closed_at || run.updated_at || "");
  const changedNote = Number.isFinite(closedMs) && deliveredAt - closedMs > LATE_DELIVERY_MS
    ? t("result.changed.late", { at: new Date(deliveredAt).toISOString(), ended_at: run.closed_at || run.updated_at })
    : null;
  const changed = [];
  const violations = [];
  const unverified = [];
  // What the work proof can and cannot show, before the list itself (RC3-BLOCKER-00).
  const proof = [];
  if (delta?.mode === "none") proof.push(t("result.proof.no_git"));
  if (delta?.mode === "changed") proof.push(t("result.proof.records_changed"));
  if (delta?.mode === "unconfirmed") proof.push(t("result.proof.records_unconfirmed"));
  if (delta?.mode === "git") proof.push(t("result.proof.records_only"));
  if (delta?.start_point === "lost") proof.push(t("result.proof.start_lost"));
  if (delta?.commits_since_start?.length) {
    proof.push(t("result.proof.commits"));
    for (const commit of delta.commits_since_start) proof.push("- " + commit.commit.slice(0, 12) + " " + commit.subject);
  }
  for (const entry of delta?.changed_files || []) {
    const line = "- " + entry.path + "（" + t("result.change." + entry.change) + "）" + (entry.attribution === "unattributed" ? t("result.proof.unattributed") : "");
    if ((delta.scope_violations || []).includes(entry.path)) violations.push(line);
    else if ((delta.scope_unverified || []).includes(entry.path)) unverified.push(line);
    else changed.push(line);
  }
  // What the writer says it changed, every call's, the latest word on each path. Only Git's list above
  // is proof; a writer can claim a file that was already there as it is.
  const claimedByPath = new Map();
  for (const event of events) if (event.event === "writer.result") for (const entry of event.changed || []) claimedByPath.set(entry.path, entry.action);
  const claimed = [...claimedByPath].map(([file, action]) => "- " + file + "（" + t("result.change." + action) + "）");
  const startUncommitted = uncommittedAtStart.map((file) => "- " + file);
  // Without a work proof "nothing changed" cannot be said.
  const noProof = !delta || ["none", "changed", "unconfirmed"].includes(delta.mode) || delta.start_point === "lost";

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
  // What Bridge read from the project's graph for the prompts: its statements and the tokens it put in,
  // which the writer's and reviewer's input above already count; no model cost of its own.
  const graph = graphTotals(events);
  if (graph) tokens.push(t("result.tokens.graph", graph));

  const line = oneLine({ t, kind, review, gate, workPackage, state, failure, stop, run });
  return { name, head, acceptance, orderChange: orderChangeLines(t, orderChange), why, stderrTail, next, proof, noProof, changed, changedNote, violations, unverified, claimed, startUncommitted, tokens, line, calls };
}

// RC3-BLOCKER-00: one line per sealed condition, as Bridge decided it, and the version it was
// checked on. A run the reviewer never judged lists none here (Fortes 2026-11-09, runs 8709b3f5 and
// f645ccf5): every line would read "unknown, reviewer none, evidence none", beside the writer's own
// account of each condition, which is the one with something in it.
function acceptanceSection({ t, contract, events, writer, review, gate }) {
  const decided = last(events, "acceptance");
  if (!decided && !review) return [];
  const reviewInput = last(events, "review.input");
  const rows = decided?.rows || (contract ? acceptanceRows({ contract, writer, review }) : []);
  if (!rows.length) return [];
  const version = decided?.review_version || reviewInput?.work_version || gate?.work_version || null;
  const lines = rows.map((row) => "- " + t("result.acceptance.row", {
    id: row.id, result: t("result.acceptance." + row.result), statement: row.statement,
    verdict: row.verdict || t("result.acceptance.none"), evidence: row.evidence || t("result.acceptance.none"),
  }));
  if (version?.kind === "git") lines.push(t(version.dirty ? "result.acceptance.version.dirty" : "result.acceptance.version.git", { head: String(version.head || "none").slice(0, 12) }));
  else if (version) lines.push(t("result.acceptance.version.unknown"));
  // The project's graph the reviewer asked was not brought up to date at this run's start.
  const graph = last(events, "graph_update");
  if (graph && graph.updated === false) lines.push(t("result.acceptance.graph_not_updated", { reason: graph.reason }));
  return lines;
}

// V3.1: the one sentence after the title.
function oneLine({ t, kind, review, gate, workPackage, state, failure, stop, run }) {
  switch (kind) {
    case "success": return gate?.kind === "command" ? t("line.delivered") : t("line.delivered.not_configured");
    case "rounds_exhausted":
      return gate?.kind === "command" && gate.passed === false && (!review || gate.sequence > review.sequence)
        ? t("line.needs_fix.gate")
        : t("line.needs_fix.findings", { count: review?.findings?.length ?? 0 });
    case "action_required": return t("line.needs_human");
    case "token_limit": return t("line.token_limit", { role: t("result.tokens.role." + (state.token_limit_role || stop?.role || "writer")) });
    case "rate_limited": return t("line.quota", { role: t("result.tokens.role." + (failure?.role || "writer")), provider: failure?.provider || "" });
    case "stopped": return run.closed_reason === "superseded" ? t("line.stopped.superseded")
      : run.closed_reason === "database_unavailable" ? t("line.stopped.database") : t("line.stopped");
    case "cancelled": return t("line.cancelled");
    case "run_timeout": return t("line.run_timeout");
    default: return t("line.error", { reason: run.closed_reason || run.conclusion });
  }
}

// V2.1b: render within 64 KB. Trim stderr, then findings, then the changed and out-of-scope
// lists; the last step keeps only the title, a few why lines, the next step and the tokens.
// Codex 2026-10-14: the out-of-scope list was never capped and the last step was never checked.
function clipLine(line, max) {
  return max === Infinity || line.length <= max ? line : line.slice(0, max - 1) + "…";
}

export function renderResult({ t, sections, identity = [] }) {
  const build = ({ stderr, findings, changed, whyMax = Infinity, clip = Infinity, trimmed = false }) => {
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
      ...identity,
      ...sections.head.map((line) => clipLine(line, clip)),
      "",
      ...((sections.acceptance || []).length ? ["## " + t("result.section.acceptance"), ...sections.acceptance.map((line) => clipLine(line, clip)), ""] : []),
      // At the tightest steps only the note stays; the listed lines are bounded but not needed.
      ...((sections.orderChange || []).length ? ["## " + t("result.section.order_changed"), ...(trimmed ? sections.orderChange.slice(0, 1) : sections.orderChange).map((line) => clipLine(line, clip)), ""] : []),
      "## " + t("result.section.why"),
      ...why,
      ...(trimmed ? [t("result.content_trimmed")] : []),
      "",
      "## " + t("result.section.next"),
      ...sections.next,
      "",
      "## " + t("result.section.changed"),
      ...(sections.changedNote ? [sections.changedNote, ""] : []),
      ...((sections.proof || []).length ? [...sections.proof, ""] : []),
      ...(changedLines.length ? changedLines : sections.changed.length || sections.noProof ? [] : [t("result.changed.none")]),
      ...(sections.changed.length > changed ? [t("result.changed.more", { count: sections.changed.length - changed })] : []),
      ...(sections.violations.length ? ["", "### " + t("result.section.violations"), ...violationLines,
        ...(sections.violations.length > changed ? [t("result.violations.more", { count: sections.violations.length - changed })] : [])] : []),
      ...((sections.unverified || []).length ? ["", "### " + t("result.section.unverified"), ...sections.unverified.slice(0, changed).map((line) => clipLine(line, clip))] : []),
      ...listSection(t("result.section.claimed"), sections.claimed, changed, clip, t),
      ...listSection(t("result.section.start_uncommitted"), sections.startUncommitted, changed, clip, t),
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
    { stderr: false, findings: 0, changed: 0, whyMax: 0, clip: 300, trimmed: true },
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

// Who the result is about (RC3-FIX-01 round 2), read from the database by run id; { unavailable }
// when there is no database to read or the run is not in it, so the result says so instead of
// filling the values from files.
async function readIdentity(runId) {
  const database = recordsDatabase();
  if (!database) return { unavailable: "none" };
  try {
    return (await resultIdentity(await database(), runId)) || { unavailable: "not_recorded" };
  } catch (error) {
    return { unavailable: "error", reason: String(error?.message || error).split(/\r?\n/)[0].slice(0, 200) };
  }
}

const yamlScalar = (value) => require("yaml").stringify(value, { lineWidth: 0 }).trimEnd();

// The head of both copies, before the title: YAML frontmatter, the way a work order carries its
// source_id, one line per value, each the database's. A line's comment says what its value means.
function identityLines(t, identity) {
  const known = !identity.unavailable;
  const value = (key) => (known ? identity[key] ?? null : null);
  const line = (key, item, note = null) => key + ": " + yamlScalar(item) + (note ? "  # " + note : "");
  const version = known ? identity.review_version : null;
  const commit = version?.kind === "git" ? version.head || null : null;
  const commitNote = !known ? null
    : version?.kind === "git" ? (version.dirty ? t("result.identity.commit.dirty") : null)
      : version ? t("result.identity.commit.no_git") : t("result.identity.commit.none");
  // Each role as a work order writes it, plus who filled it; the model the run was told to use.
  const role = (name) => [
    name + ":",
    "  " + line("provider", value(name + "_provider")),
    "  " + line("model", value(name + "_model"), known && value(name + "_provider") && value(name + "_model") === null ? t("result.identity.model.cli_default") : null),
    "  " + line("effort", value(name + "_effort")),
  ];
  return [
    "---",
    ...(known ? [] : ["# " + t("result.identity.unavailable." + identity.unavailable, { reason: identity.reason || "" })]),
    line("source_id", value("source_id")),
    line("title", value("title")),
    line("source_file", value("source_file")),
    line("version_no", value("version_no"), known ? t("result.identity.version_no") : null),
    line("contract_sha256", value("contract_sha256"), known && !identity.contract_sha256 ? t("result.identity.contract.none") : null),
    line("run_id", value("run_id")),
    line("commit", commit, commitNote),
    ...role("writer"),
    ...role("reviewer"),
    "  mcp: " + JSON.stringify(value("reviewer_mcp")),
    "---",
    "",
  ];
}

const two = (number) => String(number).padStart(2, "0");
// A file name holds no \ / : * ? " < > | or control characters on Windows, nor a trailing dot or space.
// In NFC, as the records name it, so one work order has one folder on every machine.
const fileNamePart = (text) => nfc(text).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/[. ]+$/, "");

const isUntitled = (task) => {
  try { return task ? parseWorkOrder(task).title.line === null : false; } catch { return false; }
};

// The work order's own folder for the person's copies: .review-bridge/results/<work order file>/, one
// folder per work order as Playwright keeps test-results/<test>/ (DECISIONS 2026-11-04). A work order in
// a directory of work-packages/ has it under that directory's name, one level, as the directory is. One
// with no title goes under untitled/ (Owner 2026-11-06); its files keep the work package's name, so such
// work orders share the folder without meeting.
function resultFolder(paths, { identity, workPackage, plan }) {
  const taskFile = !identity.unavailable ? identity.source_file : plan?.task_file || workPackage?.task_file || null;
  const name = taskFile ? path.basename(taskFile).replace(/\.md$/i, "") : workPackage.work_package_id;
  const directory = taskFile ? workOrderDirectory(taskFile) : null;
  return { name, folder: path.join(paths.resultsDir, ...(directory ? [fileNamePart(directory)] : []), fileNamePart(taskFile && isUntitled(workPackage?.task) ? UNTITLED : name)) };
}

// The person's copy of a run's result (DECISIONS 2026-11-03, RC3-FIX-01 round 2): one file per run in
// the work order's results folder, never in work-packages/, named so an auditor holding a ticket number
// or a date finds it: "<source_id> <work order file> <local date> <hh-mm-ss> <conclusion>.md". Without
// the database the work order's file name comes from the run's plan. The person may delete these; the
// record is the database, and the run's log folder keeps <run_id>.result.md.
function resultCopyPath(paths, { identity, run, workPackage, plan }) {
  const known = !identity.unavailable;
  const { name, folder } = resultFolder(paths, { identity, workPackage, plan });
  const closed = new Date(known ? identity.closed_at : run.closed_at || run.updated_at);
  const parts = [
    ...(known && identity.source_id !== null ? [identity.source_id] : []),
    name,
    closed.getFullYear() + "-" + two(closed.getMonth() + 1) + "-" + two(closed.getDate()),
    two(closed.getHours()) + "-" + two(closed.getMinutes()) + "-" + two(closed.getSeconds()),
    known ? identity.conclusion : run.conclusion,
  ];
  return path.join(folder, parts.map(fileNamePart).join(" ") + ".md");
}

// The sealed contract beside the results that point to it: contract.v<version>.<short SHA>.json, the
// short SHA as Git abbreviates a commit (7 characters), so each result's contract_sha256 names its own
// file even when one version was started twice (Owner 2026-11-04). The bytes are the sealed file's.
// Without the version from the database there is no name to give it, and it is not written.
async function contractCopy(paths, { identity, workPackage, plan, contractSha256 }) {
  if (identity.unavailable || !contractSha256) return null;
  const bytes = await fsp.readFile(contractPath(paths, contractSha256), "utf8").catch(() => null);
  if (bytes === null) return null;
  const file = path.join(resultFolder(paths, { identity, workPackage, plan }).folder, "contract.v" + identity.version_no + "." + contractSha256.slice(0, 7) + ".json");
  return { file, bytes };
}

// The copy is created, never overwritten (exclusive create). A file of that name with this very text
// is this delivery tried again and is kept as the copy; one with other text is another run's, and
// the delivery stops rather than write over it.
async function writeNewCopy(file, text, taken = "is already another run's result") {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  try {
    await fsp.writeFile(file, text, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (await fsp.readFile(file, "utf8") !== text) throw new Error("The result file " + file + " " + taken + "; it was not written over.");
  }
  return file;
}

async function writeAtomic(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + "." + randomUUID().slice(0, 8) + ".tmp";
  await fsp.writeFile(tmp, text, "utf8");
  await fsp.rename(tmp, file);
}

function isLockError(error) {
  return /already held|Could not acquire the run lock|lease was lost|lock advanced/.test(String(error?.message || ""));
}

// V2.7 / V2.8: idempotent delivery for one run; safe to call from work-start, stop and prune.
export async function deliverOutcome({ paths, runId, adapter = null, notify = true, now = Date.now, retry = { attempts: LOCK_RETRY_ATTEMPTS, delayMs: LOCK_RETRY_DELAY_MS }, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const locale = await resolveLocale(paths);
  const t = await createTranslator(locale);
  const run = await readRun(paths, runId);
  if (run.result_sha256) return { already: true, conclusion: run.conclusion, closed_reason: run.closed_reason, result_path: run.result_path, latest_path: run.latest_result_path, latest_written: run.latest_result_written !== false, t };
  if (run.status !== "completed") throw new Error("Run is still active: " + runId);
  // Everything is gathered before the lock; the build step only writes.
  const control = await loadControlView(paths, runId);
  assertCurrentPolicy(control.run.policy_snapshot?.policy_schema_version, runId);
  const workPackage = control.run.work_package;
  const plan = await planForRun(paths, runId);
  const events = await readIoEvents(paths, runId);
  let delta = null;
  let uncommittedAtStart = [];
  if (control.workspace_evidence?.baseline_path) {
    // A delivery may run in another process, where the controller's in-memory seal is gone; the
    // baseline is then checked against the hash on the run record, and the result says so.
    const baseline = await readJson(control.workspace_evidence.baseline_path).catch(() => null);
    if (!baseline || !control.workspace_evidence.baseline_sha256 || digest(baseline) !== control.workspace_evidence.baseline_sha256 || run.closed_reason === "evidence_changed") {
      // A run stopped because its records changed: none of them is used to list or attribute changes.
      delta = { mode: "changed", changed_files: [], scope_violations: [], scope_unverified: [] };
    } else if (run.closed_reason === "evidence_unconfirmable") {
      delta = { mode: "unconfirmed", changed_files: [], scope_violations: [], scope_unverified: [] };
    } else {
      uncommittedAtStart = Array.isArray(baseline.uncommitted_at_start) ? baseline.uncommitted_at_start : [];
      // One delta per attempt: concurrent deliverers must not race on the same file name.
      const evidence = await createWorkspaceDelta({ paths, baselinePath: control.workspace_evidence.baseline_path, deltaId: "result-" + runId + "-" + randomUUID().slice(0, 8) }).catch(() => null);
      if (evidence) delta = await readJson(evidence.delta_path).catch(() => null);
    }
  }
  // A contract that no longer loads is reported as such; its conditions then stay unknown.
  const contract = control.run.contract_sha256 ? await loadContract(paths, control.run.contract_sha256).catch(() => null) : null;
  // The work is judged on the sealed work order; an edit made since is shown, never used.
  const current = workPackage?.task_file ? await currentWorkOrder(paths, workPackage.task_file) : undefined;
  const orderChange = current === undefined ? null : current?.unreadable ? current : workOrderChange(workPackage.task, current);
  const successorExists = run.superseded_by ? await readRun(paths, run.superseded_by).then(() => true, () => false) : false;
  const sections = composeSections({ t, run, workPackage, plan, events, delta, uncommittedAtStart, contract, orderChange, successorExists, limits: control.run.policy_snapshot?.effective_policy?.limits || {}, deliveredAt: now() });
  const runPath = path.join(paths.runLogDir(runId), runId + ".result.md");
  const identity = await readIdentity(runId);
  const copyPath = resultCopyPath(paths, { identity, run, workPackage, plan });
  const contractFile = await contractCopy(paths, { identity, workPackage, plan, contractSha256: control.run.contract_sha256 });
  const body = renderResult({ t, sections, identity: identityLines(t, identity) });
  const sha256 = createHash("sha256").update(body).digest("hex");

  let delivered = null;
  for (let attempt = 0; attempt < retry.attempts; attempt += 1) {
    try {
      delivered = await deliverRun(paths, runId, async () => {
        await writeAtomic(runPath, body);
        if (contractFile) await writeNewCopy(contractFile.file, contractFile.bytes, "holds another contract");
        const copy = await writeNewCopy(copyPath, body);
        return { result_path: runPath, latest_path: copy, latest_written: true, sha256 };
      });
      break;
    } catch (error) {
      if (!isLockError(error)) throw error;
      await sleep(retry.delayMs);
    }
  }
  if (!delivered) {
    await appendIoEvent(paths, runId, { event: "delivery_skipped", reason: "lock_held" }).catch(() => {});
    return { skipped: true, reason: "lock_held", conclusion: run.conclusion, closed_reason: run.closed_reason, t };
  }
  const result = {
    already: delivered.already, conclusion: delivered.run.conclusion, closed_reason: delivered.run.closed_reason, result_path: delivered.run.result_path, latest_path: delivered.run.latest_result_path,
    latest_written: delivered.run.latest_result_written !== false,
    title: t(resultKey(t, "outcome", run)), line: sections.line, name: sections.name, tokens: tokenRows(events), t,
  };
  // V3.1: a fake-cli run never raises a real desktop notification; the fake adapter may capture it.
  const allowNotify = notify && adapter?.notify && !(run.execution_mode === "fake_cli" && adapter.id !== "portable-fake-cli");
  if (!delivered.already && allowNotify) {
    const title = t(resultKey(t, "outcome", run));
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
// With records (RC3-BLOCKER-01 step 4) the candidates come from the database, at most fifty a pass;
// a process that keeps none reads its files.
async function undeliveredCandidates(paths) {
  const database = recordsDatabase();
  const projectId = database ? (await readJson(paths.bridgeConfigPath).catch(() => null))?.project_id : null;
  if (!projectId) return await listRuns(paths);
  const ids = (await undeliveredRuns(await database(), projectId)).map((row) => row.run_id);
  return (await Promise.all(ids.map((runId) => readRun(paths, runId).catch(() => null)))).filter(Boolean);
}

export async function deliverPendingRuns(paths, adapter = null) {
  const delivered = [];
  for (const run of await undeliveredCandidates(paths)) {
    if (run.status !== "completed" || run.result_sha256 || run.archived_at) continue;
    try {
      const result = await deliverOutcome({ paths, runId: run.run_id, adapter, notify: false });
      if (!result.skipped) delivered.push({ run_id: run.run_id, conclusion: result.conclusion, closed_reason: result.closed_reason });
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
    // A run delivered when copies were shared, and kept from one by a newer run, points at its own file.
    t("stdout.file", { path: result.latest_written === false ? result.result_path : result.latest_path }),
    t("stdout.tokens", { writer: count(result.tokens?.writer), reviewer: count(result.tokens?.reviewer) }),
  ];
}
