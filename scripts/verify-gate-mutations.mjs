#!/usr/bin/env node
// Do the guards still guard? Each mistake in review-bridge/tests/mutations/cases.json is put back into a
// copy of the tree, and the one test case that exists to catch it must fail for the reason the case
// names (Nanako0129/stingray tests/mutants.sh: "A test that cannot fail is worse than no test").
//
//   node scripts/verify-gate-mutations.mjs [--only <id>,<id>] [--report <file.json>]
//
// The copy is the tree as it is now, HEAD with the working tree's changes, written by Git into a
// temporary index and checked out under the system temp folder: the working tree, the real index and
// every ref stay as they were. Verdicts (validation report §3.3): killed — the baseline is green, the
// mutant went in, and the named case fails with the expected message; survived — the mutant went in and
// the case still passes; invalid — the anchor is gone, the baseline is not green, no test ran, or the
// case fails for another reason. Not part of npm test.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : null; };
const only = option("--only")?.split(",") ?? null;
const reportFile = option("--report");

const { cases } = JSON.parse(fs.readFileSync(path.join(root, "review-bridge", "tests", "mutations", "cases.json"), "utf8"));
const chosen = only ? cases.filter((item) => only.includes(item.id)) : cases;
if (only && chosen.length !== only.length) throw new Error("Unknown case id in --only: " + only.filter((id) => !cases.some((item) => item.id === id)).join(", "));

const work = fs.mkdtempSync(path.join(os.tmpdir(), "rb-gate-mutations-"));
const index = path.join(work, "index");
const git = (gitArgs) => {
  const result = spawnSync("git", gitArgs, { cwd: root, encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_INDEX_FILE: index } });
  if (result.status !== 0) throw new Error("git " + gitArgs.join(" ") + " failed: " + result.stderr.trim());
  return result.stdout.trim();
};
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const runCase = (dir, item) => spawnSync(process.execPath, ["--test", "--test-name-pattern=^" + escape(item.case) + "$", item.test], {
  cwd: dir, encoding: "utf8", windowsHide: true, timeout: 300_000, env: { ...process.env, NODE_OPTIONS: "" },
});
const counts = (result) => ({
  pass: Number(/ℹ pass (\d+)/.exec(result.stdout)?.[1] ?? NaN),
  fail: Number(/ℹ fail (\d+)/.exec(result.stdout)?.[1] ?? NaN),
});

const report = { started_at: new Date().toISOString(), node: process.version, platform: process.platform + " " + os.release(), results: [] };
const links = [];
try {
  // The tree under test: every file Git would add now, tracked or not, ignored ones left out.
  report.head = git(["rev-parse", "HEAD"]);
  git(["add", "-A"]);
  report.tree = git(["write-tree"]);
  report.head_tree = git(["rev-parse", "HEAD^{tree}"]);
  report.working_tree_changed = report.tree !== report.head_tree;

  for (const item of chosen) {
    const dir = path.join(work, item.id);
    fs.mkdirSync(dir);
    git(["checkout-index", "-a", "-f", "--prefix=" + dir.replaceAll("\\", "/") + "/"]);
    // The copy resolves its packages through a link to the project's node_modules, removed before the copy.
    const link = path.join(dir, "node_modules");
    fs.symlinkSync(path.join(root, "node_modules"), link, "junction");
    links.push(link);
    const result = { id: item.id, gate: item.gate, target: item.target, case: item.case, test: item.test, reason: item.reason, baseline_tree: report.tree };
    const baseline = counts(runCase(dir, item));
    result.baseline = baseline;
    const file = path.join(dir, item.target);
    const text = fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n");
    if (!(baseline.fail === 0 && baseline.pass > 0)) {
      Object.assign(result, { result: "invalid", detail: "baseline is not green" });
    } else if (!text.includes(item.anchor)) {
      Object.assign(result, { result: "invalid", detail: "anchor not found: the code under test changed shape" });
    } else {
      fs.writeFileSync(file, text.replace(item.anchor, item.replacement));
      const ran = runCase(dir, item);
      const mutant = counts(ran);
      result.mutant = mutant;
      const output = ran.stdout + ran.stderr;
      if (!(mutant.pass + mutant.fail > 0)) Object.assign(result, { result: "invalid", detail: "no test ran: " + output.split("\n").find((line) => /Error/.test(line))?.trim() });
      else if (mutant.fail === 0) Object.assign(result, { result: "survived", detail: "the case still passes against the mutant" });
      else if (new RegExp(item.expect).test(output)) Object.assign(result, { result: "killed", detail: "failed with: " + item.expect });
      else Object.assign(result, { result: "invalid", detail: "failed, but not with the expected message (" + item.expect + "): " + output.split("\n").find((line) => /Error|actual|expected/.test(line))?.trim() });
    }
    fs.unlinkSync(link);
    links.pop();
    report.results.push(result);
    console.log(result.result.padEnd(9) + " " + item.id + " [" + item.gate + "] " + item.target + " — " + result.detail);
  }
} finally {
  // The links first, so removing the copies never walks into the project's node_modules.
  for (const link of links) fs.unlinkSync(link);
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

report.finished_at = new Date().toISOString();
const tally = Object.fromEntries(["killed", "survived", "invalid"].map((name) => [name, report.results.filter((item) => item.result === name).length]));
console.log("HEAD " + report.head + ", tree " + report.tree + (report.working_tree_changed ? " (HEAD plus the working tree's changes)" : "") + "; killed " + tally.killed + ", survived " + tally.survived + ", invalid " + tally.invalid);
if (reportFile) fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
process.exitCode = tally.survived || tally.invalid ? 1 : 0;
