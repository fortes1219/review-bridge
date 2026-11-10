# 第一張工單

<script setup>
import SchemaPeek from "../../.vitepress/theme/components/SchemaPeek.vue"
import contractSchema from "../../../review-bridge/features/workOrder/schemas/contract.schema.json?raw"
</script>

工單是放在 `.review-bridge/work-packages/` 的 Markdown 檔案。Bridge 用程式依區塊標記解析內容，將原文抄進合約的對應欄位，並把驗收清單的每一項切成一條編號條件（AC1、AC2…）。這一步不呼叫模型，結果檔的 token 表記為 0。

如果你用其他工具產生工單，請讓輸出符合本頁的固定格式。

## 從範本開始

```sh
cp .review-bridge/work-packages/TEMPLATE.zh-TW.md .review-bridge/work-packages/add-readme.md
```

填寫需要的區塊，用不到的可以整段刪除。`##` 小標題供人閱讀，可以使用任何語言；Bridge 依 `<!-- bridge:… -->` 標記辨識區塊。

## 先寫一張簡單工單

必填的是 `requested_work` 與 `acceptance`；以下範例另外加上標題、背景與待決問題，方便整理需求：

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

## 開工前的表單檢查

`start` 把工單當成一張表單來檢查，下列任何一項不符合，就在顯示卡片之前停下，逐項列出問題（行號、哪個區塊），並印出補好之後再執行的指令：

- **要做的事**：`requested_work`（或 `run_plan`）底下要有內容。
- **驗收清單**：`acceptance` 底下要有清單，每一行都是清單項目，用 `- `、`* `、`+ ` 或 `1. ` 開頭。「一、」「（1）」在 Markdown 裡不算清單，寫成這樣的行會被指出來。清單照 Markdown 的規則切（markdown-it，和 VitePress 相同），一個項目就是一條條件。
- **待決問題**：`open_questions` 底下只能是 `無`、`none` 或空白；其他每一行都是還沒回答的問題。把答案寫進工單，再刪掉那一行或改成 `無`。

如果你刪掉了「要做的事」或「驗收」的區塊標記，Bridge 會把標記和小標題補回檔案最後面，讓你知道要寫在哪裡；你寫過的每一行都不會被改。標題（`# `）可以不寫，沒有標題時記為 `untitled`。

Bridge 檢查格式與必填內容，不會判斷需求是否足夠清楚。如何寫出可驗證的要求，見[把需求講清楚](../principles/asking)。

## 表單過了之後：工單變成合約

表單檢查通過後、卡片出現之前，Bridge 用程式把工單抄成一份合約。這一步不呼叫模型。

- 每個區塊的內容逐字抄進合約的同名欄位，附上它在封存原文裡的行號（`source_refs`）；未填的區塊依欄位以 `null` 或 `[]` 表示。區塊外、又不屬於文件結構的行，放進 `unused_lines`。
- 驗收清單的每一項切成一條條件，依序編成 `AC1`、`AC2`…。`statement` 是那一項的原文（去掉清單符號），附行號。
- frontmatter 和標題放進 `ticket`：標題、`source_id`、`priority`、writer 的 `effort`、`budget`。
- `open_questions` 不進合約，它只在開工前擋住還沒回答的問題。
- 合約自己帶著封存的工單全文（`source.lines`）和這份全文的 SHA-256（`source.sha256`）。

整份合約再算一個 SHA-256（JSON 的 key 順序不影響結果），印在卡片上：

```
合約：sha256 c666cd9a479796f426873f72595bb8d441f5bc322692c253b35604516f0946b4，從驗收清單切出 2 條條件
```

你按「好」，授權的就是這個 hash 的合約。Bridge 把合約以 hash 為檔名存在自己的資料目錄，每次讀都重算一次，對不上就停下，不拿改過的合約做工。結果資料夾另有一份副本：`.review-bridge/results/<工單>/contract.v<版本>.<hash 前 7 碼>.json`。之後再改 `.md`，已封存的這一版不會變；要採用新內容，就再 `start` 一次，成為同一張工單的下一版。

### 合約的 schema

合約封存前要先通過這份 JSON Schema（draft-07），讀回來時也再驗一次。頂層欄位都必須存在，工單未填的選填內容以 `null` 或 `[]` 表示；`budget` 裡的各項設定則可省略。每個物件都不收額外的欄位。

<SchemaPeek title="contract.schema.json" :source="contractSchema" />

`open_questions` 不在 schema 裡：它只擋開工，不進合約。

### writer 拿到什麼

每一次呼叫，prompt 裡都有整份合約和它的 hash，再加上 Bridge 從專案 graph 查出來的 PROJECT 段（見[專案的 graph](./start#專案的-graph)）。writer 要對每一條 AC 各回報一次 `done` 或 `not_done`，全部 `done` 才能說做完。少報、重報、報了不存在的 AC，或還有條件沒做完卻說做完，Bridge 都不收。

### reviewer 拿到什麼

同一份合約。reviewer 的回答要對每一條 AC 各給一個判定：

- `pass`：附上證據（檔案與行號，或測試輸出）；
- `fail`：附一條指向那條 AC 的 finding；
- `cannot_verify`：寫出缺了什麼。

有一條 `fail` 就不能整體判 PASS。回答不合這些規則時，Bridge 退回請它重答一次；第二次還不合，就結束這次工作。

### Bridge 怎麼決定

Bridge 照逐條判定決定，不看 reviewer 整體怎麼說：`pass` 記為「已證實」，`fail` 記為「不成立」，`cannot_verify` 或沒有判定記為「未知」。

- 每一條都已證實：交付。
- 有一條不成立：reviewer 這輪一定是 FAIL，退回 writer 修。
- reviewer 判 PASS，但有條件是未知：不當成通過交付。這次工作停下，結果檔標題是「要你決定」，「為什麼」段寫「reviewer 判通過，但不是每條驗收條件都證實成立（見「驗收」），所以 Bridge 不當成通過交付。」

### 結果檔怎麼呈現

結果檔的「驗收」一節每條 AC 一行：Bridge 的決定、你寫的原文、reviewer 的判定與證據；最後一行是檢查的版本。同一次樣本 run 的這一節（證據是模擬 CLI 的固定文字）：

```markdown
## 驗收
- AC1 已證實：根目錄有 README.md，第一行是專案名稱。（reviewer：pass；證據：fake: read the delta and the test output for AC1）
- AC2 已證實：README 裡有一段「如何啟動」。（reviewer：pass；證據：fake: read the delta and the test output for AC2）
檢查的版本：commit 0a46a29129db 加上未 commit 的改動。
```

整份結果檔見[結果、紀錄與資料庫](./results)。

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

各區塊進合約的哪個欄位、怎麼被用，如下表。整份合約會放進 writer 與 reviewer 的每一次 prompt，所以每個欄位兩個角色都讀得到；表上寫的是誰拿它做什麼。

| 區塊 | 合約欄位 | 怎麼用 |
|---|---|---|
| frontmatter、`# ` 標題 | `ticket` | 標題、`source_id`、`priority`、writer 的 `effort`、`budget`。卡片上的生效值與來源由這裡、終端機旗標與 policy 算出 |
| `context`、`outcome` | `context`、`outcome` | 工作背景與預期成果，writer 和 reviewer 都讀 |
| `requested_work` | `requested_work` | 要做的事；必填（有 `run_plan` 時可省略） |
| `run_plan` | `run_plan.runs[]`：名稱、內容、`depends_on`、`effort`、`budget` | 記進合約；這一版仍以一次 run 做完整張工單 |
| `scope_notes.include`／`exclude`／`must_keep` | `scope_notes.include`／`exclude`／`must_keep` | reviewer 據此核對有沒有超出範圍、必須維持的行為有沒有壞 |
| `scope_notes.expected_locations` | `scope_notes.expected_locations` | 只是提示 writer 從哪裡找；**不是修改授權**，授權的邊界是卡片上的「範圍」 |
| `acceptance` | `acceptance[]`：`AC1`、`AC2`… | 必填；每一項一條條件。writer 逐條回報，reviewer 逐條判定，Bridge 逐條決定，結果檔逐條列出 |
| `run_plan` 裡各 run 的 `acceptance` | 接在工單驗收之後編號，`run_refs` 記是哪個 run | 範例的三條是 `AC1`～`AC3`，RUN A、RUN B 各一條成為 `AC4`、`AC5` |
| `verification_hints` | `verification_hints[]` | 測試資料與既有測試的名字，給 writer 和 reviewer 參考；實際跑哪個測試由專案的測試規則決定（卡片的「測試」） |
| `reproduction.*` | `reproduction`（五項都沒寫時是 `null`） | 缺陷的環境、重現步驟、實際結果、預期結果與頻率；功能工單可省略 |
| `references` | `references[]` | 連結、檔案路徑與相關工單 |
| `open_questions` | 不進合約 | 只擋開工：除 `無`、`none` 或空白外，其他內容都會讓 `start` 在卡片前停下，等你在工單裡回答 |
| 區塊外、不屬於文件結構的行 | `unused_lines` | 原文附行號保留，不當成任何區塊 |

## 區塊格式

- 第一個以 `# ` 開頭的行是工單標題。
- 每個區塊從 `<!-- bridge:<key> -->` 標記開始，到下一個標記或檔案結尾為止。
- 可用的區塊 key 共 17 種：`context`、`outcome`、`requested_work`、`run_plan`、`scope_notes.include`、`scope_notes.exclude`、`scope_notes.must_keep`、`scope_notes.expected_locations`、`acceptance`、`verification_hints`、`reproduction.environment`、`reproduction.steps`、`reproduction.actual`、`reproduction.expected`、`reproduction.frequency`、`references`、`open_questions`。未知 key 或重複 key 都會被拒絕，錯誤訊息會列出行號。
- `open_questions`：填入 `無`、`none` 或留空，表示沒有待決問題。其他每一行都視為問題；`start` 會在顯示卡片前停下，等你在工單中回答。
- frontmatter、標題、區塊標記、`##`／`###` 小標題與空行屬於文件結構。區塊外的其他內容會以「未使用的行」保留在合約中。

## frontmatter

frontmatter 是檔案開頭的 YAML 設定，格式參考 Astro content collections：第一行為 `---`，到下一個只含 `---` 的行結束。所有欄位都是選填，也可以完全省略 frontmatter。

```yaml
---
priority: high              # low / medium / high / urgent；預設是 policy 的 priority.default
writer:                     # writer 的模型與 effort，蓋過 policy 的 priority 表
  model: gpt-6.1-sol        # 必須是 writer 那個 CLI 的模型；null 是該 CLI 自己的預設
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

第一次按「好」之後，Bridge 會在 frontmatter 加上一行 `id: <工單 ID>`（沒有 frontmatter 的檔會多出一段只有這行的 frontmatter）。這行由 Bridge 管理，不要自己填、改或刪；它不算進合約的 SHA-256。見下方[檔名與工單身分](#檔名與工單身分)。


- 未知 key 與不合法的值都會被拒絕，並列出行號。例如 priority 或 effort 不在允許清單中、budget 不是正整數，或設定超過 policy 上限。超出上限時，訊息也會顯示允許的上限。
- `writer` 套用於 writer 的每次呼叫（做工與每次修正）；`reviewer` 套用於每次審查。省略的欄位採用 policy 中 priority 表的設定。角色使用的 provider 由 `bridge.json` 或單次執行的 `--writer`／`--reviewer` 決定，並顯示在卡片上。
- `model` 必須符合該角色 CLI 接受的命名格式，否則會在顯示卡片前被拒絕。Bridge 只檢查名稱格式（`claude`：別名 `fable`、`opus`、`sonnet`、`haiku`，可加 `[1m]`，或含 `claude-` 的名字；`codex`：`gpt-`、`codex-` 開頭，或 `o` 加數字開頭），**模型名稱是否存在，仍由該 CLI 確認**；名稱有誤時，CLI 會在第一次呼叫回報錯誤。以下是撰寫本頁時兩個 CLI 文件列出的名稱，使用時請以連結中的最新說明為準：

  | 角色的 CLI | 可以寫的值 | 來源 |
  |---|---|---|
  | `claude` | 別名：`fable`、`opus`、`sonnet`、`haiku`、`sonnet[1m]`、`opus[1m]`、`fable[1m]`。完整名稱：`claude-fable-5-1`、`claude-fable-5`、`claude-opus-5-5`、`claude-opus-5`、`claude-sonnet-5`、`claude-haiku-5-5`（更舊的 4.x 名稱該頁也還列著）。Claude Code 另有 `best`、`opusplan`、`default`，Bridge 的形狀檢查**不收**這三個 | [Claude Code：Model configuration](https://code.claude.com/docs/en/model-config) |
  | `codex` | `gpt-6.1-sol`、`gpt-6.1-terra`、`gpt-6-astra`、`gpt-6-luna`；舊的 `gpt-5.5` 只剩 API key 登入能用，`gpt-5.4`、`gpt-5.3-codex` 等已退役 | [Codex：Models](https://learn.chatgpt.com/docs/models) |

  省略 `model` 或設為 `null` 時，採用該 CLI 當下的預設模型，結果檔會記錄 `model: null`。模型名稱可能隨版本變動，請查閱上方連結及 CLI 說明。若使用自訂 Codex provider，請在 Codex 設定中指定模型，此處省略 `model`。
- `effort` 僅接受 `low`、`medium`、`high` 三個值，兩個角色都一樣。Claude Code 自己的 `--effort` 還有 `xhigh`、`max`，Codex 的介面還有 Extra High、Max、Ultra，本版 Bridge 尚未支援這些值。
- 仍支援頂層 `effort`，其意義等同 `writer.effort`；同時填寫兩者會被拒絕。
- 設定值依以下優先順序決定：終端機旗標（`--rounds`、`--call-timeout`）→ 工單 → policy 的 priority 表（effort 與 model）→ policy 的 limits。計畫會記錄各值及其來源（`cli`、`work_order`、`priority`、`config`），卡片也會一併顯示。
- `tokens` 與 `tokens_per_call` 只算 writer，而且不含 cache read（cache read 在結果檔另外列）。reviewer 的用量會記錄，但不計入 token 預算。
- `run_timeout` 是整次執行的時間上限，預設 6 小時，概念與 GitHub Actions job 的 `timeout-minutes` 相同。逾時後以 `timed_out` 結束，原因記為 `run_timeout`；每次呼叫的可用時間也受剩餘總時間限制。

## 檔名與工單身分

工單檔名可以用任何語言：各種文字的字母、數字與組合記號，加上 `.`、`_`、`-` 與單一空白。開頭和結尾不能是點或空白，不能有路徑分隔字元，長度上限 80 個字元、同時不超過 180 位元組（中文一個字 3 位元組，所以中文檔名最多約 60 個字）。比對與存檔前會正規化成 NFC，同一個中文檔名在 macOS 和 Windows 上算同一張。

Bridge 認工單靠 frontmatter 的 `id`，不靠檔名或位置：

- 改檔名、搬到別的資料夾、調整序號：仍是同一張工單。
- 改內容後重新開工：同一張工單的新版本。
- 複製檔案（原檔還在、兩個檔有同一個 `id`）：複製的那份是新工單，按「好」時拿到新的 `id`。
- 同一個檔案的兩個硬連結：同一張工單。檔案系統不提供檔案編號、分不出硬連結和複製時，Bridge 拒絕，不猜。

卡片會寫出這次認的是哪一張；認錯時用 `--update <work_order_id>` 或 `--as-new` 指定，見[開始執行 → 卡片認的是哪一張工單](./start#卡片認的是哪一張工單)。

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
