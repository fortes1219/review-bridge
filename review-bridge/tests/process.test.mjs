import assert from "node:assert/strict";
import test from "node:test";

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { descendantsOf, isPidAlive, killProcessTree, runProcess } from "../service/agentCli/process.mjs";

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
  const result = await killProcessTree(2_147_483_000, { platform: "linux", ps: "definitely-not-a-ps-binary" });
  assert.equal(result.reason, "not_running");
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
