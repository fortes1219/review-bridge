// Keeps the person's database out of these tests (see the fixture).
import "../review-bridge/tests/fixtures/isolatedDataHome.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getBridgePaths } from "../review-bridge/utils/paths.mjs";
import { FORBIDDEN_PATHS } from "../review-bridge/features/workOrder/workPackage.mjs";
import {
  createWorkspaceBaseline,
  createWorkspaceDelta,
  matchesAllowedPath,
  recordWindow,
  snapshotWorkspace,
  startPointStatus,
} from "../review-bridge/features/workOrder/workspaceEvidence.mjs";

const bridgeRoot = path.resolve("review-bridge");

test("allowed path matching supports files and directory prefixes", () => {
  assert.equal(matchesAllowedPath("src/App.vue", ["src"]), true);
  assert.equal(matchesAllowedPath("README.md", ["README.md"]), true);
  assert.equal(matchesAllowedPath("src-old/App.vue", ["src"]), false);
});

// A project with src/, README.md and Bridge's own folder; with Git, one commit and the installer's exclusion.
async function project(t, { git = true } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-evidence-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, "src"), { recursive: true });
  await fsp.writeFile(path.join(root, "src", "App.vue"), "<template>before</template>\n");
  await fsp.writeFile(path.join(root, "src", "old.ts"), "export const old = true;\n");
  await fsp.writeFile(path.join(root, "README.md"), "before\n");
  await fsp.writeFile(path.join(root, ".gitignore"), ".env\nnode_modules/\n.venv/\nbuild/\n");
  await fsp.mkdir(path.join(root, ".review-bridge", "review-queue"), { recursive: true });
  const run = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (git) {
    run("init", "-q");
    await fsp.appendFile(path.join(root, ".git", "info", "exclude"), "\n/.review-bridge/\n");
    run("add", "-A");
    run("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "start");
  }
  const paths = getBridgePaths(root, bridgeRoot, { privateRootName: ".review-bridge" });
  const commit = (message) => { run("add", "-A"); return run("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", message); };
  return { root, paths, run, commit };
}

const write = (root, relative, text) => fsp.mkdir(path.dirname(path.join(root, relative)), { recursive: true }).then(() => fsp.writeFile(path.join(root, relative), text));
const baselineFor = (p, runId, allowedPaths = ["src"]) => createWorkspaceBaseline({ paths: p.paths, planSha256: runId.padEnd(64, "0"), runId, allowedPaths, forbiddenPaths: [...FORBIDDEN_PATHS] });

// One of the run's own calls: the edits inside it are the run's.
async function asCall(p, baseline, runId, edit) {
  const before = await snapshotWorkspace(p.paths, baseline.baseline_path);
  await edit();
  return await recordWindow(p.paths, baseline.baseline_path, { runId, call: 1, phase: "writer", before });
}

async function filesUnder(dir) {
  const found = [];
  const walk = async (current) => {
    for (const entry of await fsp.readdir(current, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else found.push(full);
    }
  };
  await walk(dir);
  return found;
}

test("without Git there is no work proof: nothing is walked or copied, nothing is listed, the scope is unverified", async (t) => {
  const p = await project(t, { git: false });
  const baseline = await baselineFor(p, "run-nogit");
  assert.equal(baseline.mode, "none");
  await write(p.root, "README.md", "after\n");
  const delta = await createWorkspaceDelta({ paths: p.paths, baselinePath: baseline.baseline_path });
  assert.equal(delta.mode, "none");
  assert.deepEqual(delta.changed_paths, []);
  assert.deepEqual(delta.scope_violations, []);
  const record = JSON.parse(await fsp.readFile(delta.delta_path, "utf8"));
  assert.equal(record.scope_status, "unverified");
  // Only Bridge's own JSON records exist: no copy of any project file.
  assert.ok((await filesUnder(baseline.evidence_dir)).every((file) => file.endsWith(".json")));
});

test("with Git the start, a commit made during the run, the hand-off and uncommitted changes are all visible; Git is not touched", async (t) => {
  const p = await project(t);
  const objectsBefore = p.run("count-objects", "-v").stdout;
  const baseline = await baselineFor(p, "run-git");
  assert.equal(baseline.mode, "git");
  await asCall(p, baseline, "run-git", async () => {
    await write(p.root, "src/App.vue", "<template>after</template>\n");
    await fsp.rm(path.join(p.root, "src", "old.ts"));
    await write(p.root, "src/new.ts", "export const value = 1;\n");
  });
  // Bridge never added, staged or stored anything.
  assert.equal(p.run("count-objects", "-v").stdout, objectsBefore);
  assert.equal(p.run("diff", "--cached", "--name-only").stdout, "");
  assert.equal(p.run("stash", "list").stdout, "");
  // Someone commits between calls: the commit is listed and its file is not blamed on the run.
  await write(p.root, "README.md", "edited by a human\n");
  p.commit("human edit");
  const delta = await createWorkspaceDelta({ paths: p.paths, baselinePath: baseline.baseline_path, deltaId: "handoff" });
  const record = JSON.parse(await fsp.readFile(delta.delta_path, "utf8"));
  assert.equal(record.start_point, "ok");
  assert.deepEqual(record.commits_since_start.map((entry) => entry.subject), ["human edit"]);
  assert.deepEqual(record.changed_files.map((entry) => [entry.path, entry.change, entry.attribution]), [
    ["README.md", "modified", "unattributed"],
    ["src/App.vue", "modified", "run"],
    ["src/new.ts", "added", "run"],
    ["src/old.ts", "deleted", "run"],
  ]);
  // README.md is outside the allowed paths but not the run's: its scope is unverified, not a violation.
  assert.deepEqual(delta.scope_violations, []);
  assert.deepEqual(delta.scope_unverified, ["README.md"]);
});

test("a change already there before the run is not the run's unless the run changes it again", async (t) => {
  const p = await project(t);
  await write(p.root, "src/App.vue", "<template>work in progress</template>\n");
  await write(p.root, "notes.txt", "draft\n");
  const baseline = await baselineFor(p, "run-dirty");
  let delta = await createWorkspaceDelta({ paths: p.paths, baselinePath: baseline.baseline_path, deltaId: "untouched" });
  assert.deepEqual(delta.changed_paths, []);
  await asCall(p, baseline, "run-dirty", () => write(p.root, "src/App.vue", "<template>finished</template>\n"));
  delta = await createWorkspaceDelta({ paths: p.paths, baselinePath: baseline.baseline_path, deltaId: "touched" });
  assert.deepEqual(delta.changed_paths, ["src/App.vue"]);
  // The earlier change was recorded by hash only; Git still holds no new object for it.
  assert.equal(p.run("diff", "--cached", "--name-only").stdout, "");
});

test("large ignored folders are not walked or copied; a forbidden ignored file is watched by hash only", { timeout: 60_000 }, async (t) => {
  const p = await project(t);
  for (const folder of ["node_modules/pkg", ".venv/lib", "build/out"]) {
    for (let index = 0; index < 400; index += 1) await write(p.root, folder + "/f" + index + ".js", "x\n");
  }
  await write(p.root, ".env", "SECRET=before\n");
  const baseline = await baselineFor(p, "run-ignored", ["**"]);
  await asCall(p, baseline, "run-ignored", async () => {
    await write(p.root, ".env", "SECRET=after-value\n");
    await write(p.root, "node_modules/pkg/f0.js", "changed\n");
  });
  const delta = await createWorkspaceDelta({ paths: p.paths, baselinePath: baseline.baseline_path, deltaId: "ignored" });
  // node_modules is ignored and not forbidden: not listed. .env is forbidden: listed and refused.
  assert.deepEqual(delta.changed_paths, [".env"]);
  assert.deepEqual(delta.scope_violations, [".env"]);
  const evidence = await filesUnder(baseline.evidence_dir);
  assert.ok(evidence.every((file) => file.endsWith(".json")));
  for (const file of evidence) assert.doesNotMatch(await fsp.readFile(file, "utf8"), /SECRET=/);
});

// Another run's call records count only for a run that exists; this is the minimum a run record holds for that.
async function runRecord(p, runId, closedAt = null) {
  await fsp.mkdir(p.paths.runsDir, { recursive: true });
  await fsp.writeFile(path.join(p.paths.runsDir, runId + ".json"), JSON.stringify({ run_id: runId, created_at: new Date(Date.now() - 60_000).toISOString(), ...(closedAt ? { closed_at: closedAt } : {}) }));
}

test("two runs in one folder: separate calls are each their own; a change while both were working is unattributed", async (t) => {
  const p = await project(t);
  await runRecord(p, "run-a");
  await runRecord(p, "run-b");
  const a = await baselineFor(p, "run-a", ["src"]);
  const b = await baselineFor(p, "run-b", ["src"]);
  await asCall(p, a, "run-a", () => write(p.root, "src/a.ts", "a\n"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await asCall(p, b, "run-b", () => write(p.root, "src/b.ts", "b\n"));
  const ofRun = async (baseline, id) => JSON.parse(await fsp.readFile((await createWorkspaceDelta({ paths: p.paths, baselinePath: baseline.baseline_path, deltaId: id })).delta_path, "utf8"));
  assert.deepEqual((await ofRun(a, "a1")).changed_files.map((entry) => [entry.path, entry.attribution]), [["src/a.ts", "run"], ["src/b.ts", "unattributed"]]);
  assert.deepEqual((await ofRun(b, "b1")).changed_files.map((entry) => [entry.path, entry.attribution]), [["src/a.ts", "unattributed"], ["src/b.ts", "run"]]);
  // Overlapping calls: the same change is seen by both and belongs to neither.
  const beforeA = await snapshotWorkspace(p.paths, a.baseline_path);
  const beforeB = await snapshotWorkspace(p.paths, b.baseline_path);
  await write(p.root, "README.md", "who wrote this?\n");
  await recordWindow(p.paths, a.baseline_path, { runId: "run-a", call: 2, phase: "writer", before: beforeA });
  await recordWindow(p.paths, b.baseline_path, { runId: "run-b", call: 2, phase: "writer", before: beforeB });
  const shared = await ofRun(a, "a2");
  assert.equal(shared.changed_files.find((entry) => entry.path === "README.md").attribution, "unattributed");
  assert.deepEqual(shared.scope_violations, []);
  assert.deepEqual(shared.scope_unverified, ["README.md"]);
});

test("a rewritten history or a switched branch leaves no start to compare against", async (t) => {
  const amended = await project(t);
  const first = await baselineFor(amended, "run-amend");
  assert.equal(await startPointStatus(amended.paths, first.baseline_path), "ok");
  amended.run("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--amend", "-m", "rewritten start");
  assert.equal(await startPointStatus(amended.paths, first.baseline_path), "lost");
  const lost = JSON.parse(await fsp.readFile((await createWorkspaceDelta({ paths: amended.paths, baselinePath: first.baseline_path, deltaId: "lost" })).delta_path, "utf8"));
  assert.equal(lost.start_point, "lost");
  assert.deepEqual(lost.changed_files, []);
  const switched = await project(t);
  const second = await baselineFor(switched, "run-switch");
  switched.run("checkout", "-q", "-b", "elsewhere");
  assert.equal(await startPointStatus(switched.paths, second.baseline_path), "lost");
});

// Codex review round 2 of the work proof: a later change by another run, forged or rewritten
// records, and Git failures. Each is a boundary the proof must hold.

test("run A changes a file and run B changes it again later: the file is not A's", async (t) => {
  const p = await project(t);
  await runRecord(p, "run-a");
  await runRecord(p, "run-b");
  const a = await baselineFor(p, "run-a", ["src"]);
  const b = await baselineFor(p, "run-b", ["src"]);
  await asCall(p, a, "run-a", () => write(p.root, "src/App.vue", "<template>by A</template>\n"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await asCall(p, b, "run-b", () => write(p.root, "src/App.vue", "<template>by B</template>\n"));
  const of = async (baseline, id) => JSON.parse(await fsp.readFile((await createWorkspaceDelta({ paths: p.paths, baselinePath: baseline.baseline_path, deltaId: id })).delta_path, "utf8"));
  assert.equal((await of(a, "a")).changed_files.find((entry) => entry.path === "src/App.vue").attribution, "unattributed");
  assert.equal((await of(b, "b")).changed_files.find((entry) => entry.path === "src/App.vue").attribution, "run");
  // Changed again outside any call after B's: not what B left either.
  await write(p.root, "src/App.vue", "<template>by hand</template>\n");
  assert.equal((await of(b, "b2")).changed_files.find((entry) => entry.path === "src/App.vue").attribution, "unattributed");
});

// No other run's record can be verified here (Codex round 3): whether that run exists or not, an
// overlapping record never clears an out-of-scope change. It only raises doubt, which leaves the
// change unverified, and an unverified scope is never delivered as passed (writer loop).
test("another run's record, real or forged, never clears an out-of-scope change; it leaves the scope unverified", async (t) => {
  for (const [label, makeRun] of [["existing run", true], ["missing run", false]]) {
    const p = await project(t);
    await runRecord(p, "run-a");
    if (makeRun) await runRecord(p, "run-b");
    const baseline = await baselineFor(p, "run-a", ["src"]);
    await asCall(p, baseline, "run-a", () => write(p.root, "README.md", "outside the scope\n"));
    const clean = await createWorkspaceDelta({ paths: p.paths, baselinePath: baseline.baseline_path, deltaId: "clean" });
    assert.deepEqual(clean.scope_violations, ["README.md"], label);
    const forgedDir = path.join(p.paths.evidenceRoot, "forged", "windows");
    await fsp.mkdir(forgedDir, { recursive: true });
    await fsp.writeFile(path.join(forgedDir, "1-writer-1.json"), JSON.stringify({ run_id: "run-b", call: 1, phase: "writer", started_at: new Date(Date.now() - 600_000).toISOString(), ended_at: new Date(Date.now() + 600_000).toISOString(), changed: [{ path: "README.md", after_sha256: null }] }));
    const doubted = await createWorkspaceDelta({ paths: p.paths, baselinePath: baseline.baseline_path, deltaId: "doubted" });
    assert.deepEqual(doubted.scope_violations, [], label);
    assert.deepEqual(doubted.scope_unverified, ["README.md"], label);
  }
});

// Codex round 3: Git mode is decided by the start; a failing Git call never turns into "no Git".
test("a Git project whose Git calls fail at the start is an error, never a project without Git", async (t) => {
  const p = await project(t);
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(p.root, "no-such-git-dir");
  t.after(() => { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; });
  await assert.rejects(baselineFor(p, "run-broken"), /Git could not/);
});

test("records the controller sealed are checked before use: a rewritten start or call record, or an extra one, stops the proof", async (t) => {
  const { EvidenceChangedError, sealEvidence, verifySealedEvidence } = await import("../review-bridge/features/workOrder/workspaceEvidence.mjs");
  const p = await project(t);
  const baseline = await baselineFor(p, "run-sealed", ["src"]);
  const sealed = sealEvidence(baseline.baseline_sha256);
  const before = await snapshotWorkspace(p.paths, baseline.baseline_path);
  await write(p.root, "src/new.ts", "x\n");
  const recorded = await recordWindow(p.paths, baseline.baseline_path, { runId: "run-sealed", call: 1, phase: "writer", before });
  sealed.windows.set(path.resolve(recorded.file), recorded.sha256);
  await verifySealedEvidence(p.paths, baseline.baseline_path, sealed);
  // A rewritten call record: claims the change belonged to nothing.
  const original = await fsp.readFile(recorded.file, "utf8");
  await fsp.writeFile(recorded.file, JSON.stringify({ ...JSON.parse(original), changed: [] }));
  await assert.rejects(verifySealedEvidence(p.paths, baseline.baseline_path, sealed), (error) => error instanceof EvidenceChangedError && /rewritten/.test(error.message));
  await assert.rejects(createWorkspaceDelta({ paths: p.paths, baselinePath: baseline.baseline_path, sealed }), EvidenceChangedError);
  await fsp.writeFile(recorded.file, original);
  // An extra call record nobody sealed.
  await fsp.writeFile(path.join(path.dirname(recorded.file), "9-writer-9.json"), original);
  await assert.rejects(verifySealedEvidence(p.paths, baseline.baseline_path, sealed), /added or removed/);
  await fsp.rm(path.join(path.dirname(recorded.file), "9-writer-9.json"));
  // A rewritten start: widens the allowed paths.
  const record = JSON.parse(await fsp.readFile(baseline.baseline_path, "utf8"));
  await fsp.writeFile(baseline.baseline_path, JSON.stringify({ ...record, allowed_paths: ["**"] }));
  await assert.rejects(verifySealedEvidence(p.paths, baseline.baseline_path, sealed), /starting record/);
});

test("Git finds forbidden ignored files at any depth: .env, a deep *.pem, .claude/**, inside a large ignored folder", { timeout: 60_000 }, async (t) => {
  const p = await project(t);
  await fsp.appendFile(path.join(p.root, ".gitignore"), ".claude/\n");
  p.commit("ignore .claude");
  for (let index = 0; index < 2_000; index += 1) await write(p.root, "node_modules/big/f" + index + ".js", "x\n");
  await write(p.root, "node_modules/deep/a/b/c/server.pem", "before\n");
  await write(p.root, ".claude/settings.json", "{}\n");
  await write(p.root, ".env", "A=1\n");
  const baseline = await baselineFor(p, "run-deep", ["**"]);
  await asCall(p, baseline, "run-deep", async () => {
    await write(p.root, "node_modules/deep/a/b/c/server.pem", "after\n");
    await write(p.root, ".claude/settings.json", "{\"hooks\":{}}\n");
    await write(p.root, ".env", "A=2\n");
    await write(p.root, "node_modules/big/f7.js", "changed\n");
  });
  const delta = await createWorkspaceDelta({ paths: p.paths, baselinePath: baseline.baseline_path, deltaId: "deep" });
  assert.deepEqual(delta.scope_violations, [".claude/settings.json", ".env", "node_modules/deep/a/b/c/server.pem"]);
  assert.equal(delta.changed_paths.includes("node_modules/big/f7.js"), false);
});

test("a failing Git query stops the work proof instead of reading as 'no changes'", async (t) => {
  const p = await project(t);
  const baseline = await baselineFor(p, "run-fail", ["src"]);
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(p.root, "no-such-git-dir");
  t.after(() => { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; });
  await assert.rejects(createWorkspaceDelta({ paths: p.paths, baselinePath: baseline.baseline_path, deltaId: "fail" }), /Git could not/);
});

// A file that exists but cannot be read (on Windows, usually a lock another program holds) is
// reported, never taken for a deletion. EISDIR stands in for the lock, which Node cannot take.
test("a file the proof cannot read is reported as unreadable, not as deleted", async (t) => {
  const p = await project(t);
  await write(p.root, "notes.txt", "draft\n");
  const baseline = await baselineFor(p, "run-locked", ["**"]);
  await fsp.rm(path.join(p.root, "notes.txt"));
  await fsp.mkdir(path.join(p.root, "notes.txt"));
  await assert.rejects(createWorkspaceDelta({ paths: p.paths, baselinePath: baseline.baseline_path, deltaId: "locked" }), /Could not read notes\.txt for the work proof \(EISDIR\)/);
});
