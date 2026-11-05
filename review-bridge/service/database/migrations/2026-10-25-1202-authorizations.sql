-- Authorizations and their single-use claims (workOrder owns these).

create table authorizations (
  authorization_id      text primary key,
  kind                  text not null check (kind in ('start', 'budget_extension', 'rollback')),
  plan_sha256           text references plans,
  run_id                uuid,                 -- budget_extension / rollback only
  authorized_by         text not null,        -- the OS user
  authorized_via        text check (authorized_via in ('terminal', 'agent')),
  authorized_at         timestamptz not null,
  expires_at            timestamptz not null,
  authorization_sha256  text not null check (authorization_sha256 ~ '^[0-9a-f]{64}$'),
  body                  jsonb not null check (jsonb_typeof(body) = 'object'),
  -- A start is the yes to one card, carried at a terminal or by an agent. The work order's SHA-256 it
  -- authorized is that plan's content_sha256; it is not stored twice.
  check (kind <> 'start' or (plan_sha256 is not null and authorized_via is not null))
);
create index authorizations_by_plan on authorizations (plan_sha256) where plan_sha256 is not null;

-- Existence is the single-use guard: a second yes to one card collides on the key and rolls back.
create table authorization_claims (
  claim_key         text primary key,         -- plan-<plan_sha256> for a start
  authorization_id  text not null references authorizations,
  run_id            uuid not null,            -- references runs once runs move here
  claim_kind        text not null,
  claimed_at        timestamptz not null
);
