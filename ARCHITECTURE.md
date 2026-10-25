# Architecture

This document describes how the Review Bridge source is organized today: the runtime that is installed into a target project, the installer that puts it there, and the rules that keep the parts apart. It describes the code as it is, including the parts that are not finished.

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
│   ├── workOrder/         plan → authorize → writer → Gate A → review → deliver; status, cancel, stop
│   ├── setupCheck/        the setup page, the resident page service, the reviewer read-only check
│   ├── records/           prune and rm: fold finished runs into day files
│   └── doctor/            read-only diagnostics
├── service/               boundaries shared by more than one feature
│   ├── index.mjs          the only way in
│   ├── agentCli/          child processes and the writer/reviewer CLIs
│   └── records/           everything persisted under the project's private root
├── policy/                pure rules
└── utils/                 pure helpers
```

Dependencies only point downward: `router` → `features` → `service` → `policy` → `utils`. A feature may also use `policy` and `utils` directly.

| Layer | Owns | May import | Must not |
|---|---|---|---|
| `router/` | The command table, options, guards; passes one feature's capability to another | A feature's `index.mjs`, `service/index.mjs`, `utils/` | Reach into a feature's internal files; decide the order of business steps |
| `features/<name>/` | All steps of one flow, in order, and what that flow prints | `service/index.mjs`, `policy/`, `utils/` | Import another feature; import a service module other than `service/index.mjs` |
| `service/` | Shared external resources: CLI processes and persistent records, including their file formats and transactions | `policy/`, `utils/`, other service modules | Import a feature or the router |
| `policy/` | Default policy and override validation, the tighten-only merge, classification checks | `utils/` | Read or write files |
| `utils/` | Paths, path checks, dates, digests, filesystem type checks | Nothing above it | Business rules; reading or writing project state |

`bootstrap.mjs` is the composition root: it selects the platform adapter, applies the native start gate, and calls the router.

## 3. Features

Each feature exposes only what its `index.mjs` exports. Everything else in the folder is internal to it.

| Feature | Public entries | Internal modules |
|---|---|---|
| `workOrder` | `planWork`, `startWork`, `workStatus`, `cancelWork`, `stopWork`, `reviewWork`, `resumeWork`, `reviewQueueStatus`, `waitForReview`, `deliverOutcome` | `workPackage`, `contract`, `translation`, `confirmStart`, `writerLoop`, `writerPrompt`, `gateA`, `review`, `reviewQueue`, `typedResults` and `schemas/`, `workspaceEvidence`, `delivery`, `budget`, `i18n` and `locales/` |
| `setupCheck` | `startWatch`, `upService`, `downService`, `showService`, `checkService` | `watchServer`, `pageService`, `reviewerProbe` |
| `records` | `runPrune`, `removeRecord` | `retention` |
| `doctor` | `inspectDoctor` | — |

**Work-order contract.** A work order is a Markdown file under `.review-bridge/work-packages/`, in any language and any heading layout. `work-plan` seals its text and records the contract steps the human approves with the plan: the configured writer translates, the configured reviewer checks, at most two attempts, each call held to the plan's minutes per call. Starting the work authorizes that sealed text; there is no second human approval.

**Versions of a work order.** Saving the work order file changes nothing that is running: the run keeps its sealed text, and its result shows the lines added or removed since the start and says the work was judged on the sealed version. A new version exists only when the human builds a new plan from the edited file and starts it. A work order is a place: its folder and the name its entry has there (decision A, 2026-10-22), never the spelling of its path and never the file id alone. Where names ignore case, Abc and abc reach one entry and are one work order; where names keep case and both files exist, they are two; two hard links to one file in one folder are two entries, so two work orders. A file replaced by an editor that saves by renaming keeps its place, so editing it makes a new version of the same work order; moving it to another folder or name makes another work order, and the old run is not stopped by a start there. The entry is the one with exactly the spelled name, or, when there is none yet the path reaches a file, the single entry whose name matches ignoring case and Unicode form; either must be the file the path reaches, and anything else is refused, never guessed. No setting such as `core.ignoreCase` and no rule per operating system is used, and a file system that gives no file id refuses the start. One start of a work order runs at a time: from looking for its running version until the new run exists, the start holds that work order's start lock, keyed by its place, and a second start meanwhile is refused and creates nothing; a start already under way goes on with the plan it sealed even if the file is saved again, and only a later start of the new text replaces it. A work order deleted or moved while a start runs fails that start, and its run, if made, is closed. Under that lock, a run of the same work order still running with the same text is not an older version: the start is refused and that run goes on. Otherwise the start first stops any run of the same work order file still running, or stopped with a kill not yet confirmed, and waits for that run's work-start to let go of the run; only then is anything of the new version made. A stop that cannot be confirmed, an old work-start that does not let go within 30 seconds, or a running run whose record cannot be read refuses the start, and starting again retries. Every refusal before that step leaves the old version running, and the terminal card names the version a start would stop. The old run closes as `stopped` with the reason `superseded`; the new run has its own authorization, contract and verdicts, and nothing of the old run is carried into it. Another work order's start stops nothing.

**Runs side by side.** Runs of different work orders work at the same time in one folder. Each run has its own work lock (`run-locks/<run id>.work.lock`), which `work-start` takes before the run is created and hands to the loop that works it: a start that cannot take it creates nothing, and a run created by a start that then fails is closed as `controller_failure`, never left running. A run's own review takes no project-wide lock (the job is claimed by an atomic move from pending to running); only the `review` command, which works through every pending job, runs one at a time. A run's start waits only for its own review jobs, not for other runs'. Every file a writer, contract or Gate A call writes is named by the time and the run (`callStamp`), so two runs' calls in the same millisecond never share a name, and retention tells them apart. `work-cancel --run <run id>` names the run to cancel when several are active. The runs share the folder, so one run's edits are part of the other's project version; see the version rule in the acceptance chain.

Before the writer's first call, the writer's provider makes one tool-less call that returns a `contract.translation` (`schemas/contract.translation.schema.json`). Parts of the work order come back as line ranges only, and Bridge copies the text; each condition (AC1, AC2, ...) carries a quote that must appear verbatim in its lines; every non-blank line is either used or listed in `unused_lines`; a run plan needs at least two runs on separate lines, a dependency must quote the run's own line that names it, none may loop, and with a plan every condition belongs to a run; the schema has no field for paths, commands, budgets or roles. The reviewer's provider then reads the full work order, the candidate contract and its unused lines in its own read-only session and answers a `contract.check` that judges every part of the contract, empty ones included (an exclusion copied as an inclusion, or an empty part the work order fills, is not faithful), and every condition with its verification and runs. Bridge decides from those items: a translation mistake goes back to the writer within the attempt limit, an ambiguity in the work order or an open question stops the run for the human, and a check that skips a part or a condition, or cannot confirm, stops the run as `contract_unconfirmed`. The check lowers the risk that a translation drifts from the work order; it does not prove the translation faithful. Token ceilings are checked after each of these calls, before the writer starts; usage Bridge cannot read stops the run as `usage_unknown` instead of counting as zero. Stopping follows one order on both sides: `stop` marks the run stopped inside the run lock and only then reads the recorded pid, while every model call, the reviewer included, and every Gate A command records its pid (`processRecords.mjs`) and then reads the run status, killing its own process if the run is stopped. Whoever closes a run first wins: a run with `closed_at` keeps its status, reason and time, so a PASS that arrives after a stop is refused, and a stop that arrives after a PASS reports that the work already ended while the PASS still closes normally. A review stopped mid-way is filed as stopped, not as a reviewer failure, and its output is not taken. A kill counts only when it is confirmed: a process that survives it, or a tree walk that fails even though the main process is gone (on Windows a failed `taskkill /T` may kill only the main process), is reported as "stop incomplete" and its pid kept; running `stop` again on the stopped run retries the kill without writing the stop a second time. A call that finds the run stopped and cannot confirm the kill of its own process fails with an error and leaves its pid for that retry. Whichever side comes second sees the other, so a call started around a stop does not keep running. The check fails closed: a run whose record is missing or cannot be read counts as stopped, and a process whose pid cannot be recorded is killed before the error is reported. The contract step also reads the status before each of its calls, retries included.

A checked contract must match `schemas/contract.schema.json`; it is sealed once under its SHA-256 in `.review-bridge/review-queue/contracts/` and recorded on the run. Before each writer call, after it, and after the review, the writer loop reads it back through that hash and schema; a missing or changed file stops the run as `contract_changed`. Writer and reviewer answers must name the same `contract_sha256`. Scope, budget, roles and the Gate A command stay in the work package the controller compiled before any model saw the work order. A run plan with several runs is recorded in the contract; starting one Bridge run per planned run is not built yet. Editing the Markdown never changes a sealed contract; a new plan and start make a new one, and the old one is kept.

**Acceptance chain.** With a contract, the writer's `writer.result` reports every sealed condition once by id in `criteria` (done or not done; `done` overall only if each is), and the reviewer's `review.result` judges every condition once by id in `verdicts` (pass with evidence, fail with a finding naming that id, or cannot_verify). `acceptance.mjs` refuses a missing, repeated or unknown id, a pass without evidence, and a PASS over a failed condition. Gate A and the review are tied together by samples of the project's version, described under *Version samples* below. Bridge then decides each condition: a reviewer pass is proven only if a condition that leans on Gate A has a Gate A pass on the same version (both unknown without Git); a failed verdict or a failed Gate A is failed; anything else is unknown. Every condition proven delivers; a reviewer PASS with any condition not proven stops as `acceptance_unverified` for the human; a failure goes back to the writer through the reviewer's FAIL. The result file lists every condition as proven, failed or unknown, with the version it was checked on. Docs-only work runs no Gate A, so its conditions rest on the reviewer. Writer and reviewer usage Bridge cannot read stops the run as `usage_unknown`. Gate A now runs with the policy's `gate_a_minutes` limit and refuses to run without a valid one. Reviews and contract checks pass `--skip-git-repo-check`, so a project without Git can be reviewed; the session stays read-only.

**Version samples.** Decision 2026-10-19 asks that what Gate A tested be what the reviewer reads. Bridge checks this by sampling the project's version at fixed moments, not by watching every write. A sample (`acceptance.mjs` `workVersion`, read with `--no-optional-locks`, so Git is never changed) is a fingerprint of the HEAD commit, everything tracked as `git diff --binary HEAD` shows it (staged or not), and every untracked file by path and content; untracked files that Git ignores are not part of it (a tracked file is always in the diff, whatever the ignore rules say). With Git and a Gate A command, a writer call that gets as far as a finished review takes at most these three samples (`writerLoop.mjs`); a call that stops earlier, for example because Gate A failed, takes fewer: just before Gate A runs (the tested version, kept with Gate A's result); just before the review job is queued (the version handed to the reviewer), compared with the tested version; and after the reviewer has finished, compared with the version handed to it. A difference at the second sample stops the run as `version_changed` before any review is paid for; a difference at the third stops it after the review, and its verdicts are not counted; the result says which. What the samples show is that the working state the Git fingerprint covers was the same at those moments, nothing more:
- A change made before Gate A starts is simply part of the tested version.
- Writing a file with the content it already had does not change the version.
- A change made and undone between two samples (while Gate A runs, before the review is queued, or while the reviewer reads) leaves equal fingerprints and is not seen, so Gate A may have tested, or the reviewer read, content that differs from both samples. No sample shows that the reviewer read one version throughout, and no write is recorded as it happens.
- A change only to untracked files that Git ignores is not seen.
- Without Git every sample is unknown and nothing is compared: a condition that leans on Gate A counts on Gate A's pass with no tie to the version the reviewer read, and the result says the version is unknown.
- Docs-only work runs no Gate A, so there is no tested version and no second-sample comparison; with Git, the review is still compared before and after.
- These samples are the same for every run in the folder: another run's edits, or a person's, are part of the version, which is how runs side by side can stop each other here.

**Work proof.** `workspaceEvidence.mjs` no longer walks or copies the project. With Git (read through `gitWorkspace.mjs`, every call with `--no-optional-locks`, nothing ever written to Git; a failed Git call is an error, never read as "nothing" or "no"; a project counts as having no Git only when there is no `.git` in it or above it and no `GIT_DIR`, so a Git project whose Git fails stops the run instead of turning into one without a work proof), a run's baseline is its start commit and branch plus content hashes of what was already changed, untracked, or ignored but forbidden. Ignored forbidden files are found by Git itself from the forbidden list as glob pathspecs (without `--directory`, which would hide `node_modules/a/x.pem`), so Bridge never walks `node_modules`, `.venv` or `build`. Each writer call and Gate A command runs between two snapshots; its window records every path that changed and the content it held at the end. A change counts as the run's only if its last observed change was in one of the run's own calls, no other run's call overlapped that call, and the file still holds what that call left; a window shows that a change was observed during a call, not who wrote it. Anything else, such as a human edit, another run, or a commit between calls, is unattributed, and if it is outside the scope it is reported as unverified rather than as the run's violation, and the run is never delivered as passed: a reviewer PASS with any unverified out-of-scope change stops as `scope_unverified` for the human, and no other run is named as its author. Commits made since the start are listed for the reviewer.

Who writes the evidence and what it is checked against: the run's controller writes the baseline once at authorization (its hash also goes on the run record) and one window file after each call; it keeps those hashes in memory. At the common exit of every writer call, Gate A command and review, success or failure alike, the controller checks the records on disk against that seal (an edited, added or removed record stops the run as `evidence_changed`) and that the Git start still exists (a rewrite or branch switch stops it as `start_point_lost`); after the review it also checks that the work is still the version the reviewer was given (otherwise `version_changed`). Another run's windows cannot be verified by this controller (a run file on disk proves nothing), so they are used only to raise doubt: they can stop a change from counting as this run's, never clear one. The stop command writes the run record and its events at any time; those are not evidence. A resumed run whose earlier calls left records cannot confirm them, because the controller that sealed them is gone: it stops as `evidence_unconfirmable` before any model call. A run that ended `evidence_changed` is delivered without using any of its records. A delivery made by another process can check the baseline only against the run record and says so. Limit: models run as the same user and can write the same folder, so these hashes detect a change to a sealed record while the controller runs; they cannot prevent it, cannot cover a record another controller wrote, and cannot make the run record itself trustworthy. Without Git there is no work proof: nothing is listed and the scope is unverified, and two Gate A failures in a row are not called a loop because "nothing changed" cannot be shown.

## 4. How features work together

Features never import each other. When one flow needs another feature's capability, the router passes it in as an argument, and the receiving feature decides when to call it.

| Command | Wiring done by the router | Order owned by |
|---|---|---|
| `start` | Passes the start gate (reviewer read-only proof in the running page) as `guard`, and the setup check's `ensureReviewerChecked` (start the page if needed; run the check there, as the page's button does) as `reviewerCheck` | `workOrder.startWorkOrder`: plan → `reviewerCheck()` unless already proven in this page session → card → without a terminal and without `--yes`, stop at `Needs authorization` → `guard()` → the person's yes (asked at a terminal, or `--yes` relayed by an agent; `authorized_via` is `terminal` or `agent`) → authorize → writer loop, one line per step → deliver |
| `resume` | The same `guard` and `reviewerCheck` | `workOrder.resumeWorkOrder`: a stopped run is closed, so its work order is planned again with that run's breakpoint, change types, scope and budget, then the same steps as `start` |
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
| `agentCli/codexAppServer` | Codex through `codex app-server`: one thread per call, every sub-agent thread followed, per-thread usage added once, every running turn interrupted on stop. A call is completed only when the root turn completed and every announced sub-agent's turn has ended; an interrupted or failed root ends the call with that status. Usage is complete only when every thread reported its total and every turn completed; otherwise it is recorded as partial. Not yet called by the writer loop (see section 7) |
| `agentCli/providers` | The provider list, role validation, CLI sign-in status checks |
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

The work order's records (RC3-BLOCKER-01 step 2) are `workOrder/workOrderRecords`: projects, work orders and their versions, plans (one per card), authorizations and claims, contracts. `start`, `resume` and `work-plan` decide which work order a file is (same file name; otherwise a renamed file whose old file is gone and whose text is close) and record the plan; `--yes` finds its card there; the start writes the work order, its version, the authorization and its claim in one transaction around the file authorization. Runs, their events, Gate A, verdicts, findings, acceptance and delivery go to the database through `records/runRecords` (step 3): `appendProjectionEvent` and `appendIoEvent` hand each event to the recorder the router installs for a project with an id, one transaction per event (the run's row locked, the next sequence, the event and its fact rows, the state columns). Step 4 reads from the database too: `status` and `work-status` (Q12 page, Q6 running), `doctor`'s running runs, the delivery pass before a prune, `clean --all`'s check, and the running runs a start replaces (by work order id). A process that keeps no records (a unit test of the files, a project without an id) reads its files. A run whose database goes away stops as `database_unavailable`; the events it kept meanwhile (`review-queue/unrecorded/`) are written by the next process that opens the database.

The same entry also re-exports three pure tools for the installer: `getBridgePaths`, `inspectStateFilesystem`, `canonical`.

## 6. Installer boundary

- **Runtime source:** the installer and `bridge.mjs` import the runtime source only through `review-bridge/service/index.mjs`. Project detection and profiles live in `installer/project-profile.mjs`.
- **Installed runtime:** at upgrade and uninstall, the installer has to check and stop the page service of the runtime already installed in the target. `loadInstalledServiceModules` in `installer/neutral-install.mjs` reads it from the current layout (`utils/paths.mjs`, `features/setupCheck/pageService.mjs`). If those files are absent, it falls back to the `core/` layout that installs made before this structure use. This is what lets an older install be upgraded.
- **Layout:** the installed runtime is a copy of the whole `review-bridge/` folder, so a new layout reaches the target without any file list in the installer.

## 7. Writer and reviewer roles: current state

`init` accepts either provider (`claude`, `codex`) for either role and records the choice in `.review-bridge/review-bridge/bridge.json`. The rest of the runtime does not yet follow that choice:

| Part | Follows the configured roles |
|---|---|
| `init` readiness check | Yes |
| Reviewer read-only check on the setup page | Yes, but only `codex` is supported as reviewer; `claude` is reported as unsupported |
| Writer loop (`features/workOrder/writerLoop.mjs`) | No: always starts `claude` |
| Review worker (`features/workOrder/review.mjs`) | No: always starts `codex` |
| Native start gate (`router/guards/nativeGate.mjs`) | No: it checks the reviewer proof, not which providers the roles name |

As a result, only writer `claude` with reviewer `codex` runs as configured. With `codex` in both roles, the reviewer check can pass and native start is allowed, but the writer that runs is `claude`. This is an open defect and must be closed before any other pairing is described as supported.

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
