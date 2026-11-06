# よくある質問

実際の利用で起きた問題と、その対処方法をまとめています。

## 作業の開始

### Claude Code で /review-bridge が見つからない

`init` は全プロジェクト共用の入口を `~/.claude/commands/review-bridge.md` に配置します。`CLAUDE_CONFIG_DIR` が設定されていれば、その下の `commands/` に置きます。まずファイルがあるか確認してください。なければ、未設定のプロジェクトで `review-bridge init` を実行します。Codex の入口は `~/.agents/skills/review-bridge/SKILL.md` で、`$review-bridge` で呼び出します。

### start で Codex または Claude が未ログインと表示される

エラーに `codex login` などのログインコマンドが表示されます。ログイン後、同じ `start` を再実行してください。`review-bridge roles-check` では、モデルを呼び出さずに両方の役割の CLI インストールとログイン状態を確認できます。

### 未知の key があるとして作業指示が拒否される

frontmatter が受け付けるのは `priority`、`writer`、`reviewer`、`budget`、`source_id` と、旧形式のトップレベル `effort` だけです。ブロックマーカーはコントラクトの 17 フィールドに限られます。エラーには行番号が表示されます。[最初の作業指示](./guide/work-order)を参照してください。

### モデルを呼ぶ前に、未回答の質問があるとして停止する

`open_questions` の各行は、`無`、`none`、空白以外なら未解決の質問です。作業指示で回答するまで Bridge は停止します。受け入れ条件が 1 つもない場合も停止します。

### カードの有効期限が切れた

カードは 24 時間有効で、`Valid until` に期限を表示します。`start` を再実行して新しいカードを作成してください。

### 作業指示を編集したら、新しい内容が実行される？

`start` の再実行が必要です。承認は確認した原文にだけ適用されます。開始後の編集は結果の「Work order changed after the start」に表示され、今回の実行に使っていないことを説明します。

## reviewer とコネクター

### Claude を reviewer にすると読み取り専用の確認に失敗する

reviewer セッションで許可されるツールは `Read`、`Grep`、`Glob` だけです。`init` イベントに MCP を含む追加ツールがあれば、確認は失敗し、作業は始まりません。呼び出しには毎回 `--strict-mcp-config` を付けています。それでも追加ツールがある場合は、診断メッセージに従って実際に読み込まれたツールを確認してください。

### Reviewer MCP: none の意味は？

Bridge は個人用 MCP コネクターを分離します。Claude の connectors と、`codex mcp list` にあるサーバー（`node_repl` を含む）が対象です。`none` は reviewer に MCP サーバーが渡されていないことを示します。

許可するサーバーはプロジェクト policy の `reviewer.mcp_allow` に追加します。現在、これらのサーバーの読み取り専用検証は行わず、カードにその制限を表示します。[基本概念](./concepts/)を参照してください。

### Codex writer がテストを実行できない（spawn EPERM）

Windows 上の Codex 0.166 のサンドボックスでは、`npm test`（Vitest）が `spawn EPERM` で失敗することがあります。writer の各ラウンド後、Bridge がエージェントのサンドボックスの**外**でプロジェクトのテストを実行します。受け入れ判定には Bridge が取得した結果を使います。

## 結果

### writer は変更したと言うのに、結果には No files were changed と表示される

「Files changed」の最初の一覧は Git に基づきます。writer の報告は「What the writer says it changed (not checked against Git)」に別途表示します。異なる場合は、Git の一覧と「Already uncommitted when the run started」を照合してください。writer の報告だけでは変更の証拠になりません。

### 結果ファイルとログはどこにある？

プロジェクトの `.review-bridge/results/<作業指示>/` に結果のコピーがあります。prompt、ストリーム、stderr、テスト出力、計画、承認カードを含む完全なログは OS のログディレクトリに保存します。`review-bridge status` の `Logs:` で場所を確認でき、`review-bridge logs <run_id>` で各ファイルの用途を確認できます。[結果・ログ・データベース](./guide/results)も参照してください。

### .vscode/tasks.json が未コミットの変更として結果に出る

`.vscode/tasks.json` を Git で追跡するかは自分で決めます。Bridge は自動で追加も除外もしません。コミットするか追跡対象から除外するまでは、未コミットの変更として扱われます。

## データベースと環境

### データベースのポートが 5432 ではない

5432 が使用中なら、起動のたびに次の空きポートを順に探します。現在のポートは `init` と `review-bridge status` に表示されます。別の番号から探すには、data home の `settings.json` に `"database": { "port": 5440 }` を追加します。

### OneDrive やネットワークドライブ上のプロジェクトで init が拒否される

Bridge の状態はローカルファイルシステムに保存する必要があります。OneDrive、Dropbox、iCloud Drive、UNC、NFS、SMB などの同期フォルダーやネットワークドライブは拒否します。プロジェクトをローカルディスクに移してください。

### 中国語版 Windows で Codex の出力が文字化けする

PowerShell の出力コードページと、Codex が使う UTF-8 が一致しない場合に起こります。`$PROFILE` に `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` を追加するか、PowerShell 7 を使ってください。`review-bridge doctor` で UTF-8 か確認できます。[アップグレード・バックアップ・削除 → Windows](./guide/maintenance#windows)を参照してください。

### bridge.json の役割変更はいつ反映される？

次の `start` からです。開始済みの run は役割を変更しません。各実行の組み合わせはカードに表示されます。

### Linux で使える？

Linux は実験段階で、ネイティブ環境でのモデル実行は既定で拒否します（fail closed）。Windows x64 はネイティブ検証済みです。Apple Silicon macOS は選択できますが、ネイティブ検証は未実施です。
