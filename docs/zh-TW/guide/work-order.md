# 第一張工單

工單是一個 Markdown 檔，放在 `.review-bridge/work-packages/`。Bridge 只讀這個格式：它自己切區塊、把每個區塊的原文放進合約同名的欄位；模型只負責把驗收區塊切成一條條編號的條件。如果你用別的工具產生工單，這一頁就是完整的介面。

## 從範本開始

```sh
cp .review-bridge/work-packages/TEMPLATE.zh-TW.md .review-bridge/work-packages/add-readme.md
```

填你需要的區塊，用不到的整塊刪掉。`##` 小標題是給人看的，用什麼語言都可以，Bridge 不讀。

## 最小的工單

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

沒有任何驗收條件的工單會在叫模型之前停下，要你補一條可以查驗的結果。

## 完整的工單

一張把所有區塊都用上的工單，拿來對照範本。這張用的是缺陷修正的情境，所以五個 `reproduction.*` 區塊都有東西；功能類的工單把它們整塊刪掉就好。這份內容經過 Bridge 的解析，卡片上 `Priority: high (work order)`、`rounds 2 (work order)`——括號裡寫的就是值從工單來。

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

每個區塊給誰看、Bridge 怎麼用：

| 區塊 | 給誰 | Bridge 怎麼用 |
|---|---|---|
| `context`、`outcome` | writer、reviewer | 原文進合約；writer 理解為什麼做、做到什麼程度 |
| `requested_work` | writer | 要做的事本身；必填 |
| `run_plan` | Bridge | 兩個以上 run 才寫；記進合約，整張工單仍開一條 run |
| `scope_notes.include` / `exclude` / `must_keep` | writer、reviewer | reviewer 用它判定有沒有做過頭、有沒有弄壞不該動的 |
| `scope_notes.expected_locations` | writer | 只是提示，**不是授權**；授權的範圍是卡片上的 `Scope` |
| `acceptance` | reviewer、Bridge | 必填；模型切成 AC1、AC2…，結果檔逐條寫 proven／failed |
| `verification_hints` | writer、reviewer | 測試資料、既有測試名；實際跑哪個測試指令由專案類型決定 |
| `reproduction.*` | writer、reviewer | 缺陷的環境、步驟、實際、預期、頻率；功能類整塊刪 |
| `references` | writer | 連結、路徑、相關單 |
| `open_questions` | Bridge | 除了 `無` 的每一行都會讓工作停下來等你 |

## 區塊

- 第一行以 `# ` 開頭的是標題。
- 一個區塊從它的 `<!-- bridge:<key> -->` 那一行開始，到下一個標記或檔尾為止。
- key 就是合約的 17 個欄位：`context`、`outcome`、`requested_work`、`run_plan`、`scope_notes.include`、`scope_notes.exclude`、`scope_notes.must_keep`、`scope_notes.expected_locations`、`acceptance`、`verification_hints`、`reproduction.environment`、`reproduction.steps`、`reproduction.actual`、`reproduction.expected`、`reproduction.frequency`、`references`、`open_questions`。不認得的 key、或同一個 key 出現兩次，會連行號一起被拒絕。
- `open_questions`：只有 `無`（或 `none`）、或空的，就是沒有問題。其他每一行都是一個問題，工作會在叫模型之前停下，等你在工單裡回答。
- frontmatter、標題、標記、`##`／`###` 小標題和空行是結構；區塊外的其他行會以「未使用的行」保留在合約裡。

## frontmatter

frontmatter 是資料，規劃時當 YAML 讀（Astro content collections 的讀法）：第一行 `---`，到下一個只有 `---` 的行結束。每個 key 都可以不寫；沒有 frontmatter 的檔也合法。

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

- 其他 key 一律拒絕，連行號。超出範圍的值也是：不在上面清單裡的 priority 或 effort、不是正整數的 budget、超過 policy 上限的值（拒絕訊息會印上限）。
- `writer` 作用在每一次 writer 呼叫：做工、每次修正、合約翻譯。`reviewer` 作用在每一次 reviewer 呼叫：合約檢查、每次 review。沒寫的 key 從 policy 的 priority 表來。**誰當 writer、誰當 reviewer不在這裡**——那是 `bridge.json`，或單次的 `--writer`／`--reviewer`，卡片會寫出來。
- `model` 必須屬於那個角色的 CLI，否則在印卡之前就被拒絕。Bridge 只檢查名字的形狀（`claude`：別名 `fable`、`opus`、`sonnet`、`haiku`，可加 `[1m]`，或含 `claude-` 的名字；`codex`：`gpt-`、`codex-` 開頭，或 `o` 加數字開頭），**名字存不存在由那家 CLI 決定**，寫錯會在第一次呼叫時由 CLI 報錯。目前（2026-11-06 查）各家文件列的名字：

  | 角色的 CLI | 可以寫的值 | 來源 |
  |---|---|---|
  | `claude` | 別名：`fable`、`opus`、`sonnet`、`haiku`、`sonnet[1m]`、`opus[1m]`、`fable[1m]`。完整名稱：`claude-fable-5-1`、`claude-fable-5`、`claude-opus-5-5`、`claude-opus-5`、`claude-sonnet-5`、`claude-haiku-5-5`（更舊的 4.x 名稱該頁也還列著）。Claude Code 另有 `best`、`opusplan`、`default`，Bridge 的形狀檢查**不收**這三個 | [Claude Code：Model configuration](https://code.claude.com/docs/en/model-config) |
  | `codex` | `gpt-6.1-sol`、`gpt-6.1-terra`、`gpt-6-astra`、`gpt-6-luna`；舊的 `gpt-5.5` 只剩 API key 登入能用，`gpt-5.4`、`gpt-5.3-codex` 等已退役 | [Codex：Models](https://learn.chatgpt.com/docs/models) |

  不寫 `model`（或寫 `null`）就是那家 CLI 當下的預設模型，結果檔會記 `model: null`。名字會隨兩家改版變動，以上面兩個連結當下的內容為準；`claude --help` 與 `codex --help` 也查得到。自訂 Codex provider 的模型寫在 Codex 自己的設定裡，這裡不寫 `model`。
- `effort` 只收 `low`、`medium`、`high` 三個值，兩個角色都一樣。Claude Code 自己的 `--effort` 還有 `xhigh`、`max`，Codex 的介面還有 Extra High、Max、Ultra，Bridge 這一版不開放。
- 頂層 `effort` 仍然認，當成 `writer.effort`；兩個都寫會被拒絕。
- 每個值照固定順序決定：終端機旗標（`--rounds`、`--call-timeout`）→ 工單 → policy 的 priority 表（effort 與 model）→ policy 的 limits。計畫記下每個值和它來自哪一層（`cli`、`work_order`、`priority`、`config`），卡片兩個都印。
- `run_timeout` 是整條 run 的時間上限（預設 6 小時），像 GitHub Actions job 的 `timeout-minutes`。到時的 run 以 `timed_out` 收掉，原因 `run_timeout`；每次呼叫都被裁到剩下的時間。

## 執行計畫（run plan）

只有一件工作要拆成兩個以上的 run 才需要。每一行 `### ` 開一個 run，名字就是那行的文字；run 裡四個固定 key 當 YAML 讀，其他行是那個 run 的工作：

```markdown
<!-- bridge:run_plan -->
## 執行計畫
### RUN A
把樹種上。
- effort: low
- acceptance:
  - 地圖上看得到樹。

### RUN B
加購物車。
- depends_on: RUN A
- budget: { rounds: 1, call_timeout: 600000 }
- acceptance:
  - 購物車可以用方向鍵開。
```

- `effort`、`budget` 的值和 frontmatter 相同。`depends_on` 是一個 run 名字或清單 `[RUN A, RUN B]`；指到不存在的 run、或繞成圈，會被拒絕。
- `acceptance` 底下縱排的行是這個 run 自己的條件；工單的 `acceptance` 區塊是跨 run 的結果。只有一個 run 的執行計畫會被拒絕。
- Bridge 把執行計畫記進合約；**整張工單仍然只開一條 run**。

## 下一步

[開工](./start)。
