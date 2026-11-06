# 安裝與 init

Review Bridge 是一個全域安裝的命令列工具。裝一次，之後每個專案各跑一次 `init`。

## 需求

- Node.js 22 以上，含 npm。
- Git。沒有 Git 也能跑，但**工作證明**需要它：有 Git 時 Bridge 記下 run 開始的 commit、從 Git 讀出改了哪些檔；沒有 Git 時結果檔會寫「沒有工作證明」。
- 你要用的角色各自的 CLI，已安裝並登入：`claude`（Claude Code）和／或 `codex`。
- Bridge 的狀態要放在本機磁碟：同步資料夾與網路磁碟（OneDrive、Dropbox、iCloud Drive、UNC、NFS、SMB）會被拒絕。

## 安裝

```sh
npm i -g review-bridge@next
```

rc 版本在 `next` 標籤上；正式版之後用 `npm i -g review-bridge`。

## init

```sh
cd your-project
review-bridge init
```

`init` 問三個問題，每題都有預設值，按 Enter 就是接受：

1. **writer**：`claude` 或 `codex`（你存過的預設，否則 `claude`）。
2. **reviewer**：你存過的預設，否則 `codex`。
3. **專案類型**：偵測到的類型，否則 `none`。類型只決定一件事——每次 writer 做完後 Bridge 自己跑哪個驗證指令（例如 `npm test`）。選 `none`、或專案沒有那個指令，工作照樣開始，卡片、紀錄和結果都會寫「tests: not configured」。

最後一題問要不要把 VS Code tasks 寫進這個專案的 `.vscode/tasks.json`，預設是 **N**（見 [開工](./start#在-vs-code-裡)）。

用選項代替回答：`--writer`、`--reviewer`、`--profile <type|none>`、`--target <folder>`；沒有終端機、或加 `--yes`，就全部用預設值不問。

### init 做了什麼

- 建立 `.review-bridge/`：專案設定 `bridge.json`、`policy.override.json`、`rules.md`，以及工單範本 `work-packages/TEMPLATE.md`（英文）與 `TEMPLATE.zh-TW.md`（繁中）。
- 在 Git 專案裡，整個 `.review-bridge/`（含結果）用 `.git/info/exclude` 擋在 Git 外。**不會改你的 `.gitignore`。**
- 跑四個不叫模型的假自測（`PASS`、`FAIL_THEN_PASS`、`HARD_STOP`、`RATE_LIMIT`）。
- 在 `127.0.0.1` 起本機頁面服務。
- 在**專案外**、各 agent 找自訂指令的地方放 Bridge 的入口，所有專案共用：Claude Code 的 `~/.claude/commands/review-bridge.md`（叫法 `/review-bridge`；尊重 `CLAUDE_CONFIG_DIR`），Codex 的 `~/.agents/skills/review-bridge/SKILL.md`（叫法 `$review-bridge`）。那個位置已經有你自己的檔就不動。

專案裡除了 `.review-bridge/` 什麼都不碰：沒有應用程式檔、`.gitignore`、`AGENTS.md`、`CLAUDE.md`、`.claude/` 的改動，`init` 之後 `git status` 是空的。唯一例外是你自己選的 `.vscode/tasks.json`。

### init 印的東西

```text
Setting up .review-bridge/...
Checking the setup...
Running the four fake self-tests...
Starting the local page...
Done. Now:

  put a work order .md in .review-bridge/work-packages/, then in Claude Code type:
    /review-bridge start .review-bridge/work-packages/<file>.md
    (in Codex: $review-bridge start .review-bridge/work-packages/<file>.md)
  at a terminal, for advanced use and CI:
    review-bridge start .review-bridge/work-packages/<file>.md
  page: http://localhost:8080/

  database in VS Code: install Microsoft's PostgreSQL extension and add a connection with
    Server 127.0.0.1  Port 5432  User bridge  Database bridge
    Password: copy it from <data home>/postgres/secret
```

最後四格是連資料庫用的，`review-bridge status` 隨時會再印一次；見 [結果、紀錄與資料庫](./results#在-vs-code-看資料庫)。

## 下一步

寫[第一張工單](./work-order)，然後[開工](./start)。
