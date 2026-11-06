# 第一張工單

工單是放在 `.review-bridge/work-packages/` 的 Markdown 檔案。Bridge 依區塊標記解析內容，將原文填入合約的對應欄位；模型只負責把驗收區塊整理成編號條件。

如果你用其他工具產生工單，請讓輸出符合本頁的固定格式。

## 從範本開始

```sh
cp .review-bridge/work-packages/TEMPLATE.zh-TW.md .review-bridge/work-packages/add-readme.md
```

填寫需要的區塊，用不到的可以整段刪除。`##` 小標題供人閱讀，可以使用任何語言；Bridge 依 `<!-- bridge:… -->` 標記辨識區塊。

## 最小範例

一個標題、一個 `requested_work` 區塊、一個 `acceptance` 區塊：

```markdown
---
source_id: DOC-1
---
# 幫專案補一份 README

<!-- bridge:context -->
## 背景與現況
專案根目錄沒有 README，新同事不知道怎麼啟動。

<!-- bridge:requested_work -->
## 要做的事
在專案根目錄新增 README.md，說明專案用途與啟動方式。

<!-- bridge:acceptance -->
## 驗收
1. 根目錄有 README.md，第一行是專案名稱。
2. README 裡有一段「如何啟動」。

<!-- bridge:open_questions -->
## 待決問題
無
```

工單至少要有一項可驗證的條件。若未提供，Bridge 會在呼叫模型前停止，提示你補上。

## 完整的工單

以下以缺陷修正為例，展示全部區塊。功能開發的工單可以刪除五個 `reproduction.*` 區塊。範例經 Bridge 解析後，卡片會顯示 `Priority: high (work order)` 與 `rounds 2 (work order)`，括號表示設定來自工單。

```markdown
---
priority: high
writer: { effort: high }
reviewer: { effort: medium }
budget:
  rounds: 2
  run_timeout: 7200000
source_id: SHOP-412
---
# 結帳頁輸入折扣碼後，總價沒有重算

<!-- bridge:context -->
## 背景與現況
結帳頁（CheckoutSummary）輸入折扣碼、API 回 200 之後，畫面上的總價還是原價。客服一週收到 14 件反映。折扣碼的 API 在 2026-10 改過回傳格式：原本回 `total`，現在回 `subtotal`、`discount`、`total` 三個欄位。

<!-- bridge:outcome -->
## 期待的結果
輸入有效折扣碼後一秒內看到折後總價；無效折扣碼時總價不動、看得到錯誤訊息。

<!-- bridge:requested_work -->
## 要做的事
1. 修正 CheckoutSummary 在折扣碼套用後的總價計算，改用 API 新回傳的 `total`。
2. 無效折扣碼時顯示 API 回的錯誤訊息，總價維持原值。
3. 補上這兩種情況的單元測試。

<!-- bridge:run_plan -->
## 執行計畫
### RUN A
修正總價計算與有效折扣碼的顯示。
- effort: high
- acceptance:
  - 有效折扣碼後總價等於 API 回的 total。

### RUN B
無效折扣碼的錯誤訊息。
- depends_on: RUN A
- budget: { rounds: 1 }
- acceptance:
  - 無效折扣碼時看得到錯誤訊息，總價不變。

<!-- bridge:scope_notes.include -->
## 包含
- 結帳頁的折扣碼輸入與總價區塊
- 這兩個情境的單元測試

<!-- bridge:scope_notes.exclude -->
## 不包含
- 折扣碼 API 本身（後端另一張單）
- 購物車頁的小計

<!-- bridge:scope_notes.must_keep -->
## 必須維持
- 沒有折扣碼時的總價算法不變
- 現有結帳流程的測試全部要過
- 不改任何 API 的呼叫路徑與參數

<!-- bridge:scope_notes.expected_locations -->
## 可能會動到的位置（只是參考，不代表授權修改）
- src/components/checkout/CheckoutSummary.vue
- src/composables/useDiscount.ts
- tests/unit/checkout/

<!-- bridge:acceptance -->
## 驗收
1. 輸入有效折扣碼後，一秒內總價顯示折後金額，金額等於 API 回的 `total`。
2. 輸入無效折扣碼後，總價不變，畫面顯示 API 回的錯誤訊息。
3. `npm test` 全部通過，且新增的兩個測試在修正前會失敗、修正後通過。

<!-- bridge:verification_hints -->
## 驗證提示
- 測試資料：折扣碼 `WELCOME10`（有效，九折）、`EXPIRED` （無效，API 回 422 與訊息「折扣碼已過期」）。
- 既有測試：`tests/unit/checkout/CheckoutSummary.spec.ts`。

<!-- bridge:reproduction.environment -->
## 缺陷：環境
Chrome 130、Windows 11、前台 v2.14.0、測試站。

<!-- bridge:reproduction.steps -->
## 缺陷：重現步驟
1. 購物車放一件 1000 元的商品，進結帳頁。
2. 折扣碼欄輸入 `WELCOME10`，按套用。
3. 看總價。

<!-- bridge:reproduction.actual -->
## 缺陷：實際結果
API 回 200，總價仍顯示 1000。

<!-- bridge:reproduction.expected -->
## 缺陷：預期結果
總價顯示 900。

<!-- bridge:reproduction.frequency -->
## 缺陷：頻率與影響
每次都發生；所有使用折扣碼的結帳。

<!-- bridge:references -->
## 參考資料、附件與相依
- 折扣碼 API 文件：docs/api/discount.md
- 相關工單：SHOP-398（API 改格式）

<!-- bridge:open_questions -->
## 待決問題
無
```

各區塊的用途如下：

| 區塊 | 使用者 | 用途 |
|---|---|---|
| `context`、`outcome` | writer、reviewer | 原文填入合約，說明工作背景與預期成果 |
| `requested_work` | writer | 具體工作內容，必填 |
| `run_plan` | Bridge | 描述兩個以上的計畫步驟；會記入合約，目前仍以一次 run 執行整張工單 |
| `scope_notes.include` / `exclude` / `must_keep` | writer、reviewer | 供 reviewer 核對修改是否超出範圍，以及必須保留的行為是否受損 |
| `scope_notes.expected_locations` | writer | 提示可能修改的位置；**不代表修改授權**，實際範圍以卡片的 `Scope` 為準 |
| `acceptance` | reviewer、Bridge | 必填；模型整理成 AC1、AC2…，結果檔逐條列出驗收判定 |
| `verification_hints` | writer、reviewer | 提供測試資料與既有測試名稱；實際測試指令由專案類型決定 |
| `reproduction.*` | writer、reviewer | 描述缺陷的環境、重現步驟、實際結果、預期結果與頻率；功能工單可省略 |
| `references` | writer | 連結、檔案路徑與相關工單 |
| `open_questions` | Bridge | 列出尚待回答的問題；除 `無`、`none` 或空白外，其他內容都會使工作停下，等待你回答 |

## 區塊格式

- 第一個以 `# ` 開頭的行是工單標題。
- 每個區塊從 `<!-- bridge:<key> -->` 標記開始，到下一個標記或檔案結尾為止。
- 區塊 key 對應合約的 17 個欄位：`context`、`outcome`、`requested_work`、`run_plan`、`scope_notes.include`、`scope_notes.exclude`、`scope_notes.must_keep`、`scope_notes.expected_locations`、`acceptance`、`verification_hints`、`reproduction.environment`、`reproduction.steps`、`reproduction.actual`、`reproduction.expected`、`reproduction.frequency`、`references`、`open_questions`。未知 key 或重複 key 都會被拒絕，錯誤訊息會列出行號。
- `open_questions`：填入 `無`、`none` 或留空，表示沒有待決問題。其他每一行都視為問題；Bridge 會在呼叫模型前停止，等待你在工單中回答。
- frontmatter、標題、區塊標記、`##`／`###` 小標題與空行屬於文件結構。區塊外的其他內容會以「未使用的行」保留在合約中。

## frontmatter

frontmatter 是檔案開頭的 YAML 設定，格式參考 Astro content collections：第一行為 `---`，到下一個只含 `---` 的行結束。所有欄位都是選填，也可以完全省略 frontmatter。

```yaml
---
priority: high              # low / medium / high / urgent；預設是 policy 的 priority.default
writer:                     # writer 的模型與 effort，蓋過 policy 的 priority 表
  model: gpt-5.6-sol        # 必須是 writer 那個 CLI 的模型；null 是該 CLI 自己的預設
  effort: high              # low / medium / high
reviewer: { model: opus, effort: medium }   # reviewer 同理
budget:                     # 每一項都可以不寫；預設是 policy 同名的上限
  tokens: 2000000           # limits.tokens
  tokens_per_call: 150000   # limits.tokens_per_call
  call_timeout: 1200000     # limits.call_timeout，毫秒
  test_timeout: 600000      # limits.test_timeout，毫秒
  run_timeout: 7200000      # limits.run_timeout，毫秒
  rounds: 2                 # limits.rounds
source_id: SHOP-412         # 你自己系統的單號；Bridge 只存不讀
---
```

- 未知 key 與不合法的值都會被拒絕，並列出行號。例如 priority 或 effort 不在允許清單中、budget 不是正整數，或設定超過 policy 上限。超出上限時，訊息也會顯示允許的上限。
- `writer` 套用於實作、修正與合約翻譯的每次呼叫；`reviewer` 套用於合約檢查與每次審查。省略的欄位採用 policy 中 priority 表的設定。角色使用的 provider 由 `bridge.json` 或單次執行的 `--writer`／`--reviewer` 決定，並顯示在卡片上。
- `model` 必須符合該角色 CLI 接受的命名格式，否則會在顯示卡片前被拒絕。Bridge 只檢查名稱格式（`claude`：別名 `fable`、`opus`、`sonnet`、`haiku`，可加 `[1m]`，或含 `claude-` 的名字；`codex`：`gpt-`、`codex-` 開頭，或 `o` 加數字開頭），**模型名稱是否存在，仍由該 CLI 確認**；名稱有誤時，CLI 會在第一次呼叫回報錯誤。以下保留文件在 2026-11-06 整理的名稱，使用時請以連結中的最新說明為準：

  | 角色的 CLI | 可以寫的值 | 來源 |
  |---|---|---|
  | `claude` | 別名：`fable`、`opus`、`sonnet`、`haiku`、`sonnet[1m]`、`opus[1m]`、`fable[1m]`。完整名稱：`claude-fable-5-1`、`claude-fable-5`、`claude-opus-5-5`、`claude-opus-5`、`claude-sonnet-5`、`claude-haiku-5-5`（更舊的 4.x 名稱該頁也還列著）。Claude Code 另有 `best`、`opusplan`、`default`，Bridge 的形狀檢查**不收**這三個 | [Claude Code：Model configuration](https://code.claude.com/docs/en/model-config) |
  | `codex` | `gpt-6.1-sol`、`gpt-6.1-terra`、`gpt-6-astra`、`gpt-6-luna`；舊的 `gpt-5.5` 只剩 API key 登入能用，`gpt-5.4`、`gpt-5.3-codex` 等已退役 | [Codex：Models](https://learn.chatgpt.com/docs/models) |

  省略 `model` 或設為 `null` 時，採用該 CLI 當下的預設模型，結果檔會記錄 `model: null`。模型名稱可能隨版本變動，請查閱上方連結及 CLI 說明。若使用自訂 Codex provider，請在 Codex 設定中指定模型，此處省略 `model`。
- `effort` 僅接受 `low`、`medium`、`high` 三個值，兩個角色都一樣。Claude Code 自己的 `--effort` 還有 `xhigh`、`max`，Codex 的介面還有 Extra High、Max、Ultra，本版 Bridge 尚未支援這些值。
- 仍支援頂層 `effort`，其意義等同 `writer.effort`；同時填寫兩者會被拒絕。
- 設定值依以下優先順序決定：終端機旗標（`--rounds`、`--call-timeout`）→ 工單 → policy 的 priority 表（effort 與 model）→ policy 的 limits。計畫會記錄各值及其來源（`cli`、`work_order`、`priority`、`config`），卡片也會一併顯示。
- `run_timeout` 是整次執行的時間上限，預設 6 小時，概念與 GitHub Actions job 的 `timeout-minutes` 相同。逾時後以 `timed_out` 結束，原因記為 `run_timeout`；每次呼叫的可用時間也受剩餘總時間限制。

## 執行計畫（run plan）

需要將工單描述為兩個以上的計畫步驟時，才使用 run plan。每個 `### ` 標題定義一個計畫中的 run，名稱取自標題文字。各 run 中的四種固定 key 以 YAML 解析，其餘內容則描述該步驟的工作。

**目前 run plan 只會記入合約，不會自動拆成多次執行。**以下範例說明兩個相依的文件撰寫步驟：

```markdown
<!-- bridge:run_plan -->
## 執行計畫
### RUN A
撰寫安裝說明。
- effort: low
- acceptance:
  - README 包含安裝步驟。

### RUN B
補上啟動說明。
- depends_on: RUN A
- budget: { rounds: 1, call_timeout: 600000 }
- acceptance:
  - README 包含啟動指令。
```

- `effort`、`budget` 採用與 frontmatter 相同的值。`depends_on` 可以是一個 run 名稱，或名稱清單 `[RUN A, RUN B]`；不存在的相依項目或循環相依都會被拒絕。
- 各 run 的 `acceptance` 清單描述該步驟的驗收條件；工單的 `acceptance` 區塊則描述整體成果。run plan 至少要有兩個 run，只有一個時會被拒絕。
- Bridge 會將 run plan 記入合約；**目前仍以一次 run 執行整張工單**。

## 下一步

[開工](./start)。
