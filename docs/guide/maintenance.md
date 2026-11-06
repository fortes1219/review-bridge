# Upgrade, back up, and uninstall

## Upgrade

```sh
npm i -g review-bridge@next        # Upgrade the package
cd your-project
review-bridge upgrade              # Back up and upgrade this project's setup
```

`upgrade` stops the old service, backs up data, migrates it, checks integrity, removes old files, restarts the service, and checks its health. Bridge handles the sequence; you can rerun it after an interruption.

- Older layouts are migrated once: settings move to the top level of `.review-bridge/`; runtime state (`review-queue/`, `reviews/`, `archive/`) moves to `projects/<project_id>/` under data home; call logs, plans, and cards move to the log directory. File names are preserved and contents checked with SHA-256. Logs past retention are removed. Old result copies stored directly in `results/` stay where they are.
- Unrecognized files, such as OS temporary files or files you created, are left untouched and do not block an upgrade. If a migration destination contains a file with the same name but different content, migration is refused and the file is listed.
- Your role choices in `bridge.json` are preserved.
- Use `--rollback` to restore the previous upgrade's backup.
- Backups go to `backups/installer` under data home, or the location given by `--backup-root <folder>`.
- For scripts, `--plan-out <file>` writes a plan without interactive confirmation. `--plan <file> --approve <sha>` applies it; `<sha>` is the SHA-256 printed by `--plan-out`.

## Backup

See [Results, logs, and the database → Backup](./results#backup). `review-bridge backup` copies the database for all projects and is refused while work is running.

## Uninstall

```sh
review-bridge uninstall --target .   # Back up and remove the project's setup
npm uninstall -g review-bridge       # Remove the package
```

- `uninstall` removes only content created by Bridge: `.review-bridge/` (including result copies, which are backed up), and tasks starting with `review-bridge:` and inputs starting with `review-bridge-` in `.vscode/tasks.json`. That file is deleted only if nothing else remains.
- Agent entry points (`~/.claude/commands/review-bridge.md`, `~/.agents/skills/review-bridge/SKILL.md`) and user tasks are shared across projects. They are removed only when you uninstall the **last** configured project. Files you edited are preserved.
- `--plan-out`, `--plan`, `--approve`, `--backup-root`, and `--json` work as they do for `upgrade`.

## Platforms

Windows x64 has been verified natively. Apple Silicon macOS can be selected but has not been verified natively. Linux remains experimental; native model work fails closed by default.

### Windows

When Codex runs commands through Windows PowerShell, it loads your `$PROFILE`. If PowerShell uses a non-UTF-8 code page, such as the default on Chinese Windows, Codex may read the output as UTF-8 and display garbled text.

Run `notepad $PROFILE` in PowerShell and add the following setting. Create the file first if it does not exist:

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
```

You can also use PowerShell 7 (`pwsh`), which outputs UTF-8 by default. `review-bridge doctor` reports whether PowerShell is using UTF-8; it does not modify your profile.
