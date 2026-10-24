import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { assertSupportedStateFilesystem, inspectStateFilesystem } from "../utils/filesystem.mjs";
import { fileExists, readJson, writeJson, writeText } from "../service/records/fileStore.mjs";
import { getBridgePaths } from "../utils/paths.mjs";
import { applyNeutralInstall, planNeutralInstall } from "../../installer/neutral-install.mjs";
import { digest } from "../utils/digest.mjs";
import { loadOrCreatePolicySnapshot } from "../service/records/policySnapshots.mjs";
import { mergePolicy } from "../policy/policyRules.mjs";
import {
  acquireRunLock,
  applyBudgetExtension,
  assertRunResumable,
  claimStartAuthorization,
  consumeRun,
  createAuthorization,
  createImmutableWorkPackage,
  listRuns,
  readRun,
  reconcileRunProjection,
} from "../service/records/runStore.mjs";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const sourceBridgeRoot = path.resolve(testRoot, "..");
const packageRoot = path.resolve(sourceBridgeRoot, "..");
const cleanupRoots = new Set();

after(async () => {
  await Promise.all([...cleanupRoots].map((root) => fsp.rm(root, { recursive: true, force: true })));
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function makeRuntime(prefix = "ac-state-", baseRoot = os.tmpdir()) {
  const repoRoot = await fsp.mkdtemp(path.join(baseRoot, prefix));
  const bridgeRoot = path.join(repoRoot, ".runtime");
  cleanupRoots.add(repoRoot);
  await fsp.mkdir(path.join(bridgeRoot, "config"), { recursive: true });
  await fsp.copyFile(
    path.join(sourceBridgeRoot, "config", "default-policy.json"),
    path.join(bridgeRoot, "config", "default-policy.json"),
  );
  const paths = getBridgePaths(repoRoot, bridgeRoot, { privateRootName: ".review-bridge" });
  await writeJson(paths.bridgeConfigPath, {
    schema_version: 4,
    active_runs: "derive_from_run_projections",
  });
  await writeJson(paths.policyOverridePath, { schema_version: 4 });
  return { repoRoot, bridgeRoot, paths };
}

async function startFixture(runtime, {
  calls = 1,
  clock = Date.now,
  kind = "start",
  sourceRunId = null,
  sourceEvidence = null,
  runId = randomUUID(),
  sessionId = randomUUID(),
  workPackageId = "wp-" + randomUUID(),
} = {}) {
  const { snapshot } = await loadOrCreatePolicySnapshot(runtime.paths);
  const workPackage = await createImmutableWorkPackage(runtime.paths, {
    work_package_id: workPackageId,
    task: "Change one disposable fixture.",
    acceptance_criteria: ["fixture passes"],
    scope: { change_types: ["tests"], allowed_paths: ["fixture.txt"] },
    budget: { max_claude_calls: calls, max_claude_minutes_per_call: 1 },
    breakpoint: "return to human owner",
  }, clock);
  const authorization = await createAuthorization(runtime.paths, {
    kind,
    authorizedBy: "Human Owner",
    workPackageSha256: workPackage.record.content_sha256,
    policySha256: snapshot.effective_policy_sha256,
    ttlSeconds: snapshot.effective_policy.limits.authorization_ttl_seconds,
    sourceRunId,
    sourceEvidence,
  }, clock);
  const started = await claimStartAuthorization(runtime.paths, authorization.authorization_id, {
    runId,
    sessionId,
    executionMode: "fake_cli",
    workspaceEvidence: { fixture: true },
    clock,
  });
  return { snapshot, workPackage, authorization, ...started };
}

async function createUnclaimed(runtime, { calls = 1, clock = Date.now, ttlSeconds = null } = {}) {
  const { snapshot } = await loadOrCreatePolicySnapshot(runtime.paths);
  const workPackage = await createImmutableWorkPackage(runtime.paths, {
    work_package_id: "wp-" + randomUUID(),
    task: "Unclaimed fixture.",
    acceptance_criteria: [],
    scope: { change_types: ["tests"], allowed_paths: ["fixture.txt"] },
    budget: { max_claude_calls: calls, max_claude_minutes_per_call: 1 },
    breakpoint: "return to owner",
  }, clock);
  const authorization = await createAuthorization(runtime.paths, {
    authorizedBy: "Human Owner",
    workPackageSha256: workPackage.record.content_sha256,
    policySha256: snapshot.effective_policy_sha256,
    ttlSeconds: ttlSeconds ?? snapshot.effective_policy.limits.authorization_ttl_seconds,
  }, clock);
  return { snapshot, workPackage, authorization };
}

describe("AC-01 work-package copies do not create authorization", () => {
  it("keeps definition and authorization lifecycles separate", async () => {
    const runtime = await makeRuntime();
    const { workPackage } = await createUnclaimed(runtime);
    const copied = path.join(runtime.paths.workPackagesDir, "copy", workPackage.record.content_sha256 + ".json");
    await fsp.mkdir(path.dirname(copied), { recursive: true });
    await fsp.copyFile(workPackage.path, copied);
    assert.equal((await fsp.readdir(runtime.paths.authorizationsDir).catch(() => [])).length, 1);
    await fsp.rm(runtime.paths.authorizationsDir, { recursive: true, force: true });
    assert.equal((await fsp.readdir(runtime.paths.authorizationsDir).catch(() => [])).length, 0);
  });
});

describe("AC-02 a start authorization can create exactly one run", () => {
  it("uses exclusive claim under concurrent attempts", async () => {
    const runtime = await makeRuntime();
    const { authorization } = await createUnclaimed(runtime);
    const attempts = await Promise.allSettled([
      claimStartAuthorization(runtime.paths, authorization.authorization_id, { runId: "run-a", sessionId: "session-a" }),
      claimStartAuthorization(runtime.paths, authorization.authorization_id, { runId: "run-b", sessionId: "session-b" }),
    ]);
    assert.equal(attempts.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((entry) => entry.status === "rejected").length, 1);
    assert.equal((await listRuns(runtime.paths)).length, 1);
  });
});

describe("AC-03 abnormal interruption resumes the same claim, run, and session", () => {
  it("reconstructs a run after an already durable claim", async () => {
    const runtime = await makeRuntime();
    const { authorization } = await createUnclaimed(runtime);
    const first = await claimStartAuthorization(runtime.paths, authorization.authorization_id, {
      runId: "crash-run", sessionId: "crash-session",
    });
    await fsp.rm(path.join(runtime.paths.runsDir, "crash-run.json"));
    await fsp.rm(path.join(runtime.paths.eventsDir, "crash-run.jsonl"));
    const resumed = await claimStartAuthorization(runtime.paths, authorization.authorization_id, {
      runId: "crash-run", sessionId: "crash-session",
    });
    assert.equal(resumed.run.run_id, first.claim.run_id);
    assert.equal(resumed.run.claude_session_id, "crash-session");
    assert.equal((await listRuns(runtime.paths)).length, 1);
  });
});

describe("AC-04 terminal hard stop cannot use crash recovery", () => {
  it("rejects resume after a normal hard stop", async () => {
    const runtime = await makeRuntime();
    const started = await startFixture(runtime);
    await consumeRun(runtime.paths, started.run.run_id, "hard_stop", {
      review_gate: "FAIL", hard_stop_required: true,
    });
    await assert.rejects(assertRunResumable(runtime.paths, started.run.run_id), /Terminal run/);
  });
});

describe("AC-05 expired unclaimed authorization is rejected", () => {
  it("requires an unexpired authorization at first claim", async () => {
    const runtime = await makeRuntime();
    const old = Date.now() - 10_000;
    const { authorization } = await createUnclaimed(runtime, { clock: () => old, ttlSeconds: 1 });
    await assert.rejects(
      claimStartAuthorization(runtime.paths, authorization.authorization_id),
      /expired/,
    );
  });
});

describe("AC-06 expired recovery deadline rejects crash resume", () => {
  it("uses the run deadline independently from authorization expiry", async () => {
    const runtime = await makeRuntime();
    const old = Date.now() - 86_401_000;
    const started = await startFixture(runtime, { clock: () => old });
    await assert.rejects(assertRunResumable(runtime.paths, started.run.run_id), /deadline is expired/);
  });
});

describe("AC-07 budget extension preserves run scope and policy ceiling", () => {
  it("adds budget to the same run and rejects excess or mismatched grants", async () => {
    const runtime = await makeRuntime();
    const started = await startFixture(runtime, { calls: 1 });
    const extension = await createAuthorization(runtime.paths, {
      kind: "budget_extension",
      authorizedBy: "Human Owner",
      workPackageSha256: started.run.work_package_sha256,
      policySha256: started.run.effective_policy_sha256,
      ttlSeconds: 3600,
      runId: started.run.run_id,
      additionalBudget: { max_claude_calls: 1 },
    });
    const updated = await applyBudgetExtension(runtime.paths, extension.authorization_id);
    assert.equal(updated.run_id, started.run.run_id);
    assert.equal(updated.work_package_sha256, started.run.work_package_sha256);
    assert.equal(updated.budget.max_claude_calls, 2);
    const excess = await createAuthorization(runtime.paths, {
      kind: "budget_extension", authorizedBy: "Human Owner",
      workPackageSha256: started.run.work_package_sha256,
      policySha256: started.run.effective_policy_sha256, ttlSeconds: 3600,
      runId: started.run.run_id, additionalBudget: { max_claude_calls: 1 },
    });
    await assert.rejects(applyBudgetExtension(runtime.paths, excess.authorization_id), /ceiling/);
  });

  it("recovers the same grant when a crash leaves its claim ahead of the event", async () => {
    const runtime = await makeRuntime();
    const started = await startFixture(runtime, { calls: 1 });
    const extension = await createAuthorization(runtime.paths, {
      kind: "budget_extension",
      authorizedBy: "Human Owner",
      workPackageSha256: started.run.work_package_sha256,
      policySha256: started.run.effective_policy_sha256,
      ttlSeconds: 3600,
      runId: started.run.run_id,
      additionalBudget: { max_claude_calls: 1 },
    });
    await writeJson(path.join(runtime.paths.authorizationClaimsDir, extension.authorization_id + ".json"), {
      schema_version: 4,
      authorization_id: extension.authorization_id,
      authorization_sha256: extension.authorization_sha256,
      run_id: started.run.run_id,
      claimed_at: new Date().toISOString(),
      claim_kind: "budget_extension",
    });
    const recovered = await applyBudgetExtension(runtime.paths, extension.authorization_id);
    assert.equal(recovered.budget.max_claude_calls, 2);
    assert.equal(recovered.authorization_ids.filter((id) => id === extension.authorization_id).length, 1);
    const replayed = await applyBudgetExtension(runtime.paths, extension.authorization_id);
    assert.equal(replayed.budget.max_claude_calls, 2);
  });
});

describe("AC-08 tighten-only policy merge rejects protected weakening", () => {
  it("accepts stricter limits and rejects protected removals, exclusions, effort, and release weakening", async () => {
    const defaults = JSON.parse(await fsp.readFile(path.join(sourceBridgeRoot, "config", "default-policy.json"), "utf8"));
    assert.equal(mergePolicy(defaults, { schema_version: 4, limits: { max_claude_calls: 1 } }).limits.max_claude_calls, 1);
    assert.throws(() => mergePolicy(defaults, { schema_version: 4, limits: { max_claude_calls: 3 } }), /tighten/);
    assert.throws(() => mergePolicy(defaults, { schema_version: 4, release_actions_require_human: false }), /release/);
    assert.throws(() => mergePolicy(defaults, {
      schema_version: 4, classification: { effort_by_level: { SECURITY: "low" } },
    }), /lower review effort/);
    const security = defaults.classification.rules.find((rule) => rule.id === "package-security");
    assert.throws(() => mergePolicy(defaults, {
      schema_version: 4,
      classification: { rules: [{ ...security, any: security.any.slice(1) }] },
    }), /removed or narrowed/);
    assert.throws(() => mergePolicy(defaults, {
      schema_version: 4,
      classification: { rules: [{ ...security, none: ["skip-auth"] }] },
    }), /bypass exclusion/);
  });
});

describe("AC-10 historical evidence uses its snapshot but old active run cannot execute", () => {
  it("preserves historical validation and converts identity mismatch to human hard stop", async () => {
    const runtime = await makeRuntime();
    const started = await startFixture(runtime);
    const oldSnapshot = await readJson(path.join(runtime.paths.policySnapshotsDir, started.run.effective_policy_sha256 + ".json"));
    assert.equal(digest(oldSnapshot), digest(started.snapshot));
    const defaults = await readJson(runtime.paths.defaultPolicyPath);
    defaults.package_policy_id += "-upgrade";
    await writeJson(runtime.paths.defaultPolicyPath, defaults);
    await assert.rejects(assertRunResumable(runtime.paths, started.run.run_id), /human hard stop/);
    const stopped = await readRun(runtime.paths, started.run.run_id);
    assert.equal(stopped.status, "hard_stop");
    assert.equal(await fileExists(path.join(runtime.paths.eventsDir, stopped.run_id + ".jsonl")), true);
  });
});

describe("AC-11 active runs are derived from run projections", () => {
  it("discovers two active runs without an active index", async () => {
    const runtime = await makeRuntime();
    await startFixture(runtime);
    await startFixture(runtime);
    assert.equal((await listRuns(runtime.paths, { activeOnly: true })).length, 2);
    assert.equal(await fileExists(path.join(runtime.paths.queueRoot, "active_run_ids.json")), false);
  });
});

describe("AC-13 run rollback requires a compensating package and authorization", () => {
  it("creates rollback evidence without mutating the source audit", async () => {
    const runtime = await makeRuntime();
    const source = await startFixture(runtime);
    await consumeRun(runtime.paths, source.run.run_id, "pass", { review_gate: "PASS", hard_stop_required: false });
    const sourceEvents = await fsp.readFile(path.join(runtime.paths.eventsDir, source.run.run_id + ".jsonl"));
    await assert.rejects(createAuthorization(runtime.paths, {
      kind: "rollback", authorizedBy: "Human Owner", workPackageSha256: source.run.work_package_sha256,
      policySha256: source.run.effective_policy_sha256, ttlSeconds: 3600,
      sourceRunId: source.run.run_id, sourceEvidence: null,
    }), /source evidence/);
    const rollback = await startFixture(runtime, {
      kind: "rollback", sourceRunId: source.run.run_id,
      sourceEvidence: { event_sha256: sha256(sourceEvents) },
    });
    assert.equal(rollback.authorization.kind, "rollback");
    assert.notEqual(rollback.run.work_package_sha256, source.run.work_package_sha256);
    assert.deepEqual(await fsp.readFile(path.join(runtime.paths.eventsDir, source.run.run_id + ".jsonl")), sourceEvents);
  });
});

describe("AC-15 / R7 unsafe synchronized or network storage fails preflight", () => {
  it("rejects Windows and POSIX synchronized or network paths while accepting local paths", () => {
    assert.equal(inspectStateFilesystem("C:\\Users\\owner\\OneDrive\\repo", { platform: "win32" }).supported_for_concurrent_controller, false);
    assert.equal(inspectStateFilesystem("\\\\server\\share\\repo", { platform: "win32" }).supported_for_concurrent_controller, false);
    assert.throws(() => assertSupportedStateFilesystem("C:\\Users\\owner\\OneDrive\\repo", { platform: "win32" }), /Unsupported/);
    assert.equal(inspectStateFilesystem("C:\\work\\repo", { platform: "win32" }).supported_for_concurrent_controller, true);
    assert.equal(inspectStateFilesystem("/Users/owner/Library/Mobile Documents/repo", { platform: "darwin" }).supported_for_concurrent_controller, false);
    assert.equal(inspectStateFilesystem("/home/owner/Dropbox/repo", { platform: "linux" }).supported_for_concurrent_controller, false);
    assert.equal(inspectStateFilesystem("/mnt/nfs/team/repo", { platform: "linux" }).supported_for_concurrent_controller, false);
    assert.equal(inspectStateFilesystem("/home/owner/work/repo", { platform: "linux" }).supported_for_concurrent_controller, true);
  });
});

describe("AC-16 real NTFS claim, stale lock, stale guard, and resume", () => {
  it("runs against an actual local NTFS temp volume", { skip: process.platform !== "win32" }, async (t) => {
    const runtime = await makeRuntime(
      "ac16-ntfs-",
      process.env.REVIEW_BRIDGE_AC16_ROOT || os.tmpdir(),
    );
    const drive = path.parse(runtime.repoRoot).root.slice(0, 2);
    const detected = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", `([System.IO.DriveInfo]::new('${drive}')).DriveFormat`,
    ], { encoding: "utf8" });
    assert.equal(detected.status, 0, detected.stderr);
    assert.equal(detected.stdout.trim().toUpperCase(), "NTFS");
    t.diagnostic(`real_volume=${drive}; filesystem=${detected.stdout.trim()}`);
    const started = await startFixture(runtime);
    const policy = started.snapshot.effective_policy;
    const staleAt = new Date(Date.now() - 60_000).toISOString();
    await writeJson(path.join(runtime.paths.runLocksDir, started.run.run_id + ".json"), {
      schema_version: 4, run_id: started.run.run_id, lock_nonce: "stale-lock",
      pid: process.pid, acquired_at: staleAt, heartbeat_at: staleAt,
    });
    await writeJson(path.join(runtime.paths.reconcileGuardsDir, started.run.run_id + ".json"), {
      schema_version: 4, run_id: started.run.run_id, guard_nonce: "stale-guard",
      owner_pid: process.pid, acquired_at: staleAt, expires_at: staleAt,
    });
    const lease = await acquireRunLock(runtime.paths, started.run.run_id, policy, { sleep: async () => {} });
    await lease.assertOwner();
    await lease.release();
    const resumed = await assertRunResumable(runtime.paths, started.run.run_id);
    assert.equal(resumed.run_id, started.run.run_id);
    assert.equal(resumed.claude_session_id, started.run.claude_session_id);
  });
});

describe("AC-17 concurrent budget extensions serialize and remain single-use", () => {
  it("permits at most the policy ceiling and claims each grant once", async () => {
    const runtime = await makeRuntime();
    const started = await startFixture(runtime, { calls: 1 });
    const grants = await Promise.all([1, 2].map(() => createAuthorization(runtime.paths, {
      kind: "budget_extension", authorizedBy: "Human Owner",
      workPackageSha256: started.run.work_package_sha256,
      policySha256: started.run.effective_policy_sha256, ttlSeconds: 3600,
      runId: started.run.run_id, additionalBudget: { max_claude_calls: 1 },
    })));
    const results = await Promise.allSettled(grants.map((grant) => applyBudgetExtension(runtime.paths, grant.authorization_id)));
    assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal((await readRun(runtime.paths, started.run.run_id)).budget.max_claude_calls, 2);
    const appliedGrant = grants.find((grant) => results[grants.indexOf(grant)].status === "fulfilled");
    const replayed = await applyBudgetExtension(runtime.paths, appliedGrant.authorization_id);
    assert.equal(replayed.budget.max_claude_calls, 2);
    assert.equal(replayed.authorization_ids.filter((id) => id === appliedGrant.authorization_id).length, 1);
  });
});

describe("AC-18 protected SECURITY paths cannot be removed, bypassed, or shadowed", () => {
  it("rejects all protected classification weakening forms", async () => {
    const defaults = JSON.parse(await fsp.readFile(path.join(sourceBridgeRoot, "config", "default-policy.json"), "utf8"));
    const security = defaults.classification.rules.find((rule) => rule.id === "package-security");
    assert.throws(() => mergePolicy(defaults, {
      schema_version: 4, classification: { rules: [{ ...security, any: [security.any[0]] }] },
    }), /removed or narrowed/);
    assert.throws(() => mergePolicy(defaults, {
      schema_version: 4, classification: { rules: [{ ...security, none: ["src/auth/"] }] },
    }), /bypass exclusion/);
    assert.throws(() => mergePolicy(defaults, {
      schema_version: 4, classification: { rules: [{
        id: "project-light-auth", level: "LIGHT", priority: 999,
        reason: "bad shadow", any: [security.any[0]], none: [],
      }] },
    }), /shadow/);
  });
});

describe("AC-20 / R2 the same approved plan cannot start twice", () => {
  it("rejects the second work-start before changing event bytes", async () => {
    const target = await fsp.mkdtemp(path.join(os.tmpdir(), "ac20-plan-replay-"));
    cleanupRoots.add(target);
    await writeJson(path.join(target, "package.json"), {
      private: true, scripts: { build: "vite build" }, dependencies: { vue: "latest" },
    });
    await writeText(path.join(target, "README.md"), "# AC-20 fixture\n");
    const install = await planNeutralInstall({ target, roles: { writer: "claude", reviewer: "codex" } });
    await applyNeutralInstall(install, install.plan_sha256);

    const bootstrap = path.join(sourceBridgeRoot, "bootstrap.mjs");
    const taskPath = path.join(target, ".review-bridge", "work-packages", "ac20.md");
    const planPath = path.join(target, ".review-bridge", "review-queue", "ac20.plan.json");
    await writeText(taskPath, "Update `README.md`.\n\tKeep the task multiline.\n");
    const planned = spawnSync(process.execPath, [
      bootstrap, "work-plan",
      "--task-file", taskPath,
      "--owner", "AC-20 Owner",
      "--work-package", "ac20-plan-replay",
      "--breakpoint", "return after fake review",
      "--change-types", "docs",
      "--allow-paths", "README.md",
      "--max-claude-calls", "1",
      "--max-claude-minutes", "1",
      "--out", planPath,
    ], { cwd: target, encoding: "utf8" });
    assert.equal(planned.status, 0, planned.stderr);
    const workPlan = JSON.parse(planned.stdout);
    assert.equal(Object.hasOwn(workPlan, "plan_sha256"), false);
    const startArgs = [
      bootstrap, "work-start", "--plan", planPath, "--yes",
      "--fake-cli", "--fake-scenario", "PASS", "--json",
    ];
    const first = spawnSync(process.execPath, startArgs, { cwd: target, encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    const firstStatus = JSON.parse(first.stdout);
    const eventsPath = path.join(target, ".review-bridge", "review-queue", "events", firstStatus.run_id + ".jsonl");
    const before = await fsp.readFile(eventsPath);
    const beforeSha = sha256(before);

    const second = spawnSync(process.execPath, startArgs, { cwd: target, encoding: "utf8" });
    assert.equal(second.status, 2);
    assert.match(second.stderr, /plan already consumed, generate a new plan/i);
    assert.equal(sha256(await fsp.readFile(eventsPath)), beforeSha);
    assert.deepEqual((await fsp.readdir(path.join(target, ".review-bridge", "review-queue", "runs"))).length, 1);
  });
});
