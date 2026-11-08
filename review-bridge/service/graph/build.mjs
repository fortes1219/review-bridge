// Building a project's graph (T0-GRAPH-01). init builds it whole; start brings up to date only the files
// Git says may have changed since the commit the graph is up to date with, and of those only the ones
// whose blob id differs from the one parsed. A project without Git is built whole at init and not
// brought up to date by start. Files are parsed and written in batches inside one transaction, so a
// build that fails leaves the graph as it was, and memory holds one batch, not the project.
import fsp from "node:fs/promises";
import path from "node:path";

import { loadGrammars } from "./grammars.mjs";
import { extractFile } from "./extract.mjs";
import { clearGraph, graphState, removeFiles, saveState, storedFiles, writeFiles } from "./graphRecords.mjs";
import { blobIds, changedSince, hasGit, head, listFiles } from "./git.mjs";
import { grammarOf, languageOf } from "./languages.mjs";
import { createResolver } from "./resolve.mjs";
import { graphScope } from "./scope.mjs";

const BATCH = 200;
const PARALLEL = 8;
const pathspecs = (folders) => folders.map((folder) => folder || ".");

// Without Git: the scope's files as Vite's dependency scan globs them (tinyglobby, never node_modules,
// no folder that starts with a dot).
async function filesWithoutGit(root, folders) {
  const { glob } = await import("tinyglobby");
  const found = [];
  for (const folder of folders) {
    const listed = await glob(["**/*"], { cwd: path.join(root, folder), ignore: ["**/node_modules/**"], onlyFiles: true, dot: false });
    for (const file of listed) found.push(folder ? folder + "/" + file : file);
  }
  return found;
}

// Each file: read, parse with its language's rules, its imports resolved. `ready` holds the languages
// whose parser loaded; another language's file is recorded as no_parser, with nothing taken from it.
async function parseFile({ root, file, language, oid, ready, napi, resolve }) {
  const base = { path: file, language, oid, package: null, parse_status: "no_parser", error_count: 0, definitions: [], references: [], imports: [] };
  if (!ready.has(grammarOf(language))) return base;
  const source = await fsp.readFile(path.join(root, file), "utf8").catch((error) => (error.code === "ENOENT" ? null : Promise.reject(error)));
  if (source === null) return null;
  const parsed = await extractFile(napi, language, source);
  const imports = [];
  for (const item of parsed.imports) imports.push({ ...item, ...(await resolve(file, language, item, parsed.package)) });
  return { ...base, ...parsed, parse_status: "parsed", imports };
}

async function parseBatch(batch, context) {
  const out = new Array(batch.length);
  let next = 0;
  const worker = async () => {
    while (next < batch.length) {
      const index = next++;
      out[index] = await parseFile({ ...context, ...batch[index] });
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, batch.length) }, worker));
  return out.filter(Boolean);
}

function tally(summary, files) {
  for (const file of files) {
    summary.files += 1;
    summary.definitions += file.definitions.length;
    summary.references += file.references.length;
    summary.imports += file.imports.length;
    if (file.error_count > 0 || file.parse_status !== "parsed") summary.incomplete.push({ path: file.path, parse_status: file.parse_status, error_count: file.error_count });
  }
}

async function parseAndWrite(tx, { projectId, root, folders, entries, dataHome, onProgress, napiModule, install }) {
  const languages = new Set(entries.map((entry) => grammarOf(entry.language)));
  const { ready, problems, napi } = await loadGrammars(dataHome, languages, {
    ...(install ? { install } : {}), ...(napiModule ? { napi: napiModule } : {}), onInstall: (spec) => onProgress({ phase: "installed", spec }),
  });
  const resolve = createResolver({ projectRoot: root, folders });
  const summary = { files: 0, definitions: 0, references: 0, imports: 0, incomplete: [], problems };
  for (let start = 0; start < entries.length; start += BATCH) {
    const files = await parseBatch(entries.slice(start, start + BATCH), { root, ready, napi, resolve });
    await writeFiles(tx, { projectId, files });
    tally(summary, files);
    onProgress({ phase: "parsed", done: Math.min(start + BATCH, entries.length), total: entries.length, definitions: summary.definitions });
  }
  return summary;
}

// init: the whole scope. `ensureProject(db)` records the project first (it is the work order feature's).
export async function buildGraph({ db, projectId, projectRoot, dataHome, ensureProject = async () => {}, onProgress = () => {}, napiModule = null, install = null }) {
  const root = path.resolve(projectRoot);
  const { folders } = await graphScope(root);
  const git = hasGit(root);
  const listed = git ? listFiles(root, pathspecs(folders)) : await filesWithoutGit(root, folders);
  const supported = listed.map((file) => ({ file, language: languageOf(file) })).filter((entry) => entry.language);
  const ids = git ? blobIds(root, supported.map((entry) => entry.file)) : [];
  const entries = supported.map((entry, index) => ({ ...entry, oid: ids[index] ?? null }));
  onProgress({ phase: "found", total: entries.length, skipped: listed.length - entries.length, folders });
  const commit = git ? head(root) : null;
  await ensureProject(db);
  const summary = await db.transaction(async (tx) => {
    await clearGraph(tx, { projectId });
    const done = await parseAndWrite(tx, { projectId, root, folders, entries, dataHome, onProgress, napiModule, install });
    await saveState(tx, { projectId, scope: folders, gitCommit: commit, full: true });
    return done;
  });
  return { ...summary, folders, git, skipped: listed.length - entries.length };
}

// start: only what changed. Returns why nothing was done, or what was parsed and removed.
export async function updateGraph({ db, projectId, projectRoot, dataHome, onProgress = () => {}, napiModule = null, install = null }) {
  const root = path.resolve(projectRoot);
  const state = await graphState(db, { projectId });
  if (!state) return { updated: false, reason: "no_graph" };
  if (!hasGit(root)) return { updated: false, reason: "no_git" };
  const folders = state.scope;
  const commit = head(root);
  const candidates = (state.git_commit ? changedSince(root, state.git_commit, pathspecs(folders)) : listFiles(root, pathspecs(folders)))
    .filter((file) => languageOf(file));
  const present = [];
  const gone = [];
  for (const file of candidates) ((await fsp.stat(path.join(root, file)).then((stat) => stat.isFile(), () => false)) ? present : gone).push(file);
  const stored = await storedFiles(db, { projectId, paths: candidates });
  const ids = blobIds(root, present);
  const entries = present.map((file, index) => ({ file, language: languageOf(file), oid: ids[index] })).filter((entry) => stored.get(entry.file) !== entry.oid);
  const removed = gone.filter((file) => stored.has(file));
  const summary = await db.transaction(async (tx) => {
    const done = entries.length ? await parseAndWrite(tx, { projectId, root, folders, entries, dataHome, onProgress, napiModule, install }) : { files: 0, definitions: 0, references: 0, imports: 0, incomplete: [], problems: {} };
    await removeFiles(tx, { projectId, paths: removed });
    await saveState(tx, { projectId, scope: folders, gitCommit: commit, full: false });
    return done;
  });
  return { updated: true, candidates: candidates.length, parsed: summary.files, removed: removed.length, ...summary };
}
