# 結果・ログ・データベース

実行後は、プロジェクト内の**結果ファイル**、**実行ログ**、データベース内の**イベントと判定**の 3 か所から内容を確認できます。結果ファイルの先頭にある ID で、それぞれの記録を照合できます。

## 結果ファイル {#result-files}

各 run は作業指示ごとのフォルダーに結果ファイルを作成します。以下は[作業を実行する](./start#the-card)で紹介した英語の作業指示を、`locale: en` と `--fake-cli` で実行した記録です。ローカルパスの先頭だけを短縮し、出力は英語のまま掲載しています。

```text
.review-bridge/results/add-readme/
  contract.v1.8d086ca.json
  DOC-1 add-readme 2026-11-10 12-45-02 success.md
```

- ファイル名は `<source_id> <作業指示名> <現地日付> <hh-mm-ss> <結論>.md` です。`source_id` がなければ先頭部分を省略します。**既存の結果は上書きしません。**
- 隣の `contract.v<バージョン>.<SHA-256先頭7文字>.json` は、その結果で使った固定済みコントラクトです。
- どちらも閲覧用コピーで、削除しても DB の記録は消えません。
- フォルダー単位の実行では `results/<フォルダー>/<作業指示>/` に保存します。

結果の固定ラベルは `bridge.json` の `locale` に従います。先頭には DB から取得した作業指示、版、役割を表示し、続いて結論を記載します。実際に生成された結果ファイルは次のとおりです。

```markdown
---
source_id: DOC-1
title: Add a README to the project
source_file: .review-bridge/work-packages/add-readme.md
version_no: 1  # the sealed version this result is about, not the .md on disk now
contract_sha256: 8d086cae7ac4a9cb7202943d6ff17540235a0b0a6bed7ef4024161683c6e82e3
run_id: b8f6c4b8-44a9-4f23-8a08-12bae14a6110
commit: null  # plus uncommitted changes
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

Work order: .review-bridge/work-packages/add-readme.md   run: b8f6c4b8-44a9-4f23-8a08-12bae14a6110   ended: 2026-11-10T04:45:02.056Z   calls: 1
Tests: not configured for this project; no test rule matched, so none ran

## Acceptance
- AC1 proven: README.md exists at the project root, with the project name on its first line. (reviewer: pass; evidence: fake: read the delta and the test output for AC1)
- AC2 proven: The README has a "Getting started" section. (reviewer: pass; evidence: fake: read the delta and the test output for AC2)
Checked on commit none plus uncommitted changes.

## Why
Verified by the reviewer:
- fake: read the delta
Not run by the reviewer:
- fake: project tests

## Next step
Look at the changed files below; commit yourself if you are satisfied. Write a new work order for further changes.

## Files changed
Work proof from Git, checked against the records Bridge wrote; any process running as the same user could have rewritten them.

- README.md（added）

### What the writer says it changed (not checked against Git)
- README.md（modified）

## Tokens
| role | calls | input | cache read | cache write | output | total | cost |
|---|---|---|---|---|---|---|---|
| contract | 0 | 0 | 0 | 0 | 0 | 0 |  |
| writer | 1 | 94 | 150346 | 454 | 2352 | 153246 | 0.4200 USD |
| reviewer | 1 | 29995 | 29995 | 0 | 410 | 60400 |  |
| graph lookups | 8 SQL | about 64 prompt tokens |  |  |  |  | estimated; already in the writer's and reviewer's input above, no cost of its own |
```

例の証拠、トークン数、費用は模擬 CLI の固定値で、実際のモデル使用量ではありません。サンプルのプロジェクトは Git を初期化しただけで、まだコミットがありません。そのため `commit` は `null`、確認対象のコミットは `none` と表示されます。追加した README も未コミットです。

各節の詳細は[結果ファイル](../reference/result-file)を参照してください。特に次の点を確認します。

- `version_no` は**今回の実行時に固定した版**です。
- `Files changed` の最初の一覧は Git が根拠です。Git と照合していない writer の申告は別記します。
- `contract` のトークン数は常に 0 です。コードで作成し、モデルは使いません。
- **成功時は reviewer の追加 findings を結果に表示しません。** 合格に添えた助言は、DB と `status` の `Latest review` が示す審査ファイルに残ります。場所は data home の `projects/<project_id>/reviews/…-reviewer-review.md` です。不合格時は `Why` に findings を表示します。

## status

```text
Page: http://localhost:60999/
Database: running
Work: 0 running
  b8f6c4b8-44a9-4f23-8a08-12bae14a6110  completed    success          review_pass           .review-bridge/work-packages/add-readme.md  2026-11-10 12:45:00 +0800
Latest review: <data home>\projects\1c3df8e9-f699-4351-9b16-a9368eae3436\reviews\20261110T044501712Z-70e39aebb38d2801-reviewer-review.md
Roles: writer claude, reviewer codex
Logs: <log directory>\1c3df8e9-f699-4351-9b16-a9368eae3436
Database in VS Code: install Microsoft's PostgreSQL extension and add a connection with
  Server 127.0.0.1  Port 60998  User bridge  Database bridge
  Password: copy it from <data home>\postgres\secret
```

各行は run ID、状態、結論、終了理由、作業指示のパス、現地時刻です。次の 10 件は `--after <run_id>`、プログラム用の出力は `--json` で取得します。`status` は DB を起動せず状態を表示します。データディレクトリがない、読めない、内容が不正な場合はパスを示し、`pg_ctl status` と同じ終了コード 4 を返します。

## logs

作業指示ファイルまたは `source_id` を渡すと、過去の run を新しい順に表示します。

```text
Runs of .review-bridge/work-packages/add-readme.md, newest first:
  b8f6c4b8-44a9-4f23-8a08-12bae14a6110  2026-11-10 12:45:00 +0800  success          <log directory>\1c3df8e9-f699-4351-9b16-a9368eae3436\b8f6c4b8-44a9-4f23-8a08-12bae14a6110
```

run ID を渡すと、その実行のログフォルダーと各ファイルの用途を表示します。

```text
Logs of run b8f6c4b8-44a9-4f23-8a08-12bae14a6110 (success): <log directory>\1c3df8e9-f699-4351-9b16-a9368eae3436\b8f6c4b8-44a9-4f23-8a08-12bae14a6110
  call 1   writer      write           stop_payload        20261110T044500402Z-rb8f6c4b8-stop-payload.json
  call 1   writer      write           prompt              20261110T044500402Z-rb8f6c4b8-writer-only-prompt.txt
  call 1   writer      write           stderr              20261110T044500402Z-rb8f6c4b8-writer.stderr.log
  call 1   writer      write           result              20261110T044500402Z-rb8f6c4b8-writer.stdout.json
  call 1   writer      write           stream              20261110T044500402Z-rb8f6c4b8-writer.stream.jsonl
  call 2   reviewer    review          stderr              20261110T044501712Z-70e39aebb38d2801-reviewer.stderr.log
  call 2   reviewer    review          stream              20261110T044501712Z-70e39aebb38d2801-reviewer.stdout.log
                       plan            plan                add-readme.plan.json
                       start           authorization_card  authorized-plan-bdfd3e153a8a9fe860c85c63185b9cf46bd3b1c4c832d011fafecea1ee847751.txt
                       result          result              b8f6c4b8-44a9-4f23-8a08-12bae14a6110.result.md
```

`logs` の出力は現在英語のみです。モデル呼び出しごとに `call` を付けます。この例は writer が 1 回、reviewer が 1 回で、コントラクト作成の呼び出しはありません。個別の呼び出しに属さない `result` は結果の原本、`plan` は固定した計画、`authorization_card` は承認したカードです。

ここには各モデル呼び出しの prompt、ストリーム、stderr、テスト出力、計画、確認した承認カードが入ります。プロジェクトとは別に、OS のログディレクトリに保存します。保存期間（`bridge.json` の `retention.days`、既定は 15 日）を過ぎるか、`clean <run_id>` を実行すると、対象ファイルが削除されます。

## データの保存先

| データ | 保存先 |
|---|---|
| プロジェクト設定、作業指示、結果コピー | プロジェクトの `.review-bridge/` |
| 個人用 `settings.json`、DB、プロジェクト別状態 `projects/<project_id>/` | data home：Windows `%LOCALAPPDATA%\ReviewBridge`、macOS `~/Library/Application Support/ReviewBridge`、Linux `~/.local/share/review-bridge`。`REVIEW_BRIDGE_DATA_HOME` で変更可能 |
| run のログ `<project_id>/<run_id>/` | Windows `%LOCALAPPDATA%\ReviewBridge\Log`、macOS `~/Library/Logs/ReviewBridge`、Linux `$XDG_STATE_HOME/review-bridge`（既定 `~/.local/state/review-bridge`）。`REVIEW_BRIDGE_DATA_HOME` 指定時はその `logs/` |
| バックアップ | data home の `backups/database`（`npx review-bridge backup`）、`backups/installer`（`upgrade`・`uninstall`）。私的な作業データを含む可能性があるため公開しない |

**実行記録の正本はデータベースです。** `projects/<project_id>/` は実行中のコピーを保持します。ログや結果ファイルを削除しても、DB 内の作業指示の版、計画、承認、コントラクト、run、イベント、判定、成果は消えません。ログ原本は保持期限に従って削除します。DB は `127.0.0.1` のみで待ち受け、コマンドやターミナル、VS Code の終了後も動作します。停止には `npx review-bridge down` を使います。[データベースとローカルページの操作](./start#database-and-page)を参照してください。

## VS Code でデータベースを見る {#vs-code-database}

Microsoft の PostgreSQL 拡張機能、または SQLTools と PostgreSQL driver をインストールし、接続を追加します。

- Server：`127.0.0.1`
- Port：`5432`。使用中なら、起動時に次の空きポートを順に探します。
- User：`bridge`
- Database：`bridge`
- Password：data home の `postgres/secret` からコピーします。Windows では `%LOCALAPPDATA%\ReviewBridge\postgres\secret` です。このファイルは自分のユーザーだけが読み取れます。

`init` と `npx review-bridge status` に現在の接続情報とパスワードファイルの場所を表示します。探索開始ポートを変えるには、data home の `settings.json` に `"database": { "port": 5440 }` を追加します。再起動、停止・再起動を伴うバックアップ、または `down` → `up` の後に反映されます。

## バックアップ {#backup}

`npx review-bridge backup` は PostgreSQL のファイル単位のバックアップです。DB を停止し、パスワードファイルを含む全フォルダーをコピーして再起動します。実行中の run があると拒否します。

復元するには、バックアップの `postgres` フォルダーを空のディレクトリにコピーし、そのディレクトリを `REVIEW_BRIDGE_DATA_HOME` に指定してから Bridge を起動します。
