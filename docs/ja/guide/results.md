# 結果・ログ・データベース

実行後は、プロジェクト内の**結果ファイル**、**実行ログ**、データベース内の**イベントと判定**の 3 か所から内容を確認できます。結果ファイルの先頭にある ID で、それぞれの記録を照合できます。

## 結果ファイル

run ごとに 1 つの結果ファイルを、作業指示専用のフォルダーに保存します。

```text
.review-bridge/results/<作業指示名>/
  DOC-1 add-readme 2026-11-06 07-31-29 success.md
  contract.v1.7189c52.json
```

- ファイル名は `<source_id> <作業指示名> <現地日付> <hh-mm-ss> <結論>.md` です。`source_id` がない場合は先頭部分を省略します。**既存の結果は上書きしません。**
- 隣の `contract.v<バージョン>.<SHA-256 の先頭 7 文字>.json` は、その結果で使った固定済みコントラクトです。
- どちらも閲覧用のコピーです。削除しても Bridge のデータベース内の記録は消えません。

先頭にはデータベースから取得した作業指示、バージョン、役割の情報があり、その後に結論が続きます。このページの出力例は中国語の作業指示を使ったもので、CLI の出力はそのまま掲載しています。

```markdown
---
source_id: DOC-1
title: 幫專案補一份 README
source_file: .review-bridge/work-packages/add-readme.md
version_no: 1  # the sealed version this result is about, not the .md on disk now
contract_sha256: 7189c52c…
run_id: 2eb9dc50-f49d-4eae-95ed-e503a2fa5531
commit: 8c96ab0e…
writer:
  provider: claude
  model: null  # the CLI's own default
  effort: medium
reviewer:
  provider: codex
  model: null  # the CLI's own default
  effort: medium
  mcp: []
---

# Delivered

Work order: .review-bridge/work-packages/add-readme.md   run: 2eb9dc50-…   ended: 2026-11-05T23:31:29.742Z   calls: 1
Tests: not configured for this project; no test rule matched, so none ran

## Acceptance
- AC1 proven: 根目錄有 README.md，第一行是專案名稱。 (reviewer: pass; tests: not used; evidence: …)
- AC2 proven: README 裡有一段「如何啟動」。 (reviewer: pass; tests: not used; evidence: …)
Checked on commit 8c96ab0e483f.

## Why
Verified by the reviewer:
- …
Not run by the reviewer:
- …

## Next step
Look at the changed files below; commit yourself if you are satisfied. Write a new work order for further changes.

## Files changed
Work proof from Git, checked against the records Bridge wrote; …

### What the writer says it changed (not checked against Git)
- README.md（modified）

## Tokens
| role | calls | input | cache read | cache write | output | total | cost |
|---|---|---|---|---|---|---|---|
| writer | 1 | … |
```

各セクションの詳細は[結果ファイルのリファレンス](../reference/result-file)を参照してください。`version_no` は**その実行で固定した作業指示のバージョン**です。「Files changed」の最初の一覧は Git に基づき、Git と照合していない writer の報告は別に表示します。

## status

```text
Page: http://localhost:8080/
Work: 0 running
  2eb9dc50-f49d-4eae-95ed-e503a2fa5531  completed    success          review_pass           .review-bridge/work-packages/add-readme.md  2026-11-06 07:31:29 +0800
Review queue: pending 0, running 0, done 1, failed 0
Latest review: <data home>/projects/<project_id>/reviews/20261105T233129644Z-…-reviewer-review.md
Roles: writer claude, reviewer codex
Logs: <ログディレクトリ>/<project_id>
Database in VS Code: install Microsoft's PostgreSQL extension and add a connection with
  Server 127.0.0.1  Port 5432  User bridge  Database bridge
  Password: copy it from <data home>/postgres/secret
```

各行に run ID、状態、結論、理由、作業指示、現地時刻が表示されます。`--after <run_id>` で次の 10 件、`--json` でプログラム向けの出力を取得できます。

## logs

作業指示ファイルまたは `source_id` を渡すと、過去の run を新しい順に表示します。

```text
Runs of .review-bridge/work-packages/add-readme.md, newest first:
  2eb9dc50-f49d-4eae-95ed-e503a2fa5531  2026-11-06 07:31:29 +0800  success          <ログディレクトリ>/<project_id>/2eb9dc50-…
```

run ID を渡すと、その実行のログフォルダーと各ファイルの用途を表示します。

```text
Logs of run 2eb9dc50-… (success): <ログディレクトリ>/<project_id>/2eb9dc50-…
  call 1   writer      translate       prompt              …-contract-prompt.txt
  call 1   writer      translate       result              …-contract.result.json
  call 1   writer      translate       stderr              …-contract.stderr.log
  call 1   writer      translate       stream              …-contract.stream.jsonl
  call 2   reviewer    contract_check  prompt              …-contract-check-prompt.txt
  …
  call 3   writer      write           prompt              …-writer-only-prompt.txt
  call 3   writer      write           result              …-writer.stdout.json
  call 4   reviewer    review          stream              …-reviewer.stdout.log
                       result          result              2eb9dc50-….result.md
                       plan            plan                add-readme.plan.json
                       start           authorization_card  authorized-plan-….txt
```

ここには各モデル呼び出しの prompt、ストリーム、stderr、テスト出力、計画、確認した承認カードが入ります。プロジェクトとは別に、OS のログディレクトリに保存します。保存期間（`bridge.json` の `retention.days`、既定は 15 日）を過ぎるか、`clean <run_id>` を実行すると、対象ファイルが削除されます。

## データの保存先

| データ | 保存先 |
|---|---|
| プロジェクト設定、作業指示、結果のコピー | プロジェクトの `.review-bridge/` |
| 個人設定（`settings.json`）、データベース、プロジェクトごとの実行状態（`projects/<project_id>/`） | data home：Windows `%LOCALAPPDATA%\ReviewBridge`、macOS `~/Library/Application Support/ReviewBridge`、Linux `~/.local/share/review-bridge`。`REVIEW_BRIDGE_DATA_HOME` で変更できます。 |
| 各 run のログ（`<project_id>/<run_id>/`） | Windows `%LOCALAPPDATA%\ReviewBridge\Log`、macOS `~/Library/Logs/ReviewBridge`、Linux `$XDG_STATE_HOME/review-bridge`（`~/.local/state/review-bridge`）。`REVIEW_BRIDGE_DATA_HOME` を設定した場合は、その下の `logs/`。 |
| バックアップ | data home の `backups/database`（`review-bridge backup`）と `backups/installer`（`upgrade`、`uninstall`）。非公開の作業データを含む場合があるため、公開しないでください。 |

**実行記録の正本はデータベースです。** `projects/<project_id>/` には実行用のコピーを保持します。ログや結果ファイルを削除しても、作業指示のバージョン、計画、承認、コントラクト、run、イベント、判定、納品のデータベース記録は消えません。ただし、ログの原本は保存ルールに従って削除されます。データベースは `127.0.0.1` のみで待ち受け、現在はコマンド終了後も動作し続けます。

## VS Code でデータベースを見る {#vs-code-database}

Microsoft の PostgreSQL 拡張機能、または SQLTools と PostgreSQL driver をインストールし、接続を追加します。

- Server：`127.0.0.1`
- Port：`5432`。使用中なら、起動時に次の空きポートを順に探します。
- User：`bridge`
- Database：`bridge`
- Password：data home の `postgres/secret` からコピーします。Windows では `%LOCALAPPDATA%\ReviewBridge\postgres\secret` です。このファイルは自分のユーザーだけが読み取れます。

`init` と `review-bridge status` の末尾に、現在の接続情報とパスワードファイルの場所が表示されます。別のポートから探すには、data home の `settings.json` に `"database": { "port": 5440 }` を追加します。次回のデータベース起動時に反映されます。PC の再起動後や、データベースを停止・再起動する `review-bridge backup` の実行後に新しい設定が使われます。

## バックアップ {#backup}

`review-bridge backup` は PostgreSQL のファイルレベルバックアップを使います。データベースを停止し、データとパスワードファイルを含むフォルダー全体をコピーしてから再起動します。実行中の作業がある場合は拒否します。

復元するには、バックアップの `postgres` フォルダーを空のディレクトリにコピーし、そのディレクトリを `REVIEW_BRIDGE_DATA_HOME` に指定してから Bridge を起動します。
