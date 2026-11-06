Review Bridge runs a work order with a writer and a read-only reviewer. The person asks for one of
four actions ({{args}}):

- `start <file>`: start a work order from `.review-bridge/work-packages/`. To run several one after
  another, they go in one subdirectory there with file names starting `01-`, `02-`, and `start` takes
  that directory.
- `stop <run_id>`: pause a running work order; its records are kept
- `resume <run_id>`: carry a stopped work order on
- `clean [<run_id>]`: clear finished records; with a run id, that one run

What to do:

1. Run the matching command in this project folder: `review-bridge <action> <file|run_id>`.
2. When it prints a card and stops with "Needs authorization" (start and resume do), show the
   person the card exactly as printed, word for word, and ask whether to go on. There are two cards:
   the first's yes pays for turning the work into a contract and asking what it leaves open; the
   second names the sealed contract, and its yes starts the work.
3. Only if the person says yes, run the same command again with `--yes`. If they do not say yes,
   do not run it: do not guess and do not decide for them. stop and clean need no card.
4. When it prints "stopped to ask you" and its questions (start does, before any work), put them to
   the person with your own question tool, word for word, each reading and the two ways out: letting
   the AI decide, or saying it themselves. Do not choose for them and do not edit the work order. Run the
   same command again with what they said: `--answer` once per question, in order, each a reading's
   number or their own words (`--answer 2 --answer "rounder"`), or `--answer ai` if they let the AI decide.
   Bridge writes it into the work order and goes on: it may ask again, and it ends at the sealed card, so
   go back to step 2. For a directory, answer each file's questions with that file's command, then run
   `start` on the directory for the one sealed card of all of them.
5. When the work has run, read the result file it printed ("Result file: ...") and report it.
   Do not commit, push, deploy or release anything unless the person asks you to.
