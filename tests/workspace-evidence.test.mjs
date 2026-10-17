import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getBridgePaths } from "../review-bridge/utils/paths.mjs";
import {
  createWorkspaceBaseline,
  createWorkspaceDelta,
  matchesAllowedPath,
} from "../review-bridge/features/workOrder/workspaceEvidence.mjs";

test("allowed path matching supports files and directory prefixes", () => {
  assert.equal(matchesAllowedPath("src/App.vue", ["src"]), true);
  assert.equal(matchesAllowedPath("README.md", ["README.md"]), true);
  assert.equal(matchesAllowedPath("src-old/App.vue", ["src"]), false);
});

test("workspace evidence detects add, modify, delete, and scope violations without Git; only the neutral Bridge folder is skipped", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-evidence-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, "src"), { recursive: true });
  await fsp.writeFile(path.join(root, "src", "App.vue"), "<template>before</template>\n", "utf8");
  await fsp.writeFile(path.join(root, "src", "old.ts"), "export const old = true;\n", "utf8");
  await fsp.writeFile(path.join(root, "README.md"), "before\n", "utf8");
  await fsp.mkdir(path.join(root, ".review-bridge", "review-queue"), { recursive: true });
  await fsp.mkdir(path.join(root, ".claude"), { recursive: true });
  await fsp.mkdir(path.join(root, "docs"), { recursive: true });
  await fsp.writeFile(path.join(root, ".review-bridge", "review-queue", "ignored.txt"), "controller state\n", "utf8");
  await fsp.writeFile(path.join(root, ".claude", "settings.local.json"), "{}\n", "utf8");
  await fsp.writeFile(path.join(root, "docs", "handoff.md"), "before\n", "utf8");

  const paths = getBridgePaths(root, path.join(root, ".review-bridge", "tools", "review-bridge"), { privateRootName: ".review-bridge" });
  const baseline = await createWorkspaceBaseline({
    paths,
    planSha256: "a".repeat(64),
    allowedPaths: ["src", "docs"],
  });
  await fsp.writeFile(path.join(root, "src", "App.vue"), "<template>after</template>\n", "utf8");
  await fsp.rm(path.join(root, "src", "old.ts"));
  await fsp.writeFile(path.join(root, "src", "new.ts"), "export const value = 1;\n", "utf8");
  await fsp.writeFile(path.join(root, "README.md"), "after\n", "utf8");
  await fsp.writeFile(path.join(root, ".review-bridge", "review-queue", "ignored.txt"), "changed controller state\n", "utf8");
  await fsp.writeFile(path.join(root, ".claude", "settings.local.json"), "{\"hooks\":{}}\n", "utf8");
  await fsp.writeFile(path.join(root, "docs", "handoff.md"), "after\n", "utf8");

  const evidence = await createWorkspaceDelta({
    paths,
    baselinePath: baseline.baseline_path,
    deltaId: "first-report",
  });
  assert.match(evidence.delta_path, /delta-first-report\.json$/);
  // A provider folder belongs to the project: a change there is evidence, and outside scope.
  assert.deepEqual(evidence.changed_paths, [".claude/settings.local.json", "docs/handoff.md", "README.md", "src/App.vue", "src/new.ts", "src/old.ts"]);
  assert.deepEqual(evidence.scope_violations, [".claude/settings.local.json", "README.md"]);
  const delta = JSON.parse(await fsp.readFile(evidence.delta_path, "utf8"));
  assert.deepEqual(delta.changed_files.map((entry) => entry.change), ["modified", "modified", "modified", "modified", "added", "deleted"]);
  await fsp.access(path.join(evidence.before_files_root, "src", "App.vue"));
  await assert.rejects(fsp.access(path.join(evidence.before_files_root, "README.md")));
});
