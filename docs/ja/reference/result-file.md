# 結果ファイル

run ごとに `.review-bridge/results/<作業指示名>/` に結果ファイルを作成します。名前は `<source_id> <作業指示名> <現地日付> <hh-mm-ss> <結論>.md` で、既存の結果は上書きしません。現在、結果ファイルの見出しなどは英語で出力されます。このページでは各セクションの読み方を説明します。ヘッダーの例には中国語の作業指示を使っています。

## 先頭：作業指示と実行情報

```yaml
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
```

| フィールド | 説明 |
|---|---|
| `source_id` | 作業指示の frontmatter にあるチケット番号。未設定なら省略。 |
| `title` | 作業指示のタイトル。 |
| `source_file` | プロジェクト内の作業指示のパス。 |
| `version_no` | **その実行で固定した作業指示のバージョン**。後から編集しても、この結果が参照するバージョンは変わりません。 |
| `contract_sha256` | コントラクトの SHA-256。同じディレクトリの `contract.v<バージョン>.<先頭 7 文字>.json` に対応します。 |
| `run_id` | `logs <run_id>`、`clean <run_id>` で使う実行 ID。 |
| `commit` | 開始時のコミット。未コミットの変更があれば `plus uncommitted changes`、Git がなければ `unknown (no Git)` を表示します。 |
| `writer` / `reviewer` | 今回使った provider、モデル、effort。`null` は CLI の既定モデルです。reviewer の `mcp` は利用を許可された MCP サーバーです。 |

値は Bridge のデータベースから取得します。読み取れない場合は先頭で理由を説明し、値を unknown と表示します。

## タイトル：結論

| タイトル | `conclusion` | 意味 |
|---|---|---|
| `Delivered` | `success` | レビューが成功し、すべての受け入れ条件に根拠があります。 |
| `Needs fixing` | `action_required` | 自動修正の上限（`rounds`）に達しても未解決の項目があります。 |
| `Your decision needed` | `action_required` | 作業指示の曖昧さ、範囲外の変更、データ削除、パッケージ変更、リリース操作などについて人の判断が必要です。 |
| `Stopped` | `cancelled` | `stop` の実行、新バージョンによる置き換え、またはデータベースの切断で停止しました。 |
| `Cancelled` | `cancelled` | 承認が取り消されました。 |
| `Token ceiling exceeded` | `failure` | 呼び出し単位または run 全体のトークン上限を超えたか、使用量を取得できません。 |
| `Provider quota exhausted` | `failure` | provider の利用枠を使い切りました。 |
| `Timed out` | `timed_out` | `run_timeout` に達しました。 |
| `Error` | `failure` / `timed_out` | その他のエラー。Why に理由コードとログのパスがあります。 |

## 概要とテスト

```text
Work order: <パス>   run: <run_id>   ended: <UTC 時刻>   calls: <モデル呼び出し回数>
Tests: not configured for this project; no test rule matched, so none ran
```

テスト行は `Existing tests passed: <コマンド>`、`Existing tests failed: <コマンド> (exit <code>)`、`Existing tests timed out: <コマンド>`、`Tests: not configured…` のいずれかです。

## Acceptance

受け入れ条件ごとに 1 行表示します。

```text
- AC1 proven: <条件の原文> (reviewer: pass; tests: not used; evidence: <reviewer の根拠>)
Checked on commit 8c96ab0e483f.
```

- 結果：`proven`、`failed`、`unknown`。
- `reviewer`：その条件に対する reviewer の判定。
- `tests`：`passed`、`failed`、`not run`、`not used`（テストに依存しない条件）。
- 最後の行は確認時のバージョンです。`Checked on commit …`、`… plus uncommitted changes`、Git がなければ `Version checked: unknown (no Git)` と表示します。

reviewer が合格としても、根拠がない条件が残っていれば Bridge は納品成功と判定しません。理由は Why に記載します。

## Why

結論の根拠を説明します。成功時は、reviewer が検証した項目（`Verified by the reviewer:`）と、実行しなかった項目（`Not run by the reviewer:`）を表示します。

成功しなかった場合は、最後のレビューの指摘（`<id> (<severity>) <path>:<line>: <claim> -> <fix>`）、失敗したテストコマンドと stderr の末尾、writer の質問（`The writer asks you:`）、writer が確認できなかった事項（`What the writer says it could not check:`）、停止理由を表示します。

## Work order changed after the start

実行開始後に作業指示を変更した場合に表示されます。Bridge は開始時に固定したバージョンで判定しているため、一覧の変更は**今回の実行には使われていません**。新しい内容を使うには `start` を再実行してください。ファイルが削除された場合や読み取れない場合も、ここに表示します。

## Next step

次の操作を案内します。成功時は変更を確認してコミットするか判断します。利用枠を使い切った場合はリセット後に再試行し、指摘があれば Why に従って作業指示やコードを修正します。タイムアウト時は作業を小さくするか、許容範囲内で `budget.run_timeout` を増やします。

## Files changed

変更の証跡は 3 つの一覧に分かれます。該当項目がなければ省略します。

1. **Files changed**：Git から取得した変更（`added`／`modified`／`deleted`）を Bridge の記録と照合したものです。冒頭には、同じユーザーで動くプロセスはこれらの記録を変更できる、という証拠の制限を示します。変更がなければ `No files were changed.` と表示します。
2. **What the writer says it changed (not checked against Git)**：writer が報告した変更です。Git との照合はしていません。
3. **Already uncommitted when the run started**：開始前からあった未コミットの変更です。今回の成果とはみなしません。

範囲の問題がある場合は、`Changes outside the allowed scope`（許可範囲外の変更）や `Changes outside the scope that could not be attributed to this run`（今回の実行によるものと確認できない範囲外の変更）も表示します。Git がなければ `No work proof: …` のみです。実行中に Git 履歴が書き換えられたりブランチが切り替わったりすると、Bridge は比較を続けず停止します。

## Tokens

| 列 | 説明 |
|---|---|
| role | `writer`、`reviewer`、`contract translation`（writer による条件の整理）、`contract check`（reviewer によるコントラクト確認）。 |
| calls | 呼び出し回数。 |
| input / cache read / cache write / output / total | CLI が報告した使用量の合計。writer のサブエージェントも含みます。 |
| cost | CLI が費用を報告した場合のみ表示します。 |

停止、タイムアウト、中断などで呼び出しが正常終了しなかった場合、使用量は `partial` になります。使用量が不完全な場合、Bridge はトークン上限が守られたと確認できません。

## JSON 出力

`review-bridge status --json`、`review-bridge logs <run_id|file> --json`、`review-bridge work-status` は共通の JSON フィールドを返します。各 run の `run_id`、`status`、`conclusion`、`closed_reason`、`created_at`、`closed_at`、`source_file`、`work_package_id`、`authorized_via` が含まれます。

最新の記録には、`version_no`、`title`、`contract_sha256`、`execution_mode`、`writer_provider`／`writer_model`／`writer_effort`、`reviewer_provider`／`reviewer_model`／`reviewer_effort`／`reviewer_mcp`、`breakpoint`、`scope`、`budget`（各値の設定元を含む）、`test`、`timeout_at`、`last_stop` も含まれます。
