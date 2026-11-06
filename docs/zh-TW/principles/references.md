# 設計參考

Bridge 要求設計**遵循開源生態的既有做法**，不符合者視為設計失敗。每項設計都須能指出參考對象，並以原始碼或官方文件為依據；僅閱讀 README 或參考專案星號數並不足夠。本頁整理各項設計的參考來源與採用方式。

## VoidZero 生態的參考做法

Bridge 以 Vue 生態為技術方向，並以 VoidZero 旗下的 Vite、Vitest、Rolldown 與 Oxc 作為目前及後續設計的參考。

| 參考做法 | 來源 | Bridge 的採用方式 |
|---|---|---|
| CLI 結構：每個指令負責一項工作，以 `--help` 作為指令文件來源，由 `<cmd> --help` 列出選項 | Vite、Vitest 的 CLI | 16 個指令；[指令參考](../reference/cli)保留 `--help` 原始輸出；README 的指令段落由腳本依指令表產生，CI 檢查文件是否過期 |
| 設定優先順序：旗標高於設定檔，設定檔高於預設值，並記錄各值的來源 | Vite 的 config 解析 | 由 policy limits 提供預設，再依序套用 priority 表、工單與終端機旗標；卡片列出各值的來源 |
| 一個介面、多個 provider 模組 | Vitest 的 coverage `provider` | 以 `agentCli/calls.mjs` 為共用入口，由 `claude.mjs` 與 `codex.mjs` 分別處理各自的旗標與輸出 |
| 連接埠被占用時，依序尋找下一個可用埠 | Vite dev server | 本機頁面從 `8080`、資料庫從 `5432` 開始尋找可用埠 |
| 使用 VitePress，將三語文件存放於儲存庫的 `docs/` | Vite、Vitest、VueUse | 本站 |
| 後續規劃：驗證加入 oxlint，以 Rust 處理高負載運算，保留 npm 上的 JavaScript 入口 | Oxc、Rolldown 的 napi-rs 做法 | 規劃方向，見[架構與里程碑](./architecture) |

## 其他對照

各項設計決定的參考來源彙整如下。

| 設計項目 | 參考來源 | Bridge 的採用方式 |
|---|---|---|
| 以 Markdown 撰寫工單，將 frontmatter 解析為 YAML | Astro content collections | frontmatter 由第一行 `---` 延伸至下一個 `---`；欄位皆可省略，未知欄位會被拒絕 |
| 工單必填項 | Jira 的 issue 必填欄位 | 必填標題、工作內容與驗收條件；缺陷工單另提供環境、重現步驟、實際結果、預期結果與發生頻率 |
| 儲存計畫後依該版本套用，不採用後續設定修改 | Terraform `plan -out` → `apply` | `start` 的授權卡片與人工確認；`upgrade --plan-out` → `--plan --approve <sha>` |
| 修改工單後重新執行，停止被取代的舊執行 | GitHub Actions `concurrency` + `cancel-in-progress` | 被取代的版本採用與 `stop` 相同的停止流程；新執行建立時補上 `superseded_by` |
| 各次執行具有獨立的時間上限 | GitHub Actions job `timeout-minutes` | `budget.run_timeout`，逾時後以 `timed_out` 結束 |
| 伺服器指派序號，客戶端依目前位置取得增量資料 | Temporal sticky cache | 事件檔作為快取：落後時重建，超前時拒絕讀取，內容分歧時以資料庫為準 |
| 斷線後補寫資料，核對不符便拒絕 | Kafka idempotent producer | 本機暫編「最後已知序號＋1」，補寫時資料庫核對 |
| 執行端不另存權威狀態 | GitHub Actions、Prefect、Inngest | 以資料庫為唯一權威來源 |
| 每張工單使用獨立的結果資料夾 | Playwright `test-results/<test>/` | `.review-bridge/results/<工單>/`，每次執行一個檔案，永不覆寫 |
| 統一管理服務的停止與啟動 | `docker compose down`／`up`、`brew services` | `review-bridge down`／`up` |
| 孤兒資料庫程序的處理 | zonky embedded-postgres 的 `cleanOldDataDirectories` | 先 `pg_ctl stop -m fast` 再重試；僅處理屬於該資料目錄的程序 |
| 保留無法辨識的檔案 | `git checkout` 對未追蹤檔的規則 | `upgrade` 僅在目的地存在同名但內容不同的檔案時拒絕遷移，並列出檔名 |
| 寫入 `.vscode/` 前詢問使用者 | `npm create vue@latest` | `init` 的最後一項確認 |
| 修改 `tasks.json` 時保留其他內容與註解 | VS Code 自己的 `jsonc-parser` | `review-bridge vscode`、`uninstall` |
| 使用者層級的 agent 入口 | Claude Code `~/.claude/commands/`、Codex `~/.agents/skills/`（`ext/skills/src/host_roots.rs`） | `/review-bridge`、`$review-bridge` |
| 工作階段的唯讀與隔離選項 | Claude Code `--permission-mode plan`／`--tools`／`--strict-mcp-config`；Codex `exec --sandbox read-only`、`--disable apps --disable plugins`、`mcp_servers.<name>.enabled` | reviewer 唯讀檢查與連接器隔離 |
| 執行紀錄存放於作業系統標準目錄，並定期輪替 | `env-paths` 的 data／log 慣例 | `%LOCALAPPDATA%\ReviewBridge`、`~/Library/Logs/ReviewBridge`、`$XDG_STATE_HOME/review-bridge` |
| 資料庫備份 | PostgreSQL 檔案層級備份 | `review-bridge backup`：停止資料庫，複製完整資料夾，再重新啟動 |

曾評估但**未採用**的做法包括：在使用者 rc 檔追加標記區塊（如 conda／pnpm／nvm），以及使用 Node 內建的 SQLite。Bridge 改採獨立檔案與 PostgreSQL。

## 如何查核參考依據

- 開源專案須查閱原始碼，記錄檔案與行號；若僅有文件可供參考，則記錄頁面與查閱日期。
- 以實際程式行為為準，不僅依賴 README 的描述。
- 找不到既有做法可供參考的設計，不予採用，並列入設計邊界。
