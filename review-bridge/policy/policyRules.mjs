// The default policy, a project override, and the effective policy they make: validation and the
// tighten-only merge. Pure: no files are read or written here.

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._\[\]-]{0,79}$/;
const effortRank = new Map([["low", 1], ["medium", 2], ["high", 3]]);
// Jira's priorities: a field the person sets, never read from the work order's words.
export const PRIORITIES = Object.freeze(["low", "medium", "high", "urgent"]);
const ROLES = Object.freeze(["writer", "reviewer"]);
// What a project override may carry; profile_id is the installer's record of the project type.
const OVERRIDE_KEYS = Object.freeze(["schema_version", "profile_id", "limits", "writer", "priority", "release_actions_require_human"]);

function union(left = [], right = []) {
  return [...new Set([...left, ...right])].sort();
}

// null: the provider CLI is given no --model and uses its own default.
function validModel(model) {
  return model === null || (typeof model === "string" && MODEL.test(model));
}

function validatePriorityTable(priority) {
  if (!PRIORITIES.includes(priority?.default)) throw new Error("Default priority is invalid.");
  for (const role of ROLES) {
    for (const level of PRIORITIES) {
      const entry = priority[role]?.[level];
      if (!entry || !effortRank.has(entry.effort) || !validModel(entry.model)) {
        throw new Error("Priority setting is invalid: " + role + "." + level + ".");
      }
    }
  }
}

export function validateDefaultPolicy(policy) {
  if (policy?.schema_version !== 5 || policy?.policy_schema_version !== 5) {
    throw new Error("Default policy has an unsupported schema.");
  }
  const limits = policy.limits || {};
  for (const key of [
    "rounds",
    "call_timeout",
    "max_turns",
    "tokens_per_call",
    "tokens",
    "test_timeout",
    "run_timeout",
    "authorization_ttl",
    "recovery_window",
    "heartbeat_interval",
    "lock_stale",
    "reconcile_grace",
    "reconcile_guard_ttl",
  ]) {
    if (!Number.isInteger(limits[key]) || limits[key] < 1) throw new Error("Default policy limit is invalid: " + key);
  }
  if (limits.reconcile_guard_ttl <= limits.reconcile_grace) {
    throw new Error("Reconcile guard TTL must exceed the grace period.");
  }
  if (policy.release_actions_require_human !== true) throw new Error("Release approval cannot be disabled.");
  validatePriorityTable(policy.priority);
  return true;
}

export function mergePolicy(defaultPolicy, override = {}) {
  validateDefaultPolicy(defaultPolicy);
  if (override.schema_version !== undefined && override.schema_version !== 5) {
    throw new Error("Project policy override has an unsupported schema.");
  }
  for (const key of Object.keys(override)) {
    if (!OVERRIDE_KEYS.includes(key)) throw new Error("Unknown project policy override key: " + key);
  }
  const merged = structuredClone(defaultPolicy);
  for (const [key, value] of Object.entries(override.limits || {})) {
    if (!(key in merged.limits)) throw new Error("Unknown override limit: " + key);
    if (!Number.isInteger(value) || value < 1 || value > merged.limits[key]) {
      throw new Error("Project override may only tighten limit: " + key);
    }
    merged.limits[key] = value;
  }
  merged.writer.disallowed_tools = union(
    merged.writer.disallowed_tools,
    override.writer?.disallowed_tools,
  );
  if (override.release_actions_require_human === false) {
    throw new Error("Project override cannot disable human release approval.");
  }
  for (const role of ROLES) {
    for (const [level, entry] of Object.entries(override.priority?.[role] || {})) {
      const current = merged.priority[role][level];
      // Not protected: a project may pick any model the CLI accepts.
      if (entry?.model !== undefined) {
        if (!current || !validModel(entry.model)) throw new Error("Project override " + role + " model for " + level + " is invalid.");
        current.model = entry.model;
      }
      // Effort may only go up.
      if (entry?.effort !== undefined) {
        if (!effortRank.has(entry.effort) || !current || effortRank.get(entry.effort) < effortRank.get(current.effort)) {
          throw new Error("Project override cannot lower " + role + " effort for " + level + ".");
        }
        current.effort = entry.effort;
      }
    }
  }
  validateDefaultPolicy(merged);
  return merged;
}

// The model and effort each role uses at one priority: the work order's, else the policy default.
export function priorityChoice(policy, priority = policy.priority.default) {
  return {
    priority,
    writer: structuredClone(policy.priority.writer[priority]),
    reviewer: structuredClone(policy.priority.reviewer[priority]),
  };
}

export function reviewerPolicyFromSnapshot(snapshot) {
  const { priority, reviewer } = priorityChoice(snapshot.effective_policy);
  return { priority, model: reviewer.model, effort: reviewer.effort };
}
