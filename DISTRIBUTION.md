# Codex Review Bridge Installer 0.2.0-rc.2

Package date: 2026-08-28  
Bundled review bridge runtime: 0.2.0-rc.2  
Distribution status: private release candidate

## What This Package Is

This is a source distribution of a workspace-local Claude writer / Codex reviewer control plane. It installs one independent Bridge runtime into one project workspace. Git is optional.

It is assembled from the generic installer source rather than copied from a target project's `.claude` directory. It contains no active work-package authorization, real model session, review queue, review report, prompt artifact, log, lock, project handoff, project contract, environment file, credential, rollback snapshot, Git history, or machine-specific path.

## Platform Status

- Windows x64: active and native-verified.
- Apple Silicon macOS: selectable canary candidate; contract and fake-CLI coverage, not native-verified.
- Linux x64: experimental; not native-verified.

Experimental adapters fail closed during normal bootstrap. The Darwin candidate is selectable only to collect missing native evidence; candidate status is not a support claim.

## Included Profiles

- Rust backend
- Vue / TypeScript frontend
- Node.js backend
- Go backend
- Python backend
- Java backend
- PHP Laravel
- .NET / C# backend

Profiles detect project capabilities and candidate verification commands. They do not infer domain, architecture, permission, authentication, database, or security policy.

## Verify The Package Source

Requirements: Node.js 22 or newer. Git is optional. Native work requires Claude Code CLI and Codex CLI; fake initialization invokes neither model.

```powershell
npm test
npm run test:runtime
npm run test:state-v4:evidence
npm run smoke:windows
```

`smoke:windows` calls only `claude --version` and `codex --version`.

The separate live session-contract smoke is opt-in and makes exactly two small Claude calls. It is not part of `npm test`:

```powershell
npm run smoke:claude-session-live -- --confirm-live-model-calls
```

## Install Into A Workspace

Normal installation and the four no-token gate checks use one command:

```powershell
node bridge.mjs init --target D:\path\to\target-workspace
```

`init` installs under `.review-bridge/`. In a Git repository it adds `.review-bridge/` to the local `.git/info/exclude` and never edits tracked `.gitignore`. A workspace without Git uses controller-owned snapshot/delta evidence instead.

Upgrade and uninstall seal a read-only plan whose exact SHA-256 the human approves, at an interactive terminal or non-interactively:

```powershell
node bridge.mjs upgrade --target D:\path\to\target-workspace --plan-out D:\temp\upgrade-plan.json
node bridge.mjs upgrade --target D:\path\to\target-workspace --plan D:\temp\upgrade-plan.json --approve <plan_sha256>

node bridge.mjs uninstall --target D:\path\to\target-workspace --plan-out D:\temp\uninstall-plan.json
node bridge.mjs uninstall --target D:\path\to\target-workspace --plan D:\temp\uninstall-plan.json --approve <plan_sha256>
```

Automatic profile selection succeeds only when exactly one profile matches. Mixed or ambiguous repositories require an explicit profile ID.

Fresh installation creates no CONTROL or model session and does not start a Claude or Codex task. `START_HERE.md` and the checksum-gated `work-plan` / `work-start` commands define and run the first bounded work package without manual state or session-ID editing.

## Release Archive Gate

Create the ZIP only with `npm run package:release`. The cross-platform Node packager writes `/` entry separators and verifies the actual central directory before publishing the archive. Windows PowerShell 5.1 `Compress-Archive` is not an accepted release path because its backslash entries can break macOS Finder extraction. Any backslash, absolute path, traversal segment, case collision, or missing required nested file fails the release.

## Recovery Boundary

Before mutation, the installer creates a checksum-verified snapshot outside the target repository. Failed apply operations roll back immediately. Successful operations retain an external rollback point.

Rollback snapshots may contain private target-repository state. Never place the backup root in Git or a distribution archive.

See `README.md`, `docs/installer-contract.md`, and `docs/architecture.mmd` for the complete operating model.
