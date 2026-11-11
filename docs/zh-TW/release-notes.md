# 發行紀錄

格式參考 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)，版本號依 [Semantic Versioning](https://semver.org/lang/zh-TW/)。英文原文在 repo 的 `CHANGELOG.md`。

## 未發行

### 變更

- **Linux x64 成為可選用的平台。** Linux x64 現在可以原生開工，和 Apple Silicon macOS 一樣：可以選用，但我們自己還沒驗證。第一位使用者在 Ubuntu 26.04 用真的 Claude Code 擔任 writer 與 reviewer，把一張工單跑到交付：reviewer 唯讀檢查通過、Bridge 跑了專案的測試、reviewer 判通過。Codex 在 Linux 上還沒有執行紀錄。升級 Bridge 之後，先執行 `npx review-bridge down`，再執行 `npx review-bridge up`：本機頁面服務只在啟動時讀一次這個平台能不能呼叫模型。

### 修正

- **同一個 run 同時交付時，不再因 `Unexpected end of JSON input` 失敗。** 兩個程序同時交付同一個 run 時（例如 `stop` 和正在收尾的 `start`），其中一個可能剛好在 run lock 已建立、內容還沒寫入的那一刻讀到它，因此直接失敗，也不重試。現在讀不出內容的鎖檔算有人拿著，交付會等一下再重試。程序在寫入前就結束而留下的空鎖檔，超過 `lock_stale`（30 秒）後會被接管，和心跳過期的鎖一樣。
- **Windows 上，兩個指令同時啟動資料庫時，後到的不再被叫去重開機。** 資料庫是所有專案共用的一個，兩個指令可能同時啟動它：兩個專案各執行一次 `start`，或 `up` 和 `start` 同時執行。在 Windows 上，先到的指令的資料庫還在啟動時，後到的可能直接停下，說「上次沒有正常關閉……請重開機後再執行一次」。現在後到的會在自己的啟動期限內（60 秒）等那個資料庫起來，然後一起用它。到期限時檔案仍被占用、也沒有資料庫在跑，才報告是上次沒有正常關閉留下的程序，所以這個報告會在期限到了之後才出現，不再是立刻。
- **頁面服務已經起來，不再被報成沒有重新啟動。** `upgrade`、`upgrade --rollback` 或取消 `uninstall` 之後，Bridge 用 `up` 重新啟動頁面服務，`up` 會等到頁面有回應才結束。Bridge 之前還會再問頁面一次；只要那一次沒有回「在跑」，原本成功的重啟就被判成失敗，報「did not restart: up returned 0 but the service is not answering」：維護標記留著，Bridge 繼續被擋，要再執行一次指令。現在 `up` 成功就算起來了。`up` 失敗時，訊息會保留它說的、頁面為什麼沒有回應。

## 0.3.0-rc.3（2026-11-10）

第一個發行版。

### 新增

- **用套件管理器執行。** 用 `npx review-bridge init` 設定專案，不必全域安裝；用 `npm i -g review-bridge` 全域安裝也可以。Bridge 印出的指令照啟動它的套件管理器寫：npm 或看不出是哪一個時是 `npx review-bridge …`，其他是 `pnpm dlx review-bridge …`、`yarn dlx review-bridge …`、`bun x review-bridge …`。指令不帶版本號，用的是發行的 `latest`；有全域安裝時 `npx` 會用那一份。這套寫法用在設定說明、`status` 輸出、建議的下一步指令、代理入口與 VS Code 工作；只有 `--help` 用裸的程式名稱。需要 Node.js 22.8 以上。
- **互動式設定。** 照 create-vite 的做法，`init` 依序問 writer、reviewer、專案類型，以及要不要加 VS Code 工作，每題都有預設值；問完就設定目前的資料夾，每一步印一行，最後印出接下來的指令。沒有額外的確認，也不先顯示計畫。用參數直接給答案；沒有互動式終端機時採用預設值。專案類型決定測試指令，可以是 `none`。
- **專案裡只留一個資料夾。** 除了你選擇加入的 VS Code 工作，`init` 只寫 `.review-bridge/`：設定、規則與工單範本。資料夾自帶只有 `*` 的 `.gitignore`，之後才 `git init` 也不會進 Git。設定完 `git status` 是乾淨的，不改專案的 `.claude/`、`AGENTS.md`、`CLAUDE.md`。
- **使用者層級的代理入口。** `init` 為 Claude Code 安裝 `~/.claude/commands/review-bridge.md`（遵守 `CLAUDE_CONFIG_DIR`），為 Codex 安裝 `~/.agents/skills/review-bridge/SKILL.md`。`/review-bridge` 與 `$review-bridge` 教代理四個動作：start、stop、resume、clean，並要求人同意。那些位置已有使用者自己的檔案時不碰。最後一個已設定的專案解除安裝時，移除 Bridge 的入口，除非你改過它們。
- **用來找程式碼的專案 graph。** `init` 把 JavaScript、TypeScript、`.vue` 的 script 區塊、Python、Go、Rust、Java、Kotlin、C++ 與 C# 的定義、名稱引用與 import 目標記進你的資料庫。進度輸出最後列出檔案、定義、引用與 import 的數量，以及沒能完整解析的檔。不在專案寫 graph 檔。JavaScript 與 TypeScript 以外的 parser 第一次用到時透過 npm 裝進 Bridge 的資料目錄。npm 與 pnpm workspace 裡，graph 涵蓋這個套件和它依賴的 workspace 套件。`start` 只更新 Git 回報有改動的檔；`npx review-bridge graph` 重建整份 graph。writer 與 reviewer 可以透過 Bridge 的唯讀 MCP 伺服器 `review-bridge-graph` 查詢。
- **不呼叫模型的合約。** Bridge 把工單當表單檢查，把每個標記區塊原樣抄進合約；結果檔的 token 表把這一步記為 0。驗收清單用 markdown-it 切，和 VitePress 相同。工單必須有要做的事（`requested_work` 或 `run_plan`）與驗收清單。缺必填內容、不是清單項目的行（例如「一、」「（1）」）、還沒回答的待決問題，都會讓 `start` 在卡片前停下。Bridge 列出問題，並把缺的必填區塊標記與標題補回檔案最後面，不改既有內容。`# ` 標題可以不寫；沒有時標題是 `untitled`。
- **各角色的模型與 effort。** 工單 frontmatter 接受 `writer:` 與 `reviewer:` 區塊，含 `model` 與 `effort`，蓋過 policy 的 priority 表。頂層 `effort` 套用到 writer；兩種寫法同時出現會被拒絕。兩個角色預設都是 `model: null`，用 CLI 自己的預設。與該角色 CLI 不符的模型名稱在卡片前就被拒絕。
- **一張卡、一次同意就開工。** `npx review-bridge start <file>` 規劃工作並顯示指明合約的卡片。在終端機會問「開始這份工作嗎？[y/N]」，每一步印一行。沒有互動式終端機時，`start` 與 `resume` 顯示卡片後停在「需要授權」；你同意後，代理加上 `--yes` 重跑。授權紀錄寫入 `authorized_via`（`terminal` 或 `agent`）與封存的工單原文 SHA-256。`--yes` 用的是之前顯示過那張卡的計畫；沒有顯示過卡片、工單或選項改過、卡片過了有效期限、卡片已經開過工時，一律拒絕，不授權、不開工，每次拒絕都附上下一步該跑的指令。
- **工單身分與版本歷史。** 第一次同意時，Bridge 把 `id` 寫進工單的 frontmatter，並在資料庫記下各版本。改名或搬移檔案仍是同一張；改內容是新版本。帶著別的檔 ID 的複製會拿到自己的 ID；同一個檔的兩個硬連結仍是一張工單。不提供檔案編號的檔案系統會被拒絕。檔名可以用任何文字的字母、數字與組合記號，加上 `.`、`_`、`-` 與單一空白，最長 80 個字元、180 位元組；比對與存檔前正規化成 NFC。卡片寫出這次授權的是哪一張工單；`--update <work_order_id>` 與 `--as-new` 讓你指定別的判斷。
- **依序執行多張工單。** `start <資料夾>` 把 `.review-bridge/work-packages/` 底下的子資料夾當成一條線：依檔名順序執行，可用 `01-`、`02_` 一類的序號，沒有序號的排最後。Bridge 先檢查整個資料夾，再顯示一張列出各檔、不列內容的卡片。一次同意授權整條，每張工單各有自己的 run、授權紀錄與合約。一張沒做成不會擋下一張；provider 登出、額度用完、`stop` 或 Ctrl+C 會停下整條。再次開工時，已記為交付的工單會略過。`status` 顯示進度，最後一張總表整理結果，檔案放在 `results/<資料夾>/<工單>/`。
- **停止、恢復與清理。** `stop <run_id>` 暫停一次執行並保留紀錄。`resume <run_id>` 以相同的停點與範圍開新的執行。`clean [<run_id>]` 清理已結束的紀錄；`clean --all` 清掉這個專案在資料庫裡的紀錄。
- **兩種 provider 都能擔任兩種角色。** writer 與 reviewer 支援 `claude` 與 `codex` 的四種配對，各自獨立工作階段。角色來自 `bridge.json`，或 `start`、`resume`、`work-plan` 的單次 `--writer`、`--reviewer`。卡片顯示選定的角色，該次執行中不會變。每筆執行紀錄與結果檔開頭都記下兩個角色的 provider、模型與 effort。
- **reviewer 唯讀檢查。** 模型開始做工之前，Bridge 先確認 reviewer 的限制。Codex：它的作業系統沙箱必須擋下一次真的寫入；檢查也認得中文版 Windows 上 PowerShell 的拒絕訊息。Claude Code：要求一個 plan mode 工作階段寫一個哨兵檔，這個工作階段的工具只有 `Read`、`Grep`、`Glob`，以及 Bridge 的唯讀 graph 伺服器與 policy 放行的伺服器（和每次審查相同）；只有檔案不存在、CLI 正常結束、`init` 事件確認預期的工作階段設定時才算通過。
- **隔離個人連接器。** 每次 Claude Code 呼叫都用 `--strict-mcp-config`；只有 writer 拿到專案的 `.mcp.json`。每次 Codex 呼叫都用 `--disable apps --disable plugins`，並停用 `codex mcp list` 列出的每個伺服器；讀不到清單就不開工。policy 的 `reviewer.mcp_allow`（預設為空）把指名的伺服器交給 reviewer，不另加限制。卡片、執行紀錄與結果檔列出提供了哪些伺服器。
- **由 Bridge 執行驗證。** 每次 writer 呼叫後，Bridge 自己跑專案的測試指令。沒有測試指令的專案照樣能跑，卡片、紀錄與結果檔寫明測試沒有設定。專案有測試指令時，writer 回報 `blocked` 但沒提問，仍會進到 Bridge 的測試與審查；沒有測試指令時，這種情況會停下交回給你。
- **writer 的 token 預算。** `tokens` 與 `tokens_per_call` 只算 writer，不含 cache read（結果檔另外列出）。reviewer 的用量會記錄，但不計入 token 預算。
- **附依據的結果檔。** 每次執行在 `results/<工單>/` 產生一份結果檔，說明決定了什麼、為什麼。需要你決定的結果附上 writer 自己的說法。「改了哪些檔」分開列出 Git 的改動、writer 未經核對的回報，以及執行前就存在的改動。
- **PostgreSQL 裡的稽核軌跡。** 每位使用者一份內嵌的 PostgreSQL 18，跨專案保存工單、版本、卡片、授權、合約、執行、依序編號的事件、reviewer 判定、Bridge 的驗收決定與交付；第一次使用時建立。每次狀態改變和它的事件在同一個交易提交。`clean <run_id>` 一起刪掉該次執行與附屬紀錄，但保留已用掉的授權，讓卡片不能重用。`.review-bridge/` 底下的檔案與 log 都是副本。
- **資料庫的啟停。** 關掉終端機或 VS Code 後資料庫仍在跑。`up` 先啟動資料庫、再啟動本機頁面；`down` 依相反順序停止，照 `docker compose down` 停下 `up` 所啟動的東西的慣例。任何專案有執行中的工作時，`down` 列出那些 run 並拒絕。`status` 報告資料庫狀態，不會啟動資料庫。資料目錄不見、讀不到或內容不對時，印出路徑並以結束碼 4 結束，和 `pg_ctl status` 相同。啟動失敗會說明 `pg_ctl` 等了多久與伺服器最新的訊息。啟動時不清除已死伺服器留下的檔；它的程序仍在跑時，Bridge 會說明並請你重新開機。
- **遷移前備份。** 新版要套用資料庫遷移前，第一個指令會先備份資料庫並印出備份位置；有執行中的工作時拒絕。資料庫裡有已安裝版本不認得的遷移時，Bridge 列出它們、拒絕開啟，不做任何改動。沒有執行中的工作時，可以用 `backup` 手動備份。
- **資料庫掉線就停下。** 執行途中資料庫無法使用時，該次執行以 `database_unavailable` 停下，之後不再呼叫模型。這段期間收集的紀錄，由下一個打開資料庫的指令寫回。
- **可查詢的執行狀態。** `status`、`work-status` 與 `doctor` 從資料庫讀出頁面、執行狀態、停止原因、來源檔與開始時間。結果每頁十筆；`--after <run_id>` 取下一頁，`--json` 取機器可讀的輸出。`status` 另印出主機、連接埠、資料庫、使用者與密碼檔位置，供 VS Code 的 PostgreSQL 擴充套件或 SQLTools 連線。
- **在地化的 CLI 輸出。** `init`、`status`、`up`、`down`、`ps` 與授權卡片使用專案的語言（英文或繁體中文），照 create-vue 的做法從系統偵測。
- **VS Code 工作。** 在 Quick Open 輸入 `task review-bridge`，就能執行 `start`、`stop`、`resume`、`clean`、`status`、`logs`。可在 `init` 時選擇加入專案的 `.vscode/tasks.json`、之後用 `npx review-bridge vscode` 加入，或用 `npx review-bridge vscode --user` 加到使用者層級；預設不加入專案。其他工作、註解與排版都保留；`uninstall` 只移除 Bridge 的項目。
- **Windows 編碼診斷。** PowerShell 沒有輸出 UTF-8（會讓 Codex 的中文輸出變亂碼）時，`doctor` 會說明，並給出要加進 `$PROFILE` 的那一行。
- **自動產生的指令說明。** 每個指令的 `--help` 都由指令表產生，含選項型別、預設值與說明。`--help --all` 另列出給代理與腳本用的指令，例如 `work-plan`、`work-start`。`--version` 印出版本。

### 已知限制

- Windows 上同一張卡同時有兩個 `--yes` 時，第二個可能回報檔案錯誤，而不是說卡片已用過。只會有一次執行開始。每張卡請只同意一次。
- Windows 上開啟 Git 的 `core.autocrlf` 時，只差換行字元的改動也會算進工作證明與結果檔。請在 `start` 前 commit 或 stash。
- writer 做工途中不會停下來問問題。請在 `start` 前把工單的歧義解決；`open_questions` 裡還沒回答的行會擋下開工。
- writer 可能執行或修改專案的測試，Bridge 不阻擋也不標示。結果檔裡的測試證據來自 Bridge 在每次 writer 呼叫後自己跑的測試。請檢查結果檔列出的改動檔案。
- 用 `npx` 執行時會向 npm registry 查最新版，需要網路。用 `npm i -g review-bridge` 全域安裝可以省掉這次查詢；之後 `npx review-bridge` 會用已安裝的那一份。
- 在終端機單張 `start` 時按 Ctrl+C，指令會結束，但執行可能還在跑。用 `npx review-bridge status` 找到它，再 `npx review-bridge stop <run_id>`。
- 這一版量過的執行裡，writer 與 reviewer 都沒有主動呼叫專案 graph 的工具。
- 部分給代理與腳本用的指令（包括 `work-plan`、`work-start`）的訊息還沒在地化。
- 卡片的有效期限以 UTC 顯示。
- 最後一行輸出不含 run ID。請用 `npx review-bridge status` 查詢。
- 資料夾的工作在專案資料夾原地執行。同時開兩個資料夾會共用同一個專案工作區；請等一個跑完再開下一個。
- `npx review-bridge --help` 沒有列出 `vscode`。請用 `npx review-bridge vscode --help` 看它的選項。
- 工作證明只在 Bridge 的取樣點比較專案。在兩次檢查之間改了又改回的檔不會顯示為有改動。
- 原生執行在 Windows x64 驗證過。Apple Silicon macOS 可以選用但未驗證。Linux 擋下原生執行。
- 升級到不同主版本的 PostgreSQL 需要 dump 與 restore，這一版不處理。
