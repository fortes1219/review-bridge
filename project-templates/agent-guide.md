Review Bridge runs a work order with a writer and a read-only reviewer. The person asks for one of
four actions ({{args}}):

- `start <file>`: start a work order from `.review-bridge/work-packages/`. To run several one after
  another, they go in one subdirectory there with file names starting `01-`, `02-`, and `start` takes
  that directory.
- `stop <run_id>`: pause a running work order; its records are kept
- `resume <run_id>`: carry a stopped work order on
- `clean [<run_id>]`: clear finished records; with a run id, that one run

What to do:

1. Run the matching command in this project folder: `{{bridge}} <action> <file|run_id>`.
2. When it prints a card and stops with "Needs authorization" (start and resume do), show the
   person the card exactly as printed, word for word, and ask whether to go on. There is one card: it
   names the contract Bridge cut from the work order, and its yes starts the work.
3. Only if the person says yes, run the same command again with `--yes`. If they do not say yes,
   do not run it: do not guess and do not decide for them. stop and clean need no card. After the yes,
   Bridge writes the work order's `id` at the top of the file (its front matter); do not delete it.
4. When start says a work order cannot start yet (what to do or the acceptance list is missing, a line
   of the list is not an item, a question in it is still open), show the person what it printed, word
   for word. The work order is theirs to fill in: do not write it for them. Run start again once they
   say it is filled in.
5. When the work has run, read the result file it printed ("Result file: ...") and report it.
   Do not commit, push, deploy or release anything unless the person asks you to.
