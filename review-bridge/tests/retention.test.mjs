import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { fileExists, writeJson } from "../service/records/fileStore.mjs";
import { getBridgePaths } from "../utils/paths.mjs";
import { formatPruneSummary, mergeRun, prune, removeRun } from "../features/records/retention.mjs";
import { RetentionConfigError, retentionDays } from "../service/records/dayFiles.mjs";
import { parseReviewerUsage, parseWriterUsage } from "../service/agentCli/usage.mjs";
import { probeAuditDir } from "../service/records/probeAudit.mjs";
import { localDateKey } from "../utils/dates.mjs";
import { TERMINAL_RUN_STATUSES } from "../service/records/runStore.mjs";

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY_MS = 86_400_000;
const BASE_SHA = "0432439c9efc76d2c843916916905610a6b52c78bf7508c52951a00afec59fce";
let fixtureCount = 0;

async function runtime(t, config = {}) {
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-retention-"));
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  const paths = getBridgePaths(repoRoot, bridgeRoot, { privateRootName: ".review-bridge" });
  await writeJson(paths.bridgeConfigPath, {
    schema_version: 4, state_contract: "v4", active_runs: "derive_from_run_projections", ...config,
  });
  return { repoRoot, paths };
}

function iso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

// One terminal run laid out the way rc.2 wrote it: flat per-call files, a review job,
// review files, evidence with a before snapshot and a delta.
async function terminalRunFixture(paths, { runId = "run-" + Math.random().toString(16).slice(2, 10), closedAt = iso(), status = "pass", outcome = "delivered" } = {}) {
  fixtureCount += 1;
  const serial = String(fixtureCount).padStart(3, "0");
  const PLAN_SHA = serial.repeat(2) + BASE_SHA.slice(6);
  const stamp = "20261012T155054" + serial + "Z";
  const jobId = "20261012T155930" + serial + "Z-60141da11c31e5e9";
  const stdoutPath = path.join(paths.queueRoot, stamp + "-claude.stdout.json");
  const lastState = { status: "pass", call: 1, claude_stdout_path: stdoutPath, stderr_path: path.join(paths.queueRoot, stamp + "-claude.stderr.log") };
  const run = {
    run_id: runId, status, closed_at: closedAt, updated_at: closedAt, created_at: closedAt, ...(outcome ? { outcome } : {}),
    authorization_ids: ["plan-" + PLAN_SHA], work_package: "demo", last_event_sequence: 2, last_state: lastState,
  };
  await writeJson(path.join(paths.runsDir, runId + ".json"), run);
  await fsp.mkdir(paths.eventsDir, { recursive: true });
  await fsp.writeFile(path.join(paths.eventsDir, runId + ".jsonl"), [
    JSON.stringify({ schema_version: 4, run_id: runId, sequence: 1, type: "run_started", projection: { ...run, last_state: null } }),
    JSON.stringify({ schema_version: 4, run_id: runId, sequence: 2, type: "run_terminal", projection: run }),
  ].join("\n") + "\n");
  await fsp.writeFile(path.join(paths.queueRoot, stamp + "-writer-only-prompt.txt"), "prompt text");
  await fsp.writeFile(stdoutPath, JSON.stringify({
    type: "result", num_turns: 58, total_cost_usd: 3.03, result: "SECRET TRANSCRIPT",
    usage: { input_tokens: 94, cache_read_input_tokens: 4871292, cache_creation_input_tokens: 150800, output_tokens: 42211 },
    modelUsage: { "claude-opus-5-5": {} },
  }));
  await fsp.writeFile(lastState.stderr_path, "stderr tail");
  await fsp.writeFile(path.join(paths.queueRoot, stamp + "-stop-payload.json"), "{}");
  await fsp.writeFile(path.join(paths.queueRoot, "demo-" + serial + ".plan.json"), JSON.stringify({ proposed_run_id: runId, plan_sha256: PLAN_SHA }));
  await fsp.writeFile(path.join(paths.queueRoot, "authorized-plan-" + PLAN_SHA + ".txt"), "task text");
  const evidenceDir = path.join(paths.evidenceRoot, PLAN_SHA.slice(0, 32));
  await fsp.mkdir(path.join(evidenceDir, "before", "src"), { recursive: true });
  await fsp.writeFile(path.join(evidenceDir, "before", "src", "a.mjs"), "before copy");
  await fsp.writeFile(path.join(evidenceDir, "baseline.json"), "{}");
  const deltaPath = path.join(evidenceDir, "delta-" + jobId + ".json");
  await fsp.writeFile(deltaPath, JSON.stringify({ changed_files: [{ path: "src/a.mjs" }] }));
  await fsp.mkdir(paths.doneDir, { recursive: true });
  await writeJson(path.join(paths.doneDir, jobId + ".json"), {
    job_id: jobId, authorization: { run_id: runId },
    workspace_evidence: { delta_path: deltaPath, evidence_dir: evidenceDir, baseline_path: path.join(evidenceDir, "baseline.json") },
  });
  await fsp.mkdir(paths.reviewsRoot, { recursive: true });
  await fsp.writeFile(path.join(paths.reviewsRoot, jobId + "-codex-review.md"), "REVIEW_GATE: PASS\nHARD_STOP_REQUIRED: false\n");
  await fsp.writeFile(path.join(paths.reviewsRoot, jobId + "-codex.stderr.log"), "noise\ntokens used\n59,990\n");
  await fsp.writeFile(path.join(paths.reviewsRoot, "LATEST.txt"), "x");
  return { run, stamp, jobId, stdoutPath, evidenceDir, deltaPath };
}

async function readArchive(file) {
  return (await fsp.readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

test("T1 merge folds a terminal run into its day file and deletes what it folded", async (t) => {
  const { paths } = await runtime(t);
  const fixture = await terminalRunFixture(paths);
  const result = await mergeRun(paths, fixture.run.run_id);
  assert.equal(result.already_archived, false);
  assert.equal(path.basename(result.archive_file), localDateKey(fixture.run.closed_at) + ".jsonl");

  const lines = await readArchive(result.archive_file);
  const types = lines.map((line) => line.type);
  assert.equal(types.filter((type) => type === "run").length, 1);
  assert.equal(types.filter((type) => type === "event").length, 2);
  const usage = lines.filter((line) => line.type === "usage");
  assert.deepEqual(usage.find((line) => line.role === "writer").cache_read_input_tokens, 4871292);
  assert.equal(usage.find((line) => line.role === "writer").model, "claude-opus-5-5");
  assert.equal(usage.find((line) => line.role === "reviewer").tokens_used, 59990);
  const artifacts = lines.filter((line) => line.type === "artifact");
  assert.ok(artifacts.some((line) => line.kind === "review_result" && /REVIEW_GATE: PASS/.test(line.text)));
  assert.ok(artifacts.some((line) => line.kind === "evidence_delta" && /src\/a.mjs/.test(line.text)));
  assert.ok(artifacts.some((line) => line.kind === "plan"));
  assert.ok(artifacts.some((line) => line.kind === "authorized_plan"));
  assert.ok(artifacts.every((line) => typeof line.sha256 === "string" && line.sha256.length === 64));
  // R1.7: the writer transcript is not archived, only its usage.
  assert.equal(JSON.stringify(lines).includes("SECRET TRANSCRIPT"), false);
  assert.equal(JSON.stringify(lines).includes("before copy"), false);

  for (const file of [fixture.stdoutPath, path.join(paths.eventsDir, fixture.run.run_id + ".jsonl"), fixture.deltaPath,
    path.join(paths.queueRoot, "demo-001.plan.json"), path.join(paths.reviewsRoot, fixture.jobId + "-codex-review.md")]) {
    assert.equal(await fileExists(file), false, file);
  }
  assert.equal(await fileExists(fixture.evidenceDir), false);
  assert.equal(await fileExists(path.join(paths.reviewsRoot, "LATEST.txt")), true);
  const projection = JSON.parse(await fsp.readFile(path.join(paths.runsDir, fixture.run.run_id + ".json"), "utf8"));
  assert.ok(projection.archived_at);
  assert.equal(projection.archive_file, result.archive_file);
  assert.equal((await mergeRun(paths, fixture.run.run_id)).already_archived, true);
  await assert.rejects(mergeRun(paths, "no-such-run-0001"), /does not exist/);
});

test("T2 when the day file cannot be written nothing is deleted and the run says why", async (t) => {
  const { paths } = await runtime(t);
  const fixture = await terminalRunFixture(paths);
  await fsp.mkdir(path.dirname(paths.archiveDir), { recursive: true });
  await fsp.writeFile(paths.archiveDir, "not a directory"); // mkdir(archive) now fails
  await assert.rejects(mergeRun(paths, fixture.run.run_id));
  assert.equal(await fileExists(fixture.stdoutPath), true);
  assert.equal(await fileExists(path.join(paths.eventsDir, fixture.run.run_id + ".jsonl")), true);
  const projection = JSON.parse(await fsp.readFile(path.join(paths.runsDir, fixture.run.run_id + ".json"), "utf8"));
  assert.ok(projection.archive_error);
  assert.equal(projection.archived_at, undefined);
});

test("T3 prune merges, drops day files and run records past the window, and keeps active runs and today", async (t) => {
  const { paths } = await runtime(t);
  const now = Date.now();
  await fsp.mkdir(paths.archiveDir, { recursive: true });
  const old = localDateKey(now - 16 * DAY_MS);
  const recent = localDateKey(now - 14 * DAY_MS);
  const today = localDateKey(now);
  for (const key of [old, recent, today]) await fsp.writeFile(path.join(paths.archiveDir, key + ".jsonl"), "{}\n");
  const expired = await terminalRunFixture(paths, { runId: "run-expired-0001", closedAt: iso(-20 * DAY_MS) });
  const fresh = await terminalRunFixture(paths, { runId: "run-fresh-00001", closedAt: iso(-1 * DAY_MS) });
  const active = { run_id: "run-active-0001", status: "running", updated_at: iso(), authorization_ids: ["plan-active"], last_state: null };
  await writeJson(path.join(paths.runsDir, active.run_id + ".json"), active);
  await fsp.mkdir(paths.authorizationClaimsDir, { recursive: true });
  await writeJson(path.join(paths.authorizationClaimsDir, "plan-expired.json"), { run_id: expired.run.run_id, claimed_at: iso(-20 * DAY_MS) });
  await writeJson(path.join(paths.authorizationClaimsDir, "plan-active.json"), { run_id: active.run_id, claimed_at: iso(-20 * DAY_MS) });
  await writeJson(path.join(paths.authorizationClaimsDir, "plan-fresh.json"), { run_id: fresh.run.run_id, claimed_at: iso(-1 * DAY_MS) });

  const summary = await prune(paths, { config: { retention: { days: 15 } }, clock: () => now });
  assert.equal(summary.days, 15);
  assert.equal(summary.merged_runs, 2);
  assert.deepEqual(summary.merge_errors, []);
  assert.equal(summary.archive_files_deleted, 2); // the 16-day file and the day file the expired run was folded into
  assert.equal(await fileExists(path.join(paths.archiveDir, old + ".jsonl")), false);
  assert.equal(await fileExists(path.join(paths.archiveDir, recent + ".jsonl")), true);
  assert.equal(await fileExists(path.join(paths.archiveDir, today + ".jsonl")), true);
  // The expired run's projection and claim are gone; the fresh and active ones stay.
  assert.equal(await fileExists(path.join(paths.runsDir, expired.run.run_id + ".json")), false);
  assert.equal(await fileExists(path.join(paths.authorizationClaimsDir, "plan-expired.json")), false);
  assert.equal(await fileExists(path.join(paths.runsDir, fresh.run.run_id + ".json")), true);
  assert.equal(await fileExists(path.join(paths.authorizationClaimsDir, "plan-fresh.json")), true);
  assert.equal(await fileExists(path.join(paths.runsDir, active.run_id + ".json")), true);
  assert.equal(await fileExists(path.join(paths.authorizationClaimsDir, "plan-active.json")), true);
  // The expired run was folded into a day file dated by its own terminal time before that file aged out.
  assert.equal(await fileExists(path.join(paths.archiveDir, localDateKey(fresh.run.closed_at) + ".jsonl")), true);
});

test("T4 an invalid retention setting refuses to prune and deletes nothing", async (t) => {
  const { paths } = await runtime(t);
  await fsp.mkdir(paths.archiveDir, { recursive: true });
  const old = localDateKey(Date.now() - 40 * DAY_MS);
  await fsp.writeFile(path.join(paths.archiveDir, old + ".jsonl"), "{}\n");
  await assert.rejects(prune(paths, { config: { retention: { days: "abc" } } }), RetentionConfigError);
  await assert.rejects(prune(paths, { config: { retention: { days: 0 } } }), RetentionConfigError);
  assert.equal(await fileExists(path.join(paths.archiveDir, old + ".jsonl")), true);
  assert.equal(retentionDays({}), 15);
  assert.equal(retentionDays({ retention: { days: 3 } }), 3);
});

test("T5 rm refuses an active run, folds and removes a finished one, and names an unknown id", async (t) => {
  const { paths } = await runtime(t);
  const active = { run_id: "run-active-0002", status: "running", updated_at: iso(), authorization_ids: [], last_state: null };
  await writeJson(path.join(paths.runsDir, active.run_id + ".json"), active);
  assert.deepEqual((await removeRun(paths, active.run_id)).exitCode, 1);
  assert.equal(await fileExists(path.join(paths.runsDir, active.run_id + ".json")), true);

  const done = await terminalRunFixture(paths, { runId: "run-done-000001" });
  const removed = await removeRun(paths, done.run.run_id);
  assert.equal(removed.exitCode, 0);
  assert.equal(removed.reason, "merged_and_removed");
  assert.equal(await fileExists(path.join(paths.runsDir, done.run.run_id + ".json")), false);
  assert.equal(await fileExists(removed.archive_file), true);
  assert.equal((await removeRun(paths, "run-missing-0001")).exitCode, 1);
  assert.equal((await removeRun(paths, "../escape")).exitCode, 1);
});

test("T7 a stray file maps to no run: archived as an orphan by its own date and deleted; active-run files untouched", async (t) => {
  const { paths } = await runtime(t);
  const now = Date.now();
  await fsp.mkdir(paths.queueRoot, { recursive: true });
  const stray = path.join(paths.queueRoot, "hook-errors.log");
  await fsp.writeFile(stray, "old noise\n");
  const strayDate = new Date(now - 3 * DAY_MS);
  await fsp.utimes(stray, strayDate, strayDate);
  const activeStamp = "20261013T010000000Z";
  const activeFile = path.join(paths.queueRoot, activeStamp + "-claude.stdout.json");
  await fsp.writeFile(activeFile, "{}");
  await writeJson(path.join(paths.runsDir, "run-active-0003.json"), {
    run_id: "run-active-0003", status: "running", updated_at: iso(), authorization_ids: [], last_state: { claude_stdout_path: activeFile },
  });
  const summary = await prune(paths, { config: {}, clock: () => now });
  assert.equal(summary.orphans_archived, 1);
  assert.equal(await fileExists(stray), false);
  assert.equal(await fileExists(activeFile), true);
  const lines = await readArchive(path.join(paths.archiveDir, localDateKey(strayDate) + ".jsonl"));
  assert.equal(lines[0].type, "orphan");
  assert.equal(lines[0].text, "old noise\n");
});

test("T8 usage parsers read the real shapes and never throw on garbage", () => {
  const writer = parseWriterUsage(JSON.stringify({
    num_turns: 8, total_cost_usd: 0.5, usage: { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 },
    modelUsage: { "claude-opus-5-5": {}, "claude-haiku-4-5": {} },
  }), { call: 2 });
  assert.deepEqual(writer, {
    role: "writer", call: 2, model: "claude-opus-5-5,claude-haiku-4-5", num_turns: 8,
    input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4, total_cost_usd: 0.5,
  });
  assert.equal(parseWriterUsage("not json").parse_error, true);
  assert.equal(parseWriterUsage("[]").parse_error, true);
  assert.equal(parseWriterUsage(JSON.stringify({ num_turns: 1 })).parse_error, true);
  assert.deepEqual(parseReviewerUsage("x\ntokens used\n59,990\n", { jobId: "j" }), { role: "reviewer", job_id: "j", tokens_used: 59990 });
  assert.equal(parseReviewerUsage("no trailer").parse_error, true);
  assert.equal(parseReviewerUsage("").parse_error, true);
});

test("P8 merge folds the run's I/O event file into the day file and deletes it", async (t) => {
  const { paths } = await runtime(t);
  const fixture = await terminalRunFixture(paths);
  const ioFile = path.join(paths.eventsDir, fixture.run.run_id + ".io.jsonl");
  await fsp.writeFile(ioFile, [
    JSON.stringify({ schema_version: 1, run_id: fixture.run.run_id, sequence: 1, event: "task.input", call: 1 }),
    JSON.stringify({ schema_version: 1, run_id: fixture.run.run_id, sequence: 2, event: "usage", call: 1, tokens: { cache_read: 5 } }),
  ].join("\n") + "\n");
  await fsp.mkdir(paths.runLocksDir, { recursive: true });
  await fsp.writeFile(path.join(paths.runLocksDir, fixture.run.run_id + ".process.json"), "{}");
  const result = await mergeRun(paths, fixture.run.run_id);
  const lines = await readArchive(result.archive_file);
  const io = lines.filter((line) => line.type === "io_event");
  assert.equal(io.length, 2);
  assert.equal(io[1].event.event, "usage");
  assert.equal(await fileExists(ioFile), false);
  assert.equal(await fileExists(path.join(paths.runLocksDir, fixture.run.run_id + ".process.json")), false);
});

test("P9 every terminal status the state machine knows is archivable; the list is shared, not copied", async (t) => {
  const { paths } = await runtime(t);
  assert.ok(TERMINAL_RUN_STATUSES.includes("stopped") && TERMINAL_RUN_STATUSES.includes("token_limit") && TERMINAL_RUN_STATUSES.includes("needs_human"));
  for (const status of TERMINAL_RUN_STATUSES) {
    const fixture = await terminalRunFixture(paths, { status });
    const result = await mergeRun(paths, fixture.run.run_id);
    assert.equal(result.already_archived, false, status);
    const lines = await readArchive(result.archive_file);
    assert.ok(lines.some((line) => line.type === "run" && line.run_id === fixture.run.run_id && line.run.status === status), status);
  }
  const active = await terminalRunFixture(paths, { status: "review_pending" });
  await assert.rejects(mergeRun(paths, active.run.run_id), /still active/);
});

test("P10 prune never folds an undelivered run inside the window; it delivers first when it can, and marks the ones it folds anyway", async (t) => {
  const { paths } = await runtime(t);
  const recent = await terminalRunFixture(paths, { outcome: null });
  const stale = await terminalRunFixture(paths, { outcome: null, closedAt: iso(-20 * 86_400_000) });
  const deliverable = await terminalRunFixture(paths, { outcome: null });
  const broken = await terminalRunFixture(paths, { outcome: null });
  const calls = [];
  const summary = await prune(paths, {
    config: { retention: { days: 15 } },
    deliver: async (runId) => {
      calls.push(runId);
      if (runId === broken.run.run_id) throw new Error("cannot build the result");
      if (runId === deliverable.run.run_id) {
        const file = path.join(paths.runsDir, runId + ".json");
        await writeJson(file, { ...JSON.parse(await fsp.readFile(file, "utf8")), outcome: "delivered" });
      }
    },
  });
  assert.ok(calls.includes(recent.run.run_id) && calls.includes(broken.run.run_id) && calls.includes(deliverable.run.run_id));
  assert.deepEqual(summary.undelivered.sort(), [recent.run.run_id, broken.run.run_id].sort());
  assert.equal(summary.undelivered_archived, 1);
  const read = async (id) => JSON.parse(await fsp.readFile(path.join(paths.runsDir, id + ".json"), "utf8").catch(() => "null"));
  assert.equal((await read(recent.run.run_id)).archived_at, undefined);
  assert.equal((await read(broken.run.run_id)).archived_at, undefined);
  assert.ok((await read(deliverable.run.run_id)).archived_at);
  // Past the window it was folded (and, being expired, its record and day file are gone in the same pass).
  assert.equal(await read(stale.run.run_id), null);
  // The mark itself: a run folded without a result says so in its day-file line.
  const marked = await terminalRunFixture(paths, { outcome: null });
  const merged = await mergeRun(paths, marked.run.run_id, { undelivered: true });
  const lines = await readArchive(merged.archive_file);
  assert.equal(lines.find((line) => line.type === "run" && line.run_id === marked.run.run_id).undelivered, true);
  assert.match(formatPruneSummary(summary), /2 條還沒交付結果，這次不歸檔/);
  // Without a deliverer (any caller), an undelivered run inside the window is still left alone.
  const again = await prune(paths, { config: { retention: { days: 15 } } });
  assert.ok(again.undelivered.includes(recent.run.run_id));
});

test("T0-11 C3 prune also drops reviewer check day files past the window and keeps the recent ones and today", async (t) => {
  const { paths } = await runtime(t);
  const now = Date.now();
  const dir = probeAuditDir(paths);
  await fsp.mkdir(dir, { recursive: true });
  const keys = { old: localDateKey(now - 16 * DAY_MS), recent: localDateKey(now - 14 * DAY_MS), today: localDateKey(now) };
  for (const key of Object.values(keys)) await fsp.writeFile(path.join(dir, key + ".jsonl"), "{}\n");
  const summary = await prune(paths, { config: { retention: { days: 15 } }, clock: () => now });
  assert.equal(summary.probe_audit_files_deleted, 1);
  assert.equal(await fileExists(path.join(dir, keys.old + ".jsonl")), false);
  assert.equal(await fileExists(path.join(dir, keys.recent + ".jsonl")), true);
  assert.equal(await fileExists(path.join(dir, keys.today + ".jsonl")), true);
  assert.match(formatPruneSummary(summary), /清掉 1 天份設定檢查紀錄/);
});

test("T0-11 E3 prune retires the old single reviewer record by age and refuses an invalid setting", async (t) => {
  const { paths } = await runtime(t);
  const now = Date.now();
  const legacy = path.join(paths.configRoot, "reviewer-probe-audit.json");
  await fsp.writeFile(legacy, "{}\n");
  const old = new Date(now - 16 * DAY_MS);
  await fsp.utimes(legacy, old, old);
  await assert.rejects(prune(paths, { config: { retention: { days: 0 } }, clock: () => now }), RetentionConfigError);
  assert.equal(await fileExists(legacy), true, "an invalid setting deletes nothing");
  const summary = await prune(paths, { config: { retention: { days: 15 } }, clock: () => now });
  assert.equal(summary.probe_audit_files_deleted, 1);
  assert.equal(await fileExists(legacy), false);
});
