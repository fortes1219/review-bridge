# Commands

This page preserves the actual `npx review-bridge <command> --help` output for 0.3.0-rc.3. `Usage: review-bridge …` names the executable; add your package manager's prefix when running it. See [Package managers](#package-managers). `npx review-bridge --help --all` also lists commands for agents and scripts: `work-plan`, `work-start`, `work-status`, `work-cancel`, `wait`, `prune`, `rm`, `graph`, `graph-mcp`, and `roles-check`. Usually, `start` handles planning and execution together.

| Command | Purpose |
|---|---|
| `init` | Set up the current folder with a writer, reviewer, and project type |
| `start` | Seal a plan and show its card. After approval, check the reviewer's read-only restrictions and begin. A directory under `.review-bridge/work-packages/` runs in file-name order |
| `stop` | Stop a run's model process and keep its records; use `resume <run_id>` to run the work order again |
| `resume` | Create a new run with the same stopping point and scope; resolve roles, models, effort, and budget again, then request approval |
| `clean` | Without a run ID, consolidate finished records into daily files and remove expired records; with an ID, remove that finished run. Active runs can't be removed |
| `status` | Show the local page, database state, project runs, and connection details without starting the database |
| `logs` | List a run's log files, or a work order's run history by file or `source_id`, newest first |
| `vscode` | Add project tasks to `.vscode/tasks.json`; `--user` adds tasks shared across projects |
| `up` | Start the database, then the local page, in the background |
| `down` | Stop the page, then the database; refuse while any project has an active run |
| `ps` | Show local page service status and its address |
| `watch` | Run the local page in this terminal until Ctrl+C |
| `upgrade` | Back up and update project settings to the installed Bridge version |
| `uninstall` | Back up and remove a project's Bridge setup. Remove a global installation with `npm uninstall -g review-bridge` |
| `doctor` | Check the platform adapter without running work |
| `backup` | Stop the database, copy all projects' data, then restart it; refuse while work is active |
| `graph` | Rebuild the full code graph. `init` builds it initially; `start` refreshes changed files. Listed in `--help --all` |

Commands use `--project <folder>` or `--target <folder>` to select a project, defaulting to the current folder. See each command for supported options.

## Package managers {#package-managers}

No global installation is required. `npx review-bridge <command>` retrieves npm's `latest` release; if you've installed globally with `npm i -g review-bridge`, it uses that copy. Commands printed by Bridge—setup's next steps, the card, `status`, error recovery, agent entry points, and VS Code tasks—match the package manager that launched it:

| Started with | Commands printed by Bridge |
|---|---|
| npm, or unknown | `npx review-bridge …` |
| pnpm | `pnpm dlx review-bridge …` |
| Yarn 2 or newer | `yarn dlx review-bridge …` (Yarn 1 has no `dlx`; falls back to `npx`) |
| Bun | `bun x review-bridge …` |
| Deno | `deno run -A npm:review-bridge …` |

Bridge reads `npm_config_user_agent`, as create-vite does. Printed commands don't pin a version. Only the original `--help` text uses the bare executable name.

## init

Set up the current folder with a writer, reviewer, and project type.

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

## start

Seal the plan and show its card, then check the reviewer's read-only restrictions and begin after approval. A directory runs its work orders in file-name order. For `--update` and `--as-new`, see [Which work order are you approving?](../guide/start#work-order-identity).

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

## stop

Stop the model processes for a run and keep its records. Use `resume <run_id>` to run the work order again.

```text
Usage: review-bridge stop <run_id> [options]

Pause a running work order: its model process is stopped and its records are kept (resume <run_id> carries it on)

Options:
  --project <folder>
      The project folder (string; default: the current folder)
```

## resume

Create a new run of a stopped work order with the same breakpoint and scope. Resolve roles, models, effort, and budget again, then show a new card for human authorization.

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

## clean

Without a run ID, fold finished records into daily files and remove content past retention. With a run ID, remove that finished run. Running work cannot be removed.

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

## status

Show the local page, database state, project runs, and connection details. If the database is stopped, explain how to start it without starting it automatically.

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

## logs

Show a run’s log folder and what each file contains. Given a work-order file or `source_id`, list its runs newest first.

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

## vscode

Add Bridge tasks to the project’s `.vscode/tasks.json`. Use `--user` to add user tasks shared by all projects.

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

## up

Start the database, then the local page service, in the background.

```text
Usage: review-bridge up [options]

Start the database and the local page service in the background

Options:
  --project <folder>
      The project folder (string; default: the current folder)

1 more option(s) for tests and agents: review-bridge up --help --all
```

## down

Stop in reverse order from `up`: first the local page, then the database. If any project has an active run, list it and refuse to stop.

```text
Usage: review-bridge down [options]

Stop the local page service and the database; refused while a run is running

Options:
  --project <folder>
      The project folder (string; default: the current folder)
```

## ps

Show the local page service’s status and URL.

```text
Usage: review-bridge ps [options]

Show whether the local page service is running, and its address

Options:
  --project <folder>
      The project folder (string; default: the current folder)
```

## watch

Run the local page service in this terminal until Ctrl+C.

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

## upgrade

Back up the project’s setup, then upgrade it to the installed Review Bridge version.

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

## uninstall

Back up and remove Review Bridge’s setup from a folder. To remove the package itself, use `npm uninstall -g review-bridge`.

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

## doctor

Inspect this machine’s platform adapter without running a work order.

```text
Usage: review-bridge doctor [options]

Check which platform adapter this machine uses, without running any work

Options:
  --project <folder>
      The project folder (string; default: the current folder)

1 more option(s) for tests and agents: review-bridge doctor --help --all
```

## backup

Stop the database, copy all projects’ data, and restart it. Refused while work is running.

```text
Usage: review-bridge backup [options]

Copy your database, for all your projects, with the database stopped (refused while a run is running)

Options:
  --project <folder>
      The project folder (string; default: the current folder)
```

## graph

Rebuild the project's full code graph. `init` builds it initially; `start` refreshes only files Git reports as changed. Run this command if `start` says the graph couldn't be updated. See [The project graph](../guide/start#project-graph). Listed in `--help --all`.

```text
Usage: review-bridge graph [options]

Read this project's code into its graph again, whole (init does this; start brings it up to date)

Options:
  --json
      Print each step as one JSON line, the last one the summary (boolean)
  --project <folder>
      The project folder (string; default: the current folder)
```
