-- The source_id a version's frontmatter carries (the ticket it came from), on the version's row, so
-- `logs <source_id>` finds the work orders that carry it through an index instead of reading every
-- version's text. Written with the version from then on. Versions sealed before this keep null: the
-- value lives in YAML that SQL cannot read faithfully, and a guess would be worse than no answer.
alter table work_order_versions add column source_id text;
create index work_order_versions_by_source_id on work_order_versions (source_id) where source_id is not null;
