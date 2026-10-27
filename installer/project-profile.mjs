// Project detection for the installer: which profile fits the target, what it can verify, and
// the project override it starts with. Read only; nothing here writes to the target.
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const installerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function exists(file) {
  try {
    await fsp.lstat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(file) {
  return JSON.parse((await fsp.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

async function readJsonOptional(file) {
  return (await exists(file)) ? await readJson(file) : null;
}

// The project starts with no override of its own; the person adds one when the project needs it.
export function projectPolicyOverride(profile) {
  return {
    schema_version: 5,
    profile_id: profile.profile_id,
  };
}

function rootGlobRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^" + escaped.replaceAll("*", ".*").replaceAll("?", ".") + "$", "i");
}

async function rootGlobMatches(target, pattern) {
  const matcher = rootGlobRegex(pattern);
  return (await fsp.readdir(target, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => matcher.test(name));
}

async function readTextOptional(file) {
  return (await exists(file)) ? await fsp.readFile(file, "utf8") : null;
}

async function contentRuleMatches(target, rule) {
  const text = await readTextOptional(path.join(target, rule.file));
  if (text === null) return false;
  return (rule.patterns || []).some((pattern) => new RegExp(pattern, rule.flags || "i").test(text));
}

async function listProfileIds() {
  const entries = await fsp.readdir(path.join(installerRoot, "profiles"), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -5))
    .sort();
}

async function loadProfile(profileId) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(profileId)) throw new Error("Invalid profile ID: " + profileId);
  const file = path.join(installerRoot, "profiles", profileId + ".json");
  if (!(await exists(file))) throw new Error("Unsupported profile: " + profileId);
  const profile = await readJson(file);
  if (profile.schema_version !== 2 || profile.profile_id !== profileId || typeof profile.display_name !== "string") {
    throw new Error("Profile schema is invalid: " + profileId);
  }
  return profile;
}

async function autoProfileMatches(target, profile) {
  const rules = profile.auto_detection || {};
  if ((rules.files_all || []).length > 0) {
    const matches = await Promise.all(rules.files_all.map((file) => exists(path.join(target, file))));
    if (!matches.every(Boolean)) return false;
  }
  if ((rules.files_any || []).length > 0
      && !(await Promise.all(rules.files_any.map((file) => exists(path.join(target, file))))).some(Boolean)) return false;
  if ((rules.root_globs_any || []).length > 0) {
    const matches = await Promise.all(rules.root_globs_any.map((pattern) => rootGlobMatches(target, pattern)));
    if (!matches.some((entries) => entries.length > 0)) return false;
  }
  if ((rules.content_all || []).length > 0) {
    const matches = await Promise.all(rules.content_all.map((rule) => contentRuleMatches(target, rule)));
    if (!matches.every(Boolean)) return false;
  }
  if ((rules.content_any || []).length > 0) {
    const matches = await Promise.all(rules.content_any.map((rule) => contentRuleMatches(target, rule)));
    if (!matches.some(Boolean)) return false;
  }
  if ((rules.content_none || []).length > 0) {
    const matches = await Promise.all(rules.content_none.map((rule) => contentRuleMatches(target, rule)));
    if (matches.some(Boolean)) return false;
  }
  return Object.values(rules).some((value) => Array.isArray(value) && value.length > 0);
}

// No project type: nothing is detected, and the tests have no rules, so only
// docs-only work can pass them. Recorded as profile_id null; `--profile none` selects it.
export const UNBOUND_PROFILE = Object.freeze({
  schema_version: 2,
  profile_id: null,
  display_name: "none",
  verification_rules: Object.freeze([]),
});

export async function listProfiles() {
  const profiles = [];
  for (const id of await listProfileIds()) profiles.push(await loadProfile(id));
  return profiles;
}

// The profiles whose detection rules hold for the target; a folder that is not there yet matches none.
export async function matchingProfiles(target) {
  if (!(await exists(target))) return [];
  const matched = [];
  for (const profile of await listProfiles()) {
    if (await autoProfileMatches(target, profile)) matched.push(profile);
  }
  return matched;
}

export async function resolveProfile(target, requestedId) {
  if (requestedId === null || requestedId === "none") return UNBOUND_PROFILE;
  if (requestedId !== "auto") return await loadProfile(requestedId);
  const matched = await matchingProfiles(target);
  // Detection may find nothing, as in an empty folder; the project is then set up without a type.
  if (matched.length === 0) return UNBOUND_PROFILE;
  if (matched.length > 1) {
    throw new Error("Auto profile detection is ambiguous; choose --profile explicitly from: " + matched.map((profile) => profile.profile_id).join(", "));
  }
  return matched[0];
}

export async function detectProject(target, profile) {
  const evidence = [];
  for (const candidate of profile.required_files_any || []) {
    if (await exists(path.join(target, candidate))) evidence.push(candidate);
  }
  for (const pattern of profile.required_root_globs_any || []) {
    evidence.push(...await rootGlobMatches(target, pattern));
  }
  const capabilities = [];
  const verificationCommands = [];
  for (const rule of profile.capability_patterns || []) {
    if (await contentRuleMatches(target, rule)) capabilities.push(rule.name);
  }
  if (profile.dependency_manifest) {
    const manifestPath = path.join(target, profile.dependency_manifest.file);
    const manifest = await readJsonOptional(manifestPath);
    if (manifest) {
      const dependencies = Object.assign({}, ...(profile.dependency_manifest.sections || []).map((section) => manifest[section] || {}));
      for (const rule of profile.dependency_manifest.capabilities || []) {
        if ((rule.dependencies || []).some((dependency) => Object.hasOwn(dependencies, dependency))) capabilities.push(rule.name);
      }
      const scripts = manifest[profile.dependency_manifest.script_section || "scripts"] || {};
      for (const script of profile.verification_script_candidates || []) {
        if (typeof scripts[script] === "string") {
          verificationCommands.push((profile.dependency_manifest.script_runner || "npm run") + " " + script);
        }
      }
    }
  }
  verificationCommands.push(...(profile.verification_candidates || []));
  // T0-06: the tests read verification_rules only; lint_rules stay here for the detection summary.
  for (const rule of [...(profile.verification_rules || []), ...(profile.lint_rules || [])]) {
    const filesAny = rule.files_any || [];
    const filesNone = rule.files_none || [];
    const anyPresent = filesAny.length === 0
      || (await Promise.all(filesAny.map((file) => exists(path.join(target, file))))).some(Boolean);
    const nonePresent = (await Promise.all(filesNone.map((file) => exists(path.join(target, file))))).every((present) => !present);
    const platformMatches = (!rule.platform && !rule.platforms)
      || rule.platform === process.platform
      || (rule.platforms || []).includes(process.platform);
    if (anyPresent && nonePresent && platformMatches) verificationCommands.push(rule.command);
  }
  return {
    evidence: [...new Set(evidence)].sort(),
    capabilities: [...new Set(capabilities)].sort(),
    verification_commands: [...new Set(verificationCommands)],
    semantic_reference_tool: profile.semantic_reference_tool,
    structural_search_tool: profile.structural_search_tool,
    execute_during_apply: false,
  };
}
