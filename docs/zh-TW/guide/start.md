# 開始執行

使用 `start <工單檔>` 開始執行工單。你可以透過 AI 代理、VS Code 或終端機操作，三種入口使用相同指令，差別在於**在哪裡確認卡片並授權**。

## 在 Claude Code 或 Codex 裡（主要入口）

在 Claude Code 輸入：

```text
/review-bridge start .review-bridge/work-packages/add-readme.md
```

在 Codex 則輸入 `$review-bridge start .review-bridge/work-packages/add-readme.md`。

代理會先執行 `start`。Bridge 將工單、範圍、預算與驗證指令封存成計畫，在每個本機頁面服務工作階段檢查 reviewer 的唯讀限制，接著顯示授權卡片，並停在 `Needs authorization`。

代理必須將卡片**原文完整呈現**給你，詢問「Start this work?」。只有在你同意後，才能加上 `--yes` 再次執行相同指令。這次確認就是執行授權，紀錄會標示授權由代理轉達（`authorized_via: agent`）。

`/review-bridge` 有四個動作，和終端機的指令一樣：`start <file>`、`stop <run_id>`、`resume <run_id>`、`clean [<run_id>]`。

## 在 VS Code 裡

Bridge 提供六項 VS Code 工作（tasks）：`review-bridge: start`、`stop`、`resume`、`clean`、`status`、`logs`。在 Quick Open 輸入 `task review-bridge`，或選擇 `Terminal → Run Task` 即可執行。

`start` 會使用編輯器目前開啟的檔案；其他工作會提示你輸入 run ID 或檔名。指令會在整合終端機執行，你也在該處確認授權卡片。

| 安裝位置 | 安裝方式 | 適用範圍 |
|---|---|---|
| 這個專案的 `.vscode/tasks.json` | `init` 最後一題答 y，或跑 `review-bridge vscode` | 這個專案 |
| 你的使用者 tasks（`Tasks: Open User Tasks`） | `review-bridge vscode --user` | 你所有的專案 |

是否將 `.vscode/tasks.json` 納入 Git，由你決定，Bridge 不會自動加入或排除。在提交或忽略之前，Git 會將它列為改動，執行結果也會標示存在未提交的改動。

Bridge 僅管理 label 以 `review-bridge:` 開頭的 task，以及 id 以 `review-bridge-` 開頭的 input；其他內容、註解與排版都會保留。`uninstall` 會移除這些項目，僅在檔案不含其他內容時刪除檔案。

使用者 tasks 會寫入 VS Code 的預設 profile。其他含有獨立 tasks 的 profile、VS Code Insiders、VSCodium 與可攜版使用不同位置，請改在專案中執行 `review-bridge vscode`。在多資料夾工作區中，使用者 task 會從第一個資料夾執行，該資料夾未必是工單所在的專案。

## 在終端機（進階用法與 CI）

```sh
review-bridge start .review-bridge/work-packages/add-readme.md
```

在終端機執行 `start` 時，Bridge 會先詢問交回人工處理的停點（預設為審查完成後），再顯示授權卡片，詢問 `Start this work? [y/N]`。

| 操作 | 指令 |
|---|---|
| 執行工單 | `review-bridge start <file>` |
| 暫停（紀錄保留） | `review-bridge stop <run_id>` |
| 重新執行已停止的工單 | `review-bridge resume <run_id>` |
| 清理已結束的紀錄 | `review-bridge clean [<run_id>]` |

使用 `review-bridge status` 可查看正在執行的工作及其 run ID。

## 卡片

三種入口會顯示相同格式的授權卡片。以下為使用模擬 CLI 在 Linux 取得的實際輸出：

```text
Work order:   .review-bridge/work-packages/add-readme.md
              New work order "幫專案補一份 README"
Stops:        after the review
Scope:        the whole project except protected files (23 patterns)
Tests:        not configured (no test rule matched; the work starts without tests)
Priority:     medium (config)
Writer:       claude (config), model the CLI's default (priority table), effort medium (priority table)
Reviewer:     codex (config), model the CLI's default (priority table), effort medium (priority table)
Reviewer MCP: none
Budget:       tokens 4000000 (config), tokens_per_call 1500000 (config), call_timeout 900000 (config), test_timeout 600000 (config), run_timeout 21600000 (config), rounds 2 (config)
Contract:     up to 2 work-order translation(s) by the writer (claude) and 2 check(s) by the reviewer (codex), 15 minute(s) per call
Valid until:  2026-11-06T23:31:11.999Z

The work order, as it will be sealed:
  │ ---
  │ source_id: DOC-1
  │ ---
  │ # 幫專案補一份 README
  │ …

Needs authorization. If the person says yes, run again: review-bridge start .review-bridge/work-packages/add-readme.md --yes
```

- 每個值後方的括號標示設定來源：`cli`、`work_order`、`priority`、`config`。
- 卡片下半部列出**將封存的工單原文**，授權僅適用於這份內容。之後若修改工單，必須重新執行 `start` 才會採用新內容。
- `Valid until` 標示卡片的有效期限（24 小時）；過期後須重新產生卡片。
- `Reviewer MCP` 列出 reviewer 可使用的 MCP 伺服器，預設為 `none`。

## 執行過程

授權後，Bridge 會逐步顯示執行進度，終端機等待期間會顯示進度指示：

```text
  Writer (claude) turns the work order into a contract; reviewer (codex) checks it
  Contract sealed
  Writer working (call 1 of 2)
  Tests: not configured for this project
  Reviewer checking the work
Delivered: no tests configured, reviewer passed
Result file: /…/.review-bridge/results/add-readme/DOC-1 add-readme 2026-11-06 07-31-29 success.md
Tokens: writer 153246, reviewer 60400
```

執行順序固定：writer 將工單轉成合約，由 reviewer 核對後封存；接著 writer 進行實作，最多執行 `rounds` 輪。每輪完成後，由 **Bridge 執行專案的測試指令**，再交由 reviewer 審查，最後產生交付結果。

## 停止、恢復與清理

- `stop <run_id>`：停止模型程序，保留執行紀錄。
- `resume <run_id>`：為同一張工單建立**新的執行**，保留原本的停點與範圍。角色、模型、effort 與預算會重新決定，並再次顯示卡片，要求人工授權。
- `clean`（不帶 run id）：將已結束的執行紀錄彙整成每日檔案，並刪除超過保留期限的紀錄；`clean <run_id>` 則移除指定的已結束紀錄，不接受仍在執行中的工作。

Bridge **不會自動 commit、push 或部署**。結果檔會列出修改的檔案，由你檢查成果並決定是否提交。接著可閱讀[結果、紀錄與資料庫](./results)。
