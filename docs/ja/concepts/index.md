# 基本概念

Review Bridge は、独立した 2 つの AI エージェントで作業指示を実行します。**writer** が変更を実装し、**読み取り専用の reviewer** が成果を確認します。変更範囲、予算、検証コマンド、人に判断を戻す停止位置は Bridge が設定に基づいて決定します。エージェントがこれらの制限を変更することはできません。

このドキュメントでは、1 回の実行を **run**、エージェントの作業セッションを **session**、役割に割り当てる CLI（`claude` または `codex`）を **provider** と呼びます。**policy** は Bridge がコードで適用する実行ルールです。

> 設計の背景は [AI 導入後の開発プロセスと検証責任について](https://hackmd.io/@FortesHuang/HJnWgQGJMx)（HackMD、中国語）で説明しています。

## 1 回の実行の流れ

```text
作業指示 .md
  → 形式を検証し、各ブロックをコントラクトへ転記（モデル呼び出しなし）
  → 範囲・予算・テストコマンド・停止位置を計画として固定
  → カードを表示し、ユーザーが承認
  → reviewer の読み取り専用制限を確認し、プロジェクトの graph を更新
  → writer が最大 rounds 回の実装・修正を行い、各回の後に Bridge がテスト
  → reviewer が審査し、Bridge が完了条件ごとに判定
  → 結果ファイルを作成
  → ユーザーが成果を確認し、コミットするか決める
```

作業指示のバージョン、計画、承認、コントラクト、run、イベント、判定、納品はデータベースに記録します。結果ファイルは、内容を読むためのコピーです。

## 役割

`claude` と `codex` はどちらも writer、reviewer を担当でき、4 通りの組み合わせに対応しています。`bridge.json` で設定するか、`--writer`／`--reviewer` で今回の実行に限って指定します。モデルと推論の強度（effort）は作業指示の `writer:`／`reviewer:` ブロックで指定し、省略した値は policy の priority テーブルから取得します。

**実行中に役割は変わりません。** `bridge.json` の変更は次の `start` から有効になり、カードに組み合わせが表示されます。

同じ provider を使う場合も、各役割は別の CLI プロセスとセッションで動作します。reviewer は Bridge が別途起動します。writer のサブエージェントによる確認は、独立レビューとして扱いません。

| アクセス | 役割 | Claude Code | Codex |
|---|---|---|---|
| `read` | reviewer | `--permission-mode plan --tools Read,Grep,Glob --disallowedTools Write,Edit,NotebookEdit,Bash,PowerShell --strict-mcp-config --no-session-persistence`。`--mcp-config` で Bridge の graph サーバーと `reviewer.mcp_allow` のサーバーを追加 | `exec --ephemeral --sandbox read-only`。`-c mcp_servers.…` で Bridge の graph サーバーを追加 |
| `write` | writer | `--permission-mode auto --strict-mcp-config`。`--mcp-config` で Bridge の graph サーバーと、存在する場合はプロジェクトの `.mcp.json` を追加 | `app-server`。thread の `sandbox: workspace-write`、`approvalPolicy: never` と Bridge の graph サーバーを設定 |

Bridge の読み取り専用サーバー `review-bridge-graph` は、定義の場所、参照元、変更の影響先を調べるためのものです。[プロジェクトのコード索引](../guide/start#project-graph)を参照してください。

## reviewer の読み取り専用制限を確認する

`start` と `resume` は承認後、実装を始める前に reviewer の読み取り専用制限を確認します。この確認自体がモデル呼び出しです。結果はローカルページサービスのメモリに provider ごとに保存し、同じページのセッションでは一度だけ確認します。provider によって得られる証拠は異なります。

- **Codex**：権限確認用ファイルへの書き込みを試し、OS のサンドボックスが拒否することを確認します。
- **Claude Code**：CLI の `init` イベントで plan mode と `Read`、`Grep`、`Glob` だけが使われていること、確認用ファイルが作成されていないこと、CLI が正常終了したことを確認します。Bridge の graph サーバーと policy で許可したもの以外のツールがあれば、MCP ツールも含めてチェックは失敗し、実行しません。

## 個人用コネクターの分離

Bridge が起動するセッションは個人用 MCP コネクターを引き継ぎません。Claude Code の全呼び出しに `--strict-mcp-config` を指定し、Bridge が指定したサーバーだけを読み込みます。プロジェクトの `.mcp.json` は writer のみ、Bridge の graph サーバーは両方の役割に渡します。reviewer の権限確認と各レビューは同じサーバー設定を使い、確認時の `init` イベントに想定外のツールがあれば実行しません。

Codex の呼び出しはすべて `--disable apps --disable plugins` を使い、`codex mcp list` が返すサーバーを個別に無効化します。リストを読み取れなければ作業を開始しません。

reviewer に追加の MCP サーバーを許可するには、プロジェクトの policy の `reviewer.mcp_allow` に名前を指定します。これらのサーバーは**読み取り専用かどうかを検証せず**に渡し、カードにもその制限を表示します。この許可は reviewer だけに適用し、writer には渡しません。

## コントラクトと承認

- `start` は作業指示の原文、範囲、予算、テストコマンドを計画として固定します。承認の対象は、その計画と作業指示です。
- コントラクトはカードの表示前にコードで作成します。各ブロックをそのまま転記し、完了条件のリストを番号付きの条件に分割します。モデルは呼び出しません。カードの `Contract` 行に SHA-256 を示し、1 枚のカードに 1 回の承認で実行します。
- 承認記録は作成後に変更できません。欠落、不正、期限切れ（24 時間）、使用済みの承認では実行しません。
- 実行開始後に作業指示を編集しても、承認済みの内容は変わりません。`start` を実行し直すと、新しい版と承認カードを作成します。
- `source_id` は既存の課題管理ツールとの対応づけに使います。Bridge 内の識別や実行ルールを決めるものではありません。結果ファイルや `logs` から検索できます。

## テストは Bridge が実行する

writer の各ラウンド後に、Bridge がエージェントのサンドボックスの**外**で、プロジェクト種別に対応するテストコマンドを実行します。テストが成功してからレビューに進みます。writer がテストを実行できないと報告しても、Bridge 自身が実際の結果を取得できます。テストコマンドが未設定でも作業は実行でき、カード、記録、結果にはテスト未実行と明記します。

## 変更の証跡

Git を使うプロジェクトでは、開始時のコミットを記録し、終了時に Git から変更を取得して Bridge の記録と照合します。結果では、Git の変更、Git と照合していない writer の申告、開始前からあった未コミットの変更を分けて表示します。Git がなければ、変更の証跡を提供できないと明記します。

## プロジェクトのファイルと実行データ

プロジェクトのファイルと実行記録は分けて保存します。設定、作業指示、結果のコピーは `.review-bridge/` に置き、そこに `*` だけの `.gitignore` を用意して Git の対象外にします。プロジェクトの `.gitignore`、`AGENTS.md`、`CLAUDE.md`、`.claude/`、既存の skills は変更しません。エージェント用の入口はユーザー単位で共用し、実行記録は OS のデータ・ログディレクトリに保存します。

## セキュリティモデル

- 承認が欠落、不正、期限切れ、使用済みの場合は、実行を拒否します（fail closed）。
- writer と reviewer は別セッションです。読み取り専用の確認方法は上記のとおりです。
- ネイティブ環境でモデルを動かすには、カードへの承認（ターミナルで直接、またはエージェントが `--yes` で伝達）と、ローカルページサービスが保持する reviewer の確認成功が必要です。エージェントによる無断承認の防止は、エージェント側のツールの権限確認が担当します。
- Bridge はコミット、push、デプロイ、公開を行いません。
- Bridge の状態はローカルファイルシステムに保存します。同期フォルダーやネットワークフォルダーは拒否します。
