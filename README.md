# Review Bridge

```sh
cd your-project
npx review-bridge init
```

Review Bridge runs your work orders with two separate agents: a writer that does the work and an independent, read-only reviewer that checks it. Bridge itself decides the scope, the budget, the verification command and when to stop and hand back to you; the agents cannot change those.

## What `init` does

`init` asks three questions, each with a default you can take with Enter:

1. the writer (`claude` or `codex`; your saved default, else `claude`),
2. the reviewer (your saved default, else `codex`),
3. the project type (what detection finds in the folder, else `none`).

Then it sets the current folder up and prints the next commands:

- creates `.review-bridge/` with the project settings, the work-order template and the queue; in a Git repository it is kept out of Git through `.git/info/exclude` (tracked `.gitignore` is never edited);
- runs four fake self-tests (`PASS`, `FAIL_THEN_PASS`, `HARD_STOP`, `RATE_LIMIT`) that call no model;
- starts the local page on `127.0.0.1`.

It changes no application file and leaves `.claude/` and `.codex/` alone. Options answer the questions instead (`--writer`, `--reviewer`, `--profile <type|none>`, `--target <folder>`); without a terminal, or with `--yes`, nothing is asked and the defaults are used.

The project type only picks the verification command Bridge runs after the work (for example `npm test`). With `none`, Bridge has no verification command, so only documentation-only work can pass.

## Requirements

- Node.js 22 or newer, with npm.
- Git. Work runs without it, but the work proof needs Git: with Git, Bridge records the commit a run starts from and reads the changes from Git; without it, the result says there is no work proof.
- The `claude` and/or `codex` CLI, installed and signed in, for the roles you choose.

## Your first work order

```sh
cp .review-bridge/work-packages/TEMPLATE.md .review-bridge/work-packages/add-readme.md
# describe the work and its acceptance results, in any language
review-bridge work-plan .review-bridge/work-packages/add-readme.md
review-bridge work-start --plan .review-bridge/review-queue/add-readme.plan.json
```

`work-plan` seals the work order, its scope, budget and verification into a plan. At a terminal it asks where the work should stop for you and what it will change. `work-start` shows the plan and starts only after you confirm it at the terminal. Bridge never commits, pushes or deploys.

## Commands

```text
review-bridge init                     set up the current folder
review-bridge work-plan <file>         plan a work order
review-bridge work-start --plan <file> confirm and run a plan
review-bridge work-status              show work state
review-bridge work-cancel              cancel the active authorization
review-bridge stop <run_id>            stop a running work order
review-bridge up | down | ps | watch   the local page service
review-bridge upgrade                  move a project's setup to this version
review-bridge uninstall --target .     remove a project's setup (backed up first)
review-bridge roles-check              check the writer and reviewer CLIs
review-bridge --version | --help
```

Work commands use the current folder, or `--project <folder>`.

## Where data lives

- In the project: `.review-bridge/`.
- For you, shared by all your projects: your settings (`settings.json`, the default roles) and the database, in `%LOCALAPPDATA%\ReviewBridge` on Windows, `~/Library/Application Support/ReviewBridge` on macOS and `~/.local/share/review-bridge` on Linux. `REVIEW_BRIDGE_DATA_HOME` moves it.
- Backups made by `upgrade` and `uninstall`: `%LOCALAPPDATA%\CodexReviewBridge\backups` on Windows, or `--backup-root <folder>`. They can hold private work data; do not publish them.

## Upgrade and remove

```sh
npm i -g review-bridge@latest     # then, in each project: review-bridge upgrade
npm uninstall -g review-bridge    # remove a project's setup first: review-bridge uninstall --target .
```

## Safety model

- A missing, malformed, expired or consumed authorization fails closed.
- The writer and the reviewer run in separate sessions; the reviewer is read-only.
- Bridge runs the verification command itself before the reviewer's verdict can pass.
- Native model work starts only from `work-start` confirmed at an interactive terminal, after the reviewer's read-only check passed on the local page.
- Bridge state must be on a local filesystem; synchronized and network folders (OneDrive, Dropbox, iCloud Drive, UNC, NFS, SMB) are refused.

## Platforms

Windows x64 is native-verified. Apple Silicon macOS is a selectable candidate, not native-verified. Linux is experimental and fails closed for native work.

## Development

```sh
npm test                    # installer tests
npm run test:runtime        # runtime integration and platform tests
npm run test:state-contract # state contract acceptance
```

Tests never call a model. `npm run smoke:claude-session-live -- --confirm-live-model-calls` makes two small live Claude calls and is never part of `npm test`.

## License

MIT
