import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getBridgePaths } from "../review-bridge/utils/paths.mjs";

test("Bridge state lives only in the neutral folder; a missing or provider folder is refused", () => {
  const target = path.resolve("sample-project");
  const runtime = path.resolve("review-bridge-folder", "review-bridge");
  const neutral = getBridgePaths(target, runtime, { privateRootName: ".review-bridge" });

  assert.equal(neutral.privateRoot, path.join(target, ".review-bridge"));
  assert.equal(neutral.bridgeConfigPath, path.join(target, ".review-bridge", "bridge.json"));
  assert.throws(() => getBridgePaths(target, runtime), /Bridge private root is not given/);
  assert.throws(() => getBridgePaths(target, runtime, { privateRootName: ".claude" }), /Unsupported Bridge private root: \.claude/);
  assert.throws(() => getBridgePaths(target, runtime, { privateRootName: ".codex" }), /Unsupported Bridge private root/);
  assert.throws(() => getBridgePaths(target, runtime, { privateRootName: "../outside" }), /Unsupported Bridge private root/);
});

// RC3-FIX-02: the project holds its settings, work orders and result copies; the service's state and
// each run's logs live outside it, under the project's id.
test("the project keeps settings, work orders and results; state and logs are outside it, named by the project's id", async (t) => {
  const target = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-layout-"));
  t.after(() => fsp.rm(target, { recursive: true, force: true }));
  const home = path.join(target, "..", path.basename(target) + "-home");
  const env = { REVIEW_BRIDGE_DATA_HOME: home };
  const paths = getBridgePaths(target, path.resolve("review-bridge"), { privateRootName: ".review-bridge", env });
  for (const [key, file] of [["bridgeConfigPath", "bridge.json"], ["policyOverridePath", "policy.override.json"], ["rulesPath", "rules.md"], ["resultsDir", "results"]]) {
    assert.equal(paths[key], path.join(target, ".review-bridge", file), key);
  }
  assert.throws(() => paths.stateRoot, /This folder is not set up for Review Bridge\. Run: review-bridge init/);
  await fsp.mkdir(paths.privateRoot);
  await fsp.writeFile(paths.bridgeConfigPath, JSON.stringify({ schema_version: 4 }));
  assert.throws(() => getBridgePaths(target, path.resolve("review-bridge"), { privateRootName: ".review-bridge", env }).runsDir, /Run: review-bridge upgrade/);
  const id = "0a1b2c3d-0000-4000-8000-000000000001";
  await fsp.writeFile(paths.bridgeConfigPath, JSON.stringify({ schema_version: 4, project_id: id }));
  const named = getBridgePaths(target, path.resolve("review-bridge"), { privateRootName: ".review-bridge", env });
  assert.equal(named.stateRoot, path.join(home, "projects", id));
  assert.equal(named.runsDir, path.join(home, "projects", id, "runs"));
  assert.equal(named.installManifestPath, path.join(home, "projects", id, "review-bridge-install.json"));
  assert.equal(named.runLogDir("0a1b2c3d-0000-4000-8000-0000000000aa"), path.join(home, "logs", id, "0a1b2c3d-0000-4000-8000-0000000000aa"));
  assert.throws(() => named.runLogDir("../escape"), /Run id is invalid/);
});
