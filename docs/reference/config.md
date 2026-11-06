# Configuration

Configuration is split between project and personal settings: three files in the project's `.review-bridge/` and one `settings.json` in data home (your user data directory). Files use JSON or Markdown. Check the protected fields below before editing.

## `.review-bridge/bridge.json`

`init` generates this configuration:

```json
{
  "schema_version": 4,
  "project_id": "64c4a2f2-7c52-4f70-859f-a94c24008089",
  "profile_id": null,
  "roles": {
    "writer": { "provider_id": "claude" },
    "reviewer": { "provider_id": "codex" },
    "reviewer_readonly_required": true
  },
  "requires_human_authorization": true,
  "watch": { "port": 8080, "strict_port": false },
  "retention": { "days": 15 },
  "locale": "en",
  "test": { "profile_id": null, "rules": [] },
  "readiness": { "reviewer_readonly_proven": "not_run" },
  "default_policy_ref": "review-bridge/config/default-policy.json",
  "project_override_ref": ".review-bridge/policy.override.json",
  "active_runs": "derive_from_run_projections"
}
```

| Field | Description |
|---|---|
| `project_id` | Identifies the project in data home and the log directory. Do not change it. |
| `roles.writer` / `roles.reviewer` | Assigns `claude` or `codex` to each role. Changes take effect on the next `start`, and the card shows the pairing. |
| `roles.reviewer_readonly_required`, `requires_human_authorization`, `readiness` | Protected fields. `init` writes `true`, `true`, and `"not_run"`, respectively. `init` and `upgrade` stop if these values have changed; they are not switches for disabling safety restrictions. |
| `watch.port` | Port for the local page. If `strict_port` is `false` and the port is occupied, Bridge searches upward for a free one. |
| `retention.days` | Days to keep execution logs and finished records, used by `clean`. |
| `test.profile_id` / `test.rules` | Project type and its verification command; see the profiles below. |

## `.review-bridge/policy.override.json`

Project-level overrides adjust the package's default policy. `init` creates only:

```json
{ "schema_version": 5, "profile_id": null }
```

The default policy is in the package's `review-bridge/config/default-policy.json`:

```json
{
  "limits": {
    "rounds": 2,
    "call_timeout": 900000,
    "max_turns": 20,
    "tokens_per_call": 1500000,
    "tokens": 4000000,
    "test_timeout": 600000,
    "run_timeout": 21600000,
    "authorization_ttl": 86400000
  },
  "writer": { "mode": "writer_only", "disallowed_tools": [], "self_review": "one_local_consistency_pass" },
  "reviewer": { "mcp_allow": [] },
  "priority": {
    "default": "medium",
    "writer":   { "low": { "model": null, "effort": "low" }, "medium": { "model": null, "effort": "medium" }, "high": { "model": null, "effort": "high" }, "urgent": { "model": null, "effort": "high" } },
    "reviewer": { "low": { "model": null, "effort": "low" }, "medium": { "model": null, "effort": "medium" }, "high": { "model": null, "effort": "high" }, "urgent": { "model": null, "effort": "high" } }
  },
  "release_actions_require_human": true
}
```

- `limits` defines execution ceilings. The work order's `budget` cannot exceed them. Times are in milliseconds; `authorization_ttl` is the card's lifetime, 24 hours by default.
- The `priority` table sets the model and effort for each priority level. `model: null` uses the CLI's default. The work order's `writer:` and `reviewer:` settings take precedence. A work order may lower reviewer effort below this table; a project override may not.
- `reviewer.mcp_allow` lists MCP server names the reviewer may use. It is empty by default, allowing none. Allowed servers currently have **no read-only verification**; the card states this limitation.
- `writer.disallowed_tools` lists tools disabled for a Claude writer. A Codex writer does not support this setting; if it is set in policy, Bridge refuses to start.

## `.review-bridge/rules.md`

Before each run, Bridge gives the writer this summary of permitted actions, prohibited actions, and stop conditions. You can edit it for your project; keep it to one page.

## `settings.json` in data home

Personal settings shared by all projects:

```json
{
  "schema_version": 1,
  "default_roles": { "writer": "claude", "reviewer": "codex" }
}
```

- `default_roles`: the defaults offered when `init` asks for roles.
- `database.port`: the port from which the database starts searching, for example `"database": { "port": 5440 }`. Takes effect the next time the database starts.

## Project types (profiles)

Choose a type in init's third setting. It selects the verification command Bridge runs after each writer round:

| `profile_id` | Detection | Verification command |
|---|---|---|
| `vue-frontend` | Vue and TypeScript frontend | `npm test` |
| `node-backend` | Node.js backend | `npm test` |
| `rust-backend` | Rust | `cargo test --workspace` |
| `go-backend` | Go | `go test ./...` |
| `python-backend` | Python | `python -m pytest` |
| `java-backend` | Java | `mvnw` / `mvn test`, `gradlew` / `gradle test` |
| `dotnet-backend` | .NET and C# | `dotnet test` |
| `php-laravel` | PHP Laravel | `php artisan test` |
| `none` | — | No tests run; the card and result say `tests: not configured`. |

## Environment variables

| Variable | Purpose |
|---|---|
| `REVIEW_BRIDGE_DATA_HOME` | Sets the location for settings, the database, and project state. Logs move to its `logs/` subfolder. |
| `CLAUDE_CONFIG_DIR` | Claude Code's configuration directory. Bridge installs its `/review-bridge` entry under this directory. |
| `XDG_STATE_HOME` | Root directory for Linux logs; defaults to `~/.local/state`. |
