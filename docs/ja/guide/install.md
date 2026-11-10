# インストールと初期設定

Review Bridge は npm で公開している CLI ツールです。プロジェクトのフォルダーで `npx review-bridge init` を実行すると、最新版の取得と初期設定を行います。`npm create vite` と同じように、事前のインストールは不要です。

## 必要な環境

- Node.js 22.8 以降と npm。
- **変更の証跡**を取得するための Git。Git なしでも実行できますが、結果には証跡を提供できないと明記します。Git がある場合は開始時のコミットと実際のファイル変更を記録します。
- 各役割に必要な CLI のインストールとログイン。`claude`（Claude Code）、`codex`、または両方です。
- Bridge の状態を保存するローカルディスク。OneDrive、Dropbox、iCloud Drive、UNC、NFS、SMB などの同期・ネットワーク保存先は使えません。

## プロジェクトの初期設定

```sh
cd your-project
npx review-bridge init
```

`npx` は npm の最新版を確認するため、ネットワーク接続が必要です。確認を省くには `npm i -g review-bridge` でグローバルインストールします。その後の `npx review-bridge` はそのコピーを使います。pnpm、Yarn、Bun なら、それぞれ `pnpm dlx review-bridge init`、`yarn dlx review-bridge init`、`bun x review-bridge init` を使えます。以後の案内も同じ形式になります。[パッケージマネージャー](../reference/cli#package-managers)を参照してください。

`init` は create-vite と同じく、質問を終えてから設定を始めます。各質問には既定値があり、Enter で選べます。

1. **writer**：`claude` または `codex`。保存済みの既定値がなければ `claude` です。
2. **reviewer**：保存済みの既定値がなければ `codex` です。
3. **プロジェクトの種類**：検出した種類を使い、検出できなければ `none` です。writer の各ラウンド後に Bridge が実行する `npm test` などのコマンドを決めます。`none` や該当コマンドのない場合も実行でき、カード、記録、結果にテスト未設定と表示します。
4. **VS Code タスク**：プロジェクトの `.vscode/tasks.json` に書き込むかを選びます。既定は **N** です。[VS Code から実行](./start#in-vs-code)を参照してください。

回答後は設定を始め、各ステップを 1 行ずつ表示します。計画のプレビューや追加の確認はありません。

`--writer`、`--reviewer`、`--profile <type|none>`、`--target <folder>` で直接指定することもできます。対話型ターミナルがない場合や `--yes` を付けた場合は、未指定の項目に既定値を使い、質問しません。

### init が行うこと

- `.review-bridge/` に `bridge.json`、`policy.override.json`、`rules.md` と、作業指示テンプレート `work-packages/TEMPLATE.md`（英語）、`TEMPLATE.zh-TW.md`（繁体字中国語）を作成します。
- 同フォルダー内に `*` だけの `.gitignore` を置き、結果を含む全体を Git の対象外にします。後から Git を初期化しても同様です。**プロジェクト自身の `.gitignore` は変更しません。**
- モデルを呼び出さず、模擬 CLI で `PASS`、`FAIL_THEN_PASS`、`HARD_STOP`、`RATE_LIMIT` の 4 件を自己テストします。
- `127.0.0.1` でローカルページを起動します。初回利用時にデータベースも作成・起動します。
- コードの graph をデータベースに作成し、プロジェクトには graph ファイルを残しません。[プロジェクトのコード索引](./start#project-graph)を参照してください。
- **プロジェクト外**にエージェント用の入口を配置して共用します。Claude Code は `~/.claude/commands/review-bridge.md`（`CLAUDE_CONFIG_DIR` に対応）から `/review-bridge`、Codex は `~/.agents/skills/review-bridge/SKILL.md` から `$review-bridge` を呼び出します。既存のユーザーファイルは維持します。

アプリケーションのファイル、`.gitignore`、`AGENTS.md`、`CLAUDE.md`、`.claude/` は変更しません。初期設定前に変更がなく、`.vscode/tasks.json` の追加を選ばなければ、設定後も `git status` に変更は表示されません。

### 出力例

`package.json` と `index.js` がある小さな Git プロジェクトでの表示例です。この手順ではモデルを呼び出さない rc3 の模擬 CLI を使います。ポートやパスワードファイルの場所は環境ごとに変わります。`<data home>` はユーザーのデータディレクトリを表します。

```text
Setting up .review-bridge/...
Checking the setup...
Running the four fake self-tests...
Starting the local page...
Mapping the project...
Mapped 1 file(s): 0 definition(s), 1 reference(s), 0 import(s).

Done. Now:

  put a work order .md in .review-bridge/work-packages/, then in Claude Code type:
    /review-bridge start .review-bridge/work-packages/<file>.md
    (in Codex: $review-bridge start .review-bridge/work-packages/<file>.md)
  at a terminal, for advanced use and CI:
    npx review-bridge start .review-bridge/work-packages/<file>.md
  page: http://localhost:53559/

  database in VS Code: install Microsoft's PostgreSQL extension and add a connection with
    Server 127.0.0.1  Port 53558  User bridge  Database bridge
    Password: copy it from <data home>\postgres\secret
```

`init` はシステム言語を検出し、`bridge.json` の `locale` に保存します。カード、`status`、`up`、`down`、`ps`、結果ファイルはその設定を使います。CLI の固定メッセージは現在、英語と繁体字中国語に対応しており、日本語環境では英語になります。解析後の行は graph の集計で、解析できなかったファイルは個別に列挙します。

初期化後の `git status --short` に出力はなく、`.review-bridge/.gitignore` は次の内容になります。

```text
# Created by Review Bridge automatically.
*
```

接続情報は設定完了時に表示され、`npx review-bridge status` でも確認できます。[VS Code でデータベースを見る](./results#vs-code-database)を参照してください。

## 次のステップ

[最初の作業指示](./work-order)を作成し、[実行を開始](./start)します。
