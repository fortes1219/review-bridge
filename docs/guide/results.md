# Results, logs, and the database

After a run ends, you can inspect it in three places: the project's **result file**, the **execution logs**, and the database's **events and decisions**. The IDs at the top of the result file connect these records.

## Result files

Each run produces one file in the work order's own folder:

```text
.review-bridge/results/<work-order-name>/
  DOC-1 add-readme 2026-11-06 07-31-29 success.md
  contract.v1.7189c52.json
```

- File names follow `<source_id> <work-order-name> <local-date> <hh-mm-ss> <conclusion>.md`. The first part is omitted if the work order has no `source_id`. **Existing results are never overwritten.**
- The adjacent `contract.v<version>.<first-seven-SHA-256-characters>.json` is the sealed contract used for that result.
- Both files are copies for you to read. Deleting them does not delete the records in Bridge's database.

The header identifies the work order, version, and roles from the database, followed by the conclusion. The captured examples on this page use a Chinese work order; CLI output is kept as captured.

```markdown
---
source_id: DOC-1
title: 幫專案補一份 README
source_file: .review-bridge/work-packages/add-readme.md
version_no: 1  # the sealed version this result is about, not the .md on disk now
contract_sha256: 7189c52c…
run_id: 2eb9dc50-f49d-4eae-95ed-e503a2fa5531
commit: 8c96ab0e…
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

Work order: .review-bridge/work-packages/add-readme.md   run: 2eb9dc50-…   ended: 2026-11-05T23:31:29.742Z   calls: 1
Tests: not configured for this project; no test rule matched, so none ran

## Acceptance
- AC1 proven: 根目錄有 README.md，第一行是專案名稱。 (reviewer: pass; tests: not used; evidence: …)
- AC2 proven: README 裡有一段「如何啟動」。 (reviewer: pass; tests: not used; evidence: …)
Checked on commit 8c96ab0e483f.

## Why
Verified by the reviewer:
- …
Not run by the reviewer:
- …

## Next step
Look at the changed files below; commit yourself if you are satisfied. Write a new work order for further changes.

## Files changed
Work proof from Git, checked against the records Bridge wrote; …

### What the writer says it changed (not checked against Git)
- README.md（modified）

## Tokens
| role | calls | input | cache read | cache write | output | total | cost |
|---|---|---|---|---|---|---|---|
| writer | 1 | … |
```

See the [result-file reference](../reference/result-file) for each section. In particular, `version_no` refers to **the work-order version sealed for that run**. The first list under “Files changed” comes from Git; writer claims that have not been checked against Git appear separately.

## status

```text
Page: http://localhost:8080/
Work: 0 running
  2eb9dc50-f49d-4eae-95ed-e503a2fa5531  completed    success          review_pass           .review-bridge/work-packages/add-readme.md  2026-11-06 07:31:29 +0800
Review queue: pending 0, running 0, done 1, failed 0
Latest review: <data home>/projects/<project_id>/reviews/20261105T233129644Z-…-reviewer-review.md
Roles: writer claude, reviewer codex
Logs: <log directory>/<project_id>
Database in VS Code: install Microsoft's PostgreSQL extension and add a connection with
  Server 127.0.0.1  Port 5432  User bridge  Database bridge
  Password: copy it from <data home>/postgres/secret
```

Each row shows a run ID, status, conclusion, reason, work order, and local time. Use `--after <run_id>` for the next ten records, or `--json` for machine-readable output.

## logs

Pass a work-order file or `source_id` to list its runs, newest first:

```text
Runs of .review-bridge/work-packages/add-readme.md, newest first:
  2eb9dc50-f49d-4eae-95ed-e503a2fa5531  2026-11-06 07:31:29 +0800  success          <log directory>/<project_id>/2eb9dc50-…
```

Pass a run ID to see its log folder and what each file contains:

```text
Logs of run 2eb9dc50-… (success): <log directory>/<project_id>/2eb9dc50-…
  call 1   writer      translate       prompt              …-contract-prompt.txt
  call 1   writer      translate       result              …-contract.result.json
  call 1   writer      translate       stderr              …-contract.stderr.log
  call 1   writer      translate       stream              …-contract.stream.jsonl
  call 2   reviewer    contract_check  prompt              …-contract-check-prompt.txt
  …
  call 3   writer      write           prompt              …-writer-only-prompt.txt
  call 3   writer      write           result              …-writer.stdout.json
  call 4   reviewer    review          stream              …-reviewer.stdout.log
                       result          result              2eb9dc50-….result.md
                       plan            plan                add-readme.plan.json
                       start           authorization_card  authorized-plan-….txt
```

The folder holds each model call's prompt, stream, and stderr, along with test output, the plan, and the authorization card you confirmed. These files live in the operating system's log directory, separate from the project. They are removed after the retention period (`retention.days` in `bridge.json`, 15 days by default) or when you run `clean <run_id>`.

## Storage locations

| Data | Location |
|---|---|
| Project settings, work orders, and result copies | The project's `.review-bridge/` |
| Personal settings (`settings.json`), the database, and per-project runtime state (`projects/<project_id>/`) | Data home: Windows `%LOCALAPPDATA%\ReviewBridge`, macOS `~/Library/Application Support/ReviewBridge`, Linux `~/.local/share/review-bridge`. Override with `REVIEW_BRIDGE_DATA_HOME`. |
| Per-run logs (`<project_id>/<run_id>/`) | Windows `%LOCALAPPDATA%\ReviewBridge\Log`, macOS `~/Library/Logs/ReviewBridge`, Linux `$XDG_STATE_HOME/review-bridge` (`~/.local/state/review-bridge`). With `REVIEW_BRIDGE_DATA_HOME`, logs go in its `logs/` subfolder. |
| Backups | `backups/database` under data home for `review-bridge backup`; `backups/installer` for `upgrade` and `uninstall`. These can contain private work data; do not publish them. |

**The database is the source of truth for run records.** `projects/<project_id>/` holds the working copies. Deleting logs or result files does not delete database records for work-order versions, plans, authorizations, contracts, runs, events, verdicts, or deliveries. Raw log files are still subject to retention. The database listens only on `127.0.0.1` and currently stays running between commands.

## Database in VS Code

Install Microsoft's PostgreSQL extension, or SQLTools with its PostgreSQL driver, then add a connection:

- Server: `127.0.0.1`
- Port: `5432`. If occupied, Bridge searches upward for the next available port each time the database starts.
- User: `bridge`
- Database: `bridge`
- Password: copy from `postgres/secret` under data home (Windows: `%LOCALAPPDATA%\ReviewBridge\postgres\secret`). Only your user account can read it.

The end of `init` and `review-bridge status` shows the current connection details and password-file location. To start searching from another port, add `"database": { "port": 5440 }` to data home's `settings.json`. This takes effect the next time the database starts, after a reboot or a `review-bridge backup` (which stops and restarts it).

## Backup

`review-bridge backup` uses PostgreSQL's file-level backup procedure: stop the database, copy the entire folder including data and the password file, then restart it. Backup is refused while work is running.

To restore, copy the backed-up `postgres` folder into an empty directory, point `REVIEW_BRIDGE_DATA_HOME` at that directory, and start Bridge.
