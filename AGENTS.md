# Review Bridge Guardrails

## Repository Purpose

This private repository is the canonical source for the generic review bridge runtime and installer. It must not contain project-specific domain policy, real CONTROL state, model session IDs, credentials, queue artifacts, review reports, logs, or deployment details.

## Hard Boundaries

- Do not commit, push, publish, release, or activate an adapter without explicit human-owner authorization.
- Installer tests and smoke tests must not invoke Claude or Codex models.
- Keep writer and reviewer as separately configured roles with independent sessions; do not move independent review into writer self-review. The Stage 2 role-first onboarding contract supersedes the rc.2 fixed Claude-writer/Codex-reviewer pairing.
- Never distribute a legacy `CONTROL.json`, active authorization, claim, run, or model session identity.
- Preserve fail-closed gates, consumed authorization, writer-only limits, exact machine-readable review gates, and human breakpoints.
- Do not add project-domain rules to the organization baseline or framework profiles.
- Do not weaken Windows safety or claim Darwin/Linux native support without native evidence and human approval.
- Installer changes require install, reinstall/upgrade, verify, uninstall, stale-plan, rollback, settings-merge, and private-boundary evidence.
- Structural code claims require `sg`; symbol references require the language server. Text search is evidence only for text/configuration claims.
- Locate before reading: start from the Codemap in `ARCHITECTURE.md`, list a file's declarations with `rg`, take one function with `sg`, and read a whole file only when the change needs it. These locate code; they do not prove that nothing else calls it.

## Repository Layout

- `review-bridge/`: sanitized runtime distributed into target repositories.
- `installer/`: checksum-gated transaction controller.
- `profiles/`: project capability profiles, never product policy.
- `project-templates/`: generic installed policy files.
- `tests/`: installer lifecycle tests.
- `docs/`: architecture and installer contract.
- `ARCHITECTURE.md`: how the runtime and installer are layered today, and what is not finished.

## Public And Private Data

Treat a future package archive as shareable only after scanning it. Never package runtime CONTROL values, session metadata, `.env` files, credentials, target repository paths, queue/review artifacts, or handoffs.
