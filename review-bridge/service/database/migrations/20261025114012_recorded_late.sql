-- An event written after the fact (kept beside the run's files while the database was gone, then
-- written by the next command that opened it) says so, so an audit can tell it from one written as
-- it happened. Its occurred_at is still when it happened.

alter table run_events add column recorded_late boolean not null default false;
