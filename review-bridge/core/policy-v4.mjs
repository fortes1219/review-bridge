import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  ensureDir,
  fileExists,
  readJson,
  writeJsonExclusiveDurable,
} from "./io.mjs";

const levelRank = new Map([
  ["LIGHT", 1],
  ["STANDARD", 2],
  ["FULL", 3],
  ["SECURITY", 4],
  ["FINAL_CLOSURE", 5],
]);
const WRITER_MODEL = /^[A-Za-z0-9][A-Za-z0-9._\[\]-]{0,79}$/;
const effortRank = new Map([["low", 1], ["medium", 2], ["high", 3]]);

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function digest(value) {
  const source = typeof value === "string" ? value : JSON.stringify(canonical(value));
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function union(left = [], right = []) {
  return [...new Set([...left, ...right])].sort();
}

function validatePattern(source, label) {
  if (typeof source !== "string" || !source.trim()) throw new Error(label + " has an empty pattern.");
  try {
    new RegExp(source, "i");
  } catch (error) {
    throw new Error(label + " has an invalid pattern: " + error.message);
  }
}

function validateRule(rule, allowedLevels, label) {
  if (!rule || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(String(rule.id || ""))) {
    throw new Error(label + " has no stable rule id.");
  }
  if (!allowedLevels.includes(rule.level) || !levelRank.has(rule.level)) {
    throw new Error(label + " has an invalid review level.");
  }
  if (!Number.isInteger(rule.priority)) throw new Error(label + " has no integer priority.");
  if (!Array.isArray(rule.any) || !rule.any.length) throw new Error(label + " has no positive patterns.");
  for (const pattern of rule.any) validatePattern(pattern, label);
  for (const pattern of rule.none || []) validatePattern(pattern, label);
}

export function validateDefaultPolicy(policy) {
  if (policy?.schema_version !== 4 || policy?.policy_schema_version !== 4) {
    throw new Error("Default policy has an unsupported schema.");
  }
  const limits = policy.limits || {};
  for (const key of [
    "max_claude_calls",
    "max_claude_minutes_per_call",
    "max_turns",
    "max_tokens_per_call",
    "max_tokens_per_run",
    "authorization_ttl_seconds",
    "recovery_window_seconds",
    "heartbeat_interval_seconds",
    "lock_stale_seconds",
    "reconcile_grace_seconds",
    "reconcile_guard_ttl_seconds",
  ]) {
    if (!Number.isInteger(limits[key]) || limits[key] < 1) throw new Error("Default policy limit is invalid: " + key);
  }
  if (limits.reconcile_guard_ttl_seconds <= limits.reconcile_grace_seconds) {
    throw new Error("Reconcile guard TTL must exceed the grace period.");
  }
  if (policy.writer?.model !== undefined && !WRITER_MODEL.test(String(policy.writer.model))) {
    throw new Error("Writer model setting is invalid.");
  }
  if (policy.release_actions_require_human !== true) throw new Error("Release approval cannot be disabled.");
  const classification = policy.classification || {};
  const allowed = classification.allowed_review_levels || [];
  if (!allowed.length || !allowed.includes(classification.default_review_level)) {
    throw new Error("Default classification levels are invalid.");
  }
  const seen = new Set();
  for (const rule of classification.rules || []) {
    validateRule(rule, allowed, "classification rule " + String(rule?.id || "<missing>"));
    if (seen.has(rule.id)) throw new Error("Duplicate classification rule id: " + rule.id);
    seen.add(rule.id);
  }
  return true;
}

function mergeProtectedRule(base, candidate) {
  if (candidate.protected === false) throw new Error("Protected rule cannot be unprotected: " + base.id);
  if (levelRank.get(candidate.level || base.level) < levelRank.get(base.level)) {
    throw new Error("Protected rule level cannot be lowered: " + base.id);
  }
  if (Number(candidate.priority ?? base.priority) < base.priority) {
    throw new Error("Protected rule priority cannot be lowered: " + base.id);
  }
  const requestedAny = candidate.any || [];
  const requestedNone = candidate.none || [];
  if (candidate.any && base.any.some((entry) => !candidate.any.includes(entry))) {
    throw new Error("Protected rule patterns cannot be removed or narrowed: " + base.id);
  }
  if (requestedNone.some((entry) => !(base.none || []).includes(entry))) {
    throw new Error("Protected rule cannot add a bypass exclusion: " + base.id);
  }
  return {
    ...base,
    ...candidate,
    protected: true,
    level: levelRank.get(candidate.level || base.level) >= levelRank.get(base.level)
      ? candidate.level || base.level
      : base.level,
    priority: Math.max(base.priority, Number(candidate.priority ?? base.priority)),
    any: union(base.any, requestedAny),
    none: (base.none || []).filter((entry) => requestedNone.length ? requestedNone.includes(entry) : true),
  };
}

export function mergePolicy(defaultPolicy, override = {}) {
  validateDefaultPolicy(defaultPolicy);
  if (override.schema_version !== undefined && override.schema_version !== 4) {
    throw new Error("Project policy override has an unsupported schema.");
  }
  const merged = structuredClone(defaultPolicy);
  for (const [key, value] of Object.entries(override.limits || {})) {
    if (!(key in merged.limits)) throw new Error("Unknown override limit: " + key);
    if (!Number.isInteger(value) || value < 1 || value > merged.limits[key]) {
      throw new Error("Project override may only tighten limit: " + key);
    }
    merged.limits[key] = value;
  }
  merged.hard_stops = union(merged.hard_stops, override.hard_stops);
  merged.writer.disallowed_tools = union(
    merged.writer.disallowed_tools,
    override.writer?.disallowed_tools,
  );
  // Not protected: a project may pick any writer model the CLI accepts.
  if (override.writer?.model !== undefined) {
    if (typeof override.writer.model !== "string" || !WRITER_MODEL.test(override.writer.model)) {
      throw new Error("Project override writer model is invalid.");
    }
    merged.writer.model = override.writer.model;
  }
  if (override.release_actions_require_human === false) {
    throw new Error("Project override cannot disable human release approval.");
  }
  for (const [level, effort] of Object.entries(override.classification?.effort_by_level || {})) {
    const current = merged.classification.effort_by_level[level];
    if (!effortRank.has(effort) || !current || effortRank.get(effort) < effortRank.get(current)) {
      throw new Error("Project override cannot lower review effort for " + level + ".");
    }
    merged.classification.effort_by_level[level] = effort;
  }
  const byId = new Map(merged.classification.rules.map((rule) => [rule.id, rule]));
  for (const candidate of override.classification?.rules || []) {
    const base = byId.get(candidate.id);
    if (base?.protected) byId.set(candidate.id, mergeProtectedRule(base, candidate));
    else {
      const normalized = { protected: false, none: [], ...candidate };
      validateRule(normalized, merged.classification.allowed_review_levels, "classification rule " + candidate.id);
      for (const protectedRule of [...byId.values()].filter((rule) => rule.protected)) {
        const overlaps = normalized.any.some((pattern) => protectedRule.any.includes(pattern));
        if (overlaps && levelRank.get(normalized.level) < levelRank.get(protectedRule.level)) {
          throw new Error("Lower-level rule cannot shadow a protected match: " + candidate.id);
        }
      }
      byId.set(candidate.id, normalized);
    }
  }
  merged.classification.rules = [...byId.values()];
  validateDefaultPolicy(merged);
  return merged;
}

export async function loadOrCreatePolicySnapshot(paths) {
  const defaults = await readJson(paths.defaultPolicyPath);
  const override = await fileExists(paths.policyOverridePath)
    ? await readJson(paths.policyOverridePath)
    : { schema_version: 4 };
  const effective = mergePolicy(defaults, override);
  const snapshot = {
    schema_version: 4,
    policy_schema_version: defaults.policy_schema_version,
    package_default_policy_sha256: digest(defaults),
    project_override_sha256: digest(override),
    effective_policy: effective,
  };
  snapshot.effective_policy_sha256 = digest(snapshot);
  const file = path.join(paths.policySnapshotsDir, snapshot.effective_policy_sha256 + ".json");
  await ensureDir(paths.policySnapshotsDir);
  if (!(await fileExists(file))) await writeJsonExclusiveDurable(file, snapshot);
  else if (digest(await readJson(file)) !== digest(snapshot)) throw new Error("Policy snapshot checksum collision.");
  return { snapshot, path: file };
}

export function classificationProfileFromSnapshot(snapshot) {
  const classification = snapshot.effective_policy.classification;
  return {
    schema_version: 1,
    profile_id: "snapshot-" + snapshot.effective_policy_sha256,
    rules: structuredClone(classification.rules),
  };
}

export function codexPolicyFromSnapshot(snapshot) {
  const classification = snapshot.effective_policy.classification;
  return {
    classification_profile: "snapshot-" + snapshot.effective_policy_sha256,
    classification: "controller_dynamic_v4",
    default_review_level: classification.default_review_level,
    allowed_review_levels: structuredClone(classification.allowed_review_levels),
    effort_by_level: structuredClone(classification.effort_by_level),
    classification_owner: "controller",
    claude_may_select_or_downgrade: false,
  };
}
