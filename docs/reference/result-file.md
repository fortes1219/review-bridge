# Result files

Each run creates a result in `.review-bridge/results/<work-order-name>/`, named `<source_id> <work-order-name> <local-date> <hh-mm-ss> <conclusion>.md`. Existing results are not overwritten. Bridge currently outputs result files in English. This page explains each section; the header example uses a Chinese work order.

## Header: the work order and run

```yaml
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
```

| Field | Description |
|---|---|
| `source_id` | The ID in the work order's frontmatter; omitted if unset. |
| `title` | Work-order title. |
| `source_file` | Work-order path within the project. |
| `version_no` | **The work-order version sealed for this run.** Later edits do not change the version this result refers to. |
| `contract_sha256` | The contract's SHA-256, matching the adjacent `contract.v<version>.<first-seven-characters>.json`. |
| `run_id` | The execution ID used by `logs <run_id>` and `clean <run_id>`. |
| `commit` | Starting commit. Adds `plus uncommitted changes` if needed; without Git, shows `unknown (no Git)`. |
| `writer` / `reviewer` | The provider, model, and effort used for the run. `null` means the CLI's default model. The reviewer's `mcp` lists its allowed MCP servers. |

These values come from Bridge's database. If it cannot be read, the header explains why and values are marked unknown.

## Title: the conclusion

| Title | `conclusion` | Meaning |
|---|---|---|
| `Delivered` | `success` | Review passed and evidence supports every acceptance criterion. |
| `Needs fixing` | `action_required` | The correction-round limit (`rounds`) was reached with unresolved issues. |
| `Your decision needed` | `action_required` | A human decision is needed, for example an ambiguous work order, out-of-scope changes, data deletion, a package change, or a release action. |
| `Stopped` | `cancelled` | You ran `stop`, a new work-order version superseded this run, or the database disconnected. |
| `Cancelled` | `cancelled` | Authorization was canceled. |
| `Token ceiling exceeded` | `failure` | A per-call or per-run token ceiling was exceeded, or usage could not be read. |
| `Provider quota exhausted` | `failure` | The provider's available quota was exhausted. |
| `Timed out` | `timed_out` | The run reached `run_timeout`. |
| `Error` | `failure` / `timed_out` | Another error; see Why for its reason code and log path. |

## Summary and tests

```text
Work order: <path>   run: <run_id>   ended: <UTC time>   calls: <model call count>
Tests: not configured for this project; no test rule matched, so none ran
```

The test line can show `Existing tests passed: <command>`, `Existing tests failed: <command> (exit <code>)`, `Existing tests timed out: <command>`, or `Tests: not configured…`.

## Acceptance

Each acceptance criterion has its own row:

```text
- AC1 proven: <criterion text> (reviewer: pass; tests: not used; evidence: <reviewer evidence>)
Checked on commit 8c96ab0e483f.
```

- Result: `proven`, `failed`, or `unknown`.
- `reviewer`: the reviewer's verdict on this criterion.
- `tests`: `passed`, `failed`, `not run`, or `not used` (the criterion does not depend on tests).
- The final line identifies the checked version: `Checked on commit …`, `… plus uncommitted changes`, or `Version checked: unknown (no Git)`.

Even with a reviewer pass, Bridge does not mark the work as successfully delivered if any criterion lacks evidence. Why explains the decision.

## Why

This section explains the conclusion. For a successful delivery, it lists `Verified by the reviewer:` and `Not run by the reviewer:`.

Otherwise, it includes the last review's findings (`<id> (<severity>) <path>:<line>: <claim> -> <fix>`), failed test commands and the end of stderr, questions under `The writer asks you:`, limitations under `What the writer says it could not check:`, and the reason work stopped.

## Work order changed after the start

Appears when the work-order file changed after the run began. Bridge judges the version sealed at the start; the listed edits **were not used for this run**. Run `start` again to use them. A deleted or unreadable work order is also reported here.

## Next step

Suggests what to do next: inspect changes and decide whether to commit after success; wait for a quota reset if exhausted; address findings using Why; or reduce the work order's size or raise `budget.run_timeout` within the allowed limits after a timeout.

## Files changed

Work proof is split into three lists, omitted when there is nothing to show:

1. **Files changed**: changes read from Git (`added`, `modified`, `deleted`) and checked against Bridge's records. The opening note states a limitation: processes running as the same user can still modify those records. With no changes, it prints `No files were changed.`.
2. **What the writer says it changed (not checked against Git)**: the writer's claims, not checked against Git.
3. **Already uncommitted when the run started**: changes that existed before this run, not attributed to its work.

Scope issues also produce `Changes outside the allowed scope` or `Changes outside the scope that could not be attributed to this run`. Without Git, the section only says `No work proof: …`. If Git history is rewritten or the branch changes during the run, Bridge stops rather than continuing the comparison.

## Tokens

| Column | Description |
|---|---|
| role | `writer`, `reviewer`, `contract translation` (writer extracts criteria), or `contract check` (reviewer checks the contract). |
| calls | Number of calls. |
| input / cache read / cache write / output / total | Usage totals reported by the CLI, including the writer's sub-agents. |
| cost | Present only if the CLI reports a cost. |

A call that did not finish normally because it was stopped, timed out, or interrupted has usage marked `partial`. With incomplete usage, Bridge cannot confirm that token ceilings held.

## JSON output

`review-bridge status --json`, `review-bridge logs <run_id|file> --json`, and `review-bridge work-status` expose the same JSON fields: `run_id`, `status`, `conclusion`, `closed_reason`, `created_at`, `closed_at`, `source_file`, `work_package_id`, and `authorized_via` for each run.

The latest record also includes `version_no`, `title`, `contract_sha256`, `execution_mode`, `writer_provider` / `writer_model` / `writer_effort`, `reviewer_provider` / `reviewer_model` / `reviewer_effort` / `reviewer_mcp`, `breakpoint`, `scope`, `budget` (including each value's source), `test`, `timeout_at`, and `last_stop`.
