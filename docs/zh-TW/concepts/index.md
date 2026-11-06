# 概念

Review Bridge 用兩個彼此獨立的 agent 跑你的工單：一個 **writer** 做工，一個**唯讀的 reviewer** 檢查。範圍、預算、驗證指令、在哪裡停下來交回給你，這些由 Bridge 決定，agent 改不了。

## 一條 run 的生命週期

```text
工單 .md
  → 封存成計畫（範圍、預算、驗證指令、停點）
  → 卡片：你授權的內容  ──y──→
  → writer 把工單翻成合約，reviewer 檢查合約
  → writer 做工（最多 rounds 回）；每回之後 Bridge 自己跑測試
  → reviewer 判定
  → 交付：結果檔
  → 你自己看、自己 commit
```

每一步都是資料庫裡的一列（工單版本、計畫、授權、合約、run、事件、判定、交付），結果檔只是給你的副本。

## 角色

`claude` 和 `codex` 都能當 writer 或 reviewer，四種配對都行。誰當什麼在 `bridge.json`（或單次的 `--writer`／`--reviewer`）；模型與 effort 在工單的 `writer:`／`reviewer:` 區塊，否則照 policy 的 priority 表。**run 開始後不換角**；改了 `bridge.json` 影響的是下一次 `start`，卡片會印出來。

兩個角色各自是獨立的 CLI 程序與 session，同一家 provider 填兩個角色也一樣。reviewer 永遠是 Bridge 另外起的 session；writer 的子 agent 說的話不算 review。

| 存取 | 誰用 | Claude Code | Codex |
|---|---|---|---|
| `none` | 合約翻譯 | `--tools "" --strict-mcp-config` | `exec --sandbox read-only` |
| `read` | 合約檢查、review | `--permission-mode plan --tools Read,Grep,Glob --disallowedTools Write,Edit,NotebookEdit,Bash,PowerShell --strict-mcp-config --no-session-persistence` | `exec --ephemeral --sandbox read-only` |
| `write` | writer | `--permission-mode auto --strict-mcp-config`，專案有 `.mcp.json` 時加 `--mcp-config .mcp.json` | `app-server`，thread `sandbox: workspace-write`、`approvalPolicy: never` |

## reviewer 的唯讀證明

`start` 和 `resume` 在叫模型之前，先證明 reviewer 寫不了檔，每個 provider 一份證明，放在頁面服務的記憶體裡。兩家的證明強度不同：

- **Codex**：真的試寫一個哨兵檔，被作業系統的 sandbox 擋下來。
- **Claude Code**：它自己的 `init` 事件顯示 session 在 plan mode、工具只有 `Read`、`Grep`、`Glob`，哨兵檔不存在，CLI 跑到結束。多出任何一個工具——包括 MCP 伺服器的——檢查就不過，工作不開始。

## 你的連接器不進 Bridge 的 session

你個人的 MCP 連接器不會進任何一個 Bridge 起的 session。Claude Code 每次呼叫都帶 `--strict-mcp-config`，專案的 `.mcp.json` 只給 writer；翻譯 session 的 `init` 還列著 MCP 工具就不用它，run 停下並說是哪一個。Codex 每次呼叫 `--disable apps --disable plugins`，`codex mcp list` 裡的每個伺服器逐名關掉；那份清單讀不到就不開工。

要讓某個伺服器進 reviewer，在專案 policy 的 `reviewer.mcp_allow` 寫名字：它原樣放行、沒有任何東西證明它寫不了檔，卡片會寫出來。只有 reviewer 的呼叫留著它；writer 和翻譯都沒有。

## 合約與授權

- 工單被封存成**合約**，有 SHA-256。你按的 y 授權的是這個 hash；卡片下半段印的就是將被封存的原文。
- 授權不可變：缺、壞、過期（24 小時）、用過的授權一律 fail closed。
- 之後改了工單，要重新 `start`，那是新的版本、新的卡。
- `source_id` 是你自己系統的單號，Bridge 只存不讀；結果檔與 `logs` 可以用它找。

## 驗證是 Bridge 自己跑

每回 writer 做完，Bridge 在 sandbox **外**自己跑專案類型對應的測試指令；reviewer 的判定要過，測試得先過。所以 writer 說「我跑不了測試」不影響結論——那不是它的事。沒有測試指令的專案照樣能跑，卡片、紀錄、結果都會寫明沒有測試。

## 工作證明

有 Git 的專案，Bridge 記下 run 開始的 commit，結束時從 Git 讀出改了哪些檔，和自己寫的紀錄對過。結果檔「Files changed」分三份：Git 的證據、writer 自己宣稱的（沒和 Git 對）、開始時就已經沒 commit 的。沒有 Git 就沒有工作證明，結果檔會寫。

## 不碰你的專案

Bridge 是全域工具。專案裡只有 `.review-bridge/`，用 `.git/info/exclude` 擋在 Git 外；不改 `.gitignore`、`AGENTS.md`、`CLAUDE.md`、`.claude/`、你的 skills。agent 入口放在使用者層級、所有專案共用。執行紀錄住在作業系統的 data 與 log 目錄，和一個正式的後端服務一樣，不寫進客戶的目錄。

## 安全模型

- 缺、壞、過期、用過的授權 fail closed。
- writer 與 reviewer 分 session；reviewer 唯讀，證明如上。
- 原生模型工作只在你對卡片說 y（終端機，或透過 agent 的 `--yes`）之後、而且 reviewer 唯讀證明在頁面服務裡通過之後才開始。擋住 agent 自己說 y 是 agent 工具的事（它的權限提示），不是 Bridge 的。
- Bridge 不 commit、不 push、不部署、不發布。
- Bridge 的狀態必須在本機檔案系統；同步與網路資料夾拒絕。
