# First Work Package

This document defines the human-facing lifecycle after installation. No user needs to edit `CONTROL.json` or discover a Claude session ID manually.

## Lifecycle

1. The human writes a task file under the ignored `.claude/` boundary.
2. `work-plan` records the task, owner, breakpoint, allowed change types, allowed paths, and correction budget.
3. The plan receives a SHA-256 over its canonical content and immutable effective-policy snapshot.
4. `work-start` requires that exact SHA-256, creates an immutable authorization, exclusively claims it for one run, and creates a new Claude UUID.
5. Claude runs in writer-only mode. The first call uses `--session-id`; a bounded correction uses `--resume` with the same UUID.
6. Codex runs independently with `exec --ephemeral --sandbox read-only` and reviews the job authorization snapshot.
7. PASS, hard stop, timeout, rate limit, malformed gate, cancellation, or exhausted budget terminates the run. Authorization, claim, events, and evidence remain immutable audit records.

## Allowed Change Types

`--change-types` accepts a comma-separated subset of:

```text
docs
code
tests
config
contract
schema
migration
external-behavior
```

Anything not explicitly selected remains a hard stop. Commit, push, deploy, release, adapter activation, and history rewrite always remain hard stops.

## Allowed Paths

`--allow-paths` accepts comma-separated repository-relative paths or patterns. Absolute paths, parent traversal, `.git`, environment files, and Bridge runtime state are rejected.

Examples:

```text
README.md,docs/**
src/**,tests/**
frontend/src/**,frontend/tests/**
```

The writer receives this scope in its controller prefix. The Codex job metadata contains the same authorization snapshot and must treat any mismatch as scope expansion.

## Plan

```powershell
node .claude/tools/review-bridge/bootstrap.mjs work-plan `
  --task-file .claude/work-packages/trial-001.md `
  --owner "Human Owner" `
  --work-package trial-001 `
  --breakpoint "return after Codex review" `
  --change-types docs `
  --allow-paths "README.md" `
  --max-claude-calls 2 `
  --max-claude-minutes 8 `
  --out .claude/review-queue/trial-001.plan.json
```

`work-plan` is model-free and creates no authorization or active run.

## Start

Run the public fake mode first. It never resolves or invokes Claude/Codex CLI:

```powershell
node .claude/tools/review-bridge/bootstrap.mjs work-start `
  --plan .claude/review-queue/trial-001.plan.json `
  --approve <plan_sha256> `
  --fake-cli `
  --fake-scenario PASS
```

Supported fake scenarios are `PASS`, `FAIL_THEN_PASS`, `HARD_STOP`, and `RATE_LIMIT`. The result records `execution_mode: fake_cli`. A fake run consumes its authorization and cannot be reused for native execution.

On a natively verified platform, create a new plan and omit the fake flags:

```powershell
node .claude/tools/review-bridge/bootstrap.mjs work-start `
  --plan .claude/review-queue/trial-001.plan.json `
  --approve <plan_sha256>
```

The command is synchronous. Keep the terminal open until it prints the final work status. It automatically performs the writer, review, and at most the approved number of correction calls.

On Apple Silicon macOS, complete all fake scenarios first. Native `work-start` is a candidate canary path and must be reported as unverified until real APFS and CLI evidence passes. Linux remains experimental and fail-closed.

## Status And Cancellation

```powershell
node .claude/tools/review-bridge/bootstrap.mjs work-status
node .claude/tools/review-bridge/bootstrap.mjs work-cancel --reason "cancelled_by_human_owner"
```

If a foreground `work-start` process must be interrupted, first send `Ctrl+C` to that terminal and then run `work-cancel`. Cancellation consumes authorization but does not promise remote process termination by itself.

## Security Properties

- A report without one active run and matching immutable authorization claim cannot enqueue a review.
- A report from a different Claude session is rejected.
- A plan becomes stale when its effective-policy snapshot changes.
- A consumed plan cannot be replayed.
- Task text, plan, CONTROL, queue, and review artifacts remain under ignored `.claude/`.
- A work package never authorizes commit, push, deploy, release, or a subsequent work package.
