# 概念

Review Bridge 透過兩個獨立的 AI 代理執行工單：**實作代理（writer）**負責修改，**審查代理（reviewer）**以唯讀方式檢查成果。Bridge 根據設定決定修改範圍、執行預算、驗證指令，以及交回人工處理的停點；代理無法自行變更這些限制。

文件沿用幾個常見術語：**run** 是一次執行，**session** 是 agent 的工作階段，**provider** 是角色使用的 CLI（`claude` 或 `codex`），**policy** 是 Bridge 以程式檢查的執行規則。

> 這套做法為什麼長這樣，背景在這篇：[AI 導入後，工程團隊真正要管理的是交付鏈路與驗證責任](https://hackmd.io/@FortesHuang/HJnWgQGJMx)（HackMD）。

## 一次執行的生命週期

```text
工單 .md
  → 封存成計畫（範圍、預算、驗證指令、停點）
  → 顯示授權卡片，由你確認
  → writer 轉換驗收條件，reviewer 核對，Bridge 封存合約
  → writer 實作（最多 rounds 輪）；每輪完成後由 Bridge 執行測試
  → reviewer 審查，Bridge 逐條判定驗收結果
  → 產生結果檔
  → 你檢查成果，決定是否 commit
```

工單版本、計畫、授權、合約、執行、事件、判定與交付都會記錄在資料庫中。結果檔是供你閱讀的副本。

## 角色

`claude` 與 `codex` 都可以擔任 writer 或 reviewer，支援四種配對。角色由 `bridge.json` 設定，也可以用 `--writer`／`--reviewer` 指定單次執行的配對。模型與推理強度（effort）由工單的 `writer:`／`reviewer:` 區塊指定；未指定時，採用 policy 中 priority 表的設定。

**執行開始後，角色不會變更。**修改 `bridge.json` 會在下一次 `start` 生效，使用的配對會列在授權卡片上。

兩個角色各自使用獨立的 CLI 程序與工作階段，即使採用相同的 provider 也一樣。Bridge 會另行啟動 reviewer；writer 呼叫子代理所做的檢查，不視為獨立審查。

| 存取 | 誰用 | Claude Code | Codex |
|---|---|---|---|
| `none` | 合約翻譯 | `--tools "" --strict-mcp-config` | `exec --sandbox read-only` |
| `read` | 合約檢查、review | `--permission-mode plan --tools Read,Grep,Glob --disallowedTools Write,Edit,NotebookEdit,Bash,PowerShell --strict-mcp-config --no-session-persistence` | `exec --ephemeral --sandbox read-only` |
| `write` | writer | `--permission-mode auto --strict-mcp-config`，專案有 `.mcp.json` 時加 `--mcp-config .mcp.json` | `app-server`，thread `sandbox: workspace-write`、`approvalPolicy: never` |

## reviewer 的唯讀證明

`start` 與 `resume` 會先確認 reviewer 的唯讀限制，再呼叫模型執行工單。檢查結果按 provider 分別保存在本機頁面服務的記憶體中。兩種 provider 提供的證據強度不同：

- **Codex**：嘗試寫入用來測試權限的哨兵檔，確認寫入遭作業系統的沙箱（sandbox）阻擋。
- **Claude Code**：檢查 CLI 的 `init` 事件，確認工作階段處於 plan mode、工具僅有 `Read`、`Grep`、`Glob`，並確認哨兵檔未建立、CLI 正常結束。只要出現額外工具，包括 MCP 伺服器提供的工具，檢查就會失敗，工單也不會開始執行。

## 個人連接器的隔離

Bridge 啟動的工作階段不會繼承你的個人 MCP 連接器。Claude Code 每次呼叫都使用 `--strict-mcp-config`，專案的 `.mcp.json` 僅提供給 writer。若合約翻譯工作階段的 `init` 事件仍列出 MCP 工具，Bridge 會停止執行，並指出未隔離的工具。

Codex 每次呼叫都使用 `--disable apps --disable plugins`，並逐一停用 `codex mcp list` 列出的伺服器；若無法讀取清單，便不會開始執行。

若要讓 reviewer 使用特定 MCP 伺服器，請將名稱加入專案 policy 的 `reviewer.mcp_allow`。這些伺服器會直接放行，**未經唯讀驗證**，授權卡片會列出此限制。放行範圍僅限 reviewer，writer 與合約翻譯工作階段不會取得這些伺服器。

## 合約與授權

- `start` 先封存工單原文、範圍、預算與驗證指令，產生計畫。你確認卡片後，授權綁定的是這份計畫及其工單內容。
- 授權後，Bridge 按工單標記填入合約欄位，writer 將驗收區塊轉成編號條件，reviewer 核對後才封存合約。這個步驟不會要求第二次人工授權。
- 授權紀錄建立後不可變更。授權缺失、損壞、過期（24 小時）或已使用時，一律拒絕執行。
- 執行開始後修改工單，不會變更已授權內容。重新執行 `start`，才會產生新版本與新的授權卡片。
- `source_id` 是你原有系統的單號，Bridge 不用它決定工單身分或執行規則。你可以在結果檔與 `logs` 中用它查找工單。

## 由 Bridge 執行測試

每輪 writer 完成修改後，Bridge 會在代理的沙箱**外**執行專案類型對應的測試指令，測試通過後才進入審查。因此，即使 writer 回報自己無法執行測試，仍可由 Bridge 取得實際測試結果。未設定測試指令的專案也能執行工單；卡片、紀錄與結果檔都會明確標示未執行測試。

## 工作證明

對於使用 Git 的專案，Bridge 會記錄執行開始時的 commit，結束時從 Git 讀取檔案改動，並與 Bridge 的紀錄核對。結果檔的「Files changed」會分列 Git 取得的改動、writer 回報但未經 Git 核對的內容，以及執行前就存在的未提交改動。若專案沒有 Git，結果檔會標示無法提供工作證明。

## 專案檔案與執行資料

Bridge 是全域工具，專案設定、工單與結果副本放在 `.review-bridge/`，並透過 `.git/info/exclude` 排除 Git 追蹤。Bridge 不會修改 `.gitignore`、`AGENTS.md`、`CLAUDE.md`、`.claude/` 或你既有的 skills。代理指令入口安裝在使用者層級，供所有專案共用；執行紀錄則存放在作業系統的資料與日誌目錄。

## 安全模型

- 授權缺失、損壞、過期或已使用時，一律拒絕執行（fail closed）。
- writer 與 reviewer 使用獨立工作階段；reviewer 的唯讀檢查方式如上。
- 原生模型工作需要同時滿足兩個條件：你已確認卡片並授權（在終端機輸入 y，或由代理轉達後使用 `--yes`），且本機頁面服務已通過 reviewer 的唯讀檢查。防止代理擅自授權，仍需由代理工具本身的權限提示機制負責。
- Bridge 不 commit、不 push、不部署、不發布。
- Bridge 的狀態必須存放於本機檔案系統，不接受同步資料夾或網路資料夾。
