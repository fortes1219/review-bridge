# 開工

開工只有一個動作：`start <工單檔>`。你可以從 agent、VS Code 或終端機叫它；三條路跑的是同一個指令，差別只在**那個 y 在哪裡按**。

## 在 Claude Code 或 Codex 裡（主要入口）

Claude Code 裡打：

```text
/review-bridge start .review-bridge/work-packages/add-readme.md
```

Codex 裡同一件事是 `$review-bridge start .review-bridge/work-packages/add-readme.md`。

agent 會跑 `start`。Bridge 把工單連同範圍、預算、驗證指令封成一份計畫，每個頁面 session 檢查一次 reviewer 寫不了檔，印一張卡片說明你要授權的是什麼，然後停在 `Needs authorization`。agent 要把卡片**一字不改**貼給你、問「Start this work?」；你說好，它才帶 `--yes` 再跑一次同樣的指令。你的這一聲好是唯一的授權，紀錄會寫它是透過 agent 來的（`authorized_via: agent`）。

`/review-bridge` 有四個動作，和終端機的指令一樣：`start <file>`、`stop <run_id>`、`resume <run_id>`、`clean [<run_id>]`。

## 在 VS Code 裡

Bridge 的指令可以是 VS Code tasks：Quick Open 打 `task review-bridge`，或 `Terminal → Run Task`。六條：`review-bridge: start`、`stop`、`resume`、`clean`、`status`、`logs`。`start` 對編輯器裡開著的檔跑；其他的會問你 run id 或檔名。它們在整合終端機裡跑同樣的指令，卡片的 y 也在那裡按。

| 裝在哪 | 怎麼裝 | 誰看得到 |
|---|---|---|
| 這個專案的 `.vscode/tasks.json` | `init` 最後一題答 y，或跑 `review-bridge vscode` | 這個專案 |
| 你的使用者 tasks（`Tasks: Open User Tasks`） | `review-bridge vscode --user` | 你所有的專案 |

`.vscode/tasks.json` 進不進 Git 是你的事：Bridge 不加、也不排除它。在它 commit 或 ignore 之前 Git 會把它算成改動，run 的結果會說 commit 有未提交的改動。檔案裡只有 label 以 `review-bridge:` 開頭的 task、id 以 `review-bridge-` 開頭的 input 是 Bridge 的，其他內容、註解、排版一字不動；`uninstall` 把它們拿掉，檔裡沒別的東西才刪檔。

使用者 tasks 是 VS Code 預設 profile 的那份。自己有 tasks 的 profile、VS Code Insiders、VSCodium、可攜版放在別處，那些就在專案裡用 `review-bridge vscode`。多資料夾的 workspace 裡，使用者 task 在第一個資料夾跑，不一定是放工單的那個。

## 在終端機（進階用法與 CI）

```sh
review-bridge start .review-bridge/work-packages/add-readme.md
```

終端機的 `start` 會先問工作要在哪裡停下來交回給你（預設 review 之後），印卡片，自己問 `Start this work? [y/N]`。

| 你要 | 指令 |
|---|---|
| 開一張工單 | `review-bridge start <file>` |
| 暫停（紀錄保留） | `review-bridge stop <run_id>` |
| 接著做 | `review-bridge resume <run_id>` |
| 清掉做完的紀錄 | `review-bridge clean [<run_id>]` |

`review-bridge status` 印正在跑的 run 和它們的 run id。

## 卡片

不論從哪裡開工，你按 y 之前看到的是同一張卡。這是真實輸出（fake CLI、Linux）：

```text
Work order:   .review-bridge/work-packages/add-readme.md
              New work order "幫專案補一份 README"
Stops:        after the review
Scope:        the whole project except protected files (23 patterns)
Tests:        not configured (no test rule matched; the work starts without tests)
Priority:     medium (config)
Writer:       claude (config), model the CLI's default (priority table), effort medium (priority table)
Reviewer:     codex (config), model the CLI's default (priority table), effort medium (priority table)
Reviewer MCP: none
Budget:       tokens 4000000 (config), tokens_per_call 1500000 (config), call_timeout 900000 (config), test_timeout 600000 (config), run_timeout 21600000 (config), rounds 2 (config)
Contract:     up to 2 work-order translation(s) by the writer (claude) and 2 check(s) by the reviewer (codex), 15 minute(s) per call
Valid until:  2026-11-06T23:31:11.999Z

The work order, as it will be sealed:
  │ ---
  │ source_id: DOC-1
  │ ---
  │ # 幫專案補一份 README
  │ …

Needs authorization. If the person says yes, run again: review-bridge start .review-bridge/work-packages/add-readme.md --yes
```

- 每個值後面的括號是它從哪一層來的：`cli`、`work_order`、`priority`、`config`。
- 卡片下半段是**將被封存的工單原文**。你授權的是這一份；之後再改檔，要重新 `start` 才算。
- `Valid until` 是這張卡的有效期（24 小時）；過期就得再印一張。
- `Reviewer MCP` 寫 reviewer 拿到了哪些 MCP 伺服器；預設 `none`。

## 跑的時候

按 y 之後每一步印一行（終端機上等待時有轉圈）：

```text
  Writer (claude) turns the work order into a contract; reviewer (codex) checks it
  Contract sealed
  Writer working (call 1 of 2)
  Tests: not configured for this project
  Reviewer checking the work
Delivered: no tests configured, reviewer passed
Result file: /…/.review-bridge/results/add-readme/DOC-1 add-readme 2026-11-06 07-31-29 success.md
Tokens: writer 153246, reviewer 60400
```

順序固定：writer 先把工單翻成合約、reviewer 檢查合約；合約封存；writer 做工（最多 `rounds` 回）；每回做完 Bridge **自己**跑專案的測試指令；reviewer 看結果給判定；交付。

## 停、接、清

- `stop <run_id>`：停掉模型程序，紀錄保留。
- `resume <run_id>`：同一張工單開一條**新的** run，停點與範圍不變；角色、模型、effort、預算重新決定，印同樣的卡、要同樣的 y。
- `clean`（不帶 run id）：把做完的 run 收進日檔、丟掉過保留期的；`clean <run_id>` 移除那條做完的 run（正在跑的會被拒絕）。

Bridge 從頭到尾**不 commit、不 push、不部署**。結果檔最後一段會列出改了哪些檔，你自己看、自己 commit。接著看[結果、紀錄與資料庫](./results)。
