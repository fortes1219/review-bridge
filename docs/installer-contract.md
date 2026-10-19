# Installer Contract

Status: APPROVED / RECORDED  
Approved: 2026-08-11

Stage 2 development: role-first onboarding replaces the fixed Claude-writer/Codex-reviewer pairing. The initial reviewer write-denial probe is one human-triggered model call during first setup. Installer automation, fake scenarios, and smoke tests remain model-free. Stage 2 native execution must be blocked until that probe proves reviewer read-only capability. Fresh `init` now installs under `.review-bridge/` and leaves `.claude/` and `.codex/` unchanged; a Git target gets a local `info/exclude` entry when needed. Neutral uninstall is implemented (T0-09, 2026-10-14): `node bridge.mjs uninstall` seals a read-only plan whose exact SHA-256 the human approves (interactive terminal, or `--plan-out` then `--plan <file> --approve <sha>`; there is no `--yes`), writes the maintenance marker before checking for running work, records a journal and an index outside the project before stopping the page service, copies `.review-bridge/` to a platform backup root outside the project and verifies both the copy and the originals before deleting, moves the runtime aside first and deletes the marker last, restores only the Git exclusion block it added, and can cancel, continue or finish an interrupted uninstall under a new approved plan. Backup roots: Windows `%LOCALAPPDATA%\CodexReviewBridge\backups`, macOS `~/Library/Application Support/CodexReviewBridge/backups`, Linux `${XDG_DATA_HOME:-~/.local/share}/CodexReviewBridge/backups`. Verified on Windows only; the macOS (Apple Silicon/APFS) lifecycle is not verified and `darwin-arm64` stays a candidate. Neutral upgrade is implemented (T0-10, 2026-10-15): `node bridge.mjs upgrade` seals a read-only plan the same way (no `--yes`), refuses an install that does not verify, writes the maintenance marker before checking for running work, stops the page service, backs `.review-bridge/` up to the same backup root and verifies it, copies the new runtime beside the old one and swaps the two directories under `tools/`, keeps owner-editable settings (watch, retention, locale, gate_a, rules.md, an edited TEMPLATE.md) and all user data, adds new bridge.json keys, invalidates unclaimed authorizations when the default policy identity changes, and rolls back automatically on any failure. The marker records every file version the upgrade is about to write, so `upgrade --rollback` rebuilds an approved plan from the marker, the backup and `tools/` alone and leaves files changed by a human during the upgrade untouched. The restarted page service starts with the reviewer read-only check at not_run. Verified on Windows only. The rc.2 installer (`installer/install.mjs`, its `.claude/` layout and its Stop hook) was removed on 2026-10-16; the behavior below is kept as history only.

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
- Upgrade activation follows `docs/state-contract.md` D5: stage a complete runtime, hold an upgrade marker, switch directories without exposing partial contents, report invalidated authorization IDs, and fail closed after interruption.
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
