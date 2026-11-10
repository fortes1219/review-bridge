# コマンド

各コマンドの `review-bridge <command> --help` の出力を、オプションを含めてそのまま掲載しています。エージェントやスクリプト向けの下位コマンドは `review-bridge --help --all` で確認できます。`work-plan`、`work-start`、`work-status`、`work-cancel`、`wait`、`prune`、`rm`、`roles-check` が含まれます。通常は `start` だけで `work-plan` と `work-start` の両方を実行できます。

| コマンド | 用途 |
|---|---|
| `init` | 現在のフォルダーを初期設定し、writer、reviewer、プロジェクト種別を選択します。 |
| `start` | 実行計画を固定し、reviewer の読み取り専用制限を確認してカードを表示します。人の承認後に作業を開始します。 |
| `stop` | 指定した run のモデルプロセスを停止し、記録を残します。`resume <run_id>` で作業指示を再実行できます。 |
| `resume` | 停止した作業指示を、同じ停止位置と変更範囲で新しい run として実行します。役割、モデル、effort、予算を再決定し、新しいカードで承認を求めます。 |
| `clean` | run ID がなければ終了済み記録を日別ファイルにまとめ、期限切れの内容を削除します。ID があればその終了済み run を削除します。実行中の作業は削除できません。 |
| `status` | ローカルページ、プロジェクトの実行状態、レビューキュー、データベース接続情報を表示します。 |
| `logs` | run のログフォルダーと各ファイルの用途を表示します。作業指示ファイルまたは `source_id` を渡すと、過去の run を新しい順に表示します。 |
| `vscode` | プロジェクトの `.vscode/tasks.json` に Bridge のタスクを追加します。`--user` なら全プロジェクト共用のユーザータスクに書き込みます。 |
| `up` | ローカルページサービスをバックグラウンドで起動します。 |
| `down` | ローカルページサービスを停止します。 |
| `ps` | ローカルページサービスの状態と URL を表示します。 |
| `watch` | 現在のターミナルでローカルページサービスを実行します。Ctrl+C で終了します。 |
| `upgrade` | プロジェクト設定をバックアップし、インストール済みの Review Bridge のバージョンに更新します。 |
| `uninstall` | バックアップ後、指定フォルダーから Review Bridge の設定を削除します。パッケージ自体の削除は `npm uninstall -g review-bridge` を使います。 |
| `doctor` | 作業指示を実行せず、本機のプラットフォーム adapter を確認します。 |
| `backup` | データベースを停止し、全プロジェクトのデータをコピーしてから再起動します。実行中の作業があれば拒否します。 |

プロジェクトは `--project <folder>` または `--target <folder>` で指定し、既定は現在のフォルダーです。対応するオプションは各コマンドを参照してください。

## init

現在のフォルダーを初期設定し、writer、reviewer、プロジェクト種別を選択します。

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

実行計画を固定し、reviewer の読み取り専用制限を確認してカードを表示します。人の承認後に作業を開始します。

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

指定した run のモデルプロセスを停止し、記録を残します。`resume <run_id>` で作業指示を再実行できます。

```text
Usage: review-bridge stop <run_id> [options]

Pause a running work order: its model process is stopped and its records are kept (resume <run_id> carries it on)

Options:
  --project <folder>
      The project folder (string; default: the current folder)
```

## resume

停止した作業指示を、同じ停止位置と変更範囲で新しい run として実行します。役割、モデル、effort、予算を再決定し、新しいカードで承認を求めます。

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

run ID がなければ終了済み記録を日別ファイルにまとめ、期限切れの内容を削除します。ID があればその終了済み run を削除します。実行中の作業は削除できません。

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

ローカルページ、プロジェクトの実行状態、レビューキュー、データベース接続情報を表示します。

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

run のログフォルダーと各ファイルの用途を表示します。作業指示ファイルまたは `source_id` を渡すと、過去の run を新しい順に表示します。

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

プロジェクトの `.vscode/tasks.json` に Bridge のタスクを追加します。`--user` なら全プロジェクト共用のユーザータスクに書き込みます。

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

ローカルページサービスをバックグラウンドで起動します。

```text
Usage: review-bridge up [options]

Start the local page service in the background

Options:
  --project <folder>
      The project folder (string; default: the current folder)

1 more option(s) for tests and agents: review-bridge up --help --all
```

## down

ローカルページサービスを停止します。

```text
Usage: review-bridge down [options]

Stop the local page service

Options:
  --project <folder>
      The project folder (string; default: the current folder)
```

## ps

ローカルページサービスの状態と URL を表示します。

```text
Usage: review-bridge ps [options]

Show whether the local page service is running, and its address

Options:
  --project <folder>
      The project folder (string; default: the current folder)
```

## watch

現在のターミナルでローカルページサービスを実行します。Ctrl+C で終了します。

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

プロジェクト設定をバックアップし、インストール済みの Review Bridge のバージョンに更新します。

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

バックアップ後、指定フォルダーから Review Bridge の設定を削除します。パッケージ自体の削除は `npm uninstall -g review-bridge` を使います。

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

作業指示を実行せず、本機のプラットフォーム adapter を確認します。

```text
Usage: review-bridge doctor [options]

Check which platform adapter this machine uses, without running any work

Options:
  --project <folder>
      The project folder (string; default: the current folder)

1 more option(s) for tests and agents: review-bridge doctor --help --all
```

## backup

データベースを停止し、全プロジェクトのデータをコピーしてから再起動します。実行中の作業があれば拒否します。

```text
Usage: review-bridge backup [options]

Copy your database, for all your projects, with the database stopped (refused while a run is running)

Options:
  --project <folder>
      The project folder (string; default: the current folder)
```
