// The project's graph: built by init, brought up to date by start, read by Bridge's MCP server.
import path from "node:path";

export { buildGraph, updateGraph } from "./build.mjs";
export * as graphQueries from "./graphRecords.mjs";
export { languageOf } from "./languages.mjs";

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
