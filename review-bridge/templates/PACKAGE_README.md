# Codex Review Bridge Runtime 0.2.0-rc.2

This runtime is installed through the checksum-gated package installer. Do not copy runtime state between projects.

## Runtime boundary

- Windows x64 is native-verified.
- Apple Silicon macOS is a selectable canary candidate, not native-verified.
- Linux x64 is experimental and fail-closed.
- Fresh installations create no authorization, run, model session, or legacy `CONTROL.json`.
- Work packages, authorizations, claims, run projections, and event logs have separate lifecycles.
- Known OneDrive, Dropbox, iCloud Drive, UNC, NFS, CIFS, and SMB state locations are unsupported for concurrent controllers.

## Human entry point

Use the package-level `START_HERE.md`, then run `work-plan` and review its task, scope, budget, and breakpoint. `work-start` asks for a human confirmation and verifies the internal authorization token itself. Run fake scenarios before any native canary.

The runtime never authorizes commit, push, deploy, release, adapter promotion, or another work package. Those actions require a new human decision.

## Excluded

The package excludes active authorization, model session IDs, project queue/review artifacts, logs, locks, environment values, credentials, project handoffs, project contracts, and persistent rollback snapshots.
