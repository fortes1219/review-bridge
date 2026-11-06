# 升級、備份、移除

## 升級

```sh
npm i -g review-bridge@next        # 升級 Bridge 本體
cd your-project
review-bridge upgrade              # 把這個專案的設定搬到新版，先備份
```

`upgrade` 是一條固定的流水線，整條 Bridge 自己做完：停舊服務 → 備份 → 遷移 → 完整性檢查 → 清舊檔 → 啟動 → 健康檢查。中途被切斷就再跑一次，它會做完。

- 舊版專案的東西搬一次：設定往上搬到 `.review-bridge/` 第一層，舊的執行狀態（`review-queue/`、`reviews/`、`archive/`）搬進 data home 的 `projects/<project_id>/`，舊的呼叫 log、計畫、卡片搬進 log 目錄，每個檔保留原名、以 SHA-256 核對；保留期已經過的 run 的 log 直接去掉。舊版直接放在 `results/` 裡的結果檔留在原地，那是你的副本。
- `.review-bridge/` 裡 Bridge 不認得的檔（作業系統的垃圾檔、你自己的檔）一律不管、不搬、不刪、不擋。只有目的地已經有同名但內容不同的檔才拒絕，並列出檔名。
- `bridge.json` 裡你改過的角色會保留。
- `--rollback` 從上一次的備份退回。
- 備份放 data home 的 `backups/installer`，或 `--backup-root <folder>`。
- 給腳本用：`--plan-out <file>` 只寫計畫不問；`--plan <file> --approve <sha>` 套用那份計畫，`<sha>` 是 `--plan-out` 印出的 SHA-256。

## 備份

見 [結果、紀錄與資料庫 → 備份](./results#備份)：`review-bridge backup` 複製整個資料庫（所有專案），有 run 在跑會拒絕。

## 移除

```sh
review-bridge uninstall --target .   # 先把專案的設定移掉，有備份
npm uninstall -g review-bridge       # 再移掉 Bridge 本體
```

- `uninstall` 只拿掉 Bridge 自己放的東西：`.review-bridge/`（結果檔是你的副本，一樣在備份裡）、`.vscode/tasks.json` 裡 `review-bridge:` 的 task 與 `review-bridge-` 的 input（檔裡沒別的才刪檔）。
- agent 入口（`~/.claude/commands/review-bridge.md`、`~/.agents/skills/review-bridge/SKILL.md`）和你的使用者 tasks 是所有專案共用的，**最後一個**設定過的專案 `uninstall` 時才移除；你自己改過的檔不動。
- `--plan-out`、`--plan`、`--approve`、`--backup-root`、`--json` 和 `upgrade` 相同。

## 平台

Windows x64 是原生驗證過的。Apple Silicon macOS 可以選但沒有原生驗證。Linux 是實驗性的，原生模型工作會 fail closed。

### Windows

Codex 用 Windows PowerShell 跑指令，會載入你的 `$PROFILE`。中文版 Windows（或任何非 UTF-8 code page）的 PowerShell 用那個 code page 輸出，Codex 當 UTF-8 讀，中文會變亂碼。在 profile 加一行（PowerShell 裡 `notepad $PROFILE`，檔不存在就建）：

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
```

或改用 PowerShell 7（`pwsh`），它本來就輸出 UTF-8。`review-bridge doctor` 會告訴你 PowerShell 現在是不是 UTF-8；它不會改你的 profile。
