# Objective approval ownership checkpoint

Status: native ownership handoff implemented; live Objective approval
suspension and hosted parking are **not yet enabled**. This is a prerequisite
of the complete Agent Cell delivery, not a substitute for its online gates.

## Invariants

An Objective Evaluation is logical ownership, not a process heartbeat. Once
every physical owner is safely checkpointed on human approval, the native
transaction may retire the Objective lease while retaining the exact
Evaluation ID, Objective generation, revision and continuation sequence.

`objective_approval_waits` records that handoff. The first parked sibling keeps
the shared lease if another owner is still running. The last parked owner
installs the checkpoint and cancels the Objective lease timer in the same
transaction as its Activation checkpoint. Other Objectives in the same Session
do not participate. No approval is granted, consumed or broadened.

Admission requires a running, unexpired Activation owned by the caller's real
claimant, its open/current Thread generation, the same Agent/Context/Session/
Principal and an immutable Event carrying that Evaluation route. An explicit
Objective Principal cannot be overridden by another Session participant. For
an Objective with no recorded initiating Principal, a directed user Activation
must prove its current, unrevoked Session Principal binding; a caller-supplied
Principal string alone is insufficient. PostgreSQL locks that binding against
concurrent unbind while deciding admission. A replacement
or competing pending dependency rejects admission. Only an existing matching
checkpoint may restore a lease after wall time has elapsed; an ordinary expired
Evaluation cannot be resurrected by this API. Late heartbeats cannot resurrect
an already parked lease either.

An ordinary dialogue may create its Objective in a tool prelude. Its binding
must come from a successful `objective_create` output of the exact immutable
assistant batch, not an arbitrary later output. A batch may not drop or replace
an Evaluation route already present in its immutable trigger. Unfinished nested
Plans and Groups retain the same Objective/Evaluation route.

An initial infer request can inherit a pending dependency from its parent's
persisted `runtime/tool_calls_selected` Event instead of a top-level field.
Native admission reuses `validate_plan_evaluation_activation_route` to verify
the Plan, child and parent Threads/Activations and the exact claimed Signal,
with no closed-generation Outcome exemption. Only then may it read the parent
selection at or before that immutable infer request. Selection scope, Principal,
Evaluation, dependency and start identity must agree; conflicting or excessive
selection evidence is rejected. This is the same graph authority used by the
Runtime, not an infer permission exception or model-specific rule.

The Scheduler read model distinguishes `suspended` from `runnable`: a retained
Evaluation with no physical lease is not an invitation to create another one.
Objective status, generation or Evaluation changes invalidate the checkpoint.
Terminal anchor recovery belongs to the Supervisor, not an Activation SQL
trigger that acquires Objective locks in reverse order.

## PostgreSQL contention

Ownership transitions serialize through the Objective row and then lock the
physical owner. Existing cancellation can hold Thread before Objective. The
checkpoint/admission transactions therefore use a transaction-local 100 ms
lock timeout and a nonblocking Thread row lock. SQLSTATE `55P03` becomes a
typed `ApprovalOwnershipContended` result after rollback, not a missing row,
permission denial or terminal tool failure.

Checkpoint contention replays the same immutable batch after a delay. Objective
admission retries in place with 25 ms exponential backoff capped at one second,
repeating all persisted authority checks. It does not return a running
Activation to `queued`, clear its route, release its Signal or publish a fake
outcome. Other database errors are not silently retried as contention.

## Exact user-answer admission

The wider regression run exposed a separate race in the exact-question reply
path: clearing the question dependency before claiming its Evaluation left a
runnable interval in which reconciliation could claim a successor and suppress
the user's answer. The reply now reserves its Evaluation through the existing
exact-dependency CAS first, then satisfies that question and clears its display
wait. It retains that same Evaluation and Activation, clears only the consumed
dependency fence, and releases its own claim if the subsequent transition loses
its CAS. Replaying the answer cannot claim another Evaluation. Unrelated
same-Session questions remain pending.

## Verification and remaining work

Native integration gates run only on synthetic temporary SQLite and a
loopback-only PostgreSQL 15 instance. Each PostgreSQL case uses a fresh database.
The directed tests cover two owners of one Evaluation, unrelated Objective
isolation, direct and creation-prelude binding, real elapsed lease time, denial
wakeup, stale claimant rejection, pause invalidation and unconsumed grants.

Lock-conflict tests hold Thread or Objective in a separate transaction, prove
both checkpoint and admission return without deadlock, prove rollback releases
the Objective lock, and compare unchanged claimant/revision/lease/approval
state before retrying successfully.

Final-source integration verification (2026-09-09): **37 distinct passing cases**
(12 SQLite checkpoint, 9 PostgreSQL, 5 real-process approval resume, 5 infer
handoff and 6 SQLite owner-cancellation). The five real-process cases cover
existing direct/Plan/infer waits, **not** enabled live Objective parking.

The new SQLite/PostgreSQL infer gate constructs an admitted Program, its Plan,
child Thread/Activation and exact claimed Signal using native APIs. It asserts
that the child trigger has no copied dependency field, so admission must verify
the parent's persisted selection. An incorrect dependency and stale claimant
fail without changing the physical lease or revision; the correct route is
accepted; a subsequent Objective pause rejects it.

The library filters `objective` (83), `plan` (52), `cancel` (34), `action_group`
(2), `activation` (35) and `recovery` (26) all pass; these filters overlap and
must not be added as a distinct-test count. They include real Runtime directed
interrupts that replace four cancelled children and preserve the wait through
nested Yao infer. The exact-question case also asserts one Evaluation and
idempotent answer replay, and passed 20 consecutive isolated reruns. Clippy
with `-D warnings`, the default-feature library build, Dashboard type checking
and formatting checks also pass.

Reproduce the non-PostgreSQL integration cases with:

```sh
cargo test -p morphz --features remote-store --test activation_approval_checkpoint
cargo test -p morphz --features remote-store --test approval_runtime_resume
cargo test -p morphz --features remote-store --test plan_infer_handoff
cargo test -p morphz --features remote-store --test plan_owner_cancellation
```

PostgreSQL cases are explicitly ignored by default. Run each `postgres_*` case
with `--ignored --exact` and `MORPHZ_TEST_POSTGRES_URL` pointing to a separate,
new disposable database. Do not point these fixtures at a user database. The
remote workerd case is a separate gate and was not included in this rerun.

The native Supervisor test also holds a Thread lock while admission retries,
compares the unchanged live Activation and local Evaluation binding, releases
the lock and verifies success. A second round pauses the Objective during
contention and verifies the retry rejects it instead of using stale authority.

Still required before enabling the live path: directed-input and dependency
replacement while an Objective is actually approval-checkpointed in a real
Runtime; late-prelude cold recovery, pause/resume and terminal-anchor recovery;
full Objective/infer ownership handoff across process exit. Hosted ingress,
Provider/Edge, actual Cloudflare parking and the other five deployment closures
remain separate acceptance requirements. No quiescence predicate is relaxed.

The fresh CLI check still reports an expired Cloudflare authorization that
cannot refresh noninteractively. No paid resources or production data were
changed for these gates. The approved architecture remains Cloudflare-only,
without KMS/Hyperdrive, with a total incremental test budget of USD 20.
