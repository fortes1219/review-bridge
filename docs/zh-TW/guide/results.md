# 結果、紀錄與資料庫

一條 run 結束，你拿到三樣東西：專案裡的**結果檔**、log 目錄裡的**整條紀錄**、資料庫裡的**每一筆事件**。三者對得起來，靠的是結果檔開頭那幾個 id。

## 結果檔

每條 run 一個檔，放在工單自己的資料夾：

```text
.review-bridge/results/<工單檔名>/
  DOC-1 add-readme 2026-11-06 07-31-29 success.md
  contract.v1.7189c52.json
```

- 檔名是 `<source_id> <工單檔名> <本地日期> <hh-mm-ss> <結論>.md`；工單沒有 `source_id` 就沒有前面那段。**永不覆寫**。
- 旁邊的 `contract.v<版本>.<SHA-256 前七碼>.json` 是結果所指的那份封存合約。
- 這兩個是給你的副本，Bridge 自己另有紀錄，想刪就刪。

結果檔開頭是它在講誰（來自 Bridge 的資料庫），接著是結論：

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

各段怎麼讀見 [結果檔](../reference/result-file)。重點兩個：`version_no` 是**封存的那個版本**，不是現在磁碟上的 `.md`；「Files changed」第一份清單是 Git 的證據，writer 自己宣稱改了什麼另列一份、沒和 Git 對過。

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

一行一條 run：run id、狀態、結論、原因、工單、本地時間。`--after <run_id>` 看下一頁十條；`--json` 給程式讀。

## logs

給工單檔（或它的 `source_id`）列它的 run，最新在上：

```text
Runs of .review-bridge/work-packages/add-readme.md, newest first:
  2eb9dc50-f49d-4eae-95ed-e503a2fa5531  2026-11-06 07:31:29 +0800  success          <log 目錄>/<project_id>/2eb9dc50-…
```

給 run id 列那條 run 的 log 資料夾裡每個檔是什麼：

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

每一次模型呼叫的 prompt、串流、stderr，測試輸出，計畫，和你按 y 的那張卡，全部在這裡。這些檔放在作業系統的 log 目錄，不在專案裡；過了保留期（`bridge.json` 的 `retention.days`，預設 15 天）或 `clean <run_id>` 時刪掉。

## 東西放在哪

| 什麼 | 哪裡 |
|---|---|
| 你寫、你讀的：設定、工單、結果 | 專案的 `.review-bridge/` |
| 你的設定（`settings.json`）、資料庫、每個專案的執行狀態 `projects/<project_id>/` | data home：Windows `%LOCALAPPDATA%\ReviewBridge`、macOS `~/Library/Application Support/ReviewBridge`、Linux `~/.local/share/review-bridge`；`REVIEW_BRIDGE_DATA_HOME` 可以搬 |
| 每條 run 的 log `<project_id>/<run_id>/` | Windows `%LOCALAPPDATA%\ReviewBridge\Log`、macOS `~/Library/Logs/ReviewBridge`、Linux `$XDG_STATE_HOME/review-bridge`（`~/.local/state/review-bridge`）；設了 `REVIEW_BRIDGE_DATA_HOME` 就是它底下的 `logs/` |
| 備份 | data home 的 `backups/database`（`review-bridge backup`）與 `backups/installer`（`upgrade`、`uninstall` 留的）；裡面可能有私人工作資料，不要公開 |

**資料庫是紀錄**；`projects/<project_id>/` 是執行中的副本；log 和結果檔刪了不會丟任何東西。每張工單、每個版本、每張卡（計畫）、每筆授權、合約、run、事件、判定、交付，都是資料庫裡的一列。伺服器只聽 `127.0.0.1`，指令之間一直開著。

## 在 VS Code 看資料庫

裝 Microsoft 的 PostgreSQL 擴充（或 SQLTools 加它的 PostgreSQL driver），新增連線：

- Server：`127.0.0.1`
- Port：`5432`（PostgreSQL 的預設；被占用時往上找下一個空的，每次啟動重找）
- User：`bridge`
- Database：`bridge`
- Password：從密碼檔複製，data home 底下的 `postgres/secret`（Windows 是 `%LOCALAPPDATA%\ReviewBridge\postgres\secret`）；只有你的使用者讀得到。

`init` 和 `review-bridge status` 結尾印的就是這四格加當下的埠和密碼檔位置。要從別的埠開始，在同一個資料夾的 `settings.json` 加 `"database": { "port": 5440 }`，下次資料庫啟動時生效（電腦重開後，或立刻用 `review-bridge backup`——它會停再起）。

## 備份

`review-bridge backup` 是 PostgreSQL 的檔案層級備份：有 run 在跑會拒絕；停資料庫、整個資料夾（資料與密碼檔）複製一份、再啟動。還原：把那份 `postgres` 資料夾複製進一個空資料夾，把 `REVIEW_BRIDGE_DATA_HOME` 指到那裡，在那裡跑 Bridge。
