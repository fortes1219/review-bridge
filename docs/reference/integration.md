# Connect your existing tools

If you already use an issue tracker, scripts, or a custom dashboard, you can have it generate Bridge work orders, start work after a person approves it, and read the results back into your system.

rc3 supports three ways to connect:

| What you want to do | How to do it |
|---|---|
| Send work to Bridge | Generate a Markdown work-order file and start it through the CLI |
| Read status and results in a script | Parse the CLI's JSON output or the result file's YAML fields |
| Build reports, dashboards, or audit exports | Query the local PostgreSQL database directly |

These options are available now. **There's no HTTP API for external integrations yet**; one is planned for rc4.

## Turn an existing issue into a Bridge work order

Have your system write a work-order file to the project's `.review-bridge/work-packages/` folder. See [Your first work order](../guide/work-order) for the full format: YAML frontmatter contains settings, and blocks marked with `<!-- bridge:<key> -->` provide the requirements and contract content.

These fields are useful for integrations:

| Field | What it's for |
|---|---|
| `source_id` | The issue ID in your original system, such as Jira, Linear, or GitHub. It connects the records in both systems; it doesn't determine the Bridge work order's identity or execution rules |
| `priority` | The work's priority, used to apply the corresponding settings |
| `writer`, `reviewer` | The model and reasoning effort for each role |
| `budget` | The budget and execution limits for this work order, within the ceilings allowed by policy |

Once you set `source_id`, you'll find it in the result file's name and frontmatter, through `logs <source_id>`, and in the database's `work_order_versions.source_id` field. Use it to match Bridge runs to the original issue.

Keep work orders in the folder above. Any work-order path passed to `start` must be under the project's `.review-bridge/` directory.

## Get a person's approval before starting work

In an interactive terminal, `start` asks where work should stop, shows the plan card, and asks you to approve it. When called by an agent or script without an interactive terminal, it shows the card and stops at `Needs authorization`.

Without an interactive terminal, this takes two calls:

```sh
# Generate and show the plan card first
review-bridge start .review-bridge/work-packages/add-readme.md

# Show the card to a person and get approval before running this
review-bridge start .review-bridge/work-packages/add-readme.md --yes
```

`--yes` means a person has seen this plan and agreed to run it, with the script or agent passing along that approval. The authorization record is marked `authorized_via: agent`.

**That field records how approval was passed along. It doesn't verify that a person actually approved.** A CI job or scheduled workflow still needs a human approval step. Don't treat `--yes` as a way to skip it. Preventing an agent from answering on a person's behalf depends on the agent tool's own permission prompts.

### Separate planning from execution

Usually, `start` is all you need. If your integration needs to save a plan and wait for approval before running it, use these lower-level commands:

| Command | What it does |
|---|---|
| `work-plan <file> [--out <file>] [--json]` | Seal a plan without running it. By default, write `<name>.plan.json` to that execution's log directory and print the plan's SHA-256. Use `--out` to choose another location |
| `work-start --plan <file> --yes [--json]` | Run the specified plan after a person approves it. Add `--json` to get the run's status when it ends |
| `work-cancel --reason <text> [--run <run_id>]` | Revoke the active authorization for the specified run so work can't continue |
| `roles-check` | Check that the writer and reviewer CLIs are installed and signed in, without calling a model |

Prefix each command with `review-bridge`. Run `<command> --help` for the full options.

## Read status and results in your integration

Use the CLI's JSON output to update an issue's status or show execution progress. Choose the command for the information you need:

| Command | What you get |
|---|---|
| `status --json` | Local page information, the number of running jobs, the project's ten latest runs, the review queue, role settings, the log directory, and database connection details |
| `logs <run_id> --json` | The run's log directory and what each file is for |
| `logs <file \| source_id> --json` | Runs for a work order, newest first, ten per page. Use `--after <run_id>` for the next page |
| `work-status` | JSON containing the project's run list and details of the latest run |
| `clean --json`, `upgrade --json`, `uninstall --json`, `init --json`, `vscode --json` | The result of each operation |

### Fields in a run record

A run is one execution, identified by `run_id`. Run lists contain these basic fields:

| Category | Fields |
|---|---|
| Identity and source | `run_id`, `source_file`, `work_package_id` |
| Execution state | `status`, `conclusion`, `closed_reason` |
| Start and end times | `created_at`, `closed_at` |
| How approval was passed along | `authorized_via` |

The latest run also includes:

| Category | Fields |
|---|---|
| Work order and contract | `version_no`, `title`, `contract_sha256` |
| Execution mode | `execution_mode` |
| Writer | `writer_provider`, `writer_model`, `writer_effort` |
| Reviewer | `reviewer_provider`, `reviewer_model`, `reviewer_effort`, `reviewer_mcp` |
| Execution limits | `breakpoint`, `scope`, `budget`; each budget value also records its setting source |
| Tests and stop information | `test`, `timeout_at`, `last_stop` |

`status` tells you whether work is still running (`in_progress`) or has ended (`completed`). **Completed doesn't mean successful.** Check `conclusion` too: `success`, `failure`, `cancelled`, `timed_out`, or `action_required`. `closed_reason` gives a more specific reason for ending.

### Match a result file to the original issue

You can also parse the result file's YAML frontmatter. It includes `source_id`, `title`, `source_file`, `version_no`, `contract_sha256`, `run_id`, `commit`, `writer`, and `reviewer`. See the [result-file reference](./result-file) for field descriptions.

File names follow `<source_id> <work-order-name> <local-date> <hh-mm-ss> <conclusion>.md`. Existing results aren't overwritten. If the work order has no `source_id`, the issue ID at the start of the name is omitted.

## Check for success in a script

**An exit code alone doesn't tell you whether work was delivered.** A command can exit normally while Bridge is still waiting for approval or a human decision.

For example, displaying `Needs authorization` exits with code `0`, but work hasn't started. Once a run record exists, check `status` and `conclusion` as well. `action_required` means someone needs to intervene; it isn't success.

| Exit code | Meaning |
|---|---|
| `0` | The command exited normally. Work may have been delivered, or it may still need authorization, clarification, or contract confirmation |
| `1` | A writer, reviewer, or policy check failed |
| `2` | Invalid command arguments |
| `69` | A required resource, such as the database or work-proof data, is unavailable; corresponds to sysexits `EX_UNAVAILABLE` |
| `75` | The provider's quota is exhausted (`rate_limited`) |
| `76` | The token limit was exceeded, or usage couldn't be read |
| `77` | The writer timed out |
| `79` | Model output didn't match the required format, such as `contract_rejected` |
| `130` | Work was stopped with `stop` or Ctrl+C |

## Query the database for reports and dashboards

Bridge's PostgreSQL database is the source of truth for execution records. It listens only on the local address `127.0.0.1`. You can query it directly with SQL for reports, dashboards, or audit exports.

Run `review-bridge status` to get the host, port, user, database name, and password-file location. See [Database in VS Code](../guide/results#database-in-vs-code) for connection instructions. Result files are readable copies; detailed logs have a separate retention period. See [Results, logs, and the database](../guide/results).

### What each table stores

There are currently 16 application tables, plus `schema_migrations` to track database migrations.

| Table | Contents |
|---|---|
| `projects` | Project information; `project_id` matches the project ID in `bridge.json` |
| `work_orders`, `work_order_versions` | Work-order identity and version history; each version includes the original text, `content_sha256`, and `source_id` |
| `plans` | The full plan card (`body`) and `plan_sha256` |
| `authorizations`, `authorization_claims` | Who authorized work, when, how approval was passed along, and which plan it covered, plus records that ensure each authorization is used only once |
| `contracts` | Sealed contract content and its `sha256` |
| `policy_snapshots` | The policy in effect for a run and its hash |
| `runs`, `run_events` | Runs and their events, with event sequence numbers assigned by the database |
| `test_results` | Results of tests run by Bridge |
| `review_results`, `review_findings`, `review_verdicts` | Reviews, findings, and verdicts for individual acceptance criteria |
| `acceptance_rows`, `acceptance_decisions` | Results for each acceptance criterion and Bridge's overall decision |

### Useful queries

Replace the example issue ID `DOC-1` and run ID below with your own values.

Find runs for an issue in your original system, matching against the work-order version sealed for each run:

```sql
select r.run_id, r.status, r.conclusion, r.closed_reason, r.created_at
from runs r
join work_order_versions v
  on v.work_order_id = r.work_order_id
  and v.content_sha256 = r.content_sha256
where v.source_id = 'DOC-1'
order by r.created_at desc, r.run_id desc
limit 10;
```

See each acceptance criterion's result, review verdict, test status, and evidence for a run, in event order:

```sql
select sequence, ac_id, result, verdict, test, evidence
from acceptance_rows
where run_id = '2eb9dc50-f49d-4eae-95ed-e503a2fa5531'
order by sequence, ac_id;
```

Add up recorded token usage by project for runs that started this month:

```sql
select project_id, sum(tokens_used) as recorded_tokens
from runs
where created_at >= date_trunc('month', now())
group by project_id
order by project_id;
```

The last query groups runs by **when they started** and sums the usage recorded so far. It isn't a provider bill. If a run was interrupted or usage records are incomplete, check the result file's `partial` marker too.

### Read records without changing them directly

Use the migrations in your installed version's `review-bridge/service/database/migrations/` directory as the reference for column definitions. The schema may expand between release candidates, so check your version when writing queries.

To create or change work, use Bridge commands instead of running `insert`, `update`, or `delete` against the tables. Authorizations, contracts, and decisions need to go through Bridge's flow to preserve their relationships and supporting records.

## The planned HTTP API

rc4 is planned to add an HTTP API alongside the Vue interface, with Zod and oRPC defining data formats, types, and runtime validation. Work-order files, the CLI, and database queries will remain available, with the API as another integration option.
