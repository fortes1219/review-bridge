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
export const CONTRACT_SCHEMA_VERSION = 2;
// A translation the reviewer finds wrong is redone at most this many times in all.
export const MAX_TRANSLATION_ATTEMPTS = 2;
// The translation reads one text and writes one object; it needs no tools and few turns.
export const TRANSLATION_MAX_TURNS = 3;
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
    ...(feedback.length ? ["", "Your previous translation was refused for these reasons; fix them and translate again:", ...feedback.map((line) => "- " + line)] : []),
    "",
    "=== ACCEPTANCE BLOCKS (line-numbered) ===",
    ...acceptanceBlocks(lines, format),
    "=== END ACCEPTANCE BLOCKS ===",
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

// What stops the work before any model call: the work order states no result to check, or it
// lists open questions. Both are the human's to answer.
export function workOrderQuestions(format) {
  const questions = format.open_questions.map((entry) => entry.question);
  if (!format.acceptance.length) questions.push("The work order states no result that can be checked.");
  return questions;
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
      title: { text: format.title.text, source_refs: [{ start: format.title.line, end: format.title.line }] },
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
    unused_lines: rangesOf(format.unused, lines).map((ref) => ({ text: linesOf(lines, [ref]).join("\n"), source_refs: [ref] })),
  };
}

export function composeCheckPrompt({ workPackageId, lines, format, candidate, sha256, attempt }) {
  return [
    CHECK_MODE_HEADER,
    "",
    "Injected by the local Review Bridge controller. Work package: " + workPackageId + "  Attempt: " + attempt,
    "Candidate: " + sha256,
    "You are the independent reviewer. A writer cut the acceptance blocks of a human work order, given below, into the candidate conditions. Read both and answer with one contract.check object matching the JSON schema given to the CLI.",
    "",
    "Check:",
    "- For every condition: does its statement say what its source lines mean, no more and no less, and does its verify fit (test only where the sealed test can show it)? Answer faithful true or false for each id, with a short note when false.",
    "- Is any result the blocks state missing from the conditions? List each under missing with its lines.",
    "- Is anything genuinely ambiguous in the work order itself, so that only the human can decide? List it under ambiguities. A mistake in the conditions is not an ambiguity.",
    "- If you cannot judge, set cannot_confirm true and say why. Do not guess a pass.",
    "- Echo the candidate hash in candidate_sha256. " + LANGUAGE_RULE,
    "- Do not change any file.",
    "",
    "=== ACCEPTANCE BLOCKS (line-numbered) ===",
    ...acceptanceBlocks(lines, format),
    "=== END ACCEPTANCE BLOCKS ===",
    "",
    "=== CANDIDATE CONDITIONS ===",
    JSON.stringify(candidate.acceptance, null, 2),
    "=== END CANDIDATE CONDITIONS ===",
  ].join("\n");
}

// Bridge decides from the reviewer's typed items, never from a summary verdict: every condition
// must be judged, an ambiguity goes to the human, a mistake goes back to the writer, and
// anything the reviewer cannot confirm stops the run.
export async function decideCheck(value, { candidate, sha256 }) {
  const problems = value && typeof value === "object" && !Array.isArray(value)
    ? validateAgainstSchema(value, await loadSchema(CONTRACT_CHECK_SCHEMA))
    : ["$: not an object"];
  if (problems.length) return { decision: "unconfirmed", problems, feedback: [], questions: [] };
  if (value.candidate_sha256 !== sha256) problems.push("$.candidate_sha256: expected " + sha256);
  const expected = candidate.acceptance.map((item) => item.id);
  const judged = value.acceptance.map((item) => item.id);
  if (judged.length !== new Set(judged).size || judged.length !== expected.length || expected.some((id) => !judged.includes(id))) {
    problems.push("$.acceptance: must judge exactly " + (expected.join(", ") || "no conditions"));
  }
  if (problems.length) return { decision: "unconfirmed", problems, feedback: [], questions: [] };
  if (value.ambiguities.length) return { decision: "needs_human", problems: [], feedback: [], questions: value.ambiguities.map((entry) => entry.question) };
  if (value.cannot_confirm) return { decision: "unconfirmed", problems: [value.cannot_confirm_reason || "the reviewer could not confirm the translation"], feedback: [], questions: [] };
  const feedback = [
    ...value.acceptance.filter((item) => !item.faithful).map((item) => item.id + " does not match its lines" + (item.note ? ": " + item.note : "")),
    ...value.missing.map((entry) => "missing condition at lines " + entry.source_refs.map((ref) => ref.start + "-" + ref.end).join(", ") + ": " + entry.note),
  ];
  if (feedback.length) return { decision: "retranslate", problems: [], feedback, questions: [] };
  return { decision: "pass", problems: [], feedback: [], questions: [] };
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
// still match the formal schema. A contract an older Bridge sealed (schema version 1) belongs to
// an old run and is not read again.
export async function loadContract(paths, sha256) {
  const text = await fsp.readFile(contractPath(paths, sha256), "utf8").catch(() => null);
  if (text === null) throw new ContractChangedError(sha256, "is missing");
  let contract;
  try { contract = JSON.parse(text); } catch { throw new ContractChangedError(sha256, "is not valid JSON"); }
  if (digest(contract) !== sha256) throw new ContractChangedError(sha256, "was changed after it was sealed");
  if (contract?.schema_version === 1) throw new ContractChangedError(sha256, "was made by an older Bridge and is not read again; run: review-bridge clean");
  if ((await schemaProblems(contract)).length) throw new ContractChangedError(sha256, "does not match the contract schema");
  return contract;
}
