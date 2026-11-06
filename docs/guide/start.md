# Start a run

Use `start <work-order-file>` to run a work order. You can start from an AI agent, VS Code, or a terminal. All three use the same command; the difference is **where you review the card and authorize the work**.

## In Claude Code or Codex

This is the main entry point. In Claude Code, enter:

```text
/review-bridge start .review-bridge/work-packages/add-readme.md
```

In Codex, enter `$review-bridge start .review-bridge/work-packages/add-readme.md`.

Your agent first runs `start`. Bridge seals the work order, scope, budget, and verification command into a plan, checks the reviewer's read-only restrictions for the current page-service session, and displays an authorization card. It then stops at `Needs authorization`.

The agent must show you the card **exactly as printed** and ask “Start this work?” Only after you agree may it run the same command again with `--yes`. That confirmation authorizes the work; the record shows that your agent relayed it (`authorized_via: agent`).

`/review-bridge` supports the same four actions as the terminal: `start <file>`, `stop <run_id>`, `resume <run_id>`, and `clean [<run_id>]`.

## In VS Code

Bridge provides six tasks: `review-bridge: start`, `stop`, `resume`, `clean`, `status`, and `logs`. Enter `task review-bridge` in Quick Open, or choose `Terminal → Run Task`.

`start` uses the file open in the editor. Other tasks prompt for a run ID or file name. They run in the integrated terminal, where you also confirm the authorization card.

| Location | How to install | Available in |
|---|---|---|
| This project's `.vscode/tasks.json` | Answer y to init's last question, or run `review-bridge vscode` | This project |
| Your user tasks (`Tasks: Open User Tasks`) | `review-bridge vscode --user` | All your projects |

You decide whether `.vscode/tasks.json` belongs in Git. Bridge neither adds nor excludes it. Until you commit or ignore it, Git will report it as a change, and the result will note uncommitted changes.

Bridge manages only tasks whose label starts with `review-bridge:` and inputs whose ID starts with `review-bridge-`. Other content, comments, and formatting stay intact. `uninstall` removes Bridge's entries and deletes the file only if nothing else remains.

User tasks are written to VS Code's default profile. Other profiles with their own tasks, VS Code Insiders, VSCodium, and portable installations use different locations; use `review-bridge vscode` in the project instead. In a multi-root workspace, a user task runs in the first folder, which may not be the project containing your work order.

## In a terminal

The terminal entry point is available for advanced use and CI:

```sh
review-bridge start .review-bridge/work-packages/add-readme.md
```

`start` asks where to stop and hand control back to you (after review by default), displays the card, then asks `Start this work? [y/N]`.

| Action | Command |
|---|---|
| Run a work order | `review-bridge start <file>` |
| Stop a run and keep its records | `review-bridge stop <run_id>` |
| Run a stopped work order again | `review-bridge resume <run_id>` |
| Clean up finished records | `review-bridge clean [<run_id>]` |

Use `review-bridge status` to find active runs and their IDs.

## The card

All three entry points show the same card format. This example was captured on Linux using mock CLIs and a Chinese work order:

```text
Work order:   .review-bridge/work-packages/add-readme.md
              New work order "幫專案補一份 README"
Stops:        after the review
Scope:        the whole project except protected files (23 patterns)
Tests:        not configured (no test rule matched; the work starts without tests)
Priority:     medium (config)
Writer:       claude (config), model the CLI's default (priority table), effort medium (priority table)
Reviewer:     codex (config), model the CLI's default (priority table), effort medium (priority table)
Reviewer MCP: none
Budget:       tokens 4000000 (config), tokens_per_call 1500000 (config), call_timeout 900000 (config), test_timeout 600000 (config), run_timeout 21600000 (config), rounds 2 (config)
Contract:     up to 2 work-order translation(s) by the writer (claude) and 2 check(s) by the reviewer (codex), 15 minute(s) per call
Valid until:  2026-11-06T23:31:11.999Z

The work order, as it will be sealed:
  │ ---
  │ source_id: DOC-1
  │ ---
  │ # 幫專案補一份 README
  │ …

Needs authorization. If the person says yes, run again: review-bridge start .review-bridge/work-packages/add-readme.md --yes
```

- Parentheses after a value identify its source: `cli`, `work_order`, `priority`, or `config`.
- The lower half shows the **work-order text that will be sealed**. Your authorization applies to that text. To use later edits, run `start` again.
- `Valid until` is the card's expiration time (24 hours). An expired card must be replaced with a new one.
- `Reviewer MCP` lists the MCP servers available to the reviewer. The default is `none`.

## While it runs

After authorization, Bridge reports each step. An interactive terminal shows a progress indicator while waiting:

```text
  Writer (claude) turns the work order into a contract; reviewer (codex) checks it
  Contract sealed
  Writer working (call 1 of 2)
  Tests: not configured for this project
  Reviewer checking the work
Delivered: no tests configured, reviewer passed
Result file: /…/.review-bridge/results/add-readme/DOC-1 add-readme 2026-11-06 07-31-29 success.md
Tokens: writer 153246, reviewer 60400
```

The order is fixed: the writer translates the work order into a contract, the reviewer checks it, and Bridge seals it. The writer then implements the work, for at most `rounds` rounds. After each round, **Bridge runs the project's test command**, then the reviewer checks the result. Bridge produces the final result file.

## Stop, resume, and clean

- `stop <run_id>` stops model processes and keeps the records.
- `resume <run_id>` creates a **new run** of the same work order with the same breakpoint and scope. Roles, models, effort, and budget are resolved again, and a new card requires your authorization.
- `clean` without a run ID folds finished records into daily files and deletes records past retention. `clean <run_id>` removes the specified finished run; running work cannot be removed.

Bridge **does not automatically commit, push, or deploy**. The result lists the changed files so you can inspect the work and decide whether to commit. Continue with [Results, logs, and the database](./results).
