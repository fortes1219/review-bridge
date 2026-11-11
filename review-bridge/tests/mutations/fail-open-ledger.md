# Fail-open ledger

Every time a guard let through what it should have stopped, or a test passed while the behaviour was
wrong, it is kept here: what was seen, how to make it happen again, why, the fix, the test that now
catches it, and the mutation case that proves that test can fail
(`node scripts/verify-gate-mutations.mjs --only <id>`). The entries are engineering records, not a
claim that nothing else is wrong.

## RB-GATE-2026-001 — `.review-bridge/` shows in Git when the project gets Git after init

- **affected_gate:** Install
- **symptom:** a project set up before `git init` lists `.review-bridge/` (settings, templates, later
  work orders and results) as untracked files; `git add .` commits them.
- **expected_vs_actual:** expected `git status` to show nothing of Bridge's at any time; actually it
  showed five files under `.review-bridge/` after `git init`.
- **reproduction:** Windows 11, Node 24.16, npm 11.13, Git 2.42: `npm create vite@latest app -- --template
  vue-ts`, `cd app`, `npm install`, `npx review-bridge init`, `git init`, `git status`. create-vite makes
  no repository, so this is the order a new Vite project is set up in.
- **root_cause:** init kept the folder out of Git only by a line in `.git/info/exclude`, written only when
  a repository was already there; nothing wrote it later.
- **fix:** `c2c9fe5` — the folder carries its own `.gitignore` with `*`, written first, as pytest's
  `.pytest_cache/`, ruff's `.ruff_cache/` and uv's `.venv/` do. No file of the person's is touched.
- **regression_test:** `tests/neutral-install.test.mjs` "a project set up without Git keeps .review-bridge/
  out of Git once the person runs git init"; "reinit: .review-bridge/ without its install record …".
- **mutation_case:** `RB-M-install-no-gitignore`, `RB-M-reinit-no-gitignore` (killed).
- **residual_risk:** none known for a fresh install.

## RB-GATE-2026-002 — every printed next command assumed a global install

- **affected_gate:** Install
- **symptom:** after `npx review-bridge init`, the "Now:" lines, `status`, every refusal's "Run: …", the
  two agent entries and the VS Code tasks all named `review-bridge …`, a command a person who used only
  npx does not have.
- **expected_vs_actual:** expected each printed line to run as typed; actually `review-bridge` was not
  found. It never showed on the machine that found it, because that machine had `npm link`ed the source.
- **reproduction:** a machine with no global `review-bridge`: `npx review-bridge init` in a new project,
  then type the line it prints after "at a terminal".
- **root_cause:** the lines were written as a global binary's name. create-vite and create-playwright
  print the package manager's own form instead.
- **fix:** the commit that adds this entry — one function (`review-bridge/utils/bridgeCommand.mjs`) prints
  the package manager's one-off form with no version, as create-vite reads `npm_config_user_agent`:
  `npx review-bridge` for npm and when none is named (a global install answers it too: libnpmexec runs the
  global bin first), `pnpm dlx`, `yarn dlx` (not Yarn 1), `bun x`. `npx`, not `npm exec`: `npm exec` would
  take `--yes` as its own flag. The language packs read it as `{bridge}`. Releases publish as `latest`, so
  a command with no version runs the release.
- **regression_test:** `review-bridge/tests/bridge-command.test.mjs` (the function, and "no shipped line
  tells the person to run a bare review-bridge command …", which reads every file npm ships); the agent
  entry assertions in `tests/neutral-install.test.mjs`; `tests/vscode-tasks.test.mjs` "six shell tasks …";
  `review-bridge/tests/i18n.test.mjs` "ps and down say the page's state …".
- **mutation_case:** `RB-M-command-bare-name`, `RB-M-command-ignores-pnpm`, `RB-M-entry-keeps-placeholder`,
  `RB-M-vscode-bare-name`, `RB-M-language-ignores-runner` catch a wrong function; `RB-M-command-line-left-bare`
  catches one line left as it was (all killed). The scan leaves out `--help` and `README.md`; README is
  rewritten with the release.
- **residual_risk:** `--yes` after the package name must reach Bridge. Through npx it does: the card's
  run-again line, typed as printed, started the run (Windows, fake CLI). `pnpm dlx`, `yarn dlx`, `bun x` and
  `deno run -A npm:` pass the flags after the name on by their source; none was run (not installed where
  this was checked). The path with no link and no global install can only run once the release is on
  the registry. `npx review-bridge` asks the registry for the latest version on every command. The page
  service and PostgreSQL started through npx run from npm's cache folder, which the next release replaces
  in place (separate work).

## RB-GATE-2026-003 — the second of two yeses to one card read a half-written plan file

- **affected_gate:** Authorization
- **symptom:** two `start <file> --yes` at once: one run started (the guard held), but the other printed
  `Review bridge failed closed: Unexpected end of JSON input` instead of saying the card was already used.
- **expected_vs_actual:** expected the second to be refused in words; actually a JSON parse error.
- **reproduction:** `tests/product-init.test.mjs` "two --yes to one card at once start one run …"; red
  once in a full Linux run at `fc16a12`, green when run alone five times (timing).
- **root_cause:** both starts wrote the same plan file by truncate-then-write and read it back before the
  database claim decided between them.
- **fix:** `22c7017` — the start hands the plan on in memory and reads back nothing it wrote, as Vite's
  optimizer passes its metadata on and reads `_metadata.json` only at the next start; the file is written
  to a temporary name and renamed, and the temporary file is removed when that fails (write-file-atomic).
- **regression_test:** `review-bridge/tests/work-package.test.mjs` "a start that holds its plan authorizes
  it while its plan file is being rewritten; one given only the path does not" (`6abf40e`);
  `review-bridge/tests/file-store.test.mjs`.
- **mutation_case:** `RB-M-plan-authorize-reads-back`, `RB-M-plan-temp-file-kept` (killed);
  `RB-M-plan-run-reads-back` (**survived**: tests do reach the read in `runAuthorized` through
  `start --yes`, but at that moment the plan file is always whole, so reading it back and not reading it
  look the same).
- **residual_risk:** no test tells whether `runAuthorized` reads the plan file back; catching it needs a
  way to make the file differ from the plan in memory at that moment, which this release does not add. On Windows, two renames onto
  the same plan file at the same instant may fail with `EPERM`; the second start then ends with that error
  instead of the refusal, and still no second run starts.

## RB-GATE-2026-004 — the second yes read the work order while the first start wrote its id

- **affected_gate:** Authorization
- **symptom:** two `start <file> --yes` at once on Windows CI: one run started (the guard held), but the other
  said `The work order changed after you saw the card` instead of saying the card was used. Seen in the
  Windows CI log of `521d5e9`, the only one read; Windows CI was red on every commit before it, for causes
  not read. Green on Linux CI at `521d5e9`. Why Windows meets the window and Linux does not is not shown: the
  write takes milliseconds. Whether Windows CI turns green with the fix is the check that this is the cause.
- **expected_vs_actual:** expected the second yes to be told the card was used; actually told the person had
  changed the work order, which they had not.
- **reproduction:** GitHub Actions `windows-latest`, Node 22.23.4, `npm test` (run 42710217414): 199 of 200
  pass, this one fails with that message.
- **root_cause:** after its claim, the start that took the card writes the work order's id into the person's
  file in place (`fs.writeFile`, as ESLint's `outputFixes` and Prettier's `writeFormattedFile` write a
  person's files). The other yes compared the file with the card before asking the records whether the card
  was used, so a file read half written looked changed. The same for a directory's card.
- **fix:** the commit that adds this entry — a file that does not read as the card showed is first asked of
  the records: a used card is refused as used. The write stays in place, which keeps hard-linked work
  orders one work order.
- **regression_test:** `tests/product-init.test.mjs` "--yes is refused when the work order changed after the
  card, …" (the work order emptied after the yes, as if half written); `review-bridge/tests/work-order-line.test.mjs`
  "a card lists the directory in order, …" (one of its files emptied after the line ran).
- **mutation_case:** `RB-M-yes-midwrite-says-changed`, `RB-M-line-yes-midwrite-says-changed` (not yet run:
  both tests start the database; they run in the container).
- **residual_risk:** a person who really edits the work order at the same moment another yes takes the card
  is told the card was used; that is also true.

## RB-GATE-2026-005 — a work order not yet on disk, under a Windows short path, was named outside the project

- **affected_gate:** Records
- **symptom:** on Windows CI `canonicalTaskFile` named `.review-bridge/work-packages/ログイン修正.md` as
  `../../../../../RUNNER~1/AppData/Local/Temp/…/ログイン修正.md`.
- **expected_vs_actual:** expected the path in the project; actually a path climbing out of it.
- **reproduction:** `review-bridge/tests/work-order-name.test.mjs` "the records name a file in NFC, …" on
  GitHub Actions `windows-latest` at `837f067`, whose TEMP is `C:\Users\RUNNER~1\…` (an 8.3 name for
  `runneradmin`).
- **root_cause:** the root was made real (long name) and so was the file, but a file not yet on disk cannot
  be made real, so it kept the short name; one long and one short path were compared.
- **fix:** the commit that adds this entry — both sides are made real as far as they exist and the rest is
  joined back, as CPython's non-strict `realpath` does on Windows (`Lib/ntpath.py`).
- **regression_test:** `review-bridge/tests/work-order-name.test.mjs` "a project named by its Windows short
  path names a work order not yet on disk by its path in the project" (skipped where there are no 8.3 names).
- **mutation_case:** `RB-M-task-file-short-path` (killed on a Windows volume with 8.3 names; invalid where
  the test is skipped).
- **residual_risk:** none known.

## RB-GATE-2026-006 — test files starting their databases at once took the same port

- **affected_gate:** Records (test setup)
- **symptom:** Windows CI `review-bridge/tests/acceptance-run.test.mjs`: the template's init failed with
  "PostgreSQL did not start within 60s" about 1.4 s after the server started; seven tests failed with it.
- **expected_vs_actual:** expected each test file's server to start; actually one died binding a port another
  file's server had just taken, and Bridge's message called it a 60 s timeout.
- **reproduction:** GitHub Actions `windows-latest` at `837f067`, `node --test "review-bridge/tests/*.test.mjs"`,
  which runs `os.availableParallelism() - 1` files at once; every file's server looked for a free port from
  the same start port.
- **root_cause:** a port is probed free and then bound by the server; between them another file's server
  took it. PostgreSQL starts its log collector before binding (`postmaster.c`), so the bind FATAL went to the
  collector's file, which writes a dying server's last words after it is gone (`syslogger.c`); Bridge read
  the file at once, saw only the collector's HINT, did not retry on the next port, and said "within 60s"
  whatever the wait.
- **fix:** the commit that adds this entry — each test file takes a port the system hands out, as the
  embedded-PostgreSQL libraries' test helpers do (fergusstrange/embedded-postgres `freePort`, zonky
  `detectPort`: bind port 0, read the number, close), and writes it as its data home's `database.port`; the start failure now says how long pg_ctl waited and the server's last lines as written.
- **regression_test:** none that can fail on demand; the check is both CI platforms green.
- **mutation_case:** none: the race is not reproducible on demand.
- **residual_risk:** reading the collector's file too early is unchanged, so a port taken between the probe
  and the bind outside the tests (another program) still fails instead of moving to the next port. The
  message says where the server's log is.

## RB-GATE-2026-007 — a run lock read before its holder wrote it failed the delivery with a parse error

- **affected_gate:** Records (run lock)
- **symptom:** GitHub Actions `ubuntu-latest` at `89fd5ca`, `review-bridge/tests/result-file.test.mjs:206`
  "S1d three concurrent deliveries …" failed with `SyntaxError: Unexpected end of JSON input`, the only
  failure of 537; `windows-latest` passed the same commit.
- **expected_vs_actual:** expected all three deliveries to return, one result file and one `run_delivered`
  event; actually one delivery threw the parse error and the test failed.
- **reproduction:** not on demand in CI; the moment is fixed by a test instead: an empty or half-written file
  at `run-locks/<run_id>.json`, then `acquireRunLock`. Stack in CI: `JSON.parse` ← `parseJson`
  (`fileStore.mjs:17`) ← `readJson` ← `readOptional` (`runStore.mjs:140`) ← `acquireRunLock`
  (`runStore.mjs:270`) ← `withRunLock` ← `deliverRun` ← `deliverOutcome` (`delivery.mjs:686`).
- **root_cause:** the holder creates the lock file exclusively and writes it after (`fileStore.mjs:60-62`), so
  it exists empty for a moment. A second taker whose create fails with `EEXIST` read it in that moment; the
  reader took only a missing file as "no lock", so the parse error went up, and delivery retries only errors
  that read as a held lock. The reconcile guard is created and read the same way.
- **fix:** the commit that adds this entry — a lock or guard file with no readable content (empty, cut off,
  or content that is not a record, such as `null`) is held, as PostgreSQL's `CreateLockFile` reads an empty lock file as one being written or left by a crash
  (`miscinit.c:1270-1275,1311-1316`); its age is its modification time, as proper-lockfile judges a lock
  with no content (`lib/lockfile.js:51-85`): a run lock older than `lock_stale` goes through the existing
  takeover (guard, wait, read again, move aside), a guard older than `reconcile_guard_ttl` is moved aside.
  The holder still writes the file the same way.
- **regression_test:** `review-bridge/tests/run-closing.test.mjs` "a run lock whose file is complete with a
  fresh heartbeat is held", "a run lock file that is empty or half written is held, not a parse error", "an
  empty run lock file older than lock_stale is taken over; a younger one is not", "an empty run lock written
  during the takeover's wait is not taken over", "an empty reconcile guard is a reconciliation in progress", "an empty reconcile guard older than reconcile_guard_ttl is taken over,
  and the stale run lock with it"; `review-bridge/tests/result-file.test.mjs` "S1g a delivery that meets an
  empty run lock file retries, and delivers once it is gone".
- **mutation_case:** `RB-M-run-lock-unwritten-parse-error`, `RB-M-run-lock-unwritten-taken-at-once`,
  `RB-M-run-lock-unwritten-never-stale`, `RB-M-reconcile-guard-unwritten-parse-error`,
  `RB-M-lock-mark-ignores-unwritten-change` (killed).
- **residual_risk:** a holder that stalls between creating the file and writing it for longer than
  `lock_stale` (30 s) loses the lock to a taker, as with proper-lockfile's stale time; any unreadable
  content, not only an empty or cut-off one, is read the same way. "Run reconciliation is already in
  progress." is not among the errors delivery retries, so a delivery that meets a live guard still fails
  as before this fix.

## RB-GATE-2026-008 — a second command starting the database was told to restart the computer while the first was starting it

- **affected_gate:** Records (database start)
- **symptom:** GitHub Actions `windows-latest` on `dev/ci-test` at `806d8fb`, `review-bridge/tests/postgres-server.test.mjs:359`
  "two processes creating the cluster for the first time at once both end up on the same server" failed: one
  process threw `OldServerError` ("the server was not shut down properly last time … Restart the computer and
  run this again") from `postgresServer.mjs:496`, the only failure of 544. The same test passed on the run
  before (6.5 s).
- **expected_vs_actual:** expected both processes to end on the one server; actually the second was told a dead
  server's processes were still running, when the first process's server was starting.
- **reproduction:** not on demand on a real server; the moment is fixed through `startServer`'s seams: `detached`
  answers held, `pg_ctl status` answers not running twice and then running.
- **root_cause:** on Windows the server holds pg_ctl's `-l` file from the moment cmd.exe opens it for it, before
  it writes `postmaster.pid`. A second start that found the file held asked once whether a server ran, got
  "no" while the first was still starting, and took the held file for a dead server's leftovers.
- **fix:** the commit that adds this entry — a held file with no server yet is a server still starting, as
  pg_ctl's `wait_for_postmaster_start` reads one that is not up yet ("just keep waiting", `pg_ctl.c:602-605`):
  the start asks again every 100 ms (`WAITS_PER_SEC` 10) until its own deadline (60 s) and uses the server once
  it runs. Only a file still held with no server by then is reported as before. A start still clears nothing
  (Owner 2026-11-08).
- **regression_test:** `review-bridge/tests/database-down.test.mjs` "a held -l file while another command's
  server is still starting: the start waits and uses that server", "a held -l file with no server by the
  start's deadline is a dead server's leftovers, said as before"; on a real server (Windows CI)
  `postgres-server.test.mjs` "two processes creating the cluster …" and "four processes starting the same
  cluster at once …".
- **mutation_case:** `RB-M-held-asked-once`, `RB-M-held-taken-as-started` (killed on Windows 11 here; the seams
  make them platform-independent).
- **residual_risk:** a dead server's leftovers are now reported after the start's deadline (60 s) instead of at
  once; the start has no way to end early, since pg_ctl's own early end needs the process it started. Each
  wait asks `pg_ctl status`, one process per 100 ms at most, for that one start.
  A failed delete of the `-l` file for lack of permission (`EACCES`) is held too, on every platform, so off Windows
  that start also waits out its deadline before it reports.

## RB-GATE-2026-009 — a page service that came back was reported as not restarted

- **affected_gate:** Install (restarting the page service)
- **symptom:** GitHub Actions `ubuntu-latest` on `dev/ci-test`, installer job, `tests/neutral-upgrade.test.mjs:970`
  "a failed upgrade whose page service does not come back keeps the marker and says why" failed at its rollback:
  "did not restart: up returned 0 but the service is not answering", thrown from `installer/neutral-install.mjs:2497`,
  the only failure of 200. The same code passed on ubuntu and windows the run before.
- **expected_vs_actual:** expected the rollback to restart the page and remove the maintenance marker; actually
  `up` exited 0 and the installer reported the page as not restarted, kept the marker and gave no reason.
- **reproduction:** through the installer's seams, `tests/page-restart.test.mjs`: `up` answers 0 and the one check
  of the page answers not running.
- **root_cause:** `up` already waits for the page and exits 0 only once it answered (`pageService.mjs` serviceUp,
  every 250 ms up to 10 s). The installer then asked once more, and one answer that came late or not at all (each
  ask is a request to `/api/status` with a 2 s limit) turned a restart that worked into a failure; the check's own
  reason was dropped for a fixed sentence.
- **fix:** `3d1a8f0` took `up`'s 0 as the answer, citing `pg_ctl -w` and Playwright's webServerPlugin, and left
  the other one-off checks as they were; the next CI run failed on the test's own one-off check
  (`neutral-uninstall.test.mjs:781`, `wrong_service`). Redone against supabase/cli's stack owner in
  RB-GATE-2026-010: the page service reports ready itself, and every check finds it through its lease and
  identity.
- **regression_test:** `tests/page-restart.test.mjs` was removed: it reached the installer through an export and a
  parameter opened for the test only (supabase/cli `.agents/skills/test-audit/SKILL.md:25-27`). Now
  `review-bridge/tests/page-host.test.mjs` (see RB-GATE-2026-010) and, on real services,
  `tests/neutral-upgrade.test.mjs` and `tests/neutral-uninstall.test.mjs`, whose assertions that the page runs find
  it the waiting way and print why when they fail.
- **mutation_case:** `RB-M-restart-asks-again-after-up` and `RB-M-restart-drops-up-reason` were removed with the
  test they named; the mutants of RB-GATE-2026-010 replace them.
- **residual_risk:** which of the reasons made the first CI check fail is not known; the log has none.

## RB-GATE-2026-010 — a page service just started by `up` was found "not running" by the next check

- **affected_gate:** Page (the resident page service)
- **symptom:** GitHub Actions `ubuntu-latest` on `dev/ci-test` at `f53d7af`, installer job,
  `tests/neutral-uninstall.test.mjs:781`: the cancel's restart reported `service_restarted: true`, and the
  test's next check of the page answered `wrong_service`, the only failure of 203.
- **expected_vs_actual:** expected the page service `up` had just reported to be found running; actually one
  check of `/api/status` answered something other than this page service's identity and was taken as "not
  running".
- **reproduction:** `review-bridge/tests/page-host.test.mjs` makes each situation itself with real page-service
  processes: a record naming another process while the lease is held, a stale record with no lease holder, a
  foreign listener on the previous control port.
- **root_cause:** Bridge decided whether its page service ran from a pid, a session file and one request to a
  page endpoint that reads the settings and checks both CLIs on every call; every caller asked once, and any
  answer but a match was "not running". `up` learned that the page was ready by polling that endpoint.
- **fix:** the commit that adds this entry — the page service is a stack owner as in supabase/cli `c75aea2`
  (`packages/stack/ARCHITECTURE.md:487-536`), its lease a session-level PostgreSQL advisory lock on a
  connection of its own, taken with `pg_try_advisory_lock` and read by others from `pg_locks` (as supabase/cli
  locks in its database, `apps/cli` `db-setup.ts:636-664`; PostgreSQL `mvcc.sgml` Advisory Locks and
  `view-pg-locks`; que `docs/README.md:101`; node-pg-migrate `src/runner.ts` `lock`), which the server releases
  when the session ends; the page service shuts itself down when that session ends (`ARCHITECTURE.md:495`, lost
  ownership); a record published by rename under that lease, withdrawn only while the lock is still held and
  never touched once it was lost, the next publish renaming over it (`Publication.ts`, `Lease.ts:55,215-237`);
  a control listener
  on a port the system gives, with `/identity` and `/shutdown` behind a bearer secret (`StackHost.ts:357-372`);
  finding it means the lease, then the record, then the identity, a mismatch being a record not yet replaced and
  looked up again every 50 ms for 30 s (`HostProcess.ts:200-336`), or, for what only looks, once without waiting
  (`:254-265`); `up` and `watch` start it the one way and read its readiness from a pipe (`:467-707`), `watch`
  holding its stdin as a session's lifeline (`ARCHITECTURE.md:491`); `down` asks it to shut down and waits until
  its pid is gone (`:709-815`); shutting down cancels a running reviewer check and waits for its process tree
  (`ARCHITECTURE.md:505-512`); a page service of another release is refused except by `down` (`:489`). Page services
  started at once found races in opening a new database, fixed with two locks: the database is made under an
  advisory lock on the admin connection (supabase/cli `db-setup.ts:636-664`), and the whole run of migrations, from
  reading the history to the last one, is under one session-level migration lock taken before the migrations table
  is made and released in its finally, as node-pg-migrate holds its lock in its wait mode (`src/runner.ts:481-484`,
  `:1145-1168,1294-1307`; its default mode refuses instead, `:479,486-494`), so a second
  command neither collides creating that table nor reads a half-migrated database as one to upgrade and backs it up
  (the backup stops the server). The concurrent-launch test opens the database first: several processes starting one new database at
  once on Windows can wait 30 s on pg_ctl's -l file (pg_ctl.c:521-554, port/open.c:110-137), left to the
  database-start work.
- **regression_test:** `review-bridge/tests/page-host.test.mjs` (one page service for concurrent launches;
  relaunch with a foreign listener on the old control port, and 401 without the secret; a record naming another
  process while the lease is held; a stale record without a lease holder; status without a request; a page
  service that exits before ready; a startup failure it reports, said without its log; another release; an older release's record; the terminal's lifeline; its
  database session terminated, its record left for the next one to replace; two projects at once;
  a page service ended without a shutdown; a shutdown during a reviewer check),
  `review-bridge/tests/page-exit.test.mjs` (waiting for the pid to go, with a controllable probe and clock).
- **mutation_case:** `RB-M-page-lease-not-taken`, `RB-M-page-identity-mismatch-not-running`,
  `RB-M-page-running-by-pid`, `RB-M-page-retract-unconditional`, `RB-M-page-ready-by-polling`,
  `RB-M-page-lost-lease-kept-running`, `RB-M-page-record-pruned`, `RB-M-database-create-unlocked`,
  `RB-M-migrations-run-unlocked`, `RB-M-upgrade-not-backed-up`, `RB-M-upgrade-not-refused-while-running`
  (the last two in `review-bridge/tests/backup.test.mjs`, which now opens the database from a command of its own; `review-bridge/tests/database.test.mjs`: the test holds the lock and sees the
  commands wait for it in pg_locks, so a command that does not wait fails it every time).
- **residual_risk:** the page service keeps one database connection of its own while it runs. A page service that
  never reports ready is ended after 30 s; that wait is not tested, as supabase/cli does not test it. The shutdown
  during a reviewer check is tested on POSIX only. How fast the database releases a lock whose holder died was
  measured on Windows (7 to 8 ms); Linux is measured by these tests in the container. Two commands upgrading at
  the same moment both read pending migrations and both back up; left as it was (index.mjs open), for the
  database-start work.
