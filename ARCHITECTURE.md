# Architecture

This document describes how the Review Bridge source is organized today: the runtime that is installed into a target project, the installer that puts it there, and the rules that keep the parts apart. It describes the code as it is, including the parts that are not finished.

## Codemap

Where to start for a change. This names things and gives no line numbers: search for the names. The numbered sections say how each part behaves. Paths are under `review-bridge/` unless they start at the repository root; `workOrder/` is `features/workOrder/`.

| To change | Start at |
|---|---|
| A command, its options or its wiring | `router/index.mjs` (command table), `router/args.mjs`, `router/help.mjs` |
| `start` and `resume` of one work order | `workOrder/commands.mjs`: `startWorkOrder`, `startFile`, `resumeWorkOrder`, `runAuthorized` |
| A directory of work orders | `workOrder/line.mjs`: `startDirectory`, `runLine` |
| What a work order must say, and the contract cut from it (no model) | `workOrder/workOrderFormat.mjs` (`formProblems`, `conditionsOf`), `workOrder/workOrderForm.mjs` (the refusal and the written-back markers), `workOrder/contract.mjs` (`buildContract`, `missingFields`) |
| What a card says | `workOrder/confirmStart.mjs` (`startCard`); a directory's card in `workOrder/line.mjs` (`cardLines`) |
| Reading a work order, planning and sealing | `workOrder/workOrderFormat.mjs`, `workOrder/workPackage.mjs` (`createWorkPackagePlan`) |
| Which work order a file is, and its versions | `workOrder/workOrderRecords.mjs` |
| The writer's turns | `workOrder/writerLoop.mjs`, `workOrder/writerPrompt.mjs`, `workOrder/budget.mjs` |
| The test step | `workOrder/test.mjs` |
| The review | `workOrder/review.mjs`, `workOrder/reviewQueue.mjs`, `workOrder/typedResults.mjs`, `review-prompt.md` |
| Whether a condition is proven | `workOrder/acceptance.mjs` (`workVersion`) |
| The work proof | `workOrder/workspaceEvidence.mjs`, `workOrder/gitWorkspace.mjs` |
| Stopping, pids and locks | `workOrder/commands.mjs` (`stopWork`), `workOrder/writerLoop.mjs` (`stopRun`), `workOrder/processRecords.mjs`, `service/agentCli/process.mjs` |
| The result file and `logs` | `workOrder/delivery.mjs` (`deliverOutcome`), `workOrder/runLogs.mjs` (`showLogs`) |
| A message a person reads | `workOrder/i18n.mjs`, `workOrder/locales/` |
| A provider's flags and output, MCP | `service/agentCli/calls.mjs`, `service/agentCli/claude.mjs`, `service/agentCli/codex.mjs`, `service/agentCli/mcp.mjs` |
| The reviewer's read-only proof, the setup page | `features/setupCheck/reviewerProbe.mjs`, `features/setupCheck/reviewerCheck.mjs`, `ui/` |
| A table | `service/database/migrations/`; a run's rows in `service/records/runRecords.mjs`; a work order's in `workOrder/workOrderRecords.mjs` |
| The database server and backup | `service/database/postgresServer.mjs`, `service/database/backup.mjs` |
| Policy defaults and rules | `config/default-policy.json`, `policy/policyRules.mjs` |
| An operating system's adapter | `platforms/`, `router/platform.mjs` |
| `init`, `upgrade`, `uninstall` | `installer/install-guide.mjs`, `installer/neutral-install.mjs`, `installer/agent-files.mjs` (at the repository root) |
| Tests | Runtime in `tests/`, its fake CLIs in `tests/fixtures/`; installer in `tests/` at the repository root |

Many tests start the CLI as a process, so imports do not show which tests cover a file.

## 1. Two packages in one repository

| Package | Location | Runs where | Job |
|---|---|---|---|
| Runtime | `review-bridge/` | From the npm package, against the project named by `--project` or the current folder | Work orders, the setup page, records, diagnostics |
| Installer | `installer/`, `bridge.mjs` | From the npm package, against a target project | Project setup (the `init` Guide), upgrade, upgrade rollback, uninstall |

The `bridge.mjs` commands `init`, `roles-check`, `upgrade` and `uninstall` hand the work to `installer/` (`init` through `installer/install-guide.mjs`); every other command goes to `review-bridge/bootstrap.mjs`. npm installs, verifies, upgrades and removes the package itself.

## 2. Runtime layers

```
review-bridge/
├── bootstrap.mjs          entry point; fixed path, every installed command starts here
├── manifest.json          supported commands and platform adapters
├── config/                default-policy.json
├── platforms/             one adapter per OS: find the CLI, build the invocation, notify
├── templates/             files the installer copies into the target project
├── review-prompt.md       the packaged reviewer prompt (a project copy can override it)
├── ui/                    the setup page; owned by features/setupCheck
│
├── router/                command table, option parsing, guards, wiring
├── features/              one folder per human flow
│   ├── workOrder/         plan → authorize → writer → test → review → deliver; status, cancel, stop
│   ├── setupCheck/        the setup page, the resident page service, the reviewer read-only check
│   ├── records/           prune and rm: fold finished runs into day files
│   ├── doctor/            read-only diagnostics
│   └── backup/            backup: a stopped copy of the person's database
├── service/               boundaries shared by more than one feature
│   ├── index.mjs          the only way in
│   ├── agentCli/          child processes and the writer/reviewer CLIs
│   ├── database/          the person's embedded PostgreSQL: server, migrations, backup
│   └── records/           run records and the files under the project's private root
├── policy/                pure rules
└── utils/                 pure helpers
```

Dependencies only point downward: `router` → `features` → `service` → `policy` → `utils`. A feature may also use `policy` and `utils` directly.

| Layer | Owns | May import | Must not |
|---|---|---|---|
| `router/` | The command table, options, guards; passes one feature's capability to another | A feature's `index.mjs`, `service/index.mjs`, `utils/` | Reach into a feature's internal files; decide the order of business steps |
| `features/<name>/` | All steps of one flow, in order, and what that flow prints | `service/index.mjs`, `policy/`, `utils/` | Import another feature; import a service module other than `service/index.mjs` |
| `service/` | Shared external resources: CLI processes and persistent records, including their file formats and transactions | `policy/`, `utils/`, other service modules | Import a feature or the router |
| `policy/` | Default policy and override validation, the tighten-only merge, the priority table | `utils/` | Read or write files |
| `utils/` | Paths, path checks, dates, digests, filesystem type checks | Nothing above it | Business rules; reading or writing project state |

`bootstrap.mjs` is the composition root: it selects the platform adapter, applies the native start gate, and calls the router.

## 3. Features

Each feature exposes only what its `index.mjs` exports. Everything else in the folder is internal to it.

| Feature | Public entries | Internal modules |
|---|---|---|
| `workOrder` | `planWork`, `startWork`, `workStatus`, `cancelWork`, `stopWork`, `reviewWork`, `resumeWork`, `reviewQueueStatus`, `waitForReview`, `deliverOutcome` | `commands`, `line`, `workPackage`, `workOrderFormat`, `workOrderForm`, `workOrderRecords`, `contract`, `confirmStart`, `writerLoop`, `writerPrompt`, `test`, `review`, `reviewQueue`, `acceptance`, `typedResults` and `schemas/`, `workspaceEvidence`, `gitWorkspace`, `processRecords`, `runLogs`, `delivery`, `budget`, `i18n` and `locales/` |
| `setupCheck` | `startWatch`, `upService`, `downService`, `showService`, `checkService` | `commands`, `watchServer`, `pageService`, `reviewerCheck`, `reviewerProbe` |
| `records` | `runPrune`, `removeRecord` | `retention` |
| `doctor` | `inspectDoctor` | — |
| `backup` | `backupDatabase` | — |

**Work-order contract.** A work order is a Markdown file under `.review-bridge/work-packages/`, in any language and any heading layout. It is a form (DECISIONS 2026-11-08): `work-plan` checks that it says what it must, a `requested_work` block (or a `run_plan`) and an `acceptance` list (`workOrderFormat.mjs` `formProblems`), cuts the contract from it by code, seals the contract under its SHA-256 and puts that SHA-256 in what the plan's hash covers. No model takes part. A work order short of a required block, with a line of its list that is no item, or with an open question unanswered, is refused before the card; a required block whose marker is gone is written back at the end of the file, marker and heading only (`workOrderForm.mjs`). `start` and `resume` show one card naming the contract, and one yes opens the run. A directory is checked whole first: one work order short of what it must say stops the line before its card, and each is named. The tables `contract_gatherings` and `contract_gathering_events` that the earlier translate-and-ask step used are dropped (`2026-11-08-1000-drop-contract-gatherings.sql`).

**Versions of a work order.** Saving the work order file changes nothing that is running: the run keeps its sealed text, and its result shows the lines added or removed since the start and says the work was judged on the sealed version. A work order is its id, made by Bridge with its first card and written into the work order's front matter (`id: <uuid>`) on the person's first yes, as Docusaurus and Astro read a document's id from its front matter (DECISIONS 2026-11-08 10:4x, replacing 2026-10-23's id kept only in the database); its path, file name and file id are not its identity. The `id` line is Bridge's, so the sealed text and every hash leave it out (`workOrderFormat.mjs` `sealedText`). `start`, `resume` and `work-plan` decide which work order a file is, without a model and without comparing content: the id in its front matter; a file without one is a new work order; two files with one id are the work order where the records last saw it and a copy, which is a new work order with its own id. A new title or file name keeps the work order; edited text started again is its next version. The card shows the decision (new, the same version, or version n → n+1 with the lines changed); the person's yes settles it, and `--update <work_order_id>` or `--as-new` prints another card that says otherwise. One start of a work order file runs at a time: from looking for its running version until the new run exists, the start holds a start lock keyed by the file's place, and a second start meanwhile is refused and creates nothing; a start already under way goes on with the plan it sealed even if the file is saved again. A work order deleted or moved while a start runs fails that start, and its run, if made, is closed. Under that lock, a run of the same work order still running with the same text is not an older version: the start is refused and that run goes on. Otherwise the start first stops any running run of the same work order id, or one stopped with a kill not yet confirmed, and waits for that run's work-start to let go of the run; only then is anything of the new version made. A stop that cannot be confirmed, an old work-start that does not let go within 30 seconds, or a running run whose record cannot be read refuses the start, and starting again retries. Every refusal before that step leaves the old version running, and the card names the version a start would stop. The old run ends with status `completed`, conclusion `cancelled` and closed reason `superseded`; the new run has its own authorization, contract and verdicts, and nothing of the old run is carried into it. Another work order's start stops nothing.

**Runs side by side.** Runs of different work orders work at the same time in one folder. Each run has its own work lock (`run-locks/<run id>.work.lock`), which `work-start` takes before the run is created and hands to the loop that works it: a start that cannot take it creates nothing, and a run created by a start that then fails is closed as `controller_failure`, never left running. A run's own review takes no project-wide lock (the job is claimed by an atomic move from pending to running); only the `review` command, which works through every pending job, runs one at a time. A run's start waits only for its own review jobs, not for other runs'. Every file a writer, contract or test call writes is named by the time and the run (`callStamp`), so two runs' calls in the same millisecond never share a name, and retention tells them apart. `work-cancel --run <run id>` names the run to cancel when several are active. The runs share the folder, so one run's edits are part of the other's project version; see the version rule in the acceptance chain.

Each block's text is copied into the contract field of its name, with its line ranges; the acceptance lists, the work order's own and each run's, are cut into conditions (AC1, AC2, ...) the way Markdown cuts a list (markdown-it's `list` rule, the one VitePress renders with): each item of the outermost list is one condition with the lines under it, a run's list belongs to that run, and a run's indented list is read without its common indent. Every non-blank line outside every block is listed in `unused_lines`. A run plan needs at least two runs, a dependency quotes the run's own line that names it, and none may loop. The contract has no field for paths, commands, budgets or roles. Before the writer's first call the writer loop refuses a contract without `requested_work` (or runs) or without a condition (`contract.mjs` `missingFields`): the run stops as `contract_rejected` with no model call. Stopping follows one order on both sides: `stop` marks the run stopped inside the run lock and only then reads the recorded pid, while every model call, the reviewer included, and every test command records its pid (`processRecords.mjs`) and then reads the run status, killing its own process if the run is stopped. Whoever closes a run first wins: a run with `closed_at` keeps its status, reason and time, so a PASS that arrives after a stop is refused, and a stop that arrives after a PASS reports that the work already ended while the PASS still closes normally. A review stopped mid-way is filed as stopped, not as a reviewer failure, and its output is not taken. A kill counts only when it is confirmed: a process that survives it, or a tree walk that fails even though the main process is gone (on Windows a failed `taskkill /T` may kill only the main process), is reported as "stop incomplete" and its pid kept; running `stop` again on the stopped run retries the kill without writing the stop a second time. A call that finds the run stopped and cannot confirm the kill of its own process fails with an error and leaves its pid for that retry. Whichever side comes second sees the other, so a call started around a stop does not keep running. The check fails closed: a run whose record is missing or cannot be read counts as stopped, and a process whose pid cannot be recorded is killed before the error is reported.

A contract must match `schemas/contract.schema.json`; it is sealed once under its SHA-256 in the project's state (`projects/<project_id>/contracts/` under the data home) and recorded on the run; a copy named `contract.v<version>.<short SHA-256>.json` goes beside the run's result in `.review-bridge/results/<work order>/`. Before each writer call, after it, and after the review, the writer loop reads it back through that hash and schema; a missing or changed file stops the run as `contract_changed`. Writer and reviewer answers must name the same `contract_sha256`. Scope, budget, roles and the test command stay in the work package the controller compiled before any model saw the work order. A run plan with several runs is recorded in the contract; starting one Bridge run per planned run is not built yet. Editing the Markdown never changes a sealed contract; a new plan and start make a new one, and the old one is kept.

**Acceptance chain.** With a contract, the writer's `writer.result` reports every sealed condition once by id in `criteria` (done or not done; `done` overall only if each is), and the reviewer's `review.result` judges every condition once by id in `verdicts` (pass with evidence, fail with a finding naming that id, or cannot_verify). `acceptance.mjs` refuses a missing, repeated or unknown id, a pass without evidence, and a PASS over a failed condition. The tests and the review are tied together by samples of the project's version, described under *Version samples* below. The tests run after every writer call and send failed work back to the writer before any review, and a run whose reviewer read another version than the tests ran on stops as `version_changed`. Code cuts the conditions and cannot tell which ones the tests show (DECISIONS 2026-11-08, choice A), so no condition leans on the tests by itself: Bridge decides each from the reviewer, a pass with evidence proven, a fail failed, anything else unknown, and `acceptance_rows` has no test column. In a project whose tests Bridge runs, a writer that reports `blocked` while asking the person nothing goes on to the tests and the review. Every condition proven delivers; a reviewer PASS with any condition not proven stops as `acceptance_unverified` for the human; a failure goes back to the writer through the reviewer's FAIL. The result file lists every condition as proven, failed or unknown, with the version it was checked on. A project whose rules give no test command runs no tests (they are recorded as `not_configured`), so its conditions rest on the reviewer. The token budget is the writer's (DECISIONS 2026-11-08, replacing T0-05 D5.3): `tokens_per_call` and `tokens` count what a writer call reads new, writes to the cache and writes out (`budgetTokens`), not its cache reads, which the result lists apart; a writer call whose usage Bridge cannot read stops the run as `usage_unknown`. The reviewer's usage is recorded, unknown as unknown, and stops nothing. The tests run with the run's `test_timeout` limit and refuse to run without a valid one. Reviews pass `--skip-git-repo-check`, so a project without Git can be reviewed; the session stays read-only.

**Version samples.** Decision 2026-10-19 asks that what the tests ran on be what the reviewer reads. Bridge checks this by sampling the project's version at fixed moments, not by watching every write. A sample (`acceptance.mjs` `workVersion`, read with `--no-optional-locks`, so Git is never changed) is a fingerprint of the HEAD commit, everything tracked as `git diff --binary HEAD` shows it (staged or not), and every untracked file by path and content; untracked files that Git ignores are not part of it (a tracked file is always in the diff, whatever the ignore rules say). With Git and a test command, a writer call that gets as far as a finished review takes at most these three samples (`writerLoop.mjs`); a call that stops earlier, for example because the tests failed, takes fewer: just before the tests run (the tested version, kept with the test result); just before the review job is queued (the version handed to the reviewer), compared with the tested version; and after the reviewer has finished, compared with the version handed to it. A difference at the second sample stops the run as `version_changed` before any review is paid for; a difference at the third stops it after the review, and its verdicts are not counted; the result says which. What the samples show is that the working state the Git fingerprint covers was the same at those moments, nothing more:
- A change made before the tests start is simply part of the tested version.
- Writing a file with the content it already had does not change the version.
- A change made and undone between two samples (while the tests run, before the review is queued, or while the reviewer reads) leaves equal fingerprints and is not seen, so the tests may have run on, or the reviewer read, content that differs from both samples. No sample shows that the reviewer read one version throughout, and no write is recorded as it happens.
- A change only to untracked files that Git ignores is not seen.
- Without Git every sample is unknown and nothing is compared: the tests' pass has no tie to the version the reviewer read, and the result says the version is unknown.
- A project with no test command configured runs no tests, so there is no tested version and no second-sample comparison; with Git, the review is still compared before and after.
- These samples are the same for every run in the folder: another run's edits, or a person's, are part of the version, which is how runs side by side can stop each other here.

**Work proof.** `workspaceEvidence.mjs` no longer walks or copies the project. With Git (read through `gitWorkspace.mjs`, every call with `--no-optional-locks`, nothing ever written to Git; a failed Git call is an error, never read as "nothing" or "no"; a project counts as having no Git only when there is no `.git` in it or above it and no `GIT_DIR`, so a Git project whose Git fails stops the run instead of turning into one without a work proof), a run's baseline is its start commit and branch plus content hashes of what was already changed, untracked, or ignored but forbidden. Ignored forbidden files are found by Git itself from the forbidden list as glob pathspecs (without `--directory`, which would hide `node_modules/a/x.pem`), so Bridge never walks `node_modules`, `.venv` or `build`. Each writer call and test command runs between two snapshots; its window records every path that changed and the content it held at the end. A change counts as the run's only if its last observed change was in one of the run's own calls, no other run's call overlapped that call, and the file still holds what that call left; a window shows that a change was observed during a call, not who wrote it. Anything else, such as a human edit, another run, or a commit between calls, is unattributed, and if it is outside the scope it is reported as unverified rather than as the run's violation, and the run is never delivered as passed: a reviewer PASS with any unverified out-of-scope change stops as `scope_unverified` for the human, and no other run is named as its author. Commits made since the start are listed for the reviewer.

Who writes the evidence and what it is checked against: the run's controller writes the baseline once at authorization (its hash also goes on the run record) and one window file after each call; it keeps those hashes in memory. At the common exit of every writer call, test command and review, success or failure alike, the controller checks the records on disk against that seal (an edited, added or removed record stops the run as `evidence_changed`) and that the Git start still exists (a rewrite or branch switch stops it as `start_point_lost`); after the review it also checks that the work is still the version the reviewer was given (otherwise `version_changed`). Another run's windows cannot be verified by this controller (a run file on disk proves nothing), so they are used only to raise doubt: they can stop a change from counting as this run's, never clear one. The stop command writes the run record and its events at any time; those are not evidence. A resumed run whose earlier calls left records cannot confirm them, because the controller that sealed them is gone: it stops as `evidence_unconfirmable` before any model call. A run that ended `evidence_changed` is delivered without using any of its records. A delivery made by another process can check the baseline only against the run record and says so. Limit: models run as the same user and can write the same folder, so these hashes detect a change to a sealed record while the controller runs; they cannot prevent it, cannot cover a record another controller wrote, and cannot make the run record itself trustworthy. Without Git there is no work proof: nothing is listed and the scope is unverified, and two test failures in a row are not called a loop because "nothing changed" cannot be shown.

## 4. How features work together

Features never import each other. When one flow needs another feature's capability, the router passes it in as an argument, and the receiving feature decides when to call it.

| Command | Wiring done by the router | Order owned by |
|---|---|---|
| `start` | Passes the start gate (reviewer read-only proof in the running page) as `guard`, and the setup check's `ensureReviewerChecked` (start the page if needed; run the check there, as the page's button does) as `reviewerCheck` | `workOrder.startWorkOrder`: plan → card → without a terminal and without `--yes`, stop at `Needs authorization` → the person's yes (asked at a terminal, or `--yes` relayed by an agent; `authorized_via` is `terminal` or `agent`) → `reviewerCheck()` unless already proven in this page session → `guard()` → authorize → writer loop, one line per step → deliver. The plan before the card cut and sealed the contract, and a work order short of what it must say stopped there |
| `resume` | The same `guard` and `reviewerCheck` | `workOrder.resumeWorkOrder`: a stopped run is closed, so its work order is planned again with that run's breakpoint and scope (priority, effort and budget come from the work order again), then the same steps as `start` |
| `clean` | Passes `deliver` | `records.removeRecord` with a run id, `records.runPrune` without |
| `status` | Passes the setup check's `checkService` as `page` | `workOrder.statusOverview`: the page, the latest runs, the review queue |
| `work-start` | Passes the start gate (reviewer read-only proof in the running page) as `guard` | `workOrder.startWork`: check options → `guard()` → human confirms → authorize → writer loop → deliver |
| `prune` | Passes the work order's delivery as `deliver` | `records.runPrune`: deliver pending results → fold → delete past retention |
| `rm` | Passes `deliver` | `records.removeRecord`: deliver → fold → remove → report an undelivered result |
| `watch` | Passes `daily`, which runs the records' prune with the work order's delivery | `setupCheck.startWatch`: start the page → record the session → run `daily` now and once a day |
| `stop`, `work-cancel` | None | `workOrder`: stop or cancel the run, then deliver |

`status` and `wait` only read the review queue and work without `bridge.json`. Every other command requires the configuration created by `init`.

## 5. Service

`service/index.mjs` re-exports every service module.

| Module | Holds |
|---|---|
| `agentCli/process` | Spawning child processes and stopping a whole process tree (`taskkill /T` on Windows; on POSIX the process group of a shell run, or every descendant found with `ps` for a CLI started directly) |
| `agentCli/codexAppServer` | Codex through `codex app-server`: one thread per call, every sub-agent thread followed, per-thread usage added once, every running turn interrupted on stop. A call is completed only when the root turn completed and every announced sub-agent's turn has ended; an interrupted or failed root ends the call with that status. Usage is complete only when every thread reported its total and every turn completed; otherwise it is recorded as partial. Called through `agentCli/codex` |
| `agentCli/calls`, `agentCli/claude`, `agentCli/codex` | One way to call a role; each provider's flags and output (section 7) |
| `agentCli/providers` | The provider list, role validation, which model each CLI takes, CLI sign-in status checks |
| `agentCli/providerFailure` | Reading a CLI failure: usage limits, reset hints, evidence tails |
| `agentCli/usage` | Token usage from the writer and reviewer CLI output |
| `agentCli/fakeAdapter` | The fake CLIs used by `--fake-cli` |
| `records/fileStore` | JSON and text reads and writes, atomic and durable writes, locks |
| `records/runStore` | Work packages, authorizations, claims, run projections and their transactions; the maintenance marker; upgrade invalidation |
| `records/ioEvents` | The per-run event log |
| `records/policySnapshots` | Writing and reading immutable policy snapshot files |
| `records/archive` | Day-file archive lines |
| `records/dayFiles` | Retention days and pruning old day files |
| `records/probeAudit` | Reviewer read-only check records (used by both the setup page and prune) |
| `records/failureRecords` | Writing a failure record beside its evidence |
| `records/runRecords` | The run recorder: each run event, and the facts it carries, into the database; the start's held events; `clean <run_id>`'s delete |
| `database/postgresServer` | The person's embedded PostgreSQL server: create, start, stop, connect. Owns no table |
| `database/migrate`, `database/migrations/` | Dated migration files, each applied once in its own transaction; a changed applied file stops everything |
| `database/index` | `openDatabase()`: the cluster on first use, the server started, the `bridge` database and the migrations; one pool per process. Imported only by the commands that keep records, not re-exported |
| `database/backup` | PostgreSQL's file system level backup into `<data home>/backups/database/<time>/`: refused while a run is running, the server stopped, the cluster folder copied whole and the server started again; a copy made while another command started the server is discarded. `openDatabase()` makes one before the first new migration of an upgraded Bridge, and refuses that upgrade while a run is running |

The work order's records (RC3-BLOCKER-01 step 2) are `workOrder/workOrderRecords`: projects, work orders and their versions, plans (one per card), authorizations and claims, contracts. `start`, `resume` and `work-plan` decide which work order a file is (the id in its front matter) and record the plan; `--yes` finds its card there; the start writes the work order, its version, the authorization and its claim in one transaction around the file authorization. Runs, their events, test results, verdicts, findings, acceptance and delivery go to the database through `records/runRecords` (step 3): `appendProjectionEvent` and `appendIoEvent` hand each event to the recorder the router installs for a project with an id, one transaction per event (the run's row locked, the next sequence, the event and its fact rows, the state columns). Step 4 reads from the database too: `status` and `work-status` (the project's runs, newest first, ten at a time with `--after` for the next page, and its running runs), `doctor`'s running runs, the delivery pass before a prune, `clean --all`'s check, and the running runs a start replaces (by work order id). A process that keeps no records (a unit test of the files, a project without an id) reads its files. A run whose database goes away stops as `database_unavailable`; the events it kept meanwhile (`unrecorded/` in the project's state) are written by the next process that opens the database.

The same entry also re-exports three pure tools for the installer: `getBridgePaths`, `inspectStateFilesystem`, `canonical`.

## 6. Installer boundary

- **Runtime source:** the installer and `bridge.mjs` import the runtime source only through `review-bridge/service/index.mjs`. Project detection and profiles live in `installer/project-profile.mjs`.
- **Installed runtime:** at upgrade and uninstall, the installer has to check and stop the page service of the runtime already installed in the target. `loadInstalledServiceModules` in `installer/neutral-install.mjs` reads it from the current layout (`utils/paths.mjs`, `features/setupCheck/pageService.mjs`). If those files are absent, it falls back to the `core/` layout that installs made before this structure use. This is what lets an older install be upgraded.
- **Layout:** the installed runtime is a copy of the whole `review-bridge/` folder, so a new layout reaches the target without any file list in the installer.

## 7. Writer and reviewer roles

Either provider (`claude`, `codex`) can fill either role, in all four pairings. The plan seals who fills each role, from `--writer`/`--reviewer` or else `.review-bridge/bridge.json`, with its model and effort: from the work order's `writer:`/`reviewer:` block, else the policy's priority table. A model of `null` leaves the choice to the CLI. A run does not change roles; changing `bridge.json` affects the next start, whose card names them.

`service/agentCli/calls.mjs` is the one way to call a role, and `agentCli/claude.mjs` and `agentCli/codex.mjs` the only modules that know a CLI's flags and output, the way Vitest's coverage `provider` picks one module behind one interface. A call asks for an access: `none`, `read` or `write`.

| Access | Used by | Claude Code | Codex |
|---|---|---|---|
| `read` | Review | `--permission-mode plan --tools Read,Grep,Glob --disallowedTools Write,Edit,NotebookEdit,Bash,PowerShell --strict-mcp-config --no-session-persistence` | `exec --ephemeral --sandbox read-only` |
| `write` | Writer | `--permission-mode auto --strict-mcp-config`, plus `--mcp-config .mcp.json` when the project has one | `app-server`, thread with `sandbox: workspace-write`, `approvalPolicy: never` |

The person's own connectors go into no session Bridge starts. Claude Code gets `--strict-mcp-config` in every call; a project's `.mcp.json` reaches its writer only. Codex gets `--disable apps --disable plugins` in every call, and each MCP server still in `codex mcp list` is turned off by name (`-c mcp_servers.<name>.enabled=false`; `-c mcp_servers={}` merges and removes nothing). The plan reads that list once and seals it; a list it cannot read refuses the start. The policy's `reviewer.mcp_allow` (default empty) names servers to let through as they are, not checked to be read-only (RC3-MCP-01): Codex leaves them on in the reviewer's calls only, the writer keeps nothing, and a Claude reviewer loads them from the project's `.mcp.json`. A Codex that is not installed or signed in is said first, as that; a run with no Codex in it reads no list. The card, the run's row and the result name what the reviewer was given.

Each role is its own CLI process and session, also when one provider fills both; each usage record names the session the CLI reported.

The reviewer's read-only check proves the flags its reviews run with, one proof per provider, held in the page service's memory. The proofs differ in strength: Codex shows a write that was attempted and denied by an OS sandbox; Claude Code's session is shown by its own `init` event to be in plan mode and to hold nothing beyond the three read tools, with the sentinel file absent and the CLI run to its end. A tool beyond those, an MCP server's included, fails the check.

Measured on Windows with Codex 0.166: `npm test` fails inside the writer's sandbox with `spawn EPERM` and passes only with `--configLoader native --pool threads`. Bridge runs the tests outside the sandbox, so a condition whose `verify` is `test` is not the writer's to prove.

Limits: the Codex writer has no `max-turns` (the token and time ceilings hold it) and no disallowed tools (a policy that sets them refuses the start). The record keeps the model the run was told to use, so with `null` it does not say which model the CLI chose. A work order may lower the reviewer's effort below the policy's table, which a project override may not.

## 8. Sub-agents and usage

The writer may hand parts of one work order to sub-agents in parallel; they share the run's scope and budget, and the writer returns one `writer.result`. A project override can still disallow the `Agent` tool. The reviewer is always a separate session started by the controller; a sub-agent's opinion is never a review. These were measured on 2026-10-17 on Windows with real CLIs:

| | Claude CLI 2.1.280 | Codex CLI 0.162.0-alpha.17.2 |
|---|---|---|
| Writer usage source | The final `result`'s `modelUsage`, all models added (it includes sub-agents; `usage` is only the last turn) | `codex app-server`: each thread's latest `thread/tokenUsage/updated` total, added once per thread |
| Sub-agent threads | Stream messages carry `parent_tool_use_id` | Linked by `subAgentActivity` items and a shared `rootTurnId`; no `thread/started` is sent for them |
| `codex exec` | — | `--ephemeral` cannot start sub-agents, and `--json` shows neither the spawn nor the sub-agents' usage |
| Stopping | `taskkill /T` stops the sub-agents' commands | Interrupting the root turn leaves sub-agent turns running; every active turn is interrupted, then the tree is stopped |

A call that ends without a final result (stopped, timed out, interrupted) still records what it spent, from the stream's per-message usage or the threads that reported, marked `partial`. A run with a partial record cannot claim that the token ceilings held exactly. Before any signal, stopping refuses the system's first process, Bridge itself and its ancestors, and any tree that holds one of them; it also refuses when the ancestry or the process list cannot be read, and sends no signal then. This protects Bridge and what started it; it cannot keep a wrong or forged pid record from pointing at another process of the same account. A process that ended but was not yet reaped (a zombie) counts as stopped. POSIX stopping has been run in a clean Linux container as root and on WSL2 (ext4) as a regular user; macOS has not been run.

## 9. Checking the structure

- `npm test` runs the installer tests in `tests/`; `node --test review-bridge/tests/*.test.mjs` runs the runtime tests.
- The test files have not yet been regrouped by layer.
- `npm pack --dry-run` lists what a release carries; only the `files` list in `package.json` is shipped.
