// Typed model outputs (T0-05). The CLIs are asked for a schema-shaped answer; this
// module checks the shape again and applies the fixed rules the harness decides by.
// Nothing here reads prose.
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { nfc } from "../../utils/workOrderName.mjs";
import { criteriaProblems, verdictProblems } from "./acceptance.mjs";

export { CODEX_USAGE_FIELDS, parseCodexJsonl, pathFromCommand, reviewerUsageEvent } from "../../service/agentCli/codex.mjs";

const schemasDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "schemas");

export const WRITER_RESULT_SCHEMA = path.join(schemasDir, "writer.result.schema.json");
export const REVIEW_RESULT_SCHEMA = path.join(schemasDir, "review.result.schema.json");
export const MALFORMED_EXIT_CODE = 79;
export const SEVERITY_RANK = Object.freeze({ HIGH: 3, MEDIUM: 2, LOW: 1 });

const schemaCache = new Map();
export async function loadSchema(file) {
  if (!schemaCache.has(file)) schemaCache.set(file, JSON.parse(await fsp.readFile(file, "utf8")));
  return schemaCache.get(file);
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function typeMatches(value, expected) {
  const actual = typeOf(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  return actual === expected;
}

// A small draft-07 subset: enough for the result and contract schemas, no external dependency.
// Walked with a stack, children pushed last first. An object's unexpected keys are a separate
// entry pushed below its properties, so they are reported after them, in depth-first order.
export function validateAgainstSchema(value, schema, at = "$", errors = []) {
  const stack = [{ value, schema, at }];
  while (stack.length) {
    const { value: item, schema: rule, at: where, unexpected } = stack.pop();
    if (unexpected) {
      for (const key of Object.keys(item)) if (!(key in (rule.properties || {}))) errors.push(where + ": unexpected " + key);
      continue;
    }
    if (rule.const !== undefined && item !== rule.const) errors.push(where + ": must be " + JSON.stringify(rule.const));
    if (rule.enum && !rule.enum.some((option) => option === item)) errors.push(where + ": must be one of " + JSON.stringify(rule.enum));
    if (rule.type) {
      const types = Array.isArray(rule.type) ? rule.type : [rule.type];
      if (!types.some((type) => typeMatches(item, type))) {
        errors.push(where + ": must be " + types.join("|") + ", got " + typeOf(item));
        continue;
      }
    }
    if (typeof item === "string") {
      if (rule.minLength !== undefined && item.length < rule.minLength) errors.push(where + ": shorter than " + rule.minLength);
      if (rule.maxLength !== undefined && item.length > rule.maxLength) errors.push(where + ": longer than " + rule.maxLength);
      if (rule.pattern && !new RegExp(rule.pattern).test(item)) errors.push(where + ": does not match " + rule.pattern);
    }
    if (typeof item === "number" && rule.minimum !== undefined && item < rule.minimum) errors.push(where + ": below " + rule.minimum);
    if (Array.isArray(item) && rule.minItems !== undefined && item.length < rule.minItems) errors.push(where + ": fewer than " + rule.minItems + " items");
    if (Array.isArray(item) && rule.items) {
      for (let index = item.length - 1; index >= 0; index -= 1) stack.push({ value: item[index], schema: rule.items, at: where + "[" + index + "]" });
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      for (const key of rule.required || []) if (!(key in item)) errors.push(where + ": missing " + key);
      if (rule.additionalProperties === false) stack.push({ value: item, schema: rule, at: where, unexpected: true });
      const present = Object.entries(rule.properties || {}).filter(([key]) => key in item);
      for (const [key, child] of present.reverse()) stack.push({ value: item[key], schema: child, at: where + "." + key });
    }
  }
  return errors;
}

// D1.1 / D1.5: the CLI puts the schema-shaped answer in `structured_output` (verified
// against Claude Code 2.1.280 on 2026-10-13); anything else is malformed_writer_result.
export function writerResultFromClaudeResult(result) {
  if (result && typeof result.structured_output === "object" && result.structured_output !== null && !Array.isArray(result.structured_output)) {
    return result.structured_output;
  }
  return null;
}

// A model's answer names the contract it worked from; any other hash is not this run's work.
function contractEchoErrors(value, expected) {
  if ((value.contract_sha256 ?? null) === (expected || null)) return [];
  return ["$.contract_sha256: expected " + (expected || "null")];
}

// `contract` is the sealed contract object (null for an inline task); its conditions are the ids
// the answer must cover.
export async function validateWriterResult(value, { workOrder, call, contractSha256 = null, contract = null }) {
  const errors = value && typeof value === "object" && !Array.isArray(value)
    ? validateAgainstSchema(value, await loadSchema(WRITER_RESULT_SCHEMA))
    : ["$: not an object"];
  if (!errors.length) {
    if (nfc(value.work_order) !== nfc(workOrder)) errors.push("$.work_order: expected " + workOrder);
    if (value.call !== call) errors.push("$.call: expected " + call);
    errors.push(...contractEchoErrors(value, contractSha256));
    errors.push(...criteriaProblems(value, contract));
  }
  return { ok: errors.length === 0, errors };
}

function normalizePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
}

// D1.3: the writer's claim set against the controller's delta; both directions recorded.
export function writerClaimMismatch(writerResult, changedFiles) {
  const claimed = new Set((writerResult?.changed || []).map((entry) => normalizePath(entry.path)));
  const delta = new Set((changedFiles || []).map((entry) => normalizePath(entry.path)));
  return {
    claimed_not_in_delta: [...claimed].filter((entry) => !delta.has(entry)).sort(),
    delta_not_claimed: [...delta].filter((entry) => !claimed.has(entry)).sort(),
  };
}

export function unknownAddressedFindings(writerResult, openFindings) {
  const known = new Set((openFindings || []).map((finding) => finding.id));
  return (writerResult?.addressed_findings || []).filter((id) => !known.has(id));
}

// A finding must name a file inside the workspace: relative, no `..`, no drive or root,
// and an existing regular file (Codex finding 2026-10-13: `..` used to pass the stat).
// The path arrives with `/` already (validateReviewResult turns `\` into `/` first).
export async function workspaceFileProblem(repoRoot, relative) {
  const raw = String(relative || "");
  // Checked on the raw string, before normalization strips a leading `./`.
  if (/(^|\/)\.(\/|$)/.test(raw)) return "path escapes or is not normalized";
  const candidate = normalizePath(raw);
  if (!candidate || path.isAbsolute(candidate) || /^[A-Za-z]:/.test(candidate) || candidate.startsWith("/")) return "not a relative path";
  const segments = candidate.split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) return "path escapes or is not normalized";
  const absolute = path.resolve(repoRoot, ...segments);
  const relation = path.relative(path.resolve(repoRoot), absolute);
  if (!relation || relation.startsWith("..") || path.isAbsolute(relation)) return "outside the workspace";
  const stat = await fsp.stat(absolute).catch(() => null);
  if (!stat) return "not in workspace";
  if (!stat.isFile()) return "not a file";
  return null;
}

// D3.3: schema first, then the fixed rules; any failure is malformed_review_result.
export async function validateReviewResult(value, { workOrder, call, repoRoot, previousFindings = [], deltaPaths = null, contractSha256 = null, contract = null }) {
  const errors = value && typeof value === "object" && !Array.isArray(value)
    ? validateAgainstSchema(value, await loadSchema(REVIEW_RESULT_SCHEMA))
    : ["$: not an object"];
  if (errors.length) return { ok: false, errors };
  if (nfc(value.work_order) !== nfc(workOrder)) errors.push("$.work_order: expected " + workOrder);
  if (value.call !== call) errors.push("$.call: expected " + call);
  errors.push(...contractEchoErrors(value, contractSha256));
  errors.push(...verdictProblems(value, contract));
  if (value.gate === "FAIL" && value.findings.length === 0) errors.push("$.findings: FAIL needs at least one finding");
  if (value.gate === "PASS" && value.findings.some((finding) => finding.severity === "HIGH")) errors.push("$.findings: PASS cannot carry a HIGH finding");
  // Codex finding 2026-10-13: a PASS must not carry a hard-stop signal; the two contradict.
  if (value.gate === "PASS" && value.hard_stop) errors.push("$.hard_stop: PASS cannot request a hard stop");
  if (value.hard_stop && !value.hard_stop_reason) errors.push("$.hard_stop_reason: required when hard_stop is true");
  if (!value.hard_stop && value.hard_stop_reason) errors.push("$.hard_stop_reason: must be null when hard_stop is false");
  const ids = new Set();
  const previousIds = new Set(previousFindings.map((finding) => finding.id));
  const delta = deltaPaths ? new Set(deltaPaths.map(normalizePath)) : null;
  for (const [index, finding] of value.findings.entries()) {
    // A reviewer on Windows writes `src\a.ts`. Paths use `/`, as in Git's output and SARIF's
    // artifactLocation.uri, so the finding is kept with `/` and then checked like any other.
    finding.path = finding.path.replaceAll("\\", "/");
    const at = "$.findings[" + index + "]";
    if (ids.has(finding.id)) errors.push(at + ".id: duplicate " + finding.id);
    ids.add(finding.id);
    const problem = await workspaceFileProblem(repoRoot, finding.path);
    if (problem) errors.push(at + ".path: " + problem + ": " + finding.path);
    // D4.3: on a recheck a new id may only land on a file the delta changed.
    if (delta && !previousIds.has(finding.id) && !delta.has(normalizePath(finding.path))) {
      errors.push(at + ".path: new finding outside the delta: " + finding.path);
    }
  }
  return { ok: errors.length === 0, errors };
}

// D2.5: scope violations are decided by the controller; no reviewer call is made.
export function controllerScopeResult({ workOrder, call, scopeViolations, contractSha256 = null }) {
  return {
    event: "review.result",
    work_order: workOrder,
    contract_sha256: contractSha256,
    call,
    gate: "FAIL",
    hard_stop: true,
    hard_stop_reason: "scope_expansion",
    findings: scopeViolations.map((violation, index) => ({
      id: "F" + (index + 1),
      severity: "HIGH",
      path: normalizePath(violation),
      line: 1,
      reach: "workspace delta",
      claim: "changed outside the authorized paths",
      evidence: "delta scope_violations",
      fix: "revert the change or ask the owner to widen the scope",
      acceptance_ref: null,
      source: "controller",
    })),
    verified: [],
    not_run: [],
    // The controller judged no condition; on a scope violation every one stays unknown.
    verdicts: [],
    source: "controller",
  };
}

// D4.3 / D4.4: ids that survive a correction are unresolved; ids missing are resolved.
export function recheckFindings(previousFindings, currentFindings) {
  const previous = new Map((previousFindings || []).map((finding) => [finding.id, finding]));
  const current = new Map((currentFindings || []).map((finding) => [finding.id, finding]));
  return {
    resolved: [...previous.keys()].filter((id) => !current.has(id)),
    unresolved: [...previous.keys()].filter((id) => current.has(id)),
    new: [...current.keys()].filter((id) => !previous.has(id)),
  };
}

export function sortBySeverity(findings) {
  return [...(findings || [])].sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0));
}
