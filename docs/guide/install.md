# Install and set up

Review Bridge is a command-line tool on npm. Start right in your project with `npx review-bridge init`; it retrieves the latest release and sets things up, much like `npm create vite`.

## Requirements

- Node.js 22.8 or newer, with npm.
- Git for **work proof**. Bridge can run without Git, but the result will state that no work proof is available. With Git, it records the starting commit and reads actual file changes.
- The CLI needed for each role, installed and signed in: `claude` (Claude Code), `codex`, or both.
- Local storage for Bridge state. Synchronized and network locations, including OneDrive, Dropbox, iCloud Drive, UNC, NFS, and SMB, aren't supported.

## Initialize a project

```sh
cd your-project
npx review-bridge init
```

`npx` checks npm for the latest release, so it needs network access. To avoid that lookup, install globally with `npm i -g review-bridge`; `npx review-bridge` will then use that copy. With pnpm, Yarn, or Bun, use `pnpm dlx review-bridge init`, `yarn dlx review-bridge init`, or `bun x review-bridge init`. Bridge prints subsequent commands in the same form. See [Package managers](../reference/cli#package-managers).

Like create-vite, `init` asks its questions before making changes. Each has a default you can accept with Enter:

1. **Writer:** `claude` or `codex`. Uses your saved default, or `claude` if none is set.
2. **Reviewer:** uses your saved default, or `codex`.
3. **Project type:** uses the detected type, or `none`. This selects the test command Bridge runs after each writer round, such as `npm test`. Choosing `none` or having no matching command doesn't prevent execution; the card, records, and result say tests aren't configured.
4. **VS Code tasks:** whether to write the project's `.vscode/tasks.json`. The default is **N**. See [In VS Code](./start#in-vs-code).

Setup then starts, with one progress line per step. There's no additional plan preview or confirmation.

You can also supply `--writer`, `--reviewer`, `--profile <type|none>`, and `--target <folder>` directly. Without an interactive terminal, or with `--yes`, unspecified settings use their defaults and no questions are asked.

### What init does

- Creates `.review-bridge/` with `bridge.json`, `policy.override.json`, `rules.md`, and the work-order templates `work-packages/TEMPLATE.md` (English) and `TEMPLATE.zh-TW.md` (Traditional Chinese).
- Adds a `.gitignore` containing `*` inside that directory, keeping everything, including results, out of Git even if you initialize Git later. **Your project's own `.gitignore` isn't edited.**
- Runs four self-tests with fake CLIs, without model calls: `PASS`, `FAIL_THEN_PASS`, `HARD_STOP`, and `RATE_LIMIT`.
- Starts the local page on `127.0.0.1`. The database is created and started on first use.
- Builds a graph of the project's code in the database, without writing graph files to the project. See [The project graph](./start#project-graph).
- Installs agent entry points **outside the project**, shared across projects: `~/.claude/commands/review-bridge.md` for `/review-bridge` in Claude Code, respecting `CLAUDE_CONFIG_DIR`, and `~/.agents/skills/review-bridge/SKILL.md` for `$review-bridge` in Codex. Existing user files at those paths are preserved.

Setup leaves application files, `.gitignore`, `AGENTS.md`, `CLAUDE.md`, and `.claude/` unchanged. If your working tree was clean and you did not opt into `.vscode/tasks.json`, `git status` will still show no changes afterward.

### Output

Example output for a small Git project containing `package.json` and `index.js`. This walkthrough uses rc3's fake CLI, which doesn't call models. Ports and password-file locations vary by machine; `<data home>` stands for your user data directory:

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

`init` detects your system language and saves `locale` in `bridge.json`. The card, `status`, `up`, `down`, `ps`, and result files use that setting. CLI messages currently support English and Traditional Chinese. The line after project parsing summarizes the graph; files that couldn't be parsed are listed individually below it.

After initialization, `git status --short` has no output. `.review-bridge/.gitignore` contains:

```text
# Created by Review Bridge automatically.
*
```

Connection details appear at the end of setup and are also available from `npx review-bridge status`. See [Database in VS Code](./results#database-in-vs-code).

## Next step

Write [your first work order](./work-order), then [start a run](./start).
