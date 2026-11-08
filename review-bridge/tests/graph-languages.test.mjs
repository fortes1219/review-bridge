// T0-GRAPH-01, the six languages @ast-grep/napi does not carry: their packages are installed by npm into
// a temporary data folder (this file needs the network), registered once, and one sample of each is read
// with that grammar's tags.scm rules. No database, no model. Runs in the Linux container.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as napi from "@ast-grep/napi";

import { extractSource } from "../service/graph/extract.mjs";
import { loadGrammars } from "../service/graph/grammars.mjs";

const dataHome = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-graph-languages-"));
test.after(() => fsp.rm(dataHome, { recursive: true, force: true }));
const loaded = await loadGrammars(dataHome, new Set(["python", "go", "rust", "java", "kotlin", "cpp", "csharp"]), { napi });

const has = (items, ...expected) => {
  for (const item of expected) assert.ok(items.some((found) => Object.entries(item).every(([key, value]) => found[key] === value)), JSON.stringify(item) + " in " + JSON.stringify(items));
};

test("the seven packages install from npm into the data folder and register", () => {
  assert.deepEqual(loaded.problems, {});
  assert.deepEqual([...loaded.ready].sort(), ["cpp", "csharp", "go", "java", "kotlin", "python", "rust"]);
});

test("Python: classes and functions, calls by name and attribute, imports absolute and relative", async () => {
  const out = await extractSource(napi, "python", "import os\nfrom .util import helper\nclass Greeter:\n    def greet(self):\n        helper()\n        os.path.join('a')\ndef main():\n    Greeter().greet()\nLIMIT = 3\n");
  has(out.definitions, { name: "Greeter", kind: "class" }, { name: "greet", kind: "function" }, { name: "main", kind: "function" }, { name: "LIMIT", kind: "constant" });
  has(out.references, { name: "helper", kind: "call" }, { name: "join", kind: "call" }, { name: "Greeter", kind: "call" }, { name: "greet", kind: "call" });
  assert.deepEqual(out.imports.map((item) => item.specifier), ["os", ".util"]);
  assert.equal(out.error_count, 0);
});

test("Go: functions, methods and types, calls, the package and its import paths", async () => {
  const out = await extractSource(napi, "go", "package app\n\nimport (\n\t\"fmt\"\n\t\"example.com/app/internal/db\"\n)\n\ntype Store struct{}\n\nfunc (s *Store) Save() { db.Open(); fmt.Println(\"x\") }\n\nfunc New() *Store { return &Store{} }\n");
  has(out.definitions, { name: "Store", kind: "type" }, { name: "Save", kind: "method" }, { name: "New", kind: "function" });
  has(out.references, { name: "Open", kind: "call" }, { name: "Println", kind: "call" }, { name: "Store", kind: "type" });
  assert.deepEqual(out.imports.map((item) => item.specifier), ["fmt", "example.com/app/internal/db"]);
  assert.equal(out.package, "app");
  assert.equal(out.error_count, 0);
});

test("Rust: items, methods inside an impl, calls and macros, implementations, mod files and use paths", async () => {
  const out = await extractSource(napi, "rust", "mod util;\nuse crate::util::helper;\nstruct Point { x: i32 }\ntrait Shape { fn area(&self) -> f64; }\nimpl Shape for Point { fn area(&self) -> f64 { helper(); 0.0 } }\nfn main() { println!(\"x\"); let p = Point { x: 1 }; p.area(); }\n");
  has(out.definitions, { name: "util", kind: "module" }, { name: "Point", kind: "class" }, { name: "Shape", kind: "interface" }, { name: "area", kind: "method" }, { name: "main", kind: "function" });
  has(out.references, { name: "helper", kind: "call" }, { name: "println", kind: "call" }, { name: "area", kind: "call" }, { name: "Shape", kind: "implementation" });
  assert.deepEqual(out.imports.map((item) => [item.specifier, item.form]), [["util", "mod"], ["crate::util::helper", "use"]]);
  assert.equal(out.error_count, 0);
});

test("Java: classes, methods and interfaces, calls, new, the superclass and interfaces, imports and the package", async () => {
  const out = await extractSource(napi, "java", "package com.x;\nimport java.util.List;\nimport com.x.util.*;\npublic class Greeter extends Base implements Runnable {\n  public void run() { helper(); new Greeter(); }\n}\ninterface Named {}\n");
  has(out.definitions, { name: "Greeter", kind: "class" }, { name: "run", kind: "method" }, { name: "Named", kind: "interface" });
  has(out.references, { name: "helper", kind: "call" }, { name: "Greeter", kind: "class" }, { name: "Base", kind: "class" }, { name: "Runnable", kind: "implementation" });
  assert.deepEqual(out.imports.map((item) => item.specifier), ["java.util.List", "com.x.util.*"]);
  assert.equal(out.package, "com.x");
  assert.equal(out.error_count, 0);
});

test("Kotlin: classes, objects, functions, aliases and properties, calls, imports and the package", async () => {
  const out = await extractSource(napi, "kotlin", "package com.x\n\nimport com.x.util.helper\n\nclass Greeter {\n  fun greet() { helper(); Other().run() }\n}\nobject Single\ntypealias Name = String\nval top = 1\n");
  has(out.definitions, { name: "Greeter", kind: "class" }, { name: "greet", kind: "function" }, { name: "Single", kind: "class" }, { name: "Name", kind: "type" }, { name: "top", kind: "constant" });
  has(out.references, { name: "helper", kind: "call" }, { name: "run", kind: "call" });
  assert.deepEqual(out.imports.map((item) => item.specifier), ["com.x.util.helper"]);
  assert.equal(out.package, "com.x");
  assert.equal(out.error_count, 0);
});

test("C#: classes, interfaces, methods and namespaces, base types, new, member calls, usings", async () => {
  const out = await extractSource(napi, "csharp", "using System.Text;\nnamespace App.Core {\n  class Greeter : Base, IRun {\n    void Run() { var b = new StringBuilder(); b.Append(\"x\"); }\n  }\n  interface IRun {}\n}\n");
  has(out.definitions, { name: "App.Core", kind: "module" }, { name: "Greeter", kind: "class" }, { name: "Run", kind: "method" }, { name: "IRun", kind: "interface" });
  has(out.references, { name: "Base", kind: "class" }, { name: "IRun", kind: "class" }, { name: "StringBuilder", kind: "class" }, { name: "Append", kind: "send" });
  assert.deepEqual(out.imports.map((item) => item.specifier), ["System.Text"]);
  assert.equal(out.package, "App.Core");
  assert.equal(out.error_count, 0);
});

test("C++: structs, classes, functions, methods, typedefs and enums; includes in quotes and angle brackets; no references", async () => {
  const out = await extractSource(napi, "cpp", "#include \"x.h\"\n#include <vector>\nstruct Point { int x; };\nclass Shape { public: void draw(); };\nvoid Shape::draw() {}\nint main() { return 0; }\ntypedef int Id;\nenum Color { Red };\n");
  has(out.definitions, { name: "Point", kind: "class" }, { name: "Shape", kind: "class" }, { name: "draw", kind: "function" }, { name: "draw", kind: "method" }, { name: "main", kind: "function" }, { name: "Id", kind: "type" }, { name: "Color", kind: "type" });
  assert.deepEqual(out.references, [], "tree-sitter-cpp's tags.scm has no reference");
  assert.deepEqual(out.imports.map((item) => [item.specifier, item.form]), [["x.h", "quote"], ["vector", "system"]]);
  assert.equal(out.error_count, 0);
});
