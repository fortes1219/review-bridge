# Results, logs, and the database

After a run ends, you can inspect it in three places: the project's **result file**, the **execution logs**, and the database's **events and decisions**. The IDs at the top of the result file connect these records.

## Result files

Each run creates a result file in the work order's own folder. These files and outputs come from the English work order captured in [Start a run](./start#the-card), using `locale: en` and `--fake-cli`. Only local path prefixes are shortened.

```text
.review-bridge/results/add-readme/
  contract.v1.8d086ca.json
  DOC-1 add-readme 2026-11-10 12-45-02 success.md
```

- Names follow `<source_id> <work-order-name> <local-date> <hh-mm-ss> <conclusion>.md`, omitting the first part when there's no `source_id`. **Existing results are never overwritten.**
- The adjacent `contract.v<version>.<first-seven-SHA-256-characters>.json` is the sealed contract used for that result.
- Both are readable copies; deleting them doesn't delete database records.
- A directory pipeline puts results under `results/<directory>/<work-order>/`.

Result labels use the project's `locale` from `bridge.json`. The header identifies the work order, version, and roles from the database, followed by the conclusion. Here is the result file from that run:

```markdown
---
source_id: DOC-1
title: Add a README to the project
source_file: .review-bridge/work-packages/add-readme.md
version_no: 1  # the sealed version this result is about, not the .md on disk now
contract_sha256: 8d086cae7ac4a9cb7202943d6ff17540235a0b0a6bed7ef4024161683c6e82e3
run_id: b8f6c4b8-44a9-4f23-8a08-12bae14a6110
commit: null  # plus uncommitted changes
writer:
  provider: claude
  model: null  # the CLI's own default
  effort: medium
reviewer:
  provider: codex
  model: null  # the CLI's own default
  effort: medium
  mcp: []
---

# Delivered

Work order: .review-bridge/work-packages/add-readme.md   run: b8f6c4b8-44a9-4f23-8a08-12bae14a6110   ended: 2026-11-10T04:45:02.056Z   calls: 1
Tests: not configured for this project; no test rule matched, so none ran

## Acceptance
- AC1 proven: README.md exists at the project root, with the project name on its first line. (reviewer: pass; evidence: fake: read the delta and the test output for AC1)
- AC2 proven: The README has a "Getting started" section. (reviewer: pass; evidence: fake: read the delta and the test output for AC2)
Checked on commit none plus uncommitted changes.

## Why
Verified by the reviewer:
- fake: read the delta
Not run by the reviewer:
- fake: project tests

## Next step
Look at the changed files below; commit yourself if you are satisfied. Write a new work order for further changes.

## Files changed
Work proof from Git, checked against the records Bridge wrote; any process running as the same user could have rewritten them.

- README.md（added）

### What the writer says it changed (not checked against Git)
- README.md（modified）

## Tokens
| role | calls | input | cache read | cache write | output | total | cost |
|---|---|---|---|---|---|---|---|
| contract | 0 | 0 | 0 | 0 | 0 | 0 |  |
| writer | 1 | 94 | 150346 | 454 | 2352 | 153246 | 0.4200 USD |
| reviewer | 1 | 29995 | 29995 | 0 | 410 | 60400 |  |
| graph lookups | 8 SQL | about 64 prompt tokens |  |  |  |  | estimated; already in the writer's and reviewer's input above, no cost of its own |
```

Evidence, tokens, and costs in this example are fixed fake-CLI values, not real model usage. The sample project was a fresh Git repository with no commits, so `commit` is `null` and the checked version says `none`. The new README is uncommitted.

See the [result-file reference](../reference/result-file) for each section. In particular:

- `version_no` is **the work-order version sealed for this run**.
- The first “Files changed” list comes from Git. Writer claims not checked against Git appear separately.
- The `contract` token row is always 0: code creates the contract without calling a model.
- **Successful results omit additional reviewer findings.** Extra advice accompanying a pass currently stays in the database and the review file named by `Latest review` in `status`, under `projects/<project_id>/reviews/…-reviewer-review.md` in the data home. Failed reviews include findings under “Why.”

## status

```text
Page: http://localhost:60999/
Database: running
Work: 0 running
  b8f6c4b8-44a9-4f23-8a08-12bae14a6110  completed    success          review_pass           .review-bridge/work-packages/add-readme.md  2026-11-10 12:45:00 +0800
Latest review: <data home>\projects\1c3df8e9-f699-4351-9b16-a9368eae3436\reviews\20261110T044501712Z-70e39aebb38d2801-reviewer-review.md
Roles: writer claude, reviewer codex
Logs: <log directory>\1c3df8e9-f699-4351-9b16-a9368eae3436
Database in VS Code: install Microsoft's PostgreSQL extension and add a connection with
  Server 127.0.0.1  Port 60998  User bridge  Database bridge
  Password: copy it from <data home>\postgres\secret
```

Each row shows the run ID, status, conclusion, stop reason, work-order path, and local time. Use `--after <run_id>` for the next ten records or `--json` for machine-readable output. `status` reports database state without starting it. Missing, unreadable, or invalid database directories are reported with their path and exit code 4, as in `pg_ctl status`.

## logs

Pass a work-order file or `source_id` to list its runs, newest first:

```text
Runs of .review-bridge/work-packages/add-readme.md, newest first:
  b8f6c4b8-44a9-4f23-8a08-12bae14a6110  2026-11-10 12:45:00 +0800  success          <log directory>\1c3df8e9-f699-4351-9b16-a9368eae3436\b8f6c4b8-44a9-4f23-8a08-12bae14a6110
```

Pass a run ID to see its log folder and what each file contains:

```text
Logs of run b8f6c4b8-44a9-4f23-8a08-12bae14a6110 (success): <log directory>\1c3df8e9-f699-4351-9b16-a9368eae3436\b8f6c4b8-44a9-4f23-8a08-12bae14a6110
  call 1   writer      write           stop_payload        20261110T044500402Z-rb8f6c4b8-stop-payload.json
  call 1   writer      write           prompt              20261110T044500402Z-rb8f6c4b8-writer-only-prompt.txt
  call 1   writer      write           stderr              20261110T044500402Z-rb8f6c4b8-writer.stderr.log
  call 1   writer      write           result              20261110T044500402Z-rb8f6c4b8-writer.stdout.json
  call 1   writer      write           stream              20261110T044500402Z-rb8f6c4b8-writer.stream.jsonl
  call 2   reviewer    review          stderr              20261110T044501712Z-70e39aebb38d2801-reviewer.stderr.log
  call 2   reviewer    review          stream              20261110T044501712Z-70e39aebb38d2801-reviewer.stdout.log
                       plan            plan                add-readme.plan.json
                       start           authorization_card  authorized-plan-bdfd3e153a8a9fe860c85c63185b9cf46bd3b1c4c832d011fafecea1ee847751.txt
                       result          result              b8f6c4b8-44a9-4f23-8a08-12bae14a6110.result.md
```

`logs` output is currently English-only. Each model call has a `call` number: this example has one writer call and one reviewer call, with no contract-creation call. Files outside a call include `result` (the original result file), `plan` (the sealed plan), and `authorization_card` (the card you approved).

The folder holds each model call's prompt, stream, and stderr, along with test output, the plan, and the authorization card you confirmed. These files live in the operating system's log directory, separate from the project. They are removed after the retention period (`retention.days` in `bridge.json`, 15 days by default) or when you run `clean <run_id>`.

## Storage locations

| Data | Location |
|---|---|
| Project settings, work orders, result copies | Project `.review-bridge/` |
| Personal `settings.json`, database, per-project state `projects/<project_id>/` | Data home: `%LOCALAPPDATA%\ReviewBridge` on Windows, `~/Library/Application Support/ReviewBridge` on macOS, `~/.local/share/review-bridge` on Linux; override with `REVIEW_BRIDGE_DATA_HOME` |
| Run logs `<project_id>/<run_id>/` | `%LOCALAPPDATA%\ReviewBridge\Log` on Windows, `~/Library/Logs/ReviewBridge` on macOS, `$XDG_STATE_HOME/review-bridge` (default `~/.local/state/review-bridge`) on Linux; `logs/` under `REVIEW_BRIDGE_DATA_HOME` when set |
| Backups | Data home's `backups/database` for `npx review-bridge backup`, and `backups/installer` for `upgrade` and `uninstall`. May contain private work data; don't publish |

**The database is the source of truth for execution records.** `projects/<project_id>/` holds working copies. Deleting logs or result files doesn't remove work-order versions, plans, authorizations, contracts, runs, events, verdicts, or deliveries from the database; original log files still follow their retention rules. PostgreSQL listens only on `127.0.0.1` and stays running after commands, terminals, or VS Code close. Stop it with `npx review-bridge down`; see [Database and local page controls](./start#database-and-page).

## Database in VS Code

Install Microsoft's PostgreSQL extension, or SQLTools with its PostgreSQL driver, then add a connection:

- Server: `127.0.0.1`
- Port: `5432`. If occupied, Bridge searches upward for the next available port each time the database starts.
- User: `bridge`
- Database: `bridge`
- Password: copy from `postgres/secret` under data home (Windows: `%LOCALAPPDATA%\ReviewBridge\postgres\secret`). Only your user account can read it.

`init` and `npx review-bridge status` print the current connection details and password-file location. To start searching from another port, add `"database": { "port": 5440 }` to `settings.json` in the data home. It takes effect on the next database start: after a reboot, a backup that stops and restarts it, or `down` followed by `up`.

## Backup

`npx review-bridge backup` uses PostgreSQL's file-level backup procedure: stop the database, copy the full folder including the password file, then restart it. Active runs prevent backups.

To restore, copy the backed-up `postgres` folder into an empty directory, point `REVIEW_BRIDGE_DATA_HOME` at that directory, and start Bridge.
