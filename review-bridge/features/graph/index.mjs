// The project's graph as people and agents meet it: `graph` builds it whole (init runs it, and a person
// can run it again), and `graph-mcp` is the read-only MCP server the writer's and reviewer's CLIs start.
// Nothing is written in the project: the rows are in the person's database under the project's id.
import { buildGraph, graphSummaryLines } from "../../service/index.mjs";
import { serveGraph } from "./graphMcp.mjs";

// `ensureProject(db)` is the work order feature's (the router passes it): the project's row comes first.
// With --json every step is one JSON line on stdout (init reads them for its progress), the last one
// the summary.
export async function mapProject({ paths, options, ensureProject, openDatabase, dataHome }) {
  const db = await openDatabase();
  const emit = options.json
    ? (event) => process.stdout.write(JSON.stringify(event) + "\n")
    : (event) => {
      if (event.phase === "found") process.stdout.write("Reading " + event.total + " file(s)...\n");
      if (event.phase === "installed") process.stdout.write("Installed " + event.spec + "\n");
    };
  const summary = await buildGraph({
    db, projectId: paths.projectId, projectRoot: paths.repoRoot, dataHome, ensureProject: (database) => ensureProject(database, paths), onProgress: emit,
  });
  if (options.json) emit({ phase: "done", ...summary });
  else process.stdout.write(graphSummaryLines(summary).join("\n") + "\n");
  return 0;
}

export async function serveGraphMcp({ paths, openReadOnlyDatabase }) {
  await serveGraph({ projectId: paths.projectId, openReadOnlyDatabase });
  return 0;
}
