# 串接既有系統

如果你已經有工單系統、執行腳本或自建看板，可以讓它產生 Bridge 工單，在取得人工授權後啟動工作，再讀取執行結果，更新回原本的系統。

rc3 目前提供三種串接方式：

| 你想做的事 | 使用方式 |
|---|---|
| 將需求交給 Bridge 執行 | 產生 Markdown 工單檔，透過 CLI 啟動 |
| 讓程式讀取狀態與結果 | 讀取 CLI 的 JSON 輸出或結果檔的 YAML 欄位 |
| 製作報表、看板或稽核匯出 | 直接查詢本機 PostgreSQL |

這些都是目前支援的串接方式。**供外部系統使用的 HTTP API 尚未提供**，規劃於 rc4 加入。

## 將既有工單交給 Bridge

由你的系統產生工單檔，放進專案的 `.review-bridge/work-packages/`。完整格式見[第一張工單](../guide/work-order)：開頭的 YAML frontmatter 放設定，`<!-- bridge:<key> -->` 標記的區塊則提供工作要求與合約內容。

串接時，通常會用到以下欄位：

| 欄位 | 用途 |
|---|---|
| `source_id` | 原系統的單號，例如 Jira、Linear 或 GitHub issue 編號。用來關聯兩邊的紀錄，不決定 Bridge 的工單身分或執行規則 |
| `priority` | 工作優先程度，供 Bridge 套用對應設定 |
| `writer`、`reviewer` | 指定各角色的模型與推理強度（effort） |
| `budget` | 指定這張工單的預算與執行上限，不得超過 policy 允許的範圍 |

設定 `source_id` 後，可以在結果檔名、結果檔 frontmatter、`logs <source_id>` 與資料庫的 `work_order_versions.source_id` 找到它，將 Bridge 的執行紀錄對回原系統的工單。

工單應放在上述目錄；`start` 接受的工單路徑必須位於專案的 `.review-bridge/` 之下。

## 啟動工作前，先取得人工授權

在互動式終端機執行 `start` 時，Bridge 會詢問工作停點、顯示計畫卡片，並要求你確認。透過 agent 或腳本呼叫、沒有互動式終端機時，則先顯示卡片並停在「需要授權」（英文介面是 `Needs authorization`），以 exit code `1` 結束，不會開始工作。

以下示範沒有互動式終端機時的兩次呼叫：

```sh
# 先產生並顯示計畫卡片
npx review-bridge start .review-bridge/work-packages/add-readme.md

# 將卡片交給人確認；取得同意後，才執行這一步
npx review-bridge start .review-bridge/work-packages/add-readme.md --yes
```

`--yes` 表示「人已看過這份計畫並同意執行」，由程式或 agent 轉達這個確認。授權紀錄會標示 `authorized_via: agent`。`--yes` 只照最近一張顯示過的卡片開工；沒有顯示過卡片、工單或選項在卡片之後改過、卡片過期或已開過工，一律拒絕。

**這個欄位記錄的是授權如何轉達，不會替你驗證是否真的有人核准。** 串接 CI 或排程時，仍須安排人工核准步驟，不能把 `--yes` 當成可直接跳過確認的選項。限制 agent 擅自代答，則由 agent 工具本身的權限提示機制負責。

### 需要分開處理計畫與執行時

一般使用 `start` 即可。若你的程式需要先保存計畫，等人核准後再執行，可以使用底層指令：

| 指令 | 用途 |
|---|---|
| `work-plan <file> [--out <file>] [--json]` | 封存計畫但不執行。預設將 `<name>.plan.json` 寫入該次執行的日誌目錄，並輸出計畫的 SHA-256；可用 `--out` 指定位置 |
| `work-start --plan <file> --yes [--json]` | 在取得人工同意後執行指定計畫；加上 `--json`，可在結束時取得該次執行的狀態 |
| `work-cancel --reason <text> [--run <run_id>]` | 取消指定執行的有效授權，使工作無法繼續 |
| `roles-check` | 檢查 writer、reviewer 使用的 CLI 是否已安裝並登入，不呼叫模型 |

以上指令皆以 `npx review-bridge`（或你的套件管理器對應的寫法）開頭；完整選項可用 `<指令> --help` 查看。

## 讓程式讀取狀態與結果

CLI 的 JSON 輸出適合用來更新工單狀態或顯示執行進度。依照要查的內容選擇指令：

| 指令 | 可取得的內容 |
|---|---|
| `status --json` | 本機頁面資訊、執行中的工作數、專案最新十筆執行、最新的審查檔、角色設定、日誌目錄、資料庫是否在跑與連線資訊 |
| `logs <run_id> --json` | 指定執行的日誌目錄，以及各檔案的用途 |
| `logs <file \| source_id> --json` | 指定工單的歷次執行，最新一筆在前，每頁十筆；用 `--after <run_id>` 取得下一頁 |
| `work-status` | 直接輸出 JSON，包含專案的執行清單與最新一筆執行的詳細資料 |
| `clean --json`、`upgrade --json`、`uninstall --json`、`init --json`、`vscode --json` | 各項操作的結果 |

### 執行紀錄中的欄位

本頁將一次執行稱為 run，以 `run_id` 識別。執行清單包含以下基本欄位：

| 類別 | 欄位 |
|---|---|
| 識別與來源 | `run_id`、`source_file`、`work_package_id` |
| 執行狀態 | `status`、`conclusion`、`closed_reason` |
| 開始與結束時間 | `created_at`、`closed_at` |
| 授權轉達方式 | `authorized_via` |

最新一筆執行另有詳細資訊：

| 類別 | 欄位 |
|---|---|
| 工單與合約 | `work_order_id`、`version_no`、`title`、`contract_sha256` |
| 執行模式 | `execution_mode` |
| 實作角色 | `writer_provider`、`writer_model`、`writer_effort` |
| 審查角色 | `reviewer_provider`、`reviewer_model`、`reviewer_effort`、`reviewer_mcp` |
| 執行限制 | `breakpoint`、`scope`、`budget`；預算各值另附設定來源 |
| 測試與停止資訊 | `test`、`timeout_at`、`last_stop` |
| 授權 | `authorized_by`、`authorized_via` |

`status` 表示工作仍在執行（`in_progress`）或已結束（`completed`）。**工作結束不代表交付成功**，還須讀取 `conclusion`：`success`、`failure`、`cancelled`、`timed_out` 或 `action_required`。`closed_reason` 則提供更具體的結束原因。

### 從結果檔關聯回原系統

結果檔開頭的 YAML frontmatter 也可供程式讀取，包含 `source_id`、`title`、`source_file`、`version_no`、`contract_sha256`、`run_id`、`commit`、`writer` 與 `reviewer`。各欄位說明見[結果檔](./result-file)。

檔名格式為 `<source_id> <工單檔名> <本地日期> <hh-mm-ss> <結論>.md`，不會覆寫既有結果；工單未設定 `source_id` 時，省略檔名前面的單號。

## 在腳本中判斷是否成功

**不要只用 exit code 判斷是否完成交付。** Bridge 可能正常結束指令，卻仍在等待授權或人工決定。

例如，工作停在「要你決定」時，指令會以 exit code `0` 結束，但結論是 `action_required`，需要人工處理，不能當成成功。有執行紀錄後，請一律再檢查 `status` 與 `conclusion`。

| Exit code | 意義 |
|---|---|
| `0` | 指令正常結束。工作已結束時，可能已交付，也可能停在需要人處理的結論（例如「要你決定」） |
| `1` | 沒有開工：停在「需要授權」、在終端機答 n、工單沒過表單檢查、`--yes` 被拒；或 writer、reviewer、policy 檢查失敗。資料夾有任何一張沒交付時也是 `1` |
| `2` | 指令出錯，例如參數有誤；訊息印在 stderr |
| `4` | `status` 找不到、讀不到資料庫的資料夾或內容不對（和 `pg_ctl status` 相同） |
| `69` | 執行所需資源不可用，例如工作途中資料庫沒有回應（`database_unavailable`）或讀不到工作證明；對應 sysexits 的 `EX_UNAVAILABLE` |
| `75` | provider 額度耗盡（`rate_limited`）；資料夾整條因登出或額度用完而停下 |
| `76` | 超過 token 上限、讀不到 writer 的用量，或輪數用完仍未通過 |
| `77` | writer 單次呼叫逾時 |
| `78` | 開工後，writer 讀的參考檔被改過（`reference_changed`） |
| `79` | 模型輸出不符合要求的格式，或合約缺了必填欄位（`contract_rejected`） |
| `130` | 因 `stop` 或 Ctrl+C 停止 |

## 查詢資料庫，製作報表與看板

Bridge 的 PostgreSQL 是執行紀錄的權威來源，僅監聽本機的 `127.0.0.1`。報表、看板或稽核匯出可以直接用 SQL 讀取資料。

執行 `npx review-bridge status`，即可取得主機、連接埠、使用者、資料庫名稱，以及密碼檔位置。連線方式見[在 VS Code 看資料庫](../guide/results#在-vs-code-看資料庫)。結果檔是供閱讀的副本；詳細日誌另有保留期限，見[結果、紀錄與資料庫](../guide/results)。

### 資料表與用途

目前共有 16 張業務資料表與 5 張專案 graph 的資料表，另有一張 `schema_migrations` 記錄資料庫遷移版本。

| 資料表 | 內容 |
|---|---|
| `projects` | 專案資訊；`project_id` 對應 `bridge.json` 中的專案 ID |
| `work_orders`、`work_order_versions` | 工單身分與歷次版本；版本包含原文、`content_sha256` 與 `source_id` |
| `plans` | 計畫卡片的完整內容（`body`）與 `plan_sha256` |
| `authorizations`、`authorization_claims` | 授權時的使用者、時間、轉達方式與對應計畫，以及確保授權只使用一次的紀錄 |
| `contracts` | 封存的合約內容與 `sha256` |
| `policy_snapshots` | 執行時生效的 policy 與雜湊值 |
| `runs`、`run_events` | 各次執行及其事件；事件序號由資料庫指派 |
| `test_results` | Bridge 執行測試的結果 |
| `review_results`、`review_findings`、`review_verdicts` | 審查結果、發現的問題與各項驗收條件的判定 |
| `acceptance_rows`、`acceptance_decisions` | 驗收條件的逐項結果，以及 Bridge 的整體判定 |
| `graph_states`、`graph_files`、`graph_definitions`、`graph_references`、`graph_imports` | 專案的 graph：讀到的檔、定義、引用與 import，以及最後更新到哪個 commit |

### 常用查詢範例

以下使用示範單號 `DOC-1` 與 run ID，請換成你的實際資料。

查詢原系統某張工單的執行紀錄，依執行時封存的工單版本比對單號：

```sql
select r.run_id, r.status, r.conclusion, r.closed_reason, r.created_at
from runs r
join work_order_versions v
  on v.work_order_id = r.work_order_id
  and v.content_sha256 = r.content_sha256
where v.source_id = 'DOC-1'
order by r.created_at desc, r.run_id desc
limit 10;
```

查看一次執行中，各項驗收條件的結果、審查判定、測試狀態與證據，按事件順序排列：

```sql
select sequence, ac_id, result, verdict, test, evidence
from acceptance_rows
where run_id = '0be8174d-7b4e-4063-908f-199292f759c2'
order by sequence, ac_id;
```

統計本月開始的執行，各專案已記錄的 token 用量：

```sql
select project_id, sum(tokens_used) as recorded_tokens
from runs
where created_at >= date_trunc('month', now())
group by project_id
order by project_id;
```

最後一例按**執行開始時間**歸月，統計目前已記錄的用量，並非 provider 帳單。若有呼叫讀不到用量，結果檔的 token 表會在該角色寫「N（M 次讀不到）」與「未知」，不拿部分加總充當全部。

### 讀取資料，請不要直接改寫紀錄

欄位定義以安裝版本的 `review-bridge/service/database/migrations/` 遷移檔為準。rc 版本之間仍可能擴充 schema，撰寫查詢時請核對版本。

需要建立或變更工作時，請使用 Bridge 指令，不要直接對資料表執行 `insert`、`update` 或 `delete`。授權、合約與判定必須經由 Bridge 的流程建立，才能保留完整的關聯與核對依據。

## 後續的 HTTP API

rc4 規劃隨 Vue 介面加入 HTTP API，以 Zod 與 oRPC 定義資料格式、型別及執行時驗證。屆時，工單檔、CLI 與資料庫查詢仍會保留，另增加 API 作為串接方式。
