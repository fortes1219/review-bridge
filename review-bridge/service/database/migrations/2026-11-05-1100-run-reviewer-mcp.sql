-- The MCP servers a run's reviewer was given, on the run's row beside its other role columns. Empty: it
-- was given none. Null: the run is older than this; older runs are not filled in. Read with the row by
-- its primary key, so no index.
alter table runs add column reviewer_mcp text[];
