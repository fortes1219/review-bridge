-- The contract is cut by code when the plan is made (Owner 2026-11-08): no model turns a work order into a
-- contract, so nothing is gathered before a run, and the two tables 2026-11-06-1000 made have nothing to
-- hold. They are dropped forward, as a migration tool drops what an applied migration made (Flyway, Knex);
-- 2026-11-06-1000 stays in the history unchanged. The events go first: they reference the gatherings.
drop table contract_gathering_events;
drop table contract_gatherings;
-- A condition no longer leans on the tests by itself (Owner 2026-11-08, choice A): code cuts the conditions
-- and cannot tell which ones the tests show, so a row of acceptance_rows has no test of its own. The column
-- and its checks go with it.
alter table acceptance_rows drop column test;
