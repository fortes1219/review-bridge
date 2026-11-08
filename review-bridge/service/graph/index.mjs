// The project's graph: built by init, brought up to date by start, read by Bridge's MCP server.
import path from "node:path";

export { buildGraph, updateGraph } from "./build.mjs";
export * as graphQueries from "./graphRecords.mjs";
export { languageOf } from "./languages.mjs";

const INCOMPLETE_SHOWN = 20;

// The lines init and `graph` end with: how much was read, and every file the graph cannot vouch for
// (an ERROR node in its parse, or no parser for its language), never left out silently.
export function graphSummaryLines(summary) {
  const lines = ["Mapped " + summary.files + " file(s): " + summary.definitions + " definition(s), " + summary.references + " reference(s), " + summary.imports + " import(s)."];
  if (summary.folders?.length > 1) lines.push("  workspace packages: " + summary.folders.map((folder) => folder || ".").join(", "));
  for (const [language, problem] of Object.entries(summary.problems ?? {})) lines.push("  " + language + " files were not read: " + problem);
  if (summary.incomplete.length) {
    lines.push("  " + summary.incomplete.length + " file(s) are incomplete in the graph:");
    for (const file of summary.incomplete.slice(0, INCOMPLETE_SHOWN)) {
      lines.push("    " + file.path + "  " + (file.parse_status === "parsed" ? file.error_count + " part(s) the parser could not read" : "no parser"));
    }
    if (summary.incomplete.length > INCOMPLETE_SHOWN) lines.push("    and " + (summary.incomplete.length - INCOMPLETE_SHOWN) + " more");
  }
  return lines;
}

// Bridge's own MCP server, the same for both roles and both providers: the runtime's `graph-mcp` command
// on this project, started by the role's CLI over stdio. Its tools only read (graphMcp.mjs).
export const GRAPH_MCP_NAME = "review-bridge-graph";
export const GRAPH_TOOLS = Object.freeze(["graph_state", "find_definitions", "find_references", "file_outline", "importers", "impact"]);

export function graphMcpServer({ bridgeRoot, repoRoot }) {
  return {
    name: GRAPH_MCP_NAME,
    command: process.execPath,
    args: [path.join(bridgeRoot, "bootstrap.mjs"), "graph-mcp", "--project", path.resolve(repoRoot)],
    tools: [...GRAPH_TOOLS],
  };
}
