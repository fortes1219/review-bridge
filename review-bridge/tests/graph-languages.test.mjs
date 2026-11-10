// T0-GRAPH-01, the seven languages @ast-grep/napi does not carry: their packages are installed by npm into
// a temporary data folder (this file needs the network), registered once, and one sample of each is read
// with that grammar's tags.scm rules. No database, no model.
// The grammars are loaded in a process of their own (fixtures/graph-languages-worker.mjs), as Playwright
// keeps a server it starts in its own process and stops it by its handle (ECOSYSTEM-REFERENCES K): a loaded
// grammar is a native module that Windows keeps locked until the process that loaded it ends (EPERM,
// 2026-11-09), and a process that loaded them did not end by itself there. The worker answers in one JSON
// line and is then given a few seconds to end on its own; whether it did is a test of its own.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SAMPLES = {
  python: "import os\nfrom .util import helper\nclass Greeter:\n    def greet(self):\n        helper()\n        os.path.join('a')\ndef main():\n    Greeter().greet()\nLIMIT = 3\n",
  go: "package app\n\nimport (\n\t\"fmt\"\n\t\"example.com/app/internal/db\"\n)\n\ntype Store struct{}\n\nfunc (s *Store) Save() { db.Open(); fmt.Println(\"x\") }\n\nfunc New() *Store { return &Store{} }\n",
  rust: "mod util;\nuse crate::util::helper;\nstruct Point { x: i32 }\ntrait Shape { fn area(&self) -> f64; }\nimpl Shape for Point { fn area(&self) -> f64 { helper(); 0.0 } }\nfn main() { println!(\"x\"); let p = Point { x: 1 }; p.area(); }\n",
  java: "package com.x;\nimport java.util.List;\nimport com.x.util.*;\npublic class Greeter extends Base implements Runnable {\n  public void run() { helper(); new Greeter(); }\n}\ninterface Named {}\n",
  kotlin: "package com.x\n\nimport com.x.util.helper\n\nclass Greeter {\n  fun greet() { helper(); Other().run() }\n}\nobject Single\ntypealias Name = String\nval top = 1\n",
  csharp: "using System.Text;\nnamespace App.Core {\n  class Greeter : Base, IRun {\n    void Run() { var b = new StringBuilder(); b.Append(\"x\"); }\n  }\n  interface IRun {}\n}\n",
  cpp: "#include \"x.h\"\n#include <vector>\nstruct Point { int x; };\nclass Shape { public: void draw(); };\nvoid Shape::draw() {}\nint main() { return 0; }\ntypedef int Id;\nenum Color { Red };\n",
};
const ANSWER_MS = 240_000;
const EXIT_MS = 10_000;

// Runs the worker; resolves once it has ended, or was stopped: within ANSWER_MS for its answer, then
// EXIT_MS to end by itself. A stopped worker on Windows goes with its tree (taskkill /T /F, Playwright's
// killProcessTree); elsewhere SIGKILL.
function runWorker(dataHome) {
  const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "graph-languages-worker.mjs");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [worker], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let answer = null;
    let stopped = false;
    const stop = () => {
      stopped = true;
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      else child.kill("SIGKILL");
    };
    let timer = setTimeout(stop, ANSWER_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const line = stdout.split("\n").find((text) => text.startsWith("{"));
      if (line && !answer) {
        answer = JSON.parse(line);
        clearTimeout(timer);
        timer = setTimeout(stop, EXIT_MS);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => { clearTimeout(timer); resolve({ answer, exitedByItself: !stopped, code, stderr }); });
    child.stdin.end(JSON.stringify({ dataHome, samples: SAMPLES }));
  });
}

const dataHome = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-graph-languages-"));
const run = await runWorker(dataHome);
// The worker has ended, so nothing holds the grammars any more.
test.after(() => fsp.rm(dataHome, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
const loaded = { ready: new Set(run.answer?.ready ?? []), problems: run.answer?.problems ?? { worker: run.stderr || "no answer" } };
const read = (language) => {
  const out = run.answer?.results?.[language];
  assert.ok(out, language + " was not read: " + JSON.stringify(loaded.problems));
  return out;
};

const has = (items, ...expected) => {
  for (const item of expected) assert.ok(items.some((found) => Object.entries(item).every(([key, value]) => found[key] === value)), JSON.stringify(item) + " in " + JSON.stringify(items));
};

// Bridge's commands end by themselves; one that loaded the grammars must too, or `graph` and `start` would
// hang in a project with these languages (Windows, 2026-11-09: a test file that loaded them did not end).
test("a process that registered the grammars ends by itself", () => {
  assert.ok(run.answer, "the worker answered: " + run.stderr);
  assert.equal(run.exitedByItself, true, "it was still running " + EXIT_MS + " ms after its answer");
  assert.equal(run.code, 0, run.stderr);
});

test("the seven packages install from npm into the data folder and register", () => {
  assert.deepEqual(loaded.problems, {});
  assert.deepEqual([...loaded.ready].sort(), ["cpp", "csharp", "go", "java", "kotlin", "python", "rust"]);
});

test("Python: classes and functions, calls by name and attribute, imports absolute and relative", () => {
  const out = read("python");
  has(out.definitions, { name: "Greeter", kind: "class" }, { name: "greet", kind: "function" }, { name: "main", kind: "function" }, { name: "LIMIT", kind: "constant" });
  has(out.references, { name: "helper", kind: "call" }, { name: "join", kind: "call" }, { name: "Greeter", kind: "call" }, { name: "greet", kind: "call" });
  assert.deepEqual(out.imports.map((item) => item.specifier), ["os", ".util"]);
  assert.equal(out.error_count, 0);
});

test("Go: functions, methods and types, calls, the package and its import paths", () => {
  const out = read("go");
  has(out.definitions, { name: "Store", kind: "type" }, { name: "Save", kind: "method" }, { name: "New", kind: "function" });
  has(out.references, { name: "Open", kind: "call" }, { name: "Println", kind: "call" }, { name: "Store", kind: "type" });
  assert.deepEqual(out.imports.map((item) => item.specifier), ["fmt", "example.com/app/internal/db"]);
  assert.equal(out.package, "app");
  assert.equal(out.error_count, 0);
});

test("Rust: items, methods inside an impl, calls and macros, implementations, mod files and use paths", () => {
  const out = read("rust");
  has(out.definitions, { name: "util", kind: "module" }, { name: "Point", kind: "class" }, { name: "Shape", kind: "interface" }, { name: "area", kind: "method" }, { name: "main", kind: "function" });
  has(out.references, { name: "helper", kind: "call" }, { name: "println", kind: "call" }, { name: "area", kind: "call" }, { name: "Shape", kind: "implementation" });
  assert.deepEqual(out.imports.map((item) => [item.specifier, item.form]), [["util", "mod"], ["crate::util::helper", "use"]]);
  assert.equal(out.error_count, 0);
});

test("Java: classes, methods and interfaces, calls, new, the superclass and interfaces, imports and the package", () => {
  const out = read("java");
  has(out.definitions, { name: "Greeter", kind: "class" }, { name: "run", kind: "method" }, { name: "Named", kind: "interface" });
  has(out.references, { name: "helper", kind: "call" }, { name: "Greeter", kind: "class" }, { name: "Base", kind: "class" }, { name: "Runnable", kind: "implementation" });
  assert.deepEqual(out.imports.map((item) => item.specifier), ["java.util.List", "com.x.util.*"]);
  assert.equal(out.package, "com.x");
  assert.equal(out.error_count, 0);
});

test("Kotlin: classes, objects, functions, aliases and properties, calls, imports and the package", () => {
  const out = read("kotlin");
  has(out.definitions, { name: "Greeter", kind: "class" }, { name: "greet", kind: "function" }, { name: "Single", kind: "class" }, { name: "Name", kind: "type" }, { name: "top", kind: "constant" });
  has(out.references, { name: "helper", kind: "call" }, { name: "run", kind: "call" });
  assert.deepEqual(out.imports.map((item) => item.specifier), ["com.x.util.helper"]);
  assert.equal(out.package, "com.x");
  assert.equal(out.error_count, 0);
});

test("C#: classes, interfaces, methods and namespaces, base types, new, member calls, usings", () => {
  const out = read("csharp");
  has(out.definitions, { name: "App.Core", kind: "module" }, { name: "Greeter", kind: "class" }, { name: "Run", kind: "method" }, { name: "IRun", kind: "interface" });
  has(out.references, { name: "Base", kind: "class" }, { name: "IRun", kind: "class" }, { name: "StringBuilder", kind: "class" }, { name: "Append", kind: "send" });
  assert.deepEqual(out.imports.map((item) => item.specifier), ["System.Text"]);
  assert.equal(out.package, "App.Core");
  assert.equal(out.error_count, 0);
});

test("C++: structs, classes, functions, methods, typedefs and enums; includes in quotes and angle brackets; no references", () => {
  const out = read("cpp");
  has(out.definitions, { name: "Point", kind: "class" }, { name: "Shape", kind: "class" }, { name: "draw", kind: "function" }, { name: "draw", kind: "method" }, { name: "main", kind: "function" }, { name: "Id", kind: "type" }, { name: "Color", kind: "type" });
  assert.deepEqual(out.references, [], "tree-sitter-cpp's tags.scm has no reference");
  assert.deepEqual(out.imports.map((item) => [item.specifier, item.form]), [["x.h", "quote"], ["vector", "system"]]);
  assert.equal(out.error_count, 0);
});
