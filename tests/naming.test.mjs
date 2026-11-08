import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { applyMigrations } from "../review-bridge/service/database/migrate.mjs";
import { connect, ensureCluster, postgresBinaries, startServer, stopServer } from "../review-bridge/service/database/postgresServer.mjs";

// The names Bridge ships, checked by structure only: the key paths of its own policy, the enum
// values of its schemas, the tables and CHECK values its migrations leave, and the placeholders of
// its review prompts. Each is a set compared whole. No model is called.
const runtimeRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "review-bridge");
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(runtimeRoot, relative), "utf8"));

// Every key's full path in an object tree, walked with a stack. Array items are walked as
// `name[]`; values that are not objects end a path.
function keyPaths(root) {
  const paths = new Set();
  const stack = [[root, ""]];
  while (stack.length) {
    const [node, prefix] = stack.pop();
    if (Array.isArray(node)) {
      for (const item of node) if (item && typeof item === "object") stack.push([item, prefix + "[]"]);
      continue;
    }
    for (const [key, value] of Object.entries(node)) {
      const at = prefix ? prefix + "." + key : key;
      paths.add(at);
      if (value && typeof value === "object") stack.push([value, at]);
    }
  }
  return paths;
}

// Every `enum` in a JSON schema, by the path of the property that holds it, walked with a stack.
function enumsOf(schema) {
  const found = new Map();
  const stack = [[schema, ""]];
  while (stack.length) {
    const [node, prefix] = stack.pop();
    if (Array.isArray(node)) {
      node.forEach((item, index) => { if (item && typeof item === "object") stack.push([item, prefix + "[" + index + "]"]); });
      continue;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "enum") found.set(prefix, value);
      else if (value && typeof value === "object") stack.push([value, prefix ? prefix + "." + key : key]);
    }
  }
  return found;
}

const PRIORITY_PATHS = ["writer", "reviewer"].flatMap((role) => [
  "priority." + role,
  ...["low", "medium", "high", "urgent"].flatMap((level) => [
    "priority." + role + "." + level, "priority." + role + "." + level + ".model", "priority." + role + "." + level + ".effort",
  ]),
]);

test("the shipped policy has exactly the keys of the policy's priority table and unit-free limits", () => {
  assert.deepEqual(keyPaths(readJson("config/default-policy.json")), new Set([
    "schema_version", "policy_schema_version", "package_policy_id",
    "limits", "limits.rounds", "limits.call_timeout", "limits.max_turns", "limits.tokens_per_call", "limits.tokens",
    "limits.test_timeout", "limits.run_timeout", "limits.authorization_ttl", "limits.recovery_window", "limits.heartbeat_interval",
    "limits.lock_stale", "limits.reconcile_grace", "limits.reconcile_guard_ttl",
    "writer", "writer.mode", "writer.disallowed_tools", "writer.self_review",
    "reviewer", "reviewer.mcp_allow",
    "priority", "priority.default", ...PRIORITY_PATHS,
    "release_actions_require_human",
  ]));
});

test("every enum in the schemas holds the new values", () => {
  const schemas = path.join(runtimeRoot, "features", "workOrder", "schemas");
  const actual = new Map();
  for (const name of fs.readdirSync(schemas)) {
    for (const [at, values] of enumsOf(readJson(path.join("features", "workOrder", "schemas", name)))) actual.set(name + " " + at, values);
  }
  assert.deepEqual(actual, new Map([
    ["contract.schema.json properties.ticket.properties.priority", ["low", "medium", "high", "urgent", null]],
    ["contract.schema.json properties.ticket.properties.effort", ["low", "medium", "high", null]],
    ["contract.schema.json properties.run_plan.properties.runs.items.properties.effort", ["low", "medium", "high", null]],
    ["review.result.schema.json properties.findings.items.properties.severity", ["HIGH", "MEDIUM", "LOW"]],
    ["review.result.schema.json properties.gate", ["PASS", "FAIL"]],
    ["review.result.schema.json properties.hard_stop_reason", ["needs_human_decision", "scope_expansion", "release_action", null]],
    ["review.result.schema.json properties.verdicts.items.properties.verdict", ["pass", "fail", "cannot_verify"]],
    ["writer.result.schema.json properties.changed.items.properties.action", ["added", "modified", "deleted"]],
    ["writer.result.schema.json properties.criteria.items.properties.status", ["done", "not_done"]],
    ["writer.result.schema.json properties.status", ["done", "blocked", "out_of_scope"]],
  ]));
});

test("after every migration the tables and CHECK values carry the new names", { timeout: 120_000 }, async (t) => {
  const binaries = await postgresBinaries();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-naming-"));
  let client = null;
  t.after(async () => {
    await client?.end().catch(() => {});
    await stopServer(root, { binaries }).catch(() => {});
    await fsp.rm(root, { recursive: true, force: true });
  });
  await ensureCluster(root, { binaries });
  await startServer(root, { binaries });
  client = await connect(root);
  await applyMigrations(client);

  const tables = new Set((await client.query("select table_name from information_schema.tables where table_schema = 'public'")).rows.map((row) => row.table_name));
  assert.ok(tables.has("test_results"));
  assert.ok(!tables.has("gate_a_results"));
  const columns = async (table) => new Set((await client.query(
    "select column_name from information_schema.columns where table_schema = 'public' and table_name = $1", [table])).rows.map((row) => row.column_name));
  // gate_a became test (2026-10-27), and the column went (2026-11-08): no condition leans on the tests by itself.
  assert.ok(!(await columns("acceptance_rows")).has("test"));
  assert.ok(!(await columns("acceptance_rows")).has("gate_a"));
  assert.ok(!(await columns("runs")).has("outcome"));
  assert.ok((await columns("runs")).has("delivered_at"));
  assert.ok((await columns("runs")).has("timeout_at"));
  assert.ok((await columns("runs")).has("run_deadline_at"), "the recovery deadline stays beside the run's time limit");

  // The quoted values of one CHECK, as PostgreSQL itself prints the constraint.
  const checkValues = async (table, name) => {
    const { rows } = await client.query(
      "select pg_get_constraintdef(oid) as definition from pg_constraint where conrelid = $1::regclass and conname = $2", [table, name]);
    assert.equal(rows.length, 1, table + "." + name + " exists");
    return new Set([...rows[0].definition.matchAll(/'([^']*)'::text/g)].map((match) => match[1]));
  };
  assert.deepEqual(await checkValues("runs", "runs_status_check"), new Set(["in_progress", "completed"]));
  assert.deepEqual(await checkValues("runs", "runs_conclusion_check"), new Set(["success", "failure", "cancelled", "timed_out", "action_required"]));
  assert.deepEqual(await checkValues("test_results", "test_results_kind_check"), new Set(["command", "not_configured"]));
  const types = await checkValues("run_events", "run_events_type_check");
  assert.ok(types.has("test_result"));
  assert.ok(!types.has("gate_a_result"));
});

test("the review prompts take exactly the controller's placeholders", () => {
  for (const relative of ["review-prompt.md", "templates/review-prompt.generic.md"]) {
    const text = fs.readFileSync(path.join(runtimeRoot, relative), "utf8");
    const placeholders = new Set([...text.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((match) => match[1]));
    assert.deepEqual(placeholders, new Set(["PRIORITY", "REASONING_EFFORT", "REPO_ROOT", "RULES", "REVIEW_INPUT"]), relative);
    assert.ok(!placeholders.has("REVIEW_LEVEL") && !placeholders.has("CLASSIFICATION_REASONS"), relative);
  }
});
