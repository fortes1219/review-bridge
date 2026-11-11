# 設定

設定分為專案設定與個人設定：三個檔案位於專案的 `.review-bridge/`，另有一個 `settings.json` 位於 data home（使用者資料目錄）。檔案採用 JSON 或 Markdown 格式。修改時請留意下方列出的受保護欄位。

## `.review-bridge/bridge.json`

`init` 產生的設定如下。這是 0.3.0-rc.3 在一個有 `package.json`（沒有 `test` script）的專案、系統語言為繁體中文時寫出的檔案，照原樣：

```json
{
  "schema_version": 4,
  "project_id": "bdbe7d5a-c1de-4d00-ad6e-59ed13cf8d0f",
  "profile_id": "node-backend",
  "roles": {
    "writer": { "provider_id": "claude" },
    "reviewer": { "provider_id": "codex" },
    "reviewer_readonly_required": true
  },
  "requires_human_authorization": true,
  "watch": { "port": 53559, "strict_port": false },
  "retention": { "days": 15 },
  "locale": "zh-TW",
  "test": { "profile_id": "node-backend", "rules": [{ "command": "npm test", "package_script": "test" }] },
  "readiness": { "reviewer_readonly_proven": "not_run" },
  "default_policy_ref": "review-bridge/config/default-policy.json",
  "project_override_ref": ".review-bridge/policy.override.json",
  "active_runs": "derive_from_run_projections"
}
```

| 欄位 | 說明 |
|---|---|
| `project_id` | 專案在 data home 與日誌目錄中的識別碼，請勿修改 |
| `roles.writer` / `roles.reviewer` | 指定各角色使用 `claude` 或 `codex`。修改後於下一次 `start` 生效，卡片會顯示使用的配對 |
| `roles.reviewer_readonly_required`、`requires_human_authorization`、`readiness` | 受保護欄位。`init` 分別寫入 `true`、`true`、`"not_run"`；`init` 與 `upgrade` 會檢查這些值，若遭修改便停止，不能用來關閉安全限制 |
| `watch.port` | 本機頁面的連接埠。`strict_port` 為 `false` 時，若埠被占用，會依序尋找下一個可用埠 |
| `retention.days` | 執行日誌與已結束紀錄的保留天數，供 `clean` 清理時使用 |
| `locale` | 卡片、`status`、`up`、`down`、`ps`、`init` 與結果檔使用的語言：`en` 或 `zh-TW`。`init` 依系統語言寫入 |
| `test.profile_id` / `test.rules` | 專案類型與對應的驗證指令，見下方 profiles 表格。可以自己改，下一次 `start` 就生效，`upgrade` 也會保留。要換專案類型時，在專案資料夾執行 `npx review-bridge init --profile <類型>`：它不改任何檔，只印出目前的類型和要貼進來的 `test` 區塊，把這裡的 `test` 換成那段即可；不必 `uninstall` 再 `init`（那樣會換掉專案的 `project_id`，資料庫裡的紀錄就接不上了） |

## `.review-bridge/policy.override.json`

專案層的 policy 覆寫，用來調整套件預設規則。`init` 只會建立以下內容：

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

- `limits` 定義執行上限，工單的 `budget` 不得超過這些值。時間單位為毫秒；`authorization_ttl` 是卡片的有效期限，預設 24 小時。
- `priority` 表指定各優先等級的模型與 effort。`model: null` 表示採用 CLI 預設模型；工單中的 `writer:`／`reviewer:` 設定優先於此表。工單可以降低 reviewer 的 effort，專案層覆寫則不得低於表中的設定。
- `reviewer.mcp_allow`：允許 reviewer 使用的 MCP 伺服器名稱清單，預設為空，不放行任何伺服器。目前放行的伺服器**未經唯讀驗證**，卡片會顯示此限制。
- `writer.disallowed_tools`：Claude writer 禁用的工具清單。Codex writer 不支援此設定，若 policy 有設定，Bridge 會拒絕執行。

## `.review-bridge/rules.md`

Bridge 每次開始工作前提供給 writer 的規則摘要，說明可做事項、禁止事項與停止條件。可依專案需要修改，請維持在一頁以內。

## `settings.json`（data home）

所有專案共用的個人設定：

```json
{
  "schema_version": 1,
  "default_roles": { "writer": "claude", "reviewer": "codex" }
}
```

- `default_roles`：`init` 詢問角色時採用的預設值。
- `database.port`：資料庫開始尋找可用埠的位置，例如 `"database": { "port": 5440 }`；下次資料庫啟動時生效。

## 專案類型（profiles）

在 `init` 的第三項設定中選擇。類型決定每輪 writer 完成後，Bridge 使用哪個驗證指令：

| `profile_id` | 偵測 | 驗證指令 |
|---|---|---|
| `vue-frontend` | Vue 與 TypeScript 前端，含 Nuxt、VitePress、Slidev | `npm test` |
| `react-frontend` | React 前端（不含 Next） | `npm test`；Create React App（裝了 `react-scripts`）是 `npm test -- --watchAll=false`，否則測試會一直等檔案變更 |
| `next-frontend` | Next.js | `npm test` |
| `angular-frontend` | Angular | 有 `angular.json` 時是 `npm test -- --watch=false`（用 Karma 的 `ng test` 預設會一直等檔案變更），否則 `npm test` |
| `node-backend` | Node.js 後端 | `npm test` |
| `rust-backend` | Rust | `cargo test --workspace` |
| `go-backend` | Go | `go test ./...` |
| `python-backend` | Python | `python -m pytest` |
| `java-backend` | Java | `mvnw`／`mvn test`、`gradlew`／`gradle test` |
| `dotnet-backend` | .NET 與 C# | `dotnet test` |
| `php-laravel` | PHP Laravel | `php artisan test` |
| `none` | — | 不執行測試；卡片與結果會標示測試「沒有設定」 |

## 環境變數

| 變數 | 作用 |
|---|---|
| `REVIEW_BRIDGE_DATA_HOME` | 指定 data home 的位置，包含設定、資料庫與專案狀態；日誌改存於該目錄的 `logs/` |
| `CLAUDE_CONFIG_DIR` | Claude Code 的設定目錄，Bridge 的 `/review-bridge` 入口會安裝於此目錄下 |
| `XDG_STATE_HOME` | Linux 日誌目錄的根路徑，預設為 `~/.local/state` |
