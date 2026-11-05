// Keeps the person's database out of these tests (see the fixture).
import "./fixtures/isolatedDataHome.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acceptanceRows, criteriaProblems, decideAcceptance, sameVersion, testsDecideBlockedWriter, verdictProblems, workVersion } from "../features/workOrder/acceptance.mjs";
import { runTest } from "../features/workOrder/test.mjs";
import { effectiveLimits } from "../features/workOrder/writerLoop.mjs";

const condition = (id, verify) => ({ id, statement: "condition " + id, quote: "q", source_refs: [{ start: 1, end: 1 }], verify, run_refs: [] });
const contract = {
  acceptance: [
    condition("AC1", [{ kind: "test", check: null }]),
    condition("AC2", [{ kind: "reviewer", check: "reads the page" }]),
  ],
};
const writer = (criteria, status = "done") => ({ status, criteria });
const done = (id) => ({ id, status: "done", note: "n" });
const review = (verdicts, gate = "PASS", findings = []) => ({ gate, findings, verdicts });
const pass = (id) => ({ id, verdict: "pass", evidence: "file.js:3" });
const git = (fingerprint) => ({ kind: "git", head: "abc", dirty: true, fingerprint });

test("the writer reports every sealed condition once, and calls the work done only if each one is", () => {
  assert.deepEqual(criteriaProblems(writer([done("AC1"), done("AC2")]), contract), []);
  assert.deepEqual(criteriaProblems(writer([done("AC1")]), contract), ["$.criteria: missing AC2"]);
  assert.deepEqual(criteriaProblems(writer([done("AC1"), done("AC2"), done("AC1")]), contract), ["$.criteria[2].id: duplicate AC1"]);
  assert.deepEqual(criteriaProblems(writer([done("AC1"), done("AC2"), done("AC3")]), contract), ["$.criteria[2].id: no such condition AC3"]);
  assert.deepEqual(criteriaProblems(writer([done("AC1"), { id: "AC2", status: "not_done", note: "n" }]), contract), ["$.status: done while AC2 is not done"]);
  assert.deepEqual(criteriaProblems(writer([done("AC1"), { id: "AC2", status: "not_done", note: "n" }], "blocked"), contract), []);
  // An inline task has no contract and no conditions to report.
  assert.deepEqual(criteriaProblems(writer([done("AC1")]), null), ["$.criteria: there is no contract; leave it empty"]);
});

test("the reviewer judges every sealed condition once, backs a pass with evidence, and cannot PASS over a failed one", () => {
  assert.deepEqual(verdictProblems(review([pass("AC1"), pass("AC2")]), contract), []);
  assert.deepEqual(verdictProblems(review([pass("AC1")]), contract), ["$.verdicts: missing AC2"]);
  assert.deepEqual(verdictProblems(review([pass("AC1"), pass("AC2"), pass("AC2")]), contract), ["$.verdicts[2].id: duplicate AC2"]);
  assert.deepEqual(verdictProblems(review([pass("AC1"), { id: "AC2", verdict: "pass", evidence: "  " }]), contract), ["$.verdicts[1].evidence: say what shows it"]);
  assert.deepEqual(verdictProblems(review([pass("AC1"), { id: "AC2", verdict: "fail", evidence: "" }]), contract), ["$.gate: PASS while a condition fails"]);
  const blocked = review([pass("AC1"), { id: "AC2", verdict: "fail", evidence: "" }], "FAIL", [{ acceptance_ref: "AC9" }]);
  assert.deepEqual(verdictProblems(blocked, contract), ["$.findings[0].acceptance_ref: no such condition AC9"]);
  assert.deepEqual(verdictProblems(review([pass("AC1")]), null), ["$.verdicts: there is no contract; leave it empty"]);
});

test("Bridge decides each condition from the records: a reviewer pass is proven only when its evidence holds", () => {
  const gatePassed = (version) => ({ kind: "command", passed: true, work_version: version });
  const rows = (verdicts, testResult, reviewVersion) => acceptanceRows({ contract, writer: writer([done("AC1"), done("AC2")]), review: review(verdicts), test: testResult, reviewVersion });
  const results = (list) => list.map((row) => row.result);
  assert.deepEqual(results(rows([pass("AC1"), pass("AC2")], gatePassed(git("v1")), git("v1"))), ["proven", "proven"]);
  // The tests ran on one version, the reviewer read another: the condition proven by the tests is not proven.
  assert.deepEqual(results(rows([pass("AC1"), pass("AC2")], gatePassed(git("v1")), git("v2"))), ["unknown", "proven"]);
  // Without Git neither version is known: the test result stands, the work proof is unknown.
  assert.deepEqual(results(rows([pass("AC1"), pass("AC2")], gatePassed({ kind: "unknown", reason: "no_git" }), { kind: "unknown", reason: "no_git" })), ["proven", "proven"]);
  assert.deepEqual(results(rows([pass("AC1"), pass("AC2")], { kind: "command", passed: false, work_version: git("v1") }, git("v1"))), ["failed", "proven"]);
  assert.deepEqual(results(rows([pass("AC1"), pass("AC2")], null, git("v1"))), ["unknown", "proven"]);
  assert.deepEqual(results(rows([pass("AC1"), { id: "AC2", verdict: "cannot_verify", evidence: "needs a browser" }], gatePassed(git("v1")), git("v1"))), ["proven", "unknown"]);
  assert.deepEqual(results(rows([pass("AC1")], gatePassed(git("v1")), git("v1"))), ["proven", "unknown"]);
  assert.deepEqual(results(rows([{ id: "AC1", verdict: "fail", evidence: "" }, pass("AC2")], gatePassed(git("v1")), git("v1"))), ["failed", "proven"]);
  assert.equal(decideAcceptance(rows([pass("AC1"), pass("AC2")], gatePassed(git("v1")), git("v1"))), "proven");
  assert.equal(decideAcceptance(rows([pass("AC1"), { id: "AC2", verdict: "cannot_verify", evidence: "x" }], gatePassed(git("v1")), git("v1"))), "unknown");
  assert.equal(decideAcceptance(rows([{ id: "AC1", verdict: "fail", evidence: "" }, pass("AC2")], gatePassed(git("v1")), git("v1"))), "failed");
  assert.equal(sameVersion({ kind: "unknown" }, { kind: "unknown" }), false);
});

test("the work version comes from Git without touching it; without Git it is unknown", { timeout: 60_000 }, async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-version-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  assert.deepEqual(await workVersion(root), { kind: "unknown", reason: "no_git" });
  const run = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  run("init", "-q");
  run("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "start");
  await fsp.writeFile(path.join(root, "a.js"), "one\n");
  const statusBefore = run("status", "--porcelain").stdout;
  const indexBefore = await fsp.stat(path.join(root, ".git", "index")).catch(() => null);
  const first = await workVersion(root);
  assert.equal(first.kind, "git");
  assert.equal(first.dirty, true);
  assert.match(first.head, /^[0-9a-f]{40}$/);
  // Reading the version leaves the user's Git state as it was.
  assert.equal(run("status", "--porcelain").stdout, statusBefore);
  assert.equal((await fsp.stat(path.join(root, ".git", "index")).catch(() => null))?.mtimeMs, indexBefore?.mtimeMs);
  assert.equal((await workVersion(root)).fingerprint, first.fingerprint);
  // Any change to an untracked file is a different version.
  await fsp.writeFile(path.join(root, "a.js"), "two\n");
  assert.notEqual((await workVersion(root)).fingerprint, first.fingerprint);
});

test("the tests always have a time limit; a missing one refuses to run instead of running without one", async () => {
  assert.equal(effectiveLimits({ run: { policy_snapshot: { effective_policy: { limits: { test_timeout: 180_000 } } } } }).test_timeout, 180_000);
  assert.equal(effectiveLimits({}).test_timeout, 600_000);
  await assert.rejects(runTest({ paths: { repoRoot: os.tmpdir() }, test: { kind: "command", command: "node -e 0" }, stdoutPath: "x", stderrPath: "y", timeoutMs: Number.NaN }), /no valid time limit/);
});

// Codex review round 3: once a project has Git, a failing Git query stops the version, never "no Git".
test("reading the version of a Git project fails loudly when Git fails; only a project without .git is unknown", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-version-fail-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  assert.deepEqual(await workVersion(root), { kind: "unknown", reason: "no_git" });
  spawnSync("git", ["init", "-q"], { cwd: root, windowsHide: true });
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(root, "no-such-git-dir");
  t.after(() => { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; });
  await assert.rejects(workVersion(root), /Git could not/);
});

test("a condition the tests decide is not left open by the writer; one only the reviewer can see still is", () => {
  const contract = { acceptance: [{ id: "AC1", verify: [{ kind: "test", check: null }] }, { id: "AC2", verify: [{ kind: "reviewer", check: "read it" }] }] };
  const report = (status, ac1, ac2, needsHuman = []) => ({ status, needs_human: needsHuman, criteria: [{ id: "AC1", status: ac1, note: "" }, { id: "AC2", status: ac2, note: "" }] });
  assert.deepEqual(criteriaProblems(report("done", "not_done", "done"), contract), [], "the tests decide AC1");
  assert.deepEqual(criteriaProblems(report("done", "done", "not_done"), contract), ["$.status: done while AC2 is not done"]);
  const command = { kind: "command", command: "npm test" };
  assert.equal(testsDecideBlockedWriter(report("blocked", "not_done", "done"), contract, command), true);
  assert.equal(testsDecideBlockedWriter(report("blocked", "not_done", "not_done"), contract, command), false, "AC2 is the writer's to finish");
  assert.equal(testsDecideBlockedWriter(report("blocked", "done", "done"), contract, command), false, "blocked by something it did not name in a condition");
  assert.equal(testsDecideBlockedWriter(report("blocked", "not_done", "done", [{ question: "which?" }]), contract, command), false, "it asked the person");
  assert.equal(testsDecideBlockedWriter(report("out_of_scope", "not_done", "done"), contract, command), false);
  assert.equal(testsDecideBlockedWriter(report("blocked", "not_done", "done"), contract, { kind: "not_configured" }), false, "no test to decide it");
  assert.equal(testsDecideBlockedWriter(report("blocked", "not_done", "done"), contract, null), false);
});
