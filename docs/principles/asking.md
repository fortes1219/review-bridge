# When Bridge needs your input

Bridge doesn't run a model interview before work starts. It checks the work order's structure and required content, not whether your requirements are clear enough. The writer's instructions and the reviewer's criteria both come from the work order, so put your requirements, constraints, and unresolved choices there. Here's where you need to provide input or approval.

## Before the card: complete the work order

`start` reads the work order as a form. Missing required content stops it before the card, with an explanation and line numbers for each problem:

- `requested_work` or `run_plan` has no content, so there's no work to do.
- The acceptance list is missing, or a line isn't a Markdown list item. Formats such as `一、` and `（1）` aren't list markers.
- `open_questions` still contains questions. Each line is treated as unanswered. Write the answer into the work order, then remove the question or leave only `none`.

If you've removed a required block marker, Bridge appends it and its heading without changing your existing text. Fill it in, then rerun the command shown in the message. This step uses no tokens.

Put unresolved choices in `open_questions`. `start` will wait until you resolve them instead of leaving the writer to guess.

## On the card: approve the exact work

The card shows the sealed work-order text, contract SHA-256, scope, budget, and roles. Your approval covers that card. Later edits require another `start` before they're used. An agent may show you the full card and wait for your answer; it may not approve for you.

## During execution: work stops for your decision

The writer doesn't pause mid-run to wait for a reply. If it needs your decision, stops before finishing, or the reviewer requires a stop—for a human choice, an out-of-scope change, or a release action—the run ends with a result titled “Your decision needed.” “Why” includes the question, the writer's explanation, or the reviewer's stop reason. “Next step” asks you to write the answer into the work order and run `start` again. If automatic correction rounds run out instead, the result is titled “Needs fixing.”

## How your requirements are used

Each block is copied unchanged into the contract, and each acceptance-list item becomes one condition. After the writer finishes a round, Bridge runs the project tests and the reviewer checks each condition. Results mark each one `proven`, `failed`, or `unknown`. A condition that can't be verified from code or tests remains `unknown`, even if the work looks good.

Write each acceptance criterion as something the reviewer can check in code, tests, or the application's behavior.

## Three ways to describe the same change

These three work orders ask for the same change and all pass the form check. The difference is how much the writer has to decide and how much the reviewer can verify.

### A brief request

```markdown
# Last sync time

<!-- bridge:requested_work -->
Show the last sync time somewhere on the dashboard.

<!-- bridge:acceptance -->
- The time is visible.
```

The writer chooses the location, wording, and format. The reviewer can verify little beyond whether a time appears. This can work for a quick prototype; a specific production result needs more detail.

### Describe what users need

```markdown
# Show when dashboard data last synced

<!-- bridge:context -->
Support keeps getting asked whether the dashboard numbers are up to date.

<!-- bridge:requested_work -->
Show the last successful sync time at the top of the dashboard, in the user's time zone.

<!-- bridge:acceptance -->
- After the dashboard loads, the top of the page shows "Last synced" with a date and time.
- If data has never synced, show "Not synced yet" instead of leaving it blank.
- Use the browser's time zone.
```

You don't need file names or code; the writer finds the right place to make the change. Each criterion describes behavior the reviewer can check, including the never-synced case, so the expected result is clearer.

### Point to the code

```markdown
# DashboardHeader: show lastSyncedAt

<!-- bridge:requested_work -->
In `DashboardHeader.vue`, read `lastSyncedAt` from `GET /api/sync/status` and
display it with `formatLocalTime()` from `src/utils/time.ts`.

<!-- bridge:scope_notes.include -->
- src/components/DashboardHeader.vue
- src/utils/time.ts

<!-- bridge:acceptance -->
- When `lastSyncedAt` is set, show "Last synced" followed by `formatLocalTime()` output.
- When `lastSyncedAt` is `null`, show "Not synced yet".
- `npm test` passes.

<!-- bridge:open_questions -->
none
```

Naming files and functions gives the writer a starting point; scope notes show where you expect the changes. Use this when you know the codebase. If you only know what users should see, the previous version is enough.

## Tips that help with any work order

- Keep each work order focused on one change. Separate unrelated work so you can verify the results independently.
- Include edge cases you care about: empty data, missing values, errors, or a second attempt. Without a requirement, the reviewer has no clear criterion for that case.
- Put behavior that must stay unchanged in `scope_notes.must_keep` and known background in `context`. Both are copied into the contract for the writer.
- Add paths to team conventions, past decisions, and accepted examples under `references`; those references are copied into the contract too.

See [Your first work order](../guide/work-order) for the available blocks.
