// The graph's rows (migration 2026-11-09-1000-project-graph.sql). Every query here is one statement
// whose cost follows what it is asked, never the project's size: each reads through the index named
// beside it, takes a page (`limit`, keyset `after`), and none counts or reads a whole project. The
// EXPLAIN of each is in tests/graph-records.test.mjs.
//
//   who asks            question                                   query               index
//   start               which of these files changed since parsed  storedFiles         graph_files (project_id, path) unique
//   writer              where is NAME defined                      definitions         graph_definitions_by_name
//   writer              who refers to NAME                         references          graph_references_by_name
//   writer, reviewer    who imports this file (or its folder)      importers           graph_imports_by_target
//   writer, reviewer    what this file defines and imports         outline             unique (project_id, path); *_by_file
//   reviewer            what the changed lines define, who refers  touched, referrers  *_by_file; graph_references_by_name
//   init, MCP state     which files the graph cannot vouch for     incompleteFiles     graph_files_incomplete (partial)

export const PAGE = 50;
const clampLimit = (limit) => Math.max(1, Math.min(Number(limit) || PAGE, 200));

export async function graphState(db, { projectId }) {
  const { rows } = await db.query("select scope, git_commit, built_at, updated_at from graph_states where project_id = $1", [projectId]);
  return rows[0] ?? null;
}

export async function storedFiles(db, { projectId, paths }) {
  if (!paths.length) return new Map();
  const { rows } = await db.query("select path, oid from graph_files where project_id = $1 and path = any($2::text[])", [projectId, paths]);
  return new Map(rows.map((row) => [row.path, row.oid]));
}

export async function incompleteFiles(db, { projectId, after = "", limit = PAGE }) {
  const { rows } = await db.query(
    "select path, parse_status, error_count from graph_files"
    + " where project_id = $1 and (error_count > 0 or parse_status <> 'parsed') and path > $2 order by path limit $3",
    [projectId, after, clampLimit(limit)],
  );
  return rows;
}

// `after` is the last row of the previous page: { file_id, line }.
export async function definitions(db, { projectId, name, after = null, limit = PAGE }) {
  const { rows } = await db.query(
    "select d.file_id, f.path, d.kind, d.start_line, d.end_line from graph_definitions d join graph_files f on f.file_id = d.file_id"
    + " where d.project_id = $1 and d.name = $2 and (d.file_id, d.start_line) > ($3, $4) order by d.file_id, d.start_line limit $5",
    [projectId, name, after?.file_id ?? 0, after?.line ?? 0, clampLimit(limit)],
  );
  return rows;
}

export async function references(db, { projectId, name, after = null, limit = PAGE }) {
  const { rows } = await db.query(
    "select r.file_id, f.path, r.kind, r.line from graph_references r join graph_files f on f.file_id = r.file_id"
    + " where r.project_id = $1 and r.name = $2 and (r.file_id, r.line) > ($3, $4) order by r.file_id, r.line limit $5",
    [projectId, name, after?.file_id ?? 0, after?.line ?? 0, clampLimit(limit)],
  );
  return rows;
}

// `targets` are the file's path and, for a Go package or a Java wildcard, its folder.
export async function importers(db, { projectId, targets, after = null, limit = PAGE }) {
  const { rows } = await db.query(
    "select i.file_id, f.path, i.line, i.specifier, i.target_path from graph_imports i join graph_files f on f.file_id = i.file_id"
    + " where i.project_id = $1 and i.target_path = any($2::text[]) and (i.file_id, i.line) > ($3, $4) order by i.file_id, i.line limit $5",
    [projectId, targets, after?.file_id ?? 0, after?.line ?? 0, clampLimit(limit)],
  );
  return rows;
}

export async function outline(db, { projectId, path, limit = 200 }) {
  const file = (await db.query(
    "select file_id, path, language, package, parse_status, error_count from graph_files where project_id = $1 and path = $2",
    [projectId, path],
  )).rows[0];
  if (!file) return null;
  const capped = Math.max(1, Math.min(Number(limit) || 200, 500));
  const defined = (await db.query("select name, kind, start_line, end_line from graph_definitions where file_id = $1 order by start_line limit $2", [file.file_id, capped])).rows;
  const imported = (await db.query("select specifier, line, status, target_path, target_kind from graph_imports where file_id = $1 order by line limit $2", [file.file_id, capped])).rows;
  return { ...file, definitions: defined, imports: imported };
}

// The definitions the changed lines fall in: `changes` is [{ path, start_line, end_line }].
export async function touched(db, { projectId, changes, limit = PAGE }) {
  if (!changes.length) return [];
  const { rows } = await db.query(
    "select c.path, d.name, d.kind, d.start_line, d.end_line"
    + " from unnest($2::text[], $3::int[], $4::int[]) as c(path, start_line, end_line)"
    + " join graph_files f on f.project_id = $1 and f.path = c.path"
    + " join graph_definitions d on d.file_id = f.file_id and d.start_line <= c.end_line and d.end_line >= c.start_line"
    + " order by c.path, d.start_line limit $5",
    [projectId, changes.map((item) => item.path), changes.map((item) => item.start_line), changes.map((item) => item.end_line), clampLimit(limit)],
  );
  return rows;
}

// For each name, its first `perName` references: one statement, names × perName rows at most.
export async function referrers(db, { projectId, names, perName = 10 }) {
  if (!names.length) return [];
  const { rows } = await db.query(
    "select n.name, f.path, r.line, r.kind from unnest($2::text[]) as n(name)"
    + " cross join lateral (select file_id, line, kind from graph_references where project_id = $1 and name = n.name order by file_id, line limit $3) r"
    + " join graph_files f on f.file_id = r.file_id order by n.name, r.file_id, r.line",
    [projectId, names, Math.max(1, Math.min(Number(perName) || 10, 50))],
  );
  return rows;
}

// Writes. `files` are parsed files: { path, language, oid, package, parse_status, error_count,
// definitions, references, imports (each with status, target_path, target_kind) }. A file's earlier rows
// go and its new ones come in the same transaction; rows of files not named are untouched.
export async function writeFiles(tx, { projectId, files }) {
  if (!files.length) return;
  const column = (key) => files.map((file) => file[key] ?? null);
  const { rows } = await tx.query(
    "insert into graph_files (project_id, path, language, oid, package, parse_status, error_count, parsed_at)"
    + " select $1, u.path, u.language, u.oid, u.package, u.parse_status, u.error_count, now()"
    + " from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[]) as u(path, language, oid, package, parse_status, error_count)"
    + " on conflict (project_id, path) do update set language = excluded.language, oid = excluded.oid, package = excluded.package,"
    + " parse_status = excluded.parse_status, error_count = excluded.error_count, parsed_at = excluded.parsed_at"
    + " returning file_id, path",
    [projectId, column("path"), column("language"), column("oid"), column("package"), column("parse_status"), column("error_count")],
  );
  const ids = new Map(rows.map((row) => [row.path, row.file_id]));
  const fileIds = [...ids.values()];
  for (const table of ["graph_definitions", "graph_references", "graph_imports"]) {
    await tx.query("delete from " + table + " where file_id = any($1::bigint[])", [fileIds]);
  }
  const flat = (key) => files.flatMap((file) => (file[key] ?? []).map((item) => ({ ...item, file_id: ids.get(file.path) })));
  const definitionRows = flat("definitions");
  if (definitionRows.length) {
    await tx.query(
      "insert into graph_definitions (file_id, project_id, name, kind, start_line, end_line)"
      + " select u.file_id, $1, u.name, u.kind, u.start_line, u.end_line from unnest($2::bigint[], $3::text[], $4::text[], $5::int[], $6::int[]) as u(file_id, name, kind, start_line, end_line)",
      [projectId, definitionRows.map((row) => row.file_id), definitionRows.map((row) => row.name), definitionRows.map((row) => row.kind), definitionRows.map((row) => row.start_line), definitionRows.map((row) => row.end_line)],
    );
  }
  const referenceRows = flat("references");
  if (referenceRows.length) {
    await tx.query(
      "insert into graph_references (file_id, project_id, name, kind, line)"
      + " select u.file_id, $1, u.name, u.kind, u.line from unnest($2::bigint[], $3::text[], $4::text[], $5::int[]) as u(file_id, name, kind, line)",
      [projectId, referenceRows.map((row) => row.file_id), referenceRows.map((row) => row.name), referenceRows.map((row) => row.kind), referenceRows.map((row) => row.line)],
    );
  }
  const importRows = flat("imports");
  if (importRows.length) {
    await tx.query(
      "insert into graph_imports (file_id, project_id, specifier, line, status, target_path, target_kind)"
      + " select u.file_id, $1, u.specifier, u.line, u.status, u.target_path, u.target_kind"
      + " from unnest($2::bigint[], $3::text[], $4::int[], $5::text[], $6::text[], $7::text[]) as u(file_id, specifier, line, status, target_path, target_kind)",
      [projectId, importRows.map((row) => row.file_id), importRows.map((row) => row.specifier), importRows.map((row) => row.line), importRows.map((row) => row.status),
        importRows.map((row) => row.target_path ?? null), importRows.map((row) => row.target_kind ?? null)],
    );
  }
}

// Files that are gone, or left the scope; their rows go with them (on delete cascade).
export async function removeFiles(tx, { projectId, paths }) {
  if (!paths.length) return 0;
  return (await tx.query("delete from graph_files where project_id = $1 and path = any($2::text[])", [projectId, paths])).rowCount;
}

// init builds the graph whole: the project's earlier rows go first.
export async function clearGraph(tx, { projectId }) {
  await tx.query("delete from graph_files where project_id = $1", [projectId]);
  await tx.query("delete from graph_states where project_id = $1", [projectId]);
}

export async function saveState(tx, { projectId, scope, gitCommit, full }) {
  await tx.query(
    "insert into graph_states (project_id, scope, git_commit, built_at, updated_at) values ($1, $2, $3, now(), now())"
    + " on conflict (project_id) do update set scope = excluded.scope, git_commit = excluded.git_commit, updated_at = excluded.updated_at"
    + (full ? ", built_at = excluded.built_at" : ""),
    [projectId, scope, gitCommit],
  );
}
