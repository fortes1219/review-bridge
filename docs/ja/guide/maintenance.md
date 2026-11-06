# アップグレード・バックアップ・削除

## アップグレード

```sh
npm i -g review-bridge@next        # パッケージを更新
cd your-project
review-bridge upgrade              # バックアップ後、プロジェクト設定を更新
```

`upgrade` は、旧サービスの停止、バックアップ、移行、整合性確認、旧ファイルの整理、再起動、ヘルスチェックを順に行います。Bridge が処理するため、中断しても再実行できます。

- 旧ディレクトリ構成は一度だけ移行します。設定は `.review-bridge/` 直下、実行状態（`review-queue/`、`reviews/`、`archive/`）は data home の `projects/<project_id>/`、呼び出しログ・計画・カードはログディレクトリへ移動します。名前は保持し、SHA-256 で内容を照合します。保存期限を過ぎたログは削除し、旧版で `results/` 直下に保存した結果のコピーはそのまま残します。
- OS の一時ファイルや自分で作成したファイルなど、Bridge が認識しないものは変更せず、アップグレードも妨げません。移行先に同名で内容の異なるファイルがあれば、移行を拒否して一覧を表示します。
- `bridge.json` で変更した役割の設定は保持します。
- `--rollback` で、前回のアップグレード時のバックアップから戻せます。
- バックアップ先は data home の `backups/installer`、または `--backup-root <folder>` で指定した場所です。
- スクリプト向けには、`--plan-out <file>` で対話確認なしに計画を書き出せます。`--plan <file> --approve <sha>` でその計画を適用します。`<sha>` は `--plan-out` が表示する SHA-256 です。

## バックアップ

[結果・ログ・データベース → バックアップ](./results#backup)を参照してください。`review-bridge backup` は全プロジェクトのデータベースをコピーします。実行中の作業があれば拒否します。

## 削除

```sh
review-bridge uninstall --target .   # バックアップ後、プロジェクト設定を削除
npm uninstall -g review-bridge       # パッケージを削除
```

- `uninstall` が削除するのは Bridge が作成した内容だけです。`.review-bridge/`（結果のコピーもバックアップ対象）、`.vscode/tasks.json` の `review-bridge:` で始まる task と `review-bridge-` で始まる input を取り除きます。他に内容がなければファイルも削除します。
- エージェント用の入口（`~/.claude/commands/review-bridge.md`、`~/.agents/skills/review-bridge/SKILL.md`）とユーザータスクは全プロジェクトで共用します。**最後の**設定済みプロジェクトを `uninstall` したときだけ削除します。自分で編集したファイルは残します。
- `--plan-out`、`--plan`、`--approve`、`--backup-root`、`--json` は `upgrade` と同じです。

## 対応プラットフォーム

Windows x64 はネイティブ環境で検証済みです。Apple Silicon macOS は選択できますが、ネイティブ検証は未実施です。Linux は実験段階で、ネイティブ環境でのモデル実行は既定で拒否します（fail closed）。

### Windows

Codex が Windows PowerShell でコマンドを実行するときは、`$PROFILE` を読み込みます。中国語版 Windows の既定値など、PowerShell の出力が UTF-8 以外のコードページの場合、Codex が UTF-8 として読み取って文字化けすることがあります。

PowerShell で `notepad $PROFILE` を実行し、次の設定を追加します。ファイルがなければ先に作成してください。

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
```

既定で UTF-8 を出力する PowerShell 7（`pwsh`）に切り替える方法もあります。`review-bridge doctor` は現在の PowerShell が UTF-8 を使っているか表示し、profile 自体は変更しません。
