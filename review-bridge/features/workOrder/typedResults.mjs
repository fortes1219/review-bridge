// Typed model outputs (T0-05). The CLIs are asked for a schema-shaped answer; this
// module checks the shape again and applies the fixed rules the harness decides by.
// Nothing here reads prose.
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

// A small draft-07 subset: enough for the two result schemas, no external dependency.
export function validateAgainstSchema(value, schema, at = "$", errors = []) {
  if (schema.const !== undefined && value !== schema.const) errors.push(at + ": must be " + JSON.stringify(schema.const));
  if (schema.enum && !schema.enum.some((option) => option === value)) errors.push(at + ": must be one of " + JSON.stringify(schema.enum));
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) {
      errors.push(at + ": must be " + types.join("|") + ", got " + typeOf(value));
      return errors;
    }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(at + ": shorter than " + schema.minLength);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(at + ": longer than " + schema.maxLength);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(at + ": does not match " + schema.pattern);
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) errors.push(at + ": below " + schema.minimum);
  if (Array.isArray(value) && schema.items) value.forEach((item, index) => validateAgainstSchema(item, schema.items, at + "[" + index + "]", errors));
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!(key in value)) errors.push(at + ": missing " + key);
    for (const [key, child] of Object.entries(schema.properties || {})) if (key in value) validateAgainstSchema(value[key], child, at + "." + key, errors);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in (schema.properties || {}))) errors.push(at + ": unexpected " + key);
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

export async function validateWriterResult(value, { workOrder, call }) {
  const errors = value && typeof value === "object" && !Array.isArray(value)
    ? validateAgainstSchema(value, await loadSchema(WRITER_RESULT_SCHEMA))
    : ["$: not an object"];
  if (!errors.length) {
    if (value.work_order !== workOrder) errors.push("$.work_order: expected " + workOrder);
    if (value.call !== call) errors.push("$.call: expected " + call);
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
export async function workspaceFileProblem(repoRoot, relative) {
  const raw = String(relative || "");
  // Checked on the raw string, before normalization strips a leading `./`.
  if (raw.includes("\\") || /(^|\/)\.(\/|$)/.test(raw)) return "path escapes or is not normalized";
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
export async function validateReviewResult(value, { workOrder, call, repoRoot, previousFindings = [], deltaPaths = null }) {
  const errors = value && typeof value === "object" && !Array.isArray(value)
    ? validateAgainstSchema(value, await loadSchema(REVIEW_RESULT_SCHEMA))
    : ["$: not an object"];
  if (errors.length) return { ok: false, errors };
  if (value.work_order !== workOrder) errors.push("$.work_order: expected " + workOrder);
  if (value.call !== call) errors.push("$.call: expected " + call);
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
export function controllerScopeResult({ workOrder, call, scopeViolations }) {
  return {
    event: "review.result",
    work_order: workOrder,
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

// D5.1 / D5.2: `codex exec --json` prints one event per line; usage and commands are taken from it.
export function parseCodexJsonl(text) {
  let usage = null;
  const commands = [];
  let unparsable = 0;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { unparsable += 1; continue; }
    if (record?.type === "turn.completed" && record.usage && typeof record.usage === "object") usage = record.usage;
    if (record?.type === "item.completed" && record.item?.type === "command_execution" && record.item.command) {
      commands.push(String(record.item.command).slice(0, 200));
    }
  }
  return { usage, commands, unparsable_lines: unparsable };
}

// A path the command names, when one can be read off mechanically; otherwise null.
export function pathFromCommand(command) {
  const match = /(?:^|\s)((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8})(?=\s|$|['"])/.exec(String(command || "").replace(/^(?:bash|sh)\s+-lc\s+/, "").replace(/^['"]|['"]$/g, ""));
  return match ? normalizePath(match[1]) : null;
}

// The four token fields codex-cli 0.162 was verified to put in turn.completed.usage (2026-10-13).
export const CODEX_USAGE_FIELDS = Object.freeze(["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens"]);

export function reviewerUsageEvent({ usage, trailerTokens, call, durationMs }) {
  const number = (value) => (Number.isFinite(value) ? value : 0);
  const base = { event: "usage", role: "reviewer", provider: "codex", call, turns: null, duration_ms: durationMs };
  if (usage) {
    // Codex's input_tokens is the total; cached_input_tokens and cache_write_input_tokens are
    // parts of it (OpenAI usage shape; field names verified against codex-cli 0.162 on 2026-10-13).
    // The parts are split out so the ceiling total counts each token once. Parts larger than the
    // total are a data anomaly: recorded as such, never silently floored.
    const total = number(usage.input_tokens);
    const cached = number(usage.cached_input_tokens);
    const cacheWrite = number(usage.cache_write_input_tokens);
    const plain = total - cached - cacheWrite;
    // Codex 2026-10-14: an empty or partial usage object is unknown, never zero.
    const missing = CODEX_USAGE_FIELDS.filter((field) => !Number.isFinite(usage[field]));
    return {
      ...base,
      ...(missing.length ? { parse_error: true, missing } : {}),
      tokens: {
        input: Math.max(0, plain),
        cache_write: cacheWrite,
        cache_read: cached,
        output: number(usage.output_tokens),
      },
      ...(plain < 0 ? { anomaly: "cache_parts_exceed_input_tokens", raw_usage: usage } : {}),
      cost_usd: null,
      source: "cli_json",
    };
  }
  if (Number.isFinite(trailerTokens)) {
    return { ...base, tokens: { input: trailerTokens, cache_write: 0, cache_read: 0, output: 0 }, cost_usd: null, source: "cli_trailer" };
  }
  return { ...base, tokens: { input: 0, cache_write: 0, cache_read: 0, output: 0 }, cost_usd: null, source: null, parse_error: true };
}
