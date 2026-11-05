-- Names only, behaviour unchanged. A run's state is a status and a conclusion, as GitHub Actions has
-- them for a workflow run, with closed_reason saying why it closed; role names replace provider
-- names; the one test step is "test"; limits carry no unit in their names and time is milliseconds.
-- Rows written before keep their meaning: each old status becomes a status, a conclusion and (when
-- the run had none) a closed reason. Plans and policy snapshots are content-addressed and are not
-- rewritten; the runtime refuses the older ones where it reads them.

-- runs: status + conclusion + closed_reason.
alter table runs add column conclusion text;
alter table runs drop constraint runs_status_check;

update runs set closed_reason = case closed_reason
  when 'call_budget_exhausted' then 'rounds_exhausted'
  when 'claude_timeout' then 'writer_timeout'
  when 'claude_failed' then 'writer_failed'
  else closed_reason end;

update runs set
  closed_reason = coalesce(closed_reason, case status
    when 'call_budget_exhausted' then 'rounds_exhausted'
    when 'claude_timeout' then 'writer_timeout'
    when 'claude_failed' then 'writer_failed'
    else status end),
  conclusion = case
    when status = 'pass' then 'success'
    when status in ('stopped', 'cancelled') then 'cancelled'
    when status = 'claude_timeout' then 'timed_out'
    when status in ('hard_stop', 'needs_human', 'call_budget_exhausted', 'contract_unconfirmed', 'acceptance_unverified',
      'start_point_lost', 'evidence_changed', 'version_changed', 'evidence_unconfirmable', 'scope_unverified') then 'action_required'
    else 'failure' end,
  status = 'completed'
where status not in ('running', 'review_pending', 'correction_pending', 'interrupted');

update runs set status = 'in_progress' where status in ('running', 'review_pending', 'correction_pending', 'interrupted');

alter table runs add constraint runs_status_check check (status in ('in_progress', 'completed'));
alter table runs add constraint runs_conclusion_check
  check (conclusion is null or conclusion in ('success', 'failure', 'cancelled', 'timed_out', 'action_required'));
alter table runs add constraint runs_completed_check
  check (status <> 'completed' or (conclusion is not null and closed_reason is not null));
-- The one fact the outcome carried that is still needed: whether the run was delivered. Now the time
-- its run_delivered event was written, null while it is not.
alter table runs add column delivered_at timestamptz;
update runs set delivered_at = coalesce(
  (select min(e.occurred_at) from run_events e where e.run_id = runs.run_id and e.type = 'run_delivered'), updated_at)
where outcome is not null;
drop index runs_undelivered;
alter table runs drop column outcome;

drop index runs_active;
create index runs_active on runs (project_id, created_at) where status = 'in_progress';

-- The run's budget: calls are rounds, the call timeout is in milliseconds.
update runs set budget = jsonb_strip_nulls(jsonb_build_object(
  'rounds', budget->'max_claude_calls',
  'call_timeout', to_jsonb((budget->>'max_claude_minutes_per_call')::int * 60000),
  'consumed_rounds', budget->'consumed_claude_calls'))
where budget ? 'max_claude_calls';

-- The test step.
alter table gate_a_results rename to test_results;
alter table test_results rename constraint gate_a_results_pkey to test_results_pkey;
alter table test_results rename constraint gate_a_results_check to test_results_check;
alter table test_results rename constraint gate_a_results_kind_check to test_results_kind_check;
alter table test_results rename constraint gate_a_results_kind_not_null to test_results_kind_not_null;
alter table test_results rename constraint gate_a_results_run_id_not_null to test_results_run_id_not_null;
alter table test_results rename constraint gate_a_results_sequence_not_null to test_results_sequence_not_null;
alter table test_results rename constraint gate_a_results_run_id_sequence_fkey to test_results_run_id_sequence_fkey;

alter table acceptance_rows rename column gate_a to test;
alter table acceptance_rows rename constraint acceptance_rows_gate_a_check to acceptance_rows_test_check;
alter table acceptance_rows rename constraint acceptance_rows_gate_a_not_null to acceptance_rows_test_not_null;

alter table run_events drop constraint run_events_type_check;
update run_events set type = 'test_result' where type = 'gate_a_result';
alter table run_events add constraint run_events_type_check check (type in (
  'run_started', 'state_recorded', 'run_terminal', 'contract_sealed', 'session_rotated', 'iteration_incremented',
  'run_delivered', 'budget_extended',
  'task.input', 'handoff', 'read', 'usage', 'stop', 'writer.result', 'review.input', 'review.result', 'recheck',
  'test_result', 'fix.input', 'contract.translation', 'contract.check', 'contract.sealed', 'acceptance',
  'notified', 'delivery_skipped'));

-- The two reads of 2026-10-25-1400-run-queries.sql, on the new status: a work order's running runs,
-- and a project's ended runs that have no delivery yet.
drop index runs_active_by_work_order;
create index runs_active_by_work_order on runs (work_order_id) where status = 'in_progress';
create index runs_undelivered on runs (project_id, closed_at) where status = 'completed' and delivered_at is null;
