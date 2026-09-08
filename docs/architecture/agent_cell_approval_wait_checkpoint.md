# Agent Cell approval-wait checkpoint

Status: native Store boundary implemented; Orchestrator suspension and Cloud
parking integration remain incomplete. This document does not authorize
deploying the checkpoint path or relaxing the existing quiescence gate.

## Why a separate checkpoint is needed

A pending human Approval and a `waiting_approval` Job already survive restart.
That alone does not prove that their owning Activation can release its live
tool-execution stack. Marking that Activation succeeded would cause orphan-Job
recovery to cancel its unfinished work. Ignoring running Activations in the
Cloud sleep check would discard uncheckpointed model/physical work.

`ActivationStore::suspend_thread_activation_for_approval` records the explicit
boundary after the caller has joined every started sibling and persisted every
completed output. It is not an approval decision, grant, or terminal outcome.

## Atomic native boundary

SQLite and PostgreSQL validate, within the write transaction:

- the current Activation revision, claimant, unexpired lease and open Thread
  generation;
- the immutable assistant-call Event belongs to that Activation and Session;
- each pending tool call has an unclaimed `waiting_approval` Job and exact
  `pending_human` Approval;
- every other tool call has a durable output on the same causal route;
- no nonterminal sibling Job or unfinished Yao Plan is silently discarded.

The transaction writes `activation_approval_waits`, records the Approval/Job
revisions and assistant-call Event reference, requeues the same Activation,
clears its execution owner and lease, and cancels its activation-lease Timer.
It does not acknowledge its Thread Signals, finish the Thread, consume a
capability grant, or create replacement Jobs.

`activation_pending_approval_waits` is a derived read-only view. The Remote
Store captures its source rows and includes its DDL in the native schema hash;
the view itself has no mutable rows to journal.

## Admission and races

While all recorded dependencies are unchanged, the Activation is excluded
before every per-class admission LIMIT, from per-Session oldest-dialogue
selection, from the direct runnable probe, and from the final running CAS.
It remains live for ownership, recovery, cancellation and operator inspection.

Any one Approval or Job revision/status change makes it eligible again. No
process-local notification is required to establish readiness. In particular:

- a decision before checkpoint commit prevents the stale checkpoint;
- a decision after checkpoint commit makes the same queued Activation ready;
- deny/cancel are wakeups too, not indefinite waits;
- approving one sibling does not wait for every other approval;
- a later dialogue in the same Session can still run while the earlier turn
  waits for approval;
- grant consumption remains the existing atomic Job-claim operation.

The checkpoint references restrict individual dependency deletion. Deleting
one wait member via a foreign-key cascade could incorrectly shrink the wait
set and lose a wakeup. Claim or terminal Activation mutation removes the
checkpoint; deleting the owning Activation removes the whole set.

## Remaining integration gates

1. Physical preflight must return an explicit deferred-human result, drain
   already-started siblings, and call this boundary instead of awaiting an
   in-memory approval future.
2. Propagate a typed suspended outcome through the enclosing Activation
   handler. Release admission, EventBus dispatch and local cancellation owners
   without running success/error terminalization.
3. Resume using `get_thread_activation_approval_wait` before the running CAS,
   including Model Attempt IDs rather than assuming every call Event is named
   after the Activation. The getter is implemented; its caller is not yet wired.
4. Extend continuation checkpoints to nested Yao Plans and parent waits. The
   current Store method rejects unfinished Plans deliberately; this is an
   unimplemented gate, not a narrower definition of complete Cloud support.
5. Only after the above may quiescence recognize checkpointed owners and their
   exact Signals/Jobs/ActionGroups. In-flight model requests, physical commands,
   observers and uncheckpointed stacks must still prevent parking.
6. Verify actual host exit, human decision, wake, single physical execution,
   terminal Job/Thread, and empty-cache recovery through the real Cell gateway.

`morphz/tests/activation_approval_checkpoint.rs` exercises the native transaction
and admission contract against SQLite, disposable PostgreSQL, and the local
workerd Cell transport. Its cache-restore tests do not by themselves prove
whole-process safe parking or completion of the six Cloud deployment goals.

## Verified on 2026-09-08

Final gate: **11 passed, 0 failed, 0 ignored** using the independent native
worktree, an isolated local PostgreSQL 15 cluster with a fresh database, and
the existing real workerd conformance server. No external Provider requests
or paid cloud resources were used.

With `MORPHZ_TEST_POSTGRES_URL` and `MORPHZ_TEST_REMOTE_STORE_URL` pointing to
those disposable fixtures:

```sh
cargo test -p morphz --features remote-store \
  --test activation_approval_checkpoint --test remote_store_recovery \
  -- --include-ignored
```

- Six new conformance tests: decisions across reopen, twelve decision/checkpoint
  races, forty waits ahead of a one-slot admission window, earlier decisions
  and later Job/Thread cancellation, PostgreSQL parity, and two empty-cache
  Cell restores followed by exactly one grant claim.
- Five existing RemoteRuntimeStore gates: ambiguous/cancelled commit fencing,
  new Rust process recovery, full Runtime startup/delivery, credential refresh
  fencing, and owner renewal during a blocked operation spanning the lease.
- `cargo check -p morphz --features remote-store --lib`, formatting checks and
  `git diff --check` also passed.

The new test initially caught PostgreSQL's rejection of SQLite-style
`CREATE VIEW IF NOT EXISTS`; each backend now uses its proper DDL around the
same readiness SELECT. Final verification used a fresh PostgreSQL database,
not a manually repaired prior fixture.
