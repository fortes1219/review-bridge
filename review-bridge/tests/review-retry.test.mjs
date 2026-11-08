// Run f645ccf5 (2026-11-09): a review.result that breaks the review's rules is asked for once more, and the
// packet of that second ask says what was wrong. No CLI, no database: the packet is built from a job and
// its change list in a temporary folder. The whole loop runs in tests/acceptance-run.test.mjs.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildReviewInput } from "../features/workOrder/review.mjs";
import { REVIEW_FORMAT_ATTEMPTS, validateReviewResult } from "../features/workOrder/typedResults.mjs";

test("the second ask's review packet carries what broke the rules; the first carries nothing of it; there is one more ask, no more", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-review-retry-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const deltaPath = path.join(dir, "delta.json");
  await fsp.writeFile(deltaPath, JSON.stringify({ mode: "git", start_point: "kept", scope_status: "ok", commits_since_start: [], scope_unverified: [], changed_files: [{ path: "a.ts", change: "modified" }] }));
  const control = { run: { work_package: { work_package_id: "wo", task: "do it", scope: {} }, contract_sha256: null } };
  const job = { call: 1, priority: "medium", writer_result: { changed: [] }, workspace_evidence: { delta_path: deltaPath } };
  const first = await buildReviewInput({ paths: {}, job, control });
  assert.equal("previous_answer_problems" in first, false);
  const problems = ["$.hard_stop: PASS cannot request a hard stop"];
  const second = await buildReviewInput({ paths: {}, job: { ...job, previous_answer_problems: problems }, control });
  assert.deepEqual(second.previous_answer_problems, problems);
  assert.equal(REVIEW_FORMAT_ATTEMPTS, 2);
  // The rule run f645ccf5 broke is one the check names, so the second ask can say it.
  const checked = await validateReviewResult({
    event: "review.result", work_order: "wo", contract_sha256: null, call: 1, gate: "PASS", hard_stop: true, hard_stop_reason: "needs_human_decision",
    findings: [], verified: ["read a.ts"], not_run: [], verdicts: [],
  }, { workOrder: "wo", call: 1, repoRoot: dir, previousFindings: [], deltaPaths: null, contractSha256: null, contract: null });
  assert.ok(checked.errors.includes(problems[0]), JSON.stringify(checked.errors));
});
