# Your first work order

<script setup>
import SchemaPeek from "../.vitepress/theme/components/SchemaPeek.vue"
import simpleContract from "./samples/add-readme.contract.8d086ca.json?raw"
import fullContract from "./samples/checkout-discount.contract.5e73907.json?raw"
</script>

A work order is a Markdown file in `.review-bridge/work-packages/`. Bridge parses the block markers, copies each block into the matching contract field, and splits the acceptance list into numbered conditions (AC1, AC2, and so on). This is done in code without a model call and records 0 tokens in the result.

If another tool generates your work orders, have it output the fixed format on this page.

## Start from a template

```sh
cp .review-bridge/work-packages/TEMPLATE.md .review-bridge/work-packages/add-readme.md
```

Fill in the blocks you need and delete unused blocks entirely. `##` headings are for people and can use any language. Bridge identifies blocks by `<!-- bridge:… -->` markers.

## A simple work order

Only `requested_work` and `acceptance` are required. This example also includes a title, background, and an open-questions block to keep the request organized:

```markdown
---
source_id: DOC-1
---
# Add a README to the project

<!-- bridge:context -->
## Background
The project has no README, so new teammates do not know how to start it.

<!-- bridge:requested_work -->
## Requested work
Add README.md at the project root, explaining the project and how to start it.

<!-- bridge:acceptance -->
## Acceptance
1. README.md exists at the project root, with the project name on its first line.
2. The README has a "Getting started" section.

<!-- bridge:open_questions -->
## Open questions
none
```

## Work-order validation {#work-order-validation}

`start` validates the work order as a form. If any of the following checks fails, it stops before showing the card, lists each problem with its block and line number, and prints the command to run after you fix it:

- **Work instructions:** `requested_work` or `run_plan` must contain work to do.
- **Acceptance list:** `acceptance` must contain valid Markdown list items, starting with `- `, `* `, `+ `, or `1. `. Formats such as `一、` and `（1）` aren't list markers. Bridge uses markdown-it, the parser used by VitePress, and makes each list item one condition.
- **Open questions:** `open_questions` must be empty or contain only `none` or `無`. Any other line is an unanswered question. Write the answer into the work order, then remove the question or replace it with `none`.

If you remove a required work or acceptance marker, Bridge appends the marker and heading so you know where to fill it in. It doesn't change your existing lines. A `# ` title is optional; without one, the title is `untitled`.

Bridge checks structure and required content, not whether your requirements are clear enough. For practical ways to make them verifiable, see [When Bridge needs your input](../principles/asking).

## From work order to contract

Once validation passes, Bridge builds the contract in code, before showing the authorization card. No model is called.

- Each marked block is copied into its matching contract field. `source_refs` records its line ranges in the sealed work order. Empty optional blocks use `null` or `[]`. Text outside the blocks goes into `unused_lines`, except for document structure such as headings.
- Each acceptance list item becomes a condition, numbered `AC1`, `AC2`, and so on. Its `statement` keeps the original text without the list marker, along with the source line ranges.
- The title and selected frontmatter values go into `ticket`: title, `source_id`, `priority`, writer `effort`, and `budget`.
- `open_questions` has no contract field. Bridge checks it before work starts so unanswered questions block the start.
- The contract also contains the sealed work-order text (`source.lines`) and that text's SHA-256 (`source.sha256`).

Bridge then computes a SHA-256 for the whole contract, independent of JSON key order, and shows it on the card. For the simple work order on this page, the contract hash is:

```text
sha256 8d086cae7ac4a9cb7202943d6ff17540235a0b0a6bed7ef4024161683c6e82e3
```

Your approval authorizes the contract with that hash. Bridge stores it under the hash in its data directory and recomputes the hash whenever it reads the file. A mismatch stops the work. A copy also goes into `.review-bridge/results/<work-order>/contract.v<version>.<first-seven-hash-characters>.json`. Editing the work-order file doesn't change the sealed version. Run `start` again to use the edited text as the next version of the same work order.

### The contract for the simple example

Bridge generated and sealed this JSON from the simple work order above. The two acceptance items become `AC1` and `AC2`; their `source_refs` point to line ranges in `source.lines`. Because the work order doesn't set `priority`, `effort`, or `budget`, those fields are `null` in `ticket`; the card uses the configured defaults. Other empty blocks use `null` or `[]`. `open_questions` has no separate contract field.

<SchemaPeek title="add-readme.md → contract 8d086ca" :source="simpleContract" locale="en" />

Bridge validates the contract against `contract.schema.json` (JSON Schema draft-07) before sealing it and whenever it reads it back. All top-level fields must be present; individual `budget` settings may be omitted. Objects reject additional fields.

### What the writer receives

Every writer prompt includes the full contract and its hash, plus a PROJECT section with information Bridge retrieved from the [project graph](./start#project-graph). The writer must report `done` or `not_done` for every AC and can report the work complete only when all are `done`. Bridge rejects missing, duplicate, or unknown AC IDs, as well as a completion claim with conditions still unfinished.

### What the reviewer receives

The reviewer receives the same contract and must give a verdict for every AC:

- `pass`: include evidence, such as a file and line number or test output.
- `fail`: include a finding linked to that AC.
- `cannot_verify`: explain what is missing.

A failed condition rules out an overall PASS. If the response breaks these rules, Bridge asks the reviewer to correct it once. A second invalid response ends the run.

### How Bridge decides

Bridge checks the verdict for each condition. An overall PASS alone doesn't establish that the work is complete. A `pass` becomes `proven`, a `fail` becomes `failed`, and `cannot_verify` or a missing verdict becomes `unknown`.

- **Every condition proven:** deliver the work.
- **A condition failed:** the review must be FAIL. Send the work back to the writer if correction rounds remain.
- **Overall PASS with an unknown condition:** stop without delivering the work as passed. The result is titled `Your decision needed`; `Why` explains that not every acceptance condition was shown to hold.

### How this appears in the result

The `Acceptance` section has one row per AC: Bridge's decision, your original condition, and the reviewer's verdict and evidence. The last line identifies the version checked. This excerpt comes from the English fake-CLI run documented in [Results, logs, and the database](./results). The evidence text is a fixed fixture response:

```markdown
## Acceptance
- AC1 proven: README.md exists at the project root, with the project name on its first line. (reviewer: pass; evidence: fake: read the delta and the test output for AC1)
- AC2 proven: The README has a "Getting started" section. (reviewer: pass; evidence: fake: read the delta and the test output for AC2)
Checked on commit none plus uncommitted changes.
```

See [Results, logs, and the database](./results) for the full result file.

## Complete example

This bug-fix example uses all blocks. For a feature request, you can omit the five `reproduction.*` blocks. When parsed, its card shows `Priority: high (work order)` and `rounds 2 (work order)`; parentheses identify the work order as the setting's source.

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
# Checkout total does not update after applying a discount code

<!-- bridge:context -->
## Background
After entering a discount code in CheckoutSummary and receiving API status 200, the total still shows the original price. Support received 14 reports this week. The discount API response changed in 2026-10: it previously returned `total` and now returns `subtotal`, `discount`, and `total`.

<!-- bridge:outcome -->
## Expected outcome
Show the discounted total within one second of entering a valid code. For an invalid code, keep the total unchanged and show an error message.

<!-- bridge:requested_work -->
## Requested work
1. Fix CheckoutSummary to use the API's new `total` after applying a discount code.
2. For an invalid code, show the API error message and keep the previous total.
3. Add unit tests for both cases.

<!-- bridge:run_plan -->
## Run plan
### RUN A
Fix the total calculation and display for valid discount codes.
- effort: high
- acceptance:
  - After a valid code, the total equals the API's total.

### RUN B
Handle invalid-code errors.
- depends_on: RUN A
- budget: { rounds: 1 }
- acceptance:
  - An invalid code shows an error and leaves the total unchanged.

<!-- bridge:scope_notes.include -->
## Include
- Discount input and total in checkout
- Unit tests for these two cases

<!-- bridge:scope_notes.exclude -->
## Exclude
- The discount API itself (a separate backend ticket)
- The cart subtotal

<!-- bridge:scope_notes.must_keep -->
## Must keep
- Total calculation without a discount code remains unchanged
- All existing checkout tests must pass
- Do not change API paths or parameters

<!-- bridge:scope_notes.expected_locations -->
## Likely locations (hints only, not authorization to edit)
- src/components/checkout/CheckoutSummary.vue
- src/composables/useDiscount.ts
- tests/unit/checkout/

<!-- bridge:acceptance -->
## Acceptance
1. Within one second of entering a valid code, the displayed discounted total equals the API's `total`.
2. An invalid code leaves the total unchanged and displays the API's error message.
3. `npm test` passes. Both new tests fail before the fix and pass after it.

<!-- bridge:verification_hints -->
## Verification hints
- Test data: `WELCOME10` (valid, 10% off), `EXPIRED` (invalid, API returns 422 and "Discount code expired").
- Existing tests: `tests/unit/checkout/CheckoutSummary.spec.ts`.

<!-- bridge:reproduction.environment -->
## Bug: environment
Chrome 130, Windows 11, frontend v2.14.0, test environment.

<!-- bridge:reproduction.steps -->
## Bug: steps to reproduce
1. Put one item priced at 1000 in the cart and open checkout.
2. Enter `WELCOME10` and apply it.
3. Check the total.

<!-- bridge:reproduction.actual -->
## Bug: actual result
API returns 200, but the total still shows 1000.

<!-- bridge:reproduction.expected -->
## Bug: expected result
The total shows 900.

<!-- bridge:reproduction.frequency -->
## Bug: frequency and impact
Every time; all checkouts using discount codes.

<!-- bridge:references -->
## References, attachments, and dependencies
- Discount API documentation: docs/api/discount.md
- Related ticket: SHOP-398 (API response change)

<!-- bridge:open_questions -->
## Open questions
none
```

Here is the contract Bridge generated and sealed from the complete example above. It has five conditions: the three work-order conditions become `AC1`–`AC3`, followed by RUN A's `AC4` and RUN B's `AC5`. Each run's condition names that run in `run_refs`. The frontmatter values for `priority`, `writer.effort`, and `budget` appear in `ticket`.

<SchemaPeek title="checkout-discount.md → contract 5e73907" :source="fullContract" locale="en" />

The table below maps work-order blocks to contract fields and explains how they are used. Both roles receive the full contract in every prompt, so both can read every field.

| Work-order content | Contract field | How it is used |
|---|---|---|
| Frontmatter and `# ` title | `ticket` | Title, `source_id`, `priority`, writer `effort`, and `budget`. These values, CLI flags, and policy determine the effective settings and sources shown on the card |
| `context`, `outcome` | `context`, `outcome` | Background and expected outcome, available to both roles |
| `requested_work` | `requested_work` | Work instructions; required unless there is a `run_plan` |
| `run_plan` | `run_plan.runs[]`: name, text, `depends_on`, `effort`, `budget` | Stored in the contract; this version executes the entire work order as one run |
| `scope_notes.include` / `exclude` / `must_keep` | `scope_notes.include` / `exclude` / `must_keep` | Help the reviewer check scope and behavior that must be preserved |
| `scope_notes.expected_locations` | `scope_notes.expected_locations` | Suggest where the writer should look; **doesn't authorize edits**. The card's `Scope` sets the boundary |
| `acceptance` | `acceptance[]`: `AC1`, `AC2`, and so on | Required. The writer reports, the reviewer judges, and Bridge decides each condition; the result lists them individually |
| Each run's `acceptance` inside `run_plan` | Additional `acceptance[]` items; `run_refs` names the planned run | Numbered after the work-order conditions. Above, the three main conditions become `AC1`–`AC3`, followed by RUN A's `AC4` and RUN B's `AC5` |
| `verification_hints` | `verification_hints[]` | Test data and existing test names for both roles. The project's test rules determine the command shown under `Tests` on the card |
| `reproduction.*` | `reproduction`, or `null` when all five blocks are empty | Bug environment, steps, actual and expected results, and frequency; omit for feature work |
| `references` | `references[]` | Links, file paths, and related work orders |
| `open_questions` | No field | Pre-start check only. Anything other than `none`, `無`, or blank stops `start` before the card until you answer in the work order |
| Text outside blocks that isn't document structure | `unused_lines` | Preserved with source line ranges; not treated as a block |

## Block format

- The first line starting with `# ` is the title.
- Each block starts at `<!-- bridge:<key> -->` and ends at the next marker or the end of the file.
- The 17 keys are `context`, `outcome`, `requested_work`, `run_plan`, `scope_notes.include`, `scope_notes.exclude`, `scope_notes.must_keep`, `scope_notes.expected_locations`, `acceptance`, `verification_hints`, `reproduction.environment`, `reproduction.steps`, `reproduction.actual`, `reproduction.expected`, `reproduction.frequency`, `references`, and `open_questions`. Unknown or duplicate keys are rejected with line numbers.
- Leave `open_questions` blank or use `none` or `無` when no questions remain. Any other line is treated as a question and prevents `start` from showing the card until you answer it in the file.
- Frontmatter, the title, markers, `##`/`###` headings, and blank lines are structure. Other lines outside marked blocks remain in the contract as unused lines.

## Frontmatter

Frontmatter is YAML at the start of the file, following the Astro content collections convention: the first line is `---`, ending at the next line containing only `---`. Every field is optional; you can omit frontmatter entirely.

```yaml
---
priority: high              # low / medium / high / urgent; default: policy priority.default
writer:                     # Model and effort override the policy's priority table
  model: gpt-6.1-sol        # Must belong to the writer CLI; null uses its default
  effort: high              # low / medium / high
reviewer: { model: opus, effort: medium }   # Same settings for the reviewer
budget:                     # All optional; defaults come from the matching policy limits
  tokens: 2000000           # limits.tokens
  tokens_per_call: 150000   # limits.tokens_per_call
  call_timeout: 1200000     # limits.call_timeout, milliseconds
  test_timeout: 600000      # limits.test_timeout, milliseconds
  run_timeout: 7200000      # limits.run_timeout, milliseconds
  rounds: 2                 # limits.rounds
source_id: SHOP-412         # Your external ticket ID; not an execution rule
---
```

After your first approval, Bridge adds `id: <work-order-ID>` to frontmatter. If there was no frontmatter, it creates a block containing that line. Bridge manages the ID: don't supply, edit, or delete it yourself. It isn't part of the contract's SHA-256. See [File names and identity](#file-names-and-identity).

- Unknown keys and invalid values are rejected with line numbers. Examples include unsupported priority or effort, non-integer or nonpositive budgets, and values above the policy ceiling. Errors identify the allowed limit.
- `writer` settings apply to implementation and corrections; `reviewer` settings apply to each review. Omitted values use the policy's priority table. Providers come from `bridge.json` or per-run `--writer`/`--reviewer` options and appear on the card.
- `model` must match the role CLI's naming rules, or it's rejected before the card. Bridge checks the name's format only: for `claude`, the aliases `fable`, `opus`, `sonnet`, `haiku`, optionally with `[1m]`, or a name containing `claude-`; for `codex`, names beginning with `gpt-`, `codex-`, or `o` followed by a digit. **The CLI determines whether the model actually exists.** An unavailable name fails on the first call. The following names reflect the CLI documentation when this page was written; check the linked docs for current availability:

  | Role CLI | Values in the snapshot | Source |
  |---|---|---|
  | `claude` | Aliases: `fable`, `opus`, `sonnet`, `haiku`, `sonnet[1m]`, `opus[1m]`, `fable[1m]`. Full names: `claude-fable-5-1`, `claude-fable-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-5-5`; older 4.x names are also listed upstream. Claude Code's `best`, `opusplan`, and `default` are **not accepted** by Bridge's naming check. | [Claude Code model configuration](https://code.claude.com/docs/en/model-config) |
  | `codex` | `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-astra`, `gpt-6-luna`. The snapshot records `gpt-5.5` as API-key-only, and `gpt-5.4`, `gpt-5.3-codex`, and others as retired. | [Codex models](https://learn.chatgpt.com/docs/models) |

  Omit `model` or set it to `null` to use the CLI's current default; results record `model: null`. Names may change with CLI releases. Check the linked documentation and CLI help. For a custom Codex provider, set the model in Codex and omit `model` here.
- Both roles accept only `low`, `medium`, and `high` for `effort`. Claude Code also offers `xhigh` and `max`, and the Codex interface offers Extra High, Max, and Ultra; this Bridge release doesn't support those values.
- Top-level `effort` is still accepted as `writer.effort`. Specifying both is rejected.
- Precedence is CLI flags (`--rounds`, `--call-timeout`) → work order → policy priority table for model and effort → policy limits. Plans and cards show each value's source: `cli`, `work_order`, `priority`, or `config`.
- `tokens` and `tokens_per_call` apply only to the writer and exclude cache reads, which results list separately. Reviewer usage is recorded without a token budget.
- `run_timeout` limits the whole run, defaulting to 6 hours, like a GitHub Actions job's `timeout-minutes`. At the limit, the run ends as `timed_out` with reason `run_timeout`; each call is capped by the remaining time.

## File names and identity {#file-names-and-identity}

File names can use letters, digits, and combining marks from any script, plus `.`, `_`, `-`, and single spaces. Leading or trailing dots and spaces, and path separators, aren't allowed. The limits are 80 characters and 180 UTF-8 bytes; multibyte characters may reach the byte limit first. Names are normalized to NFC before comparison and storage, so equivalent Unicode names match on macOS and Windows.

Bridge identifies a work order by its frontmatter `id`, not its name or location:

- Rename, move, or renumber a file: the same work order.
- Edit its content and start again: a new version of the same work order.
- Copy it while the original still exists with the same `id`: a new work order, assigned its own ID on approval.
- Two hard links to one file: the same work order. If the filesystem doesn't provide file IDs, Bridge can't distinguish a hard link from a copy and rejects the request rather than guessing.

The card shows which work order it identified. Use `--update <work_order_id>` or `--as-new` if you need to correct it. See [Which work order are you approving?](./start#work-order-identity).

## Run plans

Use a run plan when a work order describes two or more planned steps. Each `### ` heading defines a planned run, named after its heading. Four fixed keys are read as YAML; other text describes that step's work.

**A run plan is currently recorded as contract data; it does not automatically create multiple runs.** This example has two dependent documentation steps:

```markdown
<!-- bridge:run_plan -->
## Run plan
### RUN A
Write the installation instructions.
- effort: low
- acceptance:
  - The README includes installation steps.

### RUN B
Add startup instructions.
- depends_on: RUN A
- budget: { rounds: 1, call_timeout: 600000 }
- acceptance:
  - The README includes a startup command.
```

- `effort` and `budget` use the same values as frontmatter. `depends_on` accepts one run name or a list such as `[RUN A, RUN B]`. Missing dependencies and cycles are rejected.
- Each run's `acceptance` list covers that step. The work order's main `acceptance` block covers the overall outcome. A run plan needs at least two runs; a plan with only one is rejected.
- Bridge records the plan in the contract; **the entire work order currently executes as one run**.

## Next step

[Start a run](./start).
