# Concepts

Review Bridge runs work orders with two independent AI agents: a **writer** that makes the changes and a **read-only reviewer** that checks them. Bridge resolves the scope, budget, verification command, and the point where control returns to you. The agents cannot change those limits.

This documentation uses a few common terms: a **run** is one execution, a **session** is an agent's working context, a **provider** is the CLI assigned to a role (`claude` or `codex`), and **policy** means the rules Bridge enforces in code.

## The lifecycle of a run

```text
Work order .md
  → Seal the plan: scope, budget, verification command, breakpoint
  → Show the card for your approval
  → Writer translates the work order into the contract; reviewer checks it; Bridge seals it
  → Writer implements (up to rounds); Bridge runs tests after each round
  → Reviewer reviews and judges each acceptance criterion; Bridge records each
  → Write the result file
  → You inspect the work and decide whether to commit
```

The database records work-order versions, plans, authorizations, contracts, runs, events, verdicts, and deliveries. The result file is a copy for you to read.

## Roles

Both `claude` and `codex` can be the writer or reviewer, in all four pairings. Set roles in `bridge.json`, or use `--writer` and `--reviewer` for a single run. The work order's `writer:` and `reviewer:` blocks set each role's model and reasoning effort. Omitted settings come from the policy's priority table.

**Roles do not change during a run.** Changes to `bridge.json` take effect on the next `start`; the card shows the selected pairing.

Each role has its own CLI process and session, even when both use the same provider. Bridge starts the reviewer separately. A check performed by a writer's sub-agent does not count as independent review.

| Access | Used for | Claude Code | Codex |
|---|---|---|---|
| `none` | Contract translation | `--tools "" --strict-mcp-config` | `exec --sandbox read-only` |
| `read` | Contract check and review | `--permission-mode plan --tools Read,Grep,Glob --disallowedTools Write,Edit,NotebookEdit,Bash,PowerShell --strict-mcp-config --no-session-persistence` | `exec --ephemeral --sandbox read-only` |
| `write` | Writer | `--permission-mode auto --strict-mcp-config`; adds `--mcp-config .mcp.json` if the project has that file | `app-server`, with thread settings `sandbox: workspace-write` and `approvalPolicy: never` |

## Evidence of read-only access

`start` and `resume` check the reviewer's read-only restrictions before calling models to carry out the work order. The local page service keeps a separate result for each provider in memory. The two checks provide different levels of evidence:

- **Codex** attempts to write a sentinel file used to test permissions. The operating-system sandbox must deny the write.
- **Claude Code** must report plan mode in its `init` event, with only `Read`, `Grep`, and `Glob` available. The sentinel file must not exist, and the CLI must finish normally. Any additional tool, including an MCP tool, fails the check and prevents work from starting.

## Isolating personal connectors

Sessions started by Bridge do not inherit your personal MCP connectors. Every Claude Code call uses `--strict-mcp-config`; only the writer receives the project's `.mcp.json`. If a contract-translation session still lists MCP tools in its `init` event, Bridge stops the run and names the tools that were not isolated.

Every Codex call uses `--disable apps --disable plugins` and disables each server returned by `codex mcp list`. If the list cannot be read, work does not start.

To allow an MCP server for the reviewer, add its name to the project's `reviewer.mcp_allow` policy. These servers are passed through **without read-only verification**, and the card states that limitation. This permission applies only to reviewer calls, not the writer or contract translation.

## Contracts and authorization

- `start` seals the work-order text, scope, budget, and verification command into a plan. When you confirm the card, you authorize that plan and its work-order content.
- After authorization, Bridge fills contract fields from the work order's marked blocks. The writer turns acceptance blocks into numbered criteria, and the reviewer checks them before Bridge seals the contract. There is no second human approval.
- Authorization records cannot be changed after creation. Missing, malformed, expired (24 hours), or already-used authorization is rejected.
- Editing a work order after a run starts does not change what was authorized. Run `start` again to create a new version and a new card.
- `source_id` is an ID from your own system. Bridge does not use it to decide work-order identity or execution rules. You can use it to find a work order in result files and `logs`.

## Bridge runs the tests

After each writer round, Bridge runs the project type's test command **outside** the agent's sandbox. Tests must pass before review. Even if the writer reports that it cannot run tests, Bridge can still obtain the actual test result. Projects without a test command can also run; the card, records, and result explicitly state that no tests ran.

## Work proof

In a Git project, Bridge records the starting commit, reads file changes from Git at the end, and checks them against its own records. “Files changed” separates changes observed through Git, writer claims that have not been checked against Git, and changes that were already uncommitted at the start. Without Git, the result states that work proof is unavailable.

## Project files and runtime data

Bridge is a global tool. Project settings, work orders, and result copies live in `.review-bridge/`, excluded through `.git/info/exclude`. Bridge does not edit `.gitignore`, `AGENTS.md`, `CLAUDE.md`, `.claude/`, or your existing skills. Agent entry points are installed at the user level and shared across projects. Runtime records live in the operating system's data and log directories.

## Security model

- Missing, malformed, expired, or already-used authorization fails closed: work is refused.
- Writer and reviewer use independent sessions. The read-only checks are described above.
- Native model work requires your authorization of the card (at a terminal, or relayed by an agent using `--yes`) and a successful reviewer check held by the local page service. Preventing an agent from authorizing work on its own remains the agent tool's responsibility, through its permission prompts.
- Bridge does not commit, push, deploy, or publish.
- Bridge state must use a local filesystem. Synced and network folders are rejected.
