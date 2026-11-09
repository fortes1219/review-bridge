# Fail-open ledger

Every time a guard let through what it should have stopped, or a test passed while the behaviour was
wrong, it is kept here: what was seen, how to make it happen again, why, the fix, the test that now
catches it, and the mutation case that proves that test can fail
(`node scripts/verify-gate-mutations.mjs --only <id>`). The entries are engineering records, not a
claim that nothing else is wrong.

## RB-GATE-2026-001 — `.review-bridge/` shows in Git when the project gets Git after init

- **affected_gate:** Install
- **symptom:** a project set up before `git init` lists `.review-bridge/` (settings, templates, later
  work orders and results) as untracked files; `git add .` commits them.
- **expected_vs_actual:** expected `git status` to show nothing of Bridge's at any time; actually it
  showed five files under `.review-bridge/` after `git init`.
- **reproduction:** Windows 11, Node 24.16, npm 11.13, Git 2.42: `npm create vite@latest app -- --template
  vue-ts`, `cd app`, `npm install`, `npx review-bridge init`, `git init`, `git status`. create-vite makes
  no repository, so this is the order a new Vite project is set up in.
- **root_cause:** init kept the folder out of Git only by a line in `.git/info/exclude`, written only when
  a repository was already there; nothing wrote it later.
- **fix:** `c2c9fe5` — the folder carries its own `.gitignore` with `*`, written first, as pytest's
  `.pytest_cache/`, ruff's `.ruff_cache/` and uv's `.venv/` do. No file of the person's is touched.
- **regression_test:** `tests/neutral-install.test.mjs` "a project set up without Git keeps .review-bridge/
  out of Git once the person runs git init"; "reinit: .review-bridge/ without its install record …".
- **mutation_case:** `RB-M-install-no-gitignore`, `RB-M-reinit-no-gitignore` (killed).
- **residual_risk:** none known for a fresh install.

## RB-GATE-2026-002 — every printed next command assumed a global install

- **affected_gate:** Install
- **symptom:** after `npx review-bridge init`, the "Now:" lines, `status`, every refusal's "Run: …", the
  two agent entries and the VS Code tasks all named `review-bridge …`, a command a person who used only
  npx does not have.
- **expected_vs_actual:** expected each printed line to run as typed; actually `review-bridge` was not
  found. It never showed on the machine that found it, because that machine had `npm link`ed the source.
- **reproduction:** a machine with no global `review-bridge`: `npx review-bridge init` in a new project,
  then type the line it prints after "at a terminal".
- **root_cause:** the lines were written as a global binary's name. create-vite and create-playwright
  print the package manager's own form instead.
- **fix:** the commit that adds this entry — one function (`review-bridge/utils/bridgeCommand.mjs`) prints
  the package manager's one-off form with no version, as create-vite reads `npm_config_user_agent`:
  `npx review-bridge` for npm and when none is named (a global install answers it too: libnpmexec runs the
  global bin first), `pnpm dlx`, `yarn dlx` (not Yarn 1), `bun x`. `npx`, not `npm exec`: `npm exec` would
  take `--yes` as its own flag. The language packs read it as `{bridge}`. Releases publish as `latest`, so
  a command with no version runs the release.
- **regression_test:** `review-bridge/tests/bridge-command.test.mjs` (the function, and "no shipped line
  tells the person to run a bare review-bridge command …", which reads every file npm ships); the agent
  entry assertions in `tests/neutral-install.test.mjs`; `tests/vscode-tasks.test.mjs` "six shell tasks …";
  `review-bridge/tests/i18n.test.mjs` "ps and down say the page's state …".
- **mutation_case:** `RB-M-command-bare-name`, `RB-M-command-ignores-pnpm`, `RB-M-entry-keeps-placeholder`,
  `RB-M-vscode-bare-name`, `RB-M-language-ignores-runner` catch a wrong function; `RB-M-command-line-left-bare`
  catches one line left as it was (all killed). The scan leaves out `--help` and `README.md`; README is
  rewritten with the release.
- **residual_risk:** `--yes` after the package name must reach Bridge. Through npx it does: the card's
  run-again line, typed as printed, started the run (Windows, fake CLI). `pnpm dlx`, `yarn dlx`, `bun x` and
  `deno run -A npm:` pass the flags after the name on by their source; none was run (not installed where
  this was checked). The path with no link and no global install can only run once the release is on
  the registry. `npx review-bridge` asks the registry for the latest version on every command. The page
  service and PostgreSQL started through npx run from npm's cache folder, which the next release replaces
  in place (separate work).

## RB-GATE-2026-003 — the second of two yeses to one card read a half-written plan file

- **affected_gate:** Authorization
- **symptom:** two `start <file> --yes` at once: one run started (the guard held), but the other printed
  `Review bridge failed closed: Unexpected end of JSON input` instead of saying the card was already used.
- **expected_vs_actual:** expected the second to be refused in words; actually a JSON parse error.
- **reproduction:** `tests/product-init.test.mjs` "two --yes to one card at once start one run …"; red
  once in a full Linux run at `fc16a12`, green when run alone five times (timing).
- **root_cause:** both starts wrote the same plan file by truncate-then-write and read it back before the
  database claim decided between them.
- **fix:** `22c7017` — the start hands the plan on in memory and reads back nothing it wrote, as Vite's
  optimizer passes its metadata on and reads `_metadata.json` only at the next start; the file is written
  to a temporary name and renamed, and the temporary file is removed when that fails (write-file-atomic).
- **regression_test:** `review-bridge/tests/work-package.test.mjs` "a start that holds its plan authorizes
  it while its plan file is being rewritten; one given only the path does not" (`6abf40e`);
  `review-bridge/tests/file-store.test.mjs`.
- **mutation_case:** `RB-M-plan-authorize-reads-back`, `RB-M-plan-temp-file-kept` (killed);
  `RB-M-plan-run-reads-back` (**survived**: tests do reach the read in `runAuthorized` through
  `start --yes`, but at that moment the plan file is always whole, so reading it back and not reading it
  look the same).
- **residual_risk:** no test tells whether `runAuthorized` reads the plan file back; catching it needs a
  way to make the file differ from the plan in memory at that moment, which this release does not add. On Windows, two renames onto
  the same plan file at the same instant may fail with `EPERM`; the second start then ends with that error
  instead of the refusal, and still no second run starts.

## RB-GATE-2026-004 — the second yes read the work order while the first start wrote its id

- **affected_gate:** Authorization
- **symptom:** two `start <file> --yes` at once on Windows CI: one run started (the guard held), but the other
  said `The work order changed after you saw the card` instead of saying the card was used. Seen in the
  Windows CI log of `521d5e9`, the only one read; Windows CI was red on every commit before it, for causes
  not read. Green on Linux CI at `521d5e9`. Why Windows meets the window and Linux does not is not shown: the
  write takes milliseconds. Whether Windows CI turns green with the fix is the check that this is the cause.
- **expected_vs_actual:** expected the second yes to be told the card was used; actually told the person had
  changed the work order, which they had not.
- **reproduction:** GitHub Actions `windows-latest`, Node 22.23.4, `npm test` (run 42710217414): 199 of 200
  pass, this one fails with that message.
- **root_cause:** after its claim, the start that took the card writes the work order's id into the person's
  file in place (`fs.writeFile`, as ESLint's `outputFixes` and Prettier's `writeFormattedFile` write a
  person's files). The other yes compared the file with the card before asking the records whether the card
  was used, so a file read half written looked changed. The same for a directory's card.
- **fix:** the commit that adds this entry — a file that does not read as the card showed is first asked of
  the records: a used card is refused as used. The write stays in place, which keeps hard-linked work
  orders one work order.
- **regression_test:** `tests/product-init.test.mjs` "--yes is refused when the work order changed after the
  card, …" (the work order emptied after the yes, as if half written); `review-bridge/tests/work-order-line.test.mjs`
  "a card lists the directory in order, …" (one of its files emptied after the line ran).
- **mutation_case:** `RB-M-yes-midwrite-says-changed`, `RB-M-line-yes-midwrite-says-changed` (not yet run:
  both tests start the database; they run in the container).
- **residual_risk:** a person who really edits the work order at the same moment another yes takes the card
  is told the card was used; that is also true.

## RB-GATE-2026-005 — a work order not yet on disk, under a Windows short path, was named outside the project

- **affected_gate:** Records
- **symptom:** on Windows CI `canonicalTaskFile` named `.review-bridge/work-packages/ログイン修正.md` as
  `../../../../../RUNNER~1/AppData/Local/Temp/…/ログイン修正.md`.
- **expected_vs_actual:** expected the path in the project; actually a path climbing out of it.
- **reproduction:** `review-bridge/tests/work-order-name.test.mjs` "the records name a file in NFC, …" on
  GitHub Actions `windows-latest` at `837f067`, whose TEMP is `C:\Users\RUNNER~1\…` (an 8.3 name for
  `runneradmin`).
- **root_cause:** the root was made real (long name) and so was the file, but a file not yet on disk cannot
  be made real, so it kept the short name; one long and one short path were compared.
- **fix:** the commit that adds this entry — both sides are made real as far as they exist and the rest is
  joined back, as CPython's non-strict `realpath` does on Windows (`Lib/ntpath.py`).
- **regression_test:** `review-bridge/tests/work-order-name.test.mjs` "a project named by its Windows short
  path names a work order not yet on disk by its path in the project" (skipped where there are no 8.3 names).
- **mutation_case:** `RB-M-task-file-short-path` (killed on a Windows volume with 8.3 names; invalid where
  the test is skipped).
- **residual_risk:** none known.

## RB-GATE-2026-006 — test files starting their databases at once took the same port

- **affected_gate:** Records (test setup)
- **symptom:** Windows CI `review-bridge/tests/acceptance-run.test.mjs`: the template's init failed with
  "PostgreSQL did not start within 60s" about 1.4 s after the server started; seven tests failed with it.
- **expected_vs_actual:** expected each test file's server to start; actually one died binding a port another
  file's server had just taken, and Bridge's message called it a 60 s timeout.
- **reproduction:** GitHub Actions `windows-latest` at `837f067`, `node --test "review-bridge/tests/*.test.mjs"`,
  which runs `os.availableParallelism() - 1` files at once; every file's server looked for a free port from
  the same start port.
- **root_cause:** a port is probed free and then bound by the server; between them another file's server
  took it. PostgreSQL starts its log collector before binding (`postmaster.c`), so the bind FATAL went to the
  collector's file, which writes a dying server's last words after it is gone (`syslogger.c`); Bridge read
  the file at once, saw only the collector's HINT, did not retry on the next port, and said "within 60s"
  whatever the wait.
- **fix:** the commit that adds this entry — each test file takes a port the system hands out, as the
  embedded-PostgreSQL libraries' test helpers do (fergusstrange/embedded-postgres `freePort`, zonky
  `detectPort`: bind port 0, read the number, close), and writes it as its data home's `database.port`; the start failure now says how long pg_ctl waited and the server's last lines as written.
- **regression_test:** none that can fail on demand; the check is both CI platforms green.
- **mutation_case:** none: the race is not reproducible on demand.
- **residual_risk:** reading the collector's file too early is unchanged, so a port taken between the probe
  and the bind outside the tests (another program) still fails instead of moving to the next port. The
  message says where the server's log is.
