# 最初の作業指示

作業指示は `.review-bridge/work-packages/` に置く Markdown ファイルです。Bridge がマーカーごとに内容を読み取り、対応するコントラクトの項目へ転記して、完了条件を AC1、AC2…に分割します。すべてコードで処理し、モデルは呼び出しません。結果のトークン数は 0 です。

他のツールで作業指示を生成する場合は、このページの固定形式で出力してください。

## テンプレートから始める

```sh
cp .review-bridge/work-packages/TEMPLATE.md .review-bridge/work-packages/add-readme.md
```

必要なブロックを記入し、不要なものはブロックごと削除します。`##` 見出しは閲覧用で、言語は自由です。Bridge は `<!-- bridge:… -->` でブロックを識別します。

## 簡単な作業指示を書く

必須なのは `requested_work` と `acceptance` です。次の例では、依頼を整理するためにタイトル、背景、未決事項も付けています。

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
## 完了条件
1. ルートに README.md があり、先頭行がプロジェクト名である。
2. README に「起動方法」の節がある。

<!-- bridge:open_questions -->
## 未決の質問
none
```

## 実行前の形式チェック {#work-order-validation}

`start` は作業指示をフォームとして検証します。次の条件を満たさない場合、カードの前で停止し、該当ブロックと行番号、修正後に実行するコマンドを表示します。

- **作業内容**：`requested_work` または `run_plan` に内容が必要です。
- **完了条件**：`acceptance` は `- `、`* `、`+ `、`1. ` などで始まる Markdown のリストにします。`一、` や `（1）` はリスト記号として認識しません。VitePress と同じ markdown-it で解析し、1 項目を 1 条件にします。
- **未決事項**：`open_questions` は空欄、`none`、`無` のいずれかにします。ほかの行は未回答の質問です。回答を作業指示へ書き込み、質問を削除するか `none` に置き換えてください。

作業内容や完了条件の必須マーカーを削除した場合は、Bridge がマーカーと見出しを末尾に補い、記入場所を示します。既存の文章は変更しません。`# ` のタイトルは省略でき、その場合は `untitled` になります。

Bridge が検証するのは形式と必須項目です。依頼の意味が十分に明確かどうかまでは判断しません。検証できる要件の書き方は[ユーザーの判断が必要なとき](../principles/asking)で説明しています。

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
## 完了条件
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

各ブロックの用途は次のとおりです。

| ブロック | 利用者 | 用途 |
|---|---|---|
| `context`、`outcome` | writer、reviewer | 背景と期待する成果を原文のままコントラクトへ転記 |
| `requested_work` | writer | 必須の作業内容 |
| `run_plan` | Bridge | 2 つ以上の計画上の手順。コントラクトに保存し、実行自体は作業指示全体で 1 run |
| `scope_notes.include` / `exclude` / `must_keep` | writer、reviewer | 範囲超過や維持すべき動作の破損を確認 |
| `scope_notes.expected_locations` | writer | 変更候補の場所。**変更の許可ではありません**。実際の範囲はカードの `Scope` が基準 |
| `acceptance` | reviewer、Bridge | 必須。各項目を AC1、AC2…に分割し、結果に個別の判定を表示 |
| `verification_hints` | writer、reviewer | テストデータや既存テスト名。実際のテストコマンドはプロジェクトの種類で決定 |
| `reproduction.*` | writer、reviewer | 不具合の環境、手順、実際・期待する結果、頻度。機能開発では省略可能 |
| `references` | writer | リンク、ファイルパス、関連する作業指示 |
| `open_questions` | Bridge | 未回答の質問。空欄、`none`、`無` 以外があると、回答が書き込まれるまでカードの前で停止 |

## ブロックの形式

- 最初の `# ` で始まる行がタイトルです。
- 各ブロックは `<!-- bridge:<key> -->` から次のマーカー、またはファイル末尾までです。
- キーは `context`、`outcome`、`requested_work`、`run_plan`、`scope_notes.include`、`scope_notes.exclude`、`scope_notes.must_keep`、`scope_notes.expected_locations`、`acceptance`、`verification_hints`、`reproduction.environment`、`reproduction.steps`、`reproduction.actual`、`reproduction.expected`、`reproduction.frequency`、`references`、`open_questions` の 17 項目です。不明・重複のキーは行番号付きで拒否します。
- 未決事項がなければ `open_questions` は空欄、`none`、`無` のいずれかにします。ほかの行は質問とみなし、ファイルに回答するまで `start` はカードの前で停止します。
- frontmatter、タイトル、マーカー、`##`／`###` 見出し、空行は構造です。ブロック外のほかの行は未使用の行としてコントラクトに残します。

## frontmatter

frontmatter はファイル先頭の YAML 設定です。Astro content collections と同じく、先頭行の `---` から次の `---` だけの行までを読みます。全項目は任意で、frontmatter 自体を省略することもできます。

```yaml
---
priority: high              # low / medium / high / urgent。既定は policy の priority.default
writer:                     # モデルと effort。policy の priority テーブルより優先
  model: gpt-6.1-sol        # writer の CLI に対応する名前。null は CLI の既定値
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

最初の承認後、Bridge が frontmatter に `id: <作業指示ID>` を追加します。frontmatter がなければ、この行だけのブロックを作ります。ID は Bridge が管理するため、自分で記入・編集・削除しないでください。コントラクトの SHA-256 には含めません。[ファイル名と作業指示の識別](#file-names-and-identity)を参照してください。

- 不明なキーや不正な値は行番号付きで拒否します。対象外の priority・effort、正の整数でない予算、policy の上限超過などです。上限超過のメッセージには許容値も表示します。
- `writer` は実装と修正、`reviewer` は各レビューに適用します。省略値は policy の priority 表に従います。provider は `bridge.json` または実行ごとの `--writer`／`--reviewer` で決まり、カードに表示します。
- `model` が役割の CLI の命名規則に合わなければ、カードの前で拒否します。Bridge が確認するのは形式だけです。`claude` は `fable`、`opus`、`sonnet`、`haiku`（`[1m]` も指定可能）、または `claude-` を含む名前。`codex` は `gpt-`、`codex-`、または `o` と数字で始まる名前です。**モデルが実在するかは CLI が確認します。** 誤った名前は最初の呼び出しでエラーになります。以下は執筆時の CLI 文書にある名前です。最新の提供状況はリンク先を確認してください。

  | 役割の CLI | 記録された値 | 参照先 |
  |---|---|---|
  | `claude` | 別名：`fable`、`opus`、`sonnet`、`haiku`、`sonnet[1m]`、`opus[1m]`、`fable[1m]`。完全名：`claude-fable-5-1`、`claude-fable-5`、`claude-opus-5-5`、`claude-opus-5`、`claude-sonnet-5`、`claude-haiku-5-5`。古い 4.x の名前も公式文書に記載。Claude Code の `best`、`opusplan`、`default` は Bridge の形式検査では**受け付けません**。 | [Claude Code のモデル設定](https://code.claude.com/docs/en/model-config) |
  | `codex` | `gpt-6.1-sol`、`gpt-6.1-terra`、`gpt-6-astra`、`gpt-6-luna`。この記録では `gpt-5.5` は API key ログインのみ、`gpt-5.4`、`gpt-5.3-codex` などは提供終了となっています。 | [Codex のモデル](https://learn.chatgpt.com/docs/models) |

  `model` を省略するか `null` にすると、CLI の現在の既定モデルを使い、結果には `model: null` と記録します。名前は変更される場合があります。リンク先と CLI の説明を確認してください。カスタム Codex provider は Codex 側でモデルを設定し、ここでは省略します。
- `effort` は両方の役割とも `low`、`medium`、`high` だけです。Claude Code の `xhigh`・`max`、Codex 画面の Extra High・Max・Ultra は、この版の Bridge では使えません。
- トップレベルの `effort` も `writer.effort` として読みます。両方を指定すると拒否します。
- 優先順序は CLI フラグ（`--rounds`、`--call-timeout`）→ 作業指示 → policy の priority 表（model・effort）→ limits です。計画とカードに `cli`、`work_order`、`priority`、`config` の設定元を表示します。
- `tokens` と `tokens_per_call` は writer のみが対象で、cache read は別記して予算から除外します。reviewer の使用量も記録しますが、トークン予算には含めません。
- `run_timeout` は run 全体の上限で、既定は 6 時間です。GitHub Actions の `timeout-minutes` と同じ考え方で、超過時は `timed_out`、理由 `run_timeout` で終了します。各呼び出しも残り時間が上限です。

## ファイル名と作業指示の識別 {#file-names-and-identity}

ファイル名には各言語の文字、数字、結合文字と、`.`、`_`、`-`、単一の空白を使えます。先頭・末尾のドットや空白、パス区切り文字は使えません。上限は 80 文字かつ 180 バイトです。漢字やかなは通常 UTF-8 で 3 バイトなので、日本語ではバイト上限にも注意してください。比較・保存の前に NFC 正規化し、macOS と Windows でも同じ Unicode 名として扱います。

Bridge はファイル名や場所ではなく、frontmatter の `id` で作業指示を識別します。

- 改名、移動、番号の変更：同じ作業指示です。
- 内容を編集して再実行：同じ作業指示の新しい版です。
- 元のファイルと同じ `id` を持つコピー：新しい作業指示として、承認時に別の ID を付けます。
- 同じファイルへの 2 つのハードリンク：同じ作業指示です。ファイル ID を提供しないファイルシステムではコピーとの区別ができないため、推測せず拒否します。

カードに識別結果を表示します。修正する場合は `--update <work_order_id>` または `--as-new` を指定してください。[カードと作業指示の識別](./start#work-order-identity)を参照してください。

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
