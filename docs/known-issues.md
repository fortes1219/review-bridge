---
description: Known issues in Review Bridge 0.3.0-rc.3 and 0.3.1-rc.3, what can interrupt a run, and how to stop and resume it.
---

# Known issues

## 0.3.0-rc.3 and 0.3.1-rc.3: interrupted runs can stay marked as running

`start` runs in the foreground of whatever launches it. If that process is killed mid-run, Bridge can still list the run as running even though the work has stopped.

The writer's edits stay on disk. Bridge doesn't automatically replay the work. You need to close the run with `stop <run_id>` before using `resume <run_id>` to run it again. **Until you stop the run, `down` refuses to shut down.**

### What can interrupt a run

- **An agent's command timeout.** Claude Code's Bash tool kills commands after two minutes by default, with a ten-minute maximum. Two writer rounds and a test step can take longer. Give the command a longer timeout or run it in the background, then wait for the result file. Codex's exec tool has its own time limit.
- **Closing the terminal or VS Code window running `start`.** Ctrl+C during a single-file `start` also exits the command, but the run may keep going.
- **Putting the machine to sleep, shutting it down, or a crash.** These can interrupt work before Bridge closes the run's record.
- **Installing a new version while a run is active.** `npx` replaces the cached program in place. Finish or stop active runs, then run `npx review-bridge down` before updating.

### Recover a run

Run these commands from the project folder. Use `status` to find the run ID, stop that run, then resume it:

```sh
npx review-bridge status
npx review-bridge stop <run_id>
npx review-bridge resume <run_id>
```

Replace `<run_id>` with the ID shown by `status`. `resume` creates a new run and shows an authorization card for you to approve; it doesn't automatically replay the interrupted run. See [Start a run](./guide/start) for details.

If you're updating first, stop the run, run `npx review-bridge down`, then update. Resume after the update. `down` won't close a run that's still marked as running for you.

### Coming in 0.3.2

**0.3.2 will add automatic detection of dead runs.** Neither 0.3.0-rc.3 nor 0.3.1-rc.3 has this feature; use the manual steps above for now.

For other limitations, see the [release notes](./release-notes).
