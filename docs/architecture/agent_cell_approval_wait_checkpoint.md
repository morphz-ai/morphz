# Agent Cell approval-wait checkpoint

Status: native Store boundary, direct tool-batch suspension and nested physical
Plan approval suspension, infer-child tool batches and infer-parent approval dependencies implemented. Objective-owned waits and
real Cloud parking integration remain incomplete. Native parent-wait verification
is described below; it is not a deployed Cloud completion claim.
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
- each unfinished Yao Plan is reachable from an `eval` in that exact batch,
  through deterministic parallel branches, a Program child or a verified infer
  dependency, and every live leaf reaches supplied pending-human Approval/Job dependencies;
- no nonterminal sibling Job or unreachable unfinished Plan is discarded.

The transaction writes `activation_approval_waits` and, for nested continuations,
`activation_approval_plan_waits` and `activation_approval_infer_waits`. It records Approval/Job and Plan/parallel-Group
revisions, statuses and the assistant-call Event reference, requeues the same Activation,
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

Any one Approval, Job, enrolled Plan or parallel Group revision/status change
makes it eligible again. Newly enrolled unfinished Plans or Jobs outside the
checkpoint also invalidate the wait. No
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

Custom callback reviewers still run their callback and block parking until it
returns. An infer child's own physical tool batch can checkpoint through the
same boundary. A parent waiting only on checkpointed infer children and/or its
own human approvals can release its stack after those children release theirs.
Active Objective Evaluation waits retain their live stacks; they are not made
eligible for whole-host parking by this change.

## Native infer-parent dependency checkpoint

Each infer edge references the **current checkpointed child Activation**, its
revision, logical Thread revision/generation and the parent's immutable
assistant-call Event. The child's initial Activation can already be completed:
the original infer Event/Signal/Activation still proves its Plan identity, while
the current continuation proves the actual wait. Matching IDs or a model-supplied
route alone are insufficient. Validation reuses the native infer route contract
and compares the reconstructed pending Program request with the durable Event.

The child must be the sole nonterminal Activation in its open, active Thread,
with no new pending Signal. Its own checkpoint must remain blocked in the same
native readiness view. Parent-owned Jobs remain parent-owned; this never copies
foreign approvals into the parent's capability scope. An infer-only parent may
have zero direct approvals. Extra, duplicate or unrelated child IDs are rejected.

The shared SQLite/PostgreSQL view computes invalid leaves then recursively
propagates invalidation to ancestors. A changed approval, Job, Plan, Group,
child Activation or Thread, a new child continuation, or new pending input wakes
the original parent. One deepest decision invalidates every ancestor **before**
any child process runs; it does not wait for all leaves. Terminal owner cleanup
removes all three checkpoint tables. PostgreSQL adds migration
`20260908_05_infer_parent_approval_waits`; SQLite installs the same schema/view.

PostgreSQL retains the owner/Group/Plan/Job lock order and does not acquire
descendant row locks in reverse order. Child revisions are sampled under the
transaction; concurrent changes invalidate that exact saved edge, even if they
commit after it was sampled. Cancellation/generation changes are a typed
dependency change, so the caller replays rather than publishing a tool failure.

The strengthened real-process cancellation regression exposed an additional
gap: child cancellation made a saved parent runnable and recovery requeued its
Plan, but no local permit changed to notify admission. Durable scheduler events,
Thread controls and successful Plan recovery now request the existing coalesced
queue rescan. This hint neither admits work nor bypasses database readiness. It
retains a notification across startup; it does not add a database polling loop.

Final-source integration verification: **31 distinct tests passed**: ten SQLite
checkpoint cases, five real-process Runtime cases, five infer handoff cases,
six SQLite owner-cancellation cases and five PostgreSQL cases. Each final PG
case used a fresh database in the same disposable loopback-only cluster; no
production/Supabase connection was used. Native infer cases include three-level
dependencies, successor Activations, duplicate/unrelated IDs, cancellation,
pause, new Activations/input and sixteen decision/cancellation races per backend.

The five Runtime cases passed **ten consecutive rounds / 120 subprocess
lifetimes** on the final source. Both parent and child are queued without a
claimant/lease before process exit; partial allow/deny keeps both original
assistant-call identities and never repeats completed reads. Live approval and
post-restart child cancellation resume the original parent with one EventBus
handler and one Activation slot. This replaces the earlier b5cbcc6d fixture's
assertion that the uncheckpointed parent must prevent process quiescence.

No hosted quiescence predicate has been relaxed. Active Objective waits, actual
Cell parking/wake integration and deployed Provider/Edge flows remain required.

Library filters `plan`, `cancel`, `action_group`, `activation`, and `recovery`
passed 52/34/2/35/26 tests respectively: **134 distinct tests after de-duplication**,
or **165 distinct passing tests** including the integrations above. The new
notification test proves retained/coalesced wake hints do not admit an Activation.
The `approval_runtime_resume` suite requires `--features remote-store`; a default
build reports zero cases and is not evidence for this gate.

`cargo clippy -p morphz --features remote-store --lib -- -D warnings`, default
`cargo check -p morphz`, formatting and diff checks passed. All test PostgreSQL
clusters were stopped and their synthetic data removed. No production instance,
main worktree, actual Provider or cloud compute resource was changed. The latest
Cloudflare CLI probe still reports expired authentication; Ubuntu SSH still times
out. Neither external condition is evidence that the full Cloud goal is complete.

## Nested physical Plan execution

A physical Plan leaf returns a distinct `DeferredPlanApproval` control outcome.
It is propagated before ordinary tool-error normalization, without inventing a
tool result or completing the Plan. A waiting parallel or Program parent uses
the shared graph validator to probe its durable human frontier and waits for
all descendant runner registrations to release before returning the same
control outcome. Each Plan releases its admission wait explicitly. The outer
immutable assistant batch then uses the existing atomic checkpoint transaction.
The probe is deliberately non-atomic and conservative; only that transaction
can requeue the owning Activation after checking every exact revision.

Recovery scans converge durable Plan/Group facts, but do not launch child
execution. Only a live parent, with its owning Activation route restored, may
start children. Starting them as soon as admission exists is too early: on
restart it can bypass durable physical preflight and attach a process-local
approval callback before the causal route is restored. A background launch
could also race a parent that has already joined its children for suspension.
The parent checks the registry on every resume, so a concurrent approval
decision can restart a deferred child without a stale local "already spawned"
set stranding it.

Plan parallel joins have their own immutable `runtime/plan_parallel_request`
intent and branch-result protocol. Ordinary assistant-batch recovery validates
that intent's exact group identity and route and leaves it to the Plan
coordinator. It does not guess ownership from an ID prefix or report a valid
Plan join as a malformed assistant call.

## Remaining integration gates

1. Extend the Plan-frontier checkpoint to active Objective-owned waits, retaining
   their Evaluation lease and objective transaction boundaries correctly.
   Unsupported wait forms remain rejected by the Store. These are required
   integration gates, not a narrower definition of complete Cloud support.
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

### Infer child checkpoint and recovery dispatch

The native process fixture covers an infer child with one completed read and
two human-approval reads. Before this extension it stopped at the first human
callback: the child retained its stack and never recorded a batch checkpoint.
Allowing the child to use the existing checkpoint then exposed a second defect:
on restart its queued Activation was dispatched behind the still-waiting
parent's sole EventBus handler, despite a free Activation admission slot.

Activation recovery now selects the existing dedicated child-handoff channel
from the matching durable Thread's `executor_kind` and nonempty parent Plan
identity. It verifies the root, Agent, Context, Session and Principal route;
neither an Event type, ID prefix nor model-supplied payload flag selects it.
This applies to startup, live queue refill and lease-expiry recovery. It changes
only the EventBus handler channel, not the child's own bounded Activation
admission, Thread gate, permission checks, persistence or de-duplication.

The b5cbcc6d infer fixture performed actual host exits before an allow and a later deny.
Each child re-checkpoint uses the same assistant-call Event, already completed
reads stay unchanged, and the typed infer value reaches the original parent.
That earlier version also asserted the distinction that matters for safe Cloud parking: the child
is queued with no claimant or lease, but the uncheckpointed parent still makes
`hosted_process_is_quiescent()` false. No ownership rows are manually expired or
rewritten to make recovery pass. This is a native crash-recovery gate, **not**
proof that the parent can park or that the real Cell gateway is integrated.

Separate cases exercise live approval decisions while the parent remains in
the sole EventBus handler, and cancellation of the checkpointed child after
restart. Cancellation closes the unstarted Jobs and child's checkpoint, does
not re-evaluate the child model, and refills the parent's failed infer outcome.
The five process cases passed ten consecutive rounds (120 child-process
lifetimes) without increasing the default native thread stack.

That b5cbcc6d source passed 149 distinct targeted tests: 133 library tests across
`plan`, `cancel`, `action_group`, `activation` and `recovery` (de-duplicated),
plus 16 integration tests across `approval_runtime_resume`, `plan_infer_handoff`
and the SQLite cases of `plan_owner_cancellation`. The subprocess entrypoint
was excluded from direct invocation; the two PostgreSQL owner tests remained
ignored in this run. No database schema, hosted quiescence predicate, EventBus
global limit or physical permission policy was changed.
Default-feature `cargo check -p morphz`, formatting and diff checks passed.

### Native Runtime nested-stack gate

The three-OS-process `approval_runtime_resume` fixture now covers both direct
tools and an outer batch containing a completed read plus a parallel `eval`.
The fixture uses one Activation slot and one EventBus slot. It proves:

- initial two-approval wait reaches the unchanged process-quiescence check;
- after that process exits, one allowed read executes in the next process;
- the partial batch re-checkpoints the **same assistant-call Event** without a
  model request and without replaying the completed sibling;
- after a second exit, denying the remaining read produces its rejected,
  `executed=false` result, closes the branch/parent/group, and resumes the model;
- the denied file is never read, the allowed grant is consumed once, and only
  the original three physical Jobs exist after completion.

Both cases passed **20 consecutive paired runs** with the default native Rust
thread stack (120 actual child-process lifetimes). No `RUST_MIN_STACK` override
is used. An intermediate implementation reproduced a default-stack overflow in
direct recovery; physical preflight, persisted Plan ownership inspection and
Plan-internal tool execution now cross explicit heap Future boundaries instead
of expanding the outer execution state machine's inline layout.

The callback-negative Runtime fixture retains its two live custom callbacks
and blocks quiescence until they decide. The built-in-reviewer fixture releases
all parent/child stacks; repeated Plan scans do not recreate them. Cancellation
closes the same durable Plans, Groups and unstarted Jobs. A separate intent
classification test rejects mismatched Plan join identity/routes rather than
silently treating malformed Groups as another recovery protocol.

These are native Runtime and disposable database tests. They do **not** establish
real Cell-gateway safe parking, observer transport or remote-cache restoration,
nor completion of the overall Cloud deployment goal.

The final source revision passed **119 distinct tests**: 86 library tests
(`plan`, `cancel`, `action_group`, removing the one overlap) and 33 integration
tests across `activation_approval_checkpoint`, `approval_runtime_resume`,
`plan_infer_handoff`, `plan_owner_cancellation`, and `runtime_store_conformance`.
PostgreSQL tests used a fresh isolated loopback PostgreSQL 15 database, not a
hosted pooler or Supabase. The two actual remote/workerd tests and the approval
subprocess entrypoint were explicitly excluded. Default-feature `cargo check`,
formatting and diff checks passed separately. No production data was migrated.

### Native nested frontier gate (subsequent extension)

`activation_approval_checkpoint` now passes **11 tests** on SQLite and a fresh,
isolated PostgreSQL 15 database (the workerd cache-restore test excluded).
The new fixtures use the real Yao parser, PlanMachine and Plan coordinator,
with a mixed outer batch, serial reads and parallel branches including a
completed constant branch. They verify:

- rejection of unstarted Plans, incomplete wait sets and invalid claimant;
- identical waits after closing/reopening SQLite;
- sixteen concurrent nested leaf decision/checkpoint races, eight per backend;
- wake on Plan cancellation, Group revision change and late Plan/Job enrollment;
- dependency foreign keys and checkpoint cleanup when the owning Thread closes;
- cancelled physical Jobs refill their branch Plans, settle the parallel Group
  once, and fail the parent without duplicate results on replay, on both stores.

This gate exposed a PostgreSQL-only parallel enrollment defect: the ActionGroup
referenced a deterministic request Event ID without persisting the Event. The
coordinator now persists the actual immutable `runtime/plan_parallel_request`
control intent before enrolling the Group. Its ID, payload and timestamp remain
stable across a reclaimed Plan. No physical effect or Thread Signal is emitted
by recording the intent. PostgreSQL foreign keys remain enforced.

The new PostgreSQL migration runs after Plan/Activation schema creation and
before admission function installation. No production storage was migrated.

The final regression run passed **116 distinct tests**: 84 library tests
(`plan`, `cancel`, `action_group`, with one overlap removed) and 32 integration
tests from `activation_approval_checkpoint`, `approval_runtime_resume`,
`plan_infer_handoff`, `plan_owner_cancellation`, and `runtime_store_conformance`.
Both PostgreSQL conformance tests used the disposable loopback database, not
Supabase or a hosted pooler. At that earlier Store-only gate, the three-process
approval test covered only the direct batch; nested Runtime stack coverage is
documented above. The two
workerd/remote-restore tests and the subprocess entrypoint were explicitly
excluded. Default-feature `cargo check` is verified separately.

### Earlier direct-batch / transport gate

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

## Nested Plan prerequisite: one live child runner per Plan

The parent execution loop and durable reconciliation both start child Plans.
Before process-local registration, repeated recovery passes could create more
live execution stacks for an already waiting child. A real Runtime regression
with one parent and two parallel branches waiting for human approval observed
**five suspended Plan stacks instead of three**. Existing Job preflight
serialization still preserved two approvals and two unstarted Jobs; this was
not evidence of duplicate physical execution or an approval bypass.

`PlanChildRunners` now registers each durable child Plan ID before spawning.
Concurrent recovery passes reuse the existing runner; unrelated child IDs run
independently. An owned guard releases registration before waking reconciliation
on completion, failure, panic, task abortion, or an unpolled future being dropped.
The registry does not replace durable Plan claims, fencing, or cancellation
semantics. It is rebuilt naturally after process restart.

The supplemental hosted-process quiescence check also requires zero registered
child runners. The durable Store's existing blockers are unchanged. This only
tightens the parking boundary; it does not make nested waits safe to suspend.

Five new regressions cover 32 concurrent registrations, independent Plan IDs,
unpolled/aborted/panicking task cleanup, and actual parallel Runtime approvals
under eight repeated reconciliation passes. Successful approval produces two
completed Jobs and three completed Plans with no model retry. Session
cancellation releases both child stacks and human waiters, leaves both Jobs
cancelled without starting their effects, and does not make another model call.
At this stage the cancellation regression checked stack cleanup only. The
owner-cancellation follow-up below adds durable parent/child terminal assertions.

This prerequisite's verification ran **60 distinct tests, all passing**: 49
Plan-filtered library tests (including the five new regressions), six SQLite
approval-checkpoint tests, the three-process approval-resume test, and four
Plan/infer handoff regressions:

```sh
cargo test -p morphz --features remote-store --lib plan
cargo test -p morphz --features remote-store \
  --test plan_infer_handoff --test approval_runtime_resume \
  --test activation_approval_checkpoint
```

The PostgreSQL and workerd conformance tests were not rerun for this
process-local-only change; those two tests remain explicitly ignored without
their isolated fixtures. The subprocess helper is again invoked by its parent.
No external model requests, cloud resources, or production data were used.

## Owner cancellation and late results

The stronger Runtime regression reproduced a separate defect: immediately after
Session cancellation returned, both child Plans still waited for Execution Jobs
and the parent still waited for their ActionGroup. Stopping the execution stacks
alone did not close these durable owners.

Both native stores now close nonterminal Plans and running ActionGroups in the
same transaction as explicit Thread cancellation. The affected set is the exact
Thread and its cancelled Activation generation, not every Thread in the Session.
Plan revisions advance, claim/lease and pending-child fields are cleared, and a
terminal timestamp/reason is stored. Already-terminal Plans and completed
results are unchanged. This does not depend on a later reconciliation pass.

New Plan and ActionGroup enrollment takes the same owner lock as cancellation
and requires a matching live Thread/Activation generation. Thus creation either
commits before cancellation and is closed by it, or cannot create a late orphan.
Replaying an existing causal identity still returns the existing record; it
does not reopen it. No schema migration or existing-data rewrite is introduced.

Cancelling an ActionGroup ends its join, but does not invent member results.
Already-issued tools may still return: their immutable result Events and member
counts are recorded, while the Group remains `cancelled`. No settled Event or
new wake Signal is emitted. An already-settled Group remains settled. PostgreSQL
member-result commits use the same Thread-before-Group lock order as cancellation
because direct wake publication also locks the Thread. Physical and infer child
creation take the owner before the Plan; infer reconciliation takes the child
Thread and parent Thread before their Plan/Activation rows, matching terminal
child handoff. This avoids acquiring an owner foreign-key lock while holding a
row that cancellation needs.

`morphz/tests/plan_owner_cancellation.rs` exercises the native contract without
a running Runtime: queued/running Plans and all four wait kinds, stale claims,
reopen, same-Session sibling isolation, exact replay, and creation/cancellation
races. ActionGroup cases cover partial and late results plus concurrent final
settlement versus cancellation. The actual parallel Runtime regression also
requires all three Plans to be cancelled and every owned batch to be terminal.

This is not proof of nested approval checkpointing, cancellation propagation to
separate infer Threads, or actual hosted compute exit/wake. Physical Job
cancellation still uses its existing mechanism; these changes do not declare a
running physical command stopped, nor relax any hosted quiescence blockers.

### Owner-cancellation verification

The final native run passed **25 integration tests** with SQLite and a disposable
loopback PostgreSQL 15 database:

```sh
cargo test -p morphz --features remote-store \
  --test activation_approval_checkpoint --test approval_runtime_resume \
  --test plan_infer_handoff --test plan_owner_cancellation \
  --test runtime_store_conformance \
  -- --include-ignored --skip approval_runtime_child \
  --skip remote_approval_checkpoint_survives_two_empty_cache_restores \
  --skip remote_runtime_store_satisfies_operational_conformance_and_restores
```

The six owner-cancellation tests include 120 paired creation, settlement,
physical handoff, and infer-reconciliation/cancellation races across the two
databases. Infer race assertions initially established lock-order convergence;
the follow-up below additionally requires a valid historical route after child
cancellation. The Runtime approval gate again executes its three subprocess stages.

Library filters `plan`, `cancel`, and `action_group` passed 49, 34, and 2 tests,
respectively (84 distinct tests after their single overlap). Default-feature
`cargo check -p morphz --lib`, targeted `rustfmt --check`, and `git diff --check`
also passed. An initial command inadvertently selected two opt-in workerd tests
without their required fixture URL; both failed at fixture validation, before
any transport call. The final command explicitly excludes them. This native
change has **not** revalidated workerd restore or actual Cloud parking.

## Consuming a cancelled infer

A subsequent deterministic regression reproduced a distinct recovery failure:
Thread cancellation advances its execution generation, but parent Plan refill
validated the child Signal against that new live generation. A cancelled child
therefore produced `PlanExecution route is inconsistent with deterministic infer
Signal`, leaving its parent waiting.

Historical result consumption now uses the cancellation Outcome read in the
same native transaction as the route. It must match the exact child Thread,
root, Session, terminal kind, result Event reference and Activation generation;
that closed generation must immediately precede the Thread's revoked generation.
The original infer Event, Signal, Activation and parent route are still checked.
Live Objective admission passes no Outcome and cannot use this closed-generation
path. No record is reopened and no generation fence is removed.

The logical Thread outcome also takes precedence over an earlier successful
Activation: success of the initial model/tool step does not turn a later Thread
cancellation into a successful infer string. Reconciliation refills the same
Plan effect with the terminal failure and preserves idempotent replay.

Native SQLite/PostgreSQL tests reconstruct the coordinator after cancellation,
cover cancellation before and after completion of the first Activation, reject
a cancelled projection without its durable Outcome, and prove the child remains
cancelled. A real Runtime test blocks the synthetic child model, cancels it using
the public API, verifies parent completion and the child future's destruction,
and requires exactly three model calls (parent, child, parent continuation).
Both EventBus and Activation concurrency limits are one. No external Provider
or physical tool is used.

This closes consumption of an already-materialized cancelled infer, **not**
parent-to-child recursive cancellation or pre-materialization cancellation.
Nested approval checkpoints and real Cloud compute parking remain required.

Verification: the same five integration suites above now pass **28 tests**,
including the three new cancellation/refill gates. The strengthened child-cancel
race must return a valid historical route, not an accepted generation error.
The 49/34/2 library filters again pass (84 distinct tests), as do default-feature
`cargo check`, formatting and diff checks: **112 distinct passing tests**.
The PostgreSQL full run used a fresh database. Reusing the prior temporary
database had accumulated 72 queued synthetic Activations, exceeding an approval
test's global 32-row admission window; the test then failed to find its new row.
Fresh-fixture verification passed without changing production code or loosening
that assertion. workerd and deployed Cloud compute were not exercised here.
