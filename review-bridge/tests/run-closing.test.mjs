import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { writeJson } from "../service/records/fileStore.mjs";
import { consumeRun, readRun, recordRunState, RunEndedError, stopRunRecord } from "../service/records/runStore.mjs";
import { getBridgePaths } from "../utils/paths.mjs";
import { authorizeWorkPackage, createWorkPackagePlan } from "../features/workOrder/workPackage.mjs";
import { stopRun } from "../features/workOrder/writerLoop.mjs";
import { deliverOutcome } from "../features/workOrder/delivery.mjs";

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// One authorized, running run in a throwaway project (an inline task: no model call is involved).
async function runningRun(t) {
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-closing-"));
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  const paths = getBridgePaths(repoRoot, bridgeRoot, { privateRootName: ".review-bridge" });
  await writeJson(paths.bridgeConfigPath, { schema_version: 4, active_runs: "derive_from_run_projections" });
  await writeJson(paths.policyOverridePath, { schema_version: 4 });
  await fsp.writeFile(path.join(repoRoot, "README.md"), "# demo\n");
  const plan = await createWorkPackagePlan({
    paths, task: "Update README.md only.", owner: "Fortes", workPackage: "closing", breakpoint: "return after review",
    changeTypes: "docs", allowedPaths: "README.md", maxCalls: 1, maxMinutes: 1, outPath: path.join(paths.queueRoot, "closing.plan.json"),
  });
  const authorization = await authorizeWorkPackage({ paths, planPath: plan.plan_path, approval: plan.plan_sha256, executionMode: "fake_cli" });
  return { paths, runId: authorization.run.run_id };
}

const passState = { status: "pass", review_gate: "PASS", call: 1, updated_at: new Date().toISOString() };
const passGate = { review_gate: "PASS", hard_stop_required: false };

// Codex review of the stop race: stop and PASS can arrive in either order. Whichever closes the
// run first wins; the other neither changes its status nor its reason.

test("stop first: a PASS that arrives later is refused and the run stays stopped", async (t) => {
  const { paths, runId } = await runningRun(t);
  assert.equal((await stopRun(paths, runId)).exitCode, 0);
  await assert.rejects(recordRunState(paths, runId, passState), /already closed/);
  await consumeRun(paths, runId, "review_pass", passGate);
  const run = await readRun(paths, runId);
  assert.equal(run.status, "stopped");
  assert.equal(run.closed_reason, "stopped");
});

test("PASS first: a later stop reports the work already ended, and the PASS still closes normally", async (t) => {
  const { paths, runId } = await runningRun(t);
  await recordRunState(paths, runId, passState);
  const stopped = await stopRun(paths, runId);
  assert.equal(stopped.exitCode, 1);
  assert.match(stopped.line, /已經結束：pass/);
  await consumeRun(paths, runId, "review_pass", passGate);
  const run = await readRun(paths, runId);
  assert.equal(run.status, "pass");
  assert.equal(run.closed_reason, "review_pass");
  assert.ok(run.closed_at);
});

test("a stop whose process cannot be killed says so, keeps the pid for a retry, and does not report success", async (t) => {
  const { paths, runId } = await runningRun(t);
  // A process no test can kill: the system process on Windows, init elsewhere.
  const pid = process.platform === "win32" ? 4 : 1;
  await fsp.mkdir(paths.runLocksDir, { recursive: true });
  const record = path.join(paths.runLocksDir, runId + ".process.json");
  await writeJson(record, { pid, role: "reviewer", provider: "codex", call: 1 });
  const stopped = await stopRun(paths, runId);
  assert.notEqual(stopped.exitCode, 0);
  assert.match(stopped.line, /停止未完成/);
  assert.equal((await fsp.readFile(record, "utf8")).includes(String(pid)), true);
  assert.equal((await readRun(paths, runId)).status, "stopped");
});

// The decision must be made inside the run lock: stop's own early read of the run cannot see a PASS
// written between that read and the lock. Here the PASS lands first and the locked stop is called
// directly, as it would be after that early read had seen a running run.
test("the stop written inside the run lock refuses a run a PASS has already ended", async (t) => {
  const { paths, runId } = await runningRun(t);
  await recordRunState(paths, runId, passState);
  await assert.rejects(stopRunRecord(paths, runId), (error) => error instanceof RunEndedError && error.status === "pass");
  await consumeRun(paths, runId, "review_pass", passGate);
  const run = await readRun(paths, runId);
  assert.equal(run.status, "pass");
  assert.equal(run.closed_reason, "review_pass");
});

// Codex review of the stop fix: "kept for a retry" must really be retryable, and a kill that
// could not be confirmed (killed:false) is never a success, whatever the main pid looks like.

test("a second stop retries the kill it could not finish, without writing the stop again", async (t) => {
  const { paths, runId } = await runningRun(t);
  const record = path.join(paths.runLocksDir, runId + ".process.json");
  await fsp.mkdir(paths.runLocksDir, { recursive: true });
  await writeJson(record, { pid: process.platform === "win32" ? 4 : 1, role: "writer", provider: "claude", call: 1 });
  assert.equal((await stopRun(paths, runId)).exitCode, 2);
  const closedAt = (await readRun(paths, runId)).closed_at;
  const again = await stopRun(paths, runId);
  assert.equal(again.exitCode, 2, "the second stop tried the kill again instead of answering 'already ended'");
  assert.match(again.line, /停止未完成/);
  // The process that survived is gone by now (here: a killable stand-in); the retry finishes the stop.
  const { spawn } = await import("node:child_process");
  const survivor = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { windowsHide: true, stdio: "ignore" });
  t.after(() => { try { survivor.kill(); } catch {} });
  await writeJson(record, { pid: survivor.pid, role: "writer", provider: "claude", call: 1 });
  const finished = await stopRun(paths, runId);
  assert.equal(finished.exitCode, 0);
  const { isPidAlive } = await import("../service/agentCli/process.mjs");
  assert.equal(isPidAlive(survivor.pid), false);
  await assert.rejects(fsp.access(record));
  const run = await readRun(paths, runId);
  assert.equal(run.status, "stopped");
  assert.equal(run.closed_at, closedAt);
});

test("a kill reported as failed is not a stop, even when the main process is already gone", async (t) => {
  const { paths, runId } = await runningRun(t);
  const { spawnSync } = await import("node:child_process");
  const gone = spawnSync(process.execPath, ["-e", ""], { windowsHide: true }).pid;
  const record = path.join(paths.runLocksDir, runId + ".process.json");
  await fsp.mkdir(paths.runLocksDir, { recursive: true });
  await writeJson(record, { pid: gone, role: "writer", provider: "claude", call: 1 });
  // A tree walk that failed after the main process died: its children may still run.
  const failedWalk = async () => ({ killed: false, reason: "taskkill_failed:1", scope: "pid", parent_alive: false });
  const stopped = await stopRun(paths, runId, { kill: failedWalk });
  assert.equal(stopped.exitCode, 2);
  assert.match(stopped.line, /停止未完成/);
  await fsp.access(record);
});

test("a process started after the stop that cannot be killed is not ignored by the calling side", async (t) => {
  const { paths, runId } = await runningRun(t);
  assert.equal((await stopRun(paths, runId)).exitCode, 0);
  const { recordProcessOrKill } = await import("../features/workOrder/processRecords.mjs");
  const pid = process.platform === "win32" ? 4 : 1;
  await assert.rejects(recordProcessOrKill(paths, runId, { pid, role: "writer", provider: "claude", call: 1 }), /could not be killed/);
  // Its record stays, so a later stop can try again.
  await fsp.access(path.join(paths.runLocksDir, runId + ".process.json"));
});

// Codex review of the new-version start: the old run's own work-start may deliver as soon as the
// locked stop is written, before stopRun records its event. The new run is named from the record.
test("a run stopped for a new start names that run from its own record, and says it replaced this one only once it exists", async (t) => {
  const { paths, runId } = await runningRun(t);
  const next = "0f6c7a1e-3b2d-4c8e-9a51-6d2e8f4b7c90";
  await stopRunRecord(paths, runId, { closedReason: "superseded", supersededBy: next });
  assert.equal((await readRun(paths, runId)).superseded_by, next);
  const early = await fsp.readFile((await deliverOutcome({ paths, runId, notify: false })).result_path, "utf8");
  assert.match(early, new RegExp("started again as a new version: run " + next + "\. That run had not been created when this result was written"));
  assert.doesNotMatch(early, /replaced this one/);

  // A second stopped run whose new start did get its run.
  const plan = await createWorkPackagePlan({
    paths, task: "Update README.md only.", owner: "Fortes", workPackage: "closing-next", breakpoint: "return after review",
    changeTypes: "docs", allowedPaths: "README.md", maxCalls: 1, maxMinutes: 1, outPath: path.join(paths.queueRoot, "closing-next.plan.json"),
  });
  const successor = (await authorizeWorkPackage({ paths, planPath: plan.plan_path, approval: plan.plan_sha256, executionMode: "fake_cli" })).run.run_id;
  const other = await createWorkPackagePlan({
    paths, task: "Update README.md only.", owner: "Fortes", workPackage: "closing-old", breakpoint: "return after review",
    changeTypes: "docs", allowedPaths: "README.md", maxCalls: 1, maxMinutes: 1, outPath: path.join(paths.queueRoot, "closing-old.plan.json"),
  });
  const replaced = (await authorizeWorkPackage({ paths, planPath: other.plan_path, approval: other.plan_sha256, executionMode: "fake_cli" })).run.run_id;
  await stopRunRecord(paths, replaced, { closedReason: "superseded", supersededBy: successor });
  const late = await fsp.readFile((await deliverOutcome({ paths, runId: replaced, notify: false })).result_path, "utf8");
  assert.match(late, new RegExp("started again as a new version: run " + successor + " replaced this one\."));
});
