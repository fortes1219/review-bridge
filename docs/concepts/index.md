# Concepts

Review Bridge runs work orders with two independent AI agents: a **writer** that makes the changes and a **read-only reviewer** that checks them. Bridge resolves the scope, budget, verification command, and the point where control returns to you. The agents cannot change those limits.

This documentation uses a few common terms: a **run** is one execution, a **session** is an agent's working context, a **provider** is the CLI assigned to a role (`claude` or `codex`), and **policy** means the rules Bridge enforces in code.

> For the background, see [Managing delivery and verification responsibilities after adopting AI](https://hackmd.io/@FortesHuang/HJnWgQGJMx) (HackMD, in Chinese).

## The lifecycle of a run

```text
Work order .md
  → Validate the form and copy its blocks into a contract (no model call)
  → Seal the plan: scope, budget, test command, and stopping point
  → Show the card for your approval
  → Check the reviewer's read-only restrictions; refresh the project graph
  → Writer implements, up to rounds iterations; Bridge runs tests after each one
  → Reviewer checks; Bridge decides each acceptance criterion
  → Write the result file
  → You inspect the work and decide whether to commit
```

The database records work-order versions, plans, authorizations, contracts, runs, events, verdicts, and deliveries. The result file is a copy for you to read.

## Roles

Both `claude` and `codex` can be the writer or reviewer, in all four pairings. Set roles in `bridge.json`, or use `--writer` and `--reviewer` for a single run. The work order's `writer:` and `reviewer:` blocks set each role's model and reasoning effort. Omitted settings come from the policy's priority table.

**Roles do not change during a run.** Changes to `bridge.json` take effect on the next `start`; the card shows the selected pairing.

Each role has its own CLI process and session, even when both use the same provider. Bridge starts the reviewer separately. A check performed by a writer's sub-agent does not count as independent review.

| Access | Role | Claude Code | Codex |
|---|---|---|---|
| `read` | reviewer | `--permission-mode plan --tools Read,Grep,Glob --disallowedTools Write,Edit,NotebookEdit,Bash,PowerShell --strict-mcp-config --no-session-persistence`, with `--mcp-config` for Bridge's graph server and servers in `reviewer.mcp_allow` | `exec --ephemeral --sandbox read-only`, with `-c mcp_servers.…` for Bridge's graph server |
| `write` | writer | `--permission-mode auto --strict-mcp-config`, with `--mcp-config` for Bridge's graph server and the project's `.mcp.json` if present | `app-server`, with thread `sandbox: workspace-write`, `approvalPolicy: never`, and Bridge's graph server |

Bridge's read-only graph server, `review-bridge-graph`, helps locate definitions, references, and code affected by a change. See [The project graph](../guide/start#project-graph).

## Evidence of read-only access

After you approve `start` or `resume`, Bridge checks the reviewer's read-only restrictions before implementation begins. The check itself calls a model. Its result is cached separately for each provider in the local page service's memory, once per page session. The two providers offer different kinds of evidence:

- **Codex:** attempts to write a sentinel file and verifies that the operating-system sandbox denies it.
- **Claude Code:** checks that the CLI's `init` event reports plan mode with only `Read`, `Grep`, and `Glob`, that the sentinel file wasn't created, and that the CLI finished normally. Bridge's graph server and policy-approved servers are allowed; any additional tools, including other MCP tools, fail the check and prevent work from starting.

## Isolating personal connectors

Sessions started by Bridge don't inherit your personal MCP connectors. Every Claude Code call uses `--strict-mcp-config` and loads only the servers Bridge specifies. The project's `.mcp.json` goes only to the writer; Bridge's graph server goes to both roles. The reviewer's probe and each review use the same server configuration. Unexpected tools in the probe's `init` event fail the check and prevent work from starting.

Every Codex call uses `--disable apps --disable plugins` and disables each server returned by `codex mcp list`. If the list cannot be read, work does not start.

To allow an additional MCP server for the reviewer, add its name to the project policy's `reviewer.mcp_allow`. These servers are passed through **without read-only verification**, and the card states that limitation. This permission applies only to the reviewer, not the writer.

## Contracts and authorization

- `start` seals the work-order text, scope, budget, and test command into a plan. Your approval covers that plan and its work-order content.
- The contract is created in code before the card appears. Bridge copies marked blocks unchanged and splits the acceptance list into numbered conditions without a model call. The card's `Contract` line shows its SHA-256: one card, one approval.
- Authorization records can't be changed after creation. Missing, malformed, expired (24 hours), or consumed authorization blocks execution.
- Editing a work order after a run starts doesn't change the approved content. Run `start` again to create a new version and authorization card.
- `source_id` links to your existing issue tracker. It doesn't determine Bridge's work-order identity or execution rules. Use it in result files and `logs` to find the work order.

## Bridge runs the tests

After each writer round, Bridge runs the project type's test command **outside** the agent's sandbox. Tests must pass before review. Even if the writer reports that it cannot run tests, Bridge can still obtain the actual test result. Projects without a test command can also run; the card, records, and result explicitly state that no tests ran.

## Work proof

For Git projects, Bridge records the starting commit, reads the actual file changes from Git when work ends, and checks them against its records. “Files changed” separates Git changes, the writer's claims that haven't been checked against Git, and uncommitted changes that predate the run. Projects without Git explicitly have no work proof.

## Project files and runtime data

Bridge keeps project files separate from runtime records. Settings, work orders, and result copies live in `.review-bridge/`, whose own `.gitignore` contains `*`. Its contents stay out of Git. Bridge doesn't edit the project's `.gitignore`, `AGENTS.md`, `CLAUDE.md`, `.claude/`, or existing skills. Agent entry points are installed at the user level for all projects; runtime records live in OS data and log directories.

## Security model

- Missing, malformed, expired, or already-used authorization fails closed: work is refused.
- Writer and reviewer use independent sessions. The read-only checks are described above.
- Native model work requires your authorization of the card (at a terminal, or relayed by an agent using `--yes`) and a successful reviewer check held by the local page service. Preventing an agent from authorizing work on its own remains the agent tool's responsibility, through its permission prompts.
- Bridge does not commit, push, deploy, or publish.
- Bridge state must use a local filesystem. Synced and network folders are rejected.
