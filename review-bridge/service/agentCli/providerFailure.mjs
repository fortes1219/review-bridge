import fsp from "node:fs/promises";
import { fileExists } from "../records/fileStore.mjs";

export const failureReasons = Object.freeze([
  "provider_usage_limit",
  "provider_signed_out",
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
  // Strings in claude.exe 2.1.280 and codex-rs 0.166's protocol/src/error.rs; none was measured.
  /you(?:'|’)ve hit your monthly spend limit/i,
  /you(?:'|’)ve reached your Fable limit/i,
  /you(?:'|’)re out of usage credits/i,
  /\byour org is out of usage\b/i,
  /\byour workspace is out of credits\b/i,
];
// What a CLI's own typed error says, where it has one: Claude's `error` on an assistant line, Codex's
// `codexErrorInfo` on the app server's error. Only these two kinds stop a line of work orders: the next
// one would die the same way.
const SIGNED_OUT_CODES = new Set(["authentication_failed", "oauth_org_not_allowed", "unauthorized"]);
const USAGE_LIMIT_CODES = new Set(["rate_limit", "billing_error", "usageLimitExceeded"]);
// The same, from a CLI that gives only words. Claude's are strings in claude.exe 2.1.280, not measured;
// each is a whole line of the CLI's own, never a phrase inside a stream it echoes. Codex's are
// login/src/auth/manager.rs of rust-v0.166.0; `exec --json` carries only the message.
const SIGNED_OUT_TEXT = [
  /^(?:Not logged in|Login expired|OAuth token revoked|Invalid API key|Invalid auth token|API Error: 401 Invalid API key) · /m,
  /^(?:ERROR: )?Your access token could not be refreshed\b/m,
];
// A moment's trouble that says nothing about the next work order: another Claude process holds the
// login refresh; Codex is reconnecting (measured 2026-11-06 with 0.166 and no network).
const PASSING_TEXT = [/\banother Claude Code process\b/i, /^(?:ERROR: )?Reconnecting\.\.\./m];
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
  code = null,
  texts = [],
  observedAt = new Date().toISOString(),
}) {
  let reason = "provider_error";
  let resetHint = null;
  const says = (patterns) => texts.some((text) => patterns.some((pattern) => pattern.test(String(text || ""))));
  if (timedOut) reason = "timeout";
  else if (says(PASSING_TEXT)) reason = "provider_error";
  else if (SIGNED_OUT_CODES.has(code) || says(SIGNED_OUT_TEXT)) reason = "provider_signed_out";
  else {
    const line = texts.map(usageLimitLine).find(Boolean) ?? null;
    if (line || USAGE_LIMIT_CODES.has(code)) {
      reason = "provider_usage_limit";
      resetHint = explicitResetHint(line);
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
