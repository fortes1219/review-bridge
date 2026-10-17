# Review Bridge 快速開始

> `dev/rc-3` 開發中：`init` 已能先選任一 writer／reviewer 組合、檢查 CLI 與登入，再安裝到專屬 `.review-bridge/`；既有 `.claude/`、`.codex/` 不會被改動。四個 fake 情境會在暫存副本執行。native 模型入口仍關閉，直到 reviewer 拒寫實測與人類 UV 授權完成。下方第 1 節起的 rc.2 安裝與工作範例尚未更新，不能照它啟動正式 Stage 2 工作。

目前可在解壓後的 Bridge 目錄執行 `node bridge.mjs init --target <你的專案> --writer claude --reviewer codex`；兩個角色可互換，也可選同一 provider。若缺少 CLI 或尚未登入，安裝會先停下並指出哪一邊需要處理。成功只代表安裝與 fake 自測完成，不代表可以啟動真實工作。

這是人類使用者唯一的安裝入口。從「剛收到 ZIP」開始，不需要先叫 Claude 或 Codex 安裝，也不需要知道 `CONTROL.json` 或 session ID。

Review Bridge 是 Claude writer / Codex reviewer 的 workspace-local review controller。它把工作範圍、預算、review gate、修正次數與人類斷點放在可驗證的 controller state，不依賴 Agent 自己記住流程。

## 0. 從 ZIP 進入安裝程式

1. 在檔案總管或 Finder 對 ZIP 選擇「解壓縮」。
2. 把它解壓到目標專案之外的任意本機目錄。
3. 開啟終端並進入解壓後的目錄。

不要把 ZIP 或 installer source 複製進專案。`init` 啟動時會自動檢查封包完整性；如果解壓後的檔案缺少或被改動，它會 fail closed，不安裝任何東西。這項檢查由程式處理，使用者不需要比對雜湊值。

## 使用條件

- Node.js 22 或更新版本。
- Fake mode 不需要 Claude 或 Codex 登入，也不會消耗模型 token。
- Native mode 才需要已登入的 Claude Code CLI 與 Codex CLI。
- Git 是可選的；沒有 Git 時，Bridge 會建立自己的 workspace before/after evidence。
- Controller state 必須位於本機檔案系統。OneDrive 同步目錄與網路磁碟不支援並行 controller。

平台狀態：

- Windows x64：已完成 native verification。
- Apple Silicon macOS：可執行 RC canary，但尚未完成 native verification。
- Linux x64：experimental，預設 fail closed。

## 1. 安裝前人類檢查

1. 執行 `node --version`，必須是 Node.js 22 或更新版本。
2. 確認目標專案位於本機磁碟，不是 OneDrive、Dropbox、iCloud Drive 或網路磁碟。
3. 如果目標是 Git repository，`init` 會在本機的 `.git/info/exclude` 加入 `.review-bridge/`，不會修改 tracked `.gitignore`。
4. 首次安裝時，若專案內已有來源不明的 `.review-bridge/`，先停止並查明，不要盲目覆蓋。

Git 是可選的；沒有 Git 時，Bridge 會建立自己的 workspace before/after evidence。

## 2. 人類互動式安裝與零 token 自證

在這個 package 目錄執行：

```text
node bridge.mjs init --target <專案的絕對路徑>
```

Windows 範例：

```powershell
node bridge.mjs init --target D:\projects\my-app
```

macOS / Linux 範例：

```bash
node bridge.mjs init --target /Users/me/projects/my-app
```

`init` 會：

1. 先選 writer／reviewer，以零 LLM 檢查兩邊 CLI 與登入；目前未支援的角色組合在寫入 target 前停下。
2. 檢查 Node、target、檔案系統與專案 profile。
3. 建立不可竄改的 install plan 並要求確認。
4. 安裝 private `.review-bridge/` controller，不修改 application code。
5. 用 fake CLI 跑完 `PASS`、`FAIL_THEN_PASS`、`HARD_STOP`、`RATE_LIMIT`。
6. 顯示 CLI 與登入結果；native 仍不可開始。

確認畫面會列出 target workspace、operation、detected profile、workspace evidence mode 與 planned changes。只有在下列條件都正確時才輸入 `y`：

- target 是你要安裝的專案。
- profile 符合專案技術棧。
- planned changes 只安裝 private controller、hook、rule、policy 與 ownership manifest。
- 畫面明確表示 application files 不會在 init 中變更。

輸入 `n` 或直接按 Enter 會取消安裝，不應產生 `.review-bridge` 安裝結果。

自動化或 disposable workspace 才使用 `--yes`：

```text
node bridge.mjs init --target <專案的絕對路徑> --writer claude --reviewer codex --yes
```

成功標準不是只有「安裝完成」，而是四個 fake gate 全部完成，且 `fake_runtime_verified` 為 `true`。若任何 preflight 或 gate 失敗，先看終端輸出的 error，不要直接改 controller JSON。

`init` 完成後先停下。此時只完成 Bridge 安裝與 fake self-test，尚未啟動任何真實 Claude/Codex task，也不會消耗模型 token。

## 3. 建立第一個 work package

先複製安裝時建立的範本，再編輯新的 work package：

```text
copy .review-bridge\work-packages\TEMPLATE.md .review-bridge\work-packages\trial-001.md
```

macOS / Linux 使用：

```text
cp .review-bridge/work-packages/TEMPLATE.md .review-bridge/work-packages/trial-001.md
```

內容至少寫清楚：

- 要做的工作。
- 驗收條件。
- 允許修改的路徑。
- 禁止事項與人類斷點。

接著在目標專案執行單行命令：

```text
node .review-bridge/tools/review-bridge/bootstrap.mjs work-plan --task-file .review-bridge/work-packages/trial-001.md --owner "YOUR_NAME" --work-package trial-001 --breakpoint "return after Codex review" --change-types docs --allow-paths "README.md" --max-claude-calls 2 --max-claude-minutes 8 --out .review-bridge/review-queue/trial-001.plan.json
```

先檢查 `work-plan` 輸出的 scope、allowed paths、budget 與 breakpoint。接著執行 `work-start`；它會再次顯示完整 task 與上述限制，確認後輸入 `y`。Controller 會自行驗證 plan：

```text
node .review-bridge/tools/review-bridge/bootstrap.mjs work-start --plan .review-bridge/review-queue/trial-001.plan.json --fake-cli --fake-scenario PASS
```

Fake run 會消耗該 authorization。Native mode 必須重新產生一份 plan，再執行：

```text
node .review-bridge/tools/review-bridge/bootstrap.mjs work-start --plan .review-bridge/review-queue/trial-001.plan.json
```

## 4. 執行期間會發生什麼

- Claude 只負責 approved work package 內的寫作。
- Codex 以獨立、ephemeral review 執行檢查。
- `FAIL` 且不需人類決策時，controller 只送 named findings 回同一個 Claude session 修正。
- `HARD_STOP_REQUIRED: true`、預算用完、rate limit、timeout 或 malformed gate 都會停止。
- `PASS` 會到達 work package 定義的人類 breakpoint，不會自動開始下一項工作。
- Bridge 不會自行 commit、push、deploy 或 release。

查看與取消目前 run：

```text
node .review-bridge/tools/review-bridge/bootstrap.mjs work-status
node .review-bridge/tools/review-bridge/bootstrap.mjs work-cancel --reason "cancelled_by_human_owner"
```

## 5. macOS RC canary

Apple Silicon adapter 目前是 `candidate`，不是 native-verified。請先確認 `init` 的四個 fake gate 全部通過，再執行小範圍、低預算、可丟棄的 native work package。保留以下資訊作為回報：

- macOS 與 Node 版本。
- Claude Code 與 Codex CLI 版本。
- `init` readiness output。
- work package 最終 gate 與錯誤輸出。

不要把專案 credential、`.env`、session ID、queue/review 內容或 rollback snapshot 放進公開 issue。

完整說明見 `README.md`、`docs/first-work-package.md` 與 `docs/installer-contract.md`。
