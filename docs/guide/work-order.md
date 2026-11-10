# Your first work order

A work order is a Markdown file in `.review-bridge/work-packages/`. Bridge parses its block markers and copies the original text into the matching contract fields. The model only turns acceptance blocks into numbered criteria.

If another tool generates your work orders, have it output the fixed format on this page.

## Start from a template

```sh
cp .review-bridge/work-packages/TEMPLATE.md .review-bridge/work-packages/add-readme.md
```

Fill in the blocks you need and delete unused blocks entirely. `##` headings are for people and can use any language. Bridge identifies blocks by `<!-- bridge:… -->` markers.

## Minimal example

The minimum is a title, a `requested_work` block, and an `acceptance` block:

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

A work order needs at least one verifiable criterion. Without one, Bridge stops before calling a model and asks you to add it.

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

| Block | Used by | Purpose |
|---|---|---|
| `context`, `outcome` | writer, reviewer | Original text enters the contract, explaining the background and expected outcome. |
| `requested_work` | writer | The specific work to do; required. |
| `run_plan` | Bridge | Describes two or more planned steps. Recorded in the contract; currently the whole work order still executes as one run. |
| `scope_notes.include` / `exclude` / `must_keep` | writer, reviewer | Lets the reviewer check for scope expansion and damage to behavior that must be preserved. |
| `scope_notes.expected_locations` | writer | Hints about likely files, **not permission to edit them**. The authorized scope is the card's `Scope`. |
| `acceptance` | reviewer, Bridge | Required. The model extracts AC1, AC2, …; the result reports each criterion's decision. |
| `verification_hints` | writer, reviewer | Test data and existing test names. The project type determines the actual test command. |
| `reproduction.*` | writer, reviewer | Bug environment, steps, actual and expected results, and frequency. Optional for feature work. |
| `references` | writer | Links, paths, and related tickets. |
| `open_questions` | Bridge | Unanswered questions. Any content other than `無`, `none`, or blank lines stops work for your answer. |

## Block format

- The first line beginning with `# ` is the title.
- Each block starts at `<!-- bridge:<key> -->` and ends at the next marker or end of file.
- The keys correspond to the contract's 17 fields: `context`, `outcome`, `requested_work`, `run_plan`, `scope_notes.include`, `scope_notes.exclude`, `scope_notes.must_keep`, `scope_notes.expected_locations`, `acceptance`, `verification_hints`, `reproduction.environment`, `reproduction.steps`, `reproduction.actual`, `reproduction.expected`, `reproduction.frequency`, `references`, `open_questions`. Unknown or duplicate keys are rejected with a line number.
- `open_questions`: use `無`, `none`, or leave it empty when there are no questions. Every other line is treated as a question; Bridge stops before calling a model until you answer it in the work order.
- Frontmatter, titles, block markers, `##` / `###` headings, and blank lines form the structure. Other text outside blocks is kept as “unused lines” in the contract.

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

- Unknown keys and invalid values are rejected with line numbers. Examples include unsupported priority or effort values, a budget that is not a positive integer, or a value exceeding policy limits. Limit errors show the allowed ceiling.
- `writer` applies to implementation, corrections, and contract translation. `reviewer` applies to contract checks and reviews. Omitted fields use the policy's priority table. The provider for each role comes from `bridge.json` or `--writer` / `--reviewer` for that run, and appears on the card.
- `model` must match the role CLI's naming format or it is rejected before the card. Bridge checks only the format: Claude aliases `fable`, `opus`, `sonnet`, `haiku`, optionally with `[1m]`, or a name containing `claude-`; Codex names beginning with `gpt-`, `codex-`, or `o` followed by a digit. **The CLI still decides whether the model exists.** An invalid name fails on its first call. The following names are the documentation snapshot dated 2026-11-06; consult the linked current documentation when choosing a model.

  | Role CLI | Values in the snapshot | Source |
  |---|---|---|
  | `claude` | Aliases: `fable`, `opus`, `sonnet`, `haiku`, `sonnet[1m]`, `opus[1m]`, `fable[1m]`. Full names: `claude-fable-5-1`, `claude-fable-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-5-5`; older 4.x names are also listed upstream. Claude Code's `best`, `opusplan`, and `default` are **not accepted** by Bridge's naming check. | [Claude Code model configuration](https://code.claude.com/docs/en/model-config) |
  | `codex` | `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-astra`, `gpt-6-luna`. The snapshot records `gpt-5.5` as API-key-only, and `gpt-5.4`, `gpt-5.3-codex`, and others as retired. | [Codex models](https://learn.chatgpt.com/docs/models) |

  Omitting `model` or setting it to `null` uses the CLI's current default; the result records `model: null`. Names can change between releases, so check the links and CLI help. For a custom Codex provider, configure the model in Codex and omit `model` here.
- Both roles accept only `low`, `medium`, and `high` for `effort`. Claude Code also has `xhigh` and `max`, and the Codex interface has Extra High, Max, and Ultra; this Bridge version does not support those values.
- The legacy top-level `effort` is still accepted as `writer.effort`. Specifying both is rejected.
- Precedence is CLI flags (`--rounds`, `--call-timeout`) → work order → policy priority table (effort and model) → policy limits. The plan records values and sources (`cli`, `work_order`, `priority`, `config`); the card displays both.
- `run_timeout` caps the whole run at six hours by default, like GitHub Actions job `timeout-minutes`. At the deadline, the run ends as `timed_out` with reason `run_timeout`. Each call is also limited to the remaining run time.

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
