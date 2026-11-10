# 結果檔

每次執行會在 `.review-bridge/results/<工單檔名>/` 產生一個結果檔，檔名為 `<source_id> <工單檔名> <本地日期> <hh-mm-ss> <結論>.md`，不會覆寫既有結果；從資料夾一次跑多張時，放在 `results/<資料夾>/<工單>/`。結果檔照專案的語言（`bridge.json` 的 `locale`，目前有英文與繁體中文）輸出，本頁以繁體中文的字樣說明各段。完整的例子見[結果、紀錄與資料庫](../guide/results#結果檔)。

## 開頭：工單與執行資訊

以下取自 0.3.0-rc.3 用模擬 CLI 跑的一次 run（`0be8174d-7b4e-4063-908f-199292f759c2`，2026-11-10），照原樣：

```yaml
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
```

| 欄位 | 說明 |
|---|---|
| `source_id` | 工單 frontmatter 的單號；未設定時省略此欄位 |
| `title` | 工單標題；工單沒有 `# ` 標題時是 `untitled` |
| `source_file` | 工單在專案裡的路徑 |
| `version_no` | **執行時封存的工單版本**。之後修改工單檔，不會變更這份結果所指的版本 |
| `contract_sha256` | 合約的 SHA-256，對應同目錄中的 `contract.v<版本>.<前七碼>.json` |
| `run_id` | 執行識別碼，供 `logs <run_id>`、`clean <run_id>` 使用 |
| `commit` | 執行開始時的 commit。有未提交改動時加註「加上未 commit 的改動」；沒有 Git 時顯示「未知（沒有 Git）」 |
| `writer` / `reviewer` | 本次執行使用的 provider、模型與 effort；`null` 表示採用 CLI 預設模型。reviewer 的 `mcp` 另列出允許使用的 MCP 伺服器 |

這些值來自 Bridge 資料庫。若無法讀取，開頭會說明原因，例如「讀不到 Bridge 的資料庫（…）；以下各項未知。」

## 標題：結論

| 標題 | `conclusion` | 說明 |
|---|---|---|
| `已交付` | `success` | reviewer 審查通過，且每項驗收條件都證實成立 |
| `需修正` | `action_required` | 已達自動修正輪數（`rounds`）上限，仍有未通過項目 |
| `要你決定` | `action_required` | 需要人工決定，例如 writer 停下來問你、須修改範圍外內容或牽涉發布動作 |
| `已停止` | `cancelled` | 使用者執行 `stop`、工單的新版本取代本次執行（`superseded`），或工作途中 Bridge 的資料庫沒有回應（`database_unavailable`） |
| `已取消` | `cancelled` | 授權被取消（`work-cancel`） |
| `超過 token 上限` | `failure` | writer 超過單次呼叫或整次執行的 token 上限，或 Bridge 讀不到用量 |
| `供應商額度用完` | `failure` | provider 的可用額度已耗盡 |
| `逾時` | `timed_out` | 已達 `run_timeout` 時間上限 |
| `出錯` | `failure` / `timed_out` | 其他錯誤，原因代號與日誌路徑列於「為什麼」段 |

`database_unavailable` 的結果檔在「為什麼」段寫：「工作進行中 Bridge 的資料庫沒有回應，所以停下；之後沒有再呼叫模型。資料庫恢復後再重新開工。」

## 第一段：一行摘要與測試

```text
工單：<路徑>　run：<run_id>　結束：<UTC 時間>　呼叫：<writer 呼叫次數> 次
測試：這個專案沒有設定測試；沒有任何測試規則命中，所以沒有跑
```

測試那一行可能是：`現有測試通過：<指令>`、`現有測試失敗：<指令>（exit <code>）`、`現有測試逾時：<指令>`，或上面的「沒有設定測試」。

## 驗收

每項驗收條件各列一行：

```text
- AC1 已證實：<條件原文>（reviewer：pass；證據：<reviewer 寫的證據>）
檢查的版本：commit 0a46a29129db 加上未 commit 的改動。
```

- 結果：`已證實`、`不成立`、`未知`。由 Bridge 逐條決定，不是直接照抄 reviewer。
- `reviewer`：reviewer 對這一條的判定。
- 最後一行標示檢查時的版本：`檢查的版本：commit …。`、`… 加上未 commit 的改動。`，或沒有 Git 時 `檢查的版本：未知（沒有 Git）…`。
- 開工時專案的 graph 沒能更新時，這裡多一行說明 writer 與 reviewer 查的是更新前的 graph。
- reviewer 沒有判定過的 run（例如還沒審就停下），這一段不列條件。

即使 reviewer 給出通過判定，只要有驗收條件不是「已證實」，Bridge 就不會標記為已交付，並在「為什麼」段說明原因。

## 為什麼

這一段說明結論的依據。

- **已交付時**：列出 reviewer 已驗證的項目（`reviewer 核過：`）與沒有執行的項目（`reviewer 沒跑：`）。**reviewer 判通過、但另外報的 findings 目前不列在這裡**，只在 reviewer 的審查檔（`status` 的「最新審查」那一行指的檔）與資料庫裡。
- **沒通過時**：列出 reviewer 最後一次審查的 findings（`<id>（<severity>）<path>:<line>：<claim>　→ <fix>`）、失敗的測試指令與 stderr 最後幾行、writer 的提問（`writer 問你：`）、writer 回報沒辦法確認的事（`writer 說它沒辦法確認的事：`），以及停止原因。

## 開工後工單被改過

工單檔在執行開始後變更時，才會出現這一段。Bridge 依據開始時封存的版本判定，列出的後續修改**未納入本次執行**；要採用新內容，請重新執行 `start`。工單遭刪除或無法讀取時，也會在此說明。

## 下一步

這一段提供下一步操作：成功時檢查改動並自行決定是否 commit；額度耗盡時等額度恢復後再 `start`；有 findings 時依「為什麼」段修正工單或程式；writer 停下來問你時，在工單裡寫清楚再 `start`；逾時則可拆小工單，或在允許範圍內調高 `budget.run_timeout`。

## 改了哪些檔

工作證明分成三份清單，沒有對應內容時省略：

1. **改了哪些檔**：從 Git 取得的改動（`新增`／`修改`／`刪除`），已與 Bridge 紀錄核對。開頭會說明證據限制：同一個使用者身分執行的任何程式都可能改寫這些紀錄。沒有改動時顯示 `沒有改任何檔。`。
2. **writer 說它改了哪些檔（未經 Git 核對）**：writer 回報的修改，未經 Git 核對。
3. **開工時就未 commit 的檔**：執行開始前已存在的未提交改動，不歸為本次執行的成果。

若有範圍異常，還會出現 `超出範圍的改動`、`超出範圍、但分不出是不是這條 run 改的`。沒有 Git 時，這一段只說明沒有工作證明。若執行期間有人改寫 Git 歷史或切換分支，Bridge 會停止，不繼續比對。

## token

| 欄位 | 說明 |
|---|---|
| 角色 | `合約`、`writer`、`reviewer`；有查 graph 時多一列 `graph 查詢` |
| 呼叫 | 呼叫次數 |
| input / cache read / cache write / output / 合計 | 該 CLI 回報的用量加總（含 writer 的子 agent） |
| 費用 | 僅在 CLI 回報費用時顯示 |

- `合約` 列永遠是 0：合約由程式從工單抄錄，不呼叫模型。
- `graph 查詢` 列是 Bridge 為 writer 與 reviewer 查專案 graph 的 SQL 次數，以及放進 prompt 的估計 token；這些 token 已算在 writer 與 reviewer 的 input 裡，不是另外的花費。
- 某個角色有呼叫讀不到用量時，`呼叫` 欄寫「N（M 次讀不到）」，其他欄寫「未知」，不拿部分加總充當全部。讀不到 writer 的用量時，Bridge 無法確認 token 上限守得住，會在下一次呼叫前停下。

## JSON 輸出

- `npx review-bridge status --json`：本機頁面、角色、資料庫連線資訊，以及這個專案最近十筆執行，每筆有 `run_id`、`status`、`conclusion`、`closed_reason`、`created_at`、`closed_at`、`updated_at`、`source_file`、`work_package_id`、`authorized_via`。用 `--after <run_id>` 取下一頁。
- `npx review-bridge work-status`：同樣的執行清單，另加 `latest_run`，是最新一筆的明細：`work_order_id`、`version_no`、`title`、`contract_sha256`、`execution_mode`、`writer_provider`／`writer_model`／`writer_effort`、`reviewer_provider`／`reviewer_model`／`reviewer_effort`／`reviewer_mcp`、`breakpoint`、`scope`、`budget`（含各值的設定來源）、`test`、`timeout_at`、`authorized_by`、`authorized_via`、`last_stop`。
- `npx review-bridge logs <run_id|file> --json`：執行的欄位與 `work-status` 相同。
