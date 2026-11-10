# よくある質問

実際の利用で起きた問題と、その対処方法をまとめています。

## 作業の開始

### Claude Code で /review-bridge が見つからない

`init` は `~/.claude/commands/review-bridge.md` にコマンドを配置し、全プロジェクトで共用します。`CLAUDE_CONFIG_DIR` を設定している場合は、その配下の `commands/` を確認してください。ファイルがなければ、未初期化のプロジェクトで `npx review-bridge init` を実行します。Codex の入口は `~/.agents/skills/review-bridge/SKILL.md` で、`$review-bridge` から呼び出します。

### start で Codex または Claude が未ログインと表示される

エラーには `codex login` など、該当 CLI のログインコマンドが表示されます。ログインしてから同じ `start` を実行してください。`npx review-bridge roles-check` では、モデルを呼び出さずに両方の CLI のインストール・ログイン状態を確認できます。

### 未知の key があるとして作業指示が拒否される

frontmatter に指定できるのは `priority`、`writer`、`reviewer`、`budget`、`source_id`、トップレベルの `effort` と、Bridge が管理する `id` です。ブロックマーカーにはコントラクトの 17 項目だけを使えます。エラーには行番号が表示されます。[最初の作業指示](./guide/work-order)を参照してください。

### カードが表示されず、作業指示が未完成と言われる

`start` は作業指示をフォームとして検証します。作業内容と、Markdown のリストで書かれた完了条件が必要です。`open_questions` は空欄か、`none` または `無` だけにします。不備があるとカードの前で停止し、該当行と修正後の実行コマンドを表示します。モデルは呼び出しません。[実行前の形式チェック](./guide/work-order#work-order-validation)を参照してください。

### カードの有効期限が切れた

承認カードの有効期間は 24 時間です。期限は `Valid until` に表示され、現在は UTC 表記です。期限が切れたら `start` を実行し直して新しいカードを生成してください。

### 名前を変えただけなのに、コピーと判定される

Bridge は frontmatter の `id` で作業指示を識別します。元のファイルを改名・移動した場合は、移動前の場所を添えて更新と表示します。元のファイルが残り、両方に同じ `id` がある場合にコピーと判断します。判定が違う場合は `--update <work_order_id>` または `--as-new` で指定してください。[カードと作業指示の識別](./guide/start#work-order-identity)で説明しています。

### 作業指示を編集したら、新しい内容が実行される？

変更を使うには `start` を実行し直してください。承認の対象は確認済みの原文だけです。実行開始後に編集すると、結果ファイルの「Work order changed after the start」に、その変更が今回の実行に含まれていないことが記載されます。

## reviewer とコネクター

### Claude を reviewer にすると読み取り専用の確認に失敗する

Claude Code の reviewer が使えるのは `Read`、`Grep`、`Glob` と、Bridge の読み取り専用 graph サーバー、policy で許可したサーバーだけです。`init` イベントにそれ以外の MCP ツールなどが含まれると、チェックに失敗して実行しません。全呼び出しに `--strict-mcp-config` を指定しています。余分なツールが残る場合は、診断結果から実際に読み込まれたツールを確認してください。

### `Reviewer MCP: none` は何を意味する？

Bridge は Claude の個人用コネクターや、`node_repl` を含む `codex mcp list` のサーバーを分離します。`none` は reviewer に追加のサーバーを許可していないという意味です。Bridge の読み取り専用サーバー `review-bridge-graph` は両方の役割に提供され、この行には表示されません。

許可するサーバーはプロジェクト policy の `reviewer.mcp_allow` に追加します。現在、これらのサーバーの読み取り専用検証は行わず、カードにその制限を表示します。[基本概念](./concepts/)を参照してください。

### Codex writer がテストを実行できない（spawn EPERM）

Windows 上の Codex 0.166 のサンドボックスでは、`npm test`（Vitest）が `spawn EPERM` で失敗することがあります。writer の各ラウンド後、Bridge がエージェントのサンドボックスの**外**でプロジェクトのテストを実行します。受け入れ判定には Bridge が取得した結果を使います。

## 結果

### writer は変更したと言うのに、結果には変更なしと表示される

「Files changed」の最初の一覧は Git から取得したものです。writer の申告は「What the writer says it changed (not checked against Git)」に別記されます。食い違う場合は、Git の一覧と実行前からあった未コミットの変更を照合してください。writer の申告だけでは変更の証拠になりません。

### 結果ファイルとログはどこにある？

閲覧用の結果はプロジェクトの `.review-bridge/results/<作業指示>/` にあります。prompt、ストリーム、stderr、テスト出力、計画、承認カードを含む詳細ログは OS のログディレクトリに保存します。`npx review-bridge status` の `Logs` 行で場所を、`npx review-bridge logs <run_id>` で各ファイルの用途を確認できます。

### レビューは通ったが、追加の指摘が結果ファイルにない

成功した結果ファイルには、reviewer が確認したことと実行しなかったことを記載しますが、追加の findings は現在表示されません。データベースと、`status` の `Latest review` が示す審査ファイルに残ります。[結果ファイル](./guide/results#result-files)を参照してください。

### .vscode/tasks.json が未コミットの変更として結果に出る

`.vscode/tasks.json` を Git で追跡するかは自分で決めます。Bridge は自動で追加も除外もしません。コミットするか追跡対象から除外するまでは、未コミットの変更として扱われます。

## データベースと環境

### データベースのポートが 5432 ではない

5432 が使用中なら、起動のたびにそれより上の空きポートを探します。使用中のポートは `init` と `npx review-bridge status` に表示されます。探索開始位置を変えるには、data home の `settings.json` に `"database": { "port": 5440 }` を追加してください。

### OneDrive やネットワークドライブ上のプロジェクトで init が拒否される

Bridge の状態はローカルファイルシステムに保存する必要があります。OneDrive、Dropbox、iCloud Drive、UNC、NFS、SMB などの同期フォルダーやネットワークドライブは拒否します。プロジェクトをローカルディスクに移してください。

### 中国語版 Windows で Codex の出力が文字化けする

PowerShell の出力はシステムのコードページ、Codex の読み取りは UTF-8 のため、一致しないと文字化けします。`$PROFILE` に `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` を追加するか、PowerShell 7 を使ってください。`npx review-bridge doctor` でも UTF-8 の使用状況を確認できます。[Windows](./guide/maintenance#windows)を参照してください。

### `database_unavailable` で停止した

実行中にデータベースが応答しなくなると、run を停止し、以後モデルを呼び出しません。ターミナルにもデータベースを利用できないと表示します。その間にファイルへ保存した記録は、次にデータベースを開くコマンドが書き戻します。`npx review-bridge status` で状態を確認し、`npx review-bridge up` で起動してから `start` を実行し直してください。

### ターミナルを閉じてもデータベースが動いている

通常の動作です。ターミナルや VS Code を閉じても、データベースとローカルページは動き続けます。停止には `npx review-bridge down` を使います。いずれかのプロジェクトに実行中の run があれば、その一覧を表示して停止を拒否します。

### bridge.json の役割変更はいつ反映される？

次の `start` からです。開始済みの run は役割を変更しません。各実行の組み合わせはカードに表示されます。

### Linux で使える？

Linux ではネイティブ環境でのモデル実行を拒否します。Windows x64 は実機で検証済みです。Apple Silicon macOS は選択できますが、実機検証は済んでいません。
