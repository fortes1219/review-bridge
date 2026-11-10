# FAQ

Common problems encountered in actual use, and how to resolve them.

## Starting work

### Claude Code does not recognize `/review-bridge`

`init` installs the command at `~/.claude/commands/review-bridge.md` for all your projects. If you set `CLAUDE_CONFIG_DIR`, look in its `commands/` directory instead. Check that the file exists. If it's missing, run `npx review-bridge init` in a project that hasn't been initialized. Codex uses the skill at `~/.agents/skills/review-bridge/SKILL.md`, invoked with `$review-bridge`.

### start says Codex or Claude is not signed in

The error includes the relevant CLI's login command, such as `codex login`. Sign in, then run the same `start` command again. Use `npx review-bridge roles-check` to check both roles' CLI installation and login status without calling a model.

### My work order was rejected for an unknown key

Frontmatter accepts only `priority`, `writer`, `reviewer`, `budget`, `source_id`, top-level `effort`, and the `id` managed by Bridge. Block markers must use one of the 17 contract field names. Errors include line numbers. See [Your first work order](./guide/work-order).

### The card never appears, and Bridge says the work order isn't ready

`start` checks the work order as a form: it needs work instructions and an acceptance list with valid Markdown items. `open_questions` must be empty or contain only `none` or `無`. If a check fails, Bridge stops before the card, lists the affected lines, and prints the command to run after you've fixed them. No model is called. See [Work-order validation](./guide/work-order#work-order-validation).

### The card expired

Authorization cards expire after 24 hours. The deadline appears under `Valid until`, currently in UTC. Run `start` again to generate a new card after it expires.

### The card calls my file a copy, but I only renamed it

Bridge identifies a work order by its frontmatter `id`. Renaming or moving the original file produces an update card that notes the previous location. A file is treated as a copy only when the original still exists and both contain the same `id`. Use `--update <work_order_id>` or `--as-new` to correct the choice. See [Which work order are you approving?](./guide/start#work-order-identity).

### I edited the work order. Will Bridge use the new version?

Run `start` again to use your edits. Authorization covers only the work-order text you approved. If you edit the file after a run starts, the result includes a “Work order changed after the start” section explaining that those edits weren't part of the run.

## Reviewers and connectors

### The read-only check fails with Claude as reviewer

A Claude Code reviewer session may use only `Read`, `Grep`, and `Glob`, plus Bridge's read-only graph server and servers allowed by policy. If its `init` event lists other tools, including tools from other MCP connectors, the check fails and work doesn't start. Every call uses `--strict-mcp-config`. If extra tools remain, use the diagnostic output to check what the session actually loaded.

### What does `Reviewer MCP: none` mean?

Bridge isolates personal MCP connectors, including Claude connectors and servers listed by `codex mcp list`, such as `node_repl`. `none` means the policy hasn't allowed any additional servers for the reviewer. Both roles receive Bridge's read-only `review-bridge-graph` server; it isn't listed on this line.

To allow a server, add it to the project's `reviewer.mcp_allow` policy. Allowed servers currently have no read-only verification, and the card states this limitation. See [Concepts](./concepts/).

### The Codex writer cannot run tests: spawn EPERM

On Windows, running `npm test` (Vitest) inside the Codex 0.166 sandbox can fail with `spawn EPERM`. After every writer round, Bridge runs the project's test command **outside** the agent sandbox. Acceptance uses the test result Bridge obtains.

## Results

### The result says no files changed, but the writer says it made changes

The first list under “Files changed” comes from Git. The writer's claims appear separately under “What the writer says it changed (not checked against Git).” If they disagree, compare the Git list with “Files already uncommitted at the start.” A writer's claim alone isn't evidence of a change.

### Where are the result file and logs?

Readable results live in the project's `.review-bridge/results/<work-order>/` directory. Full logs—including prompts, streams, stderr, test output, plans, and authorization cards—live in the operating system's log directory. `npx review-bridge status` shows its location under `Logs`; `npx review-bridge logs <run_id>` explains each file.

### The reviewer passed the work, but its extra findings aren't in the result

Successful result files currently list what the reviewer verified and didn't run, but omit its additional findings. Those remain in the database and the review file named by `Latest review` in `status`. See [Result files](./guide/results#result-files).

### .vscode/tasks.json causes the result to mention uncommitted changes

You decide whether Git should track `.vscode/tasks.json`. Bridge does not automatically add or exclude it. Until you commit or ignore it, Git treats it as an uncommitted change.

## Database and environment

### The database is not on port 5432

If port 5432 is taken, Bridge searches upward for an available port at each startup. `init` and `npx review-bridge status` show the port in use. To start searching elsewhere, add `"database": { "port": 5440 }` to `settings.json` in your data home.

### init rejects a project on OneDrive or a network drive

Bridge state requires a local filesystem. Synced folders and network drives are rejected, including OneDrive, Dropbox, iCloud Drive, UNC, NFS, and SMB. Move the project to a local disk.

### Codex output is garbled on Chinese Windows

PowerShell writes in the system code page, while Codex reads UTF-8. A mismatch can garble text. Add `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` to `$PROFILE`, or use PowerShell 7. `npx review-bridge doctor` reports whether UTF-8 is in use. See [Windows](./guide/maintenance#windows).

### A run stopped with `database_unavailable`

The database stopped responding during execution. Bridge stops the run and makes no further model calls. The terminal reports that the database is unavailable. Records saved to files during the interruption are written back by the next command that opens the database. Check `npx review-bridge status`, start it with `npx review-bridge up`, then run `start` again.

### The database is still running after I close the terminal

That's expected. The database and local page keep running after the terminal or VS Code closes. Stop them with `npx review-bridge down`. If any project has an active run, `down` lists the runs and refuses to stop.

### When do role changes in bridge.json take effect?

On the next `start`. Active runs keep their roles. The card shows the pairing used for each run.

### Can I use Linux?

Linux blocks native model execution. Windows x64 has been verified natively. Apple Silicon macOS is selectable but hasn't been verified in a native environment.
