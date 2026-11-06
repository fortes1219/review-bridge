# FAQ

Common problems encountered in actual use, and how to resolve them.

## Starting work

### Claude Code does not recognize `/review-bridge`

`init` installs the shared entry point at `~/.claude/commands/review-bridge.md`. If `CLAUDE_CONFIG_DIR` is set, it goes in that directory's `commands/` folder. Check whether the file exists. If missing, run `review-bridge init` in a project that has not been initialized. The Codex entry point is `~/.agents/skills/review-bridge/SKILL.md`, called with `$review-bridge`.

### start says Codex or Claude is not signed in

The error shows the appropriate login command, such as `codex login`. Sign in, then rerun the same `start`. `review-bridge roles-check` checks CLI installation and sign-in status for both roles without calling a model.

### My work order was rejected for an unknown key

Frontmatter accepts only `priority`, `writer`, `reviewer`, `budget`, `source_id`, and the legacy top-level `effort`. Block markers accept only the contract's 17 fields. Errors include a line number. See [Your first work order](./guide/work-order).

### Work stopped before any model call because of open questions

Every nonempty line in `open_questions`, other than `無` or `none`, is treated as an unresolved question. Bridge stops until you answer it in the work order. It also stops if no acceptance criteria are provided.

### The card expired

Cards are valid for 24 hours. `Valid until` shows the deadline. Run `start` again to generate a new card.

### I edited the work order. Will Bridge use the new version?

Run `start` again. Authorization applies only to the text you confirmed. Edits made after a run begins appear under “Work order changed after the start” in the result, with a note that they were not used.

## Reviewers and connectors

### The read-only check fails with Claude as reviewer

The reviewer session may expose only `Read`, `Grep`, and `Glob`. If its `init` event lists any additional tool, including an MCP tool, the check fails and work does not start. Every call uses `--strict-mcp-config`; if tools remain, use the diagnostic message to check what that session actually loaded.

### What does Reviewer MCP: none mean?

Bridge isolates personal MCP connectors, including Claude connectors and servers listed by `codex mcp list` (including `node_repl`). `none` means no MCP server was made available to the reviewer.

To allow a server, add it to the project's `reviewer.mcp_allow` policy. Allowed servers currently have no read-only verification, and the card states this limitation. See [Concepts](./concepts/).

### The Codex writer cannot run tests: spawn EPERM

On Windows, running `npm test` (Vitest) inside the Codex 0.166 sandbox can fail with `spawn EPERM`. After every writer round, Bridge runs the project's test command **outside** the agent sandbox. Acceptance uses the test result Bridge obtains.

## Results

### The result says No files were changed, but the writer claims otherwise

The first “Files changed” list comes from Git. Writer claims appear separately under “What the writer says it changed (not checked against Git)”. If they differ, compare the Git list with “Already uncommitted when the run started”. The writer's report alone is not evidence of a change.

### Where are the result file and logs?

The project keeps result copies in `.review-bridge/results/<work-order>/`. Full logs, including prompts, streams, stderr, test output, plans, and cards, live in the operating system's log directory. `review-bridge status` shows the location under `Logs:`, and `review-bridge logs <run_id>` explains each file. See [Results, logs, and the database](./guide/results).

### .vscode/tasks.json causes the result to mention uncommitted changes

You decide whether Git should track `.vscode/tasks.json`. Bridge does not automatically add or exclude it. Until you commit or ignore it, Git treats it as an uncommitted change.

## Database and environment

### The database is not on port 5432

If 5432 is occupied, Bridge searches upward for the next free port at each database start. `init` and `review-bridge status` show the current port. To start from another port, add `"database": { "port": 5440 }` to data home's `settings.json`.

### init rejects a project on OneDrive or a network drive

Bridge state requires a local filesystem. Synced folders and network drives are rejected, including OneDrive, Dropbox, iCloud Drive, UNC, NFS, and SMB. Move the project to a local disk.

### Codex output is garbled on Chinese Windows

PowerShell may output the system code page while Codex reads UTF-8. Add `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` to `$PROFILE`, or use PowerShell 7. `review-bridge doctor` reports whether UTF-8 is in use. See [Upgrade, back up, and uninstall → Windows](./guide/maintenance#windows).

### When do role changes in bridge.json take effect?

On the next `start`. Active runs keep their roles. The card shows the pairing used for each run.

### Can I use Linux?

Linux is experimental; native model work fails closed by default. Windows x64 has been verified natively. Apple Silicon macOS can be selected but has not been verified natively.
