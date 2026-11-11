import assert from "node:assert/strict";
import test from "node:test";

import { waitForOwnerExit } from "../features/setupCheck/pageService.mjs";

// RC3.1-PAGE-03, as supabase/cli c75aea2 packages/stack/src/HostProcess.unit.test.ts:15-168 tests
// waitForOwnerExit: a controllable probe and a controlled clock, no process and no real wait.
function clock() {
  let now = 0;
  return { clock: () => now, sleep: async (milliseconds) => { now += milliseconds; } };
}
function probeOf(states) {
  const calls = [];
  const probe = async (pid) => {
    calls.push(pid);
    const next = states.length > 1 ? states.shift() : states[0];
    if (next instanceof Error) throw next;
    return next;
  };
  return { probe, calls };
}

test("waits for the page service to disappear after an acknowledged shutdown", async () => {
  const { probe, calls } = probeOf([{ state: "present" }, { state: "present" }, { state: "absent" }]);
  await waitForOwnerExit(123, probe, clock());
  assert.deepEqual(calls, [123, 123, 123]);
});

test("retries an inconclusive EPERM probe until the page service is absent", async () => {
  const { probe, calls } = probeOf([{ state: "inconclusive", code: "EPERM" }, { state: "absent" }]);
  await waitForOwnerExit(123, probe, clock());
  assert.equal(calls.length, 2);
});

test("times out with the pid of a page service still present", async () => {
  const { probe } = probeOf([{ state: "present" }]);
  const time = clock();
  await assert.rejects(waitForOwnerExit(456, probe, time), (error) => {
    assert.equal(error.reason, "owner-exit-pending");
    assert.equal(error.pid, 456);
    assert.match(error.message, /process 456 is still running/);
    return true;
  });
  assert.ok(time.clock() >= 5_000);
});

test("times out with the last EPERM diagnostic", async () => {
  const { probe } = probeOf([{ state: "inconclusive", code: "EPERM" }]);
  await assert.rejects(waitForOwnerExit(789, probe, clock()), /process 789 is inaccessible \(EPERM\); its exit is not known/);
});

test("waits for a zombie to be reaped, and accepts one still a zombie when the wait ends", async () => {
  const reaped = probeOf([{ state: "zombie" }, { state: "absent" }]);
  await waitForOwnerExit(123, reaped.probe, clock());
  assert.equal(reaped.calls.length, 2);
  const unreaped = probeOf([{ state: "zombie" }]);
  await waitForOwnerExit(123, unreaped.probe, clock());
  assert.ok(unreaped.calls.length > 1);
});

test("propagates an unexpected probe error without retrying, and refuses an invalid pid before probing", async () => {
  const failing = probeOf([new Error("probe broke")]);
  await assert.rejects(waitForOwnerExit(321, failing.probe, clock()), /probe broke/);
  assert.equal(failing.calls.length, 1);
  const invalid = probeOf([{ state: "absent" }]);
  await assert.rejects(waitForOwnerExit(0, invalid.probe, clock()), (error) => error.reason === "invalid-owner-pid");
  assert.equal(invalid.calls.length, 0);
});
