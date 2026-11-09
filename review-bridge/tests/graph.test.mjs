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

import { fileURLToPath } from "node:url";

import { doneMessage } from "../../installer/install-guide.mjs";
import { updateRunGraph } from "../features/workOrder/commands.mjs";
import { composeSections } from "../features/workOrder/delivery.mjs";
import { createTranslator } from "../features/workOrder/i18n.mjs";
import { getBridgePaths } from "../utils/paths.mjs";
import { GRAPH_INSTRUCTIONS, GRAPH_TOOL_DESCRIPTIONS, graphToolInputs, graphTools } from "../features/graph/graphMcp.mjs";
import { graphSummaryLines, mapProject } from "../features/graph/index.mjs";
import { buildProbeArgs, evaluateProbe } from "../features/setupCheck/reviewerProbe.mjs";
import { ACCESS_ARGS, mcpConfigFor, readOnlyArgs } from "../service/agentCli/claude.mjs";
import { graphServerArgs } from "../service/agentCli/codex.mjs";
import { buildGraph, updateGraph } from "../service/graph/build.mjs";
import { extractSource, extractVue } from "../service/graph/extract.mjs";
import { blobIds, changedSince, listFiles } from "../service/graph/git.mjs";
import { GRAPH_MCP_NAME, GRAPH_TOOLS, graphMcpServer } from "../service/graph/index.mjs";
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

test("a TypeScript file's definitions, references and imports follow the grammar's tags.scm with Bridge's own lines, and a part it cannot read is counted", async () => {
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
  assert.deepEqual(out.definitions.map((item) => [item.name, item.kind, item.start_line]), [["Foo", "class", 2], ["run", "method", 3], ["f", "function", 6], ["m", "constant", 7], ["I", "interface", 8]]);
  assert.deepEqual(out.references.map((item) => [item.name, item.kind, item.line]), [["Baz", "type", 3], ["helper", "call", 3], ["go", "call", 3], ["Qux", "class", 3]]);
  assert.deepEqual(out.imports.map((item) => [item.specifier, item.form, item.line]), [["./a", "import", 1], ["m", "require", 7], ["./y", "export", 9]]);
  assert.equal(out.error_count, 1, "the unclosed function is an ERROR node");
});

// The canary's presentation.ts (2026-11-09): its labels, options and schema are constants, which the
// grammar's tags.scm leaves out, so the graph could not say where `statusLabel` is. Bridge's own query set
// keeps module-level constants and variables, type aliases, enums and their members, in ctags' kinds.
test("a module's top-level constants, variables, type aliases and enums are definitions; a constant inside a function is not", async () => {
  const source = [
    "import { z } from \"zod\";",
    "export const statusLabel: Record<Status, string> = { open: \"開啟\", closed: \"關閉\" };",
    "export const statusOptions = Object.keys(statusLabel);",
    "export const requestStatusSchema = z.enum([\"open\", \"closed\"]);",
    "export const priorityLabel = { low: \"低\" };",
    "export const priorityOptions = [\"low\", \"high\"];",
    "export const DEFAULT_STATUS = \"open\";",
    "export const MAX_ITEMS = 50;",
    "export const colors = { open: \"green\" };",
    "const internalMap = new Map();",
    "export const emptyText = \"\";",
    "export function statusText(s: Status) {",
    "  const local = statusLabel[s];",
    "  return local;",
    "}",
  ].join("\n");
  const out = await extractSource(napi, "typescript", source);
  const kinds = out.definitions.map((item) => item.kind);
  assert.equal(kinds.filter((kind) => kind === "constant").length, 10, JSON.stringify(out.definitions));
  assert.deepEqual(out.definitions.filter((item) => item.kind === "function").map((item) => item.name), ["statusText"]);
  assert.equal(out.definitions.some((item) => item.name === "local"), false, "inside a function it is no module's definition");
  assert.deepEqual(out.definitions.find((item) => item.name === "statusLabel"), { name: "statusLabel", kind: "constant", start_line: 2, end_line: 2 });

  const more = await extractSource(napi, "typescript", "let count = 0;\nvar total = 1;\nexport type Id = string;\nenum Color { Red, Green = 2 }\nconst { a, b } = pair;\n");
  assert.deepEqual(more.definitions.map((item) => [item.name, item.kind]), [["count", "variable"], ["total", "variable"], ["Id", "alias"], ["Color", "enum"], ["Red", "enumerator"], ["Green", "enumerator"]]);
  const vue = await extractVue(napi, "<script setup lang=\"ts\">\nconst title = \"x\";\nfunction go() { const inner = 1; }\n</script>\n");
  assert.deepEqual(vue.definitions.map((item) => [item.name, item.kind, item.start_line]), [["title", "constant", 2], ["go", "function", 3]]);
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

// CI's Windows runner has an 8.3 TEMP (C:\Users\RUNNER~1\...), while Git names the work tree in full:
// a project reached by its short name still sees its changed files (Windows CI, 2026-11-09).
test("a project reached by its Windows short name still sees what changed since a commit", { skip: process.platform !== "win32" && "8.3 short names are Windows only" }, async (t) => {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-long-folder-name-"));
  t.after(() => fsp.rm(parent, { recursive: true, force: true }));
  const named = spawnSync("cmd.exe", ["/d", "/s", "/c", "\"for %I in (\"" + parent + "\") do @echo %~sI\""], { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true });
  const short = named.status === 0 ? named.stdout.trim() : "";
  if (!short.includes("~")) return t.skip("this volume makes no 8.3 short names");
  const root = path.join(short, "app");
  await fsp.mkdir(root);
  await files(root, { "a.ts": "a\n", "b.ts": "b\n" });
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "one");
  const commit = git(root, "rev-parse", "HEAD").trim();
  await files(root, { "b.ts": "changed\n" });
  assert.deepEqual(changedSince(root, commit, ["."]), ["b.ts"]);
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

test("init's summary names how much it read and every file the graph cannot vouch for, in the project's language", async () => {
  const lines = graphSummaryLines({
    files: 3, definitions: 7, references: 2, imports: 1, folders: ["", "../shared"],
    problems: { rust: "npm could not install @ast-grep/lang-rust@0.0.7: offline" },
    incomplete: [{ path: "src/x.ts", parse_status: "parsed", error_count: 2 }, { path: "lib.rs", parse_status: "no_parser", error_count: 0 }],
  }, await createTranslator("en"));
  assert.deepEqual(graphSummaryLines({ files: 1, definitions: 2, references: 0, imports: 0, incomplete: [] }, await createTranslator("zh-TW")), ["已讀 1 個檔：2 個定義、0 個引用、0 個 import。"]);
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

test("`graph` prints what it reads in the project's language, and its JSON's last line carries those lines for init", async (t) => {
  const root = await tempDir(t);
  await files(root, { "src/a.ts": "export function a() {}\n", "README.md": "# x\n" });
  const run = async (json) => {
    let printed = "";
    const write = process.stdout.write;
    process.stdout.write = (text) => { printed += text; return true; };
    try {
      await mapProject({
        paths: { projectId: "p", repoRoot: root }, options: { json }, dataHome: root, ensureProject: async () => {},
        openDatabase: async () => memoryDb(), translator: () => createTranslator("zh-TW"),
      });
    } finally {
      process.stdout.write = write;
    }
    return printed;
  };
  assert.equal(await run(false), "讀取 1 個檔……\n已讀 1 個檔：1 個定義、0 個引用、0 個 import。\n");
  const last = JSON.parse((await run(true)).trimEnd().split("\n").at(-1));
  assert.equal(last.phase, "done");
  assert.deepEqual(last.lines, ["已讀 1 個檔：1 個定義、0 個引用、0 個 import。"], "init prints these as they are");
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
  const none = await tools.find_definitions({ symbol: "a" });
  assert.equal(none.isError, true);
  assert.match(none.content[0].text, /no graph yet\. Run: npx review-bridge graph/);
  graph = { scope: [""], git_commit: "abc" };
  const page = JSON.parse((await tools.find_definitions({ symbol: "a", limit: 2 })).content[0].text);
  assert.equal(page.next_cursor, "9.5", "a full page says where the next starts");
  assert.equal(page.definitions[0].file_id, undefined, "no internal id reaches the model");
  asked.length = 0;
  await tools.find_definitions({ symbol: "a", cursor: page.next_cursor });
  assert.deepEqual(asked.at(-1)[1].slice(2, 4), [9, 5], "the cursor continues after the last row");
  const last = JSON.parse((await tools.find_definitions({ symbol: "a", limit: 3 })).content[0].text);
  assert.equal(last.next_cursor, null);
  assert.match((await tools.find_definitions({ symbol: "a", cursor: "page 2" })).content[0].text, /^`cursor` is not one this tool returned/);
  const broken = graphTools({ projectId: "p", db: async () => { throw new Error("connect ECONNREFUSED"); } });
  assert.match((await broken.graph_state({})).content[0].text, /^The graph could not be read: connect ECONNREFUSED/);
});

test("a graph that cannot be brought up to date at a start goes into the run's records, and the result says it beside the verdicts", async (t) => {
  const root = await tempDir(t);
  await files(root, { ".review-bridge/bridge.json": JSON.stringify({ project_id: "00000000-0000-4000-8000-000000000001", locale: "zh-TW" }) });
  const paths = getBridgePaths(root, path.join(path.dirname(fileURLToPath(import.meta.url)), ".."), { privateRootName: ".review-bridge" });
  const recorded = [];
  let written = "";
  const reason = await updateRunGraph(paths, { db: {}, projectId: "p" }, "run-0001", {
    update: async () => { throw new Error("Git could not answer `git diff`"); },
    record: async (_paths, runId, event) => { recorded.push([runId, event]); },
    write: (text) => { written += text; },
  });
  assert.equal(reason, "Git could not answer `git diff`");
  assert.deepEqual(recorded, [["run-0001", { event: "graph_update", updated: false, reason }]]);
  assert.equal(written, "專案的 graph 沒有更新（Git could not answer `git diff`）；writer 與 reviewer 會查更新前的 graph，結果檔會寫明。要重讀整個專案：npx review-bridge graph\n");
  assert.equal(await updateRunGraph(paths, { db: {}, projectId: "p" }, "run-0001", { update: async () => ({ updated: true }), record: async () => assert.fail("nothing to record") }), null);

  const tr = await createTranslator("zh-TW");
  const events = [
    { event: "acceptance", rows: [{ id: "AC1", result: "proven", statement: "The farm is visible.", verdict: "pass", evidence: "farm.ts:3" }], review_version: { kind: "git", head: "abc123", dirty: false } },
    { event: "graph_update", updated: false, reason },
  ];
  const run = { run_id: "run-0001", status: "completed", conclusion: "success", closed_reason: null, closed_at: "2026-11-09T00:00:00.000Z", updated_at: "2026-11-09T00:00:00.000Z" };
  const sections = composeSections({ t: tr, run, workPackage: { work_package_id: "wo", budget: { rounds: 2 }, scope: {} }, plan: null, events, delta: null });
  assert.equal(sections.acceptance.at(-1), "開工時專案的 graph 沒有更新（Git could not answer `git diff`）：writer 與 reviewer 查的是這次改動之前的 graph。");
  const without = composeSections({ t: tr, run, workPackage: { work_package_id: "wo", budget: { rounds: 2 }, scope: {} }, plan: null, events: events.slice(0, 1), delta: null });
  assert.doesNotMatch(without.acceptance.join("\n"), /graph/, "an up-to-date graph adds no line");
});

// How a model comes to use a tool is the clients' own rule (knowledge base, 2026-11-09): Anthropic's tool
// definition practices (what it does, when to use it and not, each parameter, what it leaves out; 3–4
// sentences at least), the MCP schema's `instructions` for when to use the server, and Claude Code's
// 4,096-character cut on instructions and on descriptions of tools loaded up front.
test("each graph tool says what it does, when to use it instead of Grep or Read, and what each parameter means; the server says when to use it", async () => {
  const { z } = await import("zod");
  assert.deepEqual(Object.keys(GRAPH_TOOL_DESCRIPTIONS), [...GRAPH_TOOLS]);
  const inputs = graphToolInputs(z);
  for (const [name, description] of Object.entries(GRAPH_TOOL_DESCRIPTIONS)) {
    assert.ok(description.length <= 4096, name + " fits the cut Claude Code makes");
    assert.ok(description.split(/(?<=[.:])\s+(?=[A-Z`])/).length >= 3, name + " has at least three sentences");
    if (name !== "graph_state") assert.match(description, /\bUse it\b/, name + " says when to use it");
    for (const [parameter, schema] of Object.entries(inputs[name])) {
      assert.ok(schema.description, name + "." + parameter + " says what it means");
      assert.match(description, new RegExp("`" + parameter + "`"), name + " names its parameter " + parameter);
    }
  }
  for (const name of ["find_definitions", "find_references", "importers", "impact"]) assert.match(GRAPH_TOOL_DESCRIPTIONS[name], /instead of (Grep|grepping|searching)/, name);
  assert.ok(GRAPH_INSTRUCTIONS.length <= 4096);
  for (const name of GRAPH_TOOLS.filter((tool) => tool !== "graph_state")) assert.ok(GRAPH_INSTRUCTIONS.includes(name), "the instructions name " + name);
  assert.match(GRAPH_INSTRUCTIONS, /Use these tools first whenever you need to find code by name/);
});

test("the writer and the reviewer are given Bridge's graph server, by name, and the read-only check runs with it", async (t) => {
  const bridgeRoot = path.join(os.tmpdir(), "rb");
  const graph = graphMcpServer({ bridgeRoot, repoRoot: path.join(os.tmpdir(), "my project") });
  assert.equal(graph.name, GRAPH_MCP_NAME);
  assert.deepEqual(graph.args, [path.join(bridgeRoot, "bootstrap.mjs"), "graph-mcp", "--project", path.join(os.tmpdir(), "my project")]);
  const cwd = await tempDir(t);
  const config = JSON.parse(await mcpConfigFor(cwd, [], graph));
  assert.deepEqual(config, { mcpServers: { [GRAPH_MCP_NAME]: { command: process.execPath, args: graph.args, alwaysLoad: true } } }, "its tools load up front, not behind ToolSearch");
  const reviewer = readOnlyArgs({ mcpConfig: JSON.stringify(config), mcp: [GRAPH_MCP_NAME] });
  assert.deepEqual(reviewer.slice(-4), ["--mcp-config", JSON.stringify(config), "--allowedTools", "mcp__" + GRAPH_MCP_NAME]);
  assert.deepEqual(reviewer.slice(0, 4), ["--permission-mode", "plan", "--tools", "Read,Grep,Glob"], "still only the three read tools");
  const writer = ACCESS_ARGS.write([], true, null, graph);
  assert.deepEqual(writer.slice(writer.indexOf("--mcp-config")), ["--mcp-config", ".mcp.json", JSON.stringify(config), "--allowedTools", "mcp__" + GRAPH_MCP_NAME]);
  const codex = graphServerArgs(graph);
  assert.deepEqual(codex.filter((_, index) => index % 2 === 0), ["-c", "-c", "-c", "-c"]);
  assert.equal(codex[1], "mcp_servers." + GRAPH_MCP_NAME + ".command=" + JSON.stringify(process.execPath));
  assert.deepEqual(JSON.parse(codex[3].split("=").slice(1).join("=")), graph.args);
  assert.deepEqual(JSON.parse(codex[5].split("=").slice(1).join("=")), graph.tools);
  assert.equal(codex[7], "mcp_servers." + GRAPH_MCP_NAME + ".omit_tools_from=[\"deferred\"]", "Codex puts them in the first tool list too");

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
