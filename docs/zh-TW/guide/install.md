# 安裝與初始化

Review Bridge 是發行在 npm 的命令列工具。不必先安裝：在專案資料夾執行 `npx review-bridge init`，就會取得最新版並完成初始化，和 `npm create vite` 一樣。

## 需求

- Node.js 22.8 以上，含 npm。
- Git。未使用 Git 的專案也能執行工單，但無法提供**工作證明**。有 Git 時，Bridge 會記錄執行開始時的 commit，並讀取實際修改的檔案；沒有 Git 時，結果檔會明確標示此限制。
- 依 writer 與 reviewer 的角色設定，安裝並登入所需的 CLI：`claude`（Claude Code）、`codex`，或兩者皆安裝。
- Bridge 的狀態必須存放於本機磁碟。不支援同步資料夾與網路磁碟，包括 OneDrive、Dropbox、iCloud Drive、UNC、NFS、SMB。

## init

```sh
cd your-project
npx review-bridge init
```

`npx` 每次會向 npm 查最新版，所以需要網路。想省掉這一步，可以全域安裝 `npm i -g review-bridge`；之後 `npx review-bridge` 會直接用全域那一份。用 pnpm、Yarn、Bun 時，改用 `pnpm dlx review-bridge init`、`yarn dlx review-bridge init`、`bun x review-bridge init`，Bridge 之後印出的指令也會照這個寫法，見[指令 → 用哪個套件管理器執行](../reference/cli#用哪個套件管理器執行)。

`init` 照 create-vite 的方式先問完再做，每題都有預設值，按 Enter 即可採用：

1. **writer**：`claude` 或 `codex`（採用已儲存的預設值；若未設定，則使用 `claude`）。
2. **reviewer**：採用已儲存的預設值；若未設定，則使用 `codex`。
3. **專案類型**：採用偵測到的類型，未偵測到則使用 `none`。這項設定決定每輪 writer 完成後，由 Bridge 執行的驗證指令，例如 `npm test`。選擇 `none`，或專案未提供對應指令時，仍可執行工單；卡片、紀錄與結果檔會標示測試「沒有設定」。
4. **VS Code 工作（tasks）**：是否寫入專案的 `.vscode/tasks.json`，預設為 **N**（見[開始執行](./start#在-vs-code-裡)）。

問完就開始設定，每完成一步印一行，不再顯示計畫、不再要你確認。

也可以使用 `--writer`、`--reviewer`、`--profile <type|none>`、`--target <folder>` 直接指定設定。在非互動式環境中，或加上 `--yes` 時，未指定的項目會採用預設值，不再詢問。

### init 做了什麼

- 建立 `.review-bridge/`：專案設定 `bridge.json`、`policy.override.json`、`rules.md`，以及工單範本 `work-packages/TEMPLATE.md`（英文）與 `TEMPLATE.zh-TW.md`（繁中）。
- 在 `.review-bridge/` 裡放一個只有 `*` 的 `.gitignore`，整個資料夾（包含結果檔）都不進 Git；之後才 `git init` 也一樣。**不會修改專案自己的 `.gitignore`。**
- 使用模擬 CLI 執行四項自我測試，不呼叫模型（`PASS`、`FAIL_THEN_PASS`、`HARD_STOP`、`RATE_LIMIT`）。
- 在 `127.0.0.1` 啟動本機頁面服務；第一次使用時建立並啟動你的資料庫。
- 把專案的程式碼讀成 graph，存在資料庫裡，不在專案寫任何檔（見[開始執行 → 專案的 graph](./start#專案的-graph)）。
- 在**專案外**安裝代理指令入口，供所有專案共用。Claude Code 使用 `~/.claude/commands/review-bridge.md`，以 `/review-bridge` 呼叫；若設定了 `CLAUDE_CONFIG_DIR`，則依該目錄安裝。Codex 使用 `~/.agents/skills/review-bridge/SKILL.md`，以 `$review-bridge` 呼叫。若目標位置已有你自行建立的檔案，Bridge 會保留原檔。

初始化不會修改應用程式檔案、`.gitignore`、`AGENTS.md`、`CLAUDE.md` 或 `.claude/`。若初始化前工作區沒有改動，且未選擇寫入 `.vscode/tasks.json`，初始化後的 `git status` 也不會出現新增改動。

### init 的輸出

以下輸出取自 0.3.0-rc.3：在一個只有 `package.json` 與 `index.js` 的 Git 專案，系統語言是繁體中文，以 0.3.0-rc.3 的原始碼執行 `init --yes --fake-cli`（模擬 CLI，不呼叫模型；2026-11-10，Windows）。連接埠與密碼檔路徑會因機器而不同，這裡把密碼檔路徑前段改寫成 `<data home>`；其餘照原樣：

```text
設定 .review-bridge/...
檢查設定...
跑四個模擬自我測試...
啟動本機網頁...
解析專案...
已讀 1 個檔：0 個定義、1 個引用、0 個 import。

完成。接下來：

  把工單 .md 放進 .review-bridge/work-packages/，然後在 Claude Code 輸入：
    /review-bridge start .review-bridge/work-packages/<file>.md
    （在 Codex：$review-bridge start .review-bridge/work-packages/<file>.md）
  在終端機（進階用法與 CI）：
    npx review-bridge start .review-bridge/work-packages/<file>.md
  網頁：http://localhost:53559/

  在 VS Code 看資料庫：安裝 Microsoft 的 PostgreSQL 擴充套件，新增一個連線，填入
    Server 127.0.0.1  Port 53558  User bridge  Database bridge
    Password：從 <data home>\postgres\secret 複製
```

`init` 用的語言照系統語言（目前有英文與繁體中文），寫進 `bridge.json` 的 `locale`；卡片、`status`、`up`、`down`、`ps` 與結果檔都照它。`解析專案...` 之後那行是 graph 的摘要；有讀不懂的檔時，會在下面逐一列出。

同一次 `init` 之後，專案的 `git status --short` 沒有任何輸出，`.review-bridge/.gitignore` 的內容是：

```text
# Created by Review Bridge automatically.
*
```

輸出末尾列出資料庫連線資訊，也可以隨時執行 `npx review-bridge status` 查閱；見[結果、紀錄與資料庫](./results#在-vs-code-看資料庫)。

## 下一步

建立[第一張工單](./work-order)，接著[開始執行](./start)。
