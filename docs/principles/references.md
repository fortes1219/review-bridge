# Design references

Bridge requires designs to **follow established open-source practices**; departing from them is treated as a design failure. Every design needs an identifiable precedent supported by source code or official documentation. A README or a star count alone is not enough. This page lists the references and how Bridge applies them.

## The VoidZero ecosystem

Bridge follows the Vue ecosystem and uses VoidZero's Vite, Vitest, Rolldown, and Oxc as references for current and future design.

| Practice | Reference | How Bridge uses it |
|---|---|---|
| One command per job; command help is the documentation source | Vite and Vitest CLIs | 16 commands. The [CLI reference](../reference/cli) preserves help output; README command docs are generated from the command table, with a CI freshness check. |
| Configuration precedence and value provenance | Vite configuration resolution | Policy limits provide defaults, then the priority table, work order, and CLI flags apply in that order. The card lists each value’s source. |
| One interface, multiple provider modules | Vitest coverage `provider` | `agentCli/calls.mjs` is the shared entry; `claude.mjs` and `codex.mjs` handle their own flags and output. |
| Search upward when a port is occupied | Vite dev server | The local page starts at `8080`, the database at `5432`. |
| VitePress docs in the repository’s `docs/`, in three languages | Vite, Vitest, VueUse | This site. |
| Planned: oxlint verification and Rust for heavy computation, with a JavaScript entry on npm | Oxc and Rolldown’s napi-rs approach | Future direction; see [Architecture and roadmap](./architecture). |

## Other references

The following table collects the precedents for individual design decisions.

| Design | Reference | How Bridge uses it |
|---|---|---|
| Markdown work orders with YAML frontmatter | Astro content collections | From the first `---` line to the next; all fields optional, unknown fields rejected. |
| Required work-order fields | Jira required issue fields | Title, requested work, and acceptance criteria; bug reports also include environment, steps, actual and expected results, and frequency. |
| Apply a saved plan, excluding later configuration edits | Terraform `plan -out` → `apply` | The start card and human approval; `upgrade --plan-out` → `--plan --approve <sha>`. |
| Restart an edited work order and stop the superseded run | GitHub Actions `concurrency` + `cancel-in-progress` | Superseded versions follow the stop path. The new run sets `superseded_by`. |
| A time limit per run | GitHub Actions job `timeout-minutes` | `budget.run_timeout`; closes as `timed_out` on expiration. |
| Server-assigned sequences and incremental reads | Temporal sticky cache | Event files are caches: rebuild when behind, reject when ahead, use the database when contents diverge. |
| Replay after disconnection, rejecting mismatches | Kafka idempotent producer | Temporarily number local events from the last known sequence plus one; the database checks them on replay. |
| No second authoritative state in the worker | GitHub Actions, Prefect, Inngest | The database is the source of truth. |
| A result folder per work order | Playwright `test-results/<test>/` | `.review-bridge/results/<work-order>/`; one file per run, never overwritten. |
| A single place to start and stop services | `docker compose down` / `up`, `brew services` | `review-bridge down` / `up`. |
| Handling orphaned database processes | zonky embedded-postgres `cleanOldDataDirectories` | Try `pg_ctl stop -m fast`, then retry; handle only processes belonging to this data directory. |
| Leave unrecognized files untouched | Git checkout’s treatment of untracked files | `upgrade` refuses a migration only when a destination file has the same name and different content, and lists it. |
| Ask before writing `.vscode/` | `npm create vue@latest` | The final init question. |
| Preserve other tasks.json content and comments | VS Code’s `jsonc-parser` | `review-bridge vscode` and `uninstall`. |
| User-level agent entry points | Claude Code `~/.claude/commands/`, Codex `~/.agents/skills/` (`ext/skills/src/host_roots.rs`) | `/review-bridge` and `$review-bridge`. |
| Session read-only and isolation options | Claude Code `--permission-mode plan`, `--tools`, `--strict-mcp-config`; Codex `exec --sandbox read-only`, `--disable apps --disable plugins`, `mcp_servers.<name>.enabled` | Reviewer read-only checks and connector isolation. |
| Logs in OS-standard directories with rotation | `env-paths` data/log conventions | `%LOCALAPPDATA%\ReviewBridge`, `~/Library/Logs/ReviewBridge`, `$XDG_STATE_HOME/review-bridge`. |
| Database backups | PostgreSQL file-level backup | `review-bridge backup`: stop, copy the whole directory, restart. |

Considered but **not adopted**: adding marked blocks to user rc files, as conda, pnpm, and nvm do; and Node's built-in SQLite. Bridge uses its own separate files and PostgreSQL instead.

## Checking the references

- For open-source projects, read the source and record files and line numbers. If only documentation is available, record the page and date accessed.
- Use actual behavior as evidence, rather than relying only on README descriptions.
- Designs without an existing precedent are not adopted and are listed as out of scope.
