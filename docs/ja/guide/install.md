# インストールと初期設定

Review Bridge はグローバルにインストールする CLI です。一度インストールしたら、利用する各プロジェクトで `init` を実行します。

## 必要な環境

- npm を含む Node.js 22 以降。
- Git。Git を使わないプロジェクトでも作業は実行できますが、**変更の証跡**には Git が必要です。Git がある場合、Bridge は開始時のコミットと実際のファイル変更を記録します。ない場合は、証跡を取得できないことを結果に明記します。
- writer と reviewer に割り当てる CLI。`claude`（Claude Code）、`codex`、または両方をインストールし、ログインしておきます。
- Bridge の状態を保存するローカルディスク。OneDrive、Dropbox、iCloud Drive、UNC、NFS、SMB などの同期フォルダーやネットワークドライブは利用できません。

## インストール

```sh
npm i -g review-bridge@next
```

リリース候補版（rc）は `next` タグで配布します。安定版の公開後は `npm i -g review-bridge` を利用できます。

## プロジェクトの初期設定

```sh
cd your-project
review-bridge init
```

`init` は最初に次の 3 項目を確認します。それぞれ既定値があり、Enter でそのまま選択できます。

1. **writer**：`claude` または `codex`。保存済みの既定値を使い、未設定なら `claude` を使います。
2. **reviewer**：保存済みの既定値を使い、未設定なら `codex` を使います。
3. **プロジェクト種別**：検出された種別を使い、検出できなければ `none` を使います。この設定で、writer の各ラウンド後に Bridge が実行する検証コマンド（`npm test` など）が決まります。`none` を選ぶか、対応するコマンドがない場合も作業は実行できます。カード、記録、結果には `tests: not configured` と表示されます。

続いて、プロジェクトの `.vscode/tasks.json` に VS Code タスクを追加するか確認します。既定値は **N** です。[作業の実行](./start#vs-code)も参照してください。

`--writer`、`--reviewer`、`--profile <type|none>`、`--target <folder>` で直接指定することもできます。対話型ターミナルがない場合や `--yes` を付けた場合は、未指定の項目に既定値を使い、質問しません。

### init が行うこと

- `.review-bridge/` に `bridge.json`、`policy.override.json`、`rules.md` と、作業指示のテンプレート `work-packages/TEMPLATE.md`（英語）、`TEMPLATE.zh-TW.md`（繁体字中国語）を作成します。
- Git プロジェクトでは、結果ファイルを含む `.review-bridge/` 全体を `.git/info/exclude` で追跡対象から除外します。**`.gitignore` は変更しません。**
- モック CLI を使って `PASS`、`FAIL_THEN_PASS`、`HARD_STOP`、`RATE_LIMIT` の 4 つの自己テストを実行します。モデルは呼び出しません。
- `127.0.0.1` でローカルページのサービスを起動します。
- 全プロジェクトで共用するエージェント用の入口を、**プロジェクトの外**に配置します。Claude Code は `~/.claude/commands/review-bridge.md` を `/review-bridge` で呼び出します。`CLAUDE_CONFIG_DIR` が設定されていれば、その場所を使います。Codex は `~/.agents/skills/review-bridge/SKILL.md` を `$review-bridge` で呼び出します。同じ場所に自分で作成したファイルがある場合、Bridge は上書きしません。

アプリケーションのファイル、`.gitignore`、`AGENTS.md`、`CLAUDE.md`、`.claude/` は変更しません。初期設定前に変更がなく、`.vscode/tasks.json` の追加を選ばなければ、設定後も `git status` に変更は表示されません。

### 出力例

```text
Setting up .review-bridge/...
Checking the setup...
Running the four fake self-tests...
Starting the local page...
Done. Now:

  put a work order .md in .review-bridge/work-packages/, then in Claude Code type:
    /review-bridge start .review-bridge/work-packages/<file>.md
    (in Codex: $review-bridge start .review-bridge/work-packages/<file>.md)
  at a terminal, for advanced use and CI:
    review-bridge start .review-bridge/work-packages/<file>.md
  page: http://localhost:8080/

  database in VS Code: install Microsoft's PostgreSQL extension and add a connection with
    Server 127.0.0.1  Port 5432  User bridge  Database bridge
    Password: copy it from <data home>/postgres/secret
```

末尾にデータベースの接続情報が表示されます。`review-bridge status` でいつでも再確認できます。[結果・ログ・データベース](./results#vs-code-database)を参照してください。

## 次のステップ

[最初の作業指示](./work-order)を作成し、[実行を開始](./start)します。
