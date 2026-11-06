# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `start` and `resume` ask twice, both times before any work. The first yes pays for turning the work order into a contract and for the questions, which are asked outside any run; no model is called before it, the reviewer's read-only check included. The second yes is to the card that names the sealed contract, and only it opens a run. A directory is a pipeline: every work order is sealed and every question asked at once, then one yes and the runs in order, with nothing asked in between; one that cannot be sealed keeps the others from working. A sealed contract is kept, so saying no to the second card or starting the same text again costs nothing. Adds the tables `contract_gatherings` and `contract_gathering_events`.
- `start <directory>` runs a subdirectory of `.review-bridge/work-packages/` as one line: in file name order (`01-`, `02_`; the numberless last), on one yes to a card that lists the files without their text, one run per work order, each with its own authorization and contract. A failed work order does not stop the next; a provider that signed out or ran out of quota, `stop`, or Ctrl+C stops the line. What the records show as delivered is skipped; starting the directory again runs what is pending. `status` shows the line's progress, a table ends it, and results go under `results/<directory>/<work order>/`.
- When a work order stops to ask you, you can answer where you are. The question comes at the terminal in yellow with up to three ready-made ways of doing it, each saying why, and two ways out: let the AI decide, or say it yourself. At most three questions and three rounds; what would not change the work, or has an ecosystem convention, takes the recommended reading and is listed under `Readings adopted` in the result. Your answer goes at the end of the work order under `<!-- bridge:clarifications -->`, nothing you wrote changes, and the new version takes a new yes. A directory asks everything after its table. An agent passes the answers with `--answer`.
- A work order can be one sentence, even with no `# ` title (it is then `untitled`): without an `acceptance` block the reviewer proposes sets of conditions, and the one you choose is added to the file. In a directory too: only a file Bridge cannot read as a work order, or a `TEMPLATE*.md`, is left out.
- A work order's file name can be in any language: letters, digits and marks of any script, `.`, `_`, `-` and single spaces, up to 80 characters and 180 bytes. Names are compared and stored in NFC, so one file is one work order on every machine. A name Bridge cannot use is refused before the card, where it used to fail at the yes.
- An agent can run the work for you: without a terminal, `start` and `resume` print the card and stop with `Needs authorization`; after you say yes the agent runs the same command with `--yes`. The authorization records `authorized_via` (`terminal` or `agent`) and the SHA-256 of the sealed work-order text. `--yes` takes the plan of the card shown before it, and one card starts one run. It is refused when no card was shown, when the work order changed after the card, when an option given with it is not what the card showed, when the card is past its `Valid until`, or when the card already started a run; nothing is started or authorized.
- `resume <run_id>` carries a stopped work order on as a new run with that run's stop point and scope, and the roles as they are now; `clean [<run_id>]` clears records (same as `prune`, or `rm` with a run id).
- `/review-bridge` (Claude Code) and `$review-bridge` (Codex) teach agents the four actions (start, stop, resume, clean) and that only the person says yes.
- `review-bridge start <file>`: one command from a work order to its result. It plans the work, runs the reviewer read-only check once per page session, shows what the answer authorizes, asks `Start this work? [y/N]` and prints one line per step. `work-plan` and `work-start` stay for agents and scripts.
- `init` adds Bridge's own entry outside the project, where each agent looks for yours: the command `~/.claude/commands/review-bridge.md` for Claude Code (`CLAUDE_CONFIG_DIR` is honoured) and the skill `~/.agents/skills/review-bridge/SKILL.md` for Codex. A new project's `git status` shows nothing after `init`, and `.claude/`, `AGENTS.md` and `CLAUDE.md` in the project are not touched. A file of yours at those paths is left alone; `uninstall` of the last project set up removes Bridge's unless you edited them. `upgrade` installs them and takes back what an earlier setup wrote into the project's `.claude/commands/` and `AGENTS.md`, unless you edited it.
- Writer and reviewer run as you chose them, in all four pairings of `claude` and `codex`: the contract translation, the work and every fix go to the writer's CLI, the contract check and every review to the reviewer's, each as its own session. The roles come from `bridge.json`, or `--writer`/`--reviewer` on `start`, `resume` and `work-plan` for one run. The card names them and the run keeps them: changing `bridge.json` only affects the next start.
- `claude` can be the reviewer. Its read-only check runs Claude Code in plan mode with only `Read`, `Grep` and `Glob` and no MCP servers, asks it to write a sentinel file, and passes only when the file is absent, the CLI ran to its end, and its own `init` event shows that session. Each reviewer has its own proof.
- Work orders can set a role's model and effort: a `writer:` or `reviewer:` block in the frontmatter, each with `model` and `effort`, over the policy's priority table. The top-level `effort` still works and is the writer's; writing both is refused. `model: null` means the CLI's own default.
- Each run's row in the database and the head of its result file record each role's provider, model and effort.
- VS Code tasks for `start`, `stop`, `resume`, `clean`, `status` and `logs`: open Quick Open and type `task review-bridge`. `init` asks once whether to add them to the project's `.vscode/tasks.json` (no unless you say yes; never asked without a terminal), `review-bridge vscode` does the same later and `review-bridge vscode --user` adds them to your user tasks. Your other tasks, inputs, comments and layout in the file stay as they are, and `uninstall` takes only Bridge's out.
- Every command has `--help`, generated from the command table with each option's type, default and help line. `--help --all` also lists the commands and options for agents and tests. README's Commands section is generated from the same table, and CI fails when it is out of date.
- Work orders, their versions, plans, authorizations and contracts are recorded in your database (embedded PostgreSQL, one for all your projects; created on first use and migrated by dated migration files). `init` gives the project an id in `bridge.json`; `upgrade` adds one to an older project. The card says which work order the yes starts (a new one, a new version of one, or the same version with new settings); `--update <work_order_id>` and `--as-new` print a card that says otherwise. `--yes` finds its card in the database, and two `--yes` to one card start one run. The files under `.review-bridge/` are kept as the running copy.
- Runs are recorded in your database too: the run, its events in one sequence, Gate A's result, the reviewer's verdict per condition and findings, Bridge's acceptance decision per condition, and the delivery. A run's state changes in the same transaction as the event that changes it. `clean <run_id>` removes the run and everything it owns in one delete; its authorization stays, so its card never takes another yes.
- `status`, `work-status` and `doctor` read from your database: each run with its status, why it stopped, its work order file and when it began, ten at a time (`--after <run_id>` for the next ten). `status` ends with the database's host, port, database, user and password file, to open every table in VS Code's PostgreSQL extension or SQLTools.
- A run that loses its database mid-way stops as `database_unavailable` and calls no model after that; what it recorded meanwhile is written to the database by the next command that opens it. A read that cannot open the database says why and where to look, and exits non-zero.
- Terminal tests (the Guide's questions, Ctrl+C, the card's y and n) run in `npm test` through a pseudo-terminal (`@lydell/node-pty`, a dev dependency with prebuilt binaries); where it cannot load they are skipped with the reason.
- `doctor` on Windows says when PowerShell does not write UTF-8 (Codex's Chinese output then arrives broken) and which line to add to `$PROFILE`; README's Platforms section explains it.
- `clean --all` clears this project's records from your database; the project id is not used again. `--project <folder>` still names the project, so `clean --all --project <folder>` clears that one.

### Fixed

- A writer that could not run the tests where it is no longer stops the work. A condition whose `verify` is `test` is decided by Bridge's own run of the tests: not done on the writer's side is not a contradiction, and a writer that reports `blocked` for that reason alone, asking you nothing, goes on to the tests and the review.
- A result that needs your decision now gives the writer's own words in Why (what it could not check, and each condition's note). `Files changed` also lists what the writer says it changed, marked as not checked against Git, and what was already uncommitted when the run started.
- Changing the writer or reviewer in `bridge.json` no longer stops `upgrade`: the roles are yours to change, `upgrade` keeps them and `status` names them. Only `requires_human_authorization`, `reviewer_readonly_required` and `reviewer_readonly_proven` are protected.
- Your personal connectors no longer reach the sessions Bridge starts. `--tools ""` removes built-in tools only, so a real translation session still held your MCP servers' tools, and so did the writer. With Claude Code every call now takes `--strict-mcp-config`, and a project's `.mcp.json` reaches its writer only (`--mcp-config .mcp.json`). With Codex every call takes `--disable apps --disable plugins` and turns off by name each MCP server in `codex mcp list`; a list that cannot be read refuses the start.
- The policy's `reviewer.mcp_allow` (default empty) names MCP servers to let through as they are; they are not checked to be read-only. The card, the run's row and the result's `reviewer.mcp` say what the reviewer was given.
- A contract translation whose session still lists an MCP tool is not used: nothing is sealed, no work starts, and the result says which tools.
- `init` in a Git project whose path is a Windows 8.3 short name (`C:\Users\RUNNER~1\…`, as on GitHub's Windows runners) no longer stops with "Git exclusion path is outside the selected Git directory".

- The reviewer read-only check on a Chinese Windows: PowerShell's denial arrives broken (Codex reads its CP950 output as UTF-8), so it was never recognized. The check now also recognizes PowerShell's `UnauthorizedAccessException`, the English `Access to the path '…' is denied.` and the Chinese 「存取被拒」「拒絕存取」. The probe's output is decoded as one UTF-8 stream.
- A project type chosen explicitly is set up even when the folder shows no sign of it; a mismatch stops code work at Gate A.

### Changed

- The policy no longer names a writer model: `model` defaults to `null` for both roles, so each CLI uses its own default. A model that does not belong to the role's CLI (in a work order or the policy) is refused before the card.
- A plan or a contract made before this release is not read again; `start` makes a new card.
- Requires Node.js 22.8 or newer.
- Native work no longer requires an interactive terminal (T0-08's terminal rule is withdrawn); the reviewer read-only proof is still required before any model call.
- `status` shows what Bridge is doing now: the page, the runs and the review queue (`--json` for all of it).
- `start` without a terminal takes the default breakpoint and change types instead of refusing.
- The main way in is your agent: `init`, its `--help` and README start a work order with `/review-bridge start <file>` in Claude Code (`$review-bridge start <file>` in Codex); `review-bridge start <file>` at a terminal is for advanced use and CI.
- `work-plan` prints two lines (the plan and the next command); `--json` prints the JSON.
- Refusals end with the command to run next.
- Review Bridge is distributed on npm: `npx review-bridge init` or `npm i -g review-bridge`. Upgrading and removing Bridge are `npm i -g review-bridge@latest` and `npm uninstall -g review-bridge`.
- `review-bridge init` follows create-vite: it asks the writer, the reviewer and the project type, each with a default, then sets up the current folder one step per line and ends with the next commands. Nothing is confirmed and no plan is printed; options answer the questions, and without a terminal the defaults are used.
- The project type can be `none`; a folder with no detected type is set up as `none` instead of being refused.
- `review-bridge work-plan <file>` takes the work-order file directly; the work package name, the plan path and the owner have defaults.
- `--version` prints the version; `--help` describes the npm command.

### Removed

- The release ZIP, `SHA256SUMS.txt` and the integrity check before every command; npm verifies the package.
- Installing from a clone with `npm start`, registering the command with `npm link`, and upgrading Bridge in place.
- `uninstall` without `--target`; use `npm uninstall -g review-bridge`.
