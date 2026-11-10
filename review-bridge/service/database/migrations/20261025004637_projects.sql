-- Projects and the policy snapshots plans are made under (workOrder owns both: features do not import
-- each other, and only work orders use them so far).
-- One database per person, shared by all their projects: a project is a column, never a partition.

create table projects (
  project_id        uuid primary key,          -- made by init, written to the project's bridge.json
  root_path         text not null,             -- where it was last seen; a record, never identity
  name              text not null,             -- the folder name, for lists
  created_at        timestamptz not null,
  last_activity_at  timestamptz not null,
  cleared_at        timestamptz                -- clean --project: its rows are gone, the id is not used again
);
create index projects_by_activity on projects (last_activity_at desc, project_id desc) where cleared_at is null;

create table policy_snapshots (
  effective_policy_sha256        text primary key check (effective_policy_sha256 ~ '^[0-9a-f]{64}$'),
  policy_schema_version          int  not null,
  package_default_policy_sha256  text not null check (package_default_policy_sha256 ~ '^[0-9a-f]{64}$'),
  project_override_sha256        text check (project_override_sha256 ~ '^[0-9a-f]{64}$'),
  policy                         jsonb not null check (jsonb_typeof(policy) = 'object'),
  created_at                     timestamptz not null
);
