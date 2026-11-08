-- Who filled each role in a run, with which model and how hard, on the run's row (RC3-BLOCKER-02), so
-- a person can ask the database without opening a plan. Read with the row by its primary key, so no
-- index. provider null: the run is older than this. model null with a provider: the CLI's default.
-- Older runs are not filled in (the card: development data is not converted).
alter table runs
  add column writer_provider text,
  add column writer_model text,
  add column writer_effort text,
  add column reviewer_provider text,
  add column reviewer_model text,
  add column reviewer_effort text;
