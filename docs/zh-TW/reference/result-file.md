# 結果檔

每次執行會在 `.review-bridge/results/<工單檔名>/` 產生一個結果檔，檔名為 `<source_id> <工單檔名> <本地日期> <hh-mm-ss> <結論>.md`，不會覆寫既有結果。結果檔目前由程式以英文輸出，本頁說明各段內容。

## 開頭：工單與執行資訊

```yaml
---
source_id: DOC-1
title: 幫專案補一份 README
source_file: .review-bridge/work-packages/add-readme.md
version_no: 1  # the sealed version this result is about, not the .md on disk now
contract_sha256: 7189c52c…
run_id: 2eb9dc50-f49d-4eae-95ed-e503a2fa5531
commit: 8c96ab0e…
writer:
  provider: claude
  model: null  # the CLI's own default
  effort: medium
reviewer:
  provider: codex
  model: null  # the CLI's own default
  effort: medium
  mcp: []
---
```

| 欄位 | 說明 |
|---|---|
| `source_id` | 工單 frontmatter 的單號；未設定時省略此欄位 |
| `title` | 工單標題 |
| `source_file` | 工單在專案裡的路徑 |
| `version_no` | **執行時封存的工單版本**。之後修改工單檔，不會變更這份結果所指的版本 |
| `contract_sha256` | 合約的 SHA-256，對應同目錄中的 `contract.v<版本>.<前七碼>.json` |
| `run_id` | 執行識別碼，供 `logs <run_id>`、`clean <run_id>` 使用 |
| `commit` | 執行開始時的 commit。有未提交改動時加註 `plus uncommitted changes`；沒有 Git 時顯示 `unknown (no Git)` |
| `writer` / `reviewer` | 本次執行使用的 provider、模型與 effort；`null` 表示採用 CLI 預設模型。reviewer 的 `mcp` 另列出允許使用的 MCP 伺服器 |

這些值來自 Bridge 資料庫。若無法讀取，開頭會說明原因，欄位值則標為 unknown。

## 標題：結論

| 標題 | `conclusion` | 說明 |
|---|---|---|
| `Delivered` | `success` | reviewer 審查通過，且每項驗收條件都有證據支持 |
| `Needs fixing` | `action_required` | 已達自動修正輪數（`rounds`）上限，仍有未通過項目 |
| `Your decision needed` | `action_required` | 需要人工決定，例如工單有歧義、須修改範圍外內容、刪除資料、更換套件或執行發布動作 |
| `Stopped` | `cancelled` | 使用者執行 `stop`、工單的新版本取代本次執行，或資料庫中斷連線 |
| `Cancelled` | `cancelled` | 授權被取消 |
| `Token ceiling exceeded` | `failure` | 超過單次呼叫或整次執行的 token 上限，或無法讀取用量 |
| `Provider quota exhausted` | `failure` | provider 的可用額度已耗盡 |
| `Timed out` | `timed_out` | 已達 `run_timeout` 時間上限 |
| `Error` | `failure` / `timed_out` | 其他錯誤，原因代碼與日誌路徑列於 Why 段 |

## 第一段：一行摘要與測試

```text
Work order: <路徑>   run: <run_id>   ended: <UTC 時間>   calls: <模型呼叫次數>
Tests: not configured for this project; no test rule matched, so none ran
```

`Tests` 行可能顯示四種結果：`Existing tests passed: <指令>`、`Existing tests failed: <指令> (exit <code>)`、`Existing tests timed out: <指令>`、`Tests: not configured…`。

## Acceptance

每項驗收條件各列一行：

```text
- AC1 proven: <條件原文> (reviewer: pass; tests: not used; evidence: <reviewer 寫的證據>)
Checked on commit 8c96ab0e483f.
```

- 結果：`proven`、`failed`、`unknown`。
- `reviewer`：reviewer 對這一條的判定。
- `tests`：`passed`、`failed`、`not run`、`not used`（該條件不依賴測試結果判定）。
- 最後一行標示檢查時的版本：`Checked on commit …`、`… plus uncommitted changes`，或沒有 Git 時 `Version checked: unknown (no Git)`。

即使 reviewer 給出通過判定，只要仍有驗收條件缺乏證據，Bridge 就不會標記為交付成功，並會在 Why 段說明原因。

## Why

這一段說明結論的依據。交付成功時，列出 reviewer 已驗證的項目（`Verified by the reviewer:`）與未執行的項目（`Not run by the reviewer:`）。

未通過時，會列出最後一次審查的 findings（`<id> (<severity>) <path>:<line>: <claim> -> <fix>`）、失敗的測試指令與 stderr 尾段、writer 的提問（`The writer asks you:`）、writer 回報無法確認的事項（`What the writer says it could not check:`），以及停止原因。

## Work order changed after the start

工單檔在執行開始後變更時，才會出現這一段。Bridge 依據開始時封存的版本判定，列出的後續修改**未納入本次執行**；要採用新內容，請重新執行 `start`。工單遭刪除或無法讀取時，也會在此說明。

## Next step

這一段提供下一步操作：成功時檢查改動並自行決定是否 commit；額度耗盡時等待重置後重試；有 findings 時依 Why 段修正工單或程式；逾時則可縮小工單，或在允許範圍內調高 `budget.run_timeout`。

## Files changed

工作證明分成三份清單，沒有對應內容時省略：

1. **Files changed** — 從 Git 取得的改動（`added`／`modified`／`deleted`），已與 Bridge 紀錄核對。開頭會說明證據限制：同一個使用者執行的程序仍可修改這些紀錄。沒有改動時顯示 `No files were changed.`。
2. **What the writer says it changed (not checked against Git)** — writer 回報的修改，未經 Git 核對。
3. **Already uncommitted when the run started** — 執行開始前已存在的未提交改動，不歸為本次執行的成果。

若有範圍異常，還會出現以下段落：`Changes outside the allowed scope`（超出授權範圍的改動）、`Changes outside the scope that could not be attributed to this run`。沒有 Git 時，這一段只會顯示 `No work proof: …`。若執行期間有人改寫 Git 歷史或切換分支，Bridge 會停止，不繼續比對。

## Tokens

| 欄位 | 說明 |
|---|---|
| role | `writer`、`reviewer`、`contract translation`（writer 轉換驗收條件）、`contract check`（reviewer 核對合約） |
| calls | 呼叫次數 |
| input / cache read / cache write / output / total | 該 CLI 回報的用量加總（含 writer 的子 agent） |
| cost | 僅在 CLI 回報費用時顯示 |

呼叫若因停止、逾時或中斷而未正常結束，用量會標為 `partial`。用量不完整時，Bridge 無法確認 token 上限是否確實受到遵守。

## JSON 輸出

`review-bridge status --json`、`review-bridge logs <run_id|file> --json`、`review-bridge work-status` 提供相同欄位的 JSON 輸出，包含各次執行的 `run_id`、`status`、`conclusion`、`closed_reason`、`created_at`、`closed_at`、`source_file`、`work_package_id`、`authorized_via`；最新一筆另含 `version_no`、`title`、`contract_sha256`、`execution_mode`、`writer_provider`／`writer_model`／`writer_effort`、`reviewer_provider`／`reviewer_model`／`reviewer_effort`／`reviewer_mcp`、`breakpoint`、`scope`、`budget`（包含各值的設定來源）、`test`、`timeout_at`、`last_stop`。
