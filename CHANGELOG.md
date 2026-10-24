# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `review-bridge start <file>`: one command from a work order to its result. It plans the work, runs the reviewer read-only check once per page session, shows what the answer authorizes, asks `Start this work? [y/N]` and prints one line per step. `work-plan` and `work-start` stay for agents and scripts.
- `init` adds Claude Code's `/review-bridge` command (`.claude/commands/review-bridge.md`, only when there is none) and the same note in `AGENTS.md` (appended between markers). Rollback and `uninstall` remove both unless they were edited.
- Every command has `--help`, generated from the command table with each option's type, default and help line. `--help --all` also lists the commands and options for agents and tests. README's Commands section is generated from the same table, and CI fails when it is out of date.

### Fixed

- The reviewer read-only check on a Chinese Windows: PowerShell's denial arrives broken (Codex reads its CP950 output as UTF-8), so it was never recognized. The check now also recognizes PowerShell's `UnauthorizedAccessException`, the English `Access to the path '…' is denied.` and the Chinese 「存取被拒」「拒絕存取」. The probe's output is decoded as one UTF-8 stream.
- A project type chosen explicitly is set up even when the folder shows no sign of it; a mismatch stops code work at Gate A.

### Changed

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
