# 作業を実行する

`start <作業指示ファイル>` で作業を開始します。AI エージェント、VS Code、ターミナルのどこからでも同じコマンドを使います。異なるのは、**カードを確認して実行を承認する場所**です。

## Claude Code または Codex から

通常はこちらを使います。Claude Code では次のように入力します。

```text
/review-bridge start .review-bridge/work-packages/add-readme.md
```

Codex では `$review-bridge start .review-bridge/work-packages/add-readme.md` と入力します。

エージェントが最初に `start` を実行します。Bridge は作業指示の形式を検証し、各ブロックをコントラクトへ転記して、範囲、予算、テストコマンドとともに計画を固定します。承認カードを表示し、`Needs authorization` で止まります。この時点ではモデルを呼び出していません。

エージェントは**カード全文をそのまま**提示し、実行してよいか確認する必要があります。ユーザーの承認後にだけ、同じコマンドへ `--yes` を付けて再実行できます。これが実行の承認となり、エージェント経由で伝えたことを `authorized_via: agent` と記録します。

`--yes` が使うのは**直近に表示したカード**だけです。未表示、表示後の作業指示・オプション変更、期限切れ（24 時間）、使用済みの場合は、承認も実行もしません。拒否のメッセージには次に実行するコマンドを表示します。

`/review-bridge` の操作はターミナルと同じ 4 つです。`start <file>`、`stop <run_id>`、`resume <run_id>`、`clean [<run_id>]` を使えます。

## VS Code から {#in-vs-code}

Bridge は `review-bridge: start`、`stop`、`resume`、`clean`、`status`、`logs` の 6 つのタスクを用意しています。Quick Open に `task review-bridge` と入力するか、`Terminal → Run Task` を選択します。

`start` はエディターで開いているファイルを使います。他のタスクでは run ID またはファイル名を入力します。コマンドは統合ターミナルで実行され、承認カードもそこで確認します。

| 配置先 | 追加方法 | 利用範囲 |
|---|---|---|
| プロジェクトの `.vscode/tasks.json` | `init` の最後で y を選ぶか、`npx review-bridge vscode` | このプロジェクト |
| ユーザータスク（`Tasks: Open User Tasks`） | `npx review-bridge vscode --user` | 全プロジェクト |

`.vscode/tasks.json` を Git で管理するかは自分で決められます。Bridge は自動で追加も除外もしません。コミットするか追跡対象から除外するまでは、Git の変更として扱われ、結果にも未コミットの変更があると表示されます。

Bridge が管理するのは、label が `review-bridge:` で始まる task と、id が `review-bridge-` で始まる input だけです。それ以外の内容、コメント、書式は保持します。`uninstall` はこれらの項目を取り除き、他に何も残っていない場合に限りファイルを削除します。

ユーザータスクは VS Code の既定プロファイルに書き込みます。独自のタスクを持つ別プロファイル、VS Code Insiders、VSCodium、ポータブル版は保存先が異なるため、プロジェクトで `npx review-bridge vscode` を使ってください。マルチルートワークスペースでは最初のフォルダーから実行するため、作業指示のあるプロジェクトとは限りません。

## ターミナルから

```sh
npx review-bridge start .review-bridge/work-packages/add-readme.md
```

対話型ターミナルでは、`start` が停止位置（既定はレビュー後）を尋ね、カードを表示して `Start this work? [y/N]` と確認します。n を選ぶと承認も実行もしません。

| 操作 | コマンド |
|---|---|
| 作業指示を実行 | `npx review-bridge start <file>` |
| 記録を残して停止 | `npx review-bridge stop <run_id>` |
| 停止した作業指示を再実行 | `npx review-bridge resume <run_id>` |
| 終了済み記録を削除 | `npx review-bridge clean [<run_id>]` |

実行中の作業と ID は `npx review-bridge status` で確認できます。表は npm の `npx` ですが、pnpm、Yarn、Bun では案内も `pnpm dlx`、`yarn dlx`、`bun x` になります。[パッケージマネージャー](../reference/cli#package-managers)を参照してください。

## 承認カード {#the-card}

どの入口でもカードの形式は同じです。以下は README を追加する英語の作業指示を、`locale: en` と `--fake-cli` で実行した記録です。日本語の CLI メッセージには未対応のため、出力は英語のまま掲載しています。モデルは呼び出していません。対話型ターミナルがなければ、カードを表示して承認を待ちます。ローカルパスの先頭だけを `<log directory>`、`<data home>`、`<project>` に置き換え、ID、ハッシュ、日時は実行時の値を残しています。

```text
Plan written to <log directory>\1c3df8e9-f699-4351-9b16-a9368eae3436\b8f6c4b8-44a9-4f23-8a08-12bae14a6110\add-readme.plan.json

Work order:   .review-bridge/work-packages/add-readme.md
              New work order "Add a README to the project"
Stops:        after the review
Scope:        the whole project except protected files (23 patterns)
Tests:        not configured (no test rule matched; the work starts without tests)
Priority:     medium (config)
Writer:       claude (config), model the CLI's default (priority table), effort medium (priority table)
Reviewer:     codex (config), model the CLI's default (priority table), effort medium (priority table)
Reviewer MCP: none
Budget:       tokens 4000000 (config), tokens_per_call 1500000 (config), call_timeout 900000 (config), test_timeout 600000 (config), run_timeout 21600000 (config), rounds 2 (config)
Contract:     sha256 8d086cae7ac4a9cb7202943d6ff17540235a0b0a6bed7ef4024161683c6e82e3, 2 condition(s) cut from the acceptance list
Valid until:  2026-11-11T04:44:59.223Z

The work order, as sealed:
  │ ---
  │ source_id: DOC-1
  │ ---
  │ # Add a README to the project
  │
  │ <!-- bridge:context -->
  │ ## Background
  │ The project has no README, so new teammates do not know how to start it.
  │
  │ <!-- bridge:requested_work -->
  │ ## Requested work
  │ Add README.md at the project root, explaining the project and how to start it.
  │
  │ <!-- bridge:acceptance -->
  │ ## Acceptance
  │ 1. README.md exists at the project root, with the project name on its first line.
  │ 2. The README has a "Getting started" section.
  │
  │ <!-- bridge:open_questions -->
  │ ## Open questions
  │ none

Needs authorization. If the person says yes, run again: npx review-bridge start .review-bridge/work-packages/add-readme.md --fake-cli --yes
```

- 値の後の括弧は、フラグ、作業指示、priority 表、設定ファイルのどこから来たかを示します。
- `Contract` は固定したコントラクトの SHA-256 と、コードで分割した完了条件の数です。作成にモデルは使わず、結果のトークン数は 0 です。
- 下半分は承認対象の**固定した作業指示の原文**です。後の編集を使うには、再び `start` が必要です。
- `Valid until` は有効期限（24 時間）で、現在は UTC 表示です。期限切れ後は新しいカードを作ります。
- `Reviewer MCP` は追加で許可したサーバーの一覧で、既定は `none` です。
- `Work order` の次の行は、今回どの作業指示を承認するかを示します。次の節で説明します。
- `Plan written to`、`Reviewer read-only check` などの前置きと、各ステップのメッセージは現在英語のみです。

## カードと作業指示の識別 {#work-order-identity}

最初の承認時に Bridge が frontmatter へ `id` を追加し、その版をデータベースに記録します。この行は削除しないでください。コントラクトの SHA-256 には含めません。上の英語の作業指示には、次のように追記されました。

```markdown
---
id: d1626c15-7f6a-4cb1-8899-64807c20a50a
source_id: DOC-1
---
# Add a README to the project
```

次回以降はこの `id` で識別し、カードの `Work order` の下に判定を表示します。

| カードの表示 | 表示される場合 |
|---|---|
| New work order “…” | `id` がない、または DB に登録がない |
| Updates “…”, still version N, with new run settings | 原文は同じで、役割や予算などの設定が変わった |
| Updates “…”, version N → N+1, X lines changed | 作業指示の内容が変わった |
| Updates “…” (was at …) | 改名・移動した元のファイル。同じ作業指示 |
| A copy of …, recorded as a new work order “…” | 同じ `id` の元ファイルが残るコピー。承認時に別の ID を付与 |

同じファイルへのハードリンクはコピーではなく、同じ作業指示として扱います。ファイルシステムのファイル ID で判別し、ID を取得できない場合は推測せず拒否します。

判定が違う場合は、次の指定で新しいカードを表示できます。

- `--update <work_order_id>`：指定した作業指示の新しい版として扱います。別ファイルに内容を貼り付けても履歴を引き継ぎたい場合などに使います。`work_order_id` は元のファイルの frontmatter の `id` です。
- `--as-new`：別の作業指示の `id` が入っていても、新しい作業指示として扱います。

2 つは同時に指定できず、単一ファイルだけに使えます。フォルダーには使えません。旧版の実行中に編集後の作業指示を開始すると、まずカードで通知し、新版の開始時に旧 run を `cancelled`、理由 `superseded` で停止します。

## フォルダー内の作業指示をまとめて実行する

`.review-bridge/work-packages/` のサブフォルダーに作業指示をまとめ、そのフォルダーを `start` に渡します。

```sh
npx review-bridge start .review-bridge/work-packages/demo/
```

- ファイル名順に処理します。`01-`、`02_` などの番号を使え、番号なしは最後です。
- 全件を検証してから、ファイル名と各コントラクトの SHA-256 を 1 枚のカードに表示します。本文は載せません。承認は一度で、各作業指示に別の run、承認記録、コントラクトを作ります。
- 1 件失敗しても次へ進みます。provider のログアウト、利用枠の消費、`stop`、Ctrl+C は全体を停止します。
- 再び同じフォルダーを開始すると、完了済みと記録された作業指示をスキップします。
- 進捗は `status`、終了時は一覧表で確認できます。結果は `results/<フォルダー>/<作業指示>/` です。
- 実行場所はプロジェクトの作業フォルダーです。2 つ同時に始めると共有するため、先の処理が終わってから次を開始してください。

## 実行中の表示

承認後はステップごとに進捗を表示します。同じ模擬実行で、カードの再表示に続いて出力された部分です。プロジェクトのローカルパスは `<project>` に短縮しています。

```text
Reviewer read-only check: not needed with the fake CLI (no model is called)

  Writer working (call 1 of 2)
  Tests: not configured for this project
  Reviewer checking the work
Delivered: no tests configured, reviewer passed
Result file: <project>\.review-bridge\results\add-readme\DOC-1 add-readme 2026-11-10 12-45-02 success.md
Tokens: writer 153246, reviewer 60400
```

処理の順序は次のとおりです。

1. **reviewer の読み取り専用制限を確認。** 実際の CLI ではモデルを一度呼び出して検証し、`Reviewer read-only check: passed` と表示します。同じローカルページのセッションでは結果を再利用します。失敗したら実行しません。模擬 CLI はモデルを使わず、`not needed with the fake CLI` と表示します。
2. **プロジェクトの graph を更新。** Git が報告する変更ファイルだけを再読込します。次の節で説明します。
3. **writer が実装。** 最大 `rounds` 回まで実装・修正します。
4. **Bridge がテスト。** 未設定ならそのまま進め、カード、記録、結果に未設定と明記します。
5. **完了条件を個別に審査。** reviewer が確認し、Bridge が成立するかを判定します。未完了で回数が残っていれば 3 に戻ります。
6. 結果ファイルを作成。末尾の 3 行は結論、結果パス、トークン数です。run ID は `status` で確認してください。

データベースが応答しなくなると、理由 `database_unavailable` で停止し、以後モデルを呼び出しません。ターミナルにも利用できないと表示します。その間にファイルへ保存した記録は、次にデータベースを開くコマンドが書き戻します。復旧後に `start` を実行し直してください。

## プロジェクトのコード索引（graph） {#project-graph}

`init` は関数、クラス、型の定義、参照、ファイル間の import を索引にします。JavaScript、TypeScript、`.vue` の script、Python、Go、Rust、Java、Kotlin、C++、C# に対応します。JavaScript・TypeScript 以外の parser は初回利用時に npm で Bridge のデータディレクトリへ追加します。npm・pnpm workspace では、そのパッケージと依存する workspace パッケージを対象にします。

- graph はデータベースに保存し、プロジェクトにファイルは作りません。
- `init` の最後にファイル、定義、参照、import の数を表示します。解析できない箇所や parser のないファイルは不完全として列挙し、黙って集計から落としません。
- `start` は Git が報告する変更分だけを更新します。失敗時は更新できなかったことを通知し、両方の役割が旧 graph を使うことを結果にも明記します。全体の再構築は `npx review-bridge graph` です。
- writer の呼び出し前に Bridge が作業指示の文章から graph を検索し、結果を prompt に含めます。レビューでも同様です。トークン表の `graph lookups` は SQL 回数と prompt の推定トークン数で、両役割の input に計上済みです。
- 両方の役割は読み取り専用 MCP サーバー `review-bridge-graph` に直接問い合わせることもできます。ただし、この版で計測した run では、自らのツール呼び出しはありませんでした。

## 停止・再実行・整理

- `stop <run_id>`：モデルのプロセスを停止し、記録は残します。
- `resume <run_id>`：同じ作業指示に**新しい run** を作り、停止位置と範囲を引き継ぎます。役割、モデル、effort、予算を決め直し、カードで再承認を求めます。
- ID なしの `clean`：終了済み記録を日別にまとめ、保持期限を過ぎたものを削除します。`clean <run_id>` は指定した終了済み run だけを削除し、実行中は拒否します。`clean --all` はプロジェクトの全 DB 記録を消し、ID を廃止します。再利用には `uninstall`、`init` の順で実行してください。

単一ファイルの `start` 中に Ctrl+C を押すと、コマンドは終了しても run が続く場合があります。`npx review-bridge status` で探し、`npx review-bridge stop <run_id>` で止めてください。

## データベースとローカルページの操作 {#database-and-page}

データベースは初回利用時に作成・起動し、ターミナルや VS Code を閉じても動き続けます。手動操作には次を使います。

| コマンド | 動作 |
|---|---|
| `npx review-bridge up` | データベース、ページの順にバックグラウンド起動 |
| `npx review-bridge down` | ページ、データベースの順に停止。実行中の run があれば一覧を表示して拒否 |
| `npx review-bridge ps` | ページの動作状態と URL を表示 |
| `npx review-bridge watch` | このターミナルでページを実行。Ctrl+C で終了 |

`down` の実行後は次のようになります。

```text
$ npx review-bridge down
Page stopped.
Database stopped.
$ npx review-bridge status
Page: not running; start it with npx review-bridge up
Database: stopped; npx review-bridge up starts it, and so does the next start.
```

`status` は状態を表示するだけで、データベースを起動しません。

Bridge は**自動でコミット、push、デプロイを行いません**。結果ファイルに変更ファイルが並ぶので、内容を確認してコミットするか判断してください。続いて[結果・ログ・データベース](./results)を参照してください。
