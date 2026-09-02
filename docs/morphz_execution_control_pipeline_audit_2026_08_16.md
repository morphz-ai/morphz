# Morphz Execution Control Pipeline Audit — 2026-08-16

> Status: complete — audit, repairs and regression verification completed.
>
> Scope: Tool Call admission, Execution Target authorization, Approval and
> Capability Lease, Execution Job, Action Group, local/Managed SSH/Edge
> execution, cancellation, retry, crash recovery and scheduler projection
> closure.

## 1. Completion contract

This goal is complete only when the audit and repair phases are both complete.
Every confirmed defect must have a deterministic regression, SQLite and
PostgreSQL must expose the same observable contract, and the complete Rust and
Dashboard quality gates must pass. A finding alone is not a deliverable.

## 2. Authoritative invariants

| ID | Invariant | Required evidence |
| --- | --- | --- |
| EXE-I01 | A physical Action is authorized against the current Principal, Agent, Context, Thread and Target immediately before reality is crossed. Approval waiting or a frozen route cannot preserve revoked authority. | Revoke-during-approval and scoped-grant scale regressions. |
| EXE-I02 | Approval is bound to one immutable Job/request/policy identity. A grant is consumed at most once and cannot authorize a different request or changed policy. | Digest mismatch, concurrent claim and one-use tests on both stores. |
| EXE-I03 | A claimed Job has one fenced worker. Heartbeat, cancellation and terminal commits require the current revision and claim token; a stale or late worker cannot overwrite a newer fact. | Competing worker and late-result tests. |
| EXE-I04 | Retry behavior follows the declared safety contract. Work proven not to have crossed a side-effect boundary is replayable; truly idempotent work is replayable after that boundary; uncertain non-idempotent work becomes explicit `lost`. | Restart decision matrix and end-to-end recovery tests. |
| EXE-I05 | Cancellation is monotonic. The first durable cancellation cause is retained, unstarted work cannot begin afterward, and a running executor owns physical termination until it records the observed result. | Repeated cancellation, approval wait and cancel/result race tests. |
| EXE-I06 | Each immutable Tool Result closes exactly one Execution Job and exactly one parent join: a standalone Thread Signal, an Action Group member, a Plan continuation, or a dedicated Runtime projection. No result is both double-woken and unjoined. | Crash-window and startup-recovery tests for every route. |
| EXE-I07 | Action Group settlement is eventually convergent from durable member results. A crash between Job/result commit and Group commit cannot leave a permanent pending member. | Failure injection after result commit and restart repair. |
| EXE-I08 | Direct Artifact Transfer terminal Jobs and their Activation/Thread projections converge to the same terminal outcome after live completion or restart recovery. | Pre/post-publication restart and projection-repair tests. |
| EXE-I09 | Revoking an Edge Node prevents new claims and deterministically closes or cancels work which can no longer be served; queued commands cannot remain forever. | Node revoke with queued/claimed commands on both stores. |
| EXE-I10 | Empty queues and authorization hot paths are bounded database operations. Correctness never depends on an arbitrary `LIMIT`, and waiters use durable notification/fallback rather than fixed-rate polling. | More-than-limit regressions and query-shape tests. |
| EXE-I11 | SQLite and PostgreSQL implement the same execution-control state machine, including recovery and concurrency semantics. | Shared RuntimeStore conformance for every store-level repair. |
| EXE-I12 | PostgreSQL commits made by one Runtime process wake competing Runtime processes without polling or duplicate execution. Database notifications are latency hints; bounded indexed recovery remains authoritative. | Real two-process Runtime probe plus shared-store conformance. |

## 3. Audit matrix

| Area | Existing protection | Additional audit in this goal |
| --- | --- | --- |
| Target authorization | Owner check, scoped grants, execution-boundary revalidation | Exact scope lookup, revocation during waits, large grant sets |
| Approval | Stable request/policy digests, atomic grant consumption | concurrent decision/claim/cancel and policy-change cases |
| Capability Lease | Principal/Agent/Thread-or-Session/Target/policy/TTL binding | large active lease sets, terminal-Thread revocation and Session isolation |
| Execution Job | revision + claim-token fencing, durable result Event | retry matrix, cancellation causation, late result and startup wake |
| Action Group | atomic member + final settled Event | Job/result-to-member crash window and startup convergence |
| Physical backends | frozen Target route and backend-specific validation | local/SSH/Edge equivalence, cancellation and wait behavior |
| Artifact Transfer | deterministic staging and publication boundary | startup terminal projection repair and relay-leg recovery |
| Edge Node | signed identity, claims, leases and output fencing | revoke closure, expired claim, multi-worker and notification paths |

## 4. Confirmed findings

### EXE-F001 — Scoped Target authorization depended on the latest 1,000 rows

- Severity: high
- Invariant: EXE-I01, EXE-I10, EXE-I11
- Evidence: the physical execution boundary loaded at most 1,000 active grants
  and searched them in Rust. A valid Agent/Context/Thread grant outside that
  arbitrary window was treated as absent.
- Repair direction: one indexed SQL existence query over the three exact
  scopes; no materialized row list and no correctness limit.

### EXE-F002 — Capability Lease reuse depended on the latest 100 rows

- Severity: medium
- Invariant: EXE-I02, EXE-I10, EXE-I11
- Evidence: lease coverage loaded at most 100 active leases and performed JSON
  coverage in Rust. A still-valid covering lease outside that window caused an
  unnecessary new Approval.
- Repair direction: page every exact Principal/Agent/Thread/Target candidate
  without a semantic cap, or add an exact indexed coverage authority; tests
  must exceed the former limit.

### EXE-F003 — Repeated cancellation could rewrite its durable cause

- Severity: medium
- Invariant: EXE-I05, EXE-I11
- Evidence: `cancel_requested_at` was first-write-wins, while `cancel_reason`
  was overwritten on every subsequent request, including by `None`.
- Repair direction: the first cancellation request is an immutable causal
  fact; later requests are idempotent observations and do not advance revision
  or alter the reason.

### EXE-F004 — Retry safety and the persisted side-effect boundary disagreed

- Severity: high
- Invariant: EXE-I04
- Evidence: `Idempotent` is documented as safe to repeat, but every physical
  dispatch records a side-effect boundary and restart recovery then forbids
  every replay. Conversely, even an at-most-once Job proven not to have crossed
  that boundary was marked `lost`.
- Repair direction: freeze an explicit retry matrix. Any uncancelled Job before
  the boundary is replayable; truly idempotent work is also replayable after
  it. Publication-style transfers which require observation after the boundary
  use `ReconcileRequired`, not a misleading idempotent label.

### EXE-F005 — Startup-created `lost` results did not wake standalone Threads

- Severity: critical
- Invariant: EXE-I06
- Evidence: startup recovery persisted a deterministic Tool Result with
  `wake_policy=immediate`, but called the Store with `wake_thread=false` for
  every Job. A standalone parent could therefore remain waiting on a terminal
  result forever.
- Repair direction: resolve the Job's durable join route first. Standalone
  results append exactly one direct Signal; Action Group members never do.

### EXE-F006 — Job/result commit and Action Group member commit had a crash gap

- Severity: critical
- Invariant: EXE-I06, EXE-I07
- Evidence: a physical worker committed its Job and immutable result Event in
  one transaction, then committed the Group member in a second transaction.
  A crash in between left a terminal Job with a pending Group member. Group
  members also failed to retain their deterministic Execution Job IDs, making
  explicit repair needlessly indirect.
- Repair direction: persist physical member Job identity and add idempotent
  Action Group reconciliation from immutable results at startup. The live path
  also treats a post-result store failure as repairable state, not as permission
  to abandon the join.

### EXE-F007 — Direct Artifact Transfer recovery could leave scheduler state open

- Severity: high
- Invariant: EXE-I06, EXE-I08
- Evidence: generic Execution Job recovery could terminalize a transfer Job as
  `lost`, after which the transfer startup scan excluded it. Only the live
  worker closed its Activation and Thread projections.
- Repair direction: startup recovery closes dedicated Artifact Transfer
  projections from the authoritative terminal Job/result, including `lost`.

### EXE-F008 — Revoked Edge Nodes could retain permanently queued commands

- Severity: high
- Invariant: EXE-I09, EXE-I11
- Evidence: node revocation prevented authentication and marked its Target
  offline only during later reconciliation, but queued commands remained
  claimable only by the now-revoked Node and had no terminal transition.
- Repair direction: revoke Node, mark its Targets offline, cancel queued
  commands and request cancellation of claimed commands in one transaction.

### EXE-F009 — Edge result waiters used fixed-rate database polling

- Severity: medium
- Invariant: EXE-I10
- Evidence: each cloud-side Edge execution queried command state every 250 ms
  even though the Store already exposes process/cross-worker change
  notification with a durable timeout fallback.
- Repair direction: use the Store notification boundary and retain a bounded
  fallback query for missed notifications.

### EXE-F010 — A post-execution internal error could strand a running Job

- Severity: critical
- Invariant: EXE-I03, EXE-I06
- Evidence: attachment persistence, Event construction or Group commit errors
  escaped the spawned tool task. The join loop returned the error without
  proving a terminal Job/result pair, even though the physical action might
  already have completed.
- Repair direction: re-read durable Job/result state. Reuse an already
  committed result; otherwise close the still-claimed Job with an explicit
  `lost` result and feed that same fact into its parent join.

### EXE-F011 — PostgreSQL Thread Signals had no cross-process commit wake

- Severity: critical
- Invariant: EXE-I06, EXE-I11, EXE-I12
- Evidence: two independently started Runtime processes observed the durable
  user message, but neither received the other process's in-memory EventBus
  notification. The only recovery path slept for 30 seconds, so the real
  multi-process probe timed out without a reply after 10 seconds.
- Repair: a PostgreSQL trigger publishes a schema-qualified notification only
  after a pending Thread Signal transaction commits. Every Store owns a
  reconnecting listener which wakes the bounded pending-Signal reconciler.
  The indexed 30-second scan remains the missed-notification authority.

### EXE-F012 — PostgreSQL Edge waiters silently degraded to 250 ms polling

- Severity: medium
- Invariant: EXE-I09, EXE-I10, EXE-I12
- Evidence: `wait_for_edge_command_change` used only a process-local `Notify`.
  Edge workers, Runtime callers and Dashboard connections in different
  processes therefore queried unchanged command state four times per second.
- Repair: committed Edge command status changes and output chunks publish on a
  second PostgreSQL notification channel handled by the same schema-filtered
  listener. Existing timeout reads remain a correctness fallback.

## 5. Audited hypotheses already rejected

- Approval/authorization is not checked only before waiting. The dispatcher
  re-reads Target status and scoped authorization immediately before ordinary
  execution and for both Artifact Transfer endpoints. Revocation during human
  review is therefore rejected at the physical boundary.
- Edge output sequencing is not an unfenced `MAX(sequence)+1` race. PostgreSQL
  locks the command row; SQLite serializes the writer transaction, and both
  require the current claim token.

## 6. Verification record

- `cargo test -p morphz`: passed. Library 786 passed / 6 manual visual tests
  ignored; CLI 21, attempt loop 60, CLI contract 4, Objective handoff 1, Plan
  infer handoff 4, RuntimeStore conformance 3 and terminal handoff 1 all passed.
- PostgreSQL RuntimeStore conformance was also run explicitly against the local
  PostgreSQL service with a fresh isolated schema: 1 passed, 0 failed.
- The real `postgres_multi_process_probe` passed with two operating-system
  worker processes: two workers ready, one model call, one reply, expired-lease
  crash recovery requeued, total elapsed 1.67 seconds.
- `cargo check --workspace --all-targets`: passed.
- `cargo clippy --workspace --all-targets -- -D warnings`: passed.
- `cargo fmt --all -- --check` and `git diff --check`: passed.
- Dashboard unit tests: 124 passed; lint and production build passed. The build
  retains only Vite's existing advisory for a JavaScript chunk over 500 kB.

## 7. Residual boundaries

- PostgreSQL `NOTIFY` is deliberately not scheduler authority: a connection can
  disconnect after a commit. Morphz therefore retains a 30-second bounded,
  indexed pending-Signal recovery scan. Normal committed work is event-driven;
  the interval affects only a lost-notification recovery window.
- SQLite remains the exclusive-process Runtime backend. It uses immediate
  in-process dispatch plus durable startup/runtime recovery; shared-worker
  low-latency scheduling is a PostgreSQL capability. SQLite's independent
  process tests cover fencing and CAS, not a supported multi-worker queue.
- Non-idempotent physical work whose process dies after the recorded
  side-effect boundary cannot be safely replayed or magically inferred. It is
  surfaced as explicit `lost`; reconciliation-required transfers use their
  dedicated projection repair path.
- PostgreSQL notification channels are database-scoped. Payload filtering by
  `current_schema()` prevents unrelated Morphz schemas from causing queue
  scans; notifications inside one schema may coalesce, which is safe because
  each wake runs a bounded query over durable state.
