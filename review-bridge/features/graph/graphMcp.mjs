// Bridge's MCP server over stdio (the official @modelcontextprotocol/sdk, McpServer and
// StdioServerTransport): the writer asks where a thing is and who refers to it, the reviewer asks what
// a change touches. Every tool only reads, through a read-only database session with a server-side time
// limit, and is marked readOnlyHint (which Codex needs to call it without a person to approve; the hint is
// a label, the session is the guarantee). Each answer is one page; `next` asks for the following one.
import path from "node:path";

import { GRAPH_MCP_NAME, graphQueries } from "../../service/index.mjs";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const answer = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const refusal = (message) => ({ content: [{ type: "text", text: message }], isError: true });
const nextOf = (rows, limit, line = "line") => (rows.length === limit && rows.length ? { after_file_id: Number(rows.at(-1).file_id), after_line: rows.at(-1)[line] } : null);
const strip = (rows) => rows.map(({ file_id: _id, ...row }) => row);
const afterOf = (input) => (input.after_file_id ? { file_id: input.after_file_id, line: input.after_line ?? 0 } : null);

// The tools, apart from the transport so tests call them directly. `db()` opens the read-only session.
export function graphTools({ projectId, db }) {
  const limitOf = (input) => Math.max(1, Math.min(input.limit ?? graphQueries.PAGE, 200));
  const guarded = (work) => async (input) => {
    try {
      const database = await db();
      if (!(await graphQueries.graphState(database, { projectId }))) return refusal("This project has no graph yet. Run: review-bridge graph");
      return answer(await work(database, input ?? {}));
    } catch (error) {
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
      const rows = await graphQueries.definitions(database, { projectId, name: input.name, after: afterOf(input), limit });
      return { name: input.name, definitions: strip(rows), next: nextOf(rows, limit, "start_line") };
    }),
    find_references: guarded(async (database, input) => {
      const limit = limitOf(input);
      const rows = await graphQueries.references(database, { projectId, name: input.name, after: afterOf(input), limit });
      return { name: input.name, references: strip(rows), next: nextOf(rows, limit), note: "By name only: a reference may mean another definition of the same name." };
    }),
    file_outline: guarded(async (database, input) => (await graphQueries.outline(database, { projectId, path: input.path })) ?? { path: input.path, found: false }),
    importers: guarded(async (database, input) => {
      const limit = limitOf(input);
      const folder = path.posix.dirname(input.path);
      const rows = await graphQueries.importers(database, { projectId, targets: folder === "." ? [input.path] : [input.path, folder], after: afterOf(input), limit });
      return { path: input.path, importers: strip(rows), next: nextOf(rows, limit) };
    }),
    impact: guarded(async (database, input) => {
      const changes = input.changes.map((change) => ({ path: change.path, start_line: change.start_line ?? 1, end_line: change.end_line ?? 2_147_483_647 }));
      const defined = await graphQueries.touched(database, { projectId, changes, limit: 100 });
      const names = [...new Set(defined.map((row) => row.name))].slice(0, 30);
      const referred = await graphQueries.referrers(database, { projectId, names, perName: 10 });
      const targets = [...new Set(changes.flatMap((change) => [change.path, path.posix.dirname(change.path)]).filter((item) => item !== "."))];
      const imported = await graphQueries.importers(database, { projectId, targets, limit: 100 });
      return { touched: defined, references: referred, importers: strip(imported), limits: "100 touched definitions, the first 30 names with 10 references each, 100 importers" };
    }),
  };
}

export async function serveGraph({ projectId, openReadOnlyDatabase }) {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { z } = await import("zod");
  let opened = null;
  const db = () => (opened ??= openReadOnlyDatabase().catch((error) => { opened = null; throw error; }));
  const tools = graphTools({ projectId, db });
  const page = { limit: z.number().int().min(1).max(200).optional(), after_file_id: z.number().int().optional(), after_line: z.number().int().optional() };
  const server = new McpServer({ name: GRAPH_MCP_NAME, version: "1.0.0" });
  const register = (name, description, inputSchema) => server.registerTool(name, { description, inputSchema, annotations: READ_ONLY }, tools[name]);
  register("graph_state", "When this project's graph was built and last brought up to date, the folders it covers, and the files it cannot vouch for.", {});
  register("find_definitions", "Where a name is defined: file, kind and lines.", { name: z.string().min(1), ...page });
  register("find_references", "Where a name is called or used as a type, by name.", { name: z.string().min(1), ...page });
  register("file_outline", "What one file (path relative to the project) defines and imports, and where its imports lead.", { path: z.string().min(1) });
  register("importers", "Which files import this file (or its folder, for Go packages and Java wildcards).", { path: z.string().min(1), ...page });
  register("impact", "What changed lines touch: the definitions they fall in, who refers to those names, and who imports the changed files.", {
    changes: z.array(z.object({ path: z.string().min(1), start_line: z.number().int().min(1).optional(), end_line: z.number().int().min(1).optional() })).min(1).max(100),
  });
  await server.connect(new StdioServerTransport());
}
