import fsp from "node:fs/promises";
import path from "node:path";
import { assertUnder, fileExists, writeJson } from "./io.mjs";

export const failureReasons = Object.freeze([
  "provider_usage_limit",
  "work_package_call_budget",
  "timeout",
  "provider_error",
  "controller_error",
]);

const EVIDENCE_TAIL_BYTES = 16_384;
const RESET_HINT_MAX = 120;
const USAGE_LIMIT = [
  /you(?:'|’)ve hit your (?:usage|session|weekly) limit/i,
  /\busage limit (?:reached|exceeded|hit)\b/i,
  /\b(?:session|weekly|5-hour|five-hour) limit (?:reached|exceeded|hit)\b/i,
  /\breached your (?:usage|session|weekly) limit\b/i,
  /\brate limit(?:ed| reached| exceeded)\b/i,
  /\b429 Too Many Requests\b/i,
  /\bquota exceeded\b/i,
];
const CODEX_ERROR_LINE = /^ERROR: \S/;
const CODEX_TRAILER_FILLER = /^(?:tokens used|[\d,]+|)$/;
const RESET_HINTS = [
  /\btry again at ([^\r\n]{1,160}?)\.?\s*$/im,
  /\bresets? (?:at )?([^\r\n;.]{1,160}?)\s*$/im,
];
// Only an explicit date/time with an optional known timezone is kept; any other text after
// "resets" stays in private evidence. The month token is a closed list of exact spellings.
const RESET_HINT_MONTHS = Object.freeze([
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Sept", "Oct", "Nov", "Dec",
  "January", "February", "March", "April", "June", "July", "August", "September", "October",
  "November", "December",
]);
const RESET_HINT_SHAPE = new RegExp("^(?:(?:" + RESET_HINT_MONTHS.join("|") + ") "
  + "(?:[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?, \\d{4} )?(?:[1-9]|1[0-2])(?::[0-5]\\d)? ?(?:AM|PM|am|pm)"
  + "(?: \\(([^()]{1,40})\\))?$");
const RESET_HINT_OFFSET = /^(?:UTC|GMT)(?:[+-](?:0?\d|1[0-4])(?::[0-5]\d)?)?$/;
const RESET_HINT_ZONE_AREAS = new Set([
  "Africa", "America", "Antarctica", "Asia", "Atlantic", "Australia", "Europe", "Indian", "Pacific", "Etc",
]);

function knownTimeZone(zone) {
  if (RESET_HINT_OFFSET.test(zone)) return true;
  if (!/^[A-Z][A-Za-z_]+(?:\/[A-Z][A-Za-z_+-]+){1,2}$/.test(zone)) return false;
  if (!RESET_HINT_ZONE_AREAS.has(zone.split("/")[0])) return false;
  try {
    return Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}

// Codex echoes tool output (including source text) on stderr. Only the closing diagnostic
// block it prints after its work, "ERROR: ..." lines followed by the token footer, counts.
export function codexDiagnosticTrailer(text) {
  const lines = String(text || "").split(/\r?\n/);
  let index = lines.length - 1;
  while (index >= 0 && CODEX_TRAILER_FILLER.test(lines[index].trim())) index -= 1;
  const trailer = [];
  while (index >= 0 && CODEX_ERROR_LINE.test(lines[index])) trailer.unshift(lines[index--]);
  return trailer.join("\n");
}

export async function readEvidenceTail(file) {
  if (!file || !(await fileExists(file))) return "";
  const handle = await fsp.open(file, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, EVIDENCE_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

function usageLimitLine(text) {
  for (const line of String(text || "").split(/\r?\n/)) {
    if (USAGE_LIMIT.some((pattern) => pattern.test(line))) return line;
  }
  return null;
}

export function explicitResetHint(line) {
  for (const pattern of RESET_HINTS) {
    const match = pattern.exec(String(line || ""));
    if (!match) continue;
    const hint = match[1].trim().slice(0, RESET_HINT_MAX);
    const shape = RESET_HINT_SHAPE.exec(hint);
    if (!shape) return null;
    return shape[1] === undefined || knownTimeZone(shape[1]) ? hint : null;
  }
  return null;
}

export function classifyProviderFailure({
  role,
  provider,
  phase,
  exitCode = null,
  timedOut = false,
  texts = [],
  observedAt = new Date().toISOString(),
}) {
  let reason = "provider_error";
  let resetHint = null;
  if (timedOut) reason = "timeout";
  else {
    for (const text of texts) {
      const line = usageLimitLine(text);
      if (line) {
        reason = "provider_usage_limit";
        resetHint = explicitResetHint(line);
        break;
      }
    }
  }
  return {
    schema_version: 1,
    role,
    provider,
    phase,
    reason,
    observed_at: observedAt,
    exit_code: Number.isInteger(exitCode) ? exitCode : null,
    reset_hint: resetHint,
    reset_hint_source: resetHint ? "cli_text" : null,
  };
}

export function budgetStop({ phase, maxCalls, observedAt = new Date().toISOString() }) {
  return {
    schema_version: 1,
    role: "controller",
    provider: "review-bridge",
    phase,
    reason: "work_package_call_budget",
    observed_at: observedAt,
    exit_code: null,
    reset_hint: null,
    reset_hint_source: null,
    max_calls: maxCalls,
  };
}

export function controllerError({ phase, observedAt = new Date().toISOString() }) {
  return {
    schema_version: 1,
    role: "controller",
    provider: "review-bridge",
    phase,
    reason: "controller_error",
    observed_at: observedAt,
    exit_code: null,
    reset_hint: null,
    reset_hint_source: null,
  };
}

export async function writeFailureRecord(paths, directory, stem, record, evidence = {}) {
  const recordPath = assertUnder(
    path.join(directory, stem + "-failure.json"),
    paths.privateRoot,
    "Failure record",
  );
  const full = { ...record, evidence: { ...evidence } };
  for (const [key, value] of Object.entries(full.evidence)) {
    if (value) assertUnder(value, paths.privateRoot, "Failure evidence " + key);
  }
  await writeJson(recordPath, full);
  return { record: full, record_path: recordPath };
}

export function failureSummary(failure, recordPath = null) {
  if (!failure) return null;
  return {
    role: failure.role,
    provider: failure.provider,
    phase: failure.phase,
    reason: failure.reason,
    observed_at: failure.observed_at,
    exit_code: failure.exit_code,
    reset_hint: failure.reset_hint,
    record_path: recordPath,
  };
}
