# 開始執行

使用 `start <工單檔>` 開始執行工單。你可以透過 AI 代理、VS Code 或終端機操作，三種入口使用相同指令，差別在於**在哪裡確認卡片並授權**。

## 在 Claude Code 或 Codex 裡（主要入口）

在 Claude Code 輸入：

```text
/review-bridge start .review-bridge/work-packages/add-readme.md
```

在 Codex 則輸入 `$review-bridge start .review-bridge/work-packages/add-readme.md`。

代理會先執行 `start`。Bridge 用程式把工單當表單讀過、把各區塊原文抄進合約，將工單、範圍、預算與測試指令封存成計畫，接著顯示授權卡片，並停在「需要授權」。到這裡為止沒有任何模型呼叫。

代理必須將卡片**原文完整呈現**給你，問你要不要開始。只有在你同意後，才能加上 `--yes` 再次執行相同指令。這次確認就是執行授權，紀錄會標示授權由代理轉達（`authorized_via: agent`）。

`--yes` 只照**最近一張顯示過的卡片**開工。下列情況一律拒絕，不授權、不開工，訊息會附上下一步該跑的指令：沒有顯示過卡片、工單內容或指令選項在卡片之後改過、卡片已過有效期限（24 小時）、這張卡已經開過工。

`/review-bridge` 有四個動作，和終端機的指令一樣：`start <file>`、`stop <run_id>`、`resume <run_id>`、`clean [<run_id>]`。

## 在 VS Code 裡

Bridge 提供六項 VS Code 工作（tasks）：`review-bridge: start`、`stop`、`resume`、`clean`、`status`、`logs`。在 Quick Open 輸入 `task review-bridge`，或選擇 `Terminal → Run Task` 即可執行。

`start` 會使用編輯器目前開啟的檔案；其他工作會提示你輸入 run ID 或檔名。指令會在整合終端機執行，你也在該處確認授權卡片。

| 安裝位置 | 安裝方式 | 適用範圍 |
|---|---|---|
| 這個專案的 `.vscode/tasks.json` | `init` 最後一題答 y，或跑 `npx review-bridge vscode` | 這個專案 |
| 你的使用者 tasks（`Tasks: Open User Tasks`） | `npx review-bridge vscode --user` | 你所有的專案 |

是否將 `.vscode/tasks.json` 納入 Git，由你決定，Bridge 不會自動加入或排除。在提交或忽略之前，Git 會將它列為改動，執行結果也會標示存在未提交的改動。

Bridge 僅管理 label 以 `review-bridge:` 開頭的 task，以及 id 以 `review-bridge-` 開頭的 input；其他內容、註解與排版都會保留。`uninstall` 會移除這些項目，僅在檔案不含其他內容時刪除檔案。

使用者 tasks 會寫入 VS Code 的預設 profile。其他含有獨立 tasks 的 profile、VS Code Insiders、VSCodium 與可攜版使用不同位置，請改在專案中執行 `npx review-bridge vscode`。在多資料夾工作區中，使用者 task 會從第一個資料夾執行，該資料夾未必是工單所在的專案。

## 在終端機（進階用法與 CI）

```sh
npx review-bridge start .review-bridge/work-packages/add-readme.md
```

在終端機執行 `start` 時，Bridge 會先詢問交回人工處理的停點（預設為審查完成後），再顯示授權卡片，詢問「開始這份工作嗎？[y/N]」。答 n 不會開工，也不會授權任何東西。

| 操作 | 指令 |
|---|---|
| 執行工單 | `npx review-bridge start <file>` |
| 暫停（紀錄保留） | `npx review-bridge stop <run_id>` |
| 重新執行已停止的工單 | `npx review-bridge resume <run_id>` |
| 清理已結束的紀錄 | `npx review-bridge clean [<run_id>]` |

使用 `npx review-bridge status` 可查看正在執行的工作及其 run ID。上表用 npm 的 `npx`；用 pnpm、Yarn、Bun 時，Bridge 印出的指令會改成 `pnpm dlx`、`yarn dlx`、`bun x`，見[指令 → 用哪個套件管理器執行](../reference/cli#用哪個套件管理器執行)。

## 卡片

三種入口會顯示相同格式的授權卡片。以下輸出取自 0.3.0-rc.3：用模擬 CLI、前一頁的 README 工單、`bridge.json` 的 `locale: zh-TW`，在 Windows 跑一次（run `0be8174d-7b4e-4063-908f-199292f759c2`，2026-11-10）。這裡是代理入口的樣子：沒有終端機可以問，所以停在「需要授權」。路徑前段改寫成 `<log 目錄>`，並拿掉測試用的 `--fake-cli` 旗標；其餘照原樣：

```text
Plan written to <log 目錄>\bdbe7d5a-c1de-4d00-ad6e-59ed13cf8d0f\0be8174d-7b4e-4063-908f-199292f759c2\add-readme.plan.json

工單：.review-bridge/work-packages/add-readme.md
      新工單「幫專案補一份 README」
停在：after the review
範圍：整個專案，扣掉受保護的檔案（23 條規則）
測試：沒有設定（沒有符合的測試規則，這次工作不跑測試）
優先度：medium（設定檔）
Writer：claude（設定檔），模型 CLI 預設（priority 表），effort medium（priority 表）
Reviewer：codex（設定檔），模型 CLI 預設（priority 表），effort medium（priority 表）
Reviewer MCP：無
預算：tokens 4000000（設定檔）、tokens_per_call 1500000（設定檔）、call_timeout 900000（設定檔）、test_timeout 600000（設定檔）、run_timeout 21600000（設定檔）、rounds 2（設定檔）
合約：sha256 c666cd9a479796f426873f72595bb8d441f5bc322692c253b35604516f0946b4，從驗收清單切出 2 條條件
有效期限：2026-11-11T03:26:21.429Z

封存的工單原文：
  │ ---
  │ source_id: DOC-1
  │ ---
  │ # 幫專案補一份 README
  │
  │ <!-- bridge:requested_work -->
  │ ## 要做的事
  │ 在專案根目錄新增 README.md，說明專案用途與啟動方式。
  │
  │ <!-- bridge:acceptance -->
  │ ## 驗收
  │ 1. 根目錄有 README.md，第一行是專案名稱。
  │ 2. README 裡有一段「如何啟動」。
  │
  │ <!-- bridge:open_questions -->
  │ ## 待決問題
  │ 無

需要授權。人說好之後，再執行：npx review-bridge start .review-bridge/work-packages/add-readme.md --yes
```

- 每個值後方的括號標示設定來源：參數、工單、priority 表、設定檔。
- `合約` 行是封存合約的 SHA-256，以及 Bridge 用程式從驗收清單切出幾條條件。合約由程式照區塊原文抄錄，不經過模型，結果檔的 token 表會把這一步記為 0。
- 卡片下半部列出**將封存的工單原文**，授權僅適用於這份內容。之後若修改工單，必須重新執行 `start` 才會採用新內容。
- `有效期限` 是卡片的到期時間（24 小時），目前以 UTC 顯示；過期後須重新產生卡片。
- `Reviewer MCP` 列出 reviewer 可使用的 MCP 伺服器，預設為「無」。
- 第一行「工單」底下那行說明這次授權的是哪一張工單，見下一節。
- 卡片和步驟之前的幾行（`Plan written to`、`Reviewer read-only check`）以及步驟行目前只有英文。

## 卡片認的是哪一張工單

你第一次按「好」時，Bridge 會把工單的 `id` 寫進工單檔開頭的 frontmatter，並在資料庫記下這一版。這行之後不要刪；它不算進合約的 SHA-256。開工後的工單檔長這樣：

```markdown
---
id: 49c04e16-b2da-4d0d-b1a5-64b4ad02a6e7
source_id: DOC-1
---
# 幫專案補一份 README
```

之後 Bridge 靠這個 `id` 認工單，卡片「工單」行底下會寫出它的判斷：

| 卡片上的字 | 什麼時候 |
|---|---|
| 新工單「…」 | 檔案裡沒有 `id`，或資料庫不認得這個 `id` |
| 更新「…」：仍是第 N 版，執行設定變了 | 內容沒變，再開一次工（例如換了角色或預算） |
| 更新「…」：第 N 版 → 第 N+1 版，改了 X 行 | 你改了工單內容 |
| 更新「…」（原本在 …） | 你把檔案改名或搬到別的資料夾；仍是同一張 |
| 是 … 的複製，記為新工單「…」 | 你複製了另一張工單的檔案，原檔仍在、仍有同一個 `id`；複製的那份按「好」時會拿到新的 `id` |

同一個檔案的兩個硬連結算同一張工單，不是複製。Bridge 用檔案系統的檔案編號判斷兩個路徑是不是同一個檔；檔案系統不提供檔案編號時，Bridge 分不出硬連結和複製，會拒絕，不猜。

卡片判斷得不對時，用參數指定，Bridge 會照你指定的印一張新卡片：

- `--update <work_order_id>`：把這個檔當成那張工單的新版本。例如你把舊工單的內容貼到新檔、想延續原本的歷史。`work_order_id` 就是那張工單檔 frontmatter 裡的 `id`。
- `--as-new`：把這個檔當成一張新工單，即使檔案裡有別張工單的 `id`。

兩個參數只能擇一，而且只用在單一工單檔，不能用在資料夾。改了內容重新開工時，若同一張工單的舊版本還在跑，卡片會先告訴你，開工後舊版本會停下（結論 `cancelled`，原因 `superseded`）。

## 一次跑一整個資料夾

把多張工單放進 `.review-bridge/work-packages/` 底下的一個子資料夾，`start` 時傳入資料夾：

```sh
npx review-bridge start .review-bridge/work-packages/demo/
```

- 依檔名順序執行，檔名開頭可用 `01-`、`02_` 一類的序號；沒有序號的排在最後。
- Bridge 先檢查整個資料夾的每一張工單，再顯示一張卡片，列出每個檔與各自的合約 SHA-256，不列內容。一個「好」授權整條，每張工單各有自己的 run、授權紀錄與合約。
- 一張工單沒做成，不會擋下一張；provider 登出、額度用完、`stop` 或 Ctrl+C 會停下整條。
- 再對同一個資料夾 `start` 時，已記為交付的工單會略過。
- 進度看 `status`；跑完會印一張總表，結果檔放在 `results/<資料夾>/<工單>/`。
- 資料夾的工單在專案資料夾原地執行。同時跑兩個資料夾，它們會共用同一個資料夾；請等一個跑完再開下一個。

## 執行過程

你說好之後，Bridge 會逐步顯示執行進度。接續上面那張卡片，按「好」之後的輸出如下（同一次 run；結果檔路徑前段改寫成 `…\my-app`）：

```text
Reviewer read-only check: not needed with the fake CLI (no model is called)

  Writer working (call 1 of 2)
  Tests: not configured for this project
  Reviewer checking the work
已交付：沒有設定測試，reviewer 通過
結果檔：…\my-app\.review-bridge\results\add-readme\DOC-1 add-readme 2026-11-10 11-26-24 success.md
token：writer 153246，reviewer 60400
```

順序固定：

1. **確認 reviewer 只能讀。** 用真的 CLI 時，Bridge 會先用一次模型呼叫確認 reviewer 寫不了檔，印出 `Reviewer read-only check: passed`；同一個本機頁面工作階段裡只檢查一次。檢查沒過就不開工。模擬 CLI 不呼叫模型，所以印的是 `not needed with the fake CLI`。
2. **更新專案的 graph。** 只重讀 Git 回報有改動的檔，見下一節。
3. **writer 做工**，最多 `rounds` 輪。
4. **Bridge 自己跑專案的測試指令。** 專案沒有測試指令時照常執行，卡片、紀錄與結果檔都寫「沒有設定」。
5. **reviewer 逐條判定驗收條件**，Bridge 再逐條決定成立與否；沒過而輪數還沒用完，就回到第 3 步修正。
6. Bridge 寫出結果檔，最後三行是結論、結果檔路徑與 token。最後一行沒有 run ID，要查 run ID 請用 `status`。

工作途中若 Bridge 的資料庫沒有回應，run 會停下，原因記為 `database_unavailable`，之後不再呼叫模型；終端機印「已停下：Bridge 的資料庫無法使用」。這段期間寫在檔案裡的紀錄，下一個打開資料庫的指令會補寫回去。資料庫恢復後，重新 `start` 即可。

## 專案的 graph

`init` 會把專案的程式碼讀成一張 graph：哪裡定義了什麼函式、類別、型別，誰引用它，哪個檔 import 了哪個檔。支援 JavaScript、TypeScript、`.vue` 的 script 區塊、Python、Go、Rust、Java、Kotlin、C++ 與 C#；JavaScript 與 TypeScript 以外的語言，第一次用到時會透過 npm 把 parser 裝到 Bridge 的資料目錄。npm 與 pnpm workspace 裡，graph 涵蓋這個套件和它依賴的 workspace 套件。

- graph 存在你的資料庫裡，不在專案裡寫任何檔。
- `init` 的輸出結尾會列出讀了幾個檔、幾個定義、幾個引用、幾個 import；parser 讀不懂或沒有 parser 的檔會逐一列出，標為不完整，不會靜默少算。
- 每次 `start` 只更新 Git 回報有改動的檔。更新失敗時，`start` 會說「專案的 graph 沒有更新」，writer 與 reviewer 查的是更新前的 graph，結果檔也會寫明。要重讀整個專案，執行 `npx review-bridge graph`。
- writer 開工前，Bridge 依工單的文字查 graph，把查到的結果放進 writer 的 prompt；reviewer 審查時也一樣。結果檔 token 表的「graph 查詢」列是這些查詢的次數與放進 prompt 的估計 token，已算在 writer 與 reviewer 的 input 裡。
- writer 與 reviewer 也可以自己透過 Bridge 的唯讀 MCP 伺服器 `review-bridge-graph` 查詢。不過在這一版量過的 run 裡，兩個角色都沒有主動呼叫這些工具。

## 停止、恢復與清理

- `stop <run_id>`：停止模型程序，保留執行紀錄。
- `resume <run_id>`：為同一張工單建立**新的執行**，保留原本的停點與範圍。角色、模型、effort 與預算會重新決定，並再次顯示卡片，要求人工授權。
- `clean`（不帶 run id）：將已結束的執行紀錄彙整成每日檔案，並刪除超過保留期限的紀錄；`clean <run_id>` 則移除指定的已結束紀錄，不接受仍在執行中的工作。`clean --all` 清除這個專案在資料庫裡的所有紀錄；清除後這個專案的 ID 不再使用，要再用 Bridge，先 `uninstall` 再 `init`。

在終端機單張 `start` 時按 Ctrl+C，指令會結束，但 run 可能還在跑。請用 `npx review-bridge status` 找到它，再 `npx review-bridge stop <run_id>`。

## 資料庫與本機頁面：up、down、ps、watch

資料庫在第一次使用時建立並啟動，關掉終端機或 VS Code 後仍持續運作。要自己控制時：

| 指令 | 做什麼 |
|---|---|
| `npx review-bridge up` | 在背景啟動資料庫，再啟動本機頁面服務 |
| `npx review-bridge down` | 依相反順序停止：先停頁面，再停資料庫。任何專案有工作在跑時，列出那些 run 並拒絕 |
| `npx review-bridge ps` | 顯示本機頁面服務是否在跑，以及網址 |
| `npx review-bridge watch` | 在目前終端機執行本機頁面，按 Ctrl+C 結束 |

`down` 之後（同一次 run 的輸出）：

```text
$ npx review-bridge down
頁面已停止。
資料庫已停止。
$ npx review-bridge status
網頁：沒在跑；用 npx review-bridge up 啟動
資料庫：已停止；npx review-bridge up 會啟動資料庫，下一次 start 也會。
```

`status` 只報告資料庫的狀態，不會順便啟動資料庫。

Bridge **不會自動 commit、push 或部署**。結果檔會列出修改的檔案，由你檢查成果並決定是否提交。接著可閱讀[結果、紀錄與資料庫](./results)。
