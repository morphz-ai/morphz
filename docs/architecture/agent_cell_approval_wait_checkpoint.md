# Agent Cell approval-wait checkpoint

Status: native Store boundary and direct tool-batch Orchestrator suspension
implemented; nested parent waits and Cloud parking integration remain incomplete.
This document does not authorize
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
- every other normalized continuation tool call has a durable output on the
  same causal route, including the Objective creation prelude; deduplicated
  raw provider calls are not fictitious unfinished siblings;
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
set and lose a wakeup. Terminal Activation mutation removes the checkpoint;
claim deliberately retains its exact assistant-call identity so a second crash
cannot lose a Model Attempt boundary. Re-suspension replaces the dependency
set; deleting the owning Activation removes the whole set.

## Direct batch execution

For direct batches using the built-in durable human reviewer, physical preflight
returns `DeferredHuman` without attaching an in-memory review future. Automatic
review still runs normally; escalation can reach the same deferred boundary.
Started siblings finish and persist their existing Job/output/ActionGroup facts.
The batch returns an explicit control outcome to its owning Activation handler.

Only after the evaluation future has returned does that handler commit the
checkpoint, outside its cancellation select. This prevents its own requeue from
being mistaken for lease/owner revocation. It releases the local admission,
dialogue gate, cancellation route and EventBus stack without committing a
success/error outcome or acknowledging the Thread's Signals.

A decision racing ahead of checkpoint validation is a typed dependency change,
not an execution failure. The same handler replays the exact persisted call.
Ordinary live decisions wake admission; startup recovers from the same durable
rows. Existing output IDs and grant-claim fences prevent sibling re-execution.

Custom callback reviewers still run their callback. Nested Plan, infer-child,
and active Objective Evaluation stacks are not covered by this direct-batch
boundary; they retain their existing live wait and continue to block parking.

## Remaining integration gates

1. Extend continuation checkpoints to nested Yao Plans and parent waits. The
   current Store method rejects unfinished Plans deliberately; this is an
   unimplemented gate, not a narrower definition of complete Cloud support.
2. Only after the above may quiescence recognize checkpointed owners and their
   exact Signals/Jobs/ActionGroups. In-flight model requests, physical commands,
   observers and uncheckpointed stacks must still prevent parking.
3. Verify actual host exit, human decision, wake, single physical execution,
   terminal Job/Thread, and empty-cache recovery through the real Cell gateway.

`morphz/tests/activation_approval_checkpoint.rs` exercises the native transaction
and admission contract against SQLite, disposable PostgreSQL, and the local
workerd Cell transport. Its cache-restore tests do not by themselves prove
whole-process safe parking or completion of the six Cloud deployment goals.

## Verified on 2026-09-08

Integration gate: **14 passed, 0 failed, 0 ignored** using the independent native
worktree, an isolated local PostgreSQL 15 cluster with a fresh database, and
the existing real workerd conformance server. No external Provider requests
or paid cloud resources were used.

With `MORPHZ_TEST_POSTGRES_URL` and `MORPHZ_TEST_REMOTE_STORE_URL` pointing to
those disposable fixtures:

```sh
cargo test -p morphz --features remote-store \
  --test activation_approval_checkpoint --test approval_runtime_resume \
  --test remote_store_recovery \
  -- --include-ignored --skip approval_runtime_child
```

- Eight Store conformance tests: decisions across reopen, twelve decision/checkpoint
  races, forty waits ahead of a one-slot admission window, earlier decisions
  and later Job/Thread cancellation, normalized Model Attempt identity across a
  second crash, every terminal status, PostgreSQL parity, and empty-cache Cell
  restores followed by exactly one grant claim and persisted checkpoint removal.
- One full Runtime test runs **three separate OS processes** with the default
  Rust thread stack (no `RUST_MIN_STACK` override). The initial process executes
  one permitted read and checkpoints two human approvals. After one durable
  approval, the second process executes that read without another model request
  and checkpoints the remaining approval. After denial, the third process
  delivers the complete batch and final reply. Completed Job records are
  unchanged; the denied read never starts; exactly three tool outputs exist;
  all three processes release their execution stacks before exiting.
- Five existing RemoteRuntimeStore gates: ambiguous/cancelled commit fencing,
  new Rust process recovery, full Runtime startup/delivery, credential refresh
  fencing, and owner renewal during a blocked operation spanning the lease.

The subprocess test caught two implementation defects before commit: an
oversized inline Evaluation future overflowed the default Tokio worker stack,
and checkpoint cleanup confused the public `Succeeded` spelling with the native
stored `completed` value. The inner future is now heap-pinned; both databases
use their stored terminal statuses. Success, failure and cancellation cleanup
are verified through the Store API, not by writing the expected SQL in a test.

The subprocess child is excluded from direct discovery because its parent
invokes it with stage-specific isolated fixture paths; it is executed three
times, not skipped as an unverified platform gate. This proves direct-batch
continuation, **not** nested Plan suspension or real Cloud compute parking.

Existing-behavior gate: **48 passed, 0 failed**, for **62 passing tests** overall:

- 45 approval-filtered library tests, including the otherwise opt-in disposable
  PostgreSQL Session-approval contract;
- the macOS Seatbelt execution-budget test, run separately outside the outer
  development sandbox so the operating system can apply its own sandbox;
- targeted Runtime cancellation of a checkpointed human wait and automatic
  reviewer failure handing the same Job to human review.

`cargo check -p morphz --features remote-store --lib`, targeted `rustfmt --check`,
and `git diff --check` also passed. The local PostgreSQL cluster and workerd
fixture are disposable; existing data and deployed services are not modified.
