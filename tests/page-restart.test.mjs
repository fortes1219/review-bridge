import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";

import { didNotRestart, startPageServiceDetailed } from "../installer/neutral-install.mjs";

// RC3.1-PAGE-01. The installer restarts the page service through `up`. Both `up` and the one check of
// whether the page runs are seams answered here, so nothing is started and nothing depends on timing
// (CI ubuntu, neutral-upgrade "a failed upgrade whose page service does not come back …": "up returned 0
// but the service is not answering").
const target = os.tmpdir();
const upSaid = (status, stdout = "", stderr = "") => () => ({ status, signal: null, error: undefined, stdout, stderr });

test("up exits 0: the page service is up, and the page is not asked again even when that ask would time out", async () => {
  let asked = 0;
  const outcome = await startPageServiceDetailed(target, { runUp: upSaid(0, "Bridge is running at http://localhost:8080/\n"), checkPage: async () => { asked += 1; return false; } });
  assert.deepEqual(outcome, { running: true, reason: null });
  assert.equal(asked, 0);
});

test("up exits non-zero: not up, with its exit and last line; up timing out says so", async () => {
  const failed = await startPageServiceDetailed(target, { runUp: upSaid(2, "starting\nBridge did not start: pid_dead\n", "") });
  assert.deepEqual(failed, { running: false, reason: "up exited 2 | Bridge did not start: pid_dead" });
  const timedOut = await startPageServiceDetailed(target, { runUp: () => ({ status: null, signal: "SIGTERM", error: Object.assign(new Error("spawnSync node ETIMEDOUT"), { code: "ETIMEDOUT" }), stdout: "", stderr: "" }) });
  assert.deepEqual(timedOut, { running: false, reason: "up timed out" });
});

test("each reason the page did not answer reaches the person's message", async () => {
  for (const reason of ["no_session", "pid_dead", "timeout", "unreachable", "wrong_service"]) {
    const outcome = await startPageServiceDetailed(target, { runUp: upSaid(2, "Bridge did not start: " + reason + "\n") });
    assert.equal(outcome.running, false);
    assert.equal(didNotRestart(outcome), "did not restart: up exited 2 | Bridge did not start: " + reason);
  }
});
