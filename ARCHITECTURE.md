# Architecture

This document describes how the Review Bridge source is organized today: the runtime that is installed into a target project, the installer that puts it there, and the rules that keep the parts apart. It describes the code as it is, including the parts that are not finished.

## 1. Two packages in one repository

| Package | Location | Runs where | Job |
|---|---|---|---|
| Runtime | `review-bridge/` | Copied into a target project at `.review-bridge/tools/review-bridge/` | Work orders, the setup page, records, diagnostics |
| Installer | `installer/`, `bridge.mjs` | From this repository, against a target project | Install, upgrade, upgrade rollback, uninstall |

Every `bridge.mjs` command (`init`, `roles-check`, `upgrade`, `uninstall`) first checks the package against `SHA256SUMS.txt`, then hands the work to `installer/neutral-install.mjs`.

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

Before the writer's first call, the writer's provider makes one tool-less call that returns a `contract.translation` (`schemas/contract.translation.schema.json`). Parts of the work order come back as line ranges only, and Bridge copies the text; each condition (AC1, AC2, ...) carries a quote that must appear verbatim in its lines; every non-blank line is either used or listed in `unused_lines`; a run plan needs at least two runs on separate lines, a dependency must quote the run's own line that names it, none may loop, and with a plan every condition belongs to a run; the schema has no field for paths, commands, budgets or roles. The reviewer's provider then reads the full work order, the candidate contract and its unused lines in its own read-only session and answers a `contract.check` that judges every part of the contract, empty ones included (an exclusion copied as an inclusion, or an empty part the work order fills, is not faithful), and every condition with its verification and runs. Bridge decides from those items: a translation mistake goes back to the writer within the attempt limit, an ambiguity in the work order or an open question stops the run for the human, and a check that skips a part or a condition, or cannot confirm, stops the run as `contract_unconfirmed`. The check lowers the risk that a translation drifts from the work order; it does not prove the translation faithful. Token ceilings are checked after each of these calls, before the writer starts; usage Bridge cannot read stops the run as `usage_unknown` instead of counting as zero. Stopping follows one order on both sides: `stop` marks the run stopped and only then reads the recorded pid, while every model call and Gate A command records its pid and then reads the run status, killing its own process if the run is stopped. Whichever side comes second sees the other, so a call started around a stop does not keep running. The check fails closed: a run whose record is missing or cannot be read counts as stopped, and a process whose pid cannot be recorded is killed before the error is reported. The contract step also reads the status before each of its calls, retries included.

A checked contract must match `schemas/contract.schema.json`; it is sealed once under its SHA-256 in `.review-bridge/review-queue/contracts/` and recorded on the run. Before each writer call, after it, and after the review, the writer loop reads it back through that hash and schema; a missing or changed file stops the run as `contract_changed`. Writer and reviewer answers must name the same `contract_sha256`. Scope, budget, roles and the Gate A command stay in the work package the controller compiled before any model saw the work order. A run plan with several runs is recorded in the contract; starting one Bridge run per planned run is not built yet. Editing the Markdown never changes a sealed contract; a new plan and start make a new one, and the old one is kept.

## 4. How features work together

Features never import each other. When one flow needs another feature's capability, the router passes it in as an argument, and the receiving feature decides when to call it.

| Command | Wiring done by the router | Order owned by |
|---|---|---|
| `work-start` | Passes the start gate (interactive terminal only, reviewer read-only proof in the running page) as `guard` | `workOrder.startWork`: check options → `guard()` → human confirms → authorize → writer loop → deliver |
| `prune` | Passes the work order's delivery as `deliver` | `records.runPrune`: deliver pending results → fold → delete past retention |
| `rm` | Passes `deliver` | `records.removeRecord`: deliver → fold → remove → report an undelivered result |
| `watch` | Passes `daily`, which runs the records' prune with the work order's delivery | `setupCheck.startWatch`: start the page → record the session → run `daily` now and once a day |
| `stop`, `work-cancel` | None | `workOrder`: stop or cancel the run, then deliver |

`status` and `wait` only read the review queue and work without `bridge.json`. Every other command requires the v4 configuration created by `init`.

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

A call that ends without a final result (stopped, timed out, interrupted) still records what it spent, from the stream's per-message usage or the threads that reported, marked `partial`. A run with a partial record cannot claim that the token ceilings held exactly. POSIX stopping has not been exercised on a POSIX host.

## 9. Checking the structure

- `npm test` runs the installer tests in `tests/`; `node --test review-bridge/tests/*.test.mjs` runs the runtime tests.
- The test files have not yet been regrouped by layer.
- Every file listed in `SHA256SUMS.txt` must match before `bridge.mjs` runs; refresh the entries of files you change.
