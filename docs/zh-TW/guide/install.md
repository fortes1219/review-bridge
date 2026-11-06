# 安裝與初始化

Review Bridge 是全域安裝的命令列工具。安裝一次後，在各專案執行 `init` 完成初始化即可使用。

## 需求

- Node.js 22 以上，含 npm。
- Git。未使用 Git 的專案也能執行工單，但無法提供**工作證明**。有 Git 時，Bridge 會記錄執行開始時的 commit，並讀取實際修改的檔案；沒有 Git 時，結果檔會明確標示此限制。
- 依 writer 與 reviewer 的角色設定，安裝並登入所需的 CLI：`claude`（Claude Code）、`codex`，或兩者皆安裝。
- Bridge 的狀態必須存放於本機磁碟。不支援同步資料夾與網路磁碟，包括 OneDrive、Dropbox、iCloud Drive、UNC、NFS、SMB。

## 安裝

```sh
npm i -g review-bridge@next
```

候選發行版（rc）使用 `next` 標籤。正式版發布後，可使用 `npm i -g review-bridge` 安裝。

## init

```sh
cd your-project
review-bridge init
```

`init` 會先詢問三項設定。每項都有預設值，按 Enter 即可採用：

1. **writer**：`claude` 或 `codex`（採用已儲存的預設值；若未設定，則使用 `claude`）。
2. **reviewer**：採用已儲存的預設值；若未設定，則使用 `codex`。
3. **專案類型**：採用偵測到的類型，未偵測到則使用 `none`。這項設定決定每輪 writer 完成後，由 Bridge 執行的驗證指令，例如 `npm test`。選擇 `none`，或專案未提供對應指令時，仍可執行工單；卡片、紀錄與結果檔會標示「tests: not configured」。

接著會詢問是否將 VS Code 工作（tasks）寫入專案的 `.vscode/tasks.json`，預設為 **N**（見 [開工](./start#在-vs-code-裡)）。

也可以使用 `--writer`、`--reviewer`、`--profile <type|none>`、`--target <folder>` 直接指定設定。在非互動式環境中，或加上 `--yes` 時，未指定的項目會採用預設值，不再詢問。

### init 做了什麼

- 建立 `.review-bridge/`：專案設定 `bridge.json`、`policy.override.json`、`rules.md`，以及工單範本 `work-packages/TEMPLATE.md`（英文）與 `TEMPLATE.zh-TW.md`（繁中）。
- 在 Git 專案中，透過 `.git/info/exclude` 排除整個 `.review-bridge/`，包含結果檔。**不會修改 `.gitignore`。**
- 使用模擬 CLI 執行四項自我測試，不呼叫模型（`PASS`、`FAIL_THEN_PASS`、`HARD_STOP`、`RATE_LIMIT`）。
- 在 `127.0.0.1` 啟動本機頁面服務。
- 在**專案外**安裝代理指令入口，供所有專案共用。Claude Code 使用 `~/.claude/commands/review-bridge.md`，以 `/review-bridge` 呼叫；若設定了 `CLAUDE_CONFIG_DIR`，則依該目錄安裝。Codex 使用 `~/.agents/skills/review-bridge/SKILL.md`，以 `$review-bridge` 呼叫。若目標位置已有你自行建立的檔案，Bridge 會保留原檔。

初始化不會修改應用程式檔案、`.gitignore`、`AGENTS.md`、`CLAUDE.md` 或 `.claude/`。若初始化前工作區沒有改動，且未選擇寫入 `.vscode/tasks.json`，初始化後的 `git status` 也不會出現新增改動。

### init 的輸出

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

輸出末尾列出資料庫連線資訊，也可以隨時執行 `review-bridge status` 查閱；見 [結果、紀錄與資料庫](./results#在-vs-code-看資料庫)。

## 下一步

建立[第一張工單](./work-order)，接著[開始執行](./start)。
