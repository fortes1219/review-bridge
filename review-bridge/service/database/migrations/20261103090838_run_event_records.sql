-- The database is a run's one record; its run.json and event files are the copy (DECISIONS
-- 2026-11-03, B). Every event keeps the line its event file holds, sequence included, as the
-- database numbered it: a state event's line (substantive, details, the run as it left it) and an
-- I/O event's line alike. A file behind the database takes the lines after its last one; a missing
-- or broken file is written again from all of them. The promise is the same value, not the same
-- bytes: the line and its rebuild are both written with sorted keys.
-- Events written before this have no record; a run recorded then is left to its files.
alter table run_events add column record jsonb check (record is null or jsonb_typeof(record) = 'object');
-- From now on every event has one (not checked on the rows written before).
alter table run_events add constraint run_events_record_kept check (record is not null) not valid;
