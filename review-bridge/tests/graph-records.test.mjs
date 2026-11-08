// T0-GRAPH-01, against a real PostgreSQL in a temporary folder (no model, no network): the graph's rows
// are written and replaced file by file, every query the graph serves reads through its index (the
// EXPLAIN of each is printed as a diagnostic and checked for its index and for no sequential scan of a
// graph table), the MCP server's session cannot write, and a whole build lands in the tables.
// Two projects of 3,000 files each, so the planner has a choice to make.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as napi from "@ast-grep/napi";

import { graphTools } from "../features/graph/graphMcp.mjs";
import { DATABASE_NAME, openReadOnlyDatabase } from "../service/database/index.mjs";
import { applyMigrations } from "../service/database/migrate.mjs";
import { connect, ensureCluster, postgresBinaries, startServer, stopServer } from "../service/database/postgresServer.mjs";
import { buildGraph, updateGraph } from "../service/graph/build.mjs";
import * as records from "../service/graph/graphRecords.mjs";

const binaries = await postgresBinaries();
const dataHome = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-graph-records-"));
const root = path.join(dataHome, "postgres");
await ensureCluster(root, { binaries });
await startServer(root, { binaries });
const admin = await connect(root);
await admin.query("create database " + DATABASE_NAME);
await admin.end();
const client = await connect(root, { database: DATABASE_NAME });
await applyMigrations(client);
const db = {
  query: (sql, values) => client.query(sql, values),
  async transaction(fn) {
    await client.query("begin");
    try {
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  },
};
test.after(async () => {
  await client.end().catch(() => {});
  await stopServer(root, { binaries }).catch(() => {});
  await fsp.rm(dataHome, { recursive: true, force: true });
});

const projectA = randomUUID();
const projectB = randomUUID();
// A third, larger project: one person's database holds every project, so the one asked is a small part.
const projectC = randomUUID();
for (const id of [projectA, projectB, projectC]) {
  await client.query("insert into projects (project_id, root_path, name, created_at, last_activity_at) values ($1, $2, 'p', now(), now())", [id, "/p/" + id]);
}
await client.query(
  "insert into graph_files (project_id, path, language, oid, package, parse_status, error_count, parsed_at)"
  + " select p.id, 'src/d' || (g % 40) || '/f' || g || '.ts', 'typescript', null, null, case when g % 500 = 0 then 'no_parser' else 'parsed' end, case when g % 300 = 0 then 1 else 0 end, now()"
  + " from unnest($1::uuid[], $2::int[]) p(id, files), generate_series(1, p.files) g",
  [[projectA, projectB, projectC], [3000, 3000, 20000]],
);
await client.query("insert into graph_definitions select f.file_id, f.project_id, 'name' || ((f.file_id * 7 + k) % 5000), 'function', k * 10 + 1, k * 10 + 5 from graph_files f, generate_series(0, 2) k");
await client.query("insert into graph_references select f.file_id, f.project_id, 'name' || ((f.file_id * 13 + k) % 5000), 'call', k * 10 + 2 from graph_files f, generate_series(0, 2) k");
await client.query("insert into graph_imports select f.file_id, f.project_id, './f' || k, k + 1, 'resolved', 'src/d' || (((f.file_id + k) % 3000 + 1) % 40) || '/f' || (((f.file_id + k) % 3000) + 1) || '.ts', 'file' from graph_files f, generate_series(0, 1) k");
await client.query("insert into graph_states (project_id, scope, git_commit, built_at, updated_at) values ($1, '{\"\"}', null, now(), now()), ($2, '{\"\"}', null, now(), now())", [projectA, projectB]);
await client.query("analyze");

// Every statement a query function sends, explained with the same values instead of run.
function explaining(plans) {
  return {
    query: async (sql, values) => {
      const { rows } = await client.query("explain (costs off) " + sql, values);
      plans.push({ sql, plan: rows.map((row) => row["QUERY PLAN"]).join("\n") });
      return { rows: [] };
    },
  };
}

const QUERIES = [
  ["storedFiles", (database) => records.storedFiles(database, { projectId: projectA, paths: ["src/d10/f10.ts", "src/d11/f11.ts"] }), ["graph_files_project_id_path_key"]],
  ["definitions", (database) => records.definitions(database, { projectId: projectA, name: "name42" }), ["graph_definitions_by_name"]],
  ["references", (database) => records.references(database, { projectId: projectA, name: "name42", after: { file_id: 10, line: 2 } }), ["graph_references_by_name"]],
  ["importers", (database) => records.importers(database, { projectId: projectA, targets: ["src/d10/f10.ts", "src/d10"] }), ["graph_imports_by_target"]],
  ["outline", (database) => records.outline(database, { projectId: projectA, path: "src/d10/f10.ts" }), ["graph_files_project_id_path_key"]],
  ["touched", (database) => records.touched(database, { projectId: projectA, changes: [{ path: "src/d10/f10.ts", start_line: 1, end_line: 12 }] }), ["graph_files_project_id_path_key", "graph_definitions_by_file"]],
  ["referrers", (database) => records.referrers(database, { projectId: projectA, names: ["name42", "name43"], perName: 10 }), ["graph_references_by_name"]],
  ["incompleteFiles", (database) => records.incompleteFiles(database, { projectId: projectA }), ["graph_files_incomplete"]],
  // What Bridge reads itself for the writer's and the reviewer's prompts (graphContext.mjs).
  ["definitionsOf", (database) => records.definitionsOf(database, { projectId: projectA, names: ["name42", "name43", "nothing"], perName: 3 }), ["graph_definitions_by_name"]],
  ["filesNamed", (database) => records.filesNamed(database, { projectId: projectA, paths: ["src/d10/f10.ts"], fileNames: ["f11.ts"] }), ["graph_files_project_id_path_key"]],
  ["importsOf", (database) => records.importsOf(database, { projectId: projectA, paths: ["src/d10/f10.ts", "src/d11/f11.ts"] }), ["graph_files_project_id_path_key", "graph_imports_by_file"]],
  ["folderOverview", (database) => records.folderOverview(database, { projectId: projectA }), ["graph_files_project_id_path_key"]],
];

for (const [name, run, indexes] of QUERIES) {
  test("the graph's " + name + " query reads through " + indexes.join(" and ") + ", never a whole table", async (t) => {
    const plans = [];
    await run(explaining(plans));
    assert.ok(plans.length >= 1);
    const all = plans.map((item) => item.plan).join("\n");
    for (const plan of plans) t.diagnostic(name + ":\n" + plan.sql + "\n" + plan.plan);
    for (const index of indexes) assert.match(all, new RegExp(index), name + " uses " + index + "\n" + all);
    assert.doesNotMatch(all, /Seq Scan on graph_/, name + " reads no graph table whole\n" + all);
  });
}

test("the outline's follow-up reads go through the file's own indexes", async (t) => {
  const [{ file_id: fileId }] = (await client.query("select file_id from graph_files where project_id = $1 and path = 'src/d10/f10.ts'", [projectA])).rows;
  for (const [sql, index] of [
    ["select name, kind, start_line, end_line from graph_definitions where file_id = $1 order by start_line limit $2", "graph_definitions_by_file"],
    ["select specifier, line, status, target_path, target_kind from graph_imports where file_id = $1 order by line limit $2", "graph_imports_by_file"],
  ]) {
    const plan = (await client.query("explain (costs off) " + sql, [fileId, 200])).rows.map((row) => row["QUERY PLAN"]).join("\n");
    t.diagnostic(sql + "\n" + plan);
    assert.match(plan, new RegExp(index));
  }
});

test("a file's rows are replaced whole, other files' are untouched, and a removed file takes its rows with it", async () => {
  const project = randomUUID();
  await client.query("insert into projects (project_id, root_path, name, created_at, last_activity_at) values ($1, '/q', 'q', now(), now())", [project]);
  const file = (name, defs) => ({
    path: name, language: "typescript", oid: "o", package: null, parse_status: "parsed", error_count: 0,
    definitions: defs.map((def, index) => ({ name: def, kind: "function", start_line: index + 1, end_line: index + 1 })),
    references: [{ name: "x", kind: "call", line: 1 }],
    imports: [{ specifier: "./b", line: 1, status: "resolved", target_path: "b.ts", target_kind: "file" }],
  });
  await db.transaction((tx) => records.writeFiles(tx, { projectId: project, files: [file("a.ts", ["a1", "a2"]), file("b.ts", ["b1"])] }));
  await db.transaction((tx) => records.writeFiles(tx, { projectId: project, files: [file("a.ts", ["a3"])] }));
  const names = async () => (await client.query("select f.path, d.name from graph_definitions d join graph_files f using (file_id) where d.project_id = $1 order by 1, 2", [project])).rows;
  assert.deepEqual(await names(), [{ path: "a.ts", name: "a3" }, { path: "b.ts", name: "b1" }]);
  await db.transaction((tx) => records.removeFiles(tx, { projectId: project, paths: ["a.ts"] }));
  assert.deepEqual(await names(), [{ path: "b.ts", name: "b1" }]);
  assert.equal((await client.query("select count(*)::int as n from graph_references where project_id = $1", [project])).rows[0].n, 1);
});

test("the MCP server's session reads the graph and cannot write to it", async () => {
  const reader = await openReadOnlyDatabase({ dataHome });
  try {
    await assert.rejects(reader.query("delete from graph_files where project_id = $1", [projectA]), (error) => error.code === "25006");
    const tools = graphTools({ projectId: projectA, db: async () => reader });
    const found = JSON.parse((await tools.find_definitions({ symbol: "name42", limit: 2 })).content[0].text);
    assert.equal(found.definitions.length, 2);
    assert.ok(found.next_cursor);
    const following = JSON.parse((await tools.find_definitions({ symbol: "name42", limit: 2, cursor: found.next_cursor })).content[0].text);
    assert.ok(following.definitions.length >= 1, "the cursor reaches the next page");
    const state = JSON.parse((await tools.graph_state({})).content[0].text);
    assert.equal(state.incomplete_first_20.length, 20);
  } finally {
    await reader.close();
  }
});

test("a build lands in the tables, and an update after one edit writes only that file", async (t) => {
  const project = randomUUID();
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-graph-build-"));
  t.after(() => fsp.rm(folder, { recursive: true, force: true }));
  const git = (...args) => assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: folder, windowsHide: true }).status, 0);
  await fsp.writeFile(path.join(folder, "a.ts"), "import { b } from \"./b\";\nexport function a() { return b(); }\n");
  await fsp.writeFile(path.join(folder, "b.ts"), "export function b() {}\n");
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "one");
  const ensureProject = (database) => database.query("insert into projects (project_id, root_path, name, created_at, last_activity_at) values ($1, $2, 'g', now(), now()) on conflict do nothing", [project, folder]);
  const built = await buildGraph({ db, projectId: project, projectRoot: folder, dataHome, ensureProject, napiModule: napi });
  assert.equal(built.files, 2);
  assert.deepEqual((await client.query("select f.path, i.target_path from graph_imports i join graph_files f using (file_id) where i.project_id = $1", [project])).rows, [{ path: "a.ts", target_path: "b.ts" }]);
  const before = (await client.query("select path, parsed_at from graph_files where project_id = $1 order by path", [project])).rows;
  await fsp.writeFile(path.join(folder, "b.ts"), "export function b() {}\nexport function c() {}\n");
  const updated = await updateGraph({ db, projectId: project, projectRoot: folder, dataHome, napiModule: napi });
  assert.equal(updated.parsed, 1);
  const after = (await client.query("select path, parsed_at from graph_files where project_id = $1 order by path", [project])).rows;
  assert.equal(after[0].parsed_at.getTime(), before[0].parsed_at.getTime(), "a.ts is not read again");
  assert.notEqual(after[1].parsed_at.getTime(), before[1].parsed_at.getTime());
});
