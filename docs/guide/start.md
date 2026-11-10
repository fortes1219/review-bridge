# Start a run

Use `start <work-order-file>` to run a work order. You can start from an AI agent, VS Code, or a terminal. All three use the same command; the difference is **where you review the card and authorize the work**.

## In Claude Code or Codex

This is the main entry point. In Claude Code, enter:

```text
/review-bridge start .review-bridge/work-packages/add-readme.md
```

In Codex, enter `$review-bridge start .review-bridge/work-packages/add-readme.md`.

Your agent first runs `start`. Bridge validates the work order as a form, copies its blocks into a contract, and seals the work order, scope, budget, and test command into a plan. It shows the authorization card and stops at `Needs authorization`. No model has been called yet.

The agent must show you the **complete card exactly as printed** and ask whether to start. Only after you approve may it rerun the same command with `--yes`. That approval authorizes execution; the record shows it was relayed by an agent (`authorized_via: agent`).

`--yes` uses only **the most recently displayed card**. It authorizes and starts nothing if no card was shown, the work order or command options changed afterward, the card expired (24 hours), or it already started a run. Each rejection includes the next command to run.

`/review-bridge` supports the same four actions as the terminal: `start <file>`, `stop <run_id>`, `resume <run_id>`, and `clean [<run_id>]`.

## In VS Code {#in-vs-code}

Bridge provides six tasks: `review-bridge: start`, `stop`, `resume`, `clean`, `status`, and `logs`. Enter `task review-bridge` in Quick Open, or choose `Terminal → Run Task`.

`start` uses the file open in the editor. Other tasks prompt for a run ID or file name. They run in the integrated terminal, where you also confirm the authorization card.

| Location | How to add tasks | Available in |
|---|---|---|
| Project `.vscode/tasks.json` | Opt in during `init`, or run `npx review-bridge vscode` | This project |
| User tasks (`Tasks: Open User Tasks`) | `npx review-bridge vscode --user` | All your projects |

You decide whether `.vscode/tasks.json` belongs in Git. Bridge neither adds nor excludes it. Until you commit or ignore it, Git will report it as a change, and the result will note uncommitted changes.

Bridge manages only tasks whose label starts with `review-bridge:` and inputs whose ID starts with `review-bridge-`. Other content, comments, and formatting stay intact. `uninstall` removes Bridge's entries and deletes the file only if nothing else remains.

User tasks apply to VS Code's default profile. Profiles with their own tasks, VS Code Insiders, VSCodium, and portable installations use other locations; run `npx review-bridge vscode` in the project instead. In a multi-root workspace, a user task runs from the first folder, which may differ from the project containing the work order.

## In a terminal

```sh
npx review-bridge start .review-bridge/work-packages/add-readme.md
```

In an interactive terminal, `start` asks where to hand control back to you (after review by default), shows the card, and asks `Start this work? [y/N]`. Answering n starts nothing and authorizes nothing.

| Action | Command |
|---|---|
| Run a work order | `npx review-bridge start <file>` |
| Stop and keep its records | `npx review-bridge stop <run_id>` |
| Run a stopped work order again | `npx review-bridge resume <run_id>` |
| Clear finished records | `npx review-bridge clean [<run_id>]` |

Use `npx review-bridge status` to find active runs and their IDs. The table uses npm's `npx`; with pnpm, Yarn, or Bun, Bridge prints `pnpm dlx`, `yarn dlx`, or `bun x`. See [Package managers](../reference/cli#package-managers).

## The card {#the-card}

All three entry points use the same card format. This is a captured run of the README work order from the previous page, using `locale: en` and `--fake-cli`. No models were called. Without an interactive terminal, Bridge shows the card and waits for authorization. Only local path prefixes are shortened to `<log directory>`, `<data home>`, and `<project>`; IDs, hashes, and timestamps are from this run:

```text
Plan written to <log directory>\1c3df8e9-f699-4351-9b16-a9368eae3436\b8f6c4b8-44a9-4f23-8a08-12bae14a6110\add-readme.plan.json

Work order:   .review-bridge/work-packages/add-readme.md
              New work order "Add a README to the project"
Stops:        after the review
Scope:        the whole project except protected files (23 patterns)
Tests:        not configured (no test rule matched; the work starts without tests)
Priority:     medium (config)
Writer:       claude (config), model the CLI's default (priority table), effort medium (priority table)
Reviewer:     codex (config), model the CLI's default (priority table), effort medium (priority table)
Reviewer MCP: none
Budget:       tokens 4000000 (config), tokens_per_call 1500000 (config), call_timeout 900000 (config), test_timeout 600000 (config), run_timeout 21600000 (config), rounds 2 (config)
Contract:     sha256 8d086cae7ac4a9cb7202943d6ff17540235a0b0a6bed7ef4024161683c6e82e3, 2 condition(s) cut from the acceptance list
Valid until:  2026-11-11T04:44:59.223Z

The work order, as sealed:
  │ ---
  │ source_id: DOC-1
  │ ---
  │ # Add a README to the project
  │
  │ <!-- bridge:context -->
  │ ## Background
  │ The project has no README, so new teammates do not know how to start it.
  │
  │ <!-- bridge:requested_work -->
  │ ## Requested work
  │ Add README.md at the project root, explaining the project and how to start it.
  │
  │ <!-- bridge:acceptance -->
  │ ## Acceptance
  │ 1. README.md exists at the project root, with the project name on its first line.
  │ 2. The README has a "Getting started" section.
  │
  │ <!-- bridge:open_questions -->
  │ ## Open questions
  │ none

Needs authorization. If the person says yes, run again: npx review-bridge start .review-bridge/work-packages/add-readme.md --fake-cli --yes
```

- Parentheses after values show their source: flags, work order, priority table, or configuration.
- `Contract` shows the sealed contract's SHA-256 and the number of acceptance conditions parsed in code. No model creates the contract; the result records 0 tokens for this step.
- The lower half shows the **sealed work-order text** covered by your approval. Later edits require another `start` to take effect.
- `Valid until` is the card's expiry (24 hours), currently shown in UTC. Generate a new card after it expires.
- `Reviewer MCP` lists additional servers allowed for the reviewer; the default is `none`.
- The line below `Work order` identifies which work order you're approving; see the next section.
- Preliminary lines such as `Plan written to` and `Reviewer read-only check`, and the per-step messages, currently appear only in English.

## Which work order are you approving? {#work-order-identity}

On your first approval, Bridge adds an `id` to frontmatter and records that version in the database. Keep this line; it isn't part of the contract's SHA-256. The work-order file then begins like this:

```markdown
---
id: d1626c15-7f6a-4cb1-8899-64807c20a50a
source_id: DOC-1
---
# Add a README to the project
```

Bridge uses that `id` to recognize later starts. Below `Work order`, the card describes its identity choice:

| Card message | When it appears |
|---|---|
| New work order “…” | No `id`, or the database doesn't recognize it |
| Updates “…”, still version N, with new run settings | Same text, different execution settings such as roles or budget |
| Updates “…”, version N → N+1, X lines changed | Work-order content changed |
| Updates “…” (was at …) | The original file was renamed or moved; it's the same work order |
| A copy of …, recorded as a new work order “…” | The original still exists with the same `id`; the copy receives a new ID on approval |

Two hard links to the same file count as one work order, not a copy. Bridge uses filesystem file IDs to distinguish them. If the filesystem provides no ID, Bridge rejects the request rather than guessing whether it's a hard link or a copy.

If the choice is wrong, specify an option to generate a corrected card:

- `--update <work_order_id>`: treat this file as a new version of that work order. Use it, for example, when you pasted the original content into a new file and want to keep its history. `work_order_id` is the original file's frontmatter `id`.
- `--as-new`: treat the file as a new work order even if it contains another work order's `id`.

Choose only one option. Both apply to single files, not directories. If you start an edited work order while its old version is still running, the card warns you first. Starting the new version stops the old run with `conclusion: cancelled` and reason `superseded`.

## Run a directory of work orders

Put the work orders in a subdirectory of `.review-bridge/work-packages/`, then pass that directory to `start`:

```sh
npx review-bridge start .review-bridge/work-packages/demo/
```

- Files run in name order, using numeric prefixes such as `01-` or `02_`. Unnumbered files come last.
- Bridge validates the whole directory before showing one card with each file and contract SHA-256, without the body text. One approval covers the pipeline, with a separate run, authorization, and contract for each work order.
- One failed work order doesn't block the next. Provider sign-out, exhausted quota, `stop`, or Ctrl+C stops the pipeline.
- Starting the directory again skips work orders already recorded as delivered.
- `status` shows progress; a final table summarizes results. Files go under `results/<directory>/<work-order>/`.
- Work runs in the project folder itself. Two directory pipelines would share that working folder, so wait for one to finish before starting another.

## While it runs

After approval, Bridge reports progress step by step. Here is the output after the card is shown again, from the same fake-CLI run. The local project path is shortened to `<project>`:

```text
Reviewer read-only check: not needed with the fake CLI (no model is called)

  Writer working (call 1 of 2)
  Tests: not configured for this project
  Reviewer checking the work
Delivered: no tests configured, reviewer passed
Result file: <project>\.review-bridge\results\add-readme\DOC-1 add-readme 2026-11-10 12-45-02 success.md
Tokens: writer 153246, reviewer 60400
```

The order is fixed:

1. **Check reviewer restrictions.** With a real CLI, Bridge makes one model call to verify read-only access and prints `Reviewer read-only check: passed`. The result is reused within the local page session. A failed check prevents work. Fake CLIs call no models, so they report `not needed with the fake CLI`.
2. **Refresh the project graph.** Reread only files Git reports as changed; see below.
3. **Run the writer**, up to `rounds` iterations.
4. **Have Bridge run the project's tests.** Without a configured command, work continues and the card, records, and result state that tests aren't configured.
5. **Review each acceptance condition.** The reviewer checks each one; Bridge decides whether it holds. If work needs correction and rounds remain, return to step 3.
6. Write the result file. The final three lines show the conclusion, result path, and tokens. They don't include the run ID; use `status` for that.

If Bridge's database stops responding, the run stops with reason `database_unavailable` and makes no further model calls. The terminal reports that the database is unavailable. Records saved to files meanwhile are written back by the next command that opens the database. Once it's available, run `start` again.

## The project graph {#project-graph}

`init` maps definitions, references, and imports across the project's code. It supports JavaScript, TypeScript, `.vue` script blocks, Python, Go, Rust, Java, Kotlin, C++, and C#. Parsers for languages other than JavaScript and TypeScript are installed through npm into Bridge's data directory on first use. In npm and pnpm workspaces, the graph covers the package and its workspace dependencies.

- The graph lives in your database; it creates no project files.
- `init` ends with counts of files, definitions, references, and imports. Files with parse errors or no parser are listed as incomplete, rather than silently omitted.
- `start` updates only files Git reports as changed. If that fails, it warns that the graph wasn't updated; both roles use the earlier graph, and the result notes it. Rebuild the whole project with `npx review-bridge graph`.
- Before each writer call, Bridge queries the graph using the work-order text and includes the results in the prompt. It does the same for review. “graph lookups” in the token table records SQL queries and estimated prompt tokens; those tokens are already included in writer and reviewer input.
- Both roles can also query the read-only MCP server `review-bridge-graph` themselves. In runs measured for this release, neither role called those tools on its own.

## Stop, resume, and clean

- `stop <run_id>`: stop the model process and preserve records.
- `resume <run_id>`: create a **new run** for the same work order, retaining its stopping point and scope. Resolve roles, models, effort, and budget again, show the card, and ask for approval.
- `clean` without an ID: consolidate finished records into daily files and remove records past retention. `clean <run_id>` removes one finished run and rejects active work. `clean --all` removes all this project's database records and retires its project ID. To use Bridge again, run `uninstall`, then `init`.

Ctrl+C during a single-file `start` ends the terminal command, but the run may continue. Find it with `npx review-bridge status`, then stop it with `npx review-bridge stop <run_id>`.

## Database and local page controls {#database-and-page}

The database is created and started on first use and keeps running after the terminal or VS Code closes. To control it yourself:

| Command | What it does |
|---|---|
| `npx review-bridge up` | Start the database, then the local page, in the background |
| `npx review-bridge down` | Stop the page, then the database. List active runs and refuse if any project has one |
| `npx review-bridge ps` | Show the local page's status and address |
| `npx review-bridge watch` | Run the page in this terminal until Ctrl+C |

After `down`, the example looks like this:

```text
$ npx review-bridge down
Page stopped.
Database stopped.
$ npx review-bridge status
Page: not running; start it with npx review-bridge up
Database: stopped; npx review-bridge up starts it, and so does the next start.
```

`status` reports database state without starting it.

Bridge **does not automatically commit, push, or deploy**. The result lists the changed files so you can inspect the work and decide whether to commit. Continue with [Results, logs, and the database](./results).
