# 結果檔

每條 run 一個檔，在 `.review-bridge/results/<工單檔名>/`，檔名 `<source_id> <工單檔名> <本地日期> <hh-mm-ss> <結論>.md`，永不覆寫。檔裡的字是程式印的英文；這一頁說每一段怎麼讀。

## 開頭：這份結果在講誰

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

| 欄位 | 意思 |
|---|---|
| `source_id` | 工單 frontmatter 的單號；沒有就沒有這行 |
| `title` | 工單標題 |
| `source_file` | 工單在專案裡的路徑 |
| `version_no` | **封存的那個版本**。工單檔被改過，這裡仍是當時的版本 |
| `contract_sha256` | 合約的 SHA-256；旁邊 `contract.v<版本>.<前七碼>.json` 就是它 |
| `run_id` | run 的 id，`logs <run_id>`、`clean <run_id>` 用它 |
| `commit` | run 開始時的 commit；有未 commit 的改動會加 `plus uncommitted changes`；沒有 Git 是 `unknown (no Git)` |
| `writer` / `reviewer` | 這條 run 實際用的 provider、模型（`null` 是 CLI 自己的預設）、effort；reviewer 多一個 `mcp`：放行給它的 MCP 伺服器 |

這些值來自 Bridge 的資料庫。資料庫讀不到時第一行會說明，底下全部是 unknown。

## 標題：結論

| 標題 | `conclusion` | 意思 |
|---|---|---|
| `Delivered` | `success` | reviewer 通過、每一條驗收都被證明成立 |
| `Needs fixing` | `action_required` | 自動修正的回數（`rounds`）用完，還有沒過的 |
| `Your decision needed` | `action_required` | writer 或 reviewer 要你決定：工單有兩種讀法、要動到範圍外、刪資料、換套件、發布動作 |
| `Stopped` | `cancelled` | 你按了 `stop`；或這張工單以新版本重新開工，舊的被取代；或資料庫斷線 |
| `Cancelled` | `cancelled` | 授權被取消 |
| `Token ceiling exceeded` | `failure` | 超過 per-call 或 per-run 的 token 上限，或讀不到用量 |
| `Provider quota exhausted` | `failure` | provider 的額度用完 |
| `Timed out` | `timed_out` | 到了 `run_timeout` |
| `Error` | `failure` / `timed_out` | 其他錯誤，Why 段有 reason code 與 log 路徑 |

## 第一段：一行摘要與測試

```text
Work order: <路徑>   run: <run_id>   ended: <UTC 時間>   calls: <模型呼叫次數>
Tests: not configured for this project; no test rule matched, so none ran
```

Tests 那行四種：`Existing tests passed: <指令>`、`Existing tests failed: <指令> (exit <code>)`、`Existing tests timed out: <指令>`、`Tests: not configured…`。

## Acceptance

每條驗收一行：

```text
- AC1 proven: <條件原文> (reviewer: pass; tests: not used; evidence: <reviewer 寫的證據>)
Checked on commit 8c96ab0e483f.
```

- 結果：`proven`、`failed`、`unknown`。
- `reviewer`：reviewer 對這一條的判定。
- `tests`：`passed`、`failed`、`not run`、`not used`（這條不是靠測試證明的）。
- 最後一行說在哪個版本上檢查：`Checked on commit …`、`… plus uncommitted changes`，或沒有 Git 時 `Version checked: unknown (no Git)`。

reviewer 通過但不是每條都被證明成立時，Bridge **不**當成交付，Why 段會寫。

## Why

為什麼是這個結論。交付時列 reviewer 驗證了什麼（`Verified by the reviewer:`）、沒跑什麼（`Not run by the reviewer:`）。沒過時列 reviewer 最後一次 review 的 findings（`<id> (<severity>) <path>:<line>: <claim> -> <fix>`）、測試失敗的指令與 stderr 尾段、writer 的提問（`The writer asks you:`）、writer 自己說沒辦法確認的事（`What the writer says it could not check:`）、停下的原因。

## Work order changed after the start

只在工單檔在開工後被改過時出現：Bridge 是對開工時封存的版本判定的，底下列出的改動**沒有用到**；要用它們就重新 `start`。檔不見了或讀不到也會在這裡說。

## Next step

一句話：成功時「看下面改了哪些檔，滿意就自己 commit；再有改動寫新工單」；額度用完時「等額度重置再開」；有 findings 時「照 Why 改工單或程式再開」；超時時「拆小工單或調高 `budget.run_timeout`」。

## Files changed

工作證明。三份清單，缺的不印：

1. **Files changed** — Git 看到的改動（`added`／`modified`／`deleted`），和 Bridge 自己寫的紀錄對過。開頭一句說明這個證據的限制：同一個使用者跑的任何程序都改得了那些紀錄。沒有改動印 `No files were changed.`。
2. **What the writer says it changed (not checked against Git)** — writer 自己宣稱的，沒和 Git 對過。
3. **Already uncommitted when the run started** — run 開始前就已經沒 commit 的檔，不算這條 run 的。

另有兩段只在出事時出現：`Changes outside the allowed scope`（超出授權範圍的改動）、`Changes outside the scope that could not be attributed to this run`。沒有 Git 時這整段只有一句 `No work proof: …`；run 開始後有人改寫 Git 歷史或切分支，Bridge 停下而不比對。

## Tokens

| 欄 | 意思 |
|---|---|
| role | `writer`、`reviewer`、`contract translation`（writer 翻合約）、`contract check`（reviewer 查合約） |
| calls | 呼叫次數 |
| input / cache read / cache write / output / total | 該 CLI 回報的用量加總（含 writer 的子 agent） |
| cost | CLI 有回報才有 |

一次呼叫沒跑到結尾（停掉、超時、中斷）的用量標 `partial`；有 partial 的 run 不能宣稱 token 上限確實守住。

## 給程式讀

`review-bridge status --json`、`review-bridge logs <run_id|file> --json`、`review-bridge work-status` 給同一批欄位的 JSON：每條 run 的 `run_id`、`status`、`conclusion`、`closed_reason`、`created_at`、`closed_at`、`source_file`、`work_package_id`、`authorized_via`；最新一條另有 `version_no`、`title`、`contract_sha256`、`execution_mode`、`writer_provider`／`writer_model`／`writer_effort`、`reviewer_provider`／`reviewer_model`／`reviewer_effort`／`reviewer_mcp`、`breakpoint`、`scope`、`budget`（含每個值來自哪一層）、`test`、`timeout_at`、`last_stop`。
