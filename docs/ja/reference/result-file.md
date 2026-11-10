# 結果ファイル

各 run は `.review-bridge/results/<作業指示名>/` に `<source_id> <作業指示名> <現地日付> <hh-mm-ss> <結論>.md` を新規作成し、上書きしません。フォルダー単位なら `results/<フォルダー>/<作業指示>/` です。固定ラベルは `bridge.json` の `locale` に従い、現在は英語と繁体字中国語に対応します。ここでは英語の表示名に沿って各節を説明します。[全体の例](../guide/results#result-files)も参照してください。

## 先頭：作業指示と実行情報

[作業を実行する](../guide/start#the-card)で紹介した、英語の作業指示による模擬実行のヘッダーです。`locale: en` の出力をそのまま掲載しています。サンプルのリポジトリにはまだコミットがないため、`commit` は `null` です。

```yaml
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
```

| フィールド | 説明 |
|---|---|
| `source_id` | frontmatter の課題番号。未設定なら省略 |
| `title` | 作業指示のタイトル。`# ` 見出しがなければ `untitled` |
| `source_file` | プロジェクト内の作業指示パス |
| `version_no` | **今回の run で固定した版**。後の編集では変わらない |
| `contract_sha256` | 隣の `contract.v<版>.<先頭7文字>.json` に対応する SHA-256 |
| `run_id` | `logs <run_id>`、`clean <run_id>` で使う実行 ID |
| `commit` | 開始時のコミット。まだコミットがなければ `null`。必要に応じ `plus uncommitted changes`、Git がなければ `unknown (no Git)` と表示 |
| `writer` / `reviewer` | 今回の provider、model、effort。`null` は CLI 既定値。reviewer の `mcp` は許可したサーバー |

値は Bridge のデータベースから取得します。読み取れなければ、理由とともに以後の値が不明であることをヘッダーに表示します。

## タイトル：結論

| 表示タイトル | `conclusion` | 意味 |
|---|---|---|
| `Delivered` | `success` | レビューに合格し、すべての完了条件が成立 |
| `Needs fixing` | `action_required` | 修正回数 `rounds` を使い切り、未解決の項目がある |
| `Your decision needed` | `action_required` | writer の質問、範囲拡大、公開操作など、ユーザーの判断が必要 |
| `Stopped` | `cancelled` | `stop`、新版による置き換え（`superseded`）、DB 切断（`database_unavailable`） |
| `Cancelled` | `cancelled` | `work-cancel` による承認の取り消し |
| `Token ceiling exceeded` | `failure` | writer の単一呼び出し・run 全体のトークン超過、または使用量不明 |
| `Provider quota exhausted` | `failure` | provider の利用枠を使い切った |
| `Timed out` | `timed_out` | `run_timeout` に到達 |
| `Error` | `failure` / `timed_out` | その他のエラー。`Why` に理由コードとログのパス |

`database_unavailable` の `Why` には、実行中に DB が応答しなくなり、その後モデルを呼び出していないことと、復旧後に再実行する案内を記載します。

## 概要とテスト

```text
Work order: <path>   run: <run_id>   ended: <UTC time>   calls: <writer calls>
Tests: not configured for this project; no test rule matched, so none ran
```

テスト行は、上記の未設定のほか、`Existing tests passed: <command>`、`Existing tests failed: <command> (exit <code>)`、`Existing tests timed out: <command>` になります。

## 完了条件の判定

完了条件ごとに 1 行表示します。同じ模擬実行では、次のように記録されました。

```text
- AC1 proven: README.md exists at the project root, with the project name on its first line. (reviewer: pass; evidence: fake: read the delta and the test output for AC1)
- AC2 proven: The README has a "Getting started" section. (reviewer: pass; evidence: fake: read the delta and the test output for AC2)
Checked on commit none plus uncommitted changes.
```

- 結果は `proven`、`failed`、`unknown` です。reviewer の判定をそのまま写すのではなく、Bridge が条件ごとに決定します。
- `reviewer` は、その条件に対する reviewer の判定です。
- 最後に確認対象の版を示します。コミットのみ、未コミットの変更を含むコミット、または `unknown (no Git)` です。
- 開始時に graph を更新できなければ、両方の役割が以前の graph を使った旨を追記します。
- 審査前に停止した run では条件を表示しません。

reviewer が合格としても、すべての条件が `proven` でなければ完了にはしません。理由は `Why` に記載します。

## 判定の理由

結論の根拠を説明する節です。

- **完了時**：`Verified by the reviewer:` と `Not run by the reviewer:` を表示します。**合格に添えた追加 findings はここには表示しません。** DB と `status` の `Latest review` が示すファイルに残ります。
- **未完了時**：最後の findings（`<id> (<severity>) <path>:<line>: <claim> -> <fix>`）、失敗したテストと stderr 末尾、`The writer asks you:`、`What the writer says it could not check:`、停止理由を表示します。

## 実行開始後に作業指示が変わった場合

実行開始後に作業指示を変更した場合に表示されます。Bridge は開始時に固定したバージョンで判定しているため、一覧の変更は**今回の実行には使われていません**。新しい内容を使うには `start` を再実行してください。ファイルが削除された場合や読み取れない場合も、ここに表示します。

## 次の操作

成功時は変更を確認してコミットするか決めます。利用枠切れなら回復後に `start`、指摘があれば作業指示かコードを修正します。writer の質問には作業指示へ回答を書いて再実行します。タイムアウトなら依頼を分割するか、許容範囲で `budget.run_timeout` を増やします。

## 変更されたファイル

変更の証跡は 3 つの一覧に分かれます。該当項目がなければ省略します。

1. **Files changed**：Git の変更（`added`、`modified`、`deleted`）を Bridge の記録と照合した一覧。同じユーザー権限のプロセスなら記録を書き換えられるという証拠の制限を冒頭に記載します。変更なしは `No files were changed.` です。
2. **What the writer says it changed (not checked against Git)**：Git と照合していない writer の申告です。
3. **Already uncommitted when the run started**：開始前の未コミット変更で、今回の成果とは扱いません。

範囲に問題があれば、`Changes outside the allowed scope` または `Changes outside the scope that could not be attributed to this run` を追加します。Git がなければ証跡がないと表示します。実行中の履歴書き換えやブランチ変更では、比較を続けず停止します。

## トークン使用量

| 列 | 説明 |
|---|---|
| role | `contract`、`writer`、`reviewer`。検索時は `graph lookups` も追加 |
| calls | 呼び出し回数 |
| input / cache read / cache write / output / total | CLI の使用量。writer の子エージェント分も含む |
| cost | CLI が報告した場合のみ表示 |

- `contract` は常に 0 です。コントラクトはコードで転記し、モデルを使いません。
- `graph lookups` は SQL 回数と prompt に追加した推定トークン数です。両役割の input に含まれ、別料金ではありません。
- 使用量を取得できない呼び出しがあれば、calls は `N (M unreadable)`、ほかは `unknown` です。一部の合計を全体として扱いません。writer の使用量不明では予算内と確認できないため、次の呼び出し前に停止します。

## JSON 出力

- `npx review-bridge status --json`：ページ、役割、DB 接続情報、直近 10 件の run。各行に `run_id`、`status`、`conclusion`、`closed_reason`、`created_at`、`closed_at`、`updated_at`、`source_file`、`work_package_id`、`authorized_via`。次ページは `--after <run_id>` です。
- `npx review-bridge work-status`：同じ一覧と `latest_run` の詳細。`work_order_id`、`version_no`、`title`、`contract_sha256`、`execution_mode`、`writer_provider`／`writer_model`／`writer_effort`、`reviewer_provider`／`reviewer_model`／`reviewer_effort`／`reviewer_mcp`、`breakpoint`、`scope`、設定元付きの `budget`、`test`、`timeout_at`、`authorized_by`、`authorized_via`、`last_stop` を含みます。
- `npx review-bridge logs <run_id|file> --json`：run のフィールドは `work-status` と同じです。
