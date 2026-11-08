-- Work orders turned into contracts before any run exists (workOrder owns these; RC3-ASK-01). The first
-- yes pays for this; the second, to the sealed card, opens the runs. There is one row per version a yes
-- paid for, so a contract a person has not yet said yes to, and the questions on the way to it, have a
-- place that is not a run's. No other tool keeps this: the nearest is Terraform's saved plan file.

create table contract_gatherings (
  plan_sha256      text primary key references plans,
  yes_plan_sha256  text not null references plans,   -- the card whose yes pays for it; answers keep that yes
  work_order_id    uuid not null,
  content_sha256   text not null,
  settings_sha256  text not null check (settings_sha256 ~ '^[0-9a-f]{64}$'),  -- what besides the text decides the contract
  authorized_by    text not null,                    -- the OS user
  authorized_via   text not null check (authorized_via in ('terminal', 'agent')),
  authorized_at    timestamptz not null,
  created_at       timestamptz not null,
  status           text not null check (status in ('translating', 'asking', 'sealed', 'stopped')),
  contract_sha256  text,
  outcome          jsonb,                            -- the questions asked, or why it stopped
  events_taken_at  timestamptz,                      -- the first run on this contract took its events
  check ((status = 'sealed') = (contract_sha256 is not null)),
  foreign key (work_order_id, content_sha256) references work_order_versions
);
-- A contract already sealed for this text under these settings, so a new start does not pay for it again.
create index contract_gatherings_sealed on contract_gatherings (work_order_id, content_sha256, settings_sha256, created_at desc) where status = 'sealed';
-- This work order's latest, for --answer.
create index contract_gatherings_by_order on contract_gatherings (work_order_id, created_at desc);

-- What each step left: the same events a run records, kept until a run takes them.
create table contract_gathering_events (
  plan_sha256  text not null references contract_gatherings on delete cascade,
  sequence     int  not null,
  occurred_at  timestamptz not null,
  event        jsonb not null check (jsonb_typeof(event) = 'object'),
  primary key (plan_sha256, sequence)
);
