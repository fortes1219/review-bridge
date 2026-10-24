import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { getBridgePaths } from "../review-bridge/utils/paths.mjs";

test("Bridge state lives only in the neutral folder; a missing or provider folder is refused", () => {
  const target = path.resolve("sample-project");
  const runtime = path.resolve("review-bridge-folder", "review-bridge");
  const neutral = getBridgePaths(target, runtime, { privateRootName: ".review-bridge" });

  assert.equal(neutral.privateRoot, path.join(target, ".review-bridge"));
  assert.equal(neutral.bridgeConfigPath, path.join(target, ".review-bridge", "review-bridge", "bridge.json"));
  assert.throws(() => getBridgePaths(target, runtime), /Bridge private root is not given/);
  assert.throws(() => getBridgePaths(target, runtime, { privateRootName: ".claude" }), /Unsupported Bridge private root: \.claude/);
  assert.throws(() => getBridgePaths(target, runtime, { privateRootName: ".codex" }), /Unsupported Bridge private root/);
  assert.throws(() => getBridgePaths(target, runtime, { privateRootName: "../outside" }), /Unsupported Bridge private root/);
});
