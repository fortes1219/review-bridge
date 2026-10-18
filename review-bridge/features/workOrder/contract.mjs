// The work-order contract (RC3-BLOCKER-00, first part). Starting work authorizes the work-order
// text sealed in the plan. The writer's provider translates that text into a schema-bound
// object; this module checks what code can check, the reviewer's provider reads the result
// against the full text, and only then is the contract sealed once under its hash. Models only
// read it afterwards. Scope, budget, roles and the verification command stay in the work
// package, which the controller compiled before any model saw the work order.
//
// What code proves here: every part points at lines that exist, each condition quotes its lines
// verbatim, every non-blank line is either used or listed as unused, a run plan has at least two
// runs on separate lines, each dependency quotes the run's own line naming it and none loops, and
// with a plan every condition belongs to a run. Whether each part, empty ones included, and each
// condition say what the work order means is the reviewer's judgement; it lowers the risk of
// drift, it is not a proof.
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { digest } from "../../utils/digest.mjs";
import { ensureDir } from "../../service/index.mjs";
import { loadSchema, validateAgainstSchema } from "./typedResults.mjs";

const schemasDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "schemas");

export const CONTRACT_TRANSLATION_SCHEMA = path.join(schemasDir, "contract.translation.schema.json");
export const CONTRACT_SCHEMA = path.join(schemasDir, "contract.schema.json");
export const CONTRACT_CHECK_SCHEMA = path.join(schemasDir, "contract.check.schema.json");
export const CONTRACT_MODE_HEADER = "[REVIEW_BRIDGE_MODE: CONTRACT_TRANSLATION]";
export const CHECK_MODE_HEADER = "[REVIEW_BRIDGE_MODE: CONTRACT_CHECK]";
export const CONTRACT_SCHEMA_VERSION = 1;
// A translation the reviewer finds wrong is redone at most this many times in all.
export const MAX_TRANSLATION_ATTEMPTS = 2;
// Every part of the contract the reviewer judges, empty ones included: an empty part is a claim
// that the work order says nothing there. Conditions are judged by id. The check schema's enum
// is generated from the same list.
export const CHECKED_FIELDS = Object.freeze([
  "ticket", "context", "outcome", "requested_work", "scope_notes.include", "scope_notes.exclude", "scope_notes.must_keep",
  "scope_notes.expected_locations", "run_plan", "verification_hints", "reproduction", "references", "unused_lines",
]);
// The translation reads one text and writes one object; it needs no tools and few turns.
export const TRANSLATION_MAX_TURNS = 3;

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

function numbered(lines) {
  const width = String(lines.length).length;
  return lines.map((line, index) => String(index + 1).padStart(width, " ") + "| " + line);
}

const flat = (text) => String(text).replace(/\s+/g, " ").trim();
const linesOf = (lines, refs) => refs.flatMap((ref) => lines.slice(ref.start - 1, ref.end));

export function composeTranslationPrompt({ workPackageId, lines, gateA, locale, attempt = 1, feedback = [] }) {
  const gateLine = gateA?.kind === "command"
    ? "Bridge will run this verification after the work: " + gateA.command + ". A condition it can show may use {\"kind\": \"gate_a\", \"check\": null}."
    : "Bridge runs no verification command for this work; every condition uses {\"kind\": \"reviewer\", \"check\": \"<what the reviewer checks>\"}.";
  return [
    CONTRACT_MODE_HEADER,
    "",
    "Injected by the local Review Bridge controller. Work package: " + workPackageId + "  Attempt: " + attempt,
    "Turn the human work order below into one contract.translation object that matches the JSON schema given to the CLI.",
    "",
    "Rules:",
    "- Record only what the work order says. A part the work order does not fill stays null or empty; never invent one.",
    "- Parts of the work order are given as source_refs only (inclusive line ranges); Bridge copies the text itself.",
    "- acceptance: each item is one complete, checkable condition, numbered AC1, AC2, ... in order. quote is a verbatim excerpt of its source_refs lines. One line may give several conditions and one condition may span several lines; line numbers locate, they are not condition numbers.",
    "- Every non-blank line is either referenced somewhere or listed in unused_lines (headings, instructions, comments, template hints). A line is never both.",
    "- run_plan stays null unless the work order explicitly lays the work out as two or more runs; then each run's name appears in its own lines, which no other run shares. A dependency is recorded only when the run's own lines state it: depends_on_quote is that line, verbatim, and it names every run in depends_on; with no stated dependency, depends_on is empty. Sub-agents are not runs, and the number of conditions is not the number of runs.",
    "- run_refs names the runs a condition belongs to: at least one when run_plan exists, none when it is null.",
    "- Paths, test hints and references in the work order are context, not permission. You do not choose files, commands, budgets or roles; Bridge already did.",
    "- " + gateLine,
    "- If something that affects the work is genuinely ambiguous or missing in the work order, add it to open_questions instead of guessing. Bridge stops and the human edits the work order.",
    "- Write every statement and question in the language with the BCP 47 tag \"" + locale + "\"; quotes stay in the work order's own words.",
    "- Do not read or change any file; everything you need is below.",
    ...(feedback.length ? ["", "Your previous translation was refused for these reasons; fix them and translate again:", ...feedback.map((line) => "- " + line)] : []),
    "",
    "=== WORK ORDER (line-numbered) ===",
    ...numbered(lines),
    "=== END WORK ORDER ===",
  ].join("\n");
}

function refProblems(refs, lineCount, at) {
  return (refs || []).flatMap((ref, index) => {
    if (ref.start > ref.end) return [at + "[" + index + "]: start is after end"];
    if (ref.end > lineCount) return [at + "[" + index + "]: line " + ref.end + " is past the last line " + lineCount];
    return [];
  });
}

// Every source_refs array in the object except unused_lines, with its location for messages.
function everyRefList(value, at = "$", found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => everyRefList(item, at + "[" + index + "]", found));
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value)) {
    if (key === "source_refs") found.push({ refs: child, at: at + ".source_refs" });
    else if (key !== "unused_lines") everyRefList(child, at + "." + key, found);
  }
  return found;
}

function coverageProblems(lines, refLists, unused) {
  const used = new Set(refLists.flatMap(({ refs }) => refs.flatMap((ref) => range(ref))));
  const spare = new Set(unused.flatMap((ref) => range(ref)));
  const problems = [];
  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    if (used.has(number) && spare.has(number)) problems.push("line " + number + " is both used and listed in unused_lines");
    else if (line.trim() && !used.has(number) && !spare.has(number)) problems.push("line " + number + " is neither used nor listed in unused_lines");
  }
  return problems;
}

function range(ref) {
  return Array.from({ length: Math.max(0, ref.end - ref.start + 1) }, (_, offset) => ref.start + offset);
}

function cycleProblems(runs) {
  const byName = new Map(runs.map((run) => [run.name, run]));
  const done = new Set();
  const visit = (name, trail) => {
    if (trail.includes(name)) return [trail.slice(trail.indexOf(name)).concat(name).join(" -> ")];
    if (done.has(name) || !byName.has(name)) return [];
    const found = byName.get(name).depends_on.flatMap((next) => visit(next, [...trail, name]));
    done.add(name);
    return found;
  };
  return [...new Set(runs.flatMap((run) => visit(run.name, [])))].map((cycle) => "$.run_plan: dependency cycle " + cycle);
}

// A dependency must be stated in the run's own lines: its quote is verbatim there and names
// every run it depends on. A run with no stated dependency may still quote "none".
function dependencyProblems(run, at, lines, names) {
  const problems = run.depends_on.filter((dependency) => !names.has(dependency)).map((dependency) => at + ".depends_on: unknown run " + dependency);
  if (run.depends_on_quote === null) return run.depends_on.length ? [...problems, at + ".depends_on_quote: a dependency needs the line that states it"] : problems;
  if (!flat(linesOf(lines, run.source_refs).join(" ")).includes(flat(run.depends_on_quote))) return [...problems, at + ".depends_on_quote: not found verbatim in the run's own lines"];
  const unnamed = run.depends_on.filter((dependency) => !flat(run.depends_on_quote).includes(flat(dependency)));
  return [...problems, ...unnamed.map((dependency) => at + ".depends_on_quote: does not name " + dependency)];
}

function runPlanProblems(runPlan, lines) {
  if (!runPlan) return [];
  const problems = [];
  const names = new Set(runPlan.runs.map((run) => run.name));
  const seen = new Set();
  const owner = new Map();
  for (const [index, run] of runPlan.runs.entries()) {
    const at = "$.run_plan.runs[" + index + "]";
    if (seen.has(run.name)) problems.push(at + ".name: duplicate " + run.name);
    seen.add(run.name);
    if (!flat(linesOf(lines, run.source_refs).join(" ")).includes(flat(run.name))) problems.push(at + ".name: \"" + run.name + "\" does not appear in its lines");
    for (const line of run.source_refs.flatMap((ref) => range(ref))) {
      if (owner.has(line) && owner.get(line) !== run.name) problems.push(at + ".source_refs: line " + line + " also belongs to " + owner.get(line));
      owner.set(line, run.name);
    }
    problems.push(...dependencyProblems(run, at, lines, names));
  }
  return [...problems, ...cycleProblems(runPlan.runs)];
}

function acceptanceProblems(acceptance, { lines, gateA, runNames }) {
  const problems = [];
  const ids = new Set();
  for (const [index, item] of acceptance.entries()) {
    const at = "$.acceptance[" + index + "]";
    if (ids.has(item.id)) problems.push(at + ".id: duplicate " + item.id);
    ids.add(item.id);
    if (item.id !== "AC" + (index + 1)) problems.push(at + ".id: expected AC" + (index + 1));
    if (!flat(linesOf(lines, item.source_refs).join(" ")).includes(flat(item.quote))) problems.push(at + ".quote: not found verbatim in its source lines");
    for (const [verifyIndex, verify] of item.verify.entries()) {
      const where = at + ".verify[" + verifyIndex + "]";
      if (verify.kind === "gate_a" && gateA?.kind !== "command") problems.push(where + ": Bridge runs no verification command for this work");
      if (verify.kind === "gate_a" && verify.check !== null) problems.push(where + ".check: must be null for gate_a");
      if (verify.kind === "reviewer" && !verify.check) problems.push(where + ".check: say what the reviewer checks");
    }
    if (!runNames && item.run_refs.length) problems.push(at + ".run_refs: there is no run_plan");
    if (runNames && !item.run_refs.length) problems.push(at + ".run_refs: name the runs this condition belongs to");
    for (const name of item.run_refs) if (runNames && !runNames.has(name)) problems.push(at + ".run_refs: unknown run " + name);
  }
  return problems;
}

// Shape first, then the rules only code can check. `problems` refuse the translation (the model
// erred and may try again); `questions` mean the work order itself needs the human.
export async function checkTranslation(value, { lines, gateA }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, problems: ["$: not an object"], questions: [] };
  const problems = validateAgainstSchema(value, await loadSchema(CONTRACT_TRANSLATION_SCHEMA));
  if (problems.length) return { ok: false, problems, questions: [] };
  const refLists = everyRefList(value);
  for (const { refs, at } of refLists) problems.push(...refProblems(refs, lines.length, at));
  problems.push(...refProblems(value.unused_lines, lines.length, "$.unused_lines"));
  if (problems.length) return { ok: false, problems, questions: [] };
  problems.push(...coverageProblems(lines, refLists, value.unused_lines));
  problems.push(...runPlanProblems(value.run_plan, lines));
  const runNames = value.run_plan ? new Set(value.run_plan.runs.map((run) => run.name)) : null;
  problems.push(...acceptanceProblems(value.acceptance, { lines, gateA, runNames }));
  const questions = value.open_questions.map((entry) => entry.question);
  if (!value.acceptance.length && !questions.length) questions.push("The work order states no result that can be checked.");
  return { ok: problems.length === 0, problems, questions };
}

// Bridge copies the referenced lines into every part; the model wrote only conditions and questions.
function copyText(value, lines) {
  if (Array.isArray(value)) return value.map((item) => copyText(item, lines));
  if (!value || typeof value !== "object") return value;
  const copied = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key === "source_refs" ? child : copyText(child, lines)]));
  const isPart = Object.keys(value).length === 1 && Array.isArray(value.source_refs);
  return isPart ? { text: linesOf(lines, value.source_refs).join("\n"), source_refs: value.source_refs } : copied;
}

export function buildContract({ workPackage, lines, translation, translator, checker }) {
  const { event: _event, unused_lines: unused, run_plan: runPlan, ...parts } = translation;
  return {
    schema: "review-bridge.contract",
    schema_version: CONTRACT_SCHEMA_VERSION,
    work_package_id: workPackage.work_package_id,
    source: { path: workPackage.task_file || null, sha256: digest(workPackage.task), lines },
    translated_by: translator,
    checked_by: checker,
    ...copyText(parts, lines),
    run_plan: runPlan ? { runs: runPlan.runs.map((run) => ({ ...run, text: linesOf(lines, run.source_refs).join("\n") })) } : null,
    unused_lines: unused.map((ref) => ({ text: linesOf(lines, [ref]).join("\n"), source_refs: [ref] })),
  };
}

export function composeCheckPrompt({ workPackageId, lines, candidate, sha256, locale, attempt }) {
  return [
    CHECK_MODE_HEADER,
    "",
    "Injected by the local Review Bridge controller. Work package: " + workPackageId + "  Attempt: " + attempt,
    "Candidate: " + sha256,
    "You are the independent reviewer. A writer translated the human work order below into the candidate contract. Read both and answer with one contract.check object matching the JSON schema given to the CLI.",
    "",
    "Check:",
    "- Judge every part in fields, empty ones too, exactly once: " + CHECKED_FIELDS.join(", ") + ". A part is faithful only if it holds what the work order puts there and nothing else: an exclusion copied as an inclusion, a constraint left out, a hint treated as a requirement, or an empty part the work order does fill is not faithful.",
    "- run_plan: is the work really laid out as several runs in the work order, and does each dependency match what the work order states, no added and no dropped ones?",
    "- For every condition in acceptance: does its statement say what its source lines mean, no more and no less; does its verify fit (gate_a only where the sealed test can show it); do its run_refs match the runs the work order gives it? Answer faithful true or false for each id, with a short note when false.",
    "- Is any requirement the work order states clearly missing from the conditions? Look especially at unused_lines and at parts copied as context. List each under missing with its lines.",
    "- Is anything genuinely ambiguous in the work order itself, so that only the human can decide? List it under ambiguities. A translation mistake is not an ambiguity.",
    "- If you cannot judge, set cannot_confirm true and say why. Do not guess a pass.",
    "- Echo the candidate hash in candidate_sha256. Write notes and questions in the language with the BCP 47 tag \"" + locale + "\".",
    "- Do not change any file.",
    "",
    "=== WORK ORDER (line-numbered) ===",
    ...numbered(lines),
    "=== END WORK ORDER ===",
    "",
    "=== CANDIDATE CONTRACT ===",
    JSON.stringify(candidate, null, 2),
    "=== END CANDIDATE CONTRACT ===",
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
  const fields = value.fields.map((item) => item.field);
  if (fields.length !== new Set(fields).size || fields.length !== CHECKED_FIELDS.length || CHECKED_FIELDS.some((field) => !fields.includes(field))) {
    problems.push("$.fields: must judge exactly " + CHECKED_FIELDS.join(", "));
  }
  const expected = candidate.acceptance.map((item) => item.id);
  const judged = value.acceptance.map((item) => item.id);
  if (judged.length !== new Set(judged).size || judged.length !== expected.length || expected.some((id) => !judged.includes(id))) {
    problems.push("$.acceptance: must judge exactly " + (expected.join(", ") || "no conditions"));
  }
  if (problems.length) return { decision: "unconfirmed", problems, feedback: [], questions: [] };
  if (value.ambiguities.length) return { decision: "needs_human", problems: [], feedback: [], questions: value.ambiguities.map((entry) => entry.question) };
  if (value.cannot_confirm) return { decision: "unconfirmed", problems: [value.cannot_confirm_reason || "the reviewer could not confirm the translation"], feedback: [], questions: [] };
  const feedback = [
    ...value.fields.filter((item) => !item.faithful).map((item) => item.field + " does not match the work order" + (item.note ? ": " + item.note : "")),
    ...value.acceptance.filter((item) => !item.faithful).map((item) => item.id + " does not match its lines" + (item.note ? ": " + item.note : "")),
    ...value.missing.map((entry) => "missing requirement at lines " + entry.source_refs.map((ref) => ref.start + "-" + ref.end).join(", ") + ": " + entry.note),
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
// still match the formal schema.
export async function loadContract(paths, sha256) {
  const text = await fsp.readFile(contractPath(paths, sha256), "utf8").catch(() => null);
  if (text === null) throw new ContractChangedError(sha256, "is missing");
  let contract;
  try { contract = JSON.parse(text); } catch { throw new ContractChangedError(sha256, "is not valid JSON"); }
  if (digest(contract) !== sha256) throw new ContractChangedError(sha256, "was changed after it was sealed");
  if ((await schemaProblems(contract)).length) throw new ContractChangedError(sha256, "does not match the contract schema");
  return contract;
}
