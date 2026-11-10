# Review Bridge Agent Guide

## Project Identity

Review Bridge is an npm package (`npx review-bridge`) that runs a person's work orders with two agents in separate sessions: a writer that does the work and a read-only reviewer that checks it. Bridge decides the contract, the scope, the budget, the test step and when to stop; it records every work order, contract, authorization, run and verdict in an embedded PostgreSQL database per person. `README.md` is the user's guide; `ARCHITECTURE.md` says how the code is layered.

## Repository Structure

- `bridge.mjs`: the `review-bridge` command (`bin`).
- `review-bridge/`: the runtime. `router/` holds the command table and help, `features/` the commands (`workOrder/` is most of them), `service/` the database, the agent CLIs and the project graph, `platforms/` the operating-system adapters, `config/` and `policy/` the default policy.
- `installer/`: `init`, `upgrade`, `uninstall`, the agent entries and the VS Code tasks.
- `profiles/`: project types and the test command each one runs.
- `project-templates/`: what `init` copies into a project's `.review-bridge/`, and the agent entries' text.
- `tests/`: the installer's tests. `review-bridge/tests/`: the runtime's tests, with the fake `claude` and `codex` CLIs in `review-bridge/tests/fixtures/`. `review-bridge/tests/mutations/`: the gate mutation cases and the fail-open ledger.
- `scripts/`: `render-commands.mjs` (README's Commands section), `verify-gate-mutations.mjs`.
- `docs/`: the documentation site (VitePress).

`ARCHITECTURE.md` begins with a Codemap: what to change, and where to start.

## Finding Code

1. Start from the Codemap in `ARCHITECTURE.md`.
2. List a file's declarations: `rg -n '^(export |(async )?function |class )' <file or folder> --glob '*.mjs'`.
3. Take one function: `ast-grep run -l js -p 'export async function <name>($$$) { $$$ }' <file>`, or read only those lines.
4. Find its callers: `ast-grep run -l js -p '<name>($$$)' <folder>`.

These locate code. They do not prove that nothing else calls it: unexported arrow functions, indirect calls and tests that start the CLI as a process are missed. Many tests start the CLI as a process, so imports do not show which tests cover a file.

## Tests

```sh
npm test                                     # installer tests (tests/*.test.mjs)
node --test "review-bridge/tests/*.test.mjs" # runtime tests, as CI runs them
node scripts/render-commands.mjs --check     # README's Commands section matches the command table
node scripts/verify-gate-mutations.mjs       # each gate's mistake must make its test fail; not part of npm test
```

- Tests never call a model; they use the fake CLIs. `npm run smoke:claude-session-live -- --confirm-live-model-calls` is the only live call and is never part of a test run.
- Many runtime tests start PostgreSQL and the local page. Each test file gets a data home of its own under the system temp folder and stops what it started when it ends.
- A change of behaviour changes or adds its tests in the same commit.
- CI runs both suites on `ubuntu-latest` and `windows-latest`; a change is done when both are green.

## Generated Files and CI Checks

- README's Commands section is generated from `review-bridge/router/index.mjs` and `review-bridge/router/help.mjs`: edit the table, then run `node scripts/render-commands.mjs`. CI fails when it is out of date.
- A released migration file in `review-bridge/service/database/migrations/` is never renamed or removed; a change to a table is a new migration.

## Boundaries

- Do not commit, push, publish or release without the repository owner's word.
- Writer and reviewer are role names; a provider's name (`claude`, `codex`) appears only in that provider's adapter and in a record's `provider` value.
- Bridge writes nothing in a person's project outside `.review-bridge/`, except `.vscode/tasks.json` when the person says yes to the VS Code tasks.
- Every command Bridge prints is in the one-off form (`npx review-bridge …`); only `--help` names the program.
- Text in Git (code, comments, docs, commit messages) is English.
