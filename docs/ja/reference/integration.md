# システム連携

すでに課題管理ツールやスクリプト、独自のダッシュボードを使っている場合は、そこから Bridge の作業指示を生成できます。ユーザーの承認を得て実行し、結果を読み取って元のシステムに反映する、という連携が可能です。

rc3 では次の 3 つの方法を使えます。

| やりたいこと | 連携方法 |
|---|---|
| Bridge に作業を依頼する | Markdown の作業指示ファイルを生成し、CLI で実行する |
| プログラムから状態や結果を取得する | CLI の JSON 出力、または結果ファイルの YAML フィールドを読み取る |
| レポート、ダッシュボード、監査用のデータ出力を作る | ローカルの PostgreSQL を直接クエリする |

これらは現在利用できる方法です。**外部連携用の HTTP API はまだありません。** rc4 での追加を予定しています。

## 既存の課題を Bridge の作業指示にする

連携元のシステムで作業指示ファイルを生成し、プロジェクトの `.review-bridge/work-packages/` に保存します。書式の詳細は[最初の作業指示](../guide/work-order)を参照してください。先頭の YAML frontmatter に設定を記述し、`<!-- bridge:<key> -->` で区切ったブロックに依頼内容やコントラクトの材料を記述します。

連携でよく使うフィールドは次のとおりです。

| フィールド | 用途 |
|---|---|
| `source_id` | Jira、Linear、GitHub issue など、連携元の課題番号。両システムの記録を対応づけるもので、Bridge 内の作業指示の識別や実行ルールには使いません |
| `priority` | 作業の優先度。対応する設定を適用するために使います |
| `writer`、`reviewer` | 各役割のモデルと推論の強度（effort） |
| `budget` | その作業指示の予算と実行上限。policy が許可する範囲を超える値は指定できません |

`source_id` は、結果ファイル名、結果ファイルの frontmatter、`logs <source_id>`、データベースの `work_order_versions.source_id` で確認できます。Bridge の実行記録と、連携元の課題を照合するために使います。

作業指示は上記のフォルダーに置いてください。`start` に渡す作業指示のパスは、プロジェクトの `.review-bridge/` 配下である必要があります。

## 実行する前に、ユーザーの承認を得る

対話型ターミナルで `start` を実行すると、Bridge はどこまで作業するかを尋ね、計画カードを表示して承認を求めます。エージェントやスクリプトから呼び出し、対話型ターミナルがない場合は、カードを表示した後、`Needs authorization` の状態で止まります。

対話型ターミナルがない場合は、次のように 2 回に分けて呼び出します。

```sh
# まず計画カードを生成して表示する
review-bridge start .review-bridge/work-packages/add-readme.md

# ユーザーにカードを見せ、承認を得てから実行する
review-bridge start .review-bridge/work-packages/add-readme.md --yes
```

`--yes` は「ユーザーがこの計画を確認し、実行に同意した」ことを、プログラムやエージェントが伝える指定です。承認記録には `authorized_via: agent` と記録されます。

**このフィールドが記録するのは承認の伝達経路であり、本当にユーザーが承認したかを検証するものではありません。** CI や定期実行でも、ユーザーによる承認ステップを設けてください。`--yes` を確認省略のために使うことはできません。エージェントによる無断の代答は、エージェント側ツールの権限確認で制限します。

### 計画の作成と実行を分ける場合

通常は `start` だけで十分です。連携するプログラムで計画を保存し、承認を待ってから実行したい場合は、次の低レベルコマンドを使えます。

| コマンド | 用途 |
|---|---|
| `work-plan <file> [--out <file>] [--json]` | 計画を固定し、実行せずに保存します。既定では、その処理のログディレクトリに `<name>.plan.json` を書き込み、計画の SHA-256 を出力します。`--out` で保存先を指定できます |
| `work-start --plan <file> --yes [--json]` | ユーザーの承認後、指定した計画を実行します。`--json` を付けると、終了時にその run の状態を取得できます |
| `work-cancel --reason <text> [--run <run_id>]` | 指定した run の有効な承認を取り消し、作業を続行できないようにします |
| `roles-check` | writer と reviewer の CLI がインストールされ、ログイン済みかを確認します。モデルは呼び出しません |

各コマンドの前には `review-bridge` を付けます。すべてのオプションは `<コマンド> --help` で確認できます。

## プログラムから状態と結果を取得する

CLI の JSON 出力は、課題のステータス更新や進捗表示に使えます。必要な情報に応じてコマンドを選びます。

| コマンド | 取得できる内容 |
|---|---|
| `status --json` | ローカルページの情報、実行中の作業数、プロジェクトの直近 10 件の run、レビューキュー、役割設定、ログディレクトリ、データベースの接続情報 |
| `logs <run_id> --json` | 指定した run のログディレクトリと、各ファイルの用途 |
| `logs <file \| source_id> --json` | 指定した作業指示の実行履歴。新しい順に 1 ページ 10 件を返し、`--after <run_id>` で次のページを取得します |
| `work-status` | プロジェクトの run 一覧と、最新の run の詳細を JSON で出力します |
| `clean --json`、`upgrade --json`、`uninstall --json`、`init --json`、`vscode --json` | 各操作の結果 |

### 実行記録のフィールド

このページでは、1 回の実行を run と呼び、`run_id` で識別します。run 一覧には次の基本情報が含まれます。

| 分類 | フィールド |
|---|---|
| 識別と参照元 | `run_id`、`source_file`、`work_package_id` |
| 実行状態 | `status`、`conclusion`、`closed_reason` |
| 開始・終了時刻 | `created_at`、`closed_at` |
| 承認の伝達経路 | `authorized_via` |

最新の run には、さらに次の情報があります。

| 分類 | フィールド |
|---|---|
| 作業指示とコントラクト | `version_no`、`title`、`contract_sha256` |
| 実行モード | `execution_mode` |
| 実装担当 | `writer_provider`、`writer_model`、`writer_effort` |
| レビュー担当 | `reviewer_provider`、`reviewer_model`、`reviewer_effort`、`reviewer_mcp` |
| 実行上限 | `breakpoint`、`scope`、`budget`。予算の各値には設定元も含まれます |
| テストと停止に関する情報 | `test`、`timeout_at`、`last_stop` |

`status` は、実行中（`in_progress`）か、終了したか（`completed`）を示します。**終了したことと、正常に成果を得られたことは別です。** `conclusion` も確認してください。値は `success`、`failure`、`cancelled`、`timed_out`、`action_required` です。`closed_reason` には、さらに具体的な終了理由が入ります。

### 結果ファイルを連携元の課題と照合する

結果ファイル先頭の YAML frontmatter もプログラムで読み取れます。`source_id`、`title`、`source_file`、`version_no`、`contract_sha256`、`run_id`、`commit`、`writer`、`reviewer` が含まれます。各フィールドは[結果ファイル](./result-file)を参照してください。

ファイル名は `<source_id> <作業指示名> <現地日付> <hh-mm-ss> <結論>.md` で、既存の結果は上書きしません。`source_id` がない場合は、先頭の課題番号を省略します。

## スクリプトで成功を判定する

**終了コードだけでは、成果を得られたかどうかを判断できません。** コマンドが正常終了しても、承認やユーザーの判断を待っていることがあります。

たとえば `Needs authorization` を表示した場合の終了コードは `0` ですが、作業はまだ始まっていません。run の記録がある場合は、`status` と `conclusion` も確認してください。`action_required` はユーザーの対応が必要な状態であり、成功として扱えません。

| 終了コード | 意味 |
|---|---|
| `0` | コマンドが正常終了した。成果を得られた場合のほか、承認、要件の確認、コントラクトの確認を待っている場合もある |
| `1` | writer、reviewer、または policy のチェックに失敗した |
| `2` | コマンドの引数が不正 |
| `69` | データベースや変更の証跡など、必要なリソースを利用できない。sysexits の `EX_UNAVAILABLE` に相当する |
| `75` | provider の利用枠を使い切った（`rate_limited`） |
| `76` | トークン上限を超えた、または使用量を読み取れない |
| `77` | writer がタイムアウトした |
| `79` | `contract_rejected` など、モデルの出力が必要な形式を満たしていない |
| `130` | `stop` または Ctrl+C で停止した |

## データベースからレポートやダッシュボードを作る

実行記録の正本は Bridge の PostgreSQL です。待ち受けるのはローカルの `127.0.0.1` だけで、レポート、ダッシュボード、監査用のデータ出力には SQL で直接読み取れます。

`review-bridge status` を実行すると、ホスト、ポート、ユーザー、データベース名、パスワードファイルの場所を確認できます。接続手順は [VS Code でデータベースを見る](../guide/results#vs-code-database)を参照してください。結果ファイルは閲覧用のコピーです。詳細ログには別途保持期限があります。[結果・ログ・データベース](../guide/results)で説明しています。

### テーブルと保存内容

現在は 16 個の業務テーブルに加え、マイグレーションの適用履歴を管理する `schema_migrations` があります。

| テーブル | 内容 |
|---|---|
| `projects` | プロジェクト情報。`project_id` は `bridge.json` 内のプロジェクト ID に対応します |
| `work_orders`、`work_order_versions` | 作業指示の識別と版の履歴。各版に原文、`content_sha256`、`source_id` を保存します |
| `plans` | 計画カードの全文（`body`）と `plan_sha256` |
| `authorizations`、`authorization_claims` | 承認者、時刻、伝達経路、対象の計画と、承認を一度だけ使用するための記録 |
| `contracts` | 固定したコントラクトの内容と `sha256` |
| `policy_snapshots` | 実行時に適用した policy とそのハッシュ |
| `runs`、`run_events` | 各 run とイベント。イベントの連番はデータベースが割り当てます |
| `test_results` | Bridge が実行したテストの結果 |
| `review_results`、`review_findings`、`review_verdicts` | レビュー結果、指摘事項、各完了条件の判定 |
| `acceptance_rows`、`acceptance_decisions` | 完了条件ごとの結果と、Bridge による全体の判定 |

### よく使うクエリの例

以下の課題番号 `DOC-1` と run ID は例です。実際の値に置き換えてください。

連携元の課題番号から実行履歴を取得します。各 run で固定した作業指示の版と照合します。

```sql
select r.run_id, r.status, r.conclusion, r.closed_reason, r.created_at
from runs r
join work_order_versions v
  on v.work_order_id = r.work_order_id
  and v.content_sha256 = r.content_sha256
where v.source_id = 'DOC-1'
order by r.created_at desc, r.run_id desc
limit 10;
```

1 回の run について、各完了条件の結果、レビュー判定、テスト状態、証拠をイベント順に確認します。

```sql
select sequence, ac_id, result, verdict, test, evidence
from acceptance_rows
where run_id = '2eb9dc50-f49d-4eae-95ed-e503a2fa5531'
order by sequence, ac_id;
```

今月開始した run を対象に、記録済みのトークン使用量をプロジェクト別に集計します。

```sql
select project_id, sum(tokens_used) as recorded_tokens
from runs
where created_at >= date_trunc('month', now())
group by project_id
order by project_id;
```

最後の例は、**run の開始時刻**を基準に月を区切り、現時点で記録されている使用量を集計します。provider の請求額を示すものではありません。実行の中断などで使用量の記録が不完全な場合は、結果ファイルの `partial` 表示も確認してください。

### 参照は SQL、変更は Bridge のコマンドで行う

カラム定義は、インストールしたバージョンの `review-bridge/service/database/migrations/` にあるマイグレーションファイルを基準にしてください。rc 間でもスキーマが拡張される可能性があるため、クエリを書く際はバージョンを確認します。

作業の作成や変更には Bridge のコマンドを使い、テーブルに直接 `insert`、`update`、`delete` を実行しないでください。承認、コントラクト、判定は Bridge のフローで作成することで、相互の関連と確認の根拠を保てます。

## 今後の HTTP API

rc4 では Vue の画面とあわせて HTTP API を追加し、Zod と oRPC でデータ形式、型、実行時の検証を定義する予定です。作業指示ファイル、CLI、データベースのクエリは引き続き利用でき、API が新たな連携方法として加わります。
