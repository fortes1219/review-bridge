import assert from "node:assert/strict";
import test from "node:test";

import { descendantsOf, killProcessTree } from "../service/agentCli/process.mjs";

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
