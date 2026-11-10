# 作業を実行する

`start <作業指示ファイル>` で作業を開始します。AI エージェント、VS Code、ターミナルのどこからでも同じコマンドを使います。異なるのは、**カードを確認して実行を承認する場所**です。

## Claude Code または Codex から

通常はこちらを使います。Claude Code では次のように入力します。

```text
/review-bridge start .review-bridge/work-packages/add-readme.md
```

Codex では `$review-bridge start .review-bridge/work-packages/add-readme.md` と入力します。

エージェントが最初に `start` を実行します。Bridge は作業指示、変更範囲、予算、検証コマンドを実行計画として固定し、ローカルページサービスのセッションごとに reviewer の読み取り専用制限を確認します。その後、承認カードを表示し、`Needs authorization` で停止します。

エージェントはカードを**原文のまま省略せずに提示**し、「Start this work?」と確認する必要があります。あなたが同意した場合に限り、同じコマンドに `--yes` を付けて再実行できます。この確認が実行の承認となり、記録にはエージェントが承認を伝えたことが残ります（`authorized_via: agent`）。

`/review-bridge` の操作はターミナルと同じ 4 つです。`start <file>`、`stop <run_id>`、`resume <run_id>`、`clean [<run_id>]` を使えます。

## VS Code から {#vs-code}

Bridge は `review-bridge: start`、`stop`、`resume`、`clean`、`status`、`logs` の 6 つのタスクを用意しています。Quick Open に `task review-bridge` と入力するか、`Terminal → Run Task` を選択します。

`start` はエディターで開いているファイルを使います。他のタスクでは run ID またはファイル名を入力します。コマンドは統合ターミナルで実行され、承認カードもそこで確認します。

| 配置先 | 追加方法 | 利用範囲 |
|---|---|---|
| プロジェクトの `.vscode/tasks.json` | `init` の最後の質問で y を選ぶか、`review-bridge vscode` を実行 | このプロジェクト |
| ユーザータスク（`Tasks: Open User Tasks`） | `review-bridge vscode --user` | すべてのプロジェクト |

`.vscode/tasks.json` を Git で管理するかは自分で決められます。Bridge は自動で追加も除外もしません。コミットするか追跡対象から除外するまでは、Git の変更として扱われ、結果にも未コミットの変更があると表示されます。

Bridge が管理するのは、label が `review-bridge:` で始まる task と、id が `review-bridge-` で始まる input だけです。それ以外の内容、コメント、書式は保持します。`uninstall` はこれらの項目を取り除き、他に何も残っていない場合に限りファイルを削除します。

ユーザータスクは VS Code の既定プロファイルに書き込みます。独自の tasks を持つ他のプロファイル、VS Code Insiders、VSCodium、ポータブル版では場所が異なるため、プロジェクト内で `review-bridge vscode` を使ってください。マルチルートワークスペースのユーザータスクは最初のフォルダーで実行されるため、作業指示のあるプロジェクトとは限りません。

## ターミナルから

高度な使い方や CI では、直接コマンドを実行できます。

```sh
review-bridge start .review-bridge/work-packages/add-readme.md
```

`start` は、人に判断を戻す停止位置（既定はレビュー後）を確認し、カードを表示してから `Start this work? [y/N]` と尋ねます。

| 操作 | コマンド |
|---|---|
| 作業指示を実行 | `review-bridge start <file>` |
| 記録を残して停止 | `review-bridge stop <run_id>` |
| 停止した作業指示を再実行 | `review-bridge resume <run_id>` |
| 終了した実行記録を整理 | `review-bridge clean [<run_id>]` |

実行中の作業と run ID は `review-bridge status` で確認できます。

## 承認カード

どの入口でも同じ形式のカードが表示されます。以下は、中国語の作業指示をモック CLI で実行した際の Linux 上の出力です。

```text
Work order:   .review-bridge/work-packages/add-readme.md
              New work order "幫專案補一份 README"
Stops:        after the review
Scope:        the whole project except protected files (23 patterns)
Tests:        not configured (no test rule matched; the work starts without tests)
Priority:     medium (config)
Writer:       claude (config), model the CLI's default (priority table), effort medium (priority table)
Reviewer:     codex (config), model the CLI's default (priority table), effort medium (priority table)
Reviewer MCP: none
Budget:       tokens 4000000 (config), tokens_per_call 1500000 (config), call_timeout 900000 (config), test_timeout 600000 (config), run_timeout 21600000 (config), rounds 2 (config)
Contract:     up to 2 work-order translation(s) by the writer (claude) and 2 check(s) by the reviewer (codex), 15 minute(s) per call
Valid until:  2026-11-06T23:31:11.999Z

The work order, as it will be sealed:
  │ ---
  │ source_id: DOC-1
  │ ---
  │ # 幫專案補一份 README
  │ …

Needs authorization. If the person says yes, run again: review-bridge start .review-bridge/work-packages/add-readme.md --yes
```

- 値の後ろの括弧は設定元を示します。`cli`、`work_order`、`priority`、`config` のいずれかです。
- 下半分には、**固定して保存される作業指示の原文**が表示されます。承認はこの内容にだけ適用されます。後から編集した内容を使うには、`start` を再実行してください。
- `Valid until` はカードの有効期限（24 時間）です。期限が切れたら新しいカードを作成します。
- `Reviewer MCP` は reviewer が使える MCP サーバーを示します。既定値は `none` です。

## 実行中の表示

承認後は各ステップの進捗が表示されます。対話型ターミナルでは、待機中に進行表示が出ます。

```text
  Writer (claude) turns the work order into a contract; reviewer (codex) checks it
  Contract sealed
  Writer working (call 1 of 2)
  Tests: not configured for this project
  Reviewer checking the work
Delivered: no tests configured, reviewer passed
Result file: /…/.review-bridge/results/add-readme/DOC-1 add-readme 2026-11-06 07-31-29 success.md
Tokens: writer 153246, reviewer 60400
```

実行順序は決まっています。まず writer が作業指示をコントラクトに変換し、reviewer が確認してから Bridge が内容を固定します。続いて writer が最大 `rounds` ラウンドの実装を行います。各ラウンド後に **Bridge がプロジェクトのテストコマンドを実行**し、reviewer が結果を審査します。最後に結果ファイルを出力します。

## 停止・再実行・整理

- `stop <run_id>`：モデルのプロセスを停止し、記録を残します。
- `resume <run_id>`：同じ作業指示を**新しい run** として実行します。停止位置と変更範囲は引き継ぎます。役割、モデル、effort、予算は再決定し、新しいカードで再び承認を求めます。
- run ID を付けない `clean`：終了した実行記録を日別ファイルにまとめ、保存期限を過ぎた記録を削除します。`clean <run_id>` は指定した終了済み run を削除します。実行中の作業は削除できません。

Bridge は**自動でコミット、push、デプロイを行いません**。結果ファイルに変更ファイルが並ぶので、内容を確認してコミットするか判断してください。続いて[結果・ログ・データベース](./results)を参照してください。
