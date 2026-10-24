# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Review Bridge is distributed on npm: `npx review-bridge init` or `npm i -g review-bridge`. Upgrading and removing Bridge are `npm i -g review-bridge@latest` and `npm uninstall -g review-bridge`.
- `review-bridge init` follows create-vite: it asks the writer, the reviewer and the project type, each with a default, then sets up the current folder one step per line and ends with the next commands. Nothing is confirmed and no plan is printed; options answer the questions, and without a terminal the defaults are used.
- The project type can be `none`; a folder with no detected type is set up as `none` instead of being refused.
- `review-bridge work-plan <file>` takes the work-order file directly; the work package name, the plan path and the owner have defaults.
- `--version` prints the version; `--help` describes the npm command.

### Removed

- The release ZIP, `SHA256SUMS.txt` and the integrity check before every command; npm verifies the package.
- Installing from a clone with `npm start`, registering the command with `npm link`, and upgrading Bridge in place.
- `uninstall` without `--target`; use `npm uninstall -g review-bridge`.
