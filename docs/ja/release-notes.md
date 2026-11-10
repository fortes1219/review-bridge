# リリースノート

[Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) と [Semantic Versioning](https://semver.org/lang/ja/) に沿って記載しています。英語の原文はリポジトリの `CHANGELOG.md` です。

## 0.3.0-rc.3（2026年11月10日）

最初のリリースです。

### 追加

- **パッケージマネージャーから実行。** `npx review-bridge init` で初期化でき、グローバルインストールは不要です。`npm i -g review-bridge` も利用できます。案内コマンドは起動元に合わせ、npm・不明時は `npx review-bridge …`、ほかは `pnpm dlx review-bridge …`、`yarn dlx review-bridge …`、`bun x review-bridge …` です。バージョンは固定せず公開済みの `latest` を使い、グローバル版があれば `npx` はそのコピーを使います。設定案内、`status`、エラー後の手順、エージェント入口、VS Code タスクに適用し、`--help` だけは実行ファイル名を使います。Node.js 22.8 以降が必要です。
- **対話式の初期設定。** create-vite に倣い、writer、reviewer、種類、VS Code タスクを既定値付きで尋ねてから設定します。進捗はステップごとに 1 行、最後に次のコマンドを表示します。追加の確認や計画表示はありません。オプションで直接指定でき、対話型ターミナルがなければ既定値を使います。種類がテストコマンドを決め、`none` も選べます。
- **プロジェクト内の保存先を限定。** 同意した VS Code タスク以外は `.review-bridge/` の設定、規則、テンプレートだけを作成します。専用 `.gitignore` の `*` で全体を Git の対象外にし、後から Git を初期化しても同様です。`git status` はクリーンなままで、`.claude/`、`AGENTS.md`、`CLAUDE.md` は変更しません。
- **ユーザー単位のエージェント入口。** Claude Code は `~/.claude/commands/review-bridge.md`（`CLAUDE_CONFIG_DIR` に対応）、Codex は `~/.agents/skills/review-bridge/SKILL.md` に配置します。`/review-bridge` と `$review-bridge` が start、stop、resume、clean とユーザーの承認を教えます。既存のユーザーファイルは維持し、最後のプロジェクトの削除時に未編集の Bridge 専用ファイルだけを削除します。
- **コードを探すための graph。** `init` が JavaScript、TypeScript、`.vue` の script、Python、Go、Rust、Java、Kotlin、C++、C# の定義、参照、import 先を DB に保存します。最後に各件数と不完全な解析の一覧を表示し、プロジェクトには graph ファイルを作りません。JS・TS 以外の parser は初回に npm で Bridge のデータ領域へ追加します。npm・pnpm workspace では依存する workspace パッケージも対象です。`start` は Git の変更分だけを更新し、`npx review-bridge graph` で全体を再構築します。両方の役割に読み取り専用 MCP サーバー `review-bridge-graph` を提供します。
- **モデルを使わないコントラクト作成。** 作業指示をフォームとして検証し、原文を転記します。トークン表は 0 です。完了条件は VitePress と同じ markdown-it で分割します。作業内容（`requested_work` または `run_plan`）と完了条件は必須です。内容不足、`一、`・`（1）` のような不正なリスト、未回答の質問があればカードの前で停止して列挙します。必須マーカーと見出しが消えていれば末尾に補い、既存の文章は変えません。`# ` タイトルは任意で、省略時は `untitled` です。
- **役割ごとの model・effort。** frontmatter の `writer:`・`reviewer:` の `model` と `effort` が policy の priority 表を上書きします。トップレベルの `effort` は writer に適用し、両方の指定は拒否します。既定の `model: null` は CLI の既定値です。CLI の命名形式に合わないモデルはカードの前で拒否します。
- **カード 1 枚、一度の承認で開始。** `npx review-bridge start <file>` が計画し、コントラクトを示すカードを表示します。ターミナルでは `Start this work? [y/N]`、非対話環境では `Needs authorization` で停止します。承認後にエージェントが `--yes` で再実行します。`authorized_via`（`terminal`・`agent`）と原文の SHA-256 を記録し、直近のカードの計画だけを使います。未表示、内容・オプション変更、`Valid until` 超過、使用済みのカードは拒否し、何も承認・実行しません。次のコマンドも案内します。
- **作業指示の識別と版。** 最初の承認時に frontmatter へ `id` を追加して履歴を DB に保存します。改名・移動でも同じ作業指示、編集は新版、元の ID を持つコピーは別 ID、同じファイルのハードリンクは同一です。ファイル ID を取得できない環境は拒否します。ファイル名は各文字体系の文字、数字、結合文字、`.`、`_`、`-`、単一空白を使え、80 文字・180 バイトまでです。NFC で比較・保存します。カードで識別結果を確認し、`--update <work_order_id>`・`--as-new` で指定できます。
- **複数の作業指示を順番に実行。** `start <directory>` は `.review-bridge/work-packages/` のサブフォルダーを対象に、`01-`・`02_` などのファイル名順、番号なしは最後に処理します。全件検証後、本文を省いたカードを一度承認し、各件に別の run、承認、コントラクトを作ります。1 件失敗しても続行し、ログアウト、利用枠切れ、`stop`、Ctrl+C で全体停止します。再実行時は完了済みをスキップします。`status` に進捗、最後に結果一覧を表示し、`results/<directory>/<work order>/` に保存します。
- **停止・再開・削除。** `stop <run_id>` は記録を残して停止し、`resume <run_id>` は同じ停止位置と範囲で新しい run を始めます。`clean [<run_id>]` は終了済み記録、`clean --all` はプロジェクトの DB 記録を削除します。
- **どちらの provider も両方の役割に対応。** `claude`・`codex` の 4 通りを独立セッションで実行できます。`bridge.json` または `start`・`resume`・`work-plan` の `--writer`・`--reviewer` で選び、カードに表示して実行中は固定します。DB と結果ヘッダーに provider、model、effort を残します。
- **reviewer の読み取り専用チェック。** 実装前に権限制限を確認します。Codex は OS サンドボックスが実際の書き込みを拒否することを検証し、中国語 Windows の PowerShell エラーにも対応します。Claude Code は plan mode の `Read`・`Grep`・`Glob` と、レビュー時と同じ graph・policy 許可サーバーだけを使って確認用ファイルへの書き込みを試します。ファイルがなく、CLI が完了し、`init` が設定を確認できた場合だけ通過します。
- **個人用コネクターの分離。** Claude Code の全呼び出しに `--strict-mcp-config` を指定し、プロジェクトの `.mcp.json` は writer のみに渡します。Codex は `--disable apps --disable plugins` と `codex mcp list` の各サーバーを無効化し、一覧を取得できなければ開始しません。`reviewer.mcp_allow` は既定で空です。指定したサーバーは追加の制限なしで渡し、カード、DB、結果に記載します。
- **Bridge 自身が検証を実行。** writer の各呼び出し後にプロジェクトのテストを実行します。未設定でも作業は進み、カード、記録、結果に明記します。テストがある場合は、writer が質問なしで `blocked` としてもテスト・レビューへ進みます。テストがなければ停止してユーザーに戻します。
- **writer のトークン予算。** `tokens`・`tokens_per_call` は writer だけに適用し、cache read は除外して別記します。reviewer の使用量は記録しますが予算には含めません。
- **根拠を残す結果ファイル。** run ごとに `results/<work order>/` へ保存し、判定と理由を示します。判断待ちは writer 自身の説明を記載します。`Files changed` は Git の変更、未照合の申告、実行前の変更を分けます。
- **PostgreSQL の監査記録。** ユーザーごとに共通の組み込み PostgreSQL 18 を初回作成し、作業指示、版、カード、承認、コントラクト、run、連番イベント、各判定、成果を保存します。状態変更とイベントは同一トランザクションです。`clean <run_id>` は run と従属記録をまとめて削除しますが、承認は使用済みとして残して再利用を防ぎます。`.review-bridge/` とログはコピーです。
- **データベースの起動・停止。** ターミナルや VS Code を閉じても継続します。`up` は DB、ページの順、`down` は逆順に止め、`docker compose down` と同じく起動したものをまとめて扱います。実行中の run があれば一覧を表示して停止を拒否します。`status` は DB を起動しません。保存先の欠落・読み取り不可・内容不正はパスと `pg_ctl status` と同じ終了コード 4 で通知します。起動失敗では待機時間と最新のサーバーメッセージを示します。死んだサーバーの残したファイルは起動時に消さず、プロセスが残る場合は再起動を案内します。
- **マイグレーション前のバックアップ。** 新版の最初のコマンドがバックアップ先を表示してから適用します。run 実行中は拒否します。未知のマイグレーションがあれば列挙し、何も変更せず DB を開きません。run がなければ `backup` で手動作成もできます。
- **DB 切断時は停止。** `database_unavailable` で run を止め、以後モデルを呼び出しません。その間の記録は次に DB を開くコマンドが書き戻します。
- **照会できる実行状態。** `status`・`work-status`・`doctor` が DB からページ、状態、終了理由、元ファイル、開始時刻を取得します。1 ページ 10 件で、続きは `--after <run_id>`、JSON は `--json` です。`status` にホスト、ポート、DB、ユーザー、パスワードファイルを表示し、VS Code の PostgreSQL 拡張や SQLTools で接続できます。
- **CLI の言語対応。** `init`、`status`、`up`、`down`、`ps`、カードは英語・繁体字中国語に対応します。create-vue に倣ってシステムから検出し、プロジェクトの言語に従います。
- **VS Code タスク。** Quick Open の `task review-bridge` から start、stop、resume、clean、status、logs を実行できます。`init` でプロジェクトの `.vscode/tasks.json` への追加を選ぶか、`npx review-bridge vscode`、ユーザー共通なら `npx review-bridge vscode --user` を使います。既定では追加しません。既存のタスク、コメント、書式は残し、`uninstall` は Bridge の項目だけを削除します。
- **Windows の文字コード診断。** PowerShell が UTF-8 を出力せず Codex の表示が文字化けする場合に、`doctor` が状態と `$PROFILE` へ追加する設定を案内します。
- **自動生成のコマンド説明。** コマンド定義から `--help` を生成し、型、既定値、説明を表示します。`--help --all` は `work-plan`・`work-start` なども含み、`--version` はバージョンを表示します。

### 既知の制限

- Windows で同じカードに同時に 2 回 `--yes` を送ると、2 回目が使用済みの案内ではなくファイルエラーになる場合があります。開始する run は 1 件だけです。承認は一度にしてください。
- Windows の Git `core.autocrlf` では、改行だけの違いも変更の証跡に含まれます。`start` 前に commit または stash してください。
- writer は実装中に回答待ちしません。事前に曖昧な点を解消してください。`open_questions` の未回答行は開始を阻止します。
- writer はプロジェクトのテストを実行・編集することがあり、Bridge は阻止も表示もしません。証拠は各呼び出し後の Bridge 自身のテスト結果です。変更一覧を確認してください。
- `npx` は最新版確認のためネットワークを使います。`npm i -g review-bridge` なら照会を省き、その後の `npx review-bridge` もインストール済みの版を使います。
- 単一ファイルの `start` で Ctrl+C を押しても run が続く場合があります。`npx review-bridge status` で探し、`npx review-bridge stop <run_id>` で止めてください。
- この版の計測では、writer と reviewer が自ら graph ツールを呼ぶことはありませんでした。
- `work-plan`・`work-start` など一部のメッセージは未翻訳です。
- カードの `Valid until` は UTC 表示です。
- 最後の出力行に run ID はありません。`npx review-bridge status` で確認します。
- フォルダー単位の実行はプロジェクトの作業領域を共有します。同時に 2 つ実行せず、先の処理の終了を待ってください。
- `vscode` は `npx review-bridge --help` に載りません。`npx review-bridge vscode --help` で確認できます。
- 証跡は Bridge の確認時点を比較するものです。確認の間に変更して元に戻したファイルは検出できません。
- Windows x64 のネイティブ実行は検証済みです。Apple Silicon macOS は選択可能ですが未検証で、Linux は実行を拒否します。
- 別の PostgreSQL メジャーバージョンへの移行には dump と restore が必要で、この版は対応しません。
