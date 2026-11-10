# Review Bridge

![Review Bridge — AI work audit and verification harness](docs/public/readme-cover.png)

Review Bridge is an AI work audit and verification harness. It runs your work orders with a writer agent and an independent, read-only reviewer. You approve the plan; Bridge enforces the scope, budget, test command, and stopping point. The agents can't change those limits.

## Get started

```sh
cd your-project
npx review-bridge init
```

There's no need to install Bridge globally. Commands printed by Bridge use the same `npx review-bridge …` form. If you prefer a global install, run `npm i -g review-bridge`; `npx` will then use that copy.

Read the [documentation](https://review-bridge.akasa-lab.dev/) in English, Japanese, or Traditional Chinese.

## What `init` does

`init` asks four questions. Press Enter to accept each default:

1. **Writer:** `claude` or `codex`. Uses your saved default, or `claude` if you haven't set one.
2. **Reviewer:** uses your saved default, or `codex`.
3. **Project type:** uses the type detected in the current folder, or `none`.
4. **VS Code tasks:** asks whether to add them to the project. The default is no.

Bridge then sets up the current folder and prints the commands to run next. It:

- Creates `.review-bridge/` with project settings (`bridge.json`, `policy.override.json`, `rules.md`) and work-order templates (`TEMPLATE.md` in English and `TEMPLATE.zh-TW.md` in Traditional Chinese). The folder has its own `.gitignore` containing `*`, which keeps its contents, including results, out of Git even if you initialize Git later. Your project's `.gitignore` stays unchanged.
- Runs four self-tests with fake CLIs (`PASS`, `FAIL_THEN_PASS`, `HARD_STOP`, `RATE_LIMIT`). None calls a model.
- Starts the local page on `127.0.0.1`.
- Installs a user-level entry point for each agent, shared across projects: `~/.claude/commands/review-bridge.md` for Claude Code (`/review-bridge`, respecting `CLAUDE_CONFIG_DIR`) and `~/.agents/skills/review-bridge/SKILL.md` for Codex (`$review-bridge`). Existing files at those paths are left alone. Uninstalling the last configured project removes Bridge's entries unless you've edited them.

Within the project, Bridge writes only to `.review-bridge/`, so setup leaves `git status` clean. It doesn't edit application files, `.gitignore`, `AGENTS.md`, `CLAUDE.md`, or `.claude/`. If you opt in to [VS Code tasks](#in-vs-code), it also updates `.vscode/tasks.json`.

Use `--writer`, `--reviewer`, `--profile <type|none>`, or `--target <folder>` to supply answers as options. Without an interactive terminal, or with `--yes`, setup uses the defaults without prompting.

The project type selects the test command Bridge runs after each writer call, such as `npm test`. Choosing `none`, or having no matching test command, doesn't prevent work from starting. The card, run records, and result file explicitly say that tests aren't configured.

## Requirements

- Node.js 22.8 or newer, with npm.
- Git for work proof. Bridge can run without Git, but the result will say no work proof is available. With Git, Bridge records the starting commit and reads the actual changes from Git.
- The `claude` and/or `codex` CLI, installed and signed in for the roles you choose.

## Your first work order

Copy the template, then describe the work and its acceptance criteria in any language:

```sh
cp .review-bridge/work-packages/TEMPLATE.md .review-bridge/work-packages/add-readme.md
```

In Claude Code, enter:

```text
/review-bridge start .review-bridge/work-packages/add-readme.md
```

In Codex, use `$review-bridge start .review-bridge/work-packages/add-readme.md`.

The agent runs `start`. Bridge checks the required work and acceptance blocks, copies them into a contract, and splits the acceptance list into individual conditions. This is all done in code, without calling a model. It then seals the work order, contract, scope, budget, and test command into a plan, shows a card identifying the contract, and stops at `Needs authorization`.

The agent shows you the full card and reruns the command with `--yes` only after you approve it. That one approval starts the run. Bridge checks the reviewer's read-only restrictions once per local page session, then continues without further questions. The authorization record notes that your approval came through an agent.

During execution, Bridge prints one line per step, with a spinner in an interactive terminal. Each run produces a new result file in `.review-bridge/results/<work order file>/`, named `<source_id> <work order file> <local date> <hh-mm-ss> <conclusion>.md`. For example: `results/queue-summary/CANARY-1 queue-summary 2026-11-03 23-48-12 success.md`. The `source_id` prefix is omitted when the work order has none. Existing results are never overwritten.

The sealed contract appears beside the result as `contract.v<version>.<short SHA-256>.json`. The result header identifies the work order's `source_id`, title, file, sealed version, contract SHA-256, run ID, and checked commit, using records from Bridge's database. The version refers to what was sealed for that run, even if you've since edited the work order.

Result files and contract files are readable copies; deleting them doesn't remove the database records. Bridge never commits, pushes, or deploys.

Both agent entry points support the same four actions as the CLI: `start <file>`, `stop <run_id>`, `resume <run_id>`, and `clean [<run_id>]`.

### In VS Code

Run Bridge commands as VS Code tasks: open Quick Open and type `task review-bridge`, or choose **Terminal > Run Task**. The six tasks are `review-bridge: start`, `stop`, `resume`, `clean`, `status`, and `logs`. The start task uses the file open in the editor; the others prompt for a run ID or file as needed. They use the integrated terminal, where you can approve the card.

| Location | How to add tasks | Available in |
|---|---|---|
| Project `.vscode/tasks.json` | Opt in during `init`, or run `npx review-bridge vscode` | This project |
| User tasks (`Tasks: Open User Tasks`) | Run `npx review-bridge vscode --user` | All your projects |

You decide whether to commit or ignore `.vscode/tasks.json`; Bridge does neither. Until you do, Git counts it as a change, and run results note that the starting commit had uncommitted changes.

Bridge manages only tasks labeled `review-bridge:` and inputs whose IDs start with `review-bridge-`. Other tasks, inputs, comments, and formatting stay intact. `uninstall` removes Bridge's entries and deletes the file only if nothing else remains. User-level tasks stay until you uninstall the last configured project. If a file can't be read or doesn't use tasks version 2.0.0, Bridge leaves it alone and explains why.

User-level tasks apply to VS Code's default profile. Other profiles, VS Code Insiders, VSCodium, and portable installations store tasks elsewhere; use project-level tasks for those. In a multi-root workspace, a user task runs in the first folder, which may differ from the folder containing your work order.

### At a terminal (advanced use and CI)

You can also run the four actions directly. In an interactive terminal, `start` asks where work should stop, displays the card, and prompts `Start this work? [y/N]`.

| Action | Command |
|---|---|
| Start a work order | `npx review-bridge start <file>` |
| Run a directory of work orders in sequence | `npx review-bridge start .review-bridge/work-packages/<directory>/` |
| Pause a run and keep its records | `npx review-bridge stop <run_id>` |
| Resume a stopped work order | `npx review-bridge resume <run_id>` |
| Clear finished records | `npx review-bridge clean [<run_id>]` |

Use `npx review-bridge status` to see running work and run IDs.

## Work order format

A work order is a Markdown file with optional frontmatter, a title, and marked blocks for contract fields. Bridge copies each block's text into the matching field and splits the acceptance list into numbered conditions. No model is involved. If another tool generates your work orders, use the format below.

### Frontmatter

Bridge reads the frontmatter as YAML when it plans the work. Start it on the first line with `---` and end it with another line containing only `---`. You can omit the frontmatter entirely; all keys you supply yourself are optional.

```yaml
---
priority: high              # low / medium / high / urgent; default: the policy's priority.default
writer:                     # the writer's model and effort, over the policy's priority table
  model: gpt-5.6-sol        # must be the writer's CLI's; null is that CLI's own default
  effort: high              # low / medium / high
reviewer: { model: opus, effort: medium }   # the same for the reviewer
budget:                     # each key optional; default: the policy's limit of the same name
  tokens: 2000000           # limits.tokens
  tokens_per_call: 150000   # limits.tokens_per_call
  call_timeout: 1200000     # limits.call_timeout, milliseconds
  test_timeout: 600000      # limits.test_timeout, milliseconds
  run_timeout: 7200000      # limits.run_timeout, milliseconds
  rounds: 2                 # limits.rounds
source_id: SHOP-412         # your own tracker's id; Bridge stores it and never reads it
---
```

- **Bridge manages the work-order ID.** After your first approval, it writes `id: <uuid>` at the top of the frontmatter. Keep that line. Renaming or moving the file, or changing its step number, doesn't change its identity; editing its contents creates a new version. A file without an ID is a new work order. A copy containing another file's ID gets its own. The ID line is excluded from the sealed text and contract hash.
- Unknown keys are rejected with their line numbers. Invalid values are also rejected: an unsupported priority or effort, a budget value that isn't a positive integer, or a value above the policy ceiling. The error identifies the relevant limit.
- `writer` settings apply to implementation and each correction; `reviewer` settings apply to each review. Omitted values come from the policy's priority table. Choose the provider for each role in `bridge.json`, or with `--writer` and `--reviewer` for a single run. The card shows the selected providers.
- A model must match its role's CLI, or Bridge rejects the work order before showing the card. For `claude`, use an alias (`fable`, `opus`, `sonnet`, `haiku`) or a name containing `claude-`. For `codex`, use a name starting with `gpt-`, `codex-`, or `o` followed by a digit. To use a model from a custom Codex provider, configure it in Codex and omit `model` here.
- Top-level `effort` is still accepted as `writer.effort`. Specifying both is rejected.
- Settings take precedence in this order: CLI flags (`--rounds`, `--call-timeout`), work order, policy priority table for model and effort, then policy limits. The plan records each value and its source (`cli`, `work_order`, `priority`, `config`); the card shows both.
- `tokens` and `tokens_per_call` limit the writer's usage. They count new input, cache writes, and output. Cache reads appear separately in the result's token table and don't count against the budget. Reviewer usage is also recorded, but isn't subject to a token budget.
- `run_timeout` limits the whole run, like a GitHub Actions job's `timeout-minutes`. The default is 6 hours. At the limit, Bridge closes the run with `conclusion: timed_out` and `closed_reason: run_timeout`. Each call's timeout is capped by the remaining run time.

### Body

```markdown
# Checkout total is not recalculated after a discount code

<!-- bridge:context -->
## Background
The API answers 200 after a discount code is entered, but the total still shows the full price.

<!-- bridge:requested_work -->
## Work
Fix the total in CheckoutSummary so it is recalculated once a discount is applied.

<!-- bridge:acceptance -->
## Acceptance
- After a valid discount code, the total shows the discounted amount within one second.
- After an invalid code, the total is unchanged and an error message is shown.
```

- The first line starting with `# ` is the title. Without one, the title is `untitled`; results go in `results/untitled/` and use the work-order file name.
- A block starts at its `<!-- bridge:<key> -->` marker and ends at the next marker or the end of the file. `##` headings are for readers and can use any language; Bridge doesn't parse them as field names.
- There are exactly 17 recognized keys: `context`, `outcome`, `requested_work`, `run_plan`, `scope_notes.include`, `scope_notes.exclude`, `scope_notes.must_keep`, `scope_notes.expected_locations`, `acceptance`, `verification_hints`, `reproduction.environment`, `reproduction.steps`, `reproduction.actual`, `reproduction.expected`, `reproduction.frequency`, `references`, and `open_questions`. Unknown or duplicate keys are rejected with their line numbers.
- Two blocks are required: `requested_work` (or a `run_plan`) and `acceptance`. Other blocks are copied when present and left empty when omitted. The next section explains how missing required blocks are handled.
- An empty `open_questions` block, or one containing only `none` or `無`, means there are no open questions. Any other line is treated as an unanswered question, and `start` stops before the card until you answer it in the work order.
- Frontmatter, the title, markers, `##` and `###` headings, and blank lines are structure. Other text outside all marked blocks is preserved in the contract as unused lines.

### From work order to contract

Contract creation validates a form; it doesn't ask a model to interpret your request. No model is called, and contract creation shows 0 tokens in the result's token table. Bridge copies each marked block into its matching contract field and parses the acceptance list using markdown-it, the Markdown parser used by VitePress. Each item in the outermost list, including its nested content, becomes one acceptance condition.

Use Markdown list markers: `- `, `* `, `+ `, or a numbered marker such as `1. `. Formats such as `一、` and `（1）` aren't Markdown list markers. Bridge rejects those lines and explains the accepted format.

If a required block is missing or empty, or an acceptance-list line isn't a valid item, `start` lists the problems and stops before the card. If you've removed a required block's marker, Bridge appends the marker and heading to the work order without changing your existing text. Fill in the block and run `start` again.

For a directory, Bridge checks every work order before showing the card and reports all incomplete ones together. One incomplete work order prevents the whole pipeline from starting. The writer also rejects any contract missing work instructions or an acceptance condition, regardless of how it was created.

### Run plan

Use a run plan only when the work is organized into two or more runs. Each `### ` heading names a run. Within it, four fixed keys are read as YAML; other lines describe the work:

```markdown
<!-- bridge:run_plan -->
## Run plan
### RUN A
Plant the trees.
- effort: low
- acceptance:
  - Trees show on the map.

### RUN B
Add the cart.
- depends_on: RUN A
- budget: { rounds: 1, call_timeout: 600000 }
- acceptance:
  - The cart drives with the arrow keys.
```

- `effort` and `budget` use the same values as in frontmatter. `depends_on` accepts one run name or a list such as `[RUN A, RUN B]`. Unknown run names and dependency cycles are rejected.
- Indented items under `acceptance` define that run's conditions. The work order's main `acceptance` block describes the results across runs. A run plan containing only one run is rejected.
- Bridge records the run plan in the contract. It still creates one execution run for the entire work order.

## Commands

<!-- commands:start -->
<!-- Generated by scripts/render-commands.mjs from review-bridge/router/index.mjs; edit the table, not this section. -->

```text
Usage: review-bridge <command> [options]

Commands:
  init                    Set up Review Bridge in this folder: asks for the writer, the reviewer and the project type
  start <file|directory>  Run a work order, or a directory of them in file name order: plan it, check the reviewer can only read, show what you authorize, ask once, then run it
  stop <run_id>           Pause a running work order: its model process is stopped and its records are kept (resume <run_id> carries it on)
  resume <run_id>         Carry on a stopped work order: a new run of the same work order with the same stop point and scope; its roles, models, effort and budget are settled again, and the same card and yes as start show them
  clean [<run_id>]        Clear records: without a run id, fold finished runs into day files and drop what is past retention; with one, remove that finished run (a running one is refused)
  status                  Show what Bridge is doing now: the page, this project's runs, and how to look at the database
  logs <run_id|file>      Show a run's log folder and what each file in it is; for a work order (its file or source_id), its runs newest first
  up                      Start the database and the local page service in the background
  down                    Stop the local page service and the database; refused while a run is running
  ps                      Show whether the local page service is running, and its address
  watch                   Run the local page in this terminal until Ctrl+C
  upgrade                 Move this folder's setup to the installed Review Bridge version, with a backup
  uninstall               Remove Review Bridge from a folder, with a backup (Review Bridge itself: npm uninstall -g review-bridge)
  doctor                  Check which platform adapter this machine uses, without running any work
  backup                  Copy your database, for all your projects, with the database stopped (refused while a run is running)

Options:
  -v, --version   Print the version
  -h, --help      Print this help; --help --all also lists the commands for agents and scripts

Run review-bridge <command> --help for a command's options.
Update Review Bridge: npx review-bridge takes the latest version by itself; a global install updates with npm i -g review-bridge@latest
Remove Review Bridge: npm uninstall -g review-bridge
```

### init

```text
Usage: review-bridge init [options]

Set up Review Bridge in this folder: asks for the writer, the reviewer and the project type

Afterwards you start work through your agent: in Claude Code type /review-bridge start <file>; in Codex, $review-bridge start <file>. review-bridge start <file> at a terminal is for advanced use and CI.

Options:
  --target <folder>
      Set up this folder instead (string; default: the current folder)
  --writer <claude|codex>
      Writer role (string; default: your saved default, else claude)
  --reviewer <claude|codex>
      Reviewer role (string; default: your saved default, else codex)
  --profile <type|none>
      Project type; its test command becomes the tests a run executes (string; default: what detection finds, else none)
  --port <n>
      Port of the local page (number; default: 8080, or the next free port)
  --yes
      Ask nothing; use the defaults (boolean)
  --json
      Ask nothing; print the result as JSON (boolean)

1 more option(s) for tests and agents: review-bridge init --help --all
```

### start

```text
Usage: review-bridge start <file|directory> [options]

Run a work order, or a directory of them in file name order: plan it, check the reviewer can only read, show what you authorize, ask once, then run it

Options:
  --writer <claude|codex>
      Writer for this run only; the card shows it (string; default: the writer in bridge.json)
  --reviewer <claude|codex>
      Reviewer for this run only; the card shows it (string; default: the reviewer in bridge.json)
  --breakpoint <text>
      Where the work stops and comes back to you (string; default: after the review, asked at a terminal)
  --allow-paths <list>
      Limit the work to these paths, comma-separated (string; default: the whole project except protected files)
  --owner <name>
      Who owns the work (string; default: your OS user name)
  --work-package <id>
      Name of the work package (string; default: the work order's file name)
  --rounds <n>
      Writer rounds this work may use; comes before the work order's budget (number; default: the work order's budget, else the policy limit)
  --call-timeout <ms>
      Milliseconds each writer call may run; comes before the work order's budget (number; default: the work order's budget, else the policy limit)
  --update <work_order_id>
      Make this a new version of that work order (string; default: what Bridge finds, shown on the card)
  --as-new
      Make this a new work order (boolean)
  --yes
      The person said yes to the card; an agent adds this after showing them the card (boolean)
  --project <folder>
      The project folder (string; default: the current folder)

2 more option(s) for tests and agents: review-bridge start --help --all
```

### stop

```text
Usage: review-bridge stop <run_id> [options]

Pause a running work order: its model process is stopped and its records are kept (resume <run_id> carries it on)

Options:
  --project <folder>
      The project folder (string; default: the current folder)
```

### resume

```text
Usage: review-bridge resume <run_id> [options]

Carry on a stopped work order: a new run of the same work order with the same stop point and scope; its roles, models, effort and budget are settled again, and the same card and yes as start show them

Options:
  --writer <claude|codex>
      Writer for this run only; the card shows it (string; default: the writer in bridge.json)
  --reviewer <claude|codex>
      Reviewer for this run only; the card shows it (string; default: the reviewer in bridge.json)
  --yes
      The person said yes to the card; an agent adds this after showing them the card (boolean)
  --project <folder>
      The project folder (string; default: the current folder)

2 more option(s) for tests and agents: review-bridge resume --help --all
```

### clean

```text
Usage: review-bridge clean [<run_id>] [options]

Clear records: without a run id, fold finished runs into day files and drop what is past retention; with one, remove that finished run (a running one is refused)

Options:
  --all
      Clear this project's work orders, versions, plans and contracts from your database (refused while a run is running) (boolean)
  --json
      Print the result as JSON (without a run id) (boolean)
  --project <folder>
      The project folder (string; default: the current folder)
```

### status

```text
Usage: review-bridge status [options]

Show what Bridge is doing now: the page, this project's runs, and how to look at the database

Options:
  --after <run_id>
      Show the ten runs after this one (the next page) (string; default: the newest runs)
  --json
      Print the result as JSON (boolean)
  --project <folder>
      The project folder (string; default: the current folder)
```

### logs

```text
Usage: review-bridge logs <run_id|file> [options]

Show a run's log folder and what each file in it is; for a work order (its file or source_id), its runs newest first

Options:
  --after <run_id>
      Show the ten runs after this one (the next page) (string; default: the newest runs)
  --json
      Print the result as JSON, with the same run fields as work-status (boolean)
  --project <folder>
      The project folder (string; default: the current folder)
```

### up

```text
Usage: review-bridge up [options]

Start the database and the local page service in the background

Options:
  --project <folder>
      The project folder (string; default: the current folder)

1 more option(s) for tests and agents: review-bridge up --help --all
```

### down

```text
Usage: review-bridge down [options]

Stop the local page service and the database; refused while a run is running

Options:
  --project <folder>
      The project folder (string; default: the current folder)
```

### ps

```text
Usage: review-bridge ps [options]

Show whether the local page service is running, and its address

Options:
  --project <folder>
      The project folder (string; default: the current folder)
```

### watch

```text
Usage: review-bridge watch [options]

Run the local page in this terminal until Ctrl+C

Options:
  --port <n>
      Port of the local page (number; default: the port init chose)
  --project <folder>
      The project folder (string; default: the current folder)

1 more option(s) for tests and agents: review-bridge watch --help --all
```

### upgrade

```text
Usage: review-bridge upgrade [options]

Move this folder's setup to the installed Review Bridge version, with a backup

Options:
  --target <folder>
      Upgrade this folder instead (string; default: the current folder)
  --rollback
      Undo the last upgrade from its backup (boolean)
  --plan-out <file>
      Write the plan to a file instead of asking (string)
  --plan <file>
      Apply a plan written by --plan-out (needs --approve) (string)
  --approve <sha>
      The plan's SHA-256, as printed by --plan-out (string)
  --backup-root <folder>
      Where the backup goes (string; default: Review Bridge's backup folder)
  --json
      Print the result as JSON (boolean)

1 more option(s) for tests and agents: review-bridge upgrade --help --all
```

### uninstall

```text
Usage: review-bridge uninstall [options]

Remove Review Bridge from a folder, with a backup (Review Bridge itself: npm uninstall -g review-bridge)

Options:
  --target <folder>
      The folder to remove the setup from (string; required)
  --plan-out <file>
      Write the plan to a file instead of asking (string)
  --plan <file>
      Apply a plan written by --plan-out (needs --approve) (string)
  --approve <sha>
      The plan's SHA-256, as printed by --plan-out (string)
  --backup-root <folder>
      Where the backup goes (string; default: Review Bridge's backup folder)
  --json
      Print the result as JSON (boolean)

1 more option(s) for tests and agents: review-bridge uninstall --help --all
```

### vscode

```text
Usage: review-bridge vscode [options]

Add Bridge's tasks to VS Code's task list, in this project's .vscode/tasks.json; with --user, in your user tasks for all projects

Options:
  --user
      Write to your VS Code user tasks instead of this project (boolean)
  --target <folder>
      Write to this set-up folder instead (string; default: the current folder)
  --json
      Print the result as JSON (boolean)
```

### doctor

```text
Usage: review-bridge doctor [options]

Check which platform adapter this machine uses, without running any work

Options:
  --project <folder>
      The project folder (string; default: the current folder)

1 more option(s) for tests and agents: review-bridge doctor --help --all
```

### backup

```text
Usage: review-bridge backup [options]

Copy your database, for all your projects, with the database stopped (refused while a run is running)

Options:
  --project <folder>
      The project folder (string; default: the current folder)
```

### For agents and scripts

Shown by `review-bridge --help --all`. `start` does what `work-plan` and `work-start` do in one command.

#### work-plan

```text
Usage: review-bridge work-plan <file> [options]

Seal a work order into a plan without starting it (start does this for you)

Options:
  --writer <claude|codex>
      Writer for this run only; the card shows it (string; default: the writer in bridge.json)
  --reviewer <claude|codex>
      Reviewer for this run only; the card shows it (string; default: the reviewer in bridge.json)
  --breakpoint <text>
      Where the work stops and comes back to you (string; default: after the review, asked at a terminal)
  --allow-paths <list>
      Limit the work to these paths, comma-separated (string; default: the whole project except protected files)
  --owner <name>
      Who owns the work (string; default: your OS user name)
  --work-package <id>
      Name of the work package (string; default: the work order's file name)
  --rounds <n>
      Writer rounds this work may use; comes before the work order's budget (number; default: the work order's budget, else the policy limit)
  --call-timeout <ms>
      Milliseconds each writer call may run; comes before the work order's budget (number; default: the work order's budget, else the policy limit)
  --update <work_order_id>
      Make this a new version of that work order (string; default: what Bridge finds, shown on the card)
  --as-new
      Make this a new work order (boolean)
  --task-file <file>
      The work order, instead of giving it first (string)
  --task <text>
      Work text instead of a work order file (needs --allow-paths) (string)
  --out <file>
      Where the plan is written (string; default: <name>.plan.json in the run's log folder)
  --plain
      Print a short summary of the plan (boolean)
  --json
      Print the result as JSON (boolean)
  --fake-cli
      Use the built-in fake CLI instead of a model (tests and self-checks) (boolean)
  --project <folder>
      The project folder (string; default: the current folder)
```

#### work-start

```text
Usage: review-bridge work-start [options]

Start a sealed plan on the person's yes (start does this for you)

Options:
  --plan <file>
      The plan written by work-plan (string; required)
  --approve <sha>
      The plan's SHA-256, as the person's yes (string)
  --yes
      The person said yes to the card; an agent adds this after showing them the card (boolean)
  --fake-cli
      Use the built-in fake CLI instead of a model (tests and self-checks) (boolean)
  --fake-scenario <name>
      Fake CLI outcome: PASS, FAIL_THEN_PASS, HARD_STOP or RATE_LIMIT (string; default: PASS)
  --json
      Print the run's state as JSON at the end (boolean)
  --project <folder>
      The project folder (string; default: the current folder)
```

#### work-status

```text
Usage: review-bridge work-status [options]

Show the current work as JSON: this project's runs and the newest one in detail

Options:
  --after <run_id>
      Show the ten runs after this one (the next page) (string; default: the newest runs)
  --project <folder>
      The project folder (string; default: the current folder)
```

#### work-cancel

```text
Usage: review-bridge work-cancel [options]

Cancel the active authorization so the run cannot continue

Options:
  --reason <text>
      Why it is cancelled (string; required)
  --run <run_id>
      Which run (string; default: the only active run)
  --project <folder>
      The project folder (string; default: the current folder)
```

#### review

```text
Usage: review-bridge review [options]

Run the review worker on queued work (internal; refused with real models)

Options:
  --dry-run
      Show what would be reviewed (boolean)
  --validate-only
      Only check that a review could run (boolean)
  --no-notification
      Do not show a desktop notification (boolean)
  --project <folder>
      The project folder (string; default: the current folder)
```

#### bounded-resume

```text
Usage: review-bridge bounded-resume [options]

Internal: resume the writer session of the one active run (refused with real models; resume <run_id> is the command for people)

Options:
  --prompt <file>
      The prompt file (string; required)
  --rounds <n>
      Writer rounds (number; default: 2)
  --call-timeout <ms>
      Milliseconds per writer call (number; default: 480000)
  --validate-only
      Only check that the resume could run (boolean)
  --project <folder>
      The project folder (string; default: the current folder)
```

#### wait

```text
Usage: review-bridge wait [options]

Wait for the next queued review report and print its path

Options:
  --timeout <ms>
      How long to wait, in milliseconds (number; default: 7200000)
  --project <folder>
      The project folder (string; default: the current folder)
```

#### prune

```text
Usage: review-bridge prune [options]

Same as clean without a run id

Options:
  --json
      Print the result as JSON (boolean)
  --project <folder>
      The project folder (string; default: the current folder)
```

#### rm

```text
Usage: review-bridge rm <run_id> [options]

Same as clean <run_id>

Options:
  --project <folder>
      The project folder (string; default: the current folder)
```

#### graph

```text
Usage: review-bridge graph [options]

Read this project's code into its graph again, whole (init does this; start brings it up to date)

Options:
  --json
      Print each step as one JSON line, the last one the summary (boolean)
  --project <folder>
      The project folder (string; default: the current folder)
```

#### graph-mcp

```text
Usage: review-bridge graph-mcp [options]

Bridge's read-only MCP server on this project's graph, over stdio (the writer's and reviewer's CLIs start it)

Options:
  --project <folder>
      The project folder (string; default: the current folder)
```

#### roles-check

```text
Usage: review-bridge roles-check [options]

Check that the writer and reviewer CLIs are installed and signed in, without a model call

Options:
  --writer <claude|codex>
      Writer role, asked at a terminal when not given (string)
  --reviewer <claude|codex>
      Reviewer role, asked at a terminal when not given (string)
  --json
      Print the result as JSON (boolean)
  --yes
      Ask nothing (boolean)
```

<!-- commands:end -->

## Where data lives

- **Project files:** `.review-bridge/bridge.json`, `policy.override.json`, and `rules.md` hold settings. `work-packages/` holds your work orders, and `results/` has one folder per work order containing its results and contracts.
- **Shared user data:** your default roles in `settings.json`, the database, and project runtime state in `projects/<project_id>/` live under `%LOCALAPPDATA%\ReviewBridge` on Windows, `~/Library/Application Support/ReviewBridge` on macOS, or `~/.local/share/review-bridge` on Linux. There's one database per user account, and every project you set up shares it. Running `init` in ten projects gives you ten entries in that one database, not ten databases, and it makes no difference whether you run Bridge through `npx` or a global install. Runtime state includes queues, locks, event copies, evidence, and install records. Set `REVIEW_BRIDGE_DATA_HOME` to use another location.
- **Run logs:** each model call's prompt, stream, and stderr, plus test output, the plan, and the approved card, go under `<project_id>/<run_id>/` in the platform's log directory: `%LOCALAPPDATA%\ReviewBridge\Log` on Windows, `~/Library/Logs/ReviewBridge` on macOS, or `$XDG_STATE_HOME/review-bridge` (default `~/.local/state/review-bridge`) on Linux. With `REVIEW_BRIDGE_DATA_HOME`, they go in its `logs/` subfolder. Log folders are removed after the retention period or by `clean <run_id>`. `npx review-bridge status` prints the log directory; `npx review-bridge logs <run_id>` lists a run's files, and `npx review-bridge logs <work order>` lists its runs.
- **Older project layouts:** `upgrade` moves settings to `.review-bridge/`, old runtime state (`review-queue/`, `reviews/`, `archive/`) to `projects/<project_id>/`, and call logs, plans, and cards to the log directory. It preserves file names and verifies copies with SHA-256. Logs, plans, and cards for runs already removed by retention are discarded. If the upgrade is interrupted, rerun it to finish. Older result files directly under `results/` stay where they are; they're readable copies you can delete when you no longer need them.
- **Backups:** `backups/database` under the data directory holds database backups created by `npx review-bridge backup`. `backups/installer` holds backups from `upgrade` and `uninstall`, unless you set `--backup-root <folder>`. Backups may contain private work data; don't publish them.

`npx review-bridge backup` uses PostgreSQL's file-level backup procedure. It refuses to run while any run is active; otherwise, it stops the database, copies the full directory, including its password file, and restarts it. To restore a backup, copy its `postgres` folder into an empty directory, set `REVIEW_BRIDGE_DATA_HOME` to that directory, and run Bridge.

To browse the database in VS Code, install Microsoft's PostgreSQL extension or SQLTools with its PostgreSQL driver. Add a connection with:

- **Server:** `127.0.0.1`
- **Port:** `5432` by default. If it's occupied, Bridge finds the next available port, checking again at each startup.
- **User:** `bridge`
- **Database:** `bridge`
- **Password:** copy it from `postgres/secret` under the data directory (`%LOCALAPPDATA%\ReviewBridge\postgres\secret` on Windows). Only your user account can read this file.

`init` and `npx review-bridge status` print the connection details, including the port in use and the password-file location:

```text
Database in VS Code: install Microsoft's PostgreSQL extension and add a connection with
  Server 127.0.0.1  Port 5432  User bridge  Database bridge
  Password: copy it from C:\Users\you\AppData\Local\ReviewBridge\postgres\secret
```

To start searching from a different port, add `"database": { "port": 5440 }` to `settings.json` in the data directory. It takes effect the next time the database starts: after a system restart, or immediately by running `npx review-bridge backup`, which stops and restarts it.

The database is the source of truth. Work orders, versions, plan cards, authorizations, contracts, runs, events, verdicts, and deliveries are all stored there. Runtime files under `projects/<project_id>/` are working copies. Deleting logs or result files doesn't remove the database records. PostgreSQL listens only on `127.0.0.1` and keeps running between commands.

## Upgrade and remove

With `npx`, you don't need a separate package update step. Running `npx review-bridge` without a version checks npm for the latest release. If you installed Bridge globally, update it with `npm i -g review-bridge@latest`.

When a new version includes database migrations, the first command backs up the database before applying them and prints the backup location. Check the changelog for that version's migrations. Then run `npx review-bridge upgrade` in each project to update its settings, templates, and local page.

To remove Bridge from a project, run `npx review-bridge uninstall --target .` in that project. After uninstalling the project setups, remove a global installation with `npm uninstall -g review-bridge`.

## Safety model

- **Authorization is required.** Missing, malformed, expired, or already consumed authorization blocks execution.
- **Review stays independent.** Writer and reviewer use separate sessions, even when both use the same provider. The reviewer is read-only. Codex's check verifies that its OS sandbox denied a real write. Claude Code's check verifies a plan-mode session containing only `Read`, `Grep`, and `Glob`, as reported by its `init` event. If other tools remain, such as an MCP connector, the check fails and work doesn't start.
- **Personal connectors are isolated.** Claude Code calls don't inherit your personal MCP servers; only the writer receives the project's `.mcp.json`. Codex calls disable apps, plugins, and each server named by `codex mcp list`. If Bridge can't read that list, it won't start work. You can allow named servers for the reviewer through the project policy's `reviewer.mcp_allow`. Those servers are passed through without read-only verification, and the card states that limitation. They apply only to reviewer calls; a Claude reviewer loads them from the project's `.mcp.json`.
- **Bridge runs verification.** It runs the project's verification command itself before the reviewer's verdict can pass.
- **You approve model work.** `start` and `resume` make their first model call only after your approval, to check the reviewer's read-only restrictions through the local page service. Native work proceeds only if that check passes. There is one card and one approval, given in the terminal or relayed by an agent with `--yes`. Preventing an agent from approving on your behalf depends on the agent tool's permission prompts.
- **Runtime state stays local.** Bridge rejects synchronized or network locations for its state, including OneDrive, Dropbox, iCloud Drive, UNC, NFS, and SMB.

## Platforms

Native execution has been verified on Windows x64. Apple Silicon macOS is available as an unverified candidate. Linux is experimental and blocks native execution.

### Windows

Codex runs commands in Windows PowerShell, which loads your `$PROFILE`. On systems using Chinese or another non-UTF-8 code page, PowerShell writes in that encoding while Codex reads the output as UTF-8. This can garble Chinese text. Add the following line to your profile. Open it with `notepad $PROFILE` in PowerShell, creating the file if needed:

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
```

Alternatively, use PowerShell 7 (`pwsh`), which outputs UTF-8. `npx review-bridge doctor` reports when PowerShell isn't using UTF-8; it doesn't modify your profile.

In one measured Vue and Vitest project on Windows with Codex 0.166, `npm test` failed inside Codex's sandbox with `spawn EPERM`. It passed with `npm test -- --configLoader native --pool threads`. This doesn't block a Bridge run: Bridge executes your tests itself, outside the agent sandbox, after each writer call. A Codex writer may still report that it couldn't run them. This observation hasn't been verified on other platforms or projects.

## Development

```sh
npm test                    # installer tests
npm run test:runtime        # runtime integration and platform tests
npm run test:state-contract # state contract acceptance
node scripts/render-commands.mjs          # rewrite the Commands section from the command table
node scripts/render-commands.mjs --check  # fail if it is out of date (CI runs this)
```

Tests never call a model. `npm run smoke:claude-session-live -- --confirm-live-model-calls` makes two small live Claude calls and is never part of `npm test`.

## License

MIT
