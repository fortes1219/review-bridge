# 設定

三個檔在專案裡，一個在你的 data home。全部是 JSON 或 Markdown，`init` 建好，想改直接改。

## `.review-bridge/bridge.json`

`init` 建出來的樣子：

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

| 欄位 | 意思 |
|---|---|
| `project_id` | 這個專案在 data home 與 log 目錄裡的資料夾名；不要改 |
| `roles.writer` / `roles.reviewer` | 誰當 writer、誰當 reviewer：`claude` 或 `codex`。改了影響下一次 `start`，卡片會印 |
| `roles.reviewer_readonly_required`、`requires_human_authorization`、`readiness` | 受保護的設定：`init` 寫成 `true`、`true`、`"not_run"`，`init` 與 `upgrade` 的設定檢查會確認它們沒被改，改了就停下。不是開關 |
| `watch.port` | 本機頁面的埠；`strict_port` 為 `false` 時被占就往上找 |
| `retention.days` | run 的 log 與做完的紀錄保留幾天，`clean` 照它丟 |
| `test.profile_id` / `test.rules` | 專案類型與它的驗證指令（見下方 profiles） |

## `.review-bridge/policy.override.json`

專案層的 policy 覆寫，蓋在套件的預設 policy 上。`init` 建出來只有：

```json
{ "schema_version": 5, "profile_id": null }
```

預設 policy（套件內 `review-bridge/config/default-policy.json`）的內容：

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

- `limits` 是上限：工單的 `budget` 只能比它小。時間單位毫秒；`authorization_ttl` 是卡片的有效期（24 小時）。
- `priority` 表決定每個 priority 等級的模型與 effort；`model: null` 是讓 CLI 用自己的預設。工單的 `writer:`／`reviewer:` 蓋過這張表。工單可以把 reviewer 的 effort 降到表以下，專案覆寫不行。
- `reviewer.mcp_allow`：放行給 reviewer 的 MCP 伺服器名字清單，預設空＝全關。放行的伺服器**沒有**唯讀證明，卡片會寫。
- `writer.disallowed_tools`：對 Claude writer 關掉的工具。Codex writer 沒有這個開關，policy 設了會拒絕開工。

## `.review-bridge/rules.md`

每次工作開始前，Bridge 固定送給 writer 的一頁規則（能做的、不能做的、遇到什麼就停）。可以改，保持一頁以內。

## `settings.json`（data home）

你個人的設定，所有專案共用：

```json
{
  "schema_version": 1,
  "default_roles": { "writer": "claude", "reviewer": "codex" }
}
```

- `default_roles`：`init` 問角色時的預設值。
- `database.port`：資料庫從哪個埠開始找，例如 `"database": { "port": 5440 }`；下次資料庫啟動時生效。

## 專案類型（profiles）

`init` 的第三題。類型決定每回 writer 做完後 Bridge 跑哪個驗證指令：

| `profile_id` | 偵測 | 驗證指令 |
|---|---|---|
| `vue-frontend` | Vue 與 TypeScript 前端 | `npm test` |
| `node-backend` | Node.js 後端 | `npm test` |
| `rust-backend` | Rust | `cargo test --workspace` |
| `go-backend` | Go | `go test ./...` |
| `python-backend` | Python | `python -m pytest` |
| `java-backend` | Java | `mvnw`／`mvn test`、`gradlew`／`gradle test` |
| `dotnet-backend` | .NET 與 C# | `dotnet test` |
| `php-laravel` | PHP Laravel | `php artisan test` |
| `none` | — | 不跑測試；卡片與結果寫「tests: not configured」 |

## 環境變數

| 變數 | 作用 |
|---|---|
| `REVIEW_BRIDGE_DATA_HOME` | 把 data home（設定、資料庫、專案狀態）搬到這裡；log 跟著放它底下的 `logs/` |
| `CLAUDE_CONFIG_DIR` | Claude Code 的設定目錄；Bridge 的 `/review-bridge` 入口照它放 |
| `XDG_STATE_HOME` | Linux 的 log 目錄根（預設 `~/.local/state`） |
