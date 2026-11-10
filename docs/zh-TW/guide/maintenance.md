# 升級、備份、移除

## 升級

Bridge 本體怎麼升級，看你怎麼執行它：

- **用 `npx review-bridge`（沒有全域安裝）**：不必做任何事，`npx` 每次都取 npm 上的最新版。
- **全域安裝過**：`npm i -g review-bridge@latest`。全域裝了之後，`npx review-bridge` 會用全域那一份，所以要自己升級。

升級之後，先 `npx review-bridge down` 再 `npx review-bridge up`。本機頁面服務只在啟動時讀一次這個平台能不能呼叫模型；已經在跑的頁面服務還是舊版的判斷，reviewer 唯讀檢查可能照舊被擋。

新版第一次執行、需要遷移資料庫時，會先備份資料庫並印出備份位置，再套用遷移；有工作在跑時拒絕。資料庫裡有這一版不認得的遷移（例如之前用過更新的版本）時，Bridge 會列出它們、拒絕開啟，不做任何改動。

專案裡 `.review-bridge/` 的設定，用 `upgrade` 搬到新版：

```sh
cd your-project
npx review-bridge upgrade          # 把這個專案的設定搬到新版，先備份
```

`upgrade` 會依序停止舊服務、備份、遷移、檢查完整性、清理舊檔、重新啟動並執行健康檢查。流程由 Bridge 處理，中斷後可再次執行。

- 舊版目錄會進行一次性遷移：設定移到 `.review-bridge/` 第一層；執行狀態（`review-queue/`、`reviews/`、`archive/`）移到 data home 的 `projects/<project_id>/`；呼叫日誌、計畫與卡片移到日誌目錄。檔案保留原名，並以 SHA-256 核對內容。超過保留期限的執行日誌會清除；舊版直接存放於 `results/` 的結果副本則保留原位。
- Bridge 無法辨識的檔案，例如作業系統產生的暫存檔或你自行建立的檔案，會保留原狀，不影響升級。若遷移目的地已有同名但內容不同的檔案，則會拒絕遷移並列出檔名。
- `bridge.json` 裡你改過的角色會保留。
- 使用 `--rollback` 可從上一次升級的備份還原。
- 備份放 data home 的 `backups/installer`，或 `--backup-root <folder>`。
- 供腳本使用：`--plan-out <file>` 會將計畫寫入檔案，不進行互動確認；`--plan <file> --approve <sha>` 則套用該計畫，`<sha>` 為 `--plan-out` 顯示的 SHA-256。

## 備份

見[結果、紀錄與資料庫 → 備份](./results#備份)：`npx review-bridge backup` 複製整個資料庫（所有專案），若有工作仍在執行，會拒絕備份。

## 移除

```sh
npx review-bridge uninstall --target .   # 先把專案的設定移掉，有備份
npm uninstall -g review-bridge           # 有全域安裝過，再移掉 Bridge 本體
```

- `uninstall` 僅移除 Bridge 建立的內容：`.review-bridge/`（結果副本也會納入備份）、`.vscode/tasks.json` 裡 `review-bridge:` 的 task 與 `review-bridge-` 的 input（僅在檔案不含其他內容時刪除檔案）。
- 代理入口（`~/.claude/commands/review-bridge.md`、`~/.agents/skills/review-bridge/SKILL.md`）與使用者 tasks 由所有專案共用，只有在**最後一個**已設定專案執行 `uninstall` 時才移除。你自行修改過的檔案會保留。
- `--plan-out`、`--plan`、`--approve`、`--backup-root`、`--json` 和 `upgrade` 相同。

## 平台

Windows x64 已通過原生環境驗證。Apple Silicon macOS 與 Linux x64 可選用，但我們自己尚未完成原生驗證。Linux x64 已有第一位使用者在 Ubuntu 26.04 用真的 Claude Code（writer 與 reviewer）跑到交付；Codex 在 Linux 上還沒有執行紀錄。其他平台沒有 adapter，不能原生呼叫模型（fail closed）。

資料庫是 PostgreSQL 18。升級到不同主版本的 PostgreSQL 需要 dump 與 restore，這一版還不處理。

### Windows

Codex 使用 Windows PowerShell 執行指令時，會載入你的 `$PROFILE`。若 PowerShell 使用非 UTF-8 字碼頁輸出，例如中文版 Windows 的預設字碼頁，Codex 以 UTF-8 讀取時就可能出現亂碼。

可在 PowerShell 中執行 `notepad $PROFILE`，加入以下設定；若檔案不存在，請先建立：

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
```

也可以改用預設輸出 UTF-8 的 PowerShell 7（`pwsh`）。`npx review-bridge doctor` 會顯示目前 PowerShell 是否使用 UTF-8，不會修改你的 profile。
