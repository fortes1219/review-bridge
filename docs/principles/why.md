# Design decisions

Each section explains a problem, the approach, its precedent, and the design boundary. Every approach must have a reference in the existing ecosystem; mechanisms without one are not adopted.

## Approve the plan before creating the contract

**Problem:** An ambiguous work order can lead a model to assume requirements, with misunderstandings discovered only after implementation. Without a record, it is also hard to establish who approved what.

**Approach:** `start` seals the work order, scope, budget, and verification command into a plan, then shows the card. Approval applies to that text and SHA-256; later file edits do not change the authorized work. Authorization is recorded in the database and cannot be changed. Missing, malformed, expired (24 hours), or used authorization is rejected. After authorization, the writer translates the work order into a contract and the reviewer checks it. Ambiguity stops work for a human decision.

**Precedent:** Terraform's `plan -out` → `apply <plan>` applies a saved plan, excluding configuration edits made afterward. Bridge's `upgrade --plan-out` → `--plan --approve <sha>` follows that pattern. Binding content to a hash also draws on Git commits and tags.

**Boundary:** Agents must not authorize work themselves; the agent tool's permission prompts must enforce that boundary. Approval is not a standing authorization for future work. `release_actions_require_human` cannot be disabled.

## Verify the reviewer's read-only restrictions

**Problem:** A read-only instruction in a prompt does not restrict write access. A reviewer that can edit the work under review cannot maintain the independent-review boundary.

**Approach:** Bridge starts the reviewer in a separate session using the CLI's restrictions: Codex `exec --sandbox read-only`; Claude Code `--permission-mode plan --tools Read,Grep,Glob` with `--disallowedTools`.

Before work starts, Codex attempts a sentinel-file write that its OS sandbox must deny. Claude Code's `init` event must list only the three read tools, and the sentinel file must not exist. Work is refused if the check fails. The checks provide different levels of evidence, documented separately.

**Precedent:** CI checks that use read-only tokens. CLI output and the operating-system sandbox provide the evidence for the restriction.

**Boundary:** Prompts do not substitute for permissions. Bridge does not implement its own sandbox.

## Let Bridge run verification

**Problem:** A writer's claim that tests passed needs a real result to back it up. Agent environments can also prevent tests from running; for example, Codex's Windows sandbox may cause Vitest to fail with `spawn EPERM`.

**Approach:** After every writer round, Bridge runs the project type's test command outside the agent sandbox, such as `npm test` or `cargo test --workspace`. Tests must pass before review. Work can run without a test command, but the card, records, and result state this explicitly.

**Precedent:** CI required checks use actual execution results to determine success.

**Boundary:** The writer does not choose the test command. Test results do not replace the reviewer's verdict.

## Read work proof from Git

**Problem:** The model's list of changed files may differ from the actual work. Changes need an independent source of evidence.

**Approach:** Bridge records the starting commit, reads changes from Git at the end, and checks its own records. Results separate Git-observed changes, unchecked writer claims, and changes already uncommitted at the start. If history is rewritten or the branch changes during execution, Bridge stops the comparison. Projects without Git explicitly have no work proof.

**Precedent:** A PR diff is computed against a base commit so reviewers can inspect the actual changes.

**Boundary:** Bridge does not commit, push, merge, or deploy. A person decides whether to accept the work.

## Keep the database as the source of truth

**Problem:** Records scattered across working-directory JSON and Markdown files are hard to query across projects or expose through one interface.

**Approach:** Bridge provides one PostgreSQL instance per user, listening only on `127.0.0.1`. It records work orders, versions, plan cards, authorizations, contracts, runs, events, verdicts, and deliveries.

Event files in the runtime state directory are caches. Reads check database sequence numbers: rebuild a cache that is behind, reject one that is ahead, and use the database if contents diverge. When the database disconnects, only shutdown and delivery are allowed. On reconnection, the database assigns sequence numbers during replay and rejects mismatches.

**Precedent:** Temporal sticky cache's server sequences and incremental reads, and Kafka idempotent producers' client sequences checked by the broker. Worker-state management is compared with GitHub Actions, Prefect, and Inngest.

**Boundary:** There is no second authoritative state. WAL growth, IO, and locking for concurrent runs informed the choice not to use SQLite. Backups use PostgreSQL's file-level procedure, without a custom format.

## Limit changes to project files

**Problem:** As a global tool, Bridge should avoid unrequested edits to a project's `.gitignore`, `AGENTS.md`, `CLAUDE.md`, or `.claude/`, and keep runtime records out of project content.

**Approach:** Project settings, work orders, and result copies go in `.review-bridge/`, excluded through `.git/info/exclude`. Agent entry points use Bridge-owned files at the user level (`~/.claude/commands/review-bridge.md`, `~/.agents/skills/review-bridge/SKILL.md`), shared across projects and managed by `uninstall`. State and logs use OS data and log directories.

Writing `.vscode/tasks.json` is an optional integration. It is off by default and requires asking the user first.

**Precedent:** `env-paths` data/log conventions; create-vue's question before writing `.vscode/`; VS Code's `jsonc-parser` for preserving comments in `tasks.json`.

**Boundary:** Apart from that optional VS Code integration, existing user files are unchanged. Bridge does not append marked sections to `AGENTS.md`. The conda/pnpm/nvm approach was evaluated but not adopted. User-created skills are left alone.

## Isolate personal connectors

**Problem:** Sessions may inherit MCP connectors configured in Claude or Codex, such as Drive, a database, or `node_repl`. A contract-translation session receiving a delete-file tool would exceed its required permissions.

**Approach:** Every Claude Code call uses `--strict-mcp-config`; the project's `.mcp.json` reaches only the writer. If translation still exposes MCP tools in its `init` event, Bridge stops the run.

Every Codex call uses `--disable apps --disable plugins` and disables servers listed by `codex mcp list` individually. If that list cannot be read, work is refused. Servers explicitly allowed through `reviewer.mcp_allow` are not verified as read-only, and the card states this.

**Precedent:** Both CLIs' existing isolation options, applied explicitly on every call.

**Boundary:** No custom MCP proxy. No server is allowed by default.

## Enforce limits in code

**Problem:** Stating effort, budgets, and round counts in natural-language work orders or skills does not ensure that a model follows them.

**Approach:** Schema-validated policy JSON sets the ceilings: rounds, per-call time, token usage, test time, and total run time. Work-order settings cannot exceed them.

Settings have a fixed precedence: CLI flags → work order → priority table → limits. Plans record each value's source and show it on the card. Settings are loaded when the plan is sealed; the same inputs produce the same result.

**Precedent:** Vite's CLI → configuration → defaults precedence, and GitHub Actions job `timeout-minutes`.

**Boundary:** Models do not decide budgets. Project overrides cannot lower reviewer effort below the priority table.

## Have Bridge complete the upgrade

**Problem:** Asking users to stop old services, diagnose database startup, or move old directories makes upgrades easy to interrupt or leave incomplete.

**Approach:** `upgrade` follows a fixed sequence: stop the old service → back up → migrate → check integrity → clean old files → start → health check. It is idempotent and can be rerun after interruption. Unrecognized files stay untouched and do not block upgrading.

**Precedent:** Migration tools that record completed steps and apply only pending migrations; service stop/start flows such as `docker compose down` / `up` and `brew services`.

**Boundary:** The old rc2 layout is not retained. There is no idle auto-shutdown mechanism requiring another resident process.
