# Result files

Each run writes a new result to `.review-bridge/results/<work-order-name>/`, named `<source_id> <work-order-name> <local-date> <hh-mm-ss> <conclusion>.md`. Existing files aren't overwritten. Directory pipelines use `results/<directory>/<work-order>/`. Fixed labels follow `bridge.json`'s `locale`, currently English or Traditional Chinese. See the [full example](../guide/results#result-files).

## Header: the work order and run

This header comes from the [captured English fake-CLI run](../guide/start#the-card), with `locale: en`. The sample repository has no commits yet, so `commit` is `null`:

```yaml
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
```

| Field | Meaning |
|---|---|
| `source_id` | Issue ID from frontmatter; omitted if not set |
| `title` | Work-order title, or `untitled` without a `# ` heading |
| `source_file` | Work-order path within the project |
| `version_no` | **The version sealed for this run**, unaffected by later file edits |
| `contract_sha256` | Contract SHA-256, matching the adjacent `contract.v<version>.<first-seven-characters>.json` |
| `run_id` | Execution ID for `logs <run_id>` and `clean <run_id>` |
| `commit` | Starting commit (`null` if there are no commits yet), annotated `plus uncommitted changes` when needed, or `unknown (no Git)` |
| `writer` / `reviewer` | Provider, model, and effort for this run; `null` uses the CLI default. Reviewer `mcp` lists allowed MCP servers |

These values come from Bridge's database. If it can't be read, the header explains why and marks values unknown, for example: “Bridge's database could not be read (…); every value below is unknown.”

## Title: the conclusion

| Title | `conclusion` | Meaning |
|---|---|---|
| `Delivered` | `success` | Reviewer passed the work and every acceptance condition is proven |
| `Needs fixing` | `action_required` | Correction rounds (`rounds`) are exhausted with unresolved issues |
| `Your decision needed` | `action_required` | A human choice is needed, such as a writer question, scope expansion, or a release action |
| `Stopped` | `cancelled` | `stop`, a newer work-order version (`superseded`), or loss of the database (`database_unavailable`) |
| `Cancelled` | `cancelled` | Authorization revoked with `work-cancel` |
| `Token ceiling exceeded` | `failure` | Writer per-call or per-run token limit, or unreadable writer usage |
| `Provider quota exhausted` | `failure` | The provider's available quota is used up |
| `Timed out` | `timed_out` | `run_timeout` reached |
| `Error` | `failure` / `timed_out` | Other errors; “Why” gives a reason code and log path |

For `database_unavailable`, “Why” explains that the database stopped responding during work, no model was called afterward, and you should start again once the database is back.

## Summary and tests

```text
Work order: <path>   run: <run_id>   ended: <UTC time>   calls: <writer calls>
Tests: not configured for this project; no test rule matched, so none ran
```

The test line can also be `Existing tests passed: <command>`, `Existing tests failed: <command> (exit <code>)`, or `Existing tests timed out: <command>`.

## Acceptance

Each acceptance criterion has its own row. The same captured run produced:

```text
- AC1 proven: README.md exists at the project root, with the project name on its first line. (reviewer: pass; evidence: fake: read the delta and the test output for AC1)
- AC2 proven: The README has a "Getting started" section. (reviewer: pass; evidence: fake: read the delta and the test output for AC2)
Checked on commit none plus uncommitted changes.
```

- Results are `proven`, `failed`, or `unknown`. Bridge decides each condition rather than simply copying the reviewer's verdict.
- `reviewer` is the reviewer's verdict for that condition.
- The last line identifies the checked version: the commit alone, the commit plus uncommitted changes, or `unknown (no Git)`.
- If the project graph couldn't be refreshed at the start, an extra line notes that both roles used the earlier graph.
- Runs stopped before review don't list acceptance decisions here.

Even with a reviewer pass, Bridge won't mark the work delivered unless every acceptance condition is `proven`. “Why” explains the reason.

## Why

This section explains the conclusion.

- **Delivered:** lists `Verified by the reviewer:` and `Not run by the reviewer:`. **Extra findings accompanying a pass aren't included here yet.** They remain in the database and the review file identified by `Latest review` in `status`.
- **Not delivered:** lists the last review's findings (`<id> (<severity>) <path>:<line>: <claim> -> <fix>`), failed test commands and stderr tail, `The writer asks you:`, `What the writer says it could not check:`, and the stop reason.

## Work order changed after the start

Appears when the work-order file changed after the run began. Bridge judges the version sealed at the start; the listed edits **were not used for this run**. Run `start` again to use them. A deleted or unreadable work order is also reported here.

## Next step

Next steps depend on the result: inspect changes and decide whether to commit after success; wait for provider quota before another `start`; fix the work order or code based on findings; write answers to writer questions into the work order before restarting; or split timed-out work into smaller orders, or raise `budget.run_timeout` within policy limits.

## Files changed

Work proof is split into three lists, omitted when there is nothing to show:

1. **Files changed:** actual Git changes (`added`, `modified`, `deleted`), checked against Bridge's records. The opening note states that any process running as the same user could rewrite those records. No changes produces `No files were changed.`
2. **What the writer says it changed (not checked against Git):** the writer's own report.
3. **Already uncommitted when the run started:** pre-existing edits, not attributed to this run.

Scope issues add “Changes outside the allowed scope” or “Changes outside the scope that could not be attributed to this run.” Without Git, this section says no work proof is available. If history is rewritten or the branch changes during execution, Bridge stops rather than continuing the comparison.

## Tokens

| Column | Meaning |
|---|---|
| role | `contract`, `writer`, `reviewer`, plus `graph lookups` when used |
| calls | Number of calls |
| input / cache read / cache write / output / total | Usage reported by the CLI, including writer subagents |
| cost | Shown only when the CLI reports it |

- `contract` is always 0: code copies the work order into a contract without calling a model.
- `graph lookups` records Bridge's SQL queries and estimated tokens added to prompts. Those tokens are already included in writer and reviewer input, not an extra charge.
- If usage can't be read for some calls, the role's calls column shows `N (M unreadable)` and the other columns show `unknown`. Partial totals aren't presented as complete. Unreadable writer usage prevents another call because Bridge can't verify the budget still holds.

## JSON output

- `npx review-bridge status --json`: local page, roles, database connection, and the project's latest ten runs. Each has `run_id`, `status`, `conclusion`, `closed_reason`, `created_at`, `closed_at`, `updated_at`, `source_file`, `work_package_id`, and `authorized_via`. Use `--after <run_id>` for the next page.
- `npx review-bridge work-status`: the same run list plus `latest_run` details: `work_order_id`, `version_no`, `title`, `contract_sha256`, `execution_mode`, `writer_provider`/`writer_model`/`writer_effort`, `reviewer_provider`/`reviewer_model`/`reviewer_effort`/`reviewer_mcp`, `breakpoint`, `scope`, `budget` with sources, `test`, `timeout_at`, `authorized_by`, `authorized_via`, and `last_stop`.
- `npx review-bridge logs <run_id|file> --json`: run fields match `work-status`.
