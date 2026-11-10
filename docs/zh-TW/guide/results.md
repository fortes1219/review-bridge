# 結果、紀錄與資料庫

每次執行結束後，你可以從三個地方查看結果：專案中的**結果檔**、日誌目錄中的**執行紀錄**，以及資料庫中的**事件與判定**。結果檔開頭的 ID 可以用來核對這些資料。

## 結果檔

每次執行產生一個結果檔，存放在該工單的資料夾中。以下輸出都取自同一次 run：0.3.0-rc.3、模擬 CLI、[開始執行](./start#卡片)那張 README 工單、`locale: zh-TW`（run `0be8174d-7b4e-4063-908f-199292f759c2`，2026-11-10，Windows）。路徑前段改寫成 `<data home>`、`<log 目錄>`，其餘照原樣。

```text
.review-bridge/results/add-readme/
  contract.v1.c666cd9.json
  DOC-1 add-readme 2026-11-10 11-26-24 success.md
```

- 檔名是 `<source_id> <工單檔名> <本地日期> <hh-mm-ss> <結論>.md`；工單沒有 `source_id` 就沒有前面那段。**永不覆寫**。
- 旁邊的 `contract.v<版本>.<SHA-256 前七碼>.json` 是結果所指的那份封存合約。
- 結果檔與合約檔都是供你閱讀的副本；刪除副本不會刪除 Bridge 資料庫中的紀錄。
- 從資料夾一次跑多張時，結果放在 `results/<資料夾>/<工單>/`。

結果檔照專案的語言（`bridge.json` 的 `locale`）寫。開頭列出來自資料庫的工單、版本與角色資訊，接著說明結論：

```markdown
---
source_id: DOC-1
title: 幫專案補一份 README
source_file: .review-bridge/work-packages/add-readme.md
version_no: 1  # 結果對應的是封存的這一版，不是磁碟上現在的 .md
contract_sha256: c666cd9a479796f426873f72595bb8d441f5bc322692c253b35604516f0946b4
run_id: 0be8174d-7b4e-4063-908f-199292f759c2
commit: 0a46a29129db29736ddd919d744b75c84c6df62a  # 加上未 commit 的改動
writer:
  provider: claude
  model: null  # 用 CLI 自己的預設
  effort: medium
reviewer:
  provider: codex
  model: null  # 用 CLI 自己的預設
  effort: medium
  mcp: []
---

# 已交付

工單：.review-bridge/work-packages/add-readme.md　run：0be8174d-7b4e-4063-908f-199292f759c2　結束：2026-11-10T03:26:24.075Z　呼叫：1 次
測試：這個專案沒有設定測試；沒有任何測試規則命中，所以沒有跑

## 驗收
- AC1 已證實：根目錄有 README.md，第一行是專案名稱。（reviewer：pass；證據：fake: read the delta and the test output for AC1）
- AC2 已證實：README 裡有一段「如何啟動」。（reviewer：pass；證據：fake: read the delta and the test output for AC2）
檢查的版本：commit 0a46a29129db 加上未 commit 的改動。

## 為什麼
reviewer 核過：
- fake: read the delta
reviewer 沒跑：
- fake: project tests

## 下一步
看下面改了哪些檔，滿意就自己 commit；要再改就寫新工單。

## 改了哪些檔
工作證明來自 Git，並對照 Bridge 寫下的紀錄；同一個使用者身分執行的任何程式都可能改寫這些紀錄。

- README.md（新增）

### writer 說它改了哪些檔（未經 Git 核對）
- README.md（修改）

## token
| 角色 | 呼叫 | input | cache read | cache write | output | 合計 | 費用 |
|---|---|---|---|---|---|---|---|
| 合約 | 0 | 0 | 0 | 0 | 0 | 0 |  |
| writer | 1 | 94 | 150346 | 454 | 2352 | 153246 | 0.4200 USD |
| reviewer | 1 | 29995 | 29995 | 0 | 410 | 60400 |  |
| graph 查詢 | 8 次 SQL | 放進 prompt 約 68 token |  |  |  |  | 估算；已算在上面 writer 與 reviewer 的 input 裡，不是另外的花費 |
```

證據、token 與費用都是模擬 CLI 的固定值，不是真的模型用量。`commit` 註明「加上未 commit 的改動」，是因為 writer 新增的 README.md 還沒 commit。

各段說明見[結果檔參考](../reference/result-file)。閱讀時請留意：

- `version_no` 指**執行時封存的工單版本**。
- 「改了哪些檔」的第一份清單來自 Git；writer 回報但未經 Git 核對的修改另外列出。
- 「合約」那列永遠是 0：合約由程式從工單抄錄，不呼叫模型。
- **已交付時，結果檔不列 reviewer 另外報的 findings。** reviewer 判通過、但另外提醒的事（例如「建議另開工單處理」），目前只在 reviewer 的審查檔裡：`status` 的「最新審查」那一行指的檔（data home 的 `projects/<project_id>/reviews/…-reviewer-review.md`），資料庫也有存。沒通過時，findings 會列在結果檔的「為什麼」段。

## status

```text
網頁：http://localhost:53559/
資料庫：在跑
工作：0 個在跑
  0be8174d-7b4e-4063-908f-199292f759c2  completed    success          review_pass           .review-bridge/work-packages/add-readme.md  2026-11-10 11:26:22 +0800
最新審查：<data home>\projects\bdbe7d5a-c1de-4d00-ad6e-59ed13cf8d0f\reviews\20261110T032623735Z-70dc1fb2973cc3a2-reviewer-review.md
角色：writer claude、reviewer codex
紀錄：<log 目錄>\bdbe7d5a-c1de-4d00-ad6e-59ed13cf8d0f
在 VS Code 看資料庫：安裝 Microsoft 的 PostgreSQL 擴充套件，新增一個連線，填入
  Server 127.0.0.1  Port 53558  User bridge  Database bridge
  Password：從 <data home>\postgres\secret 複製
```

每行列出一次執行的 run ID、狀態、結論、原因、工單與本地時間。使用 `--after <run_id>` 查看下一頁十筆，或加上 `--json` 取得供程式使用的輸出。`status` 只報告資料庫是否在跑，不會順便啟動資料庫；資料庫的資料夾不見、讀不到或內容不對時，會印出路徑，並以結束碼 4 結束（和 `pg_ctl status` 相同）。

## logs

傳入工單檔案或 `source_id`，可列出該工單的歷次執行，最新一筆在最上方：

```text
Runs of .review-bridge/work-packages/add-readme.md, newest first:
  0be8174d-7b4e-4063-908f-199292f759c2  2026-11-10 11:26:22 +0800  success          <log 目錄>\bdbe7d5a-c1de-4d00-ad6e-59ed13cf8d0f\0be8174d-7b4e-4063-908f-199292f759c2
```

傳入 run ID，則會列出該次執行的日誌資料夾與各檔案的用途：

```text
Logs of run 0be8174d-7b4e-4063-908f-199292f759c2 (success): <log 目錄>\bdbe7d5a-c1de-4d00-ad6e-59ed13cf8d0f\0be8174d-7b4e-4063-908f-199292f759c2
                       result          result              0be8174d-7b4e-4063-908f-199292f759c2.result.md
  call 1   writer      write           stop_payload        20261110T032622445Z-r0be8174d-stop-payload.json
  call 1   writer      write           prompt              20261110T032622445Z-r0be8174d-writer-only-prompt.txt
  call 1   writer      write           stderr              20261110T032622445Z-r0be8174d-writer.stderr.log
  call 1   writer      write           result              20261110T032622445Z-r0be8174d-writer.stdout.json
  call 1   writer      write           stream              20261110T032622445Z-r0be8174d-writer.stream.jsonl
  call 2   reviewer    review          stderr              20261110T032623735Z-70dc1fb2973cc3a2-reviewer.stderr.log
  call 2   reviewer    review          stream              20261110T032623735Z-70dc1fb2973cc3a2-reviewer.stdout.log
                       plan            plan                add-readme.plan.json
                       start           authorization_card  authorized-plan-7888361e8a0a3aa1f07dec070a0970191f221f35a9c6110403e5082d9b3037cc.txt
```

`logs` 的輸出目前只有英文。每次模型呼叫是一個 `call`：這個 run 只有 writer 做工一次（call 1）、reviewer 審查一次（call 2），沒有轉合約的呼叫。不屬於某次呼叫的檔：`result` 是結果檔的原件，`plan` 是封存的計畫，`authorization_card` 是你按「好」的那張卡片。

這個目錄包含每次模型呼叫的 prompt、串流與 stderr，以及測試輸出、計畫和你確認的授權卡片。檔案存放於作業系統的日誌目錄，與專案分開。超過保留期限（`bridge.json` 的 `retention.days`，預設 15 天）或執行 `clean <run_id>` 時，會清除對應檔案。

## 資料存放位置

| 資料 | 位置 |
|---|---|
| 專案設定、工單與結果副本 | 專案的 `.review-bridge/` |
| 你的設定（`settings.json`）、資料庫、每個專案的執行狀態 `projects/<project_id>/` | data home：Windows `%LOCALAPPDATA%\ReviewBridge`、macOS `~/Library/Application Support/ReviewBridge`、Linux `~/.local/share/review-bridge`；可用 `REVIEW_BRIDGE_DATA_HOME` 指定其他位置 |
| 每次執行的日誌 `<project_id>/<run_id>/` | Windows `%LOCALAPPDATA%\ReviewBridge\Log`、macOS `~/Library/Logs/ReviewBridge`、Linux `$XDG_STATE_HOME/review-bridge`（`~/.local/state/review-bridge`）；設了 `REVIEW_BRIDGE_DATA_HOME` 就是它底下的 `logs/` |
| 備份 | data home 的 `backups/database`（`npx review-bridge backup`）與 `backups/installer`（`upgrade`、`uninstall` 留的）；裡面可能有私人工作資料，不要公開 |

**資料庫是執行紀錄的唯一權威來源**，`projects/<project_id>/` 則保存執行中的副本。刪除日誌或結果檔，不會刪除資料庫中的工單版本、計畫、授權、合約、run、事件、判定與交付紀錄；日誌原檔仍會依保留規則清除。資料庫僅監聽 `127.0.0.1`，在指令結束、關掉終端機或 VS Code 後仍持續運作；要停止用 `npx review-bridge down`，見[開始執行 → 資料庫與本機頁面](./start#資料庫與本機頁面-up、down、ps、watch)。

## 在 VS Code 看資料庫

安裝 Microsoft 的 PostgreSQL 擴充套件，或 SQLTools 與其 PostgreSQL driver，再新增連線：

- Server：`127.0.0.1`
- Port：`5432`（PostgreSQL 的預設；被占用時往上找下一個空的，每次啟動重找）
- User：`bridge`
- Database：`bridge`
- Password：從密碼檔複製，data home 底下的 `postgres/secret`（Windows 是 `%LOCALAPPDATA%\ReviewBridge\postgres\secret`）；只有你的使用者讀得到。

`init` 與 `npx review-bridge status` 的輸出末尾會顯示目前的連線資訊及密碼檔位置。若要從其他埠開始尋找，在 data home 的 `settings.json` 加入 `"database": { "port": 5440 }`，下次資料庫啟動時就會生效。重新開機，或執行會停止再啟動資料庫的 `npx review-bridge backup`、`down` 之後再 `up`，都會使用新設定。

## 備份

`npx review-bridge backup` 使用 PostgreSQL 的檔案層級備份：先停止資料庫，複製完整資料夾（包含資料與密碼檔），再重新啟動。若有工作仍在執行，會拒絕備份。

還原時，將備份的 `postgres` 資料夾複製到一個空資料夾，將 `REVIEW_BRIDGE_DATA_HOME` 指向該空資料夾，再啟動 Bridge。
