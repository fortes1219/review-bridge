# 常見問題

這裡整理實際使用時遇到的問題與處理方式。

## 開始執行

### Claude Code 裡打 `/review-bridge` 沒有這個指令

`init` 會將指令入口安裝到 `~/.claude/commands/review-bridge.md`，供所有專案共用。若設定了 `CLAUDE_CONFIG_DIR`，則安裝在該目錄的 `commands/` 下。請先確認檔案是否存在；缺少時，可在尚未初始化的專案執行 `review-bridge init`。Codex 的入口為 `~/.agents/skills/review-bridge/SKILL.md`，使用 `$review-bridge` 呼叫。

### `start` 說 Codex（或 Claude）沒登入

錯誤訊息會顯示對應 CLI 的登入指令，例如 `codex login`。登入後，重新執行相同的 `start` 即可。`review-bridge roles-check` 可以檢查兩個角色的 CLI 安裝與登入狀態，不會呼叫模型。

### 工單被拒絕，提示有未知 key

frontmatter 僅接受 `priority`、`writer`、`reviewer`、`budget`、`source_id`，以及相容舊格式的頂層 `effort`。區塊標記僅接受合約的 17 個欄位；錯誤訊息會列出行號。見[第一張工單](./guide/work-order)。

### 還沒呼叫模型就停了，提示有待決問題

`open_questions` 區塊中，除 `無`、`none` 或空白外，每一行都視為待決問題。Bridge 會停止，等待你在工單中回答。工單未提供任何驗收條件時，也會停止。

### 卡片過期了

授權卡片的有效期限為 24 小時，截止時間列在 `Valid until`。過期後，重新執行 `start` 產生新卡片。

### 我改了工單，Bridge 會跑新的嗎？

需要重新執行 `start`。授權只適用於你確認過的工單原文。執行開始後若修改檔案，結果檔會出現「Work order changed after the start」，說明這些修改未納入本次執行。

## reviewer 與連接器

### Claude 當 reviewer 時，唯讀檢查未通過

Claude Code 的 reviewer session 僅允許 `Read`、`Grep`、`Glob` 三項工具。若 `init` 事件列出任何額外工具，包括 MCP 連接器提供的工具，檢查便會失敗，工單也不會開始執行。Bridge 每次呼叫都會使用 `--strict-mcp-config`；若仍有額外工具，請依檢查訊息確認該 session 實際載入的工具。

### 卡片上 `Reviewer MCP: none` 是什麼意思

Bridge 會隔離個人 MCP 連接器，包括 Claude 的 connectors，以及 Codex 的 `codex mcp list` 所列伺服器（含 `node_repl`）。`none` 表示 reviewer 沒有取得任何 MCP 伺服器。

若要允許 reviewer 使用特定伺服器，請加入專案 policy 的 `reviewer.mcp_allow`。目前這些伺服器未經唯讀驗證，卡片會標示此限制。見[概念](./concepts/)。

### Codex 的 writer 說它跑不了測試（`spawn EPERM`）

Windows 上 Codex 0.166 的沙箱執行 `npm test`（Vitest）時，可能遇到 `spawn EPERM`。每輪 writer 完成後，Bridge 會在代理沙箱**外**執行專案的測試指令，因此驗收會採用 Bridge 取得的測試結果。

## 結果

### 結果檔說 `No files were changed.`，可是 writer 說它改了

「Files changed」的第一份清單來自 Git；writer 回報的內容另列在「What the writer says it changed (not checked against Git)」。兩者不同時，請先核對 Git 清單與執行前就存在的改動（「Already uncommitted when the run started」）。writer 的回報本身不構成修改證據。

### 結果檔和 log 不在專案裡

專案的 `.review-bridge/results/<工單>/` 存放結果副本。完整執行日誌，包括每次呼叫的 prompt、串流、stderr、測試輸出、計畫與授權卡片，則存放在作業系統的日誌目錄。`review-bridge status` 的 `Logs:` 行會顯示位置，`review-bridge logs <run_id>` 可查看各檔案的用途。見[結果、紀錄與資料庫](./guide/results)。

### `.vscode/tasks.json` 讓結果檔說 commit 有未提交的改動

Bridge 不會自動將 `.vscode/tasks.json` 加入或排除 Git，是否追蹤由你決定。在提交或忽略之前，Git 會將它列為未提交改動。

## 資料庫與環境

### 埠不是 5432

若 5432 已被占用，Bridge 會依序尋找下一個可用埠，每次啟動時重新檢查。`init` 與 `review-bridge status` 會顯示目前使用的埠。若要從其他埠開始尋找，可在 data home 的 `settings.json` 加入 `"database": { "port": 5440 }`。

### 專案在 OneDrive（或網路磁碟）裡，`init` 被拒絕

Bridge 的狀態必須存放於本機檔案系統，不接受同步資料夾與網路磁碟，包括 OneDrive、Dropbox、iCloud Drive、UNC、NFS、SMB。請將專案移到本機磁碟。

### Windows 中文版，Codex 的輸出是亂碼

PowerShell 使用系統字碼頁輸出，Codex 則以 UTF-8 讀取，兩者不一致時可能出現亂碼。可在 `$PROFILE` 加入 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`，或改用 PowerShell 7。`review-bridge doctor` 會顯示目前是否使用 UTF-8。見[升級、備份、移除 → Windows](./guide/maintenance#windows)。

### 改了 `bridge.json` 的角色，什麼時候生效

修改會在下一次 `start` 生效。已開始的執行不會更換角色；卡片會顯示該次使用的配對。

### Linux 能用嗎

Linux 仍屬實驗階段，原生模型工作預設拒絕執行（fail closed）。Windows x64 已通過原生環境驗證；Apple Silicon macOS 可選用，但尚未完成原生驗證。
