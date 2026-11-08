-- A run whose project graph could not be brought up to date before the writer's first call records it
-- (graph_update), so its result says beside the verdicts that the reviewer asked the graph as it was. The
-- event list is 20261027135039_rename.sql's with this one type added; nothing else changes.
alter table run_events drop constraint run_events_type_check;
alter table run_events add constraint run_events_type_check check (type in (
  'run_started', 'state_recorded', 'run_terminal', 'contract_sealed', 'session_rotated', 'iteration_incremented',
  'run_delivered', 'budget_extended',
  'task.input', 'handoff', 'read', 'usage', 'stop', 'writer.result', 'review.input', 'review.result', 'recheck',
  'test_result', 'fix.input', 'contract.translation', 'contract.check', 'contract.sealed', 'acceptance',
  'notified', 'delivery_skipped', 'graph_update'));