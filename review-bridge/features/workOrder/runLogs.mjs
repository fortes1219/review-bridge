// `logs`: where a run's call logs are and what each file is, or the runs of one work order with their
// log folders, newest first; the shape of `gh run view <id> --log` and `docker logs`. The runs come
// from the person's database, the files from the run's log folder outside the project.
import fsp from "node:fs/promises";
import path from "node:path";

import { projectRun, readJson, recordsDatabase, workOrderRuns } from "../../service/index.mjs";
import { localTimestamp } from "../../utils/dates.mjs";
import { canonicalTaskFile, workOrderOfFile, workOrdersWithSourceId } from "./workOrderRecords.mjs";
import { bridgeRunner } from "../../utils/bridgeCommand.mjs";

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 10;
const write = (line) => process.stdout.write(line + "\n");

// What each file a run writes is, by the name Bridge gave it: the step, the role that made the call
// (writer or reviewer; the test is the controller's own), and the kind of file. Longest suffix first.
const CALL_FILES = [
  ["-contract-check-prompt.txt", "contract_check", "reviewer", "prompt"],
  ["-contract-check.stdout.log", "contract_check", "reviewer", "stream"],
  ["-contract-check.stderr.log", "contract_check", "reviewer", "stderr"],
  ["-contract-check.result.json", "contract_check", "reviewer", "result"],
  ["-contract_check-failure.json", "contract_check", "reviewer", "failure"],
  ["-contract-prompt.txt", "translate", "writer", "prompt"],
  ["-contract.stream.jsonl", "translate", "writer", "stream"],
  ["-contract.stderr.log", "translate", "writer", "stderr"],
  ["-contract.result.json", "translate", "writer", "result"],
  ["-translate-failure.json", "translate", "writer", "failure"],
  ["-writer-only-prompt.txt", "write", "writer", "prompt"],
  ["-writer.stream.jsonl", "write", "writer", "stream"],
  ["-writer.stdout.json", "write", "writer", "result"],
  ["-writer.stderr.log", "write", "writer", "stderr"],
  ["-writer-failure.json", "write", "writer", "failure"],
  ["-stop-payload.json", "write", "writer", "stop_payload"],
  ["-test.stdout.log", "test", "controller", "stdout"],
  ["-test.stderr.log", "test", "controller", "stderr"],
  ["-reviewer.stdout.log", "review", "reviewer", "stream"],
  ["-reviewer.stderr.log", "review", "reviewer", "stderr"],
];

function describe(name) {
  if (name.endsWith(".plan.json")) return { step: "plan", role: null, kind: "plan", stamp: null };
  if (name.startsWith("authorized-")) return { step: "start", role: null, kind: "authorization_card", stamp: null };
  if (name.endsWith(".result.md")) return { step: "result", role: null, kind: "result", stamp: null };
  for (const [suffix, step, role, kind] of CALL_FILES) {
    if (name.endsWith(suffix)) return { step, role, kind, stamp: name.slice(0, -suffix.length) };
  }
  return { step: null, role: null, kind: "other", stamp: null };
}

// The run's files, each with its call: calls are numbered in the order they began (a call's files
// share the time stamp in their names, and the test belongs to the writer call it ran after).
async function runFiles(folder) {
  const entries = await fsp.readdir(folder, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (entries === null) return null;
  const files = [];
  for (const entry of entries.filter((item) => item.isFile()).sort((left, right) => left.name.localeCompare(right.name))) {
    const file = path.join(folder, entry.name);
    files.push({ name: entry.name, path: file, bytes: (await fsp.stat(file)).size, ...describe(entry.name) });
  }
  const stamps = [...new Set(files.map((file) => file.stamp).filter(Boolean))].sort();
  return files.map(({ stamp, ...file }) => ({ ...file, call: stamp ? stamps.indexOf(stamp) + 1 : null }));
}

async function openProject(paths) {
  const config = await readJson(paths.bridgeConfigPath);
  if (!config.project_id) throw new Error("This project was set up before Bridge kept its records in a database. Run: " + bridgeRunner() + " upgrade");
  const database = recordsDatabase() || (async () => (await import("../../service/database/index.mjs")).openDatabase());
  return { db: await database(), projectId: config.project_id };
}

async function showRun({ paths, db, projectId, runId, json }) {
  const run = await projectRun(db, projectId, runId);
  const folder = paths.runLogDir(runId);
  const files = await runFiles(folder);
  if (!run && files === null) throw new Error("There is no run " + runId + " in this project. Run: " + bridgeRunner() + " status");
  if (json) {
    write(JSON.stringify({ run_id: runId, log_path: folder, present: files !== null, files: files || [] }, null, 2));
    return 0;
  }
  write("Logs of run " + runId + (run ? " (" + (run.conclusion || run.status) + ")" : "") + ": " + folder);
  if (files === null) {
    write("  None: they were removed after the retention days, or by clean " + runId + ". The run's records are still in the database.");
    return 0;
  }
  if (!files.length) write("  The folder is empty.");
  for (const file of files) {
    const call = file.call ? "call " + file.call : "";
    write("  " + [call.padEnd(7), (file.role || "").padEnd(10), (file.step || "").padEnd(14), file.kind.padEnd(18), file.name].join("  "));
  }
  return 0;
}

// A work order is named by its file (as start takes it, or its bare name in work-packages/) or by the
// source_id its versions carry. A name that points both ways at different work orders is refused.
async function workOrdersNamed({ paths, db, projectId, name }) {
  const asFile = /[\\/]|\.md$/i.test(name) ? name : path.join(path.basename(paths.privateRoot), "work-packages", name + ".md");
  const byFile = await workOrderOfFile(db, { projectId, fileName: canonicalTaskFile(paths.repoRoot, path.resolve(paths.repoRoot, asFile)) });
  const bySource = await workOrdersWithSourceId(db, { projectId, sourceId: name });
  if (byFile && bySource.length && !(bySource.length === 1 && bySource[0] === byFile)) {
    throw new Error(name + " is both a work order file and a source_id of other work orders. Give the file's path, such as .review-bridge/work-packages/" + name + ".md");
  }
  return byFile ? [byFile] : bySource;
}

async function showWorkOrder({ paths, db, projectId, name, after, json }) {
  const ids = await workOrdersNamed({ paths, db, projectId, name });
  if (!ids.length) throw new Error("No work order here is named " + name + " (a file in .review-bridge/work-packages/ or a source_id). Run: " + bridgeRunner() + " status");
  const { runs, more } = await workOrderRuns(db, ids, { limit: PAGE, after });
  const withLogs = runs.map((run) => ({ ...run, log_path: paths.runLogDir(run.run_id) }));
  if (json) {
    write(JSON.stringify({ project_id: projectId, work_order_ids: ids, runs: withLogs, more }, null, 2));
    return 0;
  }
  write("Runs of " + name + ", newest first:");
  if (!withLogs.length && !after) write("  None yet.");
  for (const run of withLogs) {
    write("  " + [run.run_id, localTimestamp(run.created_at), (run.conclusion || run.status).padEnd(15), run.log_path].join("  "));
  }
  if (more) write("  More: " + bridgeRunner() + " logs " + name + " --after " + runs.at(-1).run_id);
  return 0;
}

export async function showLogs({ paths, options }) {
  const name = options.target;
  if (!name) throw new Error("logs needs a run id or a work order. Run: " + bridgeRunner() + " logs <run_id>, or " + bridgeRunner() + " logs <file or source_id>");
  const { db, projectId } = await openProject(paths);
  if (RUN_ID.test(name)) return await showRun({ paths, db, projectId, runId: name.toLowerCase(), json: Boolean(options.json) });
  return await showWorkOrder({ paths, db, projectId, name, after: options.after || null, json: Boolean(options.json) });
}
