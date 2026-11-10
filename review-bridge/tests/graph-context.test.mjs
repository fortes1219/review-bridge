// What Bridge reads from the project's graph itself and puts into the writer's and the reviewer's prompts
// (Fortes 2026-11-09: fourteen runs with the graph as tools only called it zero times). On made-up graph
// rows, no database: the section is in the prompt, never longer than its cap, cut with a count when there
// is more; a work order that names nothing the graph knows gets the folders instead; a project without a
// graph gets nothing and no error; the number of statements does not grow with the project.
import assert from "node:assert/strict";
import test from "node:test";

import { composeSections, graphTotals } from "../features/workOrder/delivery.mjs";
import { createTranslator } from "../features/workOrder/i18n.mjs";
import { graphStats, readProjectGraph, workOrderTexts } from "../features/workOrder/projectGraph.mjs";
import { composeWriterPrompt } from "../features/workOrder/writerPrompt.mjs";
import { MAX_CHARS, reviewerGraphContext, workOrderTerms, writerGraphContext } from "../service/graph/graphContext.mjs";

// The graph's statements, answered from rows given here; every statement sent is kept.
function fakeGraph({ state = { scope: [""], git_commit: "abc" }, definitions = [], references = [], files = [], importers = [], imports = [], folders = [], touched = [] } = {}) {
  const sent = [];
  const query = async (sql, values) => {
    sent.push(sql);
    if (sql.startsWith("select scope")) return { rows: state ? [state] : [] };
    if (sql.includes("from unnest($2::text[]) as n(name)") && sql.includes("graph_definitions")) return { rows: definitions.filter((row) => values[1].includes(row.name)) };
    if (sql.includes("from unnest($2::text[]) as n(name)") && sql.includes("graph_references")) return { rows: references.filter((row) => values[1].includes(row.name)) };
    if (sql.startsWith("select path from graph_files")) return { rows: files.map((path) => ({ path })) };
    if (sql.includes("from graph_imports i join graph_files f")) return { rows: importers };
    if (sql.includes("from graph_files f join graph_imports i")) return { rows: imports };
    if (sql.startsWith("select folder")) return { rows: folders };
    if (sql.includes("from unnest($2::text[], $3::int[], $4::int[])")) return { rows: touched };
    throw new Error("unexpected statement: " + sql);
  };
  return { sent, query };
}

const order = {
  ticket: { title: "Show the status label in Chinese" },
  requested_work: { text: "Change statusLabel in src/components/StatusBadge.vue so it reads from the locale." },
  acceptance: [{ id: "AC1", statement: "statusLabel returns 進行中 for in_progress, as locale.ts says." }],
};

// The canary's engineer version (2026-11-09) wrote `statusLabel`, `statusOptions`, `requestStatusSchema` in
// backticks; with plain words first, a cap on names in order of appearance could leave them out.
test("what the work order marks as code comes first, so fifty plain words before it do not crowd it out", async () => {
  const plain = Array.from({ length: 50 }, (_, index) => "word" + index).join(" ");
  const terms = await workOrderTerms([plain + " Change `statusLabel` and `statusOptions`.", "```ts\nrequestStatusSchema.parse(x)\n```\nsee `src/lib/presentation.ts`"]);
  assert.deepEqual(terms.names.slice(0, 5), ["statusLabel", "statusOptions", "requestStatusSchema", "parse", "src"]);
  assert.ok(terms.names.includes("word49"), "the rest still follows, up to the cap");
  assert.deepEqual(terms.paths, ["src/lib/presentation.ts"]);
  const many = await workOrderTerms([Array.from({ length: 300 }, (_, index) => "name" + index).join(" ")]);
  assert.equal(many.names.length, 200, "one statement asks for at most 200");
});

test("the work order's words give the names, paths and file names asked of the graph", async () => {
  const terms = await workOrderTerms(workOrderTexts(order));
  assert.ok(terms.names.includes("statusLabel"));
  assert.deepEqual(terms.paths, ["src/components/StatusBadge.vue"]);
  assert.deepEqual(terms.fileNames, ["locale.ts"], "a file name on its own; one inside a path is asked as the path");
  assert.deepEqual(workOrderTexts(null, { task: "plain task" }), ["plain task"]);
});

test("the writer's prompt carries where the work order's names are, who refers to them and who imports their files, in a fixed number of statements", async () => {
  const graph = fakeGraph({
    definitions: [{ name: "statusLabel", path: "src/components/StatusBadge.vue", kind: "function", start_line: 12, end_line: 20 }],
    references: [{ name: "statusLabel", path: "src/views/Runs.vue", line: 44, kind: "call" }],
    files: ["src/components/StatusBadge.vue"],
    importers: [{ file_id: "1", path: "src/views/Runs.vue", line: 3, specifier: "../components/StatusBadge.vue", target_path: "src/components/StatusBadge.vue" }],
  });
  const context = await writerGraphContext({ db: graph, projectId: "p", texts: workOrderTexts(order) });
  assert.equal(context.queries, 5, "state, definitions, files, references, importers: one each");
  assert.equal(graph.sent.length, 5);
  assert.match(context.text, /^- statusLabel \(function\) is defined at src\/components\/StatusBadge\.vue:12-20$/m);
  assert.match(context.text, /^- statusLabel is referred to at src\/views\/Runs\.vue:44$/m);
  assert.match(context.text, /^- src\/components\/StatusBadge\.vue is imported by src\/views\/Runs\.vue:3$/m);
  assert.ok(context.text.length <= MAX_CHARS);
  assert.equal(context.tokens, Math.ceil(context.text.length / 4));
  const prompt = composeWriterPrompt({
    workPackage: { work_package_id: "wo", scope: { allowed_paths: ["src"], forbidden_paths: [] }, breakpoint: "after review" },
    control: {}, runId: "run-1", call: 1, taskInput: { limits: { max_turns: 10, max_output_chars: 1000 } }, references: [], rulesText: "", projectGraph: context.text,
  });
  assert.match(prompt, /=== TASK \(task\.input\) ===[\s\S]*=== PROJECT \(review-bridge-graph\) ===\nProject graph: where the names and files of this work order are/);
  assert.doesNotMatch(composeWriterPrompt({
    workPackage: { work_package_id: "wo", scope: { allowed_paths: [], forbidden_paths: [] } }, control: {}, runId: "run-1", call: 1,
    taskInput: { limits: { max_turns: 10, max_output_chars: 1000 } }, references: [], rulesText: "",
  }), /=== PROJECT/, "no graph, no section");
});

test("a section longer than its cap is cut by whole lines and says how many more there are and where to ask", async () => {
  const many = Array.from({ length: 200 }, (_, index) => ({ name: "statusLabel", path: "src/views/View" + index + ".vue", line: index + 1, kind: "call" }));
  const graph = fakeGraph({ definitions: [{ name: "statusLabel", path: "src/a.ts", kind: "function", start_line: 1, end_line: 2 }], references: many });
  // One reference line per name: make many names, each referred to.
  const names = Array.from({ length: 40 }, (_, index) => "statusLabel" + index);
  const wide = fakeGraph({
    definitions: names.map((name, index) => ({ name, path: "src/components/AVeryLongComponentFileName" + index + ".vue", kind: "function", start_line: 10, end_line: 90 })),
    references: names.map((name) => ({ name, path: "src/views/SomeView.vue", line: 1, kind: "call" })),
  });
  const context = await writerGraphContext({ db: wide, projectId: "p", texts: [names.join(" ")] });
  assert.ok(context.text.length <= MAX_CHARS, String(context.text.length));
  assert.match(context.text, /\n\.\.\. and \d+ more; ask the review-bridge-graph tools for them\.$/);
  assert.ok((await writerGraphContext({ db: graph, projectId: "p", texts: ["statusLabel"] })).text.length <= MAX_CHARS);
});

test("a work order that names nothing the graph knows gets the project's folders and their file counts", async () => {
  const graph = fakeGraph({ folders: [{ folder: "src/components", files: 12, total: 30 }, { folder: "src/views", files: 8, total: 30 }, { folder: ".", files: 10, total: 30 }] });
  const context = await writerGraphContext({ db: graph, projectId: "p", texts: ["狀態標籤顯示中文"] });
  assert.equal(context.queries, 2, "state and folders: with no name or file in the words, nothing else is asked");
  assert.equal(context.text, "Project graph: no name or file in the work order is in the project's index of 30 file(s). Its folders, largest first:\n- src/components (12 file(s))\n- src/views (8 file(s))\n- . (10 file(s))");
});

test("a project without a graph, or without records, puts nothing in the prompt and says no error; a read that fails keeps its reason", async () => {
  const graph = fakeGraph({ state: null });
  assert.equal(await writerGraphContext({ db: graph, projectId: "p", texts: workOrderTexts(order) }), null);
  assert.equal(graph.sent.length, 1, "only the graph's state is asked");
  assert.equal(await reviewerGraphContext({ db: fakeGraph({ state: null }), projectId: "p", changedPaths: ["a.ts"] }), null);
  assert.equal(await readProjectGraph({ projectId: "p" }, async () => assert.fail("not read"), { database: null }), null);
  const failed = await readProjectGraph({ projectId: "p" }, async () => { throw new Error("connection refused"); }, { database: async () => ({}) });
  assert.deepEqual(failed, { text: null, queries: 0, tokens: 0, error: "connection refused" });
  assert.deepEqual(graphStats(failed), { queries: 0, tokens: 0, error: "connection refused" });
});

test("the reviewer's packet carries what the changed files define, who refers to them, who imports them and what they import", async () => {
  const graph = fakeGraph({
    touched: [{ path: "src/components/StatusBadge.vue", name: "statusLabel", kind: "function", start_line: 12, end_line: 20 }],
    references: [{ name: "statusLabel", path: "src/views/Runs.vue", line: 44, kind: "call" }],
    importers: [{ file_id: "1", path: "src/views/Runs.vue", line: 3, specifier: "../components/StatusBadge.vue", target_path: "src/components/StatusBadge.vue" }],
    imports: [{ path: "src/components/StatusBadge.vue", specifier: "vue-i18n", line: 2, status: "unresolved", target_path: null }],
  });
  const context = await reviewerGraphContext({ db: graph, projectId: "p", changedPaths: ["src/components/StatusBadge.vue"] });
  assert.equal(context.queries, 5, "state, touched, references, importers, imports: one each");
  assert.match(context.text, /^- src\/components\/StatusBadge\.vue defines statusLabel \(function\) at 12-20$/m);
  assert.match(context.text, /^- src\/views\/Runs\.vue is imported by|^- src\/components\/StatusBadge\.vue is imported by src\/views\/Runs\.vue:3$/m);
  assert.match(context.text, /^- src\/components\/StatusBadge\.vue:2 imports vue-i18n \(unresolved\)$/m);
  assert.ok(context.text.length <= MAX_CHARS);
  const outside = await reviewerGraphContext({ db: fakeGraph(), projectId: "p", changedPaths: ["README.md"] });
  assert.equal(outside.text, "Project graph: none of the changed files is in Bridge's index of the project (a new file, or not code in one of its languages):\n- README.md");
});

test("the result's token table has a graph row with Bridge's statements and the tokens it put in, when the run read the graph", async () => {
  const events = [
    { event: "task.input", call: 1, graph: { queries: 5, tokens: 120 } },
    { event: "task.input", call: 2, graph: { queries: 0, tokens: 120 } },
    { event: "review.input", call: 1, graph: { queries: 5, tokens: 90 } },
  ];
  assert.deepEqual(graphTotals(events), { queries: 10, tokens: 330 });
  assert.equal(graphTotals([{ event: "task.input", call: 1 }]), null);
  const t = await createTranslator("zh-TW");
  const run = { run_id: "run-1", status: "completed", conclusion: "success", closed_reason: null, closed_at: "2026-11-09T00:00:00.000Z" };
  const sections = composeSections({ t, run, workPackage: { work_package_id: "wo", budget: { rounds: 2 }, scope: {} }, plan: null, events, delta: null });
  assert.ok(sections.tokens.includes("| graph 查詢 | 10 次 SQL | 放進 prompt 約 330 token |  |  |  |  | 估算；已算在上面 writer 與 reviewer 的 input 裡，不是另外的花費 |"), sections.tokens.join("\n"));
});
