// Bridge's MCP server over stdio (the official @modelcontextprotocol/sdk, McpServer and
// StdioServerTransport): the writer asks where a thing is and who refers to it, the reviewer asks what
// a change touches. Every tool only reads, through a read-only database session with a server-side time
// limit, and is marked readOnlyHint (which Codex needs to call it without a person to approve; the hint is
// a label, the session is the guarantee). Each answer is one page; `next_cursor` asks for the following one.
//
// How a model comes to use these tools follows the clients' own documents (knowledge base, 2026-11-09):
// Claude Code defers MCP tools behind ToolSearch and loads only their names and the server's instructions,
// so the server says what it is for in `instructions` and marks its tools `anthropic/alwaysLoad`; each
// description says what the tool does, when to use it instead of Grep or Read, what each parameter means
// and what it leaves out (Anthropic's tool definition practices); the MCP schema's `instructions` is the
// place for when to use the server, without repeating the descriptions.
import path from "node:path";

import { GRAPH_MCP_NAME, graphQueries } from "../../service/index.mjs";
import { bridgeRunner } from "../../utils/bridgeCommand.mjs";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// Claude Code loads a tool marked this way up front instead of behind ToolSearch.
const LOAD_UPFRONT = { "anthropic/alwaysLoad": true };

export const GRAPH_INSTRUCTIONS = [
  "review-bridge-graph answers questions about this project's code from an index Bridge built of it:",
  "where a function, class, method, interface or type is defined (find_definitions), what calls or uses it (find_references),",
  "what a file defines and imports (file_outline), which files import a file (importers), and what a set of changed lines affects (impact).",
  "Use these tools first whenever you need to find code by name, trace its callers or dependents, or judge what a change could break;",
  "each answers in one call, without reading or searching files. Use Read for the lines you then need, and Grep only for text that is not a name, such as a log message.",
  "The index covers JavaScript, TypeScript, Vue scripts, Python, Go, Rust, Java, Kotlin, C++ and C#, as of this run's start.",
].join(" ");

const PAGING = "Results come one page at a time (`limit`, 50 by default, at most 200); when the answer has a `next_cursor`, call again with it as `cursor` for the next page.";

export const GRAPH_TOOL_DESCRIPTIONS = Object.freeze({
  graph_state: "Tells whether this project's code index exists and how current it is: the Git commit it was last brought up to date with, when it was built and updated, the folders it covers, and the first files it could not read completely. Call it once if another review-bridge-graph tool answers that there is no graph, or when you need to know whether edits made during this run are in the index (they are not: it reflects the project at this run's start). It takes no input.",
  find_definitions: "Finds where a function, class, method, interface, type, module, or (in JavaScript and TypeScript) a top-level constant, variable, type alias, enum or enum member named `symbol` is defined in this project, with each definition's file (relative to the project root), kind, and first and last line. Use it instead of Grep or Glob whenever you know the name of the code you need to change or understand: it answers from the index in one call. `symbol` is the bare identifier, matched exactly and case-sensitively: `createUser`, not `UserService.createUser`, a file name or a pattern. Java enums and records, and C# structs and enums are not indexed. " + PAGING,
  find_references: "Lists where this project calls or uses `symbol`: function and method calls, `new` expressions, type annotations, base classes and implemented interfaces, each with its file and line. Use it before you change, rename or remove a function, class or method, to see what depends on it, instead of grepping for the name. Matching is by exact name only: the index does not know which definition a use means, so a common name such as `get` or `run` also lists unrelated uses. C++ uses are not indexed. " + PAGING,
  file_outline: "Shows what one file defines, with each definition's line range, and what it imports, with the project file or folder each import leads to (or `external` for a package or built-in, `unresolved` when Bridge cannot tell). Use it to see a file's structure before reading it, or to choose which lines of a large file to Read. `path` is the file's path relative to the project root, with forward slashes, for example `src/services/user.ts`. It lists up to 200 definitions and 200 imports, and says when the parser could not read part of the file.",
  importers: "Lists the files in this project that import `path` (and, for Go packages and Java wildcard imports, its folder), each with the line and the import string. Use it to find what is affected when you change what a module exports, or move or delete a file, instead of grepping for import strings. `path` is relative to the project root, for example `src/utils/date.ts`. Only imports Bridge resolved to a project file count: aliases defined only in a Vite config, Kotlin and C# imports, and Rust `use` paths are not included. " + PAGING,
  impact: "Given the line ranges a change touched, returns the definitions those lines fall in, the first places that reference each of those names, and the files that import the changed files. Use it when you review a diff, or before you finish a change, to see what else it could affect, instead of searching the code by hand. `changes` lists one entry per changed range: `path` relative to the project root, and `start_line` and `end_line` (leave both out for the whole file). It returns at most 100 definitions, 10 references for each of the first 30 names, and 100 importers; references are matched by name only.",
});

const answer = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const refusal = (message) => ({ content: [{ type: "text", text: message }], isError: true });
// A cursor is the last row of the page, opaque to the model: `<row key>.<line>`.
const cursorOf = (rows, limit, line = "line") => (rows.length === limit && rows.length ? rows.at(-1).file_id + "." + rows.at(-1)[line] : null);
const strip = (rows) => rows.map(({ file_id: _id, ...row }) => row);
function afterOf(input) {
  if (input.cursor === undefined || input.cursor === null) return null;
  const match = /^(\d+)\.(\d+)$/.exec(String(input.cursor));
  if (!match) throw new CursorError();
  return { file_id: Number(match[1]), line: Number(match[2]) };
}
class CursorError extends Error {
  constructor() {
    super("`cursor` is not one this tool returned; pass `next_cursor` from the previous answer, or leave it out for the first page.");
  }
}

// The tools, apart from the transport so tests call them directly. `db()` opens the read-only session.
export function graphTools({ projectId, db }) {
  const limitOf = (input) => Math.max(1, Math.min(input.limit ?? graphQueries.PAGE, 200));
  const guarded = (work) => async (input) => {
    try {
      const database = await db();
      if (!(await graphQueries.graphState(database, { projectId }))) return refusal("This project has no graph yet. Run: " + bridgeRunner() + " graph");
      return answer(await work(database, input ?? {}));
    } catch (error) {
      if (error instanceof CursorError) return refusal(error.message);
      return refusal("The graph could not be read: " + String(error?.message || error));
    }
  };
  return {
    graph_state: guarded(async (database) => {
      const state = await graphQueries.graphState(database, { projectId });
      const incomplete = await graphQueries.incompleteFiles(database, { projectId, limit: 20 });
      return { ...state, incomplete_first_20: incomplete };
    }),
    find_definitions: guarded(async (database, input) => {
      const limit = limitOf(input);
      const rows = await graphQueries.definitions(database, { projectId, name: input.symbol, after: afterOf(input), limit });
      return { symbol: input.symbol, definitions: strip(rows), next_cursor: cursorOf(rows, limit, "start_line") };
    }),
    find_references: guarded(async (database, input) => {
      const limit = limitOf(input);
      const rows = await graphQueries.references(database, { projectId, name: input.symbol, after: afterOf(input), limit });
      return { symbol: input.symbol, references: strip(rows), next_cursor: cursorOf(rows, limit) };
    }),
    file_outline: guarded(async (database, input) => {
      const found = await graphQueries.outline(database, { projectId, path: input.path });
      if (!found) return { path: input.path, found: false };
      const { file_id: _id, ...file } = found;
      return file;
    }),
    importers: guarded(async (database, input) => {
      const limit = limitOf(input);
      const folder = path.posix.dirname(input.path);
      const rows = await graphQueries.importers(database, { projectId, targets: folder === "." ? [input.path] : [input.path, folder], after: afterOf(input), limit });
      return { path: input.path, importers: strip(rows), next_cursor: cursorOf(rows, limit) };
    }),
    impact: guarded(async (database, input) => {
      const changes = input.changes.map((change) => ({ path: change.path, start_line: change.start_line ?? 1, end_line: change.end_line ?? 2_147_483_647 }));
      const defined = await graphQueries.touched(database, { projectId, changes, limit: 100 });
      const names = [...new Set(defined.map((row) => row.name))].slice(0, 30);
      const referred = await graphQueries.referrers(database, { projectId, names, perName: 10 });
      const targets = [...new Set(changes.flatMap((change) => [change.path, path.posix.dirname(change.path)]).filter((item) => item !== "."))];
      const imported = await graphQueries.importers(database, { projectId, targets, limit: 100 });
      return { touched: defined, references: referred, importers: strip(imported) };
    }),
  };
}

// Each tool's input, with what every parameter means, from zod (the SDK's schema language).
export function graphToolInputs(z) {
  const symbol = z.string().min(1).describe("The bare identifier, exactly as written in the code, for example `createUser`.");
  const file = z.string().min(1).describe("The file's path relative to the project root, with forward slashes, for example `src/services/user.ts`.");
  const page = {
    limit: z.number().int().min(1).max(200).optional().describe("How many results this page holds: 50 when left out, at most 200."),
    cursor: z.string().optional().describe("The `next_cursor` of the previous answer, to get the next page; leave it out for the first page."),
  };
  return {
    graph_state: {},
    find_definitions: { symbol, ...page },
    find_references: { symbol, ...page },
    file_outline: { path: file },
    importers: { path: file, ...page },
    impact: {
      changes: z.array(z.object({
        path: file,
        start_line: z.number().int().min(1).optional().describe("The first changed line; leave out with `end_line` for the whole file."),
        end_line: z.number().int().min(1).optional().describe("The last changed line."),
      })).min(1).max(100).describe("One entry per changed range of lines, as a diff's hunks give them."),
    },
  };
}

export async function serveGraph({ projectId, openReadOnlyDatabase }) {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { z } = await import("zod");
  let opened = null;
  const db = () => (opened ??= openReadOnlyDatabase().catch((error) => { opened = null; throw error; }));
  const tools = graphTools({ projectId, db });
  const inputs = graphToolInputs(z);
  const server = new McpServer({ name: GRAPH_MCP_NAME, version: "1.0.0" }, { instructions: GRAPH_INSTRUCTIONS });
  for (const [name, description] of Object.entries(GRAPH_TOOL_DESCRIPTIONS)) {
    server.registerTool(name, { description, inputSchema: inputs[name], annotations: READ_ONLY, _meta: LOAD_UPFRONT }, tools[name]);
  }
  await server.connect(new StdioServerTransport());
}
