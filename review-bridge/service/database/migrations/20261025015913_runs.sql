-- Runs, their one ordered timeline, and the facts a run's judgement rests on (records owns these;
-- RC3-BLOCKER-01 step 3). A run's state columns change only in the transaction that appends the
-- event that changes them. Everything a run owns goes with it (on delete cascade): clean <run_id>
-- is one delete.

create table runs (
  run_id                   uuid primary key,
  project_id               uuid not null references projects,
  work_order_id            uuid not null references work_orders,
  content_sha256           text not null,
  plan_sha256              text not null unique references plans,
  effective_policy_sha256  text not null references policy_snapshots,
  contract_sha256          text check (contract_sha256 ~ '^[0-9a-f]{64}$'),   -- set once, when sealed
  repo_root                text not null,
  authorized_by            text not null,
  execution_mode           text not null check (execution_mode in ('native', 'fake_cli')),
  budget                   jsonb not null check (jsonb_typeof(budget) = 'object'),
  created_at               timestamptz not null,
  status                   text not null check (status in (
    'running', 'review_pending', 'correction_pending', 'interrupted',
    'pass', 'hard_stop', 'rate_limited', 'cancelled', 'policy_failure',
    'call_budget_exhausted', 'claude_timeout', 'claude_failed', 'reviewer_failed', 'controller_failure',
    'token_limit', 'stopped', 'reference_changed', 'contract_rejected', 'contract_changed', 'contract_unconfirmed',
    'usage_unknown', 'acceptance_unverified', 'start_point_lost', 'evidence_changed', 'version_changed',
    'evidence_unconfirmable', 'scope_unverified', 'needs_human', 'malformed_writer_result', 'malformed_review_result')),
  last_event_sequence      int  not null check (last_event_sequence >= 0),
  closed_reason            text,
  closed_at                timestamptz,
  superseded_by            uuid references runs on delete set null,
  outcome                  text check (outcome in ('delivered', 'needs_fix', 'needs_human', 'token_limit', 'quota', 'stopped', 'cancelled', 'error')),
  run_deadline_at          timestamptz,
  updated_at               timestamptz not null,
  foreign key (work_order_id, content_sha256) references work_order_versions
);
create index runs_by_work_order on runs (work_order_id, created_at desc, run_id desc);
create index runs_by_project on runs (project_id, created_at desc, run_id desc);
create index runs_active on runs (project_id, created_at) where status in ('running', 'review_pending', 'correction_pending', 'interrupted');

-- The state events (run_started, state_recorded, run_terminal, ...) and the I/O events (task.input,
-- review.result, ...) of one run, in one sequence. For the types with a table of their own below,
-- the fields that table holds are there and only the rest stays in payload: each field in one place.
create table run_events (
  run_id       uuid not null references runs on delete cascade,
  sequence     int  not null check (sequence >= 1),
  type         text not null check (type in (
    'run_started', 'state_recorded', 'run_terminal', 'contract_sealed', 'session_rotated', 'iteration_incremented',
    'run_delivered', 'budget_extended',
    'task.input', 'handoff', 'read', 'usage', 'stop', 'writer.result', 'review.input', 'review.result', 'recheck',
    'gate_a_result', 'fix.input', 'contract.translation', 'contract.check', 'contract.sealed', 'acceptance',
    'notified', 'delivery_skipped')),
  occurred_at  timestamptz not null,
  payload      jsonb check (payload is null or jsonb_typeof(payload) = 'object'),
  primary key (run_id, sequence)
);
create index run_events_usage_by_time on run_events (occurred_at) where type = 'usage';

create table gate_a_results (
  run_id        uuid not null,
  sequence      int  not null,
  call          int,
  kind          text not null check (kind in ('command', 'not_applicable')),
  command       text,
  passed        boolean,                       -- null when not applicable
  exit_code     int,
  timed_out     boolean,
  duration_ms   bigint,
  work_version  jsonb,                         -- the version sample Gate A ran on
  stdout_tail   text,
  stderr_tail   text,
  primary key (run_id, sequence),
  foreign key (run_id, sequence) references run_events on delete cascade,
  check (kind = 'not_applicable' or passed is not null)
);

create table review_results (
  run_id            uuid not null,
  sequence          int  not null,
  call              int,
  gate              text check (gate in ('PASS', 'FAIL')),
  hard_stop         boolean,
  hard_stop_reason  text,
  verified          jsonb,
  not_run           jsonb,
  source            text,                      -- 'controller' when Bridge decided, else the reviewer
  primary key (run_id, sequence),
  foreign key (run_id, sequence) references run_events on delete cascade
);
create table review_verdicts (
  run_id    uuid not null,
  sequence  int  not null,
  ac_id     text not null,
  verdict   text not null check (verdict in ('pass', 'fail', 'cannot_verify')),
  evidence  text,
  primary key (run_id, sequence, ac_id),
  foreign key (run_id, sequence) references review_results on delete cascade
);
create table review_findings (
  run_id          uuid not null,
  sequence        int  not null,
  finding_id      text not null,
  severity        text,
  path            text,
  line            int,
  reach           text,
  claim           text,
  evidence        text,
  fix             text,
  acceptance_ref  text,
  source          text,                      -- 'controller' for a finding Bridge raised itself
  primary key (run_id, sequence, finding_id),
  foreign key (run_id, sequence) references review_results on delete cascade
);

-- Bridge's own decision per check round, one row per acceptance condition.
create table acceptance_decisions (
  run_id          uuid not null,
  sequence        int  not null,
  call            int,
  decision        text not null check (decision in ('proven', 'failed', 'unknown')),
  review_version  jsonb,
  primary key (run_id, sequence),
  foreign key (run_id, sequence) references run_events on delete cascade
);
create table acceptance_rows (
  run_id     uuid not null,
  sequence   int  not null,
  ac_id      text not null,
  statement  text,
  writer     text,
  verdict    text,
  gate_a     text not null check (gate_a in ('passed', 'failed', 'not_run', 'not_used')),
  result     text not null check (result in ('proven', 'failed', 'unknown')),
  evidence   text,
  primary key (run_id, sequence, ac_id),
  foreign key (run_id, sequence) references acceptance_decisions on delete cascade
);

-- authorization_claims.run_id stays without a foreign key: clean <run_id> removes the run but keeps
-- its authorization and claim, so that card can never take another yes.
