// RC3-ASK-01 a: when a work order stops to ask the person. Every model call here is the fake CLI.
// Keeps the person's database out of these tests (see the fixture).
import { dataHome, queryRecords } from "./fixtures/isolatedDataHome.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { answersFromOption, clarifyForPlan, nextClarify, questionLines, writeAnswers } from "../features/workOrder/clarify.mjs";
import { startWorkOrder } from "../features/workOrder/commands.mjs";
import { decideCheck, sortQuestions } from "../features/workOrder/contract.mjs";
import { createTranslator } from "../features/workOrder/i18n.mjs";
import { parseWorkOrder } from "../features/workOrder/workOrderFormat.mjs";
import { parseOptions } from "../router/args.mjs";
import { digest } from "../utils/digest.mjs";
import { getBridgePaths } from "../utils/paths.mjs";
import { nodeTooOld } from "../utils/nodeVersion.mjs";
import { fakeQuestion } from "./fixtures/fakeAnswers.mjs";
import { KEYS, ptySkip, terminal } from "../../tests/pty.mjs";

const runtime = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.resolve(runtime, "..");
const bootstrap = path.join(runtime, "bootstrap.mjs");
const LIMIT = { timeout: 240_000 };

async function freePort() {
  const net = await import("node:net");
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function install(t, { locale = null } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-clarify-"));
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "clarify-demo", scripts: { test: "node -e \"process.exit(0)\"" } }));
  await fsp.writeFile(path.join(root, "README.md"), "# demo\n");
  const init = spawnSync(process.execPath, [
    path.join(packageRoot, "bridge.mjs"), "init", "--target", root, "--writer", "claude", "--reviewer", "codex", "--yes", "--fake-cli", "--port", String(await freePort()),
  ], { cwd: packageRoot, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, REVIEW_BRIDGE_DATA_HOME: dataHome } });
  assert.equal(init.status, 0, init.stderr);
  const paths = getBridgePaths(root, runtime, { privateRootName: ".review-bridge" });
  if (locale) {
    const config = JSON.parse(await fsp.readFile(paths.bridgeConfigPath, "utf8"));
    await fsp.writeFile(paths.bridgeConfigPath, JSON.stringify({ ...config, locale }, null, 2));
  }
  const bridge = (args, env = {}) => spawnSync(process.execPath, [bootstrap, ...args], { cwd: root, encoding: "utf8", windowsHide: true, env: { ...process.env, ...env } });
  t.after(async () => {
    bridge(["down"]);
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });
  return { root, bridge, paths };
}

// Lines 1 to 9: the work is on line 5, its one condition on line 9.
const ORDER = "# Work order: farm\n\n<!-- bridge:requested_work -->\n## Work\nAdd a shiny button.\n\n<!-- bridge:acceptance -->\n## Acceptance\n- A shiny button shows.\n";
const ANSWERED = "bridge:clarifications";
const asked = (question, line = 5, blocks = "implementation") => fakeQuestion({ question, blocks, refs: [{ start: line, end: line }], readings: [question + " first", question + " second", question + " third"] });

async function orderFile(rt, name, text = ORDER, directory = null) {
  const folder = path.join(rt.root, ".review-bridge", "work-packages", ...(directory ? [directory] : []));
  await fsp.mkdir(folder, { recursive: true });
  const file = path.join(folder, name + ".md");
  await fsp.writeFile(file, text);
  return { file, shown: ".review-bridge/work-packages/" + (directory ? directory + "/" : "") + name + ".md" };
}

async function scripted(rt, entries) {
  // In the data home, which the fixture removes when the file's tests end.
  const file = path.join(dataHome, "check-script-" + Math.random().toString(16).slice(2) + ".json");
  await fsp.writeFile(file, JSON.stringify(entries));
  return { FAKE_CHECK_SCRIPT: file };
}

// The run's columns, its plan, and the state it closed with (kept in its running copy).
async function runsOf(rt, shown) {
  const rows = await queryRecords("select r.run_id, r.conclusion, r.closed_reason, r.contract_sha256, p.body from runs r join plans p using (plan_sha256) where r.project_id = $1 and p.source_file = $2 order by r.created_at", [JSON.parse(await fsp.readFile(rt.paths.bridgeConfigPath, "utf8")).project_id, shown]);
  return await Promise.all(rows.map(async (row) => ({ ...row, last_state: JSON.parse(await fsp.readFile(path.join(rt.paths.runsDir, row.run_id + ".json"), "utf8")).last_state })));
}

async function resultsOf(rt, name) {
  const folder = path.join(rt.root, ".review-bridge", "results", name);
  const files = (await fsp.readdir(folder)).filter((file) => file.endsWith(".md")).sort();
  return await Promise.all(files.map((file) => fsp.readFile(path.join(folder, file), "utf8")));
}

// The gatherings of a file: each translation's state, outside any run.
const gatheringsOf = (rt, shown) => queryRecords(
  "select g.status, g.outcome, g.contract_sha256, p.proposed_run_id from contract_gatherings g join plans p using (plan_sha256) where p.project_id = $1 and p.source_file = $2 order by g.created_at",
  [rt.paths.projectId, shown],
);

const calls = (log) => fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line).mode);

const contractOf = async (rt, sha256) => JSON.parse(await fsp.readFile(path.join(rt.paths.contractsDir, sha256 + ".json"), "utf8"));

test("which questions reach the person: the first three of the askable, in the reviewer's order; the rest are settled", () => {
  const five = ["a", "b", "c", "d", "e"].map((name) => asked(name));
  const sorted = sortQuestions(five, { maxQuestions: 3 });
  assert.deepEqual(sorted.questions.map((item) => item.question), ["a", "b", "c"]);
  assert.deepEqual(sorted.assumptions.map((item) => [item.question, item.adopted, item.decided_by]), [["d", "d first", "suggested"], ["e", "e first", "suggested"]]);

  const mixed = sortQuestions([
    asked("impl"), asked("pref", 5, "preference"), fakeQuestion({ question: "usual", convention: true }), fakeQuestion({ question: "claimed", convention: true, readings: [{ text: "no basis", precedent: null }, "other"] }),
  ], { maxQuestions: 3 });
  // A convention nobody can name is not one: it is asked.
  assert.deepEqual(mixed.questions.map((item) => item.question), ["impl", "claimed"]);
  assert.deepEqual(mixed.assumptions.map((item) => [item.question, item.decided_by]), [["pref", "suggested"], ["usual", "convention"]]);

  const ai = sortQuestions([asked("again", 5, "verification")], { maxQuestions: 3, clarify: { round: 2, ai_decides: true, open_refs: [] } });
  assert.deepEqual([ai.questions, ai.assumptions[0].decided_by], [[], "ai"]);

  // After the first round only the lines the person answered in their own words may come back.
  const open = { round: 2, ai_decides: false, open_refs: [{ start: 5, end: 5 }, { start: 12, end: 12 }] };
  const later = sortQuestions([asked("same"), asked("their words", 12), asked("other", 9, "verification")], { maxQuestions: 3, clarify: open });
  assert.deepEqual(later.questions.map((item) => item.question), ["same", "their words"]);
  assert.deepEqual(later.assumptions.map((item) => [item.question, item.decided_by]), [["other", "suggested"]]);

  // A proposal of acceptance has nothing to fall back on.
  const proposal = fakeQuestion({ question: "done when?", acceptance_proposal: true });
  assert.equal(sortQuestions([proposal], { maxQuestions: 3, clarify: { round: 2, ai_decides: true, open_refs: [] } }).questions.length, 1);
});

test("readings: at most three, the unnamed dropped, the recommendation kept for the AI; a lookup without a tool is not one", () => {
  const five = ["1", "2", "3", "4", "5"];
  assert.deepEqual(sortQuestions([fakeQuestion({ readings: five })], { maxQuestions: 3 }).questions[0].readings.map((reading) => reading.text), ["1", "2", "3"]);
  const dropped = sortQuestions([fakeQuestion({ readings: [{ text: "first", precedent: null }, "second"] })], { maxQuestions: 3 }).questions[0];
  assert.deepEqual([dropped.readings.map((reading) => reading.text), dropped.recommended.text, dropped.no_precedent], [["second"], "first", false]);
  const none = sortQuestions([fakeQuestion({ readings: [{ text: "only", precedent: null }] })], { maxQuestions: 3 }).questions[0];
  assert.deepEqual([none.readings, none.recommended.text, none.no_precedent], [[], "only", true]);
  const looked = (lookupHeld) => sortQuestions([fakeQuestion({ readings: [{ text: "x", precedent: { source: "lookup", note: "400k a week" } }] })], { maxQuestions: 3, lookupHeld }).questions[0].readings[0].precedent.source;
  assert.equal(looked(false), "knowledge");
  assert.equal(looked(true), "lookup");
});

test("an answer in the wrong shape is malformed, never shown: a missing field, lines that are not there, a proposal where acceptance exists", async () => {
  const candidate = { acceptance: [] };
  const answer = (ambiguities) => ({ event: "contract.check", candidate_sha256: "a".repeat(64), acceptance: [], missing: [], ambiguities, cannot_confirm: false, cannot_confirm_reason: null });
  const decide = (ambiguities, extra = {}) => decideCheck(answer(ambiguities), { candidate, sha256: "a".repeat(64), lineCount: 9, ...extra });
  const { blocks, ...noBlocks } = asked("a");
  assert.equal(blocks, "implementation");
  assert.equal((await decide([noBlocks])).decision, "malformed");
  assert.equal((await decide([{ ...asked("a"), readings: [] }])).decision, "malformed");
  assert.equal((await decide([{ ...asked("a"), source_refs: [] }])).decision, "malformed");
  assert.equal((await decide([asked("a", 10)])).decision, "malformed");
  assert.equal((await decide([fakeQuestion({ acceptance_proposal: true })])).decision, "malformed");
  // With no acceptance there is exactly one proposal.
  assert.equal((await decide([], { proposing: true })).decision, "malformed");
  assert.equal((await decide([fakeQuestion({ acceptance_proposal: true })], { proposing: true })).decision, "needs_human");
});

test("--answer: a number in range, ai, or the person's words; anything else is refused", () => {
  const questions = [asked("one"), asked("two")].map((item) => sortQuestions([item], { maxQuestions: 3 }).questions[0]);
  assert.deepEqual(answersFromOption(["2", "1"], questions).map((answer) => [answer.kind, answer.text]), [["reading", "one second"], ["reading", "two first"]]);
  assert.deepEqual(answersFromOption(["圓一點", "ai"], questions).map((answer) => [answer.kind, answer.text]), [["person", "圓一點"], ["ai", "two first"]]);
  assert.deepEqual(answersFromOption(["AI"], questions).map((answer) => answer.kind), ["ai", "ai"]);
  assert.deepEqual(answersFromOption(["２", "3"], questions).map((answer) => answer.kind), ["reading", "reading"]);
  assert.throws(() => answersFromOption(["4", "1"], questions), /not one of question 1's 3 reading/);
  assert.throws(() => answersFromOption(["1"], questions), /2 question\(s\) and 1 --answer/);
  assert.throws(() => answersFromOption(["1", "1", "1"], questions), /more --answer than that/);
  assert.throws(() => answersFromOption(["  ", "1"], questions), /is empty/);
  assert.deepEqual(parseOptions(["--answer", "2", "--answer", "圓一點"], { "--answer": { key: "answer", type: "string", multiple: true } }), { answer: ["2", "圓一點"] });
});

test("the answer goes at the end of the work order: every byte the person wrote stays, whatever its line endings", async (t) => {
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-clarify-file-"));
  t.after(() => fsp.rm(folder, { recursive: true, force: true }));
  const en = await createTranslator("en");
  const at = new Date("2026-11-06T03:52:00Z");
  const write = async (text, answers, questions = [{ question: "Which way?", source_refs: [{ start: 1, end: 1 }] }]) => {
    const file = path.join(folder, "w.md");
    await fsp.writeFile(file, text);
    const lines = await writeAnswers({ t: en, file, sealedSha256: digest(text.trim()), questions, answers, now: at });
    return { after: await fsp.readFile(file, "utf8"), lines };
  };
  for (const eol of ["\n", "\r\n"]) {
    const text = ORDER.replaceAll("\n", eol);
    const { after, lines } = await write(text, [{ kind: "reading", text: "The usual one" }]);
    assert.ok(after.startsWith(text));
    assert.match(after, new RegExp(eol + eol + "<!-- bridge:clarifications -->" + eol + "## Clarifications" + eol + "- 2026-11-06 \\d\\d:52 About \"Which way\\?\": The usual one" + eol + "$"));
    assert.equal(after.split(eol)[lines[0] - 1].startsWith("- 2026-11-06"), true);
    assert.equal(parseWorkOrder(after).blocks.get("clarifications").content.length, 1);
    assert.deepEqual([...parseWorkOrder(after).blocks.keys()], ["requested_work", "acceptance", "clarifications"]);
  }
  // No line ending at the end of the file: one is added, nothing else moves.
  const bare = await write(ORDER.trimEnd(), [{ kind: "person", text: "Rounder" }]);
  assert.ok(bare.after.startsWith(ORDER.trimEnd() + "\n\n<!-- bridge:clarifications -->"));
  // A later answer joins the block; the first stays as it was, and a block after it is not touched.
  const first = (await write(ORDER, [{ kind: "person", text: "Rounder" }])).after;
  const tailed = first + "\n<!-- bridge:references -->\n## References\nA link\n";
  const second = await write(tailed, [{ kind: "ai", text: "Slower" }]);
  assert.ok(second.after.startsWith(first.trimEnd() + "\n- 2026-11-06"));
  assert.ok(second.after.endsWith("(decided by the AI; later details too)\n\n<!-- bridge:references -->\n## References\nA link\n"));
  assert.equal(parseWorkOrder(second.after).blocks.get("clarifications").content.length, 2);

  // A proposal chosen fills the acceptance block, as a new block or the template's empty one.
  const proposal = [{ question: "Done when?", acceptance_proposal: true, source_refs: [{ start: 5, end: 5 }] }];
  const noAcceptance = "# Farm\n\n<!-- bridge:requested_work -->\n## Work\nA button.\n";
  const added = await write(noAcceptance, [{ kind: "reading", text: "It shows.\nIt shines." }], proposal);
  assert.equal(added.after, noAcceptance + "\n<!-- bridge:acceptance -->\n## Acceptance\n1. It shows.\n2. It shines.\n");
  const emptyBlock = "# Farm\n\n<!-- bridge:acceptance -->\n## 驗收\n\n<!-- bridge:references -->\n## References\n";
  const filled = await write(emptyBlock, [{ kind: "reading", text: "It shows." }], proposal);
  assert.equal(filled.after, "# Farm\n\n<!-- bridge:acceptance -->\n## 驗收\n1. It shows.\n\n<!-- bridge:references -->\n## References\n");
  // Handing it to the AI says so; words of their own are not acceptance yet.
  assert.match((await write(noAcceptance, [{ kind: "ai", text: "It shows." }], proposal)).after, /1\. It shows\.[\s\S]*bridge:clarifications[\s\S]*decided by the AI/);
  const said = (await write(noAcceptance, [{ kind: "person", text: "When it looks right" }], proposal)).after;
  assert.equal(parseWorkOrder(said).acceptance.length, 0);
  assert.match(said, /When it looks right/);

  // A file that changed since the questions is not written.
  const file = path.join(folder, "w.md");
  await fsp.writeFile(file, ORDER + "changed\n");
  await assert.rejects(writeAnswers({ t: en, file, sealedSha256: digest(ORDER.trim()), questions: proposal, answers: [{ kind: "person", text: "x" }] }), /changed after these questions/);
  assert.equal(await fsp.readFile(file, "utf8"), ORDER + "changed\n");
  assert.equal(fs.readdirSync(folder).length, 1);
});

test("the next plan's record: the round, the AI's say, and only the person's own words stay open", () => {
  const questions = [{ question: "a", source_refs: [{ start: 5, end: 5 }] }, { question: "b", source_refs: [{ start: 9, end: 9 }] }];
  const next = nextClarify(null, { questions, answers: [{ kind: "person", text: "mine" }, { kind: "reading", text: "theirs" }], lines: [12, 13] });
  assert.deepEqual(next, {
    round: 2, ai_decides: false, open_refs: [{ start: 5, end: 5 }, { start: 12, end: 12 }],
    history: [{ round: 1, items: [{ question: "a", answer: "mine", kind: "person" }, { question: "b", answer: "theirs", kind: "reading" }] }],
  });
  const after = nextClarify(next, { questions: questions.slice(0, 1), answers: [{ kind: "ai", text: "x" }], lines: [14] });
  assert.deepEqual([after.round, after.ai_decides, after.open_refs, after.history.length], [3, true, [], 2]);
});

test("what the work order itself says counts on a new start: the AI's say is read from its clarifications, in any language Bridge has", async () => {
  const withLine = (line) => parseWorkOrder(ORDER + "\n<!-- bridge:clarifications -->\n## Clarifications\n" + line + "\n");
  const zh = await createTranslator("zh-TW");
  const en = await createTranslator("en");
  for (const t of [zh, en]) {
    const line = "- 2026-11-06 11:52 " + t("clarify.line", { question: "q", answer: "a" }) + t("clarify.line.ai");
    assert.deepEqual(await clarifyForPlan(null, withLine(line)), { round: 1, open_refs: [], history: [], ai_decides: true });
    // What the loop carried stays, with the AI's say added.
    assert.deepEqual(await clarifyForPlan({ round: 3, ai_decides: false, open_refs: [{ start: 1, end: 1 }], history: [] }, withLine(line)), { round: 3, ai_decides: true, open_refs: [{ start: 1, end: 1 }], history: [] });
  }
  // Their own words, or no block: nothing is handed over.
  assert.equal(await clarifyForPlan(null, withLine("- 2026-11-06 11:52 About q: a")), null);
  assert.equal(await clarifyForPlan(null, parseWorkOrder(ORDER)), null);
  const carried = { round: 2, ai_decides: false, open_refs: [], history: [] };
  assert.equal(await clarifyForPlan(carried, parseWorkOrder(ORDER)), carried);
});

test("Node from 22.8: styleText honours the colour settings from there", () => {
  assert.deepEqual(["20.18.0", "22.7.0", "22.8.0", "22.13.1", "24.0.0"].map(nodeTooOld), [true, true, false, false, false]);
});

test("the fixed words: all in one language, by the project's locale", async () => {
  const en = await createTranslator("en");
  const zh = await createTranslator("zh-TW");
  const question = sortQuestions([fakeQuestion({ question: "流光怎麼做？", readings: ["漸層位移"] })], { maxQuestions: 3 }).questions[0];
  const inZh = questionLines(zh, [question]).join("\n");
  assert.match(inZh, /未查證/);
  assert.match(inZh, /建議/);
  assert.match(inZh, /交給 AI 決定/);
  assert.match(inZh, /自己說/);
  assert.doesNotMatch(inZh.replaceAll("the usual way", "").replace("ai)", "").replace("AI", ""), /[A-Za-z]/);
  const inEn = questionLines(en, [sortQuestions([fakeQuestion({ question: "How?", readings: ["Shift"] })], { maxQuestions: 3 }).questions[0]]).join("\n");
  assert.match(inEn, /Let the AI decide/);
  assert.match(inEn, /Say it yourself/);
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(inEn, /[^\x00-\x7F]/);
  const keys = (file) => Object.keys(JSON.parse(fs.readFileSync(path.join(runtime, "features/workOrder/locales", file), "utf8"))).filter((key) => key.startsWith("clarify.")).sort();
  assert.deepEqual(keys("zh-TW.json"), keys("en.json"));
});

test("no model call before the first yes, the read-only check among them; after it, the check comes first", LIMIT, async (t) => {
  const rt = await install(t);
  const { file, shown } = await orderFile(rt, "farm");
  const log = path.join(dataHome, "calls-" + Math.random().toString(16).slice(2) + ".log");
  const card = rt.bridge(["start", shown, "--fake-cli"], { FAKE_CALL_LOG: log });
  assert.equal(card.status, 1, card.stdout + card.stderr);
  assert.match(card.stdout, /A second card comes before any work/);
  assert.equal(fs.existsSync(log), false, "the first card calls no model");
  // The real entry, without the fake CLI, so the check is its own.
  const steps = [];
  const options = { taskFile: file, writer: "claude", reviewer: "claude" };
  const context = {
    paths: rt.paths, adapter: null, inspectionAdapter: async () => { throw new Error("nothing asks a CLI here"); },
    loadAdapter: async () => { steps.push("adapter"); throw new Error("not this far"); },
    guard: async () => { steps.push("guard"); },
    reviewerCheck: async () => { steps.push("check"); return { ok: false, reason: "reviewer_not_ready", provider: "claude" }; },
  };
  const silent = t.mock.method(process.stdout, "write", () => true);
  try {
    assert.equal(await startWorkOrder({ ...context, options }), 1);
    assert.deepEqual(steps, [], "nothing before the yes");
    assert.equal(await startWorkOrder({ ...context, options: { ...options, yes: true } }), 1);
    assert.deepEqual(steps, ["check"], "the check first, and a refusal ends it");
  } finally {
    silent.mock.restore();
  }
  assert.deepEqual(await runsOf(rt, shown), []);
});

test("without a terminal: the questions are printed and the command exits 0, with no run; --answer writes back and ends at the sealed card, and --yes delivers version 2", LIMIT, async (t) => {
  const rt = await install(t);
  const { file, shown } = await orderFile(rt, "farm");
  const env = await scripted(rt, [
    { unless: ANSWERED, ambiguities: [asked("How should it shine?"), asked("Which colour?", 9, "verification"), asked("Which button?"), asked("nobody minds", 5, "preference")] },
    { ambiguities: [asked("nobody minds", 5, "preference"), fakeQuestion({ question: "usual", convention: true })] },
  ]);
  const start = (...args) => rt.bridge(["start", shown, "--fake-cli", ...args], env);
  assert.equal(start().status, 1);
  const stopped = start("--yes");
  assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
  assert.match(stopped.stdout, /farm\.md stopped to ask you:\n1\. How should it shine\?\n {3}1\) How should it shine\? first \(not checked: the usual way; recommended\)\n {3}2\) .*\n {3}3\) .*\n {3}ai\) Let the AI decide.*\n {3}Say it yourself\n2\. Which colour\?/);
  assert.match(stopped.stdout, /To answer: review-bridge start .*farm\.md --fake-cli --answer <n\|ai\|text>/);
  assert.doesNotMatch(stopped.stdout, /nobody minds/);
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(stopped.stdout, /\x1b\[/);
  assert.deepEqual(await runsOf(rt, shown), [], "the questions are asked outside any run");
  assert.deepEqual((await gatheringsOf(rt, shown)).map((row) => row.status), ["asking"]);

  // Each mistake is refused, with nothing written.
  for (const [args, said] of [
    [["--answer", "9", "--answer", "1", "--answer", "1"], /not one of question 1's 3 reading/],
    [["--answer", "1"], /3 question\(s\) and 1 --answer/],
    [["--answer", "1", "--answer", "1", "--answer", "1", "--yes"], /--answer and --yes go in two runs/],
  ]) {
    const refused = start(...args);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr + refused.stdout, said);
    assert.equal(await fsp.readFile(file, "utf8"), ORDER);
  }
  const onDirectory = await orderFile(rt, "a", ORDER, "line");
  assert.ok(onDirectory);
  const directoryAnswer = rt.bridge(["start", ".review-bridge/work-packages/line", "--fake-cli", "--answer", "1"], env);
  assert.equal(directoryAnswer.status, 2);
  assert.match(directoryAnswer.stderr + directoryAnswer.stdout, /--answer is about one work order's questions/);
  await fsp.writeFile(file, ORDER + "\nA later note.\n");
  const changed = start("--answer", "1", "--answer", "1", "--answer", "1");
  assert.equal(changed.status, 2);
  assert.match(changed.stderr + changed.stdout, /changed after these questions/);
  await fsp.writeFile(file, ORDER);
  // An answer spends model calls on the first yes, which does not hold for ever.
  const lastsUntil = async (when) => queryRecords("update plans set authorization_expires_at = " + when + ", body = jsonb_set(body, '{authorization_expires_at}', to_jsonb(" + when + ")) where project_id = $1 and source_file = $2", [rt.paths.projectId, shown]);
  await lastsUntil("now() - interval '1 second'");
  const expired = start("--answer", "1", "--answer", "1", "--answer", "1");
  assert.equal(expired.status, 2);
  assert.match(expired.stderr + expired.stdout, /The yes these questions came under was valid until/);
  assert.equal(await fsp.readFile(file, "utf8"), ORDER);
  await lastsUntil("now() + interval '1 hour'");

  // Answered: translated again under the first yes, sealed, and a second card; nothing starts on the answer alone.
  const answered = start("--answer", "2", "--answer", "1", "--answer", "3");
  assert.equal(answered.status, 1, answered.stdout + answered.stderr);
  assert.match(answered.stdout, /"Work order: farm", version 2/);
  assert.match(answered.stdout, /Contract: {5}sealed, sha256 [0-9a-f]{64}/);
  assert.match(answered.stdout, /Needs authorization/);
  const text = await fsp.readFile(file, "utf8");
  assert.ok(text.startsWith(ORDER));
  assert.match(text, /<!-- bridge:clarifications -->\n## Clarifications\n- .* About "How should it shine\?": How should it shine\? second\n/);
  assert.deepEqual(await runsOf(rt, shown), []);

  const delivered = start("--yes");
  assert.equal(delivered.status, 0, delivered.stdout + delivered.stderr);
  const [second] = await runsOf(rt, shown);
  assert.equal(second.conclusion, "success");
  assert.equal(second.body.clarify.round, 2);
  const contract = await contractOf(rt, second.contract_sha256);
  assert.match(contract.clarifications.text, /How should it shine\? second/);
  assert.deepEqual(contract.assumptions.map((item) => [item.question, item.decided_by]), [["nobody minds", "suggested"], ["usual", "convention"]]);
  // The hash the yes covered names the contract the run worked on.
  assert.equal(second.body.contract_sha256, second.contract_sha256);
  // The reviewer checked the candidate; what was sealed adds its assumptions, and the event says both.
  const [sealed] = await queryRecords("select payload from run_events where run_id = $1 and type = 'contract.sealed'", [second.run_id]);
  assert.equal(sealed.payload.contract_sha256, second.contract_sha256);
  assert.match(sealed.payload.candidate_sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(sealed.payload.candidate_sha256, sealed.payload.contract_sha256);
  const translatedIn = rt.paths.runLogDir((await gatheringsOf(rt, shown)).at(-1).proposed_run_id);
  const prompt = await fsp.readFile(path.join(translatedIn, (await fsp.readdir(translatedIn)).find((name) => name.endsWith("-contract-prompt.txt"))), "utf8");
  assert.match(prompt, /=== CLARIFICATIONS ===\n- .*How should it shine\? second/);
  const result = (await resultsOf(rt, "farm")).at(-1);
  assert.match(result, /version_no: 2/);
  assert.match(result, /## Readings adopted\n- About "nobody minds": nobody minds first\n- About "usual": The home page \(the usual convention\)\n/);

  // Delivered: nothing is waiting any more.
  const nothing = start("--answer", "1");
  assert.equal(nothing.status, 2);
  assert.match(nothing.stderr + nothing.stdout, /waiting for no answer/);
});

test("the low-level work-start still translates inside its run, and resume sends its questions to start", LIMIT, async (t) => {
  const rt = await install(t);
  const { shown } = await orderFile(rt, "low");
  const env = await scripted(rt, [{ ambiguities: [asked("How should it shine?")] }]);
  const planned = rt.bridge(["work-plan", shown, "--fake-cli", "--breakpoint", "after the review", "--json"], env);
  assert.equal(planned.status, 0, planned.stdout + planned.stderr);
  const started = rt.bridge(["work-start", "--plan", JSON.parse(planned.stdout).plan_path, "--yes", "--fake-cli"], env);
  assert.equal(started.status, 0, started.stdout + started.stderr);
  const [run] = await runsOf(rt, shown);
  assert.deepEqual([run.conclusion, run.closed_reason], ["action_required", "needs_human"]);
  const why = (await resultsOf(rt, "low"))[0];
  assert.match(why, /1\. How should it shine\?\n {3}1\) How should it shine\? first/);
  assert.match(why, /## Next step\nAnswer the questions above, then start it again\./);
  const resume = rt.bridge(["resume", run.run_id, "--fake-cli"], env);
  assert.equal(resume.status, 2);
  assert.match(resume.stderr + resume.stdout, /stopped on questions for you.*Run: review-bridge start/);
});

test("handing it to the AI covers the whole work order; words of their own come back only on that line, for three rounds", LIMIT, async (t) => {
  const rt = await install(t);
  const ai = await orderFile(rt, "byai");
  const env = await scripted(rt, [
    { unless: ANSWERED, ambiguities: [asked("How should it shine?")] },
    { ambiguities: [asked("And the colour?", 9, "verification")] },
  ]);
  const start = (order, ...args) => rt.bridge(["start", order.shown, "--fake-cli", ...args], env);
  start(ai);
  assert.equal(start(ai, "--yes").status, 0);
  assert.equal(start(ai, "--answer", "ai").status, 1);
  assert.match(await fsp.readFile(ai.file, "utf8"), /How should it shine\? first（?\s*\(decided by the AI; later details too\)/);
  const delivered = start(ai, "--yes");
  assert.equal(delivered.status, 0, delivered.stdout + delivered.stderr);
  const run = (await runsOf(rt, ai.shown)).at(-1);
  assert.equal(run.conclusion, "success");
  assert.deepEqual((await contractOf(rt, run.contract_sha256)).assumptions.map((item) => [item.question, item.decided_by]), [["And the colour?", "ai"]]);

  const own = await orderFile(rt, "own");
  const words = await scripted(rt, [
    { unless: ANSWERED, ambiguities: [asked("How should it shine?")] },
    { ambiguities: [asked("How exactly?"), asked("And the colour?", 9, "verification")] },
  ]);
  const say = (...args) => rt.bridge(["start", own.shown, "--fake-cli", ...args], words);
  say();
  assert.equal(say("--yes").status, 0);
  // No yes between the rounds: each answer is translated under the first one.
  for (const round of [1, 2, 3]) {
    const next = say("--answer", "rounder " + round);
    assert.equal(next.status, 0, next.stdout + next.stderr);
    if (round < 3) {
      assert.match(next.stdout, /1\. How exactly\?/);
      // The other line is settled, not asked.
      assert.doesNotMatch(next.stdout, /And the colour\?/);
    } else {
      // Out of rounds: said where the person is.
      assert.match(next.stdout, /Asked for 3 round\(s\) and it still cannot be settled[\s\S]*Round 1:\n- About "How should it shine\?": rounder 1\nRound 2:\n- About "How exactly\?": rounder 2\nRound 3:\n- About "How exactly\?": rounder 3/);
      assert.match(next.stdout, /1 of 1 have no contract, so no work started/);
    }
  }
  assert.match(say("--answer", "1").stderr, /waiting for no answer/);
  assert.deepEqual(await runsOf(rt, own.shown), []);
  assert.deepEqual((await gatheringsOf(rt, own.shown)).map((row) => row.status), ["asking", "asking", "asking", "stopped"]);
});

test("a work order of one sentence: nothing to cut, so the reviewer proposes acceptance; the chosen set is added, and it runs", LIMIT, async (t) => {
  const rt = await install(t);
  const sentence = "# A shiny button\n\nI want a button with a flowing light on it.\n";
  const { file, shown } = await orderFile(rt, "button", sentence);
  const proposal = fakeQuestion({ question: "How do you tell it is done?", acceptance_proposal: true, refs: [{ start: 3, end: 3 }], readings: ["The button shows.\nThe light flows across it.", "The button shows."] });
  const env = await scripted(rt, [{ unless: "bridge:acceptance", ambiguities: [proposal] }, { ambiguities: [] }]);
  const log = path.join(rt.root, "..", path.basename(rt.root) + "-calls.log");
  t.after(() => fsp.rm(log, { force: true }));
  const start = (...args) => rt.bridge(["start", shown, "--fake-cli", ...args], { ...env, FAKE_CALL_LOG: log });
  start();
  assert.equal(start("--yes").status, 0);
  // Nothing to cut: the writer was not called for it.
  assert.deepEqual(calls(log), ["check"]);
  assert.deepEqual(await runsOf(rt, shown), []);
  const answered = start("--answer", "1");
  assert.equal(answered.status, 1, answered.stdout + answered.stderr);
  assert.equal(await fsp.readFile(file, "utf8"), sentence + "\n<!-- bridge:acceptance -->\n## Acceptance\n1. The button shows.\n2. The light flows across it.\n");
  const delivered = start("--yes");
  assert.equal(delivered.status, 0, delivered.stdout + delivered.stderr);
  const last = (await runsOf(rt, shown)).at(-1);
  assert.equal(last.conclusion, "success");
  assert.deepEqual((await contractOf(rt, last.contract_sha256)).acceptance.map((item) => item.statement), ["The button shows.", "The light flows across it."]);
});

test("a sentence with no title is untitled, on the card and in the result, under results/untitled/; handed to the AI, a new start asks nothing again", LIMIT, async (t) => {
  const rt = await install(t);
  const sentence = "I want a button with a flowing light on it.\n";
  const { file, shown } = await orderFile(rt, "flowing", sentence);
  const proposal = fakeQuestion({ question: "How do you tell it is done?", acceptance_proposal: true, refs: [{ start: 1, end: 1 }], readings: ["The button shows."] });
  const env = await scripted(rt, [
    { unless: "bridge:acceptance", ambiguities: [proposal] },
    { ambiguities: [asked("How exactly should it flow?", 1, "verification")] },
  ]);
  const start = (...args) => rt.bridge(["start", shown, "--fake-cli", ...args], env);
  const card = start();
  assert.match(card.stdout, /New work order "untitled"/);
  assert.equal(start("--yes").status, 0);
  assert.equal(start("--answer", "ai").status, 1);
  const done = start("--yes");
  assert.equal(done.status, 0, done.stdout + done.stderr);
  const [second] = await runsOf(rt, shown);
  assert.equal(second.conclusion, "success");
  const contract = await contractOf(rt, second.contract_sha256);
  assert.deepEqual([contract.ticket.title, contract.assumptions[0].decided_by], [{ text: "untitled", source_refs: [] }, "ai"]);
  const folder = path.join(rt.root, ".review-bridge", "results", "untitled");
  const names = (await fsp.readdir(folder)).filter((name) => name.endsWith(".md"));
  assert.equal(names.length, 1);
  assert.ok(names.every((name) => name.startsWith("flowing ")), names.join());
  assert.match(await fsp.readFile(path.join(folder, names.sort().at(-1)), "utf8"), /^title: untitled$/m);

  // A new version, started plainly: the file still says the later details are the AI's.
  await fsp.appendFile(file, "\nOne more thing: keep it subtle.\n");
  assert.equal(start().status, 1);
  const again = start("--yes");
  assert.equal(again.status, 1, again.stdout + again.stderr);
  assert.doesNotMatch(again.stdout, /stopped to ask you/);
  assert.equal(start("--yes").status, 0);
  const third = (await runsOf(rt, shown)).at(-1);
  assert.deepEqual([third.conclusion, third.body.clarify.round, third.body.clarify.ai_decides], ["success", 1, true]);

  // Taken out of the file, it no longer holds.
  const text = await fsp.readFile(file, "utf8");
  await fsp.writeFile(file, text.replace(/ \(decided by the AI; later details too\)/, ""));
  assert.equal(start().status, 1);
  const asks = start("--yes");
  assert.equal(asks.status, 0, asks.stdout + asks.stderr);
  assert.match(asks.stdout, /How exactly should it flow?/);
});

test("a directory: a work order with no acceptance runs like any other; only what cannot be read, and the templates, are left out", LIMIT, async (t) => {
  const rt = await install(t);
  await orderFile(rt, "01-sentence", "Add a shiny button.\n", "line");
  await orderFile(rt, "02-titled", "# Notes\n\nSome words.\n", "line");
  await orderFile(rt, "03-broken", "# Broken\n\n<!-- bridge:nonsense -->\nA block nobody knows.\n", "line");
  await orderFile(rt, "TEMPLATE", ORDER, "line");
  await orderFile(rt, "TEMPLATE.zh-TW", ORDER, "line");
  const line = ".review-bridge/work-packages/line";
  const proposal = fakeQuestion({ question: "How do you tell it is done?", acceptance_proposal: true, refs: [{ start: 1, end: 1 }], readings: ["It shows."] });
  const env = await scripted(rt, [{ unless: "bridge:acceptance", ambiguities: [proposal] }]);
  const card = rt.bridge(["start", line, "--fake-cli"], env);
  assert.equal(card.status, 1);
  assert.match(card.stdout, /5 file\(s\): 0 delivered, 3 not a work order, 2 to run/);
  assert.match(card.stdout, /01-sentence\.md +sha256 \S+ +\(no acceptance yet: the reviewer proposes some and you choose\)/);
  assert.match(card.stdout, /03-broken\.md +not a work order \(line 3: unknown block key nonsense/);
  assert.match(card.stdout, /TEMPLATE\.md +not a work order \(it is a template to copy from\)/);
  assert.match(card.stdout, /TEMPLATE\.zh-TW\.md +not a work order \(it is a template to copy from\)/);
  const ran = rt.bridge(["start", line, "--fake-cli", "--yes"], env);
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /2 work order\(s\) need your answer/);
  const sentence = rt.bridge(["start", line + "/01-sentence.md", "--fake-cli", "--answer", "1"], env);
  assert.equal(sentence.status, 1, sentence.stdout + sentence.stderr);
  const done = rt.bridge(["start", line + "/01-sentence.md", "--fake-cli", "--yes"], env);
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.equal((await runsOf(rt, line + "/01-sentence.md")).at(-1).conclusion, "success");
  // Only the one still waiting is left to run.
  assert.match(rt.bridge(["start", line, "--fake-cli"], env).stdout, /1 delivered, 3 not a work order, 1 to run/);
});

test("the three questions of the 2026-11-06 canary are conventions: not asked, in the contract, and all three delivered", LIMIT, async (t) => {
  const rt = await install(t);
  const usual = (question, reading) => ({ when: "demo " + question, ambiguities: [fakeQuestion({ question, convention: true, blocks: "verification", readings: [{ text: reading, precedent: { source: "knowledge", note: "the convention" } }, "the other reading"] })] });
  const env = await scripted(rt, [
    usual("npm install is not in scripts", "npm install is npm's own; only the start command is in scripts"),
    usual("exactly or at least", "at least"),
    usual("a title above Unreleased", "Keep a Changelog keeps a title above it"),
  ]);
  const order = (sentence) => ORDER.replace("Add a shiny button.", "demo " + sentence);
  await orderFile(rt, "01-readme", order("npm install is not in scripts"), "demo");
  await orderFile(rt, "02-contributing", order("exactly or at least"), "demo");
  await orderFile(rt, "03-changelog", order("a title above Unreleased"), "demo");
  const line = ".review-bridge/work-packages/demo";
  rt.bridge(["start", line, "--fake-cli"], env);
  const sealed = rt.bridge(["start", line, "--fake-cli", "--yes"], env);
  assert.equal(sealed.status, 1, sealed.stdout + sealed.stderr);
  assert.doesNotMatch(sealed.stdout, /stopped to ask you/);
  const done = rt.bridge(["start", line, "--fake-cli", "--yes"], env);
  assert.equal(done.status, 0, done.stdout + done.stderr);
  for (const [name, adopted] of [["01-readme", /only the start command/], ["02-contributing", /at least/], ["03-changelog", /Keep a Changelog/]]) {
    const [run] = await runsOf(rt, line + "/" + name + ".md");
    assert.equal(run.conclusion, "success", name);
    const contract = await contractOf(rt, run.contract_sha256);
    assert.equal(contract.assumptions[0].decided_by, "convention");
    assert.match(contract.assumptions[0].adopted, adopted);
  }
});

test("a reviewer's answer in the wrong shape never reaches the person: it is asked once more, under the same count, and the writer is not", LIMIT, async (t) => {
  const rt = await install(t);
  const { blocks: _blocks, ...noBlocks } = asked("Missing its level");
  const log = path.join(rt.root, "..", path.basename(rt.root) + "-calls.log");
  t.after(() => fsp.rm(log, { force: true }));
  const { shown } = await orderFile(rt, "shape");
  const env = await scripted(rt, [{ malformed: [noBlocks] }]);
  rt.bridge(["start", shown, "--fake-cli"], env);
  const stopped = rt.bridge(["start", shown, "--fake-cli", "--yes"], { ...env, FAKE_CALL_LOG: log });
  assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
  assert.doesNotMatch(stopped.stdout, /Missing its level/);
  assert.deepEqual(calls(log), ["translation", "check", "check"]);
  assert.deepEqual(await runsOf(rt, shown), []);
  assert.deepEqual((await gatheringsOf(rt, shown)).map((row) => [row.status, row.outcome.status]), [["stopped", "contract_unconfirmed"]]);
});

test("a line: every question at once, in the person's language, before any run; without a terminal there is no colour, and --answer leads to one card for all", LIMIT, async (t) => {
  const rt = await install(t, { locale: "zh-TW" });
  await orderFile(rt, "01-a", ORDER, "two");
  await orderFile(rt, "02-b", ORDER.replaceAll("shiny", "plain"), "two");
  await orderFile(rt, "03-c", ORDER, "two");
  const line = ".review-bridge/work-packages/two";
  const env = await scripted(rt, [{ when: "shiny", unless: ANSWERED, ambiguities: [asked("流光怎麼做？")] }]);
  rt.bridge(["start", line, "--fake-cli"], env);
  const run = rt.bridge(["start", line, "--fake-cli", "--yes"], { ...env, NO_COLOR: "1" });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /\[2\/3\] 02-b\.md：合約已封存/);
  assert.match(run.stdout, /01-a\.md 停下來問你：\n1\. 流光怎麼做？/);
  assert.match(run.stdout, /03-c\.md 停下來問你：/);
  assert.match(run.stdout, /2 張要你回答，見上面。/);
  assert.match(run.stdout, /要回答：review-bridge start .*01-a\.md --fake-cli --answer <n\|ai\|text>，每題一個，照題序。/);
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(run.stdout, /\x1b\[/);
  assert.deepEqual(await queryRecords("select 1 from runs where project_id = $1", [rt.paths.projectId]), [], "no work before the questions are done");

  // The agent answers each, then asks for the directory again: one card, one yes, and what was sealed is not paid for twice.
  for (const name of ["01-a", "03-c"]) {
    const answered = rt.bridge(["start", line + "/" + name + ".md", "--fake-cli", "--answer", "1"], env);
    assert.equal(answered.status, 1, answered.stdout + answered.stderr);
  }
  const log = path.join(dataHome, "calls-" + Math.random().toString(16).slice(2) + ".log");
  const card = rt.bridge(["start", line, "--fake-cli"], { ...env, FAKE_CALL_LOG: log });
  assert.equal(card.status, 1, card.stdout + card.stderr);
  assert.match(card.stdout, /01-a\.md +contract sha256 [0-9a-f]{4}… {3}version 2/);
  assert.match(card.stdout, /02-b\.md +contract sha256 [0-9a-f]{4}… {3}version 1/);
  assert.match(card.stdout, /03-c\.md +contract sha256 [0-9a-f]{4}… {3}version 2/);
  assert.equal(fs.existsSync(log), false, "nothing to translate, so no model call");
  const ran = rt.bridge(["start", line, "--fake-cli", "--yes"], { ...env, FAKE_CALL_LOG: log });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.ok(calls(log).every((mode) => mode !== "translation"), calls(log).join());
  for (const name of ["01-a", "02-b", "03-c"]) assert.equal((await runsOf(rt, line + "/" + name + ".md"))[0].conclusion, "success", name);
});

test("at a terminal: yellow, three questions at most, the second reading of each, the new version's card, y, delivered", { ...LIMIT, skip: ptySkip }, async (t) => {
  const rt = await install(t);
  const { file, shown } = await orderFile(rt, "farm");
  const env = await scripted(rt, [
    { unless: ANSWERED, ambiguities: [asked("How should it shine?"), asked("Which button?"), asked("Which colour?", 9, "verification"), asked("nobody minds", 5, "preference"), asked("nor this", 9, "preference")] },
    { ambiguities: [asked("nobody minds", 5, "preference"), asked("nor this", 9, "preference")] },
  ]);
  const screen = terminal([bootstrap, "start", shown, "--fake-cli", "--breakpoint", "after the review"], { cwd: rt.root, env: { ...process.env, ...env } });
  t.after(() => screen.kill());
  await screen.waitFor(/Turn it into a contract and ask what it leaves open\? \[y\/N\]/);
  screen.press("y" + KEYS.enter);
  await screen.waitFor(/How should it shine\?/);
  assert.ok(screen.raw().includes("\x1b[33m"), "the stop is yellow");
  screen.press(KEYS.down + KEYS.enter);
  await screen.waitFor(/Which button\?/);
  screen.press(KEYS.down + KEYS.enter);
  await screen.waitFor(/Which colour\?/);
  screen.press(KEYS.down + KEYS.enter);
  await screen.waitFor(/version 2/);
  await screen.waitFor(/Start this work\? \[y\/N\]\s*$/);
  assert.doesNotMatch(screen.text(), /nobody minds/);
  screen.press("y" + KEYS.enter);
  assert.equal(await screen.exited, 0, screen.text());
  const text = await fsp.readFile(file, "utf8");
  assert.ok(text.startsWith(ORDER));
  for (const chosen of ["How should it shine? second", "Which button? second", "Which colour? second"]) assert.ok(text.includes(chosen), chosen);
  const result = (await resultsOf(rt, "farm")).at(-1);
  assert.match(result, /version_no: 2/);
  assert.match(result, /## Readings adopted\n- About "nobody minds"/);
});

test("at a terminal, cancelling the questions leaves the work order as it was, with no run; the next start is a new one", { ...LIMIT, skip: ptySkip }, async (t) => {
  const rt = await install(t);
  const { file, shown } = await orderFile(rt, "farm");
  const env = await scripted(rt, [{ unless: ANSWERED, ambiguities: [asked("How should it shine?"), asked("Which button?")] }]);
  const open = () => {
    const screen = terminal([bootstrap, "start", shown, "--fake-cli", "--breakpoint", "after the review"], { cwd: rt.root, env: { ...process.env, NO_COLOR: "1", ...env } });
    t.after(() => screen.kill());
    return screen;
  };
  const first = open();
  await first.waitFor(/Turn it into a contract/);
  first.press("y" + KEYS.enter);
  await first.waitFor(/How should it shine\?/);
  assert.ok(!first.raw().includes("\x1b[33m"), "NO_COLOR: no yellow");
  // The first is answered, the second cancelled: nothing of it is kept.
  first.press(KEYS.enter);
  await first.waitFor(/Which button\?/);
  first.press(KEYS.ctrlC);
  assert.equal(await first.exited, 130, first.text());
  assert.match(first.text(), /The work order was not changed/);
  assert.equal(await fsp.readFile(file, "utf8"), ORDER);
  assert.deepEqual(await runsOf(rt, shown), []);

  const second = open();
  await second.waitFor(/Turn it into a contract/);
  second.press("n" + KEYS.enter);
  assert.equal(await second.exited, 1);
  assert.equal(second.text().includes("How should it shine?"), false);
});

test("at a terminal, a no to the second card: no run, and the contract and the answers stay; started again, no model is paid and no first card is asked", { ...LIMIT, skip: ptySkip }, async (t) => {
  const rt = await install(t);
  const { file, shown } = await orderFile(rt, "farm");
  const env = await scripted(rt, [{ unless: ANSWERED, ambiguities: [asked("How should it shine?")] }]);
  const log = path.join(dataHome, "calls-" + Math.random().toString(16).slice(2) + ".log");
  const open = () => {
    const screen = terminal([bootstrap, "start", shown, "--fake-cli", "--breakpoint", "after the review"], { cwd: rt.root, env: { ...process.env, ...env, FAKE_CALL_LOG: log } });
    t.after(() => screen.kill());
    return screen;
  };
  const first = open();
  await first.waitFor(/Turn it into a contract/);
  first.press("y" + KEYS.enter);
  await first.waitFor(/How should it shine\?/);
  first.press(KEYS.enter);
  await first.waitFor(/Start this work\? \[y\/N\]\s*$/);
  first.press("n" + KEYS.enter);
  assert.equal(await first.exited, 1, first.text());
  assert.match(first.text(), /Not started\. The contracts and your answers stay/);
  assert.deepEqual(await runsOf(rt, shown), []);
  assert.deepEqual((await gatheringsOf(rt, shown)).map((row) => row.status), ["asking", "sealed"]);
  assert.match(await fsp.readFile(file, "utf8"), new RegExp(ANSWERED));
  const before = calls(log).length;

  const second = open();
  await second.waitFor(/Start this work\? \[y\/N\]\s*$/);
  assert.doesNotMatch(second.text(), /Turn it into a contract/);
  assert.equal(calls(log).length, before, "the sealed contract is not paid for again");
  second.press("y" + KEYS.enter);
  assert.equal(await second.exited, 0, second.text());
  assert.equal((await runsOf(rt, shown))[0].conclusion, "success");
  assert.match((await resultsOf(rt, "farm")).at(-1), /version_no: 2/);
});

test("at a terminal, a line is a pipeline: four are turned into contracts, two ask, one answer, one yes, and four runs in order that ask nothing", { ...LIMIT, skip: ptySkip }, async (t) => {
  const rt = await install(t);
  await orderFile(rt, "01-a", ORDER, "four");
  await orderFile(rt, "02-b", ORDER.replaceAll("shiny", "plain"), "four");
  await orderFile(rt, "03-c", ORDER, "four");
  await orderFile(rt, "04-d", ORDER.replaceAll("shiny", "plain"), "four");
  const line = ".review-bridge/work-packages/four";
  const env = await scripted(rt, [{ when: "shiny", unless: ANSWERED, ambiguities: [asked("How should it shine?")] }]);
  const log = path.join(dataHome, "calls-" + Math.random().toString(16).slice(2) + ".log");
  const screen = terminal([bootstrap, "start", line, "--fake-cli"], { cwd: rt.root, env: { ...process.env, ...env, FAKE_CALL_LOG: log } });
  t.after(() => screen.kill());
  await screen.waitFor(/Turn these 4 into contracts/);
  assert.equal(fs.existsSync(log), false, "no model call before the first yes");
  screen.press("y" + KEYS.enter);
  // Translated all four first: both questions are out, after the fourth is sealed.
  await screen.waitFor(/2 work order\(s\) need your answer; see above\.[\s\S]*How should it shine\?/);
  assert.ok(screen.text().indexOf("[4/4] 04-d.md: contract sealed") < screen.text().indexOf("2 work order(s) need your answer"));
  // eslint-disable-next-line no-control-regex
  assert.match(screen.raw(), /\x1b\[33m\s*2 work order\(s\) need your answer/);
  // Past the three readings and "let the AI decide": their own words, with a line of text.
  screen.press(KEYS.down + KEYS.down + KEYS.down + KEYS.down + KEYS.enter);
  await screen.waitFor(/In your own words:/);
  screen.press("rounder" + KEYS.enter);
  await screen.waitFor(/03-c\.md stopped to ask you:[\s\S]*03-c\.md stopped to ask you:/);
  screen.press(KEYS.enter);
  await screen.waitFor(/Run these 4 in this order\? \[y\/N\]\s*$/);

  // At the card: every contract sealed, and no run.
  const projectId = rt.paths.projectId;
  const sealed = await queryRecords(
    "select distinct p.source_file from contract_gathering_events e join plans p using (plan_sha256) where p.project_id = $1 and e.event->>'event' = 'contract.sealed'", [projectId]);
  assert.deepEqual(sealed.map((row) => path.posix.basename(row.source_file)).sort(), ["01-a.md", "02-b.md", "03-c.md", "04-d.md"]);
  assert.deepEqual(await queryRecords("select 1 from runs where project_id = $1", [projectId]), []);
  assert.match(screen.text(), /01-a\.md +contract sha256 [0-9a-f]{4}… {3}version 2/);
  assert.match(screen.text(), /02-b\.md +contract sha256 [0-9a-f]{4}… {3}version 1/);
  // Only what was answered was translated again.
  assert.equal(calls(log).filter((mode) => mode === "translation").length, 6);
  const shownBefore = screen.text().length;

  screen.press("y" + KEYS.enter);
  assert.equal(await screen.exited, 0, screen.text());
  assert.doesNotMatch(screen.text().slice(shownBefore), /stopped to ask you|\[y\/N\]/, "nothing is asked once the work starts");
  // Every contract call came before the first writer's call.
  const modes = calls(log);
  assert.ok(modes.lastIndexOf("translation") < modes.indexOf("writer"), modes.join());
  const runs = await queryRecords("select p.source_file, r.conclusion, a.authorized_at from runs r join plans p using (plan_sha256) join authorizations a using (plan_sha256) where r.project_id = $1 order by r.created_at", [projectId]);
  assert.deepEqual(runs.map((run) => [path.posix.basename(run.source_file), run.conclusion]), [["01-a.md", "success"], ["02-b.md", "success"], ["03-c.md", "success"], ["04-d.md", "success"]]);
  assert.equal(new Set(runs.map((run) => run.authorized_at.toISOString())).size, 1, "one yes");
  const folder = path.join(rt.root, ".review-bridge", "work-packages", "four");
  assert.match(await fsp.readFile(path.join(folder, "01-a.md"), "utf8"), /"How should it shine\?": rounder/);
  assert.match(await fsp.readFile(path.join(folder, "03-c.md"), "utf8"), /"How should it shine\?": How should it shine\? first/);
  assert.match((await resultsOf(rt, "four/01-a")).at(-1), /version_no: 2/);
  assert.match((await resultsOf(rt, "four/02-b")).at(-1), /version_no: 1/);
});
