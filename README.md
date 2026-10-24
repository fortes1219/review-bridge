# Codex Review Bridge Installer

## Stage 2 development status

The current development branch supports role selection and a provider-neutral private install:

```text
node bridge.mjs roles-check --writer codex --reviewer claude
node bridge.mjs init --target <workspace> --writer codex --reviewer claude
```

`init` checks the selected CLIs and sign-in state without calling a model. If a CLI is missing, signed out, or its sign-in state is unknown, `init` shows the missing step and reports the roles as not ready; setup still completes with fake self-tests only, which need no CLI or login. It installs under `.review-bridge/`, leaving existing `.claude/` and `.codex/` alone. Four fake scenarios run in a disposable copy. Reviewer write denial and independent sessions have not been proved, so native readiness remains false. Every native model entrypoint rejects until the Stage 2 UV authorization issuer is implemented. The rc.2 work commands below are historical and cannot start native work in this branch. Neutral upgrade and uninstall are still in development.

After `init`, open the local setup page:

```text
node .review-bridge/tools/review-bridge/bootstrap.mjs watch
```

The page binds to `127.0.0.1` only and shows the selected writer and reviewer with their CLI and sign-in status. Opening or refreshing it uses no model. The button "將使用一次模型呼叫確認 reviewer 無法寫入" runs one reviewer call in a disposable folder under the provider's read-only sandbox and asks it to write a unique file. It passes only when the reviewer really tried to write, the sandbox denied it, and no file appeared. It also requires a successful CLI exit, a completed run, and exactly one recognisable fixed write command; a refusal, error, nonzero exit, timeout, rate limit, ambiguous output, or unsupported reviewer stays unproven. The result is held only in the running `watch` process memory and becomes stale when the roles, CLI identity or version, platform adapter source or configuration, probe code, or sandbox arguments change; restarting `watch` returns it to not tested. The JSON audit file it writes is never read back as proof, and `doctor`, as a separate process, always reports `not_run` (`watch_session_only`). Only the Codex reviewer can currently produce this proof, so the button is disabled for other reviewers. The page token blocks foreign webpages but does not prove a human clicked. Native work still cannot start.

Private preview for installing the Claude-to-Codex review bridge into one project workspace at a time. Git is supported but optional.

Human users should begin with `START_HERE.md`. It starts at the moment a user receives the release ZIP, extracts it outside the target project, performs human-approved initialization, and then defines the first complete Claude writer / Codex reviewer work package without manual CONTROL or session-ID editing.

Supported profiles are loaded from the declarative `profiles/*.json` registry. The preview includes Rust, Vue/TypeScript, Node.js backend, Go, Python, Java, PHP Laravel, and .NET/C#.

## Positioning

Codex Review Bridge is a repository-local delivery review controller. It externalizes writer/reviewer separation, work-package authorization, review gates, correction budgets, durable evidence, and human breakpoints from agent context.

It is not a general agent framework, a session synchronization protocol, or an agent-computer platform. Session synchronization, agent-computer execution, and delivery review operate on different responsibility planes; this project does not use feature-count comparisons to claim superiority.

## Safety Model

- `plan` is read-only and never invokes a model.
- Integrity and authorization tokens are checked by the controller. Human-facing commands show the target, scope, budget, breakpoint, and effects instead of asking users to copy hashes.
- Git is not required to work, but the work proof needs it. With Git, Bridge records the commit and branch a run starts from and reads the changes since then from Git at each hand-off, without copying files and without committing, staging, stashing or switching anything. Without Git, work still runs, but the result says there is no work proof: Bridge cannot list what changed and does not check the scope.
- In a Git repository, the installer adds `.review-bridge/` to the local `.git/info/exclude` when it is not already ignored. It never edits tracked `.gitignore`.
- Existing Claude permissions, unrelated hooks, rules, skills, docs, and handoffs are preserved.
- Existing project-specific review prompts are preserved at `.review-bridge/review-bridge/review-prompt.md` and override the packaged generic prompt.
- Fresh installs create no `CONTROL.json`. Immutable work packages and authorizations create run state only after checksum approval.
- Failed transactions immediately restore the pre-operation managed paths.
- Successful operations retain a checksum-verified rollback point outside the target repository.
- Windows x64 is native-verified. Apple Silicon macOS is a selectable RC canary adapter but is not native-verified; Linux remains experimental and fail-closed.

## Install

### Start From A Release ZIP

Do not ask an agent to install the Bridge. In File Explorer or Finder, extract the ZIP into any local directory outside the target project. Open a terminal in that extracted directory. Do not copy the ZIP or installer source into the target project.

Git, Node.js 22 or newer, and npm must already be installed; Bridge does not install them. Run `node --version` and require Node.js 22 or newer before continuing. After switching Node versions (for example with nvm), run `npm start` in the Bridge folder again: the `review-bridge` command belongs to one Node installation and is registered again for the new one. `init` automatically verifies the extracted package before it reads the target or installs anything. A missing, modified, or damaged packaged file produces one fail-closed error and no installation; users do not compare integrity values manually.

### Human-Approved Initialization

The normal entry point installs the Bridge and runs `PASS`, `FAIL_THEN_PASS`, `HARD_STOP`, and `RATE_LIMIT` with fake CLIs, so it consumes no model tokens:

```powershell
node bridge.mjs init --target D:\projects\my-project
```

The confirmation screen shows the target workspace, operation, detected profile, workspace evidence mode, and planned changes. Enter `y` only after those values are correct. Entering `n` or pressing Enter cancels without installing the Bridge.

Use `--yes` only for CI or disposable automated verification. The command detects the project profile, applies the checksum-gated installer internally, verifies the fake runtime, and reports whether the native Claude and Codex CLIs are available. It does not modify application files or require a Git repository.

After `init` succeeds, stop. Installation is complete, but no real Claude or Codex work has started. Real model use begins only after a human creates and confirms a work package.

## Release Packaging

Maintainers must create release archives through the cross-platform Node packager. It writes every ZIP entry with the specification-defined `/` separator, then parses the finished archive and fails closed on backslashes, absolute paths, traversal segments, case-colliding entries, or a missing required tree. The PowerShell file is only a thin compatibility wrapper around the same Node implementation.

Do not use Windows PowerShell 5.1 `Compress-Archive` for a release. Its backslash entry names can appear usable on Windows or tolerant extractors while breaking macOS Finder extraction. A release archive is not deliverable until `verify-release-archive.mjs` accepts the actual ZIP.

```text
npm run package:release
```

The external checksum sidecar is optional supply-chain evidence for advanced consumers. It is not part of the normal human installation flow; `init` verifies extracted package integrity automatically.

Controller state must be on a local filesystem with atomic file operations. Known synchronized and network-mounted locations fail preflight. Exclusive-create concurrency is not supported on OneDrive, Dropbox, iCloud Drive, UNC, NFS, CIFS, or SMB state paths. This RC has real local NTFS evidence; APFS and ext4 support must not be claimed until equivalent native evidence exists.

On non-Windows systems, `npm run test:state-contract` is expected to report 19 passing suites and one skipped suite. AC-16 is the real local NTFS-only exercise; its skip is intentional outside Windows. AC-15 still verifies POSIX synchronized/network path rejection on every platform.

The lower-level plan/apply interface remains an internal maintainer API for controlled upgrades and automation. Normal users should use `bridge.mjs init`; maintainer details are isolated in `docs/installer-contract.md`.

## Start The First Work Package

After installation, copy `.review-bridge/work-packages/TEMPLATE.md` to a new work-order file and describe the work and its acceptance results in your own words, in any language. Files or modules you mention there are context for the writer, not permission: the files Bridge may change come only from `--allow-paths` or, without it, the whole project minus the fixed forbidden list. Then create a controller-validated authorization plan:

```powershell
node .review-bridge/tools/review-bridge/bootstrap.mjs work-plan `
  --task-file .review-bridge/work-packages/trial-001.md `
  --owner "YOUR_NAME" `
  --work-package trial-001 `
  --breakpoint "return after Codex review" `
  --change-types docs `
  --allow-paths "README.md" `
  --max-claude-calls 2 `
  --max-claude-minutes 8 `
  --out .review-bridge/review-queue/trial-001.plan.json
```

Review the scope, budget, and breakpoint printed by `work-plan`, and the model calls made before the work: the writer translates the work order into a contract and the reviewer checks it, up to two times each. `work-start` then displays the complete task and those limits, asks for confirmation, and validates the internal authorization token itself. Starting authorizes the work order as it is then; there is no second approval of the translation. If the reviewer finds the work order itself unclear, or cannot confirm the translation, no work starts and the result file says why.

Run the first plan in no-token fake mode:

```powershell
node .review-bridge/tools/review-bridge/bootstrap.mjs work-start `
  --plan .review-bridge/review-queue/trial-001.plan.json `
  --fake-cli `
  --fake-scenario PASS
```

Fake scenarios include `PASS`, `FAIL_THEN_PASS`, `HARD_STOP`, and `RATE_LIMIT`. A fake run consumes that plan. Generate a new plan before native execution.

On Windows x64, start the new plan without fake flags:

```powershell
node .review-bridge/tools/review-bridge/bootstrap.mjs work-start `
  --plan .review-bridge/review-queue/trial-001.plan.json
```

`work-start` creates the Claude session, runs the writer, runs ephemeral read-only Codex review, performs only budgeted named corrections, and stops at PASS or a human hard stop. It never commits, pushes, deploys, or starts another work package.

On Apple Silicon macOS, the adapter is selectable for an explicit RC canary after all fake scenarios pass. `init` reports `adapter_status: candidate` and `runtime_verified: false`; that is a disclosure, not a support claim. The canary result is evidence required before promoting macOS to native-verified.

```powershell
node .review-bridge/tools/review-bridge/bootstrap.mjs work-status
node .review-bridge/tools/review-bridge/bootstrap.mjs work-cancel --reason "cancelled_by_human_owner"
```

See `docs/first-work-package.md` for scope categories, status meanings, cancellation, and fail-closed behavior.

`auto` selects a profile only when exactly one profile matches. Mixed-stack or ambiguous repositories fail closed and list the explicit profile IDs to choose from. Planning an adoption of an existing unmanaged bridge requires `--adopt-existing`.

Available profile IDs:

```text
rust-backend
vue-frontend
node-backend
go-backend
python-backend
java-backend
php-laravel
dotnet-backend
```

Detection identifies tooling evidence and candidate verification commands. It does not approve commands, infer domain policy, or generate application code.

When `--adopt-existing` finds a customized runtime `review-prompt.md`, the approved plan records its hash and migrates it to the project-owned override path before replacing the shared runtime. A conflicting pre-existing override fails closed.

## Upgrade, Uninstall, And Rollback

Upgrade, uninstall, and upgrade rollback use the same sealed-plan approval as installation: `node bridge.mjs upgrade`, `node bridge.mjs uninstall`, and `node bridge.mjs upgrade --rollback`, each confirmed at an interactive terminal or through `--plan-out` then `--plan <file> --approve <sha>`. They are maintainer operations, not normal onboarding steps; see `docs/installer-contract.md`.

An upgrade stages the complete runtime before activation and holds an upgrade marker while it verifies the new runtime and records invalidated unclaimed authorizations. An interrupted operation exposes either the previous runtime or an explicit incomplete-upgrade state, never a partially copied runtime. Resolve an incomplete upgrade through a controller-validated rollback before starting new work.

`uninstall` backs `.review-bridge/` up outside the project and verifies the copy before deleting it. `upgrade --rollback` restores an interrupted upgrade from its maintenance marker and backup.

The default persistent backup root is `%LOCALAPPDATA%\CodexReviewBridge\backups` on Windows. Use `--backup-root <external-path>` during planning to select another location. The backup root must be outside the target repository.

Backups may contain private queue, review, and run data. Do not publish, commit, or include the backup root in a distribution archive. Automatic retention/pruning is not part of this preview.

No remote repository, npm publication, commit, push, or deploy is performed by this preview. `init` invokes no model; native `work-start` does.

## Verification Evidence

On 2026-08-28, the rc.2 source passed 33/33 installer, profile, product-init, workspace-evidence, rollback, package-integrity, human-approval, and disposable-workspace tests on Windows. The no-Git Vue workspace completed `PASS`, `FAIL_THEN_PASS`, `HARD_STOP`, and `RATE_LIMIT` through the public fake-CLI workflow without leaving self-test artifacts in the installed project. `npm run test:runtime` passed 33/33 tests. `npm run test:state-contract:evidence` passed all 20 acceptance suites, including AC-20 same-plan replay rejection and real local NTFS claim, stale-lock, stale-guard, migration, rollback, upgrade, and concurrency evidence. This does not constitute native APFS, ext4, macOS CLI, or Linux CLI verification.

Maintainers can separately verify the installed Claude Code session contract. This opt-in smoke makes exactly two small live Claude calls: the first uses `--session-id <uuid>` and the second uses `--resume <same uuid>`. It runs in Claude safe mode, disables tools, uses a temporary working directory, and sets a US$0.25 maximum per call. It is intentionally excluded from `npm test`.

```powershell
npm run smoke:claude-session-live -- --confirm-live-model-calls
```

The live smoke passed on Claude Code 2.1.218 on 2026-08-27. It verified that the first `--session-id` call and the following `--resume` call returned the same UUID and that the resumed call recovered a nonce supplied only in the first turn.
