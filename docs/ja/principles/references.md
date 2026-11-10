# 設計の参考資料

Bridge の設計は**オープンソースで確立された実践に従う**必要があります。そこから外れるものは設計上の失敗とみなします。各設計には参考にした前例が必要で、ソースコードまたは公式ドキュメントを根拠にします。README やスター数だけでは不十分です。このページでは参考元と取り入れ方をまとめています。

## VoidZero エコシステム

Bridge は Vue エコシステムを技術の方向性とし、VoidZero の Vite、Vitest、Rolldown、Oxc を現在と今後の設計の参考にしています。

| 実践 | 参考元 | Bridge での採用方法 |
|---|---|---|
| 1 コマンドに 1 つの責務。ヘルプをコマンド文書の基点にする | Vite・Vitest CLI | 16 コマンド。[リファレンス](../reference/cli)にヘルプの原文を掲載。README のコマンド説明は定義表から生成し、CI で更新漏れを確認。 |
| 設定の優先順序と設定元の記録 | Vite の設定解決 | policy limits を既定値とし、priority テーブル、作業指示、CLI フラグの順で適用。カードに設定元を表示。 |
| 共通インターフェースと provider ごとのモジュール | Vitest coverage の `provider` | `agentCli/calls.mjs` を共通入口に、`claude.mjs` と `codex.mjs` が各 CLI のフラグと出力を処理。 |
| ポートが使用中なら次の空きポートを探す | Vite dev server | ローカルページは `8080`、データベースは `5432` から検索。 |
| リポジトリの `docs/` に VitePress の 3 言語文書を置く | Vite・Vitest・VueUse | このサイト。 |
| 計画：oxlint の検証、重い計算を Rust に移し npm の JavaScript 入口を維持 | Oxc・Rolldown の napi-rs | 今後の方向。[アーキテクチャとロードマップ](./architecture)を参照。 |

## その他の参考元

各設計判断の参考元をまとめた表です。

| 設計項目 | 参考元 | Bridge での採用方法 |
|---|---|---|
| Markdown 作業指示と YAML frontmatter | Astro content collections | 先頭の `---` から次の `---` まで。全フィールドは任意、未知の項目は拒否。 |
| 作業指示の必須内容 | Jira の issue 必須項目 | 作業内容と完了条件は必須、タイトルは任意。不具合では環境、手順、実際・期待する結果、頻度も記載 |
| 保存済み計画を適用し、後の設定変更を含めない | Terraform `plan -out` → `apply` | start のカードと人の承認。`upgrade --plan-out` → `--plan --approve <sha>`。 |
| 編集した作業指示を再実行し、旧 run を停止 | GitHub Actions `concurrency` + `cancel-in-progress` | 置き換えられる版は stop と同じ停止処理。新 run の作成時に `superseded_by` を設定。 |
| run ごとの時間制限 | GitHub Actions job の `timeout-minutes` | `budget.run_timeout`。期限到達時に `timed_out` で終了。 |
| サーバーが採番し、クライアントは差分を取得 | Temporal sticky cache | イベントファイルはキャッシュ。遅れていれば再構築、先行していれば拒否、不一致ならデータベースを優先。 |
| 切断後の追記と不一致の拒否 | Kafka idempotent producer | 最後の既知番号＋1 からローカルで仮採番し、追記時にデータベースが照合。 |
| 実行側に別の正本を持たせない | GitHub Actions・Prefect・Inngest | データベースを唯一の正本にする。 |
| 作業指示ごとの結果フォルダー | Playwright `test-results/<test>/` | `.review-bridge/results/<作業指示>/`。run ごとに 1 ファイル、上書きしない。 |
| サービスの起動・停止 | `docker compose down`／`up`、`brew services` | `npx review-bridge up` は DB、ページの順に起動。`down` は逆順で、作業中は拒否 |
| 孤立したデータベースプロセスの処理 | zonky embedded-postgres の `cleanOldDataDirectories` | `pg_ctl stop -m fast` 後に再試行。そのデータディレクトリに属するプロセスだけを扱う。 |
| 認識できないファイルを変更しない | Git checkout の未追跡ファイルの扱い | 移行先に同名で内容の異なるファイルがあるときだけ `upgrade` が拒否し、名前を表示。 |
| `.vscode/` への書き込み前に確認 | `npm create vue@latest` | init の最後の確認。 |
| `tasks.json` の既存内容とコメントを維持 | VS Code の `jsonc-parser` | `npx review-bridge vscode`、`uninstall` |
| ユーザーレベルのエージェント入口 | Claude Code `~/.claude/commands/`、Codex `~/.agents/skills/`（`ext/skills/src/host_roots.rs`） | `/review-bridge`、`$review-bridge`。 |
| セッションの読み取り専用・分離オプション | Claude Code `--permission-mode plan`／`--tools`／`--strict-mcp-config`、Codex `exec --sandbox read-only`、`--disable apps --disable plugins`、`mcp_servers.<name>.enabled` | reviewer の制限確認とコネクターの分離。 |
| OS 標準ディレクトリへの記録とローテーション | `env-paths` の data／log 規約 | `%LOCALAPPDATA%\ReviewBridge`、`~/Library/Logs/ReviewBridge`、`$XDG_STATE_HOME/review-bridge`。 |
| DB のバックアップ | PostgreSQL のファイル単位方式 | `npx review-bridge backup`：停止、全フォルダーのコピー、再起動 |
| ツール用フォルダー内に `*` だけの `.gitignore` | pytest `.pytest_cache`、ruff `.ruff_cache`、uv `.venv` | `.review-bridge/.gitignore`。プロジェクトの除外設定は変更しない |
| 起動元に合わせた次のコマンド | create-vite の `npm_config_user_agent`（`pkgFromUserAgent`） | `npx`、`pnpm dlx`、`yarn dlx`、`bun x`、`deno run -A npm:` |
| frontmatter の `id` で識別 | Docusaurus・Astro の文書 ID、Jira の課題番号 | 初回承認で書き込み、改名・移動でも同じ作業指示 |
| 2 つのパスが同じファイルか判定 | `find -samefile`、coreutils `test -ef`（device と inode） | ハードリンクは同一。ファイル ID のない環境は拒否 |
| リスト項目の分割 | VitePress でも使う markdown-it の規則 | 1 項目が 1 条件。`一、`・`（1）` はリスト記号ではない |
| DB 状態の終了コード | `pg_ctl status` の 4 | DB ディレクトリを読めなければ `status` は 4 |

検討したものの**採用しなかった**方式は、conda／pnpm／nvm のようなユーザー rc ファイルへのマーカーブロック追加と、Node 組み込み SQLite です。Bridge は専用の独立ファイルと PostgreSQL を使います。

## 参考元の確認方法

- オープンソースはソースコードを読み、ファイルと行番号を記録します。ドキュメントしかない場合は、ページと参照日を記録します。
- README の説明だけに依存せず、実際の動作を根拠にします。
- 参考にできる既存の方式がなければ採用せず、設計の対象外として記録します。
