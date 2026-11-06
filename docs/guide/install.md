# Install and set up

Review Bridge is a globally installed CLI. Install it once, then run `init` in each project you want to use it with.

## Requirements

- Node.js 22 or later, including npm.
- Git. Projects without Git can still run work orders, but **work proof** requires it. With Git, Bridge records the starting commit and reads the actual file changes. Without Git, the result states that work proof is unavailable.
- The CLIs for your chosen writer and reviewer: `claude` (Claude Code), `codex`, or both. Install them and sign in before running work.
- Local storage for Bridge's state. Synced folders and network drives are not supported, including OneDrive, Dropbox, iCloud Drive, UNC, NFS, and SMB.

## Install

```sh
npm i -g review-bridge@next
```

Release candidates use the `next` tag. Once a stable release is available, use `npm i -g review-bridge`.

## Initialize a project

```sh
cd your-project
review-bridge init
```

`init` first asks for three settings. Each has a default; press Enter to accept it.

1. **Writer**: `claude` or `codex`. Uses your saved default, or `claude` if you have not saved one.
2. **Reviewer**: uses your saved default, or `codex`.
3. **Project type**: uses the detected type, or `none`. This selects the verification command Bridge runs after each writer round, such as `npm test`. If you choose `none`, or the project has no matching command, the work can still run. The card, records, and result will say `tests: not configured`.

It then asks whether to add VS Code tasks to the project's `.vscode/tasks.json`. The default is **N**. See [Start a run](./start#in-vs-code).

You can also supply `--writer`, `--reviewer`, `--profile <type|none>`, and `--target <folder>` directly. Without an interactive terminal, or with `--yes`, unspecified settings use their defaults and no questions are asked.

### What init does

- Creates `.review-bridge/` with `bridge.json`, `policy.override.json`, `rules.md`, and the work-order templates `work-packages/TEMPLATE.md` (English) and `TEMPLATE.zh-TW.md` (Traditional Chinese).
- In a Git project, excludes all of `.review-bridge/`, including results, through `.git/info/exclude`. **It does not edit `.gitignore`.**
- Runs four self-tests with mock CLIs, without calling a model: `PASS`, `FAIL_THEN_PASS`, `HARD_STOP`, and `RATE_LIMIT`.
- Starts the local page service on `127.0.0.1`.
- Installs agent entry points **outside the project**, shared by all your projects. Claude Code uses `~/.claude/commands/review-bridge.md`, called with `/review-bridge`; `CLAUDE_CONFIG_DIR` is honored if set. Codex uses `~/.agents/skills/review-bridge/SKILL.md`, called with `$review-bridge`. If you already have your own file at either path, Bridge leaves it alone.

Setup leaves application files, `.gitignore`, `AGENTS.md`, `CLAUDE.md`, and `.claude/` unchanged. If your working tree was clean and you did not opt into `.vscode/tasks.json`, `git status` will still show no changes afterward.

### Output

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

The last lines show the database connection details. You can see them again at any time with `review-bridge status`. See [Results, logs, and the database](./results#database-in-vs-code).

## Next step

Write [your first work order](./work-order), then [start a run](./start).
