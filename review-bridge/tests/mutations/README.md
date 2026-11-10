# Gate mutations

A test that cannot fail guarantees nothing. Each case in `cases.json` puts one specific mistake back into
a copy of the tree, and names the one test case that exists to catch it and the message it must fail
with:

```sh
node scripts/verify-gate-mutations.mjs                      # every case
node scripts/verify-gate-mutations.mjs --only <id>,<id>     # some
node scripts/verify-gate-mutations.mjs --report out.json    # with the full report
```

The copy is HEAD with the working tree's changes, written by Git into a temporary index and checked out
under the system temp folder; the working tree, the index and the refs are not touched. Each result is:

- `killed`: the case passes on the copy, the mistake went in, and the case fails with the expected message;
- `survived`: the mistake went in and the case still passes, so the test cannot catch it;
- `invalid`: the anchor is gone (the code changed shape), the case is not green before the mistake, no test
  ran, or the case failed for another reason. Never counted as killed.

A case has: `id`, `gate` (Authorization, Contract, Probe, Budget, Delivery, Records, Install), `target`
(the file), `anchor` and `replacement` (the mistake), `reason` (what goes wrong), `test` and `case` (the
file and the test name), and `expect` (a regular expression the failing output must match).

This is not part of `npm test`. `fail-open-ledger.md` keeps each defect the cases come from; it lives here,
beside its cases, and not under `docs/`, which is the documentation site, and npm does not ship it. The method is
Nanako0129/stingray's `tests/mutants.sh`.
