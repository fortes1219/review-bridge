# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- An agent can run the work for you: without a terminal, `start` and `resume` print the card and stop with `Needs authorization`; after you say yes the agent runs the same command with `--yes`. The authorization records `authorized_via` (`terminal` or `agent`) and the SHA-256 of the sealed work-order text. `--yes` is refused when no card was shown for the work order, or when the work order changed after the card; nothing is started or authorized.
- `resume <run_id>` carries a stopped work order on as a new run with that run's settings; `clean [<run_id>]` clears records (same as `prune`, or `rm` with a run id).
- `/review-bridge` and the `AGENTS.md` section teach agents the four actions (start, stop, resume, clean) and that only the person says yes.
- `review-bridge start <file>`: one command from a work order to its result. It plans the work, runs the reviewer read-only check once per page session, shows what the answer authorizes, asks `Start this work? [y/N]` and prints one line per step. `work-plan` and `work-start` stay for agents and scripts.
- `init` adds Claude Code's `/review-bridge` command (`.claude/commands/review-bridge.md`, only when there is none) and the same note in `AGENTS.md` (appended between markers). Rollback and `uninstall` remove both unless they were edited.
- Every command has `--help`, generated from the command table with each option's type, default and help line. `--help --all` also lists the commands and options for agents and tests. README's Commands section is generated from the same table, and CI fails when it is out of date.

### Fixed

- The reviewer read-only check on a Chinese Windows: PowerShell's denial arrives broken (Codex reads its CP950 output as UTF-8), so it was never recognized. The check now also recognizes PowerShell's `UnauthorizedAccessException`, the English `Access to the path '…' is denied.` and the Chinese 「存取被拒」「拒絕存取」. The probe's output is decoded as one UTF-8 stream.
- A project type chosen explicitly is set up even when the folder shows no sign of it; a mismatch stops code work at Gate A.

### Changed

- Native work no longer requires an interactive terminal (T0-08's terminal rule is withdrawn); the reviewer read-only proof is still required before any model call.
- `status` shows what Bridge is doing now: the page, the runs and the review queue (`--json` for all of it).
- `start` without a terminal takes the default breakpoint and change types instead of refusing.
- `init` ends with `review-bridge start …` and the page address.
- `work-plan` prints two lines (the plan and the next command); `--json` prints the JSON.
- Refusals end with the command to run next.
- Review Bridge is distributed on npm: `npx review-bridge init` or `npm i -g review-bridge`. Upgrading and removing Bridge are `npm i -g review-bridge@latest` and `npm uninstall -g review-bridge`.
- `review-bridge init` follows create-vite: it asks the writer, the reviewer and the project type, each with a default, then sets up the current folder one step per line and ends with the next commands. Nothing is confirmed and no plan is printed; options answer the questions, and without a terminal the defaults are used.
- The project type can be `none`; a folder with no detected type is set up as `none` instead of being refused.
- `review-bridge work-plan <file>` takes the work-order file directly; the work package name, the plan path and the owner have defaults.
- `--version` prints the version; `--help` describes the npm command.

### Removed

- The release ZIP, `SHA256SUMS.txt` and the integrity check before every command; npm verifies the package.
- Installing from a clone with `npm start`, registering the command with `npm link`, and upgrading Bridge in place.
- `uninstall` without `--target`; use `npm uninstall -g review-bridge`.
