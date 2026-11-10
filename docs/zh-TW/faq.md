# 常見問題

這裡整理實際使用時遇到的問題與處理方式。

## 開始執行

### Claude Code 裡打 `/review-bridge` 沒有這個指令

`init` 會將指令入口安裝到 `~/.claude/commands/review-bridge.md`，供所有專案共用。若設定了 `CLAUDE_CONFIG_DIR`，則安裝在該目錄的 `commands/` 下。請先確認檔案是否存在；缺少時，可在尚未初始化的專案執行 `npx review-bridge init`。Codex 的入口為 `~/.agents/skills/review-bridge/SKILL.md`，使用 `$review-bridge` 呼叫。

### `start` 說 Codex（或 Claude）沒登入

錯誤訊息會顯示對應 CLI 的登入指令，例如 `codex login`。登入後，重新執行相同的 `start` 即可。`npx review-bridge roles-check` 可以檢查兩個角色的 CLI 安裝與登入狀態，不會呼叫模型。

### 工單被拒絕，提示有未知 key

frontmatter 僅接受 `priority`、`writer`、`reviewer`、`budget`、`source_id`、頂層 `effort`，以及 Bridge 自己寫入的 `id`。區塊標記僅接受合約的 17 個欄位；錯誤訊息會列出行號。見[第一張工單](./guide/work-order)。

### 卡片沒出來，說工單「還不能開工」

`start` 會先用程式檢查工單這張表單：要有「要做的事」、要有驗收清單且每一行都是清單項目、`open_questions` 底下只能是 `無`、`none` 或空白。不符合時在卡片前停下，逐項列出行號，並印出補好之後再執行的指令。這一步不呼叫模型。見[第一張工單 → 開工前的表單檢查](./guide/work-order#開工前的表單檢查)。

### 卡片過期了

授權卡片的有效期限為 24 小時，截止時間列在卡片的「有效期限」（英文介面是 `Valid until`），目前以 UTC 顯示。過期後，重新執行 `start` 產生新卡片。

### 卡片說「是 … 的複製」，可是我只是改了檔名

Bridge 靠工單檔 frontmatter 的 `id` 認工單。改檔名或搬資料夾，原本的檔就不在了，卡片會寫「更新…（原本在 …）」；只有原檔還在、兩個檔有同一個 `id` 時，才會認成複製。認錯時用 `--update <work_order_id>` 或 `--as-new` 指定，見[開始執行 → 卡片認的是哪一張工單](./guide/start#卡片認的是哪一張工單)。

### 我改了工單，Bridge 會跑新的嗎？

需要重新執行 `start`。授權只適用於你確認過的工單原文。執行開始後若修改檔案，結果檔會出現「開工後工單被改過」一段，說明這些修改未納入本次執行。

## reviewer 與連接器

### Claude 當 reviewer 時，唯讀檢查未通過

Claude Code 的 reviewer session 僅允許 `Read`、`Grep`、`Glob` 三項工具，加上 Bridge 自己的唯讀 graph 伺服器與 policy 放行的伺服器。若 `init` 事件列出這些以外的工具，包括其他 MCP 連接器提供的工具，檢查便會失敗，工單也不會開始執行。Bridge 每次呼叫都會使用 `--strict-mcp-config`；若仍有額外工具，請依檢查訊息確認該 session 實際載入的工具。

### 卡片上 `Reviewer MCP：無` 是什麼意思

Bridge 會隔離個人 MCP 連接器，包括 Claude 的 connectors，以及 Codex 的 `codex mcp list` 所列伺服器（含 `node_repl`）。「無」表示 policy 沒有替 reviewer 放行任何伺服器。Bridge 自己的唯讀 graph 伺服器（`review-bridge-graph`）兩個角色都有，不列在這一行。

若要允許 reviewer 使用特定伺服器，請加入專案 policy 的 `reviewer.mcp_allow`。目前這些伺服器未經唯讀驗證，卡片會標示此限制。見[概念](./concepts/)。

### Codex 的 writer 說它跑不了測試（`spawn EPERM`）

Windows 上 Codex 0.166 的沙箱執行 `npm test`（Vitest）時，可能遇到 `spawn EPERM`。每輪 writer 完成後，Bridge 會在代理沙箱**外**執行專案的測試指令，因此驗收會採用 Bridge 取得的測試結果。

## 結果

### 結果檔說「沒有改任何檔。」，可是 writer 說它改了

「改了哪些檔」的第一份清單來自 Git；writer 回報的內容另列在「writer 說它改了哪些檔（未經 Git 核對）」。兩者不同時，請先核對 Git 清單與執行前就存在的改動（「開工時就未 commit 的檔」）。writer 的回報本身不構成修改證據。

### 結果檔和 log 不在專案裡

專案的 `.review-bridge/results/<工單>/` 存放結果副本。完整執行日誌，包括每次呼叫的 prompt、串流、stderr、測試輸出、計畫與授權卡片，則存放在作業系統的日誌目錄。`npx review-bridge status` 的「紀錄」行會顯示位置，`npx review-bridge logs <run_id>` 可查看各檔案的用途。

### reviewer 判通過，可是它另外提醒的事結果檔沒寫

目前已交付的結果檔只列 reviewer 核過與沒跑的項目，不列它另外報的 findings。這些提醒在 reviewer 的審查檔裡：`status` 的「最新審查」那一行指的檔，資料庫也有存。見[結果、紀錄與資料庫 → 結果檔](./guide/results#結果檔)。

### `.vscode/tasks.json` 讓結果檔說 commit 有未提交的改動

Bridge 不會自動將 `.vscode/tasks.json` 加入或排除 Git，是否追蹤由你決定。在提交或忽略之前，Git 會將它列為未提交改動。

## 資料庫與環境

### 埠不是 5432

若 5432 已被占用，Bridge 會依序尋找下一個可用埠，每次啟動時重新檢查。`init` 與 `npx review-bridge status` 會顯示目前使用的埠。若要從其他埠開始尋找，可在 data home 的 `settings.json` 加入 `"database": { "port": 5440 }`。

### 專案在 OneDrive（或網路磁碟）裡，`init` 被拒絕

Bridge 的狀態必須存放於本機檔案系統，不接受同步資料夾與網路磁碟，包括 OneDrive、Dropbox、iCloud Drive、UNC、NFS、SMB。請將專案移到本機磁碟。

### Windows 中文版，Codex 的輸出是亂碼

PowerShell 使用系統字碼頁輸出，Codex 則以 UTF-8 讀取，兩者不一致時可能出現亂碼。可在 `$PROFILE` 加入 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`，或改用 PowerShell 7。`npx review-bridge doctor` 會顯示目前是否使用 UTF-8。見[升級、備份、移除 → Windows](./guide/maintenance#windows)。

### 工作停下來，原因是 `database_unavailable`

工作進行中 Bridge 的資料庫沒有回應，run 就停下，之後不再呼叫模型；終端機印「已停下：Bridge 的資料庫無法使用」。這段期間寫在檔案裡的紀錄，下一個打開資料庫的指令會補寫回去。用 `npx review-bridge status` 看資料庫狀態，`npx review-bridge up` 啟動資料庫，再重新 `start`。

### 關掉終端機後，資料庫還在跑

這是預設：資料庫和本機頁面在關掉終端機或 VS Code 後仍持續運作。要停下它們，執行 `npx review-bridge down`；有任何專案的工作在跑時，`down` 會列出那些 run 並拒絕。

### 改了 `bridge.json` 的角色，什麼時候生效

修改會在下一次 `start` 生效。已開始的執行不會更換角色；卡片會顯示該次使用的配對。

### Linux 能用嗎

Linux 上原生模型工作一律拒絕執行（fail closed）。Windows x64 已通過原生環境驗證；Apple Silicon macOS 可選用，但尚未完成原生驗證。
