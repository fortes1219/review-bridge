// The acceptance chain (RC3-BLOCKER-00). Every condition sealed in the contract is reported by the
// writer, judged by the reviewer, and decided here by code: the writer's and reviewer's answers
// must name exactly the sealed ids, and a condition the reviewer passes counts as proven only
// when its evidence holds: a condition that leans on the tests needs them to have passed on the
// same version of the work the reviewer saw. Anything else is failed or unknown, never a pass.
import { fileSha256, headCommit, isGitWorkTree, runGit as git, sha256 } from "./gitWorkspace.mjs";

// Which version of the work a check ran against. With Git: the commit, every tracked change and
// every untracked file, by content. Without Git there is no proof of the version (Owner
// 2026-10-17), so it is recorded as unknown rather than guessed.
export async function workVersion(repoRoot) {
  // Only a project with no .git is "no Git"; a Git project whose Git fails is an error, which stops
  // the verification instead of letting a pass stand on an unknown version (Codex review round 3).
  if (!isGitWorkTree(repoRoot)) return { kind: "unknown", reason: "no_git" };
  const head = headCommit(repoRoot);
  const diff = head ? git(repoRoot, ["diff", "--binary", "HEAD"]) : git(repoRoot, ["diff", "--binary", "--cached"]);
  const untracked = git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (diff === null || untracked === null) throw new Error("Git could not read the version of the work.");
  const files = [];
  for (const relative of untracked.toString("utf8").split("\0").filter(Boolean).sort()) files.push([relative, await fileSha256(repoRoot, relative)]);
  const dirty = diff.length > 0 || files.length > 0;
  return { kind: "git", head, dirty, fingerprint: sha256(JSON.stringify({ head, diff: sha256(diff), untracked: files })) };
}

export function sameVersion(left, right) {
  return left?.kind === "git" && right?.kind === "git" && left.fingerprint === right.fingerprint;
}

function idProblems(items, ids, at) {
  const problems = [];
  const seen = new Set();
  for (const [index, item] of items.entries()) {
    if (seen.has(item.id)) problems.push(at + "[" + index + "].id: duplicate " + item.id);
    else if (!ids.includes(item.id)) problems.push(at + "[" + index + "].id: no such condition " + item.id);
    seen.add(item.id);
  }
  const missing = ids.filter((id) => !seen.has(id));
  if (missing.length) problems.push(at + ": missing " + missing.join(", "));
  return problems;
}

const contractIds = (contract) => (contract?.acceptance || []).map((item) => item.id);

const leansOnTest = (condition) => (condition.verify || []).some((check) => check.kind === "test");

// Conditions the writer reports as not done, apart from those that lean on the tests: Bridge runs the
// tests itself, outside the writer's sandbox, and decides those (rowResult never reads the writer's
// word), so a writer that could not run them has not left anything open.
function openConditions(writerResult, contract) {
  const decidedByTests = new Set((contract?.acceptance || []).filter(leansOnTest).map((condition) => condition.id));
  return writerResult.criteria.filter((item) => item.status !== "done" && !decidedByTests.has(item.id)).map((item) => item.id);
}

// A writer that calls itself blocked for no other reason than a condition the tests decide, and asks
// the person nothing, is not stopped: Bridge's own tests and the reviewer judge the work. Code decides
// this from the sealed contract, so it does not rest on the model reading its instructions (Owner
// 2026-11-03). Only with a test command to run; without one nothing would decide those conditions.
export function testsDecideBlockedWriter(writerResult, contract, test) {
  return writerResult.status === "blocked"
    && test?.kind === "command"
    && !writerResult.needs_human.length
    && writerResult.criteria.some((item) => item.status !== "done")
    && !openConditions(writerResult, contract).length;
}

// The writer reports every sealed condition by id, and calls the work done only if each one is,
// apart from those the tests decide.
export function criteriaProblems(writerResult, contract) {
  const ids = contractIds(contract);
  if (!contract) return writerResult.criteria.length ? ["$.criteria: there is no contract; leave it empty"] : [];
  const problems = idProblems(writerResult.criteria, ids, "$.criteria");
  const open = openConditions(writerResult, contract);
  if (writerResult.status === "done" && open.length) problems.push("$.status: done while " + open.join(", ") + " is not done");
  return problems;
}

// The reviewer judges every sealed condition by id; a pass carries evidence; a failed condition
// cannot sit under an overall PASS; a finding blocks a condition by its id.
export function verdictProblems(reviewResult, contract) {
  const ids = contractIds(contract);
  const problems = [];
  for (const [index, finding] of reviewResult.findings.entries()) {
    if (finding.acceptance_ref !== null && !ids.includes(finding.acceptance_ref)) problems.push("$.findings[" + index + "].acceptance_ref: no such condition " + finding.acceptance_ref);
  }
  if (!contract) return reviewResult.verdicts.length ? [...problems, "$.verdicts: there is no contract; leave it empty"] : problems;
  problems.push(...idProblems(reviewResult.verdicts, ids, "$.verdicts"));
  for (const [index, verdict] of reviewResult.verdicts.entries()) {
    if (verdict.verdict !== "fail" && !verdict.evidence.trim()) problems.push("$.verdicts[" + index + "].evidence: say what shows it");
  }
  if (reviewResult.gate === "PASS" && reviewResult.verdicts.some((verdict) => verdict.verdict === "fail")) problems.push("$.gate: PASS while a condition fails");
  return problems;
}

// One row per sealed condition, decided from records only.
export function acceptanceRows({ contract, writer = null, review = null, test = null, reviewVersion = null }) {
  return (contract?.acceptance || []).map((condition) => {
    const reported = writer?.criteria?.find((item) => item.id === condition.id) || null;
    const judged = review?.verdicts?.find((item) => item.id === condition.id) || null;
    const row = {
      id: condition.id,
      statement: condition.statement,
      writer: reported?.status || null,
      verdict: judged?.verdict || null,
      evidence: judged?.evidence || null,
      test: leansOnTest(condition) ? (test?.kind === "command" ? (test.passed ? "passed" : "failed") : "not_run") : "not_used",
    };
    return { ...row, result: rowResult(row, { test, reviewVersion }) };
  });
}

function rowResult(row, { test, reviewVersion }) {
  if (row.verdict === "fail" || row.test === "failed") return "failed";
  if (row.verdict !== "pass") return "unknown";
  if (row.test === "not_used") return "proven";
  if (row.test !== "passed") return "unknown";
  // Without Git neither version is known; the work proof is unknown, not the test result.
  if (test.work_version?.kind === "unknown" && reviewVersion?.kind === "unknown") return "proven";
  return sameVersion(test.work_version, reviewVersion) ? "proven" : "unknown";
}

// Bridge's decision once the reviewer's answer is valid: every condition proven delivers; any
// failed one goes back to the writer through the reviewer's FAIL; otherwise the human decides.
export function decideAcceptance(rows) {
  if (rows.some((row) => row.result === "failed")) return "failed";
  if (rows.every((row) => row.result === "proven")) return "proven";
  return "unknown";
}
