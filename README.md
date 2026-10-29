# Review Bridge

```sh
cd your-project
npx review-bridge init
```

Review Bridge runs your work orders with two separate agents: a writer that does the work and an independent, read-only reviewer that checks it. Bridge itself decides the scope, the budget, the verification command and when to stop and hand back to you; the agents cannot change those.

## What `init` does

`init` asks three questions, each with a default you can take with Enter:

1. the writer (`claude` or `codex`; your saved default, else `claude`),
2. the reviewer (your saved default, else `codex`),
3. the project type (what detection finds in the folder, else `none`).

Then it sets the current folder up and prints the next commands:

- creates `.review-bridge/` with the project settings, the work-order templates (`TEMPLATE.md` in English, `TEMPLATE.zh-TW.md` in Chinese) and the queue; in a Git repository it is kept out of Git through `.git/info/exclude` (tracked `.gitignore` is never edited);
- runs four fake self-tests (`PASS`, `FAIL_THEN_PASS`, `HARD_STOP`, `RATE_LIMIT`) that call no model;
- starts the local page on `127.0.0.1`;
- adds a `/review-bridge` command for Claude Code (`.claude/commands/review-bridge.md`, only if there is none) and the same steps for any agent to `AGENTS.md` (appended, never overwritten). `uninstall` removes both again unless you edited them.

It changes no application file and nothing else in `.claude/` or `.codex/`. Options answer the questions instead (`--writer`, `--reviewer`, `--profile <type|none>`, `--target <folder>`); without a terminal, or with `--yes`, nothing is asked and the defaults are used.

The project type only picks the verification command Bridge runs after every writer call (for example `npm test`). With `none`, or when the project has no such command, the work still starts; the card, the run's records and the result all say the tests are not configured.

## Requirements

- Node.js 22 or newer, with npm.
- Git. Work runs without it, but the work proof needs Git: with Git, Bridge records the commit a run starts from and reads the changes from Git; without it, the result says there is no work proof.
- The `claude` and/or `codex` CLI, installed and signed in, for the roles you choose.

## Your first work order

```sh
cp .review-bridge/work-packages/TEMPLATE.md .review-bridge/work-packages/add-readme.md
# describe the work and its acceptance results, in any language
review-bridge start .review-bridge/work-packages/add-readme.md
```

`start` seals the work order with its scope, budget and verification into a plan (asking where the work should stop for you), checks once per page session that the reviewer cannot write files, shows what you are authorizing, and asks `Start this work? [y/N]`. Your answer is the only authorization. It then prints one line per step and ends with the result file. Bridge never commits, pushes or deploys.

The same four actions work for you or through an agent:

| You want to | Command |
|---|---|
| start a work order | `review-bridge start <file>` |
| pause it (its records are kept) | `review-bridge stop <run_id>` |
| carry it on | `review-bridge resume <run_id>` |
| clear finished records | `review-bridge clean [<run_id>]` |

`review-bridge status` shows what is running and the run ids.

**Through an agent.** In Claude Code type `/review-bridge start <file>` (or `stop`, `resume`, `clean`); Codex reads the same steps from `AGENTS.md`. Without a terminal, `start` and `resume` print the card and stop with `Needs authorization`; the agent shows you the card word for word and runs the command again with `--yes` only after you say yes. The authorization records that the yes came through an agent.

## Work order format

A work order is a Markdown file: optional frontmatter, a title, and blocks marked for the contract fields. Bridge reads only this format; it splits the file itself and fills every contract field from its block, copying the text as written. A model only cuts the acceptance blocks into numbered conditions. If you generate work orders from another tool, this section is the whole interface.

### Frontmatter

The frontmatter is data, read as YAML when the work is planned (the way Astro reads content collections): the first line is `---`, and it ends at the next line that is only `---`. Every key is optional, and a file without frontmatter is valid.

```yaml
---
priority: high              # low / medium / high / urgent; default: the policy's priority.default
effort: high                # low / medium / high; default: the policy's priority table
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

- Any other key is refused, with its line. So is a value out of range: a priority or effort that is not one of the values above, a budget value that is not a positive whole number, or one above the policy's limit (the refusal names the limit).
- `effort` is the writer's effort for every writer call: the work, each fix and the contract translation. The reviewer's effort always comes from the policy's priority table.
- Each value is settled in a fixed order: a flag given at the terminal (`--rounds`, `--call-timeout`), then the work order, then the policy's priority table (effort and model), then the policy's limits. The plan records each value with the layer it came from (`cli`, `work_order`, `priority`, `config`), and the card shows both.
- `run_timeout` is the run's own time limit, like a GitHub Actions job's `timeout-minutes` (default 6 hours). A run that reaches it is closed as `timed_out` with the reason `run_timeout`; every call is cut to the time left.

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
1. After a valid discount code, the total shows the discounted amount within one second.
2. After an invalid code, the total is unchanged and an error message is shown.
```

- The first line starting with `# ` is the title.
- A block runs from its `<!-- bridge:<key> -->` line to the next marker or the end of the file. The `##` headings are for people, in any language; Bridge does not read them.
- The keys are exactly the 17 contract fields: `context`, `outcome`, `requested_work`, `run_plan`, `scope_notes.include`, `scope_notes.exclude`, `scope_notes.must_keep`, `scope_notes.expected_locations`, `acceptance`, `verification_hints`, `reproduction.environment`, `reproduction.steps`, `reproduction.actual`, `reproduction.expected`, `reproduction.frequency`, `references`, `open_questions`. An unknown key, or a key used twice, is refused with its line.
- The smallest work order is a title, a `requested_work` block and an `acceptance` block. Without any acceptance, the work stops before any model call and asks you for a result that can be checked.
- `open_questions`: a block holding only `none` (or `無`), or nothing, means there are none. Any other line is one question, and the work stops before any model call until you answer it in the work order.
- Frontmatter, the title, markers, `##` and `###` headings and blank lines are structure. Any other line outside every block is kept in the contract as an unused line.

### Run plan

Only for work laid out as two or more runs. Each `### ` line opens a run named by its text. Inside a run, four lines carry fixed keys, read as YAML; every other line is the run's work:

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

- `effort` and `budget` take the same values as in the frontmatter. `depends_on` is one run name or a list such as `[RUN A, RUN B]`; a name that is no run here, or a loop, is refused.
- `acceptance` takes the indented lines after it as that run's own conditions. The work order's `acceptance` block holds the results across runs. A run plan with only one run is refused.
- Bridge records the run plan in the contract; it still starts one run for the whole work order.

## Commands

<!-- commands:start -->
<!-- Generated by scripts/render-commands.mjs from review-bridge/router/index.mjs; edit the table, not this section. -->

```text
Usage: review-bridge <command> [options]

Commands:
  init              Set up Review Bridge in this folder: asks for the writer, the reviewer and the project type
  start <file>      Run a work order: plan it, check the reviewer can only read, show what you authorize, ask once, then run it
  stop <run_id>     Pause a running work order: its model process is stopped and its records are kept (resume <run_id> carries it on)
  resume <run_id>   Carry on a stopped work order: a new run of the same work order with the same stop point, changes, scope and budget, after the same card and yes as start
  clean [<run_id>]  Clear records: without a run id, fold finished runs into day files and drop what is past retention; with one, remove that finished run (a running one is refused)
  status            Show what Bridge is doing now: the page, this project's runs, the review queue, and how to look at the database
  up                Start the local page service in the background
  down              Stop the local page service
  ps                Show whether the local page service is running, and its address
  watch             Run the local page in this terminal until Ctrl+C
  upgrade           Move this folder's setup to the installed Review Bridge version, with a backup
  uninstall         Remove Review Bridge from a folder, with a backup (Review Bridge itself: npm uninstall -g review-bridge)
  doctor            Check which platform adapter this machine uses, without running any work
  backup            Copy your database, for all your projects, with the database stopped (refused while a run is running)

Options:
  -v, --version   Print the version
  -h, --help      Print this help; --help --all also lists the commands for agents and scripts

Run review-bridge <command> --help for a command's options.
Update Review Bridge: npm i -g review-bridge@latest
Remove Review Bridge: npm uninstall -g review-bridge
```

### init

```text
Usage: review-bridge init [options]

Set up Review Bridge in this folder: asks for the writer, the reviewer and the project type

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
Usage: review-bridge start <file> [options]

Run a work order: plan it, check the reviewer can only read, show what you authorize, ask once, then run it

Options:
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

Carry on a stopped work order: a new run of the same work order with the same stop point, changes, scope and budget, after the same card and yes as start

Options:
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

Show what Bridge is doing now: the page, this project's runs, the review queue, and how to look at the database

Options:
  --after <run_id>
      Show the ten runs after this one (the next page) (string; default: the newest runs)
  --json
      Print the result as JSON (boolean)
  --project <folder>
      The project folder (string; default: the current folder)
```

### up

```text
Usage: review-bridge up [options]

Start the local page service in the background

Options:
  --project <folder>
      The project folder (string; default: the current folder)

1 more option(s) for tests and agents: review-bridge up --help --all
```

### down

```text
Usage: review-bridge down [options]

Stop the local page service

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
      Where the plan is written (string; default: .review-bridge/review-queue/<name>.plan.json)
  --plain
      Print a short summary of the plan (boolean)
  --json
      Print the result as JSON (boolean)
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

- In the project: `.review-bridge/`.
- For you, shared by all your projects: your settings (`settings.json`, the default roles) and the database, in `%LOCALAPPDATA%\ReviewBridge` on Windows, `~/Library/Application Support/ReviewBridge` on macOS and `~/.local/share/review-bridge` on Linux. `REVIEW_BRIDGE_DATA_HOME` moves it.
- Backups, in `backups` under that folder: `backups/database` holds the copies `review-bridge backup` makes of the database; `backups/installer` holds what `upgrade` and `uninstall` keep (or `--backup-root <folder>`). They can hold private work data; do not publish them.

`review-bridge backup` is PostgreSQL's file system level backup: it refuses while a run is running, stops the database, copies its whole folder (the data, its password file and its port) and starts it again. To restore one, copy its `postgres` folder into an empty folder, set `REVIEW_BRIDGE_DATA_HOME` to that folder, and run Bridge there.

The database is the record; the files under `.review-bridge/` are the running copy. Every work order, version, card (plan), authorization, contract, run, event, verdict and delivery is a row in it. `review-bridge status` ends with how to reach it:

```text
Database: host 127.0.0.1  port 57065  database bridge  user bridge
          password file: C:\Users\you\AppData\Local\ReviewBridge\postgres\secret
```

To look at every table in VS Code, install Microsoft's PostgreSQL extension (or SQLTools with its PostgreSQL driver), add a connection with that host, port, database and user, and paste the password from that file (only your user can read it). The server listens on 127.0.0.1 only and keeps running between commands; the port can change when it restarts, so take it from `status`.

## Upgrade and remove

```sh
npm i -g review-bridge@latest     # then, in each project: review-bridge upgrade
npm uninstall -g review-bridge    # remove a project's setup first: review-bridge uninstall --target .
```

## Safety model

- A missing, malformed, expired or consumed authorization fails closed.
- The writer and the reviewer run in separate sessions; the reviewer is read-only.
- Bridge runs the verification command itself before the reviewer's verdict can pass.
- Native model work starts only on your yes to the card (at the terminal, or through an agent with `--yes`) and only after the reviewer's read-only check passed in the local page service; `start` and `resume` run that check first. Keeping an agent from saying yes on its own is the agent tool's job (its permission prompts), not Bridge's.
- Bridge state must be on a local filesystem; synchronized and network folders (OneDrive, Dropbox, iCloud Drive, UNC, NFS, SMB) are refused.

## Platforms

Windows x64 is native-verified. Apple Silicon macOS is a selectable candidate, not native-verified. Linux is experimental and fails closed for native work.

### Windows

Codex runs its commands in Windows PowerShell, which loads your `$PROFILE`. On a Windows set to Chinese (or any non-UTF-8 code page), PowerShell writes in that code page and Codex reads it as UTF-8, so its Chinese output arrives broken. Add this line to your profile (`notepad $PROFILE` in PowerShell; create the file if it does not exist):

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
```

Or use PowerShell 7 (`pwsh`), which writes UTF-8. `review-bridge doctor` tells you when PowerShell does not write UTF-8; it never changes your profile.

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
