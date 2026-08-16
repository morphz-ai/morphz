# Morphz Context State Pipeline Audit — 2026-08-16

> Status: complete — audit, repair and regression gates passed
>
> Scope: immutable Event Ledger, Mind Projection, Mind Snapshot, Session
> Projection, Recall Projection, Context Working Set, Frame lifecycle and the
> model-facing S-expression encoding.

## 1. Completion contract

This audit is complete only when every confirmed defect has a regression test,
SQLite and PostgreSQL satisfy the same store contract, long-running state
transitions remain bounded, and the complete Rust quality gate passes. Finding
a defect is not a terminal condition for this work.

## 2. Authoritative invariants

| ID | Invariant | Required evidence |
| --- | --- | --- |
| CTX-I01 | The immutable Ledger is the sole historical authority. Every derived state can be rebuilt from it. | Full replay equals online Mind Projection. |
| CTX-I02 | A Context transaction is all-or-nothing across Ledger Event, Context Head, Mind Projection, Session Projection, attention mutation and Recall Outbox intents. | Store conformance and rollback tests on both backends. |
| CTX-I03 | Context Head, materialized Mind revision/hash and transaction head Event always identify the same commit. | CAS conflict, corruption and restart tests. |
| CTX-I04 | Latest Snapshot plus later Context transactions produces exactly the same Mind as Genesis replay. | Differential replay after periodic, checkpoint and rollback snapshots. |
| CTX-I05 | Session Projection is exactly the active Observation set: append enters once, retire removes once, restore re-enters once, and no Context can mutate another Context's rows. | Stateful projection tests and backend conformance. |
| CTX-I06 | Recall is eventually convergent. Rebuild or a stale worker may not lose a newer Ledger/Mind intent or overwrite a newer document generation. | Rebuild/outbox race, leased-claim and restart tests. |
| CTX-I07 | Recall pagination remains valid across Runtime restart and across workers sharing one Store; cursors never expand authorization. | Restart/multi-worker cursor tests. |
| CTX-I08 | One model request observes a causally valid Context: its own root and claimed Signal batch are stable, future turns do not leak backwards, and concurrent status is explicitly read-only. | Interruption and concurrent-session Context Encoding tests. |
| CTX-I09 | Frame retirement is generation fenced. Revise, restore or protect cancels an older retirement, and an older finalizer cannot retire the successor state. | Stateful lifecycle and concurrent finalizer tests. |
| CTX-I10 | Online work is bounded by the selected Working Set and physical prompt capacity; Ledger length does not re-enter ordinary hot paths. | Query-plan and long-run capacity tests. |
| CTX-I11 | SQLite and PostgreSQL implement identical observable Context semantics. | Shared conformance suite, including every defect regression. |

## 3. Audit matrix

| Area | Existing evidence | Additional audit in this goal |
| --- | --- | --- |
| Mind transaction/CAS | Atomic SQLite tests, RuntimeStore conformance | Stateful differential sequence; concurrent writers; failure rollback |
| Snapshot recovery | Seed and incremental recovery tests | Periodic snapshot boundary, checkpoint/rollback, corruption and long tail |
| Session Projection | append/retire/restore and migration tests | Randomized active-set oracle and restart parity |
| Recall Projection | lexical, whole-document and stale-claim tests | Rebuild/outbox race, rebuild under writes, restart convergence |
| Frame lifecycle | operation and cognitive-clock tests | Generation race and randomized lifecycle sequences |
| Context Encoding | working-set and causal-frontier examples | Mixed concurrent reads, deterministic rerender and capacity soak |
| Backend parity | broad RuntimeStore suite | Context-specific regressions added to the common suite |

## 4. Confirmed findings

### CTX-F001 — Recall rebuild deleted concurrent durable intents

- Severity: high
- Invariant: CTX-I06, CTX-I11
- Evidence: `replace_recall_documents` deleted all rows from
  `recall_projection_outbox` even though its input documents were assembled
  before the replacement transaction. A Ledger Event committed after that
  snapshot could therefore lose its only pending Recall intent.
- Regression: RuntimeStore conformance now commits an Event after the rebuild
  snapshot, performs the stale replacement, drains the Outbox and requires the
  Event to become searchable.
- Repair: replacement preserves transactional Outbox rows. Reapplication is
  idempotent and existing document sequence plus Outbox generation fencing
  prevents stale overwrite.

### CTX-F002 — Recall rebuild rewrote unchanged Frame recency

- Severity: medium
- Invariant: CTX-I06
- Evidence: the long stateful differential test found that incremental Frame
  documents retained their actual update versions while a full rebuild stamped
  every Frame with the latest global Mind version. Maintenance therefore
  changed Recall ordering and cursor boundaries without a cognitive change.
- Regression: the 130-revision stateful test compares incremental and rebuilt
  Recall signatures after revise, relation, retirement, checkpoint and rollback
  transitions.
- Repair: Frame documents now derive their stable ordering key from
  `ContextFrame.updated_version`; their content hash no longer includes the
  unrelated global Mind version. Frame Outbox claims may replace the document
  at the same/lower stable version because Outbox generation, not recency, is
  the stale-writer fence. PostgreSQL locks the exact claimed Outbox generation
  before writing the document, preventing an older same-recency Frame worker
  from becoming the last writer after a newer generation.

### CTX-F003 — Recall cursors died on restart or worker hand-off

- Severity: high
- Invariant: CTX-I07
- Evidence: a cursor generated by one `ContextEngine` failed with `签名无效`
  when the next page was served by a fresh engine over the same Store. Each
  process generated an unrelated random cursor key.
- Regression: Frame and lexical Recall cursors are encoded by one engine and
  decoded by a restarted engine; byte tampering remains rejected.
- Repair: cursors use a stable, versioned, domain-separated integrity digest.
  They are not authorization credentials: Context/Principal authorization and
  every query parameter are revalidated when consumed.

### CTX-F004 — Explicit Mind audit could report transient corruption

- Severity: high
- Invariant: CTX-I01, CTX-I03
- Evidence: a deterministic test commits a Context transaction after the audit
  has read Ledger but before it reads Projection. The previous implementation
  compared different commit boundaries and returned `matches = false`.
- Regression: `mind_projection_audit_retries_a_concurrent_commit_between_independent_reads`.
- Repair: audit detects a forward Projection/Snapshot revision, yields, and
  reacquires a bounded stable observation boundary. Sustained writes now
  produce an explicit “stable view unavailable” result rather than a false
  corruption diagnosis.

### CTX-F005 — Model Context could combine Mind and Observation from different commits

- Severity: critical
- Invariant: CTX-I02, CTX-I05, CTX-I08, CTX-I11
- Evidence: Context Encoding read Mind before reading Session Projection. A
  concurrent atomic transaction could retire the source Observation and create
  its replacement Frame between those reads, leaving the model-facing request
  with neither fact.
- Regression: shared SQLite/PostgreSQL conformance repeatedly toggles one
  Observation while reading Context snapshots and requires the Mind membership
  marker and Event membership to agree on every read.
- Repair: `SessionProjectionStore` now exposes one causal Context Encoding
  snapshot. SQLite pins one WAL read transaction; PostgreSQL uses a read-only
  `REPEATABLE READ` transaction. Context compilation validates and consumes the
  Mind Projection and active Session Events returned by that same snapshot.

### CTX-F006 — Frame retirement maintenance could fail Context compilation under writers

- Severity: medium
- Invariant: CTX-I09
- Evidence: retirement finalization constructs a transaction from an earlier
  version. A concurrent writer produced an ordinary string error which the
  caller did not recognize as retryable, so derived cleanup could fail the
  model's Context build.
- Regression: stale Runtime finalization must return a typed lifecycle conflict;
  the existing cognitive tick, cancellation and successor tests still pass.
- Repair: Runtime lifecycle version movement has a typed retry boundary.
  Finalization retries with bounded backoff and, under sustained writers,
  leaves the fenced durable intent for the next pass instead of rejecting
  Context compilation.

### CTX-F007 — Context-local mutex registry grew without bound

- Severity: medium
- Invariant: CTX-I10
- Evidence: every Context ID ever written remained as a strong `DashMap` entry
  for the lifetime of the process.
- Regression: 1,000 transient Context locks must leave the registry empty;
  existing multi-engine concurrent writer tests preserve serialization/CAS.
- Repair: registry entries are weak references. A custom guard unlocks first,
  then atomically removes the matching entry only when no waiter/owner still
  holds that exact mutex, avoiding both leaks and split-lock races.

## 5. Audited hypotheses and disposition

All five initial hypotheses reproduced as CTX-F003 through CTX-F007 and were
repaired with regressions. The long differential run also discovered CTX-F002,
which was not visible in the initial static review.

## 6. Verification record

- Context module: 65 tests passed, including long replay/rebuild, restart,
  concurrency, lifecycle, capacity and causal-frontier coverage.
- SQLite RuntimeStore conformance: passed with stale Recall rebuild and atomic
  Context Encoding snapshot regressions.
- PostgreSQL RuntimeStore conformance: passed in an isolated temporary schema
  against the local PostgreSQL 15 instance, including the same regressions.
- Context compilation compatibility: Delegate integration tests pass both for
  the production pair of Mind + Session Projections and for lightweight stores
  which intentionally configure Session Projection without Mind Projection.
- Complete Rust suite: 873 passed, 6 ignored, 0 failed.
- `cargo clippy -p morphz --all-targets -- -D warnings`: passed after repairs.
- Dashboard: 124 tests passed; lint and production build passed. The existing
  Vite main-chunk size warning remains a separate frontend performance item,
  not a Context state-pipeline correctness failure.
- `cargo fmt --all -- --check` and `git diff --check`: passed.

## 7. Residual boundaries

- Recall cursors use a stable versioned checksum, not an authorization secret.
  This is intentional: cursor payloads only select a validated pagination
  position, while Context/Principal access and all query-shape fields are
  revalidated on every request. A future product requirement for opaque,
  unforgeable cursors would require a durable shared Runtime secret.
- Frame retirement finalization is bounded best-effort maintenance. Sixteen
  consecutive version conflicts defer the still-fenced durable intent to the
  next Context/clock pass rather than failing a model request; no authoritative
  state is discarded.
- PostgreSQL and SQLite share observable conformance, but distributed-process
  soak testing under real network latency remains an operational benchmark,
  not a substitute for the deterministic transaction tests completed here.
