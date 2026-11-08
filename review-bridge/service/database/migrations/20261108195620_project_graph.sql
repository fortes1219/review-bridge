-- The shape of a project's code (T0-GRAPH-01): which file defines what, which names each file refers to,
-- and where each of its import strings leads. init builds it whole; start brings up to date only the files
-- Git says changed; Bridge's read-only MCP server answers the writer's and the reviewer's questions from it.
-- The rows are definitions and references in the tree-sitter tags sense (the tags.scm convention aider's
-- repo map uses), without its ranking. One set of rows per project; a project is a column, never a
-- partition. Every query the graph serves is listed in service/graph/graphRecords.mjs with its index.

-- One row per project that has a graph: where it was built and the Git commit it is up to date with.
create table graph_states (
  project_id   uuid primary key references projects,
  scope        text[] not null,          -- the folders graphed, relative to the project root ('' is the root)
  git_commit   text,                     -- HEAD when it was last brought up to date; null without Git or commits
  built_at     timestamptz not null,     -- the last full build (init)
  updated_at   timestamptz not null      -- the last build or update
);

-- One row per source file of a supported language in the scope.
create table graph_files (
  file_id       bigint generated always as identity primary key,
  project_id    uuid not null references projects,
  path          text not null,           -- relative to the project root, with '/'
  language      text not null,
  oid           text,                    -- Git's blob id of the content parsed; null without Git
  package       text,                    -- the package or namespace the file declares (Go, Java, Kotlin, C#)
  parse_status  text not null check (parse_status in ('parsed', 'no_parser')),
  error_count   int not null check (error_count >= 0),  -- ERROR and MISSING nodes; above 0 the file is incomplete
  parsed_at     timestamptz not null,
  unique (project_id, path)
);
-- The files the graph cannot vouch for, listed by init and by the MCP server's state.
create index graph_files_incomplete on graph_files (project_id, path) where error_count > 0 or parse_status <> 'parsed';

-- What a file defines: functions, classes, methods, interfaces, types, modules.
create table graph_definitions (
  file_id     bigint not null references graph_files on delete cascade,
  project_id  uuid not null,
  name        text not null,
  kind        text not null,
  start_line  int not null check (start_line >= 1),
  end_line    int not null check (end_line >= start_line)
);
create index graph_definitions_by_name on graph_definitions (project_id, name, file_id, start_line);
create index graph_definitions_by_file on graph_definitions (file_id, start_line);

-- The names a file refers to (calls, classes, types), by name: a name says nothing about which definition.
create table graph_references (
  file_id     bigint not null references graph_files on delete cascade,
  project_id  uuid not null,
  name        text not null,
  kind        text not null,
  line        int not null check (line >= 1)
);
create index graph_references_by_name on graph_references (project_id, name, file_id, line);
create index graph_references_by_file on graph_references (file_id);

-- Each import string and where it leads: a file or a directory in the project, a package outside it, or
-- nowhere Bridge can tell (the string is kept).
create table graph_imports (
  file_id      bigint not null references graph_files on delete cascade,
  project_id   uuid not null,
  specifier    text not null,
  line         int not null check (line >= 1),
  status       text not null check (status in ('resolved', 'external', 'unresolved')),
  target_path  text,                     -- relative to the project root; set only when resolved
  target_kind  text check (target_kind in ('file', 'directory')),
  check ((status = 'resolved') = (target_path is not null and target_kind is not null))
);
create index graph_imports_by_target on graph_imports (project_id, target_path, file_id, line) where target_path is not null;
create index graph_imports_by_file on graph_imports (file_id, line);
