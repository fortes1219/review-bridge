-- Work orders, their versions and the plans (cards) made from them (workOrder owns these).
-- The work order's identity is work_order_id, made here; file names are hints, never identity.

create table work_orders (
  work_order_id     uuid primary key,
  project_id        uuid not null references projects,
  last_file_name    text not null,           -- the file in .review-bridge/work-packages/ at the last start
  created_at        timestamptz not null,
  last_activity_at  timestamptz not null     -- set with a new version, a run start or a run end
);
create index work_orders_by_activity on work_orders (last_activity_at desc, work_order_id desc);
create index work_orders_by_project on work_orders (project_id, last_activity_at desc, work_order_id desc);
create index work_orders_by_file on work_orders (project_id, last_file_name, last_activity_at desc);

-- The requirement as the person wrote it, one row per version; settings live in the plan.
create table work_order_versions (
  work_order_id   uuid not null references work_orders,
  content_sha256  text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),  -- sha of source_text
  version_no      int  not null check (version_no >= 1),
  title           text not null,
  source_text     text not null,             -- the trimmed text the card showed line by line
  source_file     text not null,             -- where it was read then; a record, never identity
  sealed_at       timestamptz not null,
  primary key (work_order_id, content_sha256),
  unique (work_order_id, version_no)
);
create index work_order_versions_by_order on work_order_versions (work_order_id, version_no desc);

-- One plan is one card. Its decision (update this work order, or a new one) takes effect only when
-- the person says yes, so a plan points at no version.
create table plans (
  plan_sha256               text primary key check (plan_sha256 ~ '^[0-9a-f]{64}$'),
  project_id                uuid not null references projects,
  work_order_id             uuid references work_orders,   -- null: a new work order
  content_sha256            text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  source_file               text not null,
  proposed_run_id           uuid not null unique,
  effective_policy_sha256   text not null references policy_snapshots,
  repo_root                 text not null,                 -- where the work runs then; a record
  authorization_expires_at  timestamptz not null,          -- the card's "Valid until"
  body                      jsonb not null check (jsonb_typeof(body) = 'object'),
  created_at                timestamptz not null,
  shown_at                  timestamptz,                   -- the card was printed and waits for a yes
  withdrawn_at              timestamptz,                   -- never shown (the reviewer check refused) or answered no
  check (withdrawn_at is null or shown_at is null or withdrawn_at >= shown_at)
);
create index plans_shown_by_file on plans (project_id, source_file, shown_at desc) where shown_at is not null and withdrawn_at is null;
create index plans_by_work_order on plans (work_order_id) where work_order_id is not null;
