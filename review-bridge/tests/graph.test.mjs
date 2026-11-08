// T0-GRAPH-01, the parts that need no database and no network: what a file defines, refers to and
// imports (JavaScript, TypeScript, TSX and .vue, which @ast-grep/napi carries); which folders a monorepo
// package covers; where an import string leads; which files Git says changed; how init and start decide
// what to read; the MCP tools' pages; and the flags that give the writer and reviewer the graph server.
// The other six languages need their parser packages and run in tests/graph-languages.test.mjs (network).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as napi from "@ast-grep/napi";

import { doneMessage } from "../../installer/install-guide.mjs";
import { graphTools } from "../features/graph/graphMcp.mjs";
import { buildProbeArgs, evaluateProbe } from "../features/setupCheck/reviewerProbe.mjs";
import { ACCESS_ARGS, mcpConfigFor, readOnlyArgs } from "../service/agentCli/claude.mjs";
import { graphServerArgs } from "../service/agentCli/codex.mjs";
import { buildGraph, updateGraph } from "../service/graph/build.mjs";
import { extractSource, extractVue } from "../service/graph/extract.mjs";
import { blobIds, changedSince, listFiles } from "../service/graph/git.mjs";
import { GRAPH_MCP_NAME, graphMcpServer, graphSummaryLines } from "../service/graph/index.mjs";
import { languageOf } from "../service/graph/languages.mjs";
import { createResolver } from "../service/graph/resolve.mjs";
import { graphScope } from "../service/graph/scope.mjs";

async function tempDir(t, prefix = "review-bridge-graph-") {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function files(root, entries) {
  for (const [name, text] of Object.entries(entries)) {
    await fsp.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fsp.writeFile(path.join(root, name), text);
  }
}
function git(root, ...args) {
  const done = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.autocrlf=false", ...args], { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(done.status, 0, done.stderr);
  return done.stdout;
}

test("a TypeScript file's definitions, references and imports follow the grammar's tags.scm, and a part it cannot read is counted", async () => {
  const source = [
    "import { a } from \"./a\";",
    "export class Foo extends Bar {",
    "  run(x: Baz) { helper(); this.go(); new Qux(); }",
    "  constructor() {}",
    "}",
    "const f = () => 1;",
    "const m = require(\"m\");",
    "interface I { x: number }",
    "export { y } from \"./y\";",
    "function broken( {",
  ].join("\n");
  const out = await extractSource(napi, "typescript", source);
  assert.deepEqual(out.definitions.map((item) => [item.name, item.kind, item.start_line]), [["Foo", "class", 2], ["run", "method", 3], ["f", "function", 6], ["I", "interface", 8]]);
  assert.deepEqual(out.references.map((item) => [item.name, item.kind, item.line]), [["Baz", "type", 3], ["helper", "call", 3], ["go", "call", 3], ["Qux", "class", 3]]);
  assert.deepEqual(out.imports.map((item) => [item.specifier, item.form, item.line]), [["./a", "import", 1], ["m", "require", 7], ["./y", "export", 9]]);
  assert.equal(out.error_count, 1, "the unclosed function is an ERROR node");
});

test("a .jsx file is read with the TSX grammar, so class= in JSX is no error", async () => {
  assert.equal(languageOf("src/App.jsx"), "tsx");
  const out = await extractSource(napi, "tsx", "export const A = () => <div class=\"x\">{f()}</div>;\n");
  assert.equal(out.error_count, 0);
  assert.deepEqual(out.definitions.map((item) => item.name), ["A"]);
  assert.deepEqual(out.references.map((item) => item.name), ["f"]);
});

test("a .vue file's script blocks are read in their own language, at the file's own lines; its template is not read", async () => {
  const source = "<template>\n  <Child />\n</template>\n<script setup lang=\"ts\">\nimport Child from \"./Child.vue\";\nfunction hi(): void {\n  call();\n}\n</script>\n";
  const out = await extractVue(napi, source);
  assert.deepEqual(out.imports.map((item) => [item.specifier, item.line]), [["./Child.vue", 5]]);
  assert.deepEqual(out.definitions.map((item) => [item.name, item.start_line, item.end_line]), [["hi", 6, 8]]);
  assert.deepEqual(out.references.map((item) => [item.name, item.line]), [["call", 7]]);
  assert.equal(out.error_count, 0);
});

test("only the nine languages are read; any other file is not", () => {
  for (const [file, language] of [["a.py", "python"], ["a.go", "go"], ["a.rs", "rust"], ["A.java", "java"], ["a.kt", "kotlin"], ["a.cpp", "cpp"], ["a.h", "cpp"], ["a.cs", "csharp"], ["a.mts", "typescript"], ["a.vue", "vue"]]) {
    assert.equal(languageOf(file), language, file);
  }
  for (const file of ["README.md", "a.c", "a.php", "Makefile", "dir.js/x"]) assert.equal(languageOf(file), null, file);
});

test("in a pnpm workspace a package covers itself and the packages it depends on through workspace:, nothing else", async (t) => {
  const root = await tempDir(t);
  const manifest = (name, deps = {}, devDeps = {}) => JSON.stringify({ name, dependencies: deps, devDependencies: devDeps });
  await files(root, {
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n  - '!packages/ignored'\n",
    "package.json": manifest("root"),
    "packages/app/package.json": manifest("app", { shared: "workspace:*", lodash: "^4", hidden: "workspace:*" }, { tools: "workspace:tools@^1" }),
    "packages/shared/package.json": manifest("shared", { deep: "workspace:^" }),
    "packages/deep/package.json": manifest("deep", { app: "workspace:*" }),
    "packages/tools/package.json": manifest("tools"),
    "packages/other/package.json": manifest("other"),
    "packages/ignored/package.json": manifest("hidden"),
    "node_modules/x/package.json": manifest("x"),
  });
  assert.deepEqual((await graphScope(path.join(root, "packages", "app"))).folders, ["", "../deep", "../shared", "../tools"]);
  assert.deepEqual((await graphScope(root)).folders, [""], "the workspace root is one folder holding every package");
  assert.deepEqual((await graphScope(path.join(root, "packages", "other", "src"))).folders, [""], "a folder inside a package");
});

test("npm workspaces in the object form count; a folder in no workspace is graphed alone; two packages with one name are refused", async (t) => {
  const root = await tempDir(t);
  await files(root, {
    "package.json": JSON.stringify({ name: "root", workspaces: { packages: ["libs/*"] } }),
    "libs/a/package.json": JSON.stringify({ name: "a", peerDependencies: { b: "workspace:*" } }),
    "libs/b/package.json": JSON.stringify({ name: "b" }),
  });
  assert.deepEqual((await graphScope(path.join(root, "libs", "a"))).folders, ["", "../b"]);
  const alone = await tempDir(t);
  assert.deepEqual(await graphScope(alone), { folders: [""], workspace: null });
  await files(root, { "libs/c/package.json": JSON.stringify({ name: "b" }) });
  await assert.rejects(graphScope(path.join(root, "libs", "a")), /Two workspace packages are named b/);
});

test("an import leads to a file in the project, outside it, or stays unresolved, by each language's own rule", async (t) => {
  const root = await tempDir(t);
  await files(root, {
    "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
    "src/a.ts": "", "src/b.ts": "", "src/c.ts": "", "src/View.vue": "<template/>",
    "node_modules/lib/package.json": JSON.stringify({ name: "lib", main: "index.js" }), "node_modules/lib/index.js": "",
    "py/pkg/__init__.py": "", "py/pkg/mod.py": "", "py/pkg/sub/x.py": "",
    "go.mod": "module example.com/app\n\ngo 1.22\n", "internal/db/db.go": "", "cmd/main.go": "",
    "rs/lib.rs": "", "rs/util.rs": "", "rs/util/inner.rs": "",
    "java/src/com/x/A.java": "", "java/src/com/x/B.java": "",
    "cpp/main.cpp": "", "cpp/x.h": "",
  });
  const resolve = createResolver({ projectRoot: root });
  const at = (file, language, specifier, form = "import", filePackage = null) => resolve(file, language, { specifier, form }, filePackage);
  assert.deepEqual(await at("src/a.ts", "typescript", "./b"), { status: "resolved", target_path: "src/b.ts", target_kind: "file" });
  assert.deepEqual(await at("src/a.ts", "typescript", "@/c"), { status: "resolved", target_path: "src/c.ts", target_kind: "file" }, "tsconfig paths");
  assert.deepEqual(await at("src/a.ts", "typescript", "./View.vue"), { status: "resolved", target_path: "src/View.vue", target_kind: "file" });
  assert.deepEqual(await at("src/a.ts", "typescript", "lib"), { status: "external" });
  assert.deepEqual(await at("src/a.ts", "typescript", "node:fs"), { status: "external" });
  assert.deepEqual(await at("src/a.ts", "typescript", "./missing"), { status: "unresolved" });
  assert.deepEqual(await at("py/pkg/sub/x.py", "python", "..mod"), { status: "resolved", target_path: "py/pkg/mod.py", target_kind: "file" });
  assert.deepEqual(await at("py/pkg/sub/x.py", "python", "."), { status: "unresolved" }, "sub has no __init__.py");
  assert.deepEqual(await at("cmd/main.go", "go", "example.com/app/internal/db"), { status: "resolved", target_path: "internal/db", target_kind: "directory" });
  assert.deepEqual(await at("cmd/main.go", "go", "fmt"), { status: "external" });
  assert.deepEqual(await at("rs/lib.rs", "rust", "util", "mod"), { status: "resolved", target_path: "rs/util.rs", target_kind: "file" });
  assert.deepEqual(await at("rs/util.rs", "rust", "inner", "mod"), { status: "resolved", target_path: "rs/util/inner.rs", target_kind: "file" });
  assert.deepEqual(await at("rs/lib.rs", "rust", "crate::util::f", "use"), { status: "unresolved" });
  assert.deepEqual(await at("java/src/com/x/A.java", "java", "com.x.B", "import", "com.x"), { status: "resolved", target_path: "java/src/com/x/B.java", target_kind: "file" });
  assert.deepEqual(await at("java/src/com/x/A.java", "java", "com.x.*", "import", "com.x"), { status: "resolved", target_path: "java/src/com/x", target_kind: "directory" });
  assert.deepEqual(await at("java/src/com/x/A.java", "java", "java.util.List", "import", "com.x"), { status: "unresolved" });
  assert.deepEqual(await at("cpp/main.cpp", "cpp", "x.h", "quote"), { status: "resolved", target_path: "cpp/x.h", target_kind: "file" });
  assert.deepEqual(await at("cpp/main.cpp", "cpp", "vector", "system"), { status: "external" });
  assert.deepEqual(await at("a.kt", "kotlin", "com.x.Foo"), { status: "unresolved" });
  assert.deepEqual(await at("a.cs", "csharp", "System.Text"), { status: "unresolved" });
});

test("Git lists what it does not ignore, what changed since a commit (staged or not, untracked too), and blob ids it does not store", async (t) => {
  const root = await tempDir(t);
  await files(root, { "a.ts": "a\n", "b.ts": "b\n", ".gitignore": "ignored.ts\n", "ignored.ts": "x\n" });
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "one");
  const commit = git(root, "rev-parse", "HEAD").trim();
  assert.deepEqual(listFiles(root, ["."]).sort(), [".gitignore", "a.ts", "b.ts"]);
  assert.deepEqual(blobIds(root, ["a.ts"]), [git(root, "rev-parse", "HEAD:a.ts").trim()], "a clean file's id is its committed blob");
  await files(root, { "a.ts": "changed\n", "c.ts": "new\n" });
  await fsp.rm(path.join(root, "b.ts"));
  git(root, "add", "a.ts");
  assert.deepEqual(changedSince(root, commit, ["."]).sort(), ["a.ts", "b.ts", "c.ts"]);
  const objects = git(root, "count-objects", "-v");
  blobIds(root, ["c.ts"]);
  assert.equal(git(root, "count-objects", "-v"), objects, "hash-object without -w stores nothing in the project's Git");
});

// An in-memory stand-in for the graph's tables, answering the statements graphRecords.mjs sends.
function memoryDb() {
  const state = { graph: null, files: new Map(), writes: [], removed: [], cleared: 0, project: false };
  let nextId = 1;
  const query = async (sql, values) => {
    if (sql.startsWith("select scope")) return { rows: state.graph ? [state.graph] : [] };
    if (sql.startsWith("select path, oid")) return { rows: values[1].filter((file) => state.files.has(file)).map((file) => ({ path: file, oid: state.files.get(file).oid })) };
    if (sql.startsWith("insert into graph_files")) {
      const rows = values[1].map((file, index) => {
        const id = state.files.get(file)?.file_id ?? String(nextId++);
        state.files.set(file, { file_id: id, oid: values[3][index], language: values[2][index], parse_status: values[5][index], error_count: values[6][index] });
        return { file_id: id, path: file };
      });
      state.writes.push(values[1]);
      return { rows };
    }
    if (sql.startsWith("delete from graph_files where project_id = $1 and path")) {
      for (const file of values[1]) state.files.delete(file);
      state.removed.push(values[1]);
      return { rowCount: values[1].length };
    }
    if (sql.startsWith("delete from graph_files where project_id = $1")) { state.files.clear(); state.cleared += 1; return { rowCount: 0 }; }
    if (sql.startsWith("insert into graph_states")) { state.graph = { scope: values[1], git_commit: values[2] }; return { rows: [] }; }
    return { rows: [], rowCount: 0 };
  };
  return { state, query, transaction: async (fn) => await fn({ query }) };
}

test("init reads every file of the nine languages in the scope; start re-reads only what Git says changed and whose content is new", async (t) => {
  const root = await tempDir(t);
  const dataHome = await tempDir(t, "review-bridge-graph-home-");
  await files(root, { "src/a.ts": "export function a() { return b(); }\n", "src/b.ts": "export function b() {}\n", "src/c.ts": "export const c = () => 1;\n", "README.md": "# x\n" });
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "one");
  const db = memoryDb();
  const progress = [];
  const summary = await buildGraph({ db, projectId: "p", projectRoot: root, dataHome, ensureProject: async () => { db.state.project = true; }, onProgress: (event) => progress.push(event.phase), napiModule: napi });
  assert.equal(db.state.project, true, "the project's row comes first");
  assert.equal(summary.files, 3);
  assert.equal(summary.skipped, 1, "README.md is not read");
  assert.equal(summary.definitions, 3);
  assert.deepEqual(progress, ["found", "parsed"]);
  assert.equal(db.state.graph.git_commit, git(root, "rev-parse", "HEAD").trim());

  await files(root, { "src/a.ts": "export function a() { return 2; }\n", "src/d.ts": "export function d() {}\n" });
  await fsp.rm(path.join(root, "src", "c.ts"));
  await files(root, { "src/b.ts": "export function b() {}\n" });
  db.state.writes.length = 0;
  const update = await updateGraph({ db, projectId: "p", projectRoot: root, dataHome, napiModule: napi });
  assert.deepEqual(db.state.writes, [["src/a.ts", "src/d.ts"]], "b.ts was written with the content it had: not read again");
  assert.deepEqual(db.state.removed.at(-1), ["src/c.ts"]);
  assert.equal(update.parsed, 2);
  assert.equal(update.removed, 1);
  db.state.writes.length = 0;
  const again = await updateGraph({ db, projectId: "p", projectRoot: root, dataHome, napiModule: napi });
  assert.deepEqual(db.state.writes, [], "nothing new since the last start");
  assert.equal(again.parsed, 0);
});

test("start does not bring up to date a project with no graph, or one without Git", async (t) => {
  const root = await tempDir(t);
  await files(root, { "a.ts": "export function a() {}\n" });
  const db = memoryDb();
  assert.deepEqual(await updateGraph({ db, projectId: "p", projectRoot: root, dataHome: root }), { updated: false, reason: "no_graph" });
  const summary = await buildGraph({ db, projectId: "p", projectRoot: root, dataHome: root, napiModule: napi });
  assert.equal(summary.git, false);
  assert.equal(summary.files, 1, "without Git, init still reads the project (tinyglobby, never node_modules)");
  assert.equal(db.state.graph.git_commit, null);
  assert.deepEqual(await updateGraph({ db, projectId: "p", projectRoot: root, dataHome: root }), { updated: false, reason: "no_git" });
});

test("init's summary names how much it read and every file the graph cannot vouch for", () => {
  const lines = graphSummaryLines({
    files: 3, definitions: 7, references: 2, imports: 1, folders: ["", "../shared"],
    problems: { rust: "npm could not install @ast-grep/lang-rust@0.0.7: offline" },
    incomplete: [{ path: "src/x.ts", parse_status: "parsed", error_count: 2 }, { path: "lib.rs", parse_status: "no_parser", error_count: 0 }],
  });
  assert.deepEqual(lines, [
    "Mapped 3 file(s): 7 definition(s), 2 reference(s), 1 import(s).",
    "  workspace packages: ., ../shared",
    "  rust files were not read: npm could not install @ast-grep/lang-rust@0.0.7: offline",
    "  2 file(s) are incomplete in the graph:",
    "    src/x.ts  2 part(s) the parser could not read",
    "    lib.rs  no parser",
  ]);
  assert.match(doneMessage("/p", "/p", "http://localhost:1/", { host: "h", port: 1, user: "u", database: "d", passwordFile: "f" }, null, lines), /^Mapped 3 file\(s\)[\s\S]*no parser\n\nDone\. Now:/);
});

test("the MCP tools answer one page at a time from the graph, say when there is none, and refuse nothing silently", async () => {
  const rows = { definitions: [{ file_id: "4", path: "src/a.ts", kind: "function", start_line: 1, end_line: 3 }, { file_id: "9", path: "src/b.ts", kind: "function", start_line: 5, end_line: 6 }] };
  const asked = [];
  let graph = null;
  const db = {
    query: async (sql, values) => {
      asked.push([sql.slice(0, 40), values]);
      if (sql.startsWith("select scope")) return { rows: graph ? [graph] : [] };
      if (sql.includes("from graph_definitions d")) return { rows: rows.definitions.slice(0, values[4]) };
      return { rows: [] };
    },
  };
  const tools = graphTools({ projectId: "p", db: async () => db });
  const none = await tools.find_definitions({ name: "a" });
  assert.equal(none.isError, true);
  assert.match(none.content[0].text, /no graph yet\. Run: review-bridge graph/);
  graph = { scope: [""], git_commit: "abc" };
  const page = JSON.parse((await tools.find_definitions({ name: "a", limit: 2 })).content[0].text);
  assert.deepEqual(page.next, { after_file_id: 9, after_line: 5 }, "a full page says where the next starts");
  assert.equal(page.definitions[0].file_id, undefined);
  const last = JSON.parse((await tools.find_definitions({ name: "a", limit: 3 })).content[0].text);
  assert.equal(last.next, null);
  const broken = graphTools({ projectId: "p", db: async () => { throw new Error("connect ECONNREFUSED"); } });
  assert.match((await broken.graph_state({})).content[0].text, /^The graph could not be read: connect ECONNREFUSED/);
});

test("the writer and the reviewer are given Bridge's graph server, by name, and the read-only check runs with it", async (t) => {
  const bridgeRoot = path.join(os.tmpdir(), "rb");
  const graph = graphMcpServer({ bridgeRoot, repoRoot: path.join(os.tmpdir(), "my project") });
  assert.equal(graph.name, GRAPH_MCP_NAME);
  assert.deepEqual(graph.args, [path.join(bridgeRoot, "bootstrap.mjs"), "graph-mcp", "--project", path.join(os.tmpdir(), "my project")]);
  const cwd = await tempDir(t);
  const config = JSON.parse(await mcpConfigFor(cwd, [], graph));
  assert.deepEqual(config, { mcpServers: { [GRAPH_MCP_NAME]: { command: process.execPath, args: graph.args } } });
  const reviewer = readOnlyArgs({ mcpConfig: JSON.stringify(config), mcp: [GRAPH_MCP_NAME] });
  assert.deepEqual(reviewer.slice(-4), ["--mcp-config", JSON.stringify(config), "--allowedTools", "mcp__" + GRAPH_MCP_NAME]);
  assert.deepEqual(reviewer.slice(0, 4), ["--permission-mode", "plan", "--tools", "Read,Grep,Glob"], "still only the three read tools");
  const writer = ACCESS_ARGS.write([], true, null, graph);
  assert.deepEqual(writer.slice(writer.indexOf("--mcp-config")), ["--mcp-config", ".mcp.json", JSON.stringify(config), "--allowedTools", "mcp__" + GRAPH_MCP_NAME]);
  const codex = graphServerArgs(graph);
  assert.deepEqual(codex.filter((_, index) => index % 2 === 0), ["-c", "-c", "-c"]);
  assert.equal(codex[1], "mcp_servers." + GRAPH_MCP_NAME + ".command=" + JSON.stringify(process.execPath));
  assert.deepEqual(JSON.parse(codex[3].split("=").slice(1).join("=")), graph.args);
  assert.deepEqual(JSON.parse(codex[5].split("=").slice(1).join("=")), graph.tools);

  const probe = buildProbeArgs("claude", "<dir>", { off: [], allow: [], graph, config: JSON.stringify(config) });
  assert.ok(probe.includes("mcp__" + GRAPH_MCP_NAME), "the check is allowed the graph's tools as the review is");
  assert.ok(buildProbeArgs("codex", "<dir>", { off: [], allow: [], graph }).includes("mcp_servers." + GRAPH_MCP_NAME + ".command=" + JSON.stringify(process.execPath)));
  const stream = [
    { type: "system", subtype: "init", permissionMode: "plan", tools: ["Read", "Grep", "Glob", "mcp__" + GRAPH_MCP_NAME + "__find_definitions"] },
    { type: "result", is_error: false, result: "ok" },
  ].map((line) => JSON.stringify(line)).join("\n");
  const judged = (allow) => evaluateProbe({ provider: "claude", result: { status: 0, stdout: stream }, sentinelName: "s", probeDir: "d", sentinelPresent: false, unexpectedEntries: [], mcpAllow: allow });
  assert.equal(judged([GRAPH_MCP_NAME]).proven, true);
  assert.equal(judged([]).proven, false, "a server the review was not given still fails the check");
});
