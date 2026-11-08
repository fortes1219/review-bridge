-- Change types are gone: the test step runs the project's tests whenever its rules give a command,
-- and a project without one records not_configured instead of the docs-only not_applicable. Rows
-- written before keep their meaning under the new name.
alter table test_results drop constraint test_results_kind_check;
alter table test_results drop constraint test_results_check;
update test_results set kind = 'not_configured' where kind = 'not_applicable';
alter table test_results add constraint test_results_kind_check check (kind in ('command', 'not_configured'));
alter table test_results add constraint test_results_check check (kind = 'not_configured' or passed is not null);

-- A run's own time limit (run_timeout), counted from its start: the moment it is closed as timed out.
-- Null for a run started before the limit existed. run_deadline_at stays the recovery deadline.
alter table runs add column timeout_at timestamptz;
