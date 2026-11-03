-- A run's tokens so far, kept on its row the way Rails keeps a counter cache: each usage event adds
-- its tokens in the same transaction that writes it, so the budget check reads one number by primary
-- key and never sums the run's usage events (RC3-FIX-01). The count is the one tokenTotal makes:
-- input, cache_write, cache_read and output, each only when it is a number.
alter table runs add column tokens_used bigint not null default 0 check (tokens_used >= 0);

-- Runs recorded before this: their usage events summed once, here.
update runs r set tokens_used = u.total
from (
  select e.run_id, sum(
    coalesce(case when jsonb_typeof(e.payload->'tokens'->'input') = 'number' then (e.payload->'tokens'->>'input')::numeric end, 0)
    + coalesce(case when jsonb_typeof(e.payload->'tokens'->'cache_write') = 'number' then (e.payload->'tokens'->>'cache_write')::numeric end, 0)
    + coalesce(case when jsonb_typeof(e.payload->'tokens'->'cache_read') = 'number' then (e.payload->'tokens'->>'cache_read')::numeric end, 0)
    + coalesce(case when jsonb_typeof(e.payload->'tokens'->'output') = 'number' then (e.payload->'tokens'->>'output')::numeric end, 0)
  ) as total
  from run_events e
  where e.type = 'usage'
  group by e.run_id
) u
where u.run_id = r.run_id;
