// The work-order contract (RC3-BLOCKER-00, first part). Starting work authorizes the work-order
// text sealed in the plan. The work order is written in marked blocks (workOrderFormat.mjs), so
// Bridge fills every field from its own block, copying the text as written; no model decides
// which text goes where. The one thing a model does is cut the acceptance blocks into conditions:
// the writer's provider writes them, this module checks what code can check, the reviewer's
// provider reads them against those blocks, and only then is the contract sealed once under its
// hash. Models only read it afterwards. Scope, budget, roles and the verification command stay in
// the work package, which the controller compiled before any model saw the work order.
//
// What code proves here: each condition points at lines inside one acceptance block, quotes them
// verbatim, and every content line of those blocks belongs to a condition. Whether each condition
// says what its lines mean is the reviewer's judgement; it lowers the risk of drift, it is not a
// proof.
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { digest } from "../../utils/digest.mjs";
import { ensureDir } from "../../service/index.mjs";
import { loadSchema, validateAgainstSchema } from "./typedResults.mjs";
import { rangesOf } from "./workOrderFormat.mjs";

const schemasDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "schemas");

export const CONTRACT_TRANSLATION_SCHEMA = path.join(schemasDir, "contract.translation.schema.json");
export const CONTRACT_SCHEMA = path.join(schemasDir, "contract.schema.json");
export const CONTRACT_CHECK_SCHEMA = path.join(schemasDir, "contract.check.schema.json");
export const CONTRACT_MODE_HEADER = "[REVIEW_BRIDGE_MODE: CONTRACT_TRANSLATION]";
export const CHECK_MODE_HEADER = "[REVIEW_BRIDGE_MODE: CONTRACT_CHECK]";
export const CONTRACT_SCHEMA_VERSION = 3;
// A translation the reviewer finds wrong is redone at most this many times in all.
export const MAX_TRANSLATION_ATTEMPTS = 2;
// The translation reads one text and writes one object; it needs no tools and few turns.
export const TRANSLATION_MAX_TURNS = 3;
// Codex's request_user_input takes two or three options, recommended first; a question here shows no more.
export const MAX_READINGS = 3;
const LANGUAGE_RULE = "Write every statement, note and question in the language the work order itself is written in; quotes stay in the work order's own words.";

export class ContractChangedError extends Error {
  constructor(sha256, reason) {
    super("The sealed contract " + sha256 + " " + reason + ".");
    this.name = "ContractChangedError";
    this.sha256 = sha256;
  }
}

// Line numbers are the only way a model may point at the source; the text itself is the sealed task.
export function numberedLines(text) {
  const lines = String(text || "").split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const flat = (text) => String(text).replace(/\s+/g, " ").trim();
const linesOf = (lines, refs) => refs.flatMap((ref) => lines.slice(ref.start - 1, ref.end));

// The acceptance blocks as the models see them: each one named, with the work order's own line
// numbers, so a condition points at the lines it came from.
function acceptanceBlocks(lines, format) {
  const width = String(lines.length).length;
  return format.acceptance.flatMap((block) => [
    "--- " + (block.run ? "acceptance of run " + block.run : "acceptance") + " ---",
    ...block.lines.map((number) => String(number).padStart(width, " ") + "| " + lines[number - 1]),
  ]);
}

// The person's answers, written back at the end of the work order. Not numbered: no condition points at them.
const clarificationLines = (lines, format) => (format.blocks.get("clarifications")?.content || []).map((number) => lines[number - 1]);

export function composeTranslationPrompt({ workPackageId, lines, format, test, attempt = 1, feedback = [] }) {
  const gateLine = test?.kind === "command"
    ? "Bridge will run this verification after the work: " + test.command + ". A condition it can show may use {\"kind\": \"test\", \"check\": null}."
    : "Bridge runs no verification command for this work; every condition uses {\"kind\": \"reviewer\", \"check\": \"<what the reviewer checks>\"}.";
  return [
    CONTRACT_MODE_HEADER,
    "",
    "Injected by the local Review Bridge controller. Work package: " + workPackageId + "  Attempt: " + attempt,
    "Cut the acceptance blocks of a human work order, given below, into conditions: one contract.translation object that matches the JSON schema given to the CLI.",
    "",
    "Rules:",
    "- Bridge has already placed every other part of the work order; you only write conditions.",
    "- Each condition is one complete, checkable result, numbered AC1, AC2, ... in the order given. statement says it in one sentence; quote is a verbatim excerpt of its source_refs lines.",
    "- source_refs are inclusive line ranges, using the line numbers shown, all inside one block. One line may give several conditions and one condition may span several lines, an explanation or example beside it included.",
    "- Every line shown belongs to at least one condition.",
    "- Paths and test hints are context, not permission. You do not choose files, commands, budgets or roles; Bridge already did.",
    "- " + gateLine,
    "- " + LANGUAGE_RULE,
    "- Do not read or change any file; everything you need is below.",
    ...(clarificationLines(lines, format).length ? ["- The CLARIFICATIONS are the person's own answers about this work order. Read the blocks in their light: a statement says what its lines mean as answered there; a quote still comes only from the blocks."] : []),
    ...(feedback.length ? ["", "Your previous translation was refused for these reasons; fix them and translate again:", ...feedback.map((line) => "- " + line)] : []),
    "",
    "=== ACCEPTANCE BLOCKS (line-numbered) ===",
    ...acceptanceBlocks(lines, format),
    "=== END ACCEPTANCE BLOCKS ===",
    ...(clarificationLines(lines, format).length ? ["", "=== CLARIFICATIONS ===", ...clarificationLines(lines, format), "=== END CLARIFICATIONS ==="] : []),
  ].join("\n");
}

function range(ref) {
  return Array.from({ length: Math.max(0, ref.end - ref.start + 1) }, (_, offset) => ref.start + offset);
}

// The block a condition's lines lie in, or null when they lie outside every acceptance block or
// across two.
function blockOf(item, format) {
  const lines = item.source_refs.flatMap((ref) => range(ref));
  return format.acceptance.find((block) => {
    const first = block.lines[0];
    const last = block.lines[block.lines.length - 1];
    return lines.every((line) => line >= first && line <= last);
  }) || null;
}

function acceptanceProblems(acceptance, { lines, format, test }) {
  const problems = [];
  const covered = new Set();
  for (const [index, item] of acceptance.entries()) {
    const at = "$.acceptance[" + index + "]";
    if (item.id !== "AC" + (index + 1)) problems.push(at + ".id: expected AC" + (index + 1));
    const backwards = item.source_refs.findIndex((ref) => ref.start > ref.end);
    if (backwards !== -1) { problems.push(at + ".source_refs[" + backwards + "]: start is after end"); continue; }
    if (!blockOf(item, format)) { problems.push(at + ".source_refs: not inside one acceptance block"); continue; }
    for (const ref of item.source_refs) for (const line of range(ref)) covered.add(line);
    if (!flat(linesOf(lines, item.source_refs).join(" ")).includes(flat(item.quote))) problems.push(at + ".quote: not found verbatim in its source lines");
    for (const [verifyIndex, verify] of item.verify.entries()) {
      const where = at + ".verify[" + verifyIndex + "]";
      if (verify.kind === "test" && test?.kind !== "command") problems.push(where + ": Bridge runs no verification command for this work");
      if (verify.kind === "test" && verify.check !== null) problems.push(where + ".check: must be null for test");
      if (verify.kind === "reviewer" && !verify.check) problems.push(where + ".check: say what the reviewer checks");
    }
  }
  for (const block of format.acceptance) {
    for (const line of block.lines) if (!covered.has(line)) problems.push("line " + line + " belongs to no condition");
  }
  return problems;
}

// What stops the work before any model call: the questions the person wrote into the work order
// themselves, which are theirs to answer.
export function workOrderQuestions(format) {
  return format.open_questions.map((entry) => entry.question);
}

// Shape first, then the rules only code can check. `problems` refuse the translation (the model
// erred and may try again).
export async function checkTranslation(value, { lines, format, test }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, problems: ["$: not an object"] };
  const problems = validateAgainstSchema(value, await loadSchema(CONTRACT_TRANSLATION_SCHEMA));
  if (problems.length) return { ok: false, problems };
  problems.push(...acceptanceProblems(value.acceptance, { lines, format, test }));
  return { ok: problems.length === 0, problems };
}

// One block as a contract part: its content lines, as written.
function partOf(lines, numbers) {
  if (!numbers?.length) return null;
  const sourceRefs = rangesOf(numbers, lines);
  return { text: linesOf(lines, sourceRefs).join("\n"), source_refs: sourceRefs };
}

function frontmatterPart(format) {
  const { source_id: sourceId, lines: at } = format.frontmatter;
  return sourceId === null ? null : { text: sourceId, source_refs: [{ start: at.source_id, end: at.source_id }] };
}

// Every field from its block; the conditions from the translation, each belonging to the run whose
// list it was cut from (none for the work order's own acceptance block).
export function buildContract({ workPackage, lines, format, translation, translator, checker }) {
  const block = (key) => format.blocks.get(key)?.content;
  const part = (key) => partOf(lines, block(key));
  const listOf = (key) => (block(key)?.length ? [part(key)] : []);
  const reproductionKeys = ["environment", "steps", "actual", "expected", "frequency"];
  const reproduction = reproductionKeys.some((key) => block("reproduction." + key)?.length)
    ? Object.fromEntries(reproductionKeys.map((key) => [key, part("reproduction." + key)]))
    : null;
  return {
    schema: "review-bridge.contract",
    schema_version: CONTRACT_SCHEMA_VERSION,
    work_package_id: workPackage.work_package_id,
    source: { path: workPackage.task_file || null, sha256: digest(workPackage.task), lines },
    translated_by: translator,
    checked_by: checker,
    ticket: {
      title: { text: format.title.text, source_refs: format.title.line === null ? [] : [{ start: format.title.line, end: format.title.line }] },
      source_id: frontmatterPart(format),
      priority: format.frontmatter.priority,
      effort: format.frontmatter.effort,
      budget: format.frontmatter.budget,
    },
    context: part("context"),
    outcome: part("outcome"),
    requested_work: part("requested_work"),
    scope_notes: {
      include: part("scope_notes.include"),
      exclude: part("scope_notes.exclude"),
      must_keep: part("scope_notes.must_keep"),
      expected_locations: part("scope_notes.expected_locations"),
    },
    run_plan: format.runs ? {
      runs: format.runs.map((run) => {
        const sourceRefs = rangesOf(run.work, lines);
        return {
          name: run.name,
          text: linesOf(lines, sourceRefs).join("\n"),
          depends_on: run.depends_on,
          depends_on_quote: run.depends_on_line ? lines[run.depends_on_line - 1].trim() : null,
          source_refs: sourceRefs,
          effort: run.effort,
          budget: run.budget,
        };
      }),
    } : null,
    acceptance: translation.acceptance.map((item) => {
      const run = blockOf(item, format)?.run;
      return { ...item, run_refs: run ? [run] : [] };
    }),
    verification_hints: listOf("verification_hints"),
    reproduction,
    references: listOf("references"),
    open_questions: format.open_questions,
    clarifications: part("clarifications"),
    // What the reviewer's questions settled without asking; filled when the contract is sealed.
    assumptions: [],
    unused_lines: rangesOf(format.unused, lines).map((ref) => ({ text: linesOf(lines, [ref]).join("\n"), source_refs: [ref] })),
  };
}

export function composeCheckPrompt({ workPackageId, lines, format, candidate, sha256, attempt }) {
  const proposing = !format.acceptance.length;
  const width = String(lines.length).length;
  return [
    CHECK_MODE_HEADER,
    "",
    "Injected by the local Review Bridge controller. Work package: " + workPackageId + "  Attempt: " + attempt,
    "Candidate: " + sha256,
    "You are the independent reviewer. " + (proposing
      ? "The human work order below states no acceptance conditions yet, so there is nothing to judge. Read it and answer with one contract.check object matching the JSON schema given to the CLI."
      : "A writer cut the acceptance blocks of a human work order, given below, into the candidate conditions. Read both and answer with one contract.check object matching the JSON schema given to the CLI."),
    "You may read the project's files to see what it already uses. A clarifications block holds answers the person already gave: never ask again what it settles.",
    "",
    "Check:",
    ...(proposing ? [
      "- Propose how to tell the work is done: one item under ambiguities with acceptance_proposal true, blocks verification and source_refs on the lines asking for the work. Each of its readings is one whole set of conditions, one condition per line, in plain words the person can check; the most usual set first.",
    ] : [
      "- For every condition: does its statement say what its source lines mean, as the clarifications answer them, no more and no less, and does its verify fit (test only where the sealed test can show it)? Answer faithful true or false for each id, with a short note when false.",
      "- Is any result the acceptance blocks state missing from the conditions? List each under missing with its lines.",
    ]),
    "- Is anything open in the work order itself? List it under ambiguities, most important first (impact times uncertainty). A mistake in the conditions is not an ambiguity. Set blocks to:",
    "  - verification: the work order gives no basis and no convention answers it, and two readings would make one condition pass or fail.",
    "  - implementation: the ways of doing it clearly differ and the person would notice the difference.",
    "  - preference: the person would not care which. It is decided for them, not asked.",
    "- Convention first: when one reading is the ecosystem's convention (Keep a Changelog allows a title above Unreleased; npm install is not listed in scripts), put it first and set convention true. It is adopted without asking.",
    "- readings are the ready-made ways the ecosystem already has, not a brainstorm: at most " + MAX_READINGS + ", the most mainstream first, because the first is the recommendation. Each is a whole passage in the work order's language, in words a person who does not program can follow.",
    "- Every reading has a precedent: source project (this project already uses it; note where), lookup (you looked it up with a tool you hold; note the figures) or knowledge (from what you know; note why it is mainstream). If you can name none, set precedent to null.",
    "- source_refs say which lines of the work order an item is about.",
    "- If you cannot judge, set cannot_confirm true and say why. Do not guess a pass.",
    "- Echo the candidate hash in candidate_sha256. " + LANGUAGE_RULE,
    "- Do not change any file.",
    "",
    "=== WORK ORDER (line-numbered) ===",
    ...lines.map((line, index) => String(index + 1).padStart(width, " ") + "| " + line),
    "=== END WORK ORDER ===",
    "",
    "=== CANDIDATE CONDITIONS ===",
    JSON.stringify(candidate.acceptance, null, 2),
    "=== END CANDIDATE CONDITIONS ===",
  ].join("\n");
}

const overlaps = (refs, others) => refs.some((ref) => others.some((other) => ref.start <= other.end && other.start <= ref.end));

// One question as the person sees it. The first reading the reviewer gave is the recommendation, kept
// even when it cannot be shown, because handing the question to the AI writes it. A lookup needs a tool
// the reviewer holds; without one it is its own knowledge, however it was labelled.
function asQuestion(item, { lookupHeld }) {
  const readings = item.readings.map((reading, index) => ({
    text: reading.text,
    recommended: index === 0,
    precedent: reading.precedent?.source === "lookup" && !lookupHeld ? { ...reading.precedent, source: "knowledge" } : reading.precedent,
  }));
  const shown = readings.filter((reading) => reading.precedent).slice(0, MAX_READINGS);
  return {
    question: item.question, source_refs: item.source_refs, blocks: item.blocks, acceptance_proposal: item.acceptance_proposal,
    readings: shown, recommended: readings[0], no_precedent: shown.length === 0,
  };
}

const asAssumption = (question, decidedBy) => ({
  question: question.question, adopted: question.recommended.text, precedent: question.recommended.precedent, decided_by: decidedBy, source_refs: question.source_refs,
});

// Which of the reviewer's items reach the person and which are settled here (RC3-ASK-01 sections 1
// and 3). Code decides, from the plan's clarify record; the model is never told the round. A person who
// handed the work order to the AI is not asked again. After the first round only what the person said in
// their own words may come back, recognised by the lines it is about: each round is a new session with no
// ids, and the work order only grows at its end, so the lines stay where they are. A proposal of
// acceptance has nothing to fall back on, so it is always asked.
export function sortQuestions(items, { clarify = null, maxQuestions, lookupHeld = false }) {
  const askable = [];
  const assumptions = [];
  for (const item of items) {
    const question = asQuestion(item, { lookupHeld });
    if (item.acceptance_proposal) { askable.push(question); continue; }
    if (clarify?.ai_decides) { assumptions.push(asAssumption(question, "ai")); continue; }
    if (item.convention && question.recommended.precedent) { assumptions.push(asAssumption(question, "convention")); continue; }
    if (item.blocks === "preference" || (clarify && !overlaps(item.source_refs, clarify.open_refs))) { assumptions.push(asAssumption(question, "suggested")); continue; }
    askable.push(question);
  }
  for (const question of askable.slice(maxQuestions)) assumptions.push(asAssumption(question, "suggested"));
  return { questions: askable.slice(0, maxQuestions), assumptions };
}

function itemProblems(items, { lineCount, proposing }) {
  const problems = [];
  for (const [index, item] of items.entries()) {
    const at = "$.ambiguities[" + index + "]";
    if (item.source_refs.some((ref) => ref.start > ref.end || ref.end > lineCount)) problems.push(at + ".source_refs: not lines of the work order");
    if (item.acceptance_proposal && !proposing) problems.push(at + ".acceptance_proposal: this work order states its acceptance");
  }
  if (proposing && items.filter((item) => item.acceptance_proposal).length !== 1) problems.push("$.ambiguities: a work order with no acceptance needs exactly one acceptance proposal");
  return problems;
}

// Bridge decides from the reviewer's typed items, never from a summary verdict: every condition must be
// judged, a question goes to the human or is settled by sortQuestions, a mistake goes back to the writer,
// anything the reviewer cannot confirm stops the run, and an answer in the wrong shape is asked for again.
export async function decideCheck(value, { candidate, sha256, lineCount = Infinity, proposing = false, clarify = null, maxQuestions = 3, lookupHeld = false }) {
  const none = { problems: [], feedback: [], questions: [], assumptions: [] };
  const problems = value && typeof value === "object" && !Array.isArray(value)
    ? validateAgainstSchema(value, await loadSchema(CONTRACT_CHECK_SCHEMA))
    : ["$: not an object"];
  if (problems.length) return { ...none, decision: "malformed", problems };
  if (value.candidate_sha256 !== sha256) problems.push("$.candidate_sha256: expected " + sha256);
  const expected = candidate.acceptance.map((item) => item.id);
  const judged = value.acceptance.map((item) => item.id);
  if (judged.length !== new Set(judged).size || judged.length !== expected.length || expected.some((id) => !judged.includes(id))) {
    problems.push("$.acceptance: must judge exactly " + (expected.join(", ") || "no conditions"));
  }
  problems.push(...itemProblems(value.ambiguities, { lineCount, proposing }));
  if (problems.length) return { ...none, decision: "malformed", problems };
  const { questions, assumptions } = sortQuestions(value.ambiguities, { clarify, maxQuestions, lookupHeld });
  if (questions.length) return { ...none, decision: "needs_human", questions, assumptions };
  if (value.cannot_confirm) return { ...none, decision: "unconfirmed", problems: [value.cannot_confirm_reason || "the reviewer could not confirm the translation"] };
  const feedback = [
    ...value.acceptance.filter((item) => !item.faithful).map((item) => item.id + " does not match its lines" + (item.note ? ": " + item.note : "")),
    ...value.missing.map((entry) => "missing condition at lines " + entry.source_refs.map((ref) => ref.start + "-" + ref.end).join(", ") + ": " + entry.note),
  ];
  if (feedback.length) return { ...none, decision: "retranslate", feedback };
  return { ...none, decision: "pass", assumptions };
}

export function contractPath(paths, sha256) {
  if (!/^[0-9a-f]{64}$/.test(String(sha256 || ""))) throw new Error("Contract hash is invalid.");
  return path.join(paths.contractsDir, sha256 + ".json");
}

async function schemaProblems(contract) {
  return validateAgainstSchema(contract, await loadSchema(CONTRACT_SCHEMA));
}

// Written once under its own hash, after the formal schema accepts it; an existing file must
// already hold the same contract.
export async function sealContract(paths, contract) {
  const problems = await schemaProblems(contract);
  if (problems.length) throw new Error("Contract does not match its schema: " + problems.slice(0, 5).join("; "));
  const sha256 = digest(contract);
  const file = contractPath(paths, sha256);
  await ensureDir(paths.contractsDir);
  try {
    await fsp.writeFile(file, JSON.stringify(contract, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    await loadContract(paths, sha256);
  }
  return { sha256, contract };
}

// Every read goes through here: the file must still hash to the name the run recorded and
// still match the formal schema. A contract an older Bridge sealed (a lower schema version) belongs to
// an old run and is not read again.
export async function loadContract(paths, sha256) {
  const text = await fsp.readFile(contractPath(paths, sha256), "utf8").catch(() => null);
  if (text === null) throw new ContractChangedError(sha256, "is missing");
  let contract;
  try { contract = JSON.parse(text); } catch { throw new ContractChangedError(sha256, "is not valid JSON"); }
  if (digest(contract) !== sha256) throw new ContractChangedError(sha256, "was changed after it was sealed");
  if (contract?.schema_version < CONTRACT_SCHEMA_VERSION) throw new ContractChangedError(sha256, "was made by an older Bridge and is not read again; run: review-bridge clean");
  if ((await schemaProblems(contract)).length) throw new ContractChangedError(sha256, "does not match the contract schema");
  return contract;
}
