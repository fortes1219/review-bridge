// The project's graph as people and agents meet it: `graph` builds it whole (init runs it, and a person
// can run it again), and `graph-mcp` is the read-only MCP server the writer's and reviewer's CLIs start.
// Nothing is written in the project: the rows are in the person's database under the project's id. What
// `graph` prints is in the project's language; init prints the lines `graph --json` rendered.
import { buildGraph } from "../../service/index.mjs";
import { serveGraph } from "./graphMcp.mjs";

const INCOMPLETE_SHOWN = 20;

// How much was read, and every file the graph cannot vouch for (an ERROR node in its parse, or no parser
// for its language), never left out silently.
export function graphSummaryLines(summary, t) {
  const lines = [t("graph.mapped", { files: summary.files, definitions: summary.definitions, references: summary.references, imports: summary.imports })];
  if (summary.folders?.length > 1) lines.push(t("graph.workspace", { folders: summary.folders.map((folder) => folder || ".").join(", ") }));
  for (const [language, problem] of Object.entries(summary.problems ?? {})) lines.push(t("graph.not_read", { language, problem }));
  if (summary.incomplete.length) {
    lines.push(t("graph.incomplete", { count: summary.incomplete.length }));
    for (const file of summary.incomplete.slice(0, INCOMPLETE_SHOWN)) {
      lines.push(file.parse_status === "parsed" ? t("graph.incomplete.parsed", { path: file.path, count: file.error_count }) : t("graph.incomplete.no_parser", { path: file.path }));
    }
    if (summary.incomplete.length > INCOMPLETE_SHOWN) lines.push(t("graph.incomplete.more", { count: summary.incomplete.length - INCOMPLETE_SHOWN }));
  }
  return lines;
}

// `ensureProject(db)` is the work order feature's, and so is `translator()`, the project's language (the
// router passes both). With --json every step is one JSON line on stdout (init reads them for its
// progress), the last one the summary with its lines.
export async function mapProject({ paths, options, ensureProject, openDatabase, dataHome, translator }) {
  const t = await translator();
  const db = await openDatabase();
  const emit = options.json
    ? (event) => process.stdout.write(JSON.stringify(event) + "\n")
    : (event) => {
      if (event.phase === "found") process.stdout.write(t("graph.reading", { total: event.total }) + "\n");
      if (event.phase === "installed") process.stdout.write(t("graph.installed", { spec: event.spec }) + "\n");
    };
  const summary = await buildGraph({
    db, projectId: paths.projectId, projectRoot: paths.repoRoot, dataHome, ensureProject: (database) => ensureProject(database, paths), onProgress: emit,
  });
  const lines = graphSummaryLines(summary, t);
  if (options.json) emit({ phase: "done", ...summary, lines });
  else process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

export async function serveGraphMcp({ paths, openReadOnlyDatabase }) {
  await serveGraph({ projectId: paths.projectId, openReadOnlyDatabase });
  return 0;
}
