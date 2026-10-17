# Review Bridge State Contract v4

Status: APPROVED FOR STAGING IMPLEMENTATION  
Date: 2026-08-28  
Scope: controller state, policy, authorization, run recovery, audit, migration, and rollback  
Non-scope: application features, adapters, ticket-system integration, parallel scheduling UI

D1-D7 and the acceptance matrix were approved by the human owner on 2026-08-28. This approval authorizes staging implementation and acceptance verification only; it does not authorize commit, push, release, external delivery, or migration apply.

## 1. Required separation

The controller must keep these lifecycles separate:

1. Work package: immutable definition of task, scope, allowed paths, change types, budget, and breakpoint.
2. Authorization: immutable human approval of one exact work-package checksum under one exact effective-policy checksum.
3. Run: mutable execution projection for one attempt, including session, usage, status, and evidence pointers.
4. Event log: append-only audit history of run transitions. A current run file must never replace historical evidence.

Copying a work-package file must not copy or create authorization. Changing any work-package field creates a new checksum and requires a new authorization.

## 2. Proposed layout

```text
.review-bridge/tools/review-bridge/config/
└─ default-policy.json                 # installer-owned package default

.review-bridge/review-bridge/
├─ bridge.json                         # static schema and policy references
├─ policy.override.json                # project-owned override
└─ policy-snapshots/<sha256>.json       # immutable effective policy

.review-bridge/review-queue/
├─ work-packages/<id>/<sha256>.json     # immutable definition
├─ authorizations/<authorization-id>.json
├─ authorization-claims/<authorization-id>.json
├─ runs/<run-id>.json
├─ events/<run-id>.jsonl
├─ pending/
├─ running/
├─ done/
└─ failed/
```

There is no mutable `active_run_ids` index. Active runs are derived from `runs/*.json` status. New runtime code must not use current policy to reinterpret an old job; every authorization, run, and job references an immutable policy snapshot checksum.

## 3. Core records

### 3.1 Work package

Required fields:

- `schema_version`
- `work_package_id`
- normalized work-item source fields when present
- task and acceptance criteria
- change types and allowed paths
- budget
- breakpoint
- content checksum
- created timestamp

The file is immutable. A revised task, scope, budget, or breakpoint creates a new checksum under the same logical ID or a new logical ID.

### 3.2 Start authorization

Required fields:

- `schema_version`
- `authorization_id`
- `kind: start`
- `authorized_by`
- `authorized_at`
- `expires_at`
- `work_package_sha256`
- `effective_policy_sha256`

It does not duplicate task, scope, paths, budget, or breakpoint.

### 3.3 Budget-extension authorization

Proposed fields:

- all identity, issuer, timestamp, expiry, work-package checksum, and policy checksum fields
- `kind: budget_extension`
- `run_id`
- exact additional call and time allowance

This is a distinct authorization type, not a mutation of the start authorization or work package.

### 3.4 Authorization claim

Required fields:

- `authorization_id`
- `run_id`
- `claimed_at`
- `claim_kind`
- authorization checksum

The claim is created with exclusive-create semantics. An existing claim is valid only for its recorded run; it cannot authorize another run.

### 3.5 Run

Required fields include:

- `run_id`
- `work_package_sha256`
- `authorization_ids[]`
- `effective_policy_sha256`
- Claude session identity
- status and transition sequence
- consumed and remaining budget
- `run_deadline_at`
- workspace baseline and evidence pointers
- parent/resume metadata when applicable

The run projection is updated atomically under a per-run lock. Its status is not a replacement for the event log.

## 4. Pending decisions

Decision status: **D1-D7 APPROVED by the human owner on 2026-08-28.** Option A is selected for D1-D5; D6 and D7 invariants are approved as written.

### D1 - Crash recovery and claim ownership

Options:

- A: An abnormal interruption may resume the same non-terminal run, session, and claim after proving that no live controller holds the run lock.
- B: Every abnormal interruption consumes the authorization and requires a new authorization.

Recommendation: **A**.

Under A:

- A normal `pass`, `hard_stop`, `rate_limited`, `cancelled`, or policy failure is a terminal disposition, not a crash.
- A stale `running`, `review_pending`, or `correction_pending` projection with no live lock may become `interrupted`.
- The per-run lock record contains `run_id`, a random `lock_nonce`, PID, `acquired_at`, and `heartbeat_at`.
- Package policy defines heartbeat interval, stale threshold, and reconcile grace period. Initial proposed values are 5 seconds, 30 seconds, and 5 seconds.
- A controller is live only while both conditions hold: its PID probe succeeds and the same lock nonce receives a heartbeat within the stale threshold.
- Reconcile may treat a lock as stale only after the heartbeat is expired, it acquires the reconcile guard, waits the grace period, rereads the same nonce, and observes no heartbeat advance. A dead PID alone is insufficient until heartbeat expiry; an alive PID alone is insufficient because Windows may reuse a PID.
- The per-run reconcile guard is itself acquired with exclusive-create semantics and records `run_id`, a random `guard_nonce`, owner PID, `acquired_at`, and `expires_at`. Its package-policy TTL must be longer than the grace period; the initial proposed values use a 15-second guard TTL for a 5-second grace period.
- A reconcile guard does not renew indefinitely. Its owner must finish or abort before expiry and must reread the same `guard_nonce` immediately before every takeover mutation. After expiry, a contender may atomically move the stale guard to a nonce-addressed tombstone and exclusive-create a new guard. A controller that loses the nonce is fenced and must stop. This finite lease is the terminal stale-guard recovery rule; it must not create another nested guard type.
- If heartbeat advances or the lock nonce changes during reconciliation, takeover stops immediately.
- Resume must use the claim's original `run_id`; it must not create another run or claim.
- Resume is allowed only before `run_deadline_at`, with remaining budget, the same policy snapshot, and no terminal review gate.
- Recovery is explicit through controller resume/reconcile logic; copying or deleting a claim is never recovery.

### D2 - Authorization expiry and run recovery window

Options:

- A: `expires_at` is mandatory; package policy supplies a default and maximum TTL. A claimed run receives a separate recovery deadline.
- B: expiry remains optional.

Recommendation: **A**, with initial defaults of 24 hours for authorization claim and a 24-hour sliding crash-recovery window after claim. Project override may shorten but not extend these package maxima.

An authorization must be unexpired when first claimed. After claim, `run_deadline_at` controls crash resume. The deadline slides only after a successfully fsynced, substantive run-progress event and is set to that event time plus the effective recovery window. Heartbeat-only events do not extend it. Neither timestamp permits budget or scope expansion, and a run without remaining budget cannot resume even if its deadline is valid.

### D3 - Budget increase during a run

Options:

- A: Keep the same run and session. Attach one or more immutable `budget_extension` authorizations, each exclusively claimed by that run. Sum grants under policy ceilings.
- B: End the run, create a revised work package and authorization, and start a new run that inherits the session and original evidence baseline.

Recommendation: **A**. It preserves one semantic run and one evidence baseline while retaining a complete authorization trail.

The controller must reject extension grants that reference another run, work-package checksum, or policy snapshot. An extension cannot alter scope, paths, breakpoint, task, or review level. Claim validation, effective-budget recomputation, ceiling enforcement, event append, and run-projection update occur in one per-run locked transaction; concurrent extensions cannot both pass against the same stale remaining ceiling. Total effective budget must remain at or below the effective policy ceiling.

### D4 - Machine-enforced tighten-only policy merge

Options:

- A: Define typed merge constraints and fail policy snapshot creation when an override weakens a protected field.
- B: Keep the restriction as documentation only.

Recommendation: **A**.

Required protected merge rules:

- Every package-default classification rule that participates in a protected boundary has a stable rule ID and explicit `protected: true`. Snapshot validation derives the protected rule set from this field; a project override cannot clear, replace, or shadow it.
- mandatory non-retryable auth and rate-limit classes: set union; project cannot remove
- forbidden paths and disallowed tools: set union; project can add only
- call, wall-clock, authorization-TTL, and recovery ceilings: numeric minimum
- minimum review effort for protected classes: ordered maximum (`low < medium < high`)
- mandatory human hard-stop classes: set union; project cannot remove
- release actions requiring human approval: immutable true
- protected classification positive patterns, path globs, and semantic triggers: set union; project can add but cannot remove or narrow
- protected classification exclusions: project cannot add an exclusion; removing a package exclusion is allowed because it tightens classification
- protected classification level and priority: ordered maximum; project cannot lower or shadow a protected match

Classification evaluates all matching rules and selects the highest required review level. Rule ordering or an earlier project rule cannot short-circuit a protected SECURITY, FINAL_CLOSURE, or other package-protected match. Arrays use explicit per-field semantics; there is no generic deep-merge or implicit append. Snapshot creation validates the merged result before hashing it.

### D5 - Policy upgrade invalidation

Options:

- A: An installer upgrade that changes effective policy invalidates all unclaimed authorizations referencing an older snapshot. The upgrade report and audit record list count, IDs, and reason.
- B: Old unclaimed authorizations continue under their old policy snapshot.

Recommendation: **A**.

Every policy snapshot records `policy_schema_version`, `package_default_policy_sha256`, `project_override_sha256`, and the final effective-policy checksum. It never relies on a package enumerating user-specific effective snapshot hashes.

During 0.x, a runtime declares only its current `policy_schema_version` and current `package_default_policy_sha256`; it carries no historical compatibility list. If either recorded value differs after activation, unclaimed authorizations are invalidated and claimed non-terminal runs stop at a human hard stop. Their immutable files remain for audit and are never silently reinterpreted. A historical compatibility matrix is deferred until 1.0 and requires a separate reviewed contract.

Runtime activation is atomic from the controller's perspective. While the installer-owned upgrade marker/lock exists, new starts, resume, and crash reconciliation fail closed. After activation completes, they compare the recorded schema/default-policy identity with the activated runtime manifest's current identity. An interrupted upgrade leaves the previous runtime active or an explicit incomplete-upgrade state; it must never expose a partially replaced runtime as current.

### D6 - Rollback boundaries

Required distinction:

- Installer rollback changes installer-owned runtime/configuration files. It must not delete, overwrite, or rewind authorizations, claims, runs, events, reviews, or workspace evidence.
- Run rollback restores application changes through a new compensating work package and a new immutable authorization with `kind: rollback`. The authorization references the compensating work-package checksum, source run, and source evidence. It is claimed and executed under the same gates as any other run. It must preserve the original run, events, and evidence and add new rollback evidence.

Recommendation: approve this distinction as a hard invariant.

If an older runtime cannot read the current state schema, installer rollback fails closed instead of restoring an incompatible runtime. Migration rollback may restore operational pointers/configuration from the legacy archive, but v4 migration events and evidence remain append-only.

### D7 - Storage atomicity boundary

Recommendation: approve local filesystem as the supported consistency boundary for v4.

Exclusive-create and lock guarantees are assumed only for a local filesystem with documented atomic semantics, such as local NTFS, APFS, or ext4. OneDrive-synchronized folders, network shares, and similar filesystems are unsupported for concurrent controller execution. Preflight must warn or fail when the location is known to be unsafe; README must state this limitation.

## 5. Event and recovery invariants

- Events are partitioned by run to avoid one global append hotspot.
- Event sequence is monotonic per run and is written under the per-run lock.
- The event line is appended through an open file handle and `fsync`/`FileHandle.sync()` completes before the run projection advances. A successful `appendFile` return alone is not durable evidence.
- The atomic run-projection replacement fsyncs its temporary file before rename and fsyncs the containing directory where the platform supports it.
- Startup reconciliation compares the projection sequence with the event sequence.
- A malformed or partial event tail fails closed and requires an explicit repair procedure; it is never silently discarded.
- Terminal runs cannot transition back to active. Resume after a terminal disposition requires a new authorization and, where applicable, a new run.

## 6. v2/v3 migration contract

Removed 2026-10-16: the `migrate-control` command and the v2/v3 migration code are no longer in the product. This section is kept as history.

Command shape: `bridge migrate-control plan|apply` with checksum approval.

Required behavior:

1. Refuse migration when legacy CONTROL is active or a live Bridge lock exists.
2. Accept only supported inactive/consumed v2 or v3 input.
3. Preserve the original CONTROL as a checksum-addressed, private legacy archive.
4. Move package-generic policy to installer-owned defaults and project-specific hard stops to project override.
5. Create one immutable effective policy snapshot.
6. Import old terminal state only as historical data; never create replayable authorization from incomplete legacy fields.
7. Produce a migration report listing imported, omitted, invalidated, and unresolved records.
8. Verify rollback compatibility without deleting migration audit or evidence.

## 7. Acceptance matrix

Implementation is not complete until disposable tests prove all of these:

1. Copying a work package creates no authorization.
2. The same start authorization cannot create two runs, including concurrent attempts.
3. A crash after claim can resume the same run/session/claim before the recovery deadline.
4. A normal hard stop cannot use crash recovery to bypass new authorization.
5. Expired unclaimed authorization is rejected.
6. Expired recovery deadline prevents crash resume.
7. Budget extension stays on the same run, cannot change scope, and cannot exceed policy ceiling.
8. Tighten-only override accepts stricter values and rejects every protected weakening case.
9. Policy upgrade reports all invalidated unclaimed authorizations and preserves their audit records.
10. Historical jobs and evidence continue to validate against their recorded policy snapshot, but an old non-terminal run cannot execute after its recorded schema/default-policy identity differs from the active 0.x runtime.
11. Active-run discovery from `runs/` remains correct with at least two concurrent runs and no central active index.
12. Installer rollback preserves authorizations, claims, runs, events, reviews, and evidence byte-for-byte.
13. Run rollback creates compensating evidence and preserves the original audit trail.
14. v2/v3 active migration fails closed; consumed migration and rollback round-trip pass.
15. Unsafe synchronized/network storage produces the documented preflight result.
16. Windows local filesystem tests exercise exclusive claim, stale-lock recovery, stale reconcile-guard takeover, and interrupted-run resume on a real local NTFS volume. Mocked, in-memory, OneDrive-synchronized, or network filesystems cannot satisfy this acceptance case. Equivalent native APFS/ext4 evidence is required before claiming support for those platforms.
17. Two budget-extension authorizations concurrently claiming the same run are serialized; each authorization is consumed at most once and the effective total never exceeds the policy ceiling.
18. Removing or narrowing a protected SECURITY classification path/pattern, adding a bypass exclusion, or shadowing it with a LIGHT rule is rejected during policy snapshot creation.
19. A run that crashes while an upgrade is in progress follows the 0.x current-only rule: if activation did not complete, the previous runtime remains authoritative and normal D1 recovery may proceed; after activation changes the schema/default-policy identity, the run stops at a human hard stop without losing claim, events, or evidence.

### 7.1 Acceptance traceability and evidence

- Acceptance items use stable IDs `AC-01` through `AC-19`, matching the numbered list above.
- Every ID has exactly one primary test file or top-level `describe` suite named with that ID. Subcases may exist under the primary suite, and helpers may be shared, but no acceptance item may exist only as an untraceable assertion inside another suite.
- Delivery evidence for each ID records the test path, exact command, runtime version, operating system, filesystem type when relevant, result, timestamp, and raw-output or artifact pointer.
- `AC-16` evidence additionally records the real local volume and detected filesystem. Mocked filesystem output cannot be attached as its passing evidence.
- A summary such as "all acceptance tests passed" is not sufficient evidence. Review must be able to locate and rerun each acceptance ID independently.
- The implementation delivery report includes an `AC-01` to `AC-19` claims-to-evidence table. Missing, skipped, or not-run IDs fail the implementation release gate unless the human owner explicitly changes this contract.

## 8. Release gate

The human owner must approve D1-D7. The independent reviewer must then review the approved contract and acceptance matrix. Only after that review may the writer implement v4 state handling.

Release milestones are independent:

1. Fresh-install RC: requires v4 fresh-install state handling, disposable no-Git Vue initialization, all fake gates, native-readiness reporting, and the real bounded canary. It does not require legacy CONTROL migration or any change to an existing installed runtime.
2. Legacy project migration: separately requires the approved v2/v3 migration command. Before its plan step, the current legacy work package/CONTROL must reach an inactive, consumed or otherwise terminal state and all live Bridge locks must be clear. The milestone then requires migration plan/apply evidence, rollback verification, and installed-runtime regression.

Failure or delay in a legacy project migration must not block delivery of a fresh-install v4 RC. Migration code must not be included in the RC critical path unless that RC explicitly advertises legacy upgrade support.
