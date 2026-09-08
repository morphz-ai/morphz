# Objective approval ownership checkpoint

Status: live Objective approval suspension is enabled in the isolated Runtime
worktree and verified across real local process exits. Hosted deployment is
**not yet accepted**. This is part of the complete Agent Cell delivery, not a
substitute for its remaining online and fault-injection gates.

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

Integration verification (2026-09-09): **44 distinct passing cases**
(12 SQLite checkpoint, 9 PostgreSQL, 11 real-process approval resume/control,
5 infer handoff and 7 SQLite owner-cancellation). The subprocess tests use
synthetic models and actual read tools, not real Provider calls.

The new Objective fixtures create the Objective through its real tool prelude,
then run direct, parallel Plan and infer batches through three separate Runtime
processes. One outside read is approved and the other denied. The exact
Evaluation, revision and continuation are retained; the completed sibling is
unchanged; an approved Job executes once; no denial executes. Both pause and
cancel cover all three shapes after process exit, followed by a third process
proving the stopped work does not revive. Jobs, Plans, Activations and approvals
are terminal, grants remain unconsumed, and the host has no live stacks.
An additional live infer case uses the real decision/wakeup API without restart.

These fixtures exposed and now cover four defects:

- Missing and JSON-null optional dependency IDs were incorrectly treated as
  distinct routes. Both mean no dependency; malformed or different IDs still
  fail validation.
- Infer replay adds two Runtime dispatch hints. Only the exact recovery
  Activation ID plus `runtime_force_evaluation=true` may differ from the saved
  payload. Every other field and the complete native Plan/Signal graph are
  still checked. Wrong owners, replaced routes and extra fields are rejected.
- Plan construction used Evaluation ownership as capability-lease scope,
  while dispatch used Thread supervision. Both now use the same persisted
  supervision resolver. A creation-prelude dialogue gains no extra lease
  authority, and immutable Job-request equality is unchanged.
- Cold Objective control could miss its process-local owners, then leave
  logical Plans behind even after Jobs closed. Control now reuses the
  Supervisor's exact persisted ownership lookup. SQLite/PostgreSQL cancel an
  Activation's unfinished Plans and Action Groups in its terminal transaction,
  retaining completed results and leaving other Activations in the same Thread
  untouched. PostgreSQL uses the same Thread-first enrollment lock order and
  migration `20260909_01_terminal_activation_owners` refreshes that function.
  Native tests cover stale CAS, both failed/cancelled owners and twelve real
  creation/cancellation races on each backend, without a Runtime reconciler.

Final-source library verification: **1331 passed / 8 explicitly ignored**.
The first restricted-host run passed 1322 and failed nine tests because the
outer host sandbox refused the tests' own `sandbox-exec` calls. The approved
host rerun passed all 1331 with the actual Seatbelt allow/deny checks retained;
the nine failures were not skipped or converted into permissive execution.
Clippy for the library and four integration targets passes with `-D warnings`.
The nine PostgreSQL cases used separate fresh databases in one disposable,
loopback-only PostgreSQL 15 cluster; it was stopped after verification.

The new SQLite/PostgreSQL infer gate constructs an admitted Program, its Plan,
child Thread/Activation and exact claimed Signal using native APIs. It asserts
that the child trigger has no copied dependency field, so admission must verify
the parent's persisted selection. An incorrect dependency and stale claimant
fail without changing the physical lease or revision; the correct route is
accepted; a subsequent Objective pause rejects it.

The prior-commit library filters `objective` (83), `plan` (52), `cancel` (34), `action_group`
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

### Interrupted Objective control recovery

The next native gate reproduced both pause and cancellation failures after
the control commit but before physical cancellation: the fresh Runtime left
the two pending approval Jobs alive and the five-second recovery assertion
failed. This was not a normal shutdown or a simulated approval decision.

Startup now checks the immutable assistant batch behind each parked approval
checkpoint before rebuilding admission or redispatching work. It reuses the
same successful creation-prelude binding proof and exact Evaluation-owner
cancellation path as live control. A revoked Evaluation is fenced and its
pending physical Jobs, logical Plans and approvals are closed. Valid parked
Evaluations are left waiting; no permission is granted or broadened. This
uses the existing store contract and adds no schema or compatibility layer.

Four new real-process tests cover pause/cancel at two persisted seams, each
with direct, parallel Plan and infer batches: immediately after the native
Objective state transition, and after Evaluation release but before physical
cancellation. The test process calls `exit` without running destructors only
after proving both approval Jobs are still pending. A fresh Runtime must close
them; another restart verifies idempotence. Completed siblings stay byte-for-
byte unchanged, denied/unapproved Jobs never start, grants remain unconsumed,
the Objective stays paused/cancelled with no old Evaluation, and no model is
called during recovery. All **15 process-level cases pass** (one separate
subprocess entry point is explicitly ignored and invoked by the tests).

The additional same-Objective replacement-Evaluation preservation fixture has
not been added or run: its write was interrupted by automatic permission-review
transport failure and timeout. Do not count that boundary as verified.

### Directed input across approval suspension

The real-process directed-input gate first reproduced an acknowledged but
unconsumed `@Objective` message. The creation-prelude owner and the Objective's
primary Thread have different roots. Claiming the latter during the former's
held Evaluation lost the routed Evaluation claim and suppressed the input.
`@Thread` stayed pending correctly. Preserving `@Objective` as pending alone
was insufficient: the resumed source did not hand off or notify the other root.

SQLite and PostgreSQL now keep that exact primary-Thread Signal pending while
its Objective has a live or approval-parked Evaluation. Genuine expired leases
remain recoverable, and unrelated Objectives in the same Session are unaffected.
An automatic continuation cannot overtake pending or claimed directed input.
Routed and automatic claims share the existing local Objective scheduling lock;
the native transaction remains authoritative.

At a model-safe boundary, the coordinator verifies its immutable user root,
current Evaluation and exact target supervision. A dialogue can already have
been promoted to Execution, so display kind alone is not ownership proof.
Attached/infer children must deliver their real result first. The coordinator
commits a Runtime `no_reply` handoff retaining the old Evaluation route, then
finalizes that Evaluation and notifies the target's existing Event. It does not
create another message, fabricate model output or cancel physical Jobs. The
source's durable terminal state, not its deliberately retained in-memory route,
decides whether the old model loop must stop. An unsettled Group can still defer
the terminal outcome. A pending exact Objective input also prevents an old
completion intent from completing the Objective during terminal commit.

The process-level gate passes for direct tools, a parallel Plan and nested
infer. It asserts pending input/no model calls before approval, one allowed read
and one rejected read, a genuinely claimed input visible in the model request,
unchanged completed siblings, no duplicate physical Job, terminal source/target
Threads, one durable routed handoff and no work revived on another restart.
The native gate passes on both SQLite and disposable PostgreSQL, including
expired leases and automatic-continuation priority before and after Signal
claim. These are synthetic local gates, not hosted acceptance.

Final directed-input source verification (2026-09-09): **1331 library cases
passed, 8 explicitly ignored; 43 local integration cases passed** (13 SQLite
checkpoint, 18 real-process resume/control/input, 5 infer handoff and 7 owner
cancellation). All **10 PostgreSQL cases passed** in separate disposable
databases, including the new directed-input ownership/priority contract. The
temporary PostgreSQL instance was stopped and its synthetic data removed.
The first unrestricted-concurrency library run failed three existing cases;
each passed with the same binary in isolation, and the complete final-source
run passed with `--test-threads=2`. No assertions, security checks or existing
test deadlines were relaxed to obtain that result.
Clippy for the library and all four integration targets passes with
`-D warnings`; the default-feature library build, formatting and diff checks
also pass.

Still required before hosted acceptance: dependency replacement while an
Objective is actually approval-checkpointed; pause/resume,
replacement-Evaluation preservation and terminal-anchor recovery. The directed
input gate above does not exhaust crash injection at every handoff instruction
or every concurrent terminal/input commit interleaving. The control-commit
crash seam is covered, but not every possible control/dependency replacement.
Hosted ingress,
Provider/Edge, actual Cloudflare parking and the other five deployment closures
remain separate acceptance requirements. No quiescence predicate is relaxed.

The fresh CLI check still reports an expired Cloudflare authorization that
cannot refresh noninteractively. No paid resources or production data were
changed for these gates. The approved architecture remains Cloudflare-only,
without KMS/Hyperdrive, with a total incremental test budget of USD 20.
