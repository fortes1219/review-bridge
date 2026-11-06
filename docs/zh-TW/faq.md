# 常見問題

這一頁收的是真的有人撞到的事，照撞到的順序補。

## 開工

### Claude Code 裡打 `/review-bridge` 沒有這個指令

`init` 把它放在 `~/.claude/commands/review-bridge.md`（有設 `CLAUDE_CONFIG_DIR` 就在那底下的 `commands/`），所有專案共用。先看那個檔在不在；不在就在任一專案再跑一次 `review-bridge init`。Codex 的對應是 `~/.agents/skills/review-bridge/SKILL.md`，叫法 `$review-bridge`。

### `start` 說 Codex（或 Claude）沒登入

訊息會印那家 CLI 的登入指令（Codex 是 `codex login`）。登入後再跑同一條 `start`。`review-bridge roles-check` 不叫模型，只檢查兩個角色的 CLI 裝好、登入了沒有。

### 工單被拒絕，說某個 key 不認得

frontmatter 只收 `priority`、`writer`、`reviewer`、`budget`、`source_id`（和舊的頂層 `effort`）；區塊標記只收合約的 17 個欄位。拒絕訊息會印行號。見[第一張工單](./guide/work-order)。

### 還沒叫模型就停了，說要我回答問題

`open_questions` 區塊裡除了 `無`／`none` 的每一行都是一個問題，Bridge 會停下等你在工單裡回答。沒有任何驗收條件的工單也會停下。

### 卡片過期了

卡片 `Valid until` 是 24 小時。過了就再跑一次 `start`，印新的一張。

### 我改了工單，Bridge 會跑新的嗎？

要重新 `start`。你按 y 授權的是卡片下半段印的那份原文；開工後再改檔，結果檔會多一段「Work order changed after the start」，說明改動沒有用到。

## reviewer 與連接器

### Claude 當 reviewer 時唯讀檢查不過

Bridge 要 Claude Code 的 reviewer session 只有 `Read`、`Grep`、`Glob` 三個工具。它的 `init` 事件多出任何一個工具——MCP 連接器的也算——檢查就不過，工作不開始。Bridge 每次呼叫都帶 `--strict-mcp-config`，所以一般不會有；如果你的 Claude Code 設定在那個 session 裡仍留著別的工具，就是它。

### 卡片上 `Reviewer MCP: none` 是什麼意思

你個人的 MCP 連接器（Claude 的 connectors、Codex 的 `codex mcp list` 那些，含 `node_repl`）**不會**進任何 Bridge 起的 session，這是刻意的。`none` 就是 reviewer 沒拿到任何一個。要放行某個伺服器給 reviewer，寫進專案 policy 的 `reviewer.mcp_allow`；放行的伺服器沒有唯讀證明，卡片會寫。見[概念](./concepts/)。

### Codex 的 writer 說它跑不了測試（`spawn EPERM`）

Windows 上 Codex 0.166 的 sandbox 裡 `npm test`（Vitest）會 `spawn EPERM`。這不影響結論：Bridge 在 sandbox **外**自己跑你的測試指令，每回 writer 做完跑一次。writer 的那句話只是它自己說的。

## 結果

### 結果檔說 `No files were changed.`，可是 writer 說它改了

「Files changed」第一份是 Git 的證據；writer 宣稱的另列在「What the writer says it changed (not checked against Git)」。兩個對不上的常見原因：那些檔在開工前就已經是那個樣子（會出現在第三份「Already uncommitted when the run started」）、或 writer 只是說說。信 Git 那份。

### 結果檔和 log 不在專案裡

對。專案裡只有 `.review-bridge/results/<工單>/` 的結果檔副本。整條 run 的紀錄（每次呼叫的 prompt、串流、stderr、測試輸出、計畫、你按 y 的卡）在作業系統的 log 目錄，`review-bridge status` 的 `Logs:` 行會印位置，`review-bridge logs <run_id>` 列每個檔是什麼。見[結果、紀錄與資料庫](./guide/results)。

### `.vscode/tasks.json` 讓結果檔說 commit 有未提交的改動

Bridge 不把它加進 Git、也不排除它——進不進 Git 是你的事。commit 它或 ignore 它之前，Git 會把它算成改動。

## 資料庫與環境

### 埠不是 5432

5432 被別的 PostgreSQL 占了，Bridge 往上找第一個空的，每次啟動重找。`init` 結尾和 `review-bridge status` 印的是當下在用的埠。要固定從別的埠開始，在 data home 的 `settings.json` 加 `"database": { "port": 5440 }`。

### 專案在 OneDrive（或網路磁碟）裡，`init` 被拒絕

Bridge 的狀態要在本機檔案系統；同步資料夾與網路磁碟（OneDrive、Dropbox、iCloud Drive、UNC、NFS、SMB）一律拒絕。把專案放到本機磁碟。

### Windows 中文版，Codex 的輸出是亂碼

PowerShell 用系統 code page 輸出，Codex 當 UTF-8 讀。在 `$PROFILE` 加 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`，或改用 PowerShell 7。`review-bridge doctor` 會告訴你現在是不是 UTF-8。見[升級、備份、移除 → Windows](./guide/maintenance#windows)。

### 改了 `bridge.json` 的角色，什麼時候生效

下一次 `start`。run 開始後不換角；卡片會印這次用的是誰。

### Linux 能用嗎

Linux 是實驗性的：原生模型工作會 fail closed。Windows x64 是原生驗證過的；Apple Silicon macOS 可以選但沒有原生驗證。
