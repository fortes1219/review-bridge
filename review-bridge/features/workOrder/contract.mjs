// The work-order contract (RC3-BLOCKER-00, first part). Starting work authorizes the work-order
// text sealed in the plan. The work order is a form written in marked blocks (workOrderFormat.mjs):
// Bridge fills every field from its own block, copying the text as written, and cuts the acceptance
// list into conditions the way Markdown cuts a list (Owner 2026-11-08). No model takes part, so the
// contract costs no tokens; it is sealed once under its hash when the plan is made, and models only
// read it afterwards. Scope, budget, roles and the verification command stay in the work package,
// which the controller compiled before any model saw the work order.
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { digest } from "../../utils/digest.mjs";
import { ensureDir } from "../../service/index.mjs";
import { loadSchema, validateAgainstSchema } from "./typedResults.mjs";
import { conditionsOf, rangesOf } from "./workOrderFormat.mjs";
import { bridgeRunner } from "../../utils/bridgeCommand.mjs";

const schemasDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "schemas");

export const CONTRACT_SCHEMA = path.join(schemasDir, "contract.schema.json");
export const CONTRACT_SCHEMA_VERSION = 4;

export class ContractChangedError extends Error {
  constructor(sha256, reason) {
    super("The sealed contract " + sha256 + " " + reason + ".");
    this.name = "ContractChangedError";
    this.sha256 = sha256;
  }
}

const linesOf = (lines, refs) => refs.flatMap((ref) => lines.slice(ref.start - 1, ref.end));

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

// Every field from its block; the conditions cut from the acceptance lists, each belonging to the run
// whose list it was cut from (none for the work order's own acceptance block).
export function buildContract({ workPackage, format }) {
  const { lines } = format;
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
    acceptance: conditionsOf(format).conditions.map((condition, index) => ({
      id: "AC" + (index + 1),
      statement: condition.statement,
      source_refs: condition.source_refs,
      run_refs: condition.run ? [condition.run] : [],
    })),
    verification_hints: listOf("verification_hints"),
    reproduction,
    references: listOf("references"),
    unused_lines: rangesOf(format.unused, lines).map((ref) => ({ text: linesOf(lines, [ref]).join("\n"), source_refs: [ref] })),
  };
}

// The second lock (Owner 2026-11-08): a contract that does not say what to do and when it is done is not
// worked on, whatever made it. Empty when it does.
export function missingFields(contract) {
  return [
    ...(contract?.requested_work || contract?.run_plan?.runs?.length ? [] : ["requested_work"]),
    ...(contract?.acceptance?.length ? [] : ["acceptance"]),
  ];
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
  if (contract?.schema_version < CONTRACT_SCHEMA_VERSION) throw new ContractChangedError(sha256, "was made by an older Bridge and is not read again; run: " + bridgeRunner() + " clean");
  if ((await schemaProblems(contract)).length) throw new ContractChangedError(sha256, "does not match the contract schema");
  return contract;
}
