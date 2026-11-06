# 最初の作業指示

作業指示は `.review-bridge/work-packages/` に置く Markdown ファイルです。Bridge がブロックマーカーを解析し、原文を対応するコントラクトの項目に入れます。モデルが担当するのは、受け入れ条件を番号付きの条件に整理する部分だけです。

他のツールで作業指示を生成する場合は、このページの固定形式で出力してください。

## テンプレートから始める

```sh
cp .review-bridge/work-packages/TEMPLATE.md .review-bridge/work-packages/add-readme.md
```

必要なブロックを記入し、不要なものはブロックごと削除します。`##` 見出しは閲覧用で、言語は自由です。Bridge は `<!-- bridge:… -->` でブロックを識別します。

## 最小の例

最低限必要なのは、タイトル、`requested_work`、`acceptance` のブロックです。

```markdown
---
source_id: DOC-1
---
# プロジェクトに README を追加する

<!-- bridge:context -->
## 背景と現状
ルートに README がなく、新しいメンバーが起動方法を把握できない。

<!-- bridge:requested_work -->
## 作業内容
ルートに README.md を追加し、プロジェクトの用途と起動方法を説明する。

<!-- bridge:acceptance -->
## 受け入れ条件
1. ルートに README.md があり、先頭行がプロジェクト名である。
2. README に「使い始める」セクションがある。

<!-- bridge:open_questions -->
## 未決の質問
none
```

作業指示には検証可能な条件が 1 つ以上必要です。なければモデル呼び出し前に停止し、追加を求めます。

## 完全な例

以下はすべてのブロックを使うバグ修正の例です。機能追加なら 5 つの `reproduction.*` ブロックを省略できます。解析後、カードには `Priority: high (work order)` と `rounds 2 (work order)` が表示され、括弧は設定元が作業指示であることを示します。

```markdown
---
priority: high
writer: { effort: high }
reviewer: { effort: medium }
budget:
  rounds: 2
  run_timeout: 7200000
source_id: SHOP-412
---
# クーポン適用後にチェックアウトの合計が更新されない

<!-- bridge:context -->
## 背景と現状
CheckoutSummary でクーポンを入力し、API が 200 を返しても合計が元の価格のまま。サポートには今週 14 件の報告があった。クーポン API は 2026-10 にレスポンスを変更し、以前の `total` から `subtotal`、`discount`、`total` の 3 フィールドになった。

<!-- bridge:outcome -->
## 期待する成果
有効なクーポンの入力後 1 秒以内に割引後の合計を表示する。無効なら合計を変更せず、エラーメッセージを表示する。

<!-- bridge:requested_work -->
## 作業内容
1. CheckoutSummary のクーポン適用後の計算を修正し、API の新しい `total` を使う。
2. 無効なクーポンでは API のエラーメッセージを表示し、合計は元のままにする。
3. 両方のケースにユニットテストを追加する。

<!-- bridge:run_plan -->
## 実行計画
### RUN A
合計計算と有効なクーポンの表示を修正する。
- effort: high
- acceptance:
  - 有効なクーポン適用後の合計が API の total と一致する。

### RUN B
無効なクーポンのエラーを表示する。
- depends_on: RUN A
- budget: { rounds: 1 }
- acceptance:
  - 無効なクーポンではエラーを表示し、合計は変わらない。

<!-- bridge:scope_notes.include -->
## 対象に含める
- チェックアウトのクーポン入力と合計の部分
- この 2 ケースのユニットテスト

<!-- bridge:scope_notes.exclude -->
## 対象外
- クーポン API 本体（バックエンドの別チケット）
- カートページの小計

<!-- bridge:scope_notes.must_keep -->
## 維持するもの
- クーポンがない場合の計算は変えない
- 既存のチェックアウトのテストはすべて成功する
- API のパスやパラメーターを変更しない

<!-- bridge:scope_notes.expected_locations -->
## 変更が予想される場所（参考であり、編集の許可ではない）
- src/components/checkout/CheckoutSummary.vue
- src/composables/useDiscount.ts
- tests/unit/checkout/

<!-- bridge:acceptance -->
## 受け入れ条件
1. 有効なクーポン入力後 1 秒以内に割引後の合計を表示し、API の `total` と一致する。
2. 無効なクーポンでは合計を変えず、API のエラーメッセージを表示する。
3. `npm test` がすべて成功する。追加した 2 テストは修正前に失敗し、修正後に成功する。

<!-- bridge:verification_hints -->
## 検証のヒント
- テストデータ：`WELCOME10`（有効、10% 引き）、`EXPIRED`（無効、API は 422 と「クーポンの有効期限が切れています」を返す）。
- 既存テスト：`tests/unit/checkout/CheckoutSummary.spec.ts`。

<!-- bridge:reproduction.environment -->
## バグ：環境
Chrome 130、Windows 11、フロントエンド v2.14.0、テスト環境。

<!-- bridge:reproduction.steps -->
## バグ：再現手順
1. 価格 1000 の商品を 1 つカートに入れ、チェックアウトに進む。
2. `WELCOME10` を入力して適用する。
3. 合計を確認する。

<!-- bridge:reproduction.actual -->
## バグ：実際の結果
API は 200 を返すが、合計は 1000 のまま。

<!-- bridge:reproduction.expected -->
## バグ：期待する結果
合計が 900 と表示される。

<!-- bridge:reproduction.frequency -->
## バグ：頻度と影響
毎回発生。クーポンを使うすべてのチェックアウトが対象。

<!-- bridge:references -->
## 参考資料・添付・依存関係
- クーポン API の文書：docs/api/discount.md
- 関連チケット：SHOP-398（API の形式変更）

<!-- bridge:open_questions -->
## 未決の質問
none
```

| ブロック | 利用者 | 用途 |
|---|---|---|
| `context`、`outcome` | writer、reviewer | 原文をコントラクトに入れ、背景と期待する成果を説明します。 |
| `requested_work` | writer | 具体的な作業内容。必須です。 |
| `run_plan` | Bridge | 2 つ以上の計画ステップを記載します。コントラクトに保存しますが、現在は作業指示全体を 1 回の run で実行します。 |
| `scope_notes.include` / `exclude` / `must_keep` | writer、reviewer | 範囲の逸脱や、維持すべき動作の破損を確認します。 |
| `scope_notes.expected_locations` | writer | 変更場所のヒントであり、**編集の許可ではありません**。実際の許可範囲はカードの `Scope` です。 |
| `acceptance` | reviewer、Bridge | 必須です。モデルが AC1、AC2…に整理し、結果に条件ごとの判定を表示します。 |
| `verification_hints` | writer、reviewer | テストデータや既存テストの名前。実際のコマンドはプロジェクト種別が決めます。 |
| `reproduction.*` | writer、reviewer | バグの環境、手順、実際・期待する結果、頻度。機能追加では省略可能です。 |
| `references` | writer | リンク、ファイルパス、関連チケット。 |
| `open_questions` | Bridge | 未回答の質問。`無`、`none`、空白以外の内容があれば停止して回答を待ちます。 |

## ブロックの形式

- 最初の `# ` で始まる行を作業指示のタイトルにします。
- ブロックは `<!-- bridge:<key> -->` から始まり、次のマーカーまたはファイル末尾まで続きます。
- key はコントラクトの 17 フィールドに対応します：`context`, `outcome`, `requested_work`, `run_plan`, `scope_notes.include`, `scope_notes.exclude`, `scope_notes.must_keep`, `scope_notes.expected_locations`, `acceptance`, `verification_hints`, `reproduction.environment`, `reproduction.steps`, `reproduction.actual`, `reproduction.expected`, `reproduction.frequency`, `references`, `open_questions`。未知の key や重複した key は、行番号付きで拒否します。
- `open_questions`：質問がなければ `無`、`none`、または空白にします。他の各行は質問として扱われ、作業指示内で回答するまでモデルを呼ばずに停止します。
- frontmatter、タイトル、マーカー、`##`／`###` 見出し、空行は文書構造です。ブロック外の他の内容は「未使用の行」としてコントラクトに残します。

## frontmatter

frontmatter はファイル先頭の YAML 設定です。Astro content collections と同じく、先頭行の `---` から次の `---` だけの行までを読みます。全項目は任意で、frontmatter 自体を省略することもできます。

```yaml
---
priority: high              # low / medium / high / urgent。既定は policy の priority.default
writer:                     # モデルと effort。policy の priority テーブルより優先
  model: gpt-5.6-sol        # writer の CLI に対応する名前。null は CLI の既定値
  effort: high              # low / medium / high
reviewer: { model: opus, effort: medium }   # reviewer も同じ設定
budget:                     # すべて任意。既定は同名の policy 上限
  tokens: 2000000           # limits.tokens
  tokens_per_call: 150000   # limits.tokens_per_call
  call_timeout: 1200000     # limits.call_timeout、ミリ秒
  test_timeout: 600000      # limits.test_timeout、ミリ秒
  run_timeout: 7200000      # limits.run_timeout、ミリ秒
  rounds: 2                 # limits.rounds
source_id: SHOP-412         # 外部システムの番号。実行ルールには使わない
---
```

- 未知の key と不正な値は、行番号付きで拒否します。未対応の priority／effort、正の整数でない budget、policy 上限を超えた値などが対象です。上限超過のメッセージには許容値も表示します。
- `writer` は実装、修正、コントラクト変換の全呼び出しに、`reviewer` はコントラクト確認とレビューに適用します。省略した値は policy の priority テーブルから取得します。provider は `bridge.json` または実行時の `--writer`／`--reviewer` が決め、カードに表示します。
- `model` は役割に割り当てた CLI の命名形式に合わなければ、カード表示前に拒否します。Bridge が確認するのは形式だけです。Claude は `fable`、`opus`、`sonnet`、`haiku`（`[1m]` を追加可能）または `claude-` を含む名前、Codex は `gpt-`、`codex-`、または `o` の後に数字が続く名前です。**モデルが実在するかは CLI が確認**し、不正なら最初の呼び出しでエラーになります。以下は 2026-11-06 時点の文書に記載した名前です。選択時はリンク先の最新情報を確認してください。

  | 役割の CLI | 記録された値 | 参照先 |
  |---|---|---|
  | `claude` | 別名：`fable`、`opus`、`sonnet`、`haiku`、`sonnet[1m]`、`opus[1m]`、`fable[1m]`。完全名：`claude-fable-5-1`、`claude-fable-5`、`claude-opus-5-5`、`claude-opus-5`、`claude-sonnet-5`、`claude-haiku-5-5`。古い 4.x の名前も公式文書に記載。Claude Code の `best`、`opusplan`、`default` は Bridge の形式検査では**受け付けません**。 | [Claude Code のモデル設定](https://code.claude.com/docs/en/model-config) |
  | `codex` | `gpt-6.1-sol`、`gpt-6.1-terra`、`gpt-6-astra`、`gpt-6-luna`。この記録では `gpt-5.5` は API key ログインのみ、`gpt-5.4`、`gpt-5.3-codex` などは提供終了となっています。 | [Codex のモデル](https://learn.chatgpt.com/docs/models) |

  `model` を省略するか `null` にすると CLI の既定モデルを使い、結果には `model: null` を記録します。名前は更新されるため、上のリンクと CLI ヘルプを確認してください。独自の Codex provider を使う場合は Codex 側でモデルを設定し、ここでは `model` を省略します。
- 両役割の `effort` は `low`、`medium`、`high` のみです。Claude Code 自体には `xhigh`、`max`、Codex UI には Extra High、Max、Ultra もありますが、このバージョンの Bridge は対応していません。
- 旧形式のトップレベル `effort` は `writer.effort` として受け付けます。両方を指定すると拒否します。
- 優先順序は CLI フラグ（`--rounds`、`--call-timeout`）→ 作業指示 → policy の priority テーブル（effort、model）→ limits です。計画は各値と設定元（`cli`、`work_order`、`priority`、`config`）を記録し、カードに両方を表示します。
- `run_timeout` は run 全体の制限時間で、既定は 6 時間です。GitHub Actions job の `timeout-minutes` と同じ考え方です。期限に達すると `timed_out`、理由 `run_timeout` で終了し、各呼び出しも残り時間で制限します。

## 実行計画（run plan）

作業指示を 2 つ以上の計画ステップとして記述するときに使います。`### ` 見出しごとに計画上の run を定義し、その見出しを名前にします。4 つの固定 key は YAML として読み、他の文章はステップの作業内容です。

**現在、run plan はコントラクトに記録するだけで、複数の run を自動作成しません。** 以下は依存関係のある文書作成の 2 ステップです。

```markdown
<!-- bridge:run_plan -->
## 実行計画
### RUN A
インストール手順を書く。
- effort: low
- acceptance:
  - README にインストール手順がある。

### RUN B
起動手順を追加する。
- depends_on: RUN A
- budget: { rounds: 1, call_timeout: 600000 }
- acceptance:
  - README に起動コマンドがある。
```

- `effort` と `budget` は frontmatter と同じ値を使います。`depends_on` は run 名または `[RUN A, RUN B]` のような一覧です。存在しない依存先や循環依存は拒否します。
- 各 run の `acceptance` はそのステップの条件、作業指示の `acceptance` は全体の成果です。run plan には 2 つ以上の run が必要で、1 つだけなら拒否します。
- 計画はコントラクトに記録します。**現在は作業指示全体を 1 回の run で実行します。**

## 次のステップ

[作業を実行する](./start)。
