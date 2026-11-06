# 指令

這一頁由 `review-bridge <指令> --help` 的實際輸出整理，每段的 `--help` 原文照貼，不另外改寫選項。`review-bridge --help --all` 另列給 agent 與腳本用的指令（`work-plan`、`work-start`、`work-status`、`work-cancel`、`wait`、`prune`、`rm`、`roles-check`；`start` 一次做完 `work-plan` 加 `work-start`）。

| 指令 | 做什麼 |
|---|---|
| `init` | 在這個資料夾設定 Review Bridge：問 writer、reviewer、專案類型。 |
| `start` | 跑一張工單：封存計畫、確認 reviewer 只能讀、印出你要授權的內容、問一次、然後跑。 |
| `stop` | 暫停一條正在跑的工單：停掉它的模型程序，紀錄保留（`resume <run_id>` 接著做）。 |
| `resume` | 接著做一條停掉的工單：同一張工單的新 run，停點與範圍相同；角色、模型、effort、預算重新決定，印同樣的卡、要同樣的 y。 |
| `clean` | 清紀錄：不帶 run id 時把做完的 run 收進日檔、丟掉過保留期的；帶 run id 時移除那條做完的 run（正在跑的拒絕）。 |
| `status` | Bridge 現在在做什麼：頁面、這個專案的 run、review 佇列、怎麼看資料庫。 |
| `logs` | 一條 run 的 log 資料夾與每個檔是什麼；給工單（檔或 `source_id`）時列它的 run，最新在上。 |
| `vscode` | 把 Bridge 的 tasks 加進 VS Code 的 task 清單：這個專案的 `.vscode/tasks.json`，或 `--user` 寫進你的使用者 tasks、所有專案都有。 |
| `up` | 在背景起本機頁面服務。 |
| `down` | 停本機頁面服務。 |
| `ps` | 本機頁面服務有沒有在跑、網址是什麼。 |
| `watch` | 在這個終端機跑本機頁面，直到 Ctrl+C。 |
| `upgrade` | 把這個資料夾的設定搬到已安裝的 Review Bridge 版本，先備份。 |
| `uninstall` | 從一個資料夾移除 Review Bridge 的設定，先備份（Bridge 本體：`npm uninstall -g review-bridge`）。 |
| `doctor` | 檢查這台機器用哪個平台 adapter，不跑任何工作。 |
| `backup` | 複製你的資料庫（所有專案），資料庫停著時做；有 run 在跑會拒絕。 |

每個指令都收 `--project <folder>`（預設目前資料夾）或 `--target <folder>`，見各段。

## init

在這個資料夾設定 Review Bridge：問 writer、reviewer、專案類型。

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

跑一張工單：封存計畫、確認 reviewer 只能讀、印出你要授權的內容、問一次、然後跑。

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

暫停一條正在跑的工單：停掉它的模型程序，紀錄保留（`resume <run_id>` 接著做）。

```text
Usage: review-bridge stop <run_id> [options]

Pause a running work order: its model process is stopped and its records are kept (resume <run_id> carries it on)

Options:
  --project <folder>
      The project folder (string; default: the current folder)
```

## resume

接著做一條停掉的工單：同一張工單的新 run，停點與範圍相同；角色、模型、effort、預算重新決定，印同樣的卡、要同樣的 y。

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

清紀錄：不帶 run id 時把做完的 run 收進日檔、丟掉過保留期的；帶 run id 時移除那條做完的 run（正在跑的拒絕）。

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

Bridge 現在在做什麼：頁面、這個專案的 run、review 佇列、怎麼看資料庫。

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

一條 run 的 log 資料夾與每個檔是什麼；給工單（檔或 `source_id`）時列它的 run，最新在上。

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

把 Bridge 的 tasks 加進 VS Code 的 task 清單：這個專案的 `.vscode/tasks.json`，或 `--user` 寫進你的使用者 tasks、所有專案都有。

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

在背景起本機頁面服務。

```text
Usage: review-bridge up [options]

Start the local page service in the background

Options:
  --project <folder>
      The project folder (string; default: the current folder)

1 more option(s) for tests and agents: review-bridge up --help --all
```

## down

停本機頁面服務。

```text
Usage: review-bridge down [options]

Stop the local page service

Options:
  --project <folder>
      The project folder (string; default: the current folder)
```

## ps

本機頁面服務有沒有在跑、網址是什麼。

```text
Usage: review-bridge ps [options]

Show whether the local page service is running, and its address

Options:
  --project <folder>
      The project folder (string; default: the current folder)
```

## watch

在這個終端機跑本機頁面，直到 Ctrl+C。

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

把這個資料夾的設定搬到已安裝的 Review Bridge 版本，先備份。

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

從一個資料夾移除 Review Bridge 的設定，先備份（Bridge 本體：`npm uninstall -g review-bridge`）。

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

檢查這台機器用哪個平台 adapter，不跑任何工作。

```text
Usage: review-bridge doctor [options]

Check which platform adapter this machine uses, without running any work

Options:
  --project <folder>
      The project folder (string; default: the current folder)

1 more option(s) for tests and agents: review-bridge doctor --help --all
```

## backup

複製你的資料庫（所有專案），資料庫停著時做；有 run 在跑會拒絕。

```text
Usage: review-bridge backup [options]

Copy your database, for all your projects, with the database stopped (refused while a run is running)

Options:
  --project <folder>
      The project folder (string; default: the current folder)
```
