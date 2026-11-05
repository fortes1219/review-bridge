-- Indexes for the reads moved to the database in RC3-BLOCKER-01 step 4: a work order's running runs
-- (a start replaces them), and a project's ended runs that have no delivery yet (delivered before a
-- prune). Each read is proportional to what it returns, never to a project's history.

create index runs_active_by_work_order on runs (work_order_id)
  where status in ('running', 'review_pending', 'correction_pending', 'interrupted');
create index runs_undelivered on runs (project_id, closed_at)
  where outcome is null and closed_at is not null;
