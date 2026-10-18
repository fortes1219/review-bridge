import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { writeJson } from "../service/records/fileStore.mjs";
import { consumeRun, readRun, recordRunState, RunEndedError, stopRunRecord } from "../service/records/runStore.mjs";
import { getBridgePaths } from "../utils/paths.mjs";
import { authorizeV4WorkPackage, createV4WorkPackagePlan } from "../features/workOrder/workPackage.mjs";
import { stopRun } from "../features/workOrder/writerLoop.mjs";

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// One authorized, running run in a throwaway project (an inline task: no model call is involved).
async function runningRun(t) {
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-closing-"));
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  const paths = getBridgePaths(repoRoot, bridgeRoot, { privateRootName: ".review-bridge" });
  await writeJson(paths.bridgeConfigPath, { schema_version: 4, state_contract: "v4", active_runs: "derive_from_run_projections" });
  await writeJson(paths.policyOverridePath, { schema_version: 4 });
  await fsp.writeFile(path.join(repoRoot, "README.md"), "# demo\n");
  const plan = await createV4WorkPackagePlan({
    paths, task: "Update README.md only.", owner: "Fortes", workPackage: "closing", breakpoint: "return after review",
    changeTypes: "docs", allowedPaths: "README.md", maxCalls: 1, maxMinutes: 1, outPath: path.join(paths.queueRoot, "closing.plan.json"),
  });
  const authorization = await authorizeV4WorkPackage({ paths, planPath: plan.plan_path, approval: plan.plan_sha256, executionMode: "fake_cli" });
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
