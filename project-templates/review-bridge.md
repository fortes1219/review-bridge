# Review Bridge Boundary

The Review Bridge controller (the `review-bridge` command, installed by npm) owns the review
state machine. This project's Bridge state lives in `.review-bridge/`.

- Claude is the writer. Codex is the independent reviewer.
- Runtime authorization comes only from an immutable authorization that references the exact work-package and effective-policy checksums.
- Active execution is derived from `.review-bridge/review-queue/runs/*.json`; there is no mutable global active-run list.
- An inactive, missing, malformed, exhausted, or consumed authorization fails closed.
- A review FAIL without a hard stop may return only named findings to the authorized Claude session.
- A review FAIL with a hard stop returns control to the human owner.
- A review PASS reaches the authorized breakpoint and returns control to the human owner.
- Neither agent may create a new work package, approve a decision, commit, push, deploy, or release without explicit human authorization.
- Project architecture and domain policy remain in project-owned canonical sources.
