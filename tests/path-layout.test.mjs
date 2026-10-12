import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { getBridgePaths } from "../review-bridge/core/paths.mjs";

test("neutral Bridge state is separate from provider-specific directories", () => {
  const target = path.resolve("sample-project");
  const runtime = path.join(target, ".review-bridge", "tools", "review-bridge");
  const neutral = getBridgePaths(target, runtime, { privateRootName: ".review-bridge" });
  const legacy = getBridgePaths(target, runtime);

  assert.equal(neutral.privateRoot, path.join(target, ".review-bridge"));
  assert.equal(neutral.bridgeConfigPath, path.join(target, ".review-bridge", "review-bridge", "bridge.json"));
  assert.equal(legacy.privateRoot, path.join(target, ".claude"));
  assert.notEqual(neutral.authorizationsDir, legacy.authorizationsDir);
  assert.throws(() => getBridgePaths(target, runtime, { privateRootName: "../outside" }), /Unsupported Bridge private root/);
});
