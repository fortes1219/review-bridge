# 設定

設定はプロジェクト用と個人用に分かれています。プロジェクトの `.review-bridge/` に 3 ファイル、data home（ユーザーデータディレクトリ）に `settings.json` があります。形式は JSON または Markdown です。編集する前に、以下の保護対象フィールドを確認してください。

## `.review-bridge/bridge.json`

rc3 の `init` が作成する設定例です。`package.json` はあり、`test` script はないプロジェクトを想定しています。

```json
{
  "schema_version": 4,
  "project_id": "bdbe7d5a-c1de-4d00-ad6e-59ed13cf8d0f",
  "profile_id": "node-backend",
  "roles": {
    "writer": { "provider_id": "claude" },
    "reviewer": { "provider_id": "codex" },
    "reviewer_readonly_required": true
  },
  "requires_human_authorization": true,
  "watch": { "port": 53559, "strict_port": false },
  "retention": { "days": 15 },
  "locale": "en",
  "test": { "profile_id": "node-backend", "rules": [{ "command": "npm test", "package_script": "test" }] },
  "readiness": { "reviewer_readonly_proven": "not_run" },
  "default_policy_ref": "review-bridge/config/default-policy.json",
  "project_override_ref": ".review-bridge/policy.override.json",
  "active_runs": "derive_from_run_projections"
}
```

| フィールド | 説明 |
|---|---|
| `project_id` | データ・ログディレクトリ内の識別子。変更しないでください |
| `roles.writer` / `roles.reviewer` | 各役割の `claude` または `codex`。変更は次の `start` から適用し、カードに表示 |
| `roles.reviewer_readonly_required`、`requires_human_authorization`、`readiness` | 保護項目。`init` は順に `true`、`true`、`"not_run"` を設定。初期化と更新時に確認し、変更されていれば停止。安全制限の解除には使えません |
| `watch.port` | ページのポート。`strict_port: false` なら使用中の番号より上の空きを探索 |
| `retention.days` | `clean` が適用するログ・終了済み記録の保持日数 |
| `locale` | カード、`status`、`up`、`down`、`ps`、`init`、結果の言語。`en` または `zh-TW`。`init` がシステム言語から設定 |
| `test.profile_id` / `test.rules` | プロジェクトの種類とテストコマンド。下の profiles 表を参照 |

## `.review-bridge/policy.override.json`

パッケージの既定 policy をプロジェクト単位で調整します。`init` が作成する内容は次のものだけです。

```json
{ "schema_version": 5, "profile_id": null }
```

既定 policy はパッケージの `review-bridge/config/default-policy.json` にあります。

```json
{
  "limits": {
    "rounds": 2,
    "call_timeout": 900000,
    "max_turns": 20,
    "tokens_per_call": 1500000,
    "tokens": 4000000,
    "test_timeout": 600000,
    "run_timeout": 21600000,
    "authorization_ttl": 86400000
  },
  "writer": { "mode": "writer_only", "disallowed_tools": [], "self_review": "one_local_consistency_pass" },
  "reviewer": { "mcp_allow": [] },
  "priority": {
    "default": "medium",
    "writer":   { "low": { "model": null, "effort": "low" }, "medium": { "model": null, "effort": "medium" }, "high": { "model": null, "effort": "high" }, "urgent": { "model": null, "effort": "high" } },
    "reviewer": { "low": { "model": null, "effort": "low" }, "medium": { "model": null, "effort": "medium" }, "high": { "model": null, "effort": "high" }, "urgent": { "model": null, "effort": "high" } }
  },
  "release_actions_require_human": true
}
```

- `limits` は実行上限です。作業指示の `budget` はこの値を超えられません。時間の単位はミリ秒です。`authorization_ttl` はカードの有効期間で、既定は 24 時間です。
- `priority` テーブルは優先度ごとのモデルと effort を指定します。`model: null` は CLI の既定モデルを使います。作業指示の `writer:`／`reviewer:` が優先されます。作業指示では reviewer の effort を下げられますが、プロジェクトの上書き設定ではテーブルの値より下げられません。
- `reviewer.mcp_allow` は reviewer に許可する MCP サーバー名のリストです。既定は空で、すべて無効です。現在、許可するサーバーの**読み取り専用検証は行いません**。カードにこの制限を表示します。
- `writer.disallowed_tools` は Claude writer で禁止するツールのリストです。Codex writer は対応していないため、policy に設定されていると実行を拒否します。

## `.review-bridge/rules.md`

作業開始前に Bridge が writer に渡すルールの要約です。許可する操作、禁止事項、停止条件を記載します。プロジェクトに合わせて編集できますが、1 ページ以内にまとめてください。

## data home の `settings.json`

すべてのプロジェクトで共用する個人設定です。

```json
{
  "schema_version": 1,
  "default_roles": { "writer": "claude", "reviewer": "codex" }
}
```

- `default_roles`：`init` で役割を選ぶときの既定値。
- `database.port`：データベースが空きポートを探し始める番号。例：`"database": { "port": 5440 }`。次回のデータベース起動時に反映します。

## プロジェクト種別（profiles）

`init` の 3 番目の設定で選択します。writer の各ラウンド後に Bridge が使う検証コマンドを決めます。

| `profile_id` | 検出対象 | テストコマンド |
|---|---|---|
| `vue-frontend` | Vue・TypeScript フロントエンド | `npm test` |
| `node-backend` | Node.js バックエンド | `npm test` |
| `rust-backend` | Rust | `cargo test --workspace` |
| `go-backend` | Go | `go test ./...` |
| `python-backend` | Python | `python -m pytest` |
| `java-backend` | Java | `mvnw`／`mvn test`、`gradlew`／`gradle test` |
| `dotnet-backend` | .NET・C# | `dotnet test` |
| `php-laravel` | PHP Laravel | `php artisan test` |
| `none` | — | テストなし。カードと結果に未設定と明記 |

## 環境変数

| 変数 | 用途 |
|---|---|
| `REVIEW_BRIDGE_DATA_HOME` | 設定、データベース、プロジェクト状態を保存する data home を指定します。ログはその下の `logs/` に保存します。 |
| `CLAUDE_CONFIG_DIR` | Claude Code の設定ディレクトリ。Bridge の `/review-bridge` の入口もこの下に配置します。 |
| `XDG_STATE_HOME` | Linux のログディレクトリの基点。既定は `~/.local/state`。 |
