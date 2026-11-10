# 指令

本頁整理 `review-bridge <指令> --help` 的實際輸出，各段保留原文與選項。供 agent 與腳本使用的底層指令，可透過 `review-bridge --help --all` 查看，包括 `work-plan`、`work-start`、`work-status`、`work-cancel`、`wait`、`prune`、`rm`、`roles-check`。一般使用 `start` 即可完成 `work-plan` 與 `work-start` 兩個步驟。

| 指令 | 用途 |
|---|---|
| `init` | 初始化目前資料夾，設定 writer、reviewer 與專案類型。 |
| `start` | 執行工單：封存計畫、檢查 reviewer 的唯讀限制、顯示卡片，取得人工授權後開始執行。 |
| `stop` | 停止指定執行的模型程序並保留紀錄，可透過 `resume <run_id>` 重新執行該工單。 |
| `resume` | 為已停止的工單建立新的 run，保留停點與範圍；重新決定角色、模型、effort 與預算，並再次顯示卡片、要求人工授權。 |
| `clean` | 清理紀錄：不帶 run ID 時，將已結束紀錄彙整成每日檔案，並刪除超過保留期限的內容；帶 run ID 時，移除指定的已結束紀錄。執行中的工作不能清除。 |
| `status` | 顯示本機頁面、專案的執行狀態、審查佇列與資料庫連線資訊。 |
| `logs` | 查看指定 run 的日誌目錄與各檔案用途；傳入工單檔案或 `source_id` 時，按時間由新到舊列出歷次執行。 |
| `vscode` | 將 Bridge 工作加入專案的 `.vscode/tasks.json`；使用 `--user` 則寫入所有專案共用的使用者 tasks。 |
| `up` | 在背景啟動本機頁面服務。 |
| `down` | 停止本機頁面服務。 |
| `ps` | 顯示本機頁面服務的運作狀態與網址。 |
| `watch` | 在目前終端機執行本機頁面服務，按 Ctrl+C 結束。 |
| `upgrade` | 先備份，再將專案設定升級至目前安裝的 Review Bridge 版本。 |
| `uninstall` | 先備份，再從指定資料夾移除 Review Bridge 設定。移除 Bridge 本體請使用 `npm uninstall -g review-bridge`。 |
| `doctor` | 檢查本機使用的平台 adapter，不執行工單。 |
| `backup` | 停止資料庫後備份所有專案的資料，再重新啟動。若有工作仍在執行，會拒絕備份。 |

各指令使用 `--project <folder>` 或 `--target <folder>` 指定專案，預設為目前資料夾。支援的選項見各段說明。

## init

初始化目前資料夾，設定 writer、reviewer 與專案類型。

```text
Usage: review-bridge init [options]

Set up Review Bridge in this folder: asks for the writer, the reviewer and the project type

Afterwards you start work through your agent: in Claude Code type /review-bridge start <file>; in Codex, $review-bridge start <file>. review-bridge start <file> at a terminal is for advanced use and CI.

Options:
  --target <folder>
      Set up this folder instead (string; default: the current folder)
  --writer <claude|codex>
      Writer role (string; default: your saved default, else claude)
  --reviewer <claude|codex>
      Reviewer role (string; default: your saved default, else codex)
  --profile <type|none>
      Project type; its test command becomes the tests a run executes (string; default: what detection finds, else none)
  --port <n>
      Port of the local page (number; default: 8080, or the next free port)
  --yes
      Ask nothing; use the defaults (boolean)
  --json
      Ask nothing; print the result as JSON (boolean)

1 more option(s) for tests and agents: review-bridge init --help --all
```

## start

執行工單：封存計畫、檢查 reviewer 的唯讀限制、顯示卡片，取得人工授權後開始執行。

```text
Usage: review-bridge start <file> [options]

Run a work order: plan it, check the reviewer can only read, show what you authorize, ask once, then run it

Options:
  --writer <claude|codex>
      Writer for this run only; the card shows it (string; default: the writer in bridge.json)
  --reviewer <claude|codex>
      Reviewer for this run only; the card shows it (string; default: the reviewer in bridge.json)
  --breakpoint <text>
      Where the work stops and comes back to you (string; default: after the review, asked at a terminal)
  --allow-paths <list>
      Limit the work to these paths, comma-separated (string; default: the whole project except protected files)
  --owner <name>
      Who owns the work (string; default: your OS user name)
  --work-package <id>
      Name of the work package (string; default: the work order's file name)
  --rounds <n>
      Writer rounds this work may use; comes before the work order's budget (number; default: the work order's budget, else the policy limit)
  --call-timeout <ms>
      Milliseconds each writer call may run; comes before the work order's budget (number; default: the work order's budget, else the policy limit)
  --update <work_order_id>
      Make this a new version of that work order (string; default: what Bridge finds, shown on the card)
  --as-new
      Make this a new work order (boolean)
  --yes
      The person said yes to the card; an agent adds this after showing them the card (boolean)
  --project <folder>
      The project folder (string; default: the current folder)

2 more option(s) for tests and agents: review-bridge start --help --all
```

## stop

停止指定執行的模型程序並保留紀錄，可透過 `resume <run_id>` 重新執行該工單。

```text
Usage: review-bridge stop <run_id> [options]

Pause a running work order: its model process is stopped and its records are kept (resume <run_id> carries it on)

Options:
  --project <folder>
      The project folder (string; default: the current folder)
```

## resume

為已停止的工單建立新的 run，保留停點與範圍；重新決定角色、模型、effort 與預算，並再次顯示卡片、要求人工授權。

```text
Usage: review-bridge resume <run_id> [options]

Carry on a stopped work order: a new run of the same work order with the same stop point and scope; its roles, models, effort and budget are settled again, and the same card and yes as start show them

Options:
  --writer <claude|codex>
      Writer for this run only; the card shows it (string; default: the writer in bridge.json)
  --reviewer <claude|codex>
      Reviewer for this run only; the card shows it (string; default: the reviewer in bridge.json)
  --yes
      The person said yes to the card; an agent adds this after showing them the card (boolean)
  --project <folder>
      The project folder (string; default: the current folder)

2 more option(s) for tests and agents: review-bridge resume --help --all
```

## clean

清理紀錄：不帶 run ID 時，將已結束紀錄彙整成每日檔案，並刪除超過保留期限的內容；帶 run ID 時，移除指定的已結束紀錄。執行中的工作不能清除。

```text
Usage: review-bridge clean [<run_id>] [options]

Clear records: without a run id, fold finished runs into day files and drop what is past retention; with one, remove that finished run (a running one is refused)

Options:
  --all
      Clear this project's work orders, versions, plans and contracts from your database (refused while a run is running) (boolean)
  --json
      Print the result as JSON (without a run id) (boolean)
  --project <folder>
      The project folder (string; default: the current folder)
```

## status

顯示本機頁面、專案的執行狀態、審查佇列與資料庫連線資訊。

```text
Usage: review-bridge status [options]

Show what Bridge is doing now: the page, this project's runs, the review queue, and how to look at the database

Options:
  --after <run_id>
      Show the ten runs after this one (the next page) (string; default: the newest runs)
  --json
      Print the result as JSON (boolean)
  --project <folder>
      The project folder (string; default: the current folder)
```

## logs

查看指定 run 的日誌目錄與各檔案用途；傳入工單檔案或 `source_id` 時，按時間由新到舊列出歷次執行。

```text
Usage: review-bridge logs <run_id|file> [options]

Show a run's log folder and what each file in it is; for a work order (its file or source_id), its runs newest first

Options:
  --after <run_id>
      Show the ten runs after this one (the next page) (string; default: the newest runs)
  --json
      Print the result as JSON, with the same run fields as work-status (boolean)
  --project <folder>
      The project folder (string; default: the current folder)
```

## vscode

將 Bridge 工作加入專案的 `.vscode/tasks.json`；使用 `--user` 則寫入所有專案共用的使用者 tasks。

```text
Usage: review-bridge vscode [options]

Add Bridge's tasks to VS Code's task list, in this project's .vscode/tasks.json; with --user, in your user tasks for all projects

Options:
  --user
      Write to your VS Code user tasks instead of this project (boolean)
  --target <folder>
      Write to this set-up folder instead (string; default: the current folder)
  --json
      Print the result as JSON (boolean)
```

## up

在背景啟動本機頁面服務。

```text
Usage: review-bridge up [options]

Start the local page service in the background

Options:
  --project <folder>
      The project folder (string; default: the current folder)

1 more option(s) for tests and agents: review-bridge up --help --all
```

## down

停止本機頁面服務。

```text
Usage: review-bridge down [options]

Stop the local page service

Options:
  --project <folder>
      The project folder (string; default: the current folder)
```

## ps

顯示本機頁面服務的運作狀態與網址。

```text
Usage: review-bridge ps [options]

Show whether the local page service is running, and its address

Options:
  --project <folder>
      The project folder (string; default: the current folder)
```

## watch

在目前終端機執行本機頁面服務，按 Ctrl+C 結束。

```text
Usage: review-bridge watch [options]

Run the local page in this terminal until Ctrl+C

Options:
  --port <n>
      Port of the local page (number; default: the port init chose)
  --project <folder>
      The project folder (string; default: the current folder)

1 more option(s) for tests and agents: review-bridge watch --help --all
```

## upgrade

先備份，再將專案設定升級至目前安裝的 Review Bridge 版本。

```text
Usage: review-bridge upgrade [options]

Move this folder's setup to the installed Review Bridge version, with a backup

Options:
  --target <folder>
      Upgrade this folder instead (string; default: the current folder)
  --rollback
      Undo the last upgrade from its backup (boolean)
  --plan-out <file>
      Write the plan to a file instead of asking (string)
  --plan <file>
      Apply a plan written by --plan-out (needs --approve) (string)
  --approve <sha>
      The plan's SHA-256, as printed by --plan-out (string)
  --backup-root <folder>
      Where the backup goes (string; default: Review Bridge's backup folder)
  --json
      Print the result as JSON (boolean)

1 more option(s) for tests and agents: review-bridge upgrade --help --all
```

## uninstall

先備份，再從指定資料夾移除 Review Bridge 設定。移除 Bridge 本體請使用 `npm uninstall -g review-bridge`。

```text
Usage: review-bridge uninstall [options]

Remove Review Bridge from a folder, with a backup (Review Bridge itself: npm uninstall -g review-bridge)

Options:
  --target <folder>
      The folder to remove the setup from (string; required)
  --plan-out <file>
      Write the plan to a file instead of asking (string)
  --plan <file>
      Apply a plan written by --plan-out (needs --approve) (string)
  --approve <sha>
      The plan's SHA-256, as printed by --plan-out (string)
  --backup-root <folder>
      Where the backup goes (string; default: Review Bridge's backup folder)
  --json
      Print the result as JSON (boolean)

1 more option(s) for tests and agents: review-bridge uninstall --help --all
```

## doctor

檢查本機使用的平台 adapter，不執行工單。

```text
Usage: review-bridge doctor [options]

Check which platform adapter this machine uses, without running any work

Options:
  --project <folder>
      The project folder (string; default: the current folder)

1 more option(s) for tests and agents: review-bridge doctor --help --all
```

## backup

停止資料庫後備份所有專案的資料，再重新啟動。若有工作仍在執行，會拒絕備份。

```text
Usage: review-bridge backup [options]

Copy your database, for all your projects, with the database stopped (refused while a run is running)

Options:
  --project <folder>
      The project folder (string; default: the current folder)
```
