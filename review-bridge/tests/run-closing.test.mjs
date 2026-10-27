// Keeps the person's database out of these tests (see the fixture).
import "./fixtures/isolatedDataHome.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { writeJson } from "../service/records/fileStore.mjs";
import { consumeRun, createRunRuntimeState, readRun, recordRunState, RunEndedError, stopRunRecord } from "../service/records/runStore.mjs";
import { getBridgePaths } from "../utils/paths.mjs";
import { authorizeWorkPackage, cancelWorkPackage, createWorkPackagePlan } from "../features/workOrder/workPackage.mjs";
import { callStamp, workLockFile } from "../features/workOrder/processRecords.mjs";
import { runBoundedResume, stopRun, validateBoundedResume } from "../features/workOrder/writerLoop.mjs";
import { deliverOutcome } from "../features/workOrder/delivery.mjs";

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A throwaway project with Bridge configured, and plans for inline tasks (no model call is involved).
async function project(t) {
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-closing-"));
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  const paths = getBridgePaths(repoRoot, bridgeRoot, { privateRootName: ".review-bridge" });
  await writeJson(paths.bridgeConfigPath, { schema_version: 4, active_runs: "derive_from_run_projections" });
  await writeJson(paths.policyOverridePath, { schema_version: 5 });
  await fsp.writeFile(path.join(repoRoot, "README.md"), "# demo\n");
  return paths;
}

async function planFor(paths, name) {
  return await createWorkPackagePlan({
    paths, task: "Update README.md only.", owner: "Fortes", workPackage: name, breakpoint: "return after review",
    allowedPaths: "README.md", rounds: 1, callTimeout: 60_000, outPath: path.join(paths.queueRoot, name + ".plan.json"),
  });
}

// Authorizes a plan; the work lock it hands over is let go, as no loop works the run here.
async function authorized(paths, plan) {
  const authorization = await authorizeWorkPackage({ paths, planPath: plan.plan_path, approval: plan.plan_sha256, executionMode: "fake_cli" });
  await authorization.workLock();
  return authorization;
}

// One authorized, running run in a throwaway project.
async function runningRun(t) {
  const paths = await project(t);
  return { paths, runId: (await authorized(paths, await planFor(paths, "closing"))).run.run_id };
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
  assert.equal(run.conclusion, "cancelled");
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
  assert.equal(run.conclusion, "success");
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
  assert.equal((await readRun(paths, runId)).conclusion, "cancelled");
});

// The decision must be made inside the run lock: stop's own early read of the run cannot see a PASS
// written between that read and the lock. Here the PASS lands first and the locked stop is called
// directly, as it would be after that early read had seen a running run.
test("the stop written inside the run lock refuses a run a PASS has already ended", async (t) => {
  const { paths, runId } = await runningRun(t);
  await recordRunState(paths, runId, passState);
  await assert.rejects(stopRunRecord(paths, runId), (error) => error instanceof RunEndedError && error.reason === "pass");
  await consumeRun(paths, runId, "review_pass", passGate);
  const run = await readRun(paths, runId);
  assert.equal(run.conclusion, "success");
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
  assert.equal(run.conclusion, "cancelled");
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
  const successor = (await authorized(paths, await planFor(paths, "closing-next"))).run.run_id;
  const replaced = (await authorized(paths, await planFor(paths, "closing-old"))).run.run_id;
  await stopRunRecord(paths, replaced, { closedReason: "superseded", supersededBy: successor });
  const late = await fsp.readFile((await deliverOutcome({ paths, runId: replaced, notify: false })).result_path, "utf8");
  assert.match(late, new RegExp("started again as a new version: run " + successor + " replaced this one\."));
});

// Decision 2026-10-17: runs work side by side, each under its own work lock, taken before the run
// exists. A start that cannot take it leaves nothing; one that fails after the run exists closes it.
test("a start whose run is locked by another process creates nothing", async (t) => {
  const paths = await project(t);
  const plan = await planFor(paths, "locked");
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { windowsHide: true, stdio: "ignore" });
  t.after(() => { try { holder.kill(); } catch {} });
  await writeJson(workLockFile(paths, plan.proposed_run_id), { pid: holder.pid });
  await assert.rejects(authorizeWorkPackage({ paths, planPath: plan.plan_path, approval: plan.plan_sha256, executionMode: "fake_cli" }),
    /already being started or worked by another process; nothing was created/);
  await assert.rejects(readRun(paths, plan.proposed_run_id));
});

test("a run whose checks fail after it was created is closed and its lock let go, never left running", async (t) => {
  const paths = await project(t);
  const plan = await planFor(paths, "failing");
  const authorization = await authorizeWorkPackage({ paths, planPath: plan.plan_path, approval: plan.plan_sha256, executionMode: "fake_cli" });
  const runId = authorization.run.run_id;
  await assert.rejects(runBoundedResume({
    paths, control: authorization.control, adapter: {}, promptPath: path.join(paths.privateRoot, "missing-prompt.txt"),
    rounds: 1, callTimeout: 60_000, startNewSession: true, runtimeState: createRunRuntimeState(paths, runId), workLock: authorization.workLock,
  }), /Prompt file is missing/);
  const run = await readRun(paths, runId);
  assert.equal(run.closed_reason, "controller_failure");
  assert.ok(run.closed_at);
  await assert.rejects(fsp.access(workLockFile(paths, runId)));
});

test("with several runs active, cancel names the one to cancel and leaves the others running", async (t) => {
  const paths = await project(t);
  const first = (await authorized(paths, await planFor(paths, "first"))).run.run_id;
  const second = (await authorized(paths, await planFor(paths, "second"))).run.run_id;
  await assert.rejects(cancelWorkPackage({ paths }), /Several runs are active; name the one to cancel with --run/);
  await cancelWorkPackage({ paths, runId: second });
  assert.equal((await readRun(paths, second)).closed_reason, "cancelled");
  assert.equal((await readRun(paths, first)).status, "in_progress");
  await assert.rejects(cancelWorkPackage({ paths, runId: second }), /No active run/);
});

test("only this run's own review jobs hold its start back; another run's review does not", async (t) => {
  const paths = await project(t);
  const authorization = await authorized(paths, await planFor(paths, "queued"));
  const check = () => validateBoundedResume({
    paths, control: authorization.control, adapter: { resolveExecutable: async () => "claude" },
    promptPath: authorization.promptPath, rounds: 1, callTimeout: 60_000,
  });
  await fsp.mkdir(paths.pendingDir, { recursive: true });
  await writeJson(path.join(paths.pendingDir, "other.json"), { authorization: { run_id: "5e3b1a7c-2d4f-4a6b-8c9d-0e1f2a3b4c5d" } });
  assert.equal((await check()).valid, true);
  await writeJson(path.join(paths.pendingDir, "own.json"), { authorization: { run_id: authorization.run.run_id } });
  await assert.rejects(check(), /This run's review queue must be idle/);
});

test("two runs' calls in the same millisecond never share a file name", () => {
  const first = callStamp("1a2b3c4d-0000-4000-8000-000000000000");
  const second = callStamp("5e6f7a8b-0000-4000-8000-000000000000");
  assert.match(first, /^\d{8}T\d{9}Z-r1a2b3c4d$/);
  assert.notEqual(first.slice(-9), second.slice(-9));
});
