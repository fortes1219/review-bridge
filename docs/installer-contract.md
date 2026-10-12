# Installer Contract

Status: APPROVED / RECORDED  
Approved: 2026-08-11

Stage 2 development: role-first onboarding replaces the fixed Claude-writer/Codex-reviewer pairing. The initial reviewer write-denial probe is one human-triggered model call during first setup. Installer automation, fake scenarios, and smoke tests remain model-free. Stage 2 native execution must be blocked until that probe proves reviewer read-only capability. Fresh `init` now installs under `.review-bridge/` and leaves `.claude/` and `.codex/` unchanged; a Git target gets a local `info/exclude` entry when needed. Neutral upgrade and uninstall are not implemented; the rc.2 installer behavior below is historical for the new layout.

## Approved Product Shape

- Canonical source lives in a separate private Git repository.
- One workspace is one installation unit with independent immutable work packages, authorizations, run projections, and event logs. Git is optional.
- Apply, upgrade, uninstall, and rollback require the exact SHA-256 of a read-only plan.
- Distribution starts with private Git and versioned ZIP. npm publication is deferred until lifecycle tests and approved canaries pass.

## Required Behavior

- Load project profiles from a declarative registry rather than a language allowlist in installer code.
- Include Rust, Vue/TypeScript, Node.js backend, Go, Python, Java, PHP Laravel, and .NET/C# profiles without importing project-domain policy.
- Allow automatic selection only for one unambiguous match; mixed-stack or ambiguous repositories require an explicit profile selection.
- Preserve existing permissions, unrelated hooks, rules, skills, docs, handoffs, and runtime state.
- Keep the packaged generic review prompt installer-owned and support a project-owned override at `.claude/review-bridge/review-prompt.md`.
- During explicit adoption, preserve a customized existing runtime prompt as the project-owned override; fail closed if two conflicting project prompt candidates exist.
- Never modify tracked `.gitignore`; stop if `.claude/` is not already ignored.
- Merge JSON structurally and own exactly one review-bridge Stop hook.
- Fresh install creates no CONTROL, authorization, claim, run, or copied session identity.
- Upgrade activation follows `docs/state-contract-v4.md` D5: stage a complete runtime, hold an upgrade marker, switch directories without exposing partial contents, report invalidated authorization IDs, and fail closed after interruption.
- Use ownership hashes, a transaction lock, a short-lived transaction backup, post-apply verification, and persistent rollback points.
- Keep persistent snapshots outside the target repository. On Windows the default root is `%LOCALAPPDATA%\CodexReviewBridge\backups`.
- Snapshot the managed runtime, project rule, Claude settings, queue, reviews, and ownership manifest before mutation.
- Verify snapshot identity, manifest checksum, path coverage, and data hashes before removing target paths.
- Keep uninstall and rollback distinct: uninstall preserves later project/runtime changes, while rollback restores the exact selected pre-operation state.
- Reject missing, corrupt, mismatched, or symlinked rollback data without changing the installed target.
- Fail closed for malformed settings, stale plans, changed targets, conflicting ownership, untrusted runtime resolution, and failed validation.
- Windows is active only with native evidence. A candidate adapter may be selectable for an explicit canary while remaining visibly unverified; promotion to native-verified requires native filesystem and CLI evidence plus human approval.

## Non-Scope

- Model invocation during installation or tests.
- Domain, auth, schema, or application-code generation.
- Multi-repository shared runtime state.
- Automatic persistent-backup retention or pruning.
- Publishing or packaging persistent snapshots, which may contain private operational data.
- Commit, push, remote creation, publication, deploy, or adapter activation without separate authorization.
