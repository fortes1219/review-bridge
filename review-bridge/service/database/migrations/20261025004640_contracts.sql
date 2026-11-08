-- Sealed contracts (workOrder owns this). canonical_text is exactly the text the SHA-256 is over;
-- jsonb would reorder keys and rewrite numbers, so the hash could not be recomputed from it.
-- One contract can come from more than one work order version (a copy with the same text, another
-- project), so a row is the contract as one version's: the SHA-256 alone names the contract.

create table contracts (
  contract_sha256  text not null check (contract_sha256 ~ '^[0-9a-f]{64}$'),
  work_order_id    uuid not null,
  content_sha256   text not null,
  canonical_text   text not null,
  sealed_at        timestamptz not null,
  primary key (contract_sha256, work_order_id, content_sha256),
  foreign key (work_order_id, content_sha256) references work_order_versions
);
create index contracts_by_version on contracts (work_order_id, content_sha256);
