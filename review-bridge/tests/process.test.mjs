// Keeps the person's database out of these tests (see the fixture).
import "./fixtures/isolatedDataHome.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { spawn, spawnSync } from "node:child_process";

import {
  descendantsOf, isPidAlive, killProcessTree, posixAncestors, protectedPidVerdict, protectedSetOrNull, runProcess, treeVerdict,
} from "../service/agentCli/process.mjs";

// POSIX: a CLI started directly keeps the caller's process group, so its sub-agents' commands are
// found by walking `ps` rows (pid, ppid). Children come before grandchildren; unrelated processes
// and a cycle in the listing are ignored.
test("descendantsOf walks the ps listing breadth first and ignores everything else", () => {
  const rows = [[100, 1], [200, 100], [201, 100], [300, 200], [400, 300], [500, 1], [600, 500], [100, 400]];
  assert.deepEqual(descendantsOf(100, rows), [200, 201, 300, 400]);
  assert.deepEqual(descendantsOf(500, rows), [600]);
  assert.deepEqual(descendantsOf(999, rows), []);
});

test("a pid that is not running is reported without signalling anything", async () => {
  assert.deepEqual(await killProcessTree(0), { killed: false, reason: "invalid_pid" });
  const result = await killProcessTree(2_147_483_000, { platform: "linux", ps: "definitely-not-a-ps-binary", ancestors: () => [] });
  assert.equal(result.reason, "ps_unavailable");
});

// A child that ends while onSpawn is still writing its record must still be heard closing; before
// the fix the close event fired with no listener and the caller waited forever.
test("runProcess hears a child that exits while onSpawn is still busy", { timeout: 15_000 }, async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-process-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const result = await runProcess({
    invocation: { command: process.execPath, args: ["-e", "process.stdout.write('done')"] },
    cwd: dir,
    stdoutPath: path.join(dir, "out.log"),
    stderrPath: path.join(dir, "err.log"),
    onSpawn: () => new Promise((resolve) => setTimeout(resolve, 1_000)),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(await fsp.readFile(path.join(dir, "out.log"), "utf8"), "done");
});

// If recording the pid fails, no stop command can find the process; runProcess must not leave it running.
test("a failing onSpawn kills the started child before the error goes up", { timeout: 30_000 }, async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-process-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  let pid = null;
  const startedAt = Date.now();
  await assert.rejects(runProcess({
    invocation: { command: process.execPath, args: ["-e", "setTimeout(() => {}, 20000)"] },
    cwd: dir,
    stdoutPath: path.join(dir, "out.log"),
    stderrPath: path.join(dir, "err.log"),
    onSpawn: async (childPid) => { pid = childPid; throw new Error("process record could not be written"); },
  }), /process record could not be written/);
  assert.ok(Number.isInteger(pid));
  assert.equal(isPidAlive(pid), false);
  assert.ok(Date.now() - startedAt < 15_000, "the child was waited for instead of killed");
});

// RC3-LINUX-00: before any signal, the pid itself is checked, then this process's ancestry is read,
// and only then is the subtree listed. Every seam is counted, so "nothing was listed, read or
// signalled" is shown, not assumed. The seams make the POSIX order testable on any host.
function seams({ ancestors = () => [], rows = () => [] } = {}) {
  const calls = { ancestors: 0, rows: 0, signals: [] };
  return {
    calls,
    options: {
      platform: "linux",
      ancestors: (pid) => { calls.ancestors += 1; return ancestors(pid); },
      processRows: () => { calls.rows += 1; return rows(); },
      signal: (pid, name) => { calls.signals.push([pid, name]); },
    },
  };
}

function sleeper(t) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { windowsHide: true, stdio: "ignore" });
  t.after(() => { try { child.kill(); } catch {} });
  return child;
}

test("the system's first process, Bridge itself and its parent are refused before anything is listed, read or signalled", async () => {
  for (const pid of [1, process.pid, process.ppid]) {
    const { calls, options } = seams();
    assert.deepEqual(await killProcessTree(pid, options), { killed: false, reason: "refused_pid", scope: "none" }, "pid " + pid);
    assert.deepEqual(calls, { ancestors: 0, rows: 0, signals: [] }, "pid " + pid);
  }
  assert.equal(protectedPidVerdict(1, { platform: "linux" }), "refused_pid");
  assert.equal(protectedPidVerdict(2, { platform: "linux", self: 10, parent: 9 }), null);
  // Windows: the system's own processes (pid 4 and below), Bridge and its parent; taskkill is never run.
  for (const pid of [4, process.pid, process.ppid]) {
    const result = await killProcessTree(pid, { platform: "win32", taskkill: "definitely-not-taskkill" });
    assert.deepEqual(result, { killed: false, reason: "refused_pid", scope: "none" }, "win32 pid " + pid);
  }
});

test("an ancestor of Bridge is refused, and an ancestry that cannot be read refuses every stop", async (t) => {
  const child = sleeper(t);
  const ancestor = seams({ ancestors: () => [child.pid, 1] });
  assert.equal((await killProcessTree(child.pid, ancestor.options)).reason, "refused_pid");
  assert.deepEqual([ancestor.calls.rows, ancestor.calls.signals.length], [0, 0]);
  const unknown = seams({ ancestors: () => null });
  assert.deepEqual(await killProcessTree(child.pid, unknown.options), { killed: false, reason: "ancestry_unknown", scope: "none" });
  assert.deepEqual([unknown.calls.rows, unknown.calls.signals.length], [0, 0], "no listing and no signal");
  assert.equal(isPidAlive(child.pid), true);
  assert.equal(protectedSetOrNull({ self: 50, ancestors: () => null }), null);
  assert.deepEqual([...protectedSetOrNull({ self: 50, ancestors: () => [40, 1] })].sort((a, b) => a - b), [1, 40, 50]);
});

test("the ancestry is walked to the first process, and a chain that breaks or runs too deep is unknown", () => {
  const parents = new Map([[500, 400], [400, 300], [300, 1]]);
  assert.deepEqual(posixAncestors(500, { readParent: (pid) => parents.get(pid) ?? null }), [400, 300, 1]);
  assert.equal(posixAncestors(500, { readParent: (pid) => (pid === 400 ? null : parents.get(pid)) }), null);
  assert.equal(posixAncestors(500, { readParent: (pid) => pid + 1, limit: 8 }), null);
  assert.deepEqual(posixAncestors(1, { readParent: () => 0 }), []);
});

test("a process list that cannot be read refuses the stop and signals nothing, even for a live child", async (t) => {
  const child = sleeper(t);
  const signals = [];
  const result = await killProcessTree(child.pid, {
    platform: "linux", ancestors: () => [], ps: "definitely-not-a-ps-binary", signal: (pid, name) => signals.push([pid, name]),
  });
  assert.deepEqual(result, { killed: false, reason: "ps_unavailable", scope: "none" });
  assert.deepEqual(signals, []);
  assert.equal(isPidAlive(child.pid), true);
});

test("a subtree that holds Bridge itself is refused whole: nothing is signalled and Bridge's child lives", async (t) => {
  const target = sleeper(t);
  const bridgeChild = sleeper(t);
  const { calls, options } = seams({ rows: () => [[process.pid, target.pid], [bridgeChild.pid, process.pid]] });
  assert.deepEqual(await killProcessTree(target.pid, options), { killed: false, reason: "refused_tree", scope: "none" });
  assert.deepEqual(calls.signals, []);
  assert.equal(isPidAlive(bridgeChild.pid), true);
  assert.equal(isPidAlive(target.pid), true);
  assert.equal(treeVerdict([7, 8], new Set([1, 8])), "refused_tree");
  assert.equal(treeVerdict([7], new Set([1, 8])), null);
});

// A zombie: ended, but its parent (this test, blocked) has not reaped it yet. POSIX only.
test("a child that ended but was not yet reaped is not running", { skip: process.platform === "win32" && "Windows has no zombie processes" }, () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  spawnSync("sleep", ["1"]);
  assert.equal(isPidAlive(child.pid), false);
});
