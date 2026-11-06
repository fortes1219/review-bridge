# 結果、紀錄與資料庫

每次執行結束後，你可以從三個地方查看結果：專案中的**結果檔**、日誌目錄中的**執行紀錄**，以及資料庫中的**事件與判定**。結果檔開頭的 ID 可以用來核對這些資料。

## 結果檔

每次執行產生一個結果檔，存放在該工單的資料夾中：

```text
.review-bridge/results/<工單檔名>/
  DOC-1 add-readme 2026-11-06 07-31-29 success.md
  contract.v1.7189c52.json
```

- 檔名是 `<source_id> <工單檔名> <本地日期> <hh-mm-ss> <結論>.md`；工單沒有 `source_id` 就沒有前面那段。**永不覆寫**。
- 旁邊的 `contract.v<版本>.<SHA-256 前七碼>.json` 是結果所指的那份封存合約。
- 結果檔與合約檔都是供你閱讀的副本；刪除副本不會刪除 Bridge 資料庫中的紀錄。

結果檔開頭列出來自資料庫的工單、版本與角色資訊，接著說明結論：

```markdown
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

# Delivered

Work order: .review-bridge/work-packages/add-readme.md   run: 2eb9dc50-…   ended: 2026-11-05T23:31:29.742Z   calls: 1
Tests: not configured for this project; no test rule matched, so none ran

## Acceptance
- AC1 proven: 根目錄有 README.md，第一行是專案名稱。 (reviewer: pass; tests: not used; evidence: …)
- AC2 proven: README 裡有一段「如何啟動」。 (reviewer: pass; tests: not used; evidence: …)
Checked on commit 8c96ab0e483f.

## Why
Verified by the reviewer:
- …
Not run by the reviewer:
- …

## Next step
Look at the changed files below; commit yourself if you are satisfied. Write a new work order for further changes.

## Files changed
Work proof from Git, checked against the records Bridge wrote; …

### What the writer says it changed (not checked against Git)
- README.md（modified）

## Tokens
| role | calls | input | cache read | cache write | output | total | cost |
|---|---|---|---|---|---|---|---|
| writer | 1 | … |
```

各段說明見[結果檔參考](../reference/result-file)。閱讀時請留意：`version_no` 指**執行時封存的工單版本**；「Files changed」中的第一份清單來自 Git，writer 回報但未經 Git 核對的修改會另外列出。

## status

```text
Page: http://localhost:8080/
Work: 0 running
  2eb9dc50-f49d-4eae-95ed-e503a2fa5531  completed    success          review_pass           .review-bridge/work-packages/add-readme.md  2026-11-06 07:31:29 +0800
Review queue: pending 0, running 0, done 1, failed 0
Latest review: <data home>/projects/<project_id>/reviews/20261105T233129644Z-…-reviewer-review.md
Roles: writer claude, reviewer codex
Logs: <log 目錄>/<project_id>
Database in VS Code: install Microsoft's PostgreSQL extension and add a connection with
  Server 127.0.0.1  Port 5432  User bridge  Database bridge
  Password: copy it from <data home>/postgres/secret
```

每行列出一次執行的 run ID、狀態、結論、原因、工單與本地時間。使用 `--after <run_id>` 查看下一頁十筆，或加上 `--json` 取得供程式使用的輸出。

## logs

傳入工單檔案或 `source_id`，可列出該工單的歷次執行，最新一筆在最上方：

```text
Runs of .review-bridge/work-packages/add-readme.md, newest first:
  2eb9dc50-f49d-4eae-95ed-e503a2fa5531  2026-11-06 07:31:29 +0800  success          <log 目錄>/<project_id>/2eb9dc50-…
```

傳入 run ID，則會列出該次執行的日誌資料夾與各檔案的用途：

```text
Logs of run 2eb9dc50-… (success): <log 目錄>/<project_id>/2eb9dc50-…
  call 1   writer      translate       prompt              …-contract-prompt.txt
  call 1   writer      translate       result              …-contract.result.json
  call 1   writer      translate       stderr              …-contract.stderr.log
  call 1   writer      translate       stream              …-contract.stream.jsonl
  call 2   reviewer    contract_check  prompt              …-contract-check-prompt.txt
  …
  call 3   writer      write           prompt              …-writer-only-prompt.txt
  call 3   writer      write           result              …-writer.stdout.json
  call 4   reviewer    review          stream              …-reviewer.stdout.log
                       result          result              2eb9dc50-….result.md
                       plan            plan                add-readme.plan.json
                       start           authorization_card  authorized-plan-….txt
```

這個目錄包含每次模型呼叫的 prompt、串流與 stderr，以及測試輸出、計畫和你確認的授權卡片。檔案存放於作業系統的日誌目錄，與專案分開。超過保留期限（`bridge.json` 的 `retention.days`，預設 15 天）或執行 `clean <run_id>` 時，會清除對應檔案。

## 資料存放位置

| 資料 | 位置 |
|---|---|
| 專案設定、工單與結果副本 | 專案的 `.review-bridge/` |
| 你的設定（`settings.json`）、資料庫、每個專案的執行狀態 `projects/<project_id>/` | data home：Windows `%LOCALAPPDATA%\ReviewBridge`、macOS `~/Library/Application Support/ReviewBridge`、Linux `~/.local/share/review-bridge`；可用 `REVIEW_BRIDGE_DATA_HOME` 指定其他位置 |
| 每次執行的日誌 `<project_id>/<run_id>/` | Windows `%LOCALAPPDATA%\ReviewBridge\Log`、macOS `~/Library/Logs/ReviewBridge`、Linux `$XDG_STATE_HOME/review-bridge`（`~/.local/state/review-bridge`）；設了 `REVIEW_BRIDGE_DATA_HOME` 就是它底下的 `logs/` |
| 備份 | data home 的 `backups/database`（`review-bridge backup`）與 `backups/installer`（`upgrade`、`uninstall` 留的）；裡面可能有私人工作資料，不要公開 |

**資料庫是執行紀錄的唯一權威來源**，`projects/<project_id>/` 則保存執行中的副本。刪除日誌或結果檔，不會刪除資料庫中的工單版本、計畫、授權、合約、run、事件、判定與交付紀錄；日誌原檔仍會依保留規則清除。資料庫僅監聽 `127.0.0.1`，目前會在指令結束後持續運作。

## 在 VS Code 看資料庫

安裝 Microsoft 的 PostgreSQL 擴充套件，或 SQLTools 與其 PostgreSQL driver，再新增連線：

- Server：`127.0.0.1`
- Port：`5432`（PostgreSQL 的預設；被占用時往上找下一個空的，每次啟動重找）
- User：`bridge`
- Database：`bridge`
- Password：從密碼檔複製，data home 底下的 `postgres/secret`（Windows 是 `%LOCALAPPDATA%\ReviewBridge\postgres\secret`）；只有你的使用者讀得到。

`init` 與 `review-bridge status` 的輸出末尾會顯示目前的連線資訊及密碼檔位置。若要從其他埠開始尋找，在 data home 的 `settings.json` 加入 `"database": { "port": 5440 }`，下次資料庫啟動時就會生效。重新開機，或執行會停止再啟動資料庫的 `review-bridge backup`，都會使用新設定。

## 備份

`review-bridge backup` 使用 PostgreSQL 的檔案層級備份：先停止資料庫，複製完整資料夾（包含資料與密碼檔），再重新啟動。若有工作仍在執行，會拒絕備份。

還原時，將備份的 `postgres` 資料夾複製到一個空資料夾，將 `REVIEW_BRIDGE_DATA_HOME` 指向該空資料夾，再啟動 Bridge。
