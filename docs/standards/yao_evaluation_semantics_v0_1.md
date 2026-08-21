# Yao Evaluation Semantics v0.1

> Status: Draft
>
> Steward: Newvar
>
> Canonical language: English
>
> Last updated: 2026-08-21
>
> Chinese translation: [zh-CN](zh-CN/yao_evaluation_semantics_v0_1.md)

## 1. Scope

This specification defines how one Yao language is evaluated by a model and a Runtime without
merging their authority. It also defines lowering, suspension, persistence, resumption, failure,
parallel join, and Program Value execution semantics.

Syntax and typing come from the
[Yao Core Language Specification](yao_core_language_specification_v0_1.md). Host operations come
from a Runtime profile.

## 2. Two evaluators, one language

Yao has two evaluation owners:

| Root | Evaluation Loop owner | Semantic role |
| --- | --- | --- |
| `eval` | Runtime | Deterministic control, durable effects, typed data flow |
| `infer` | model | Open semantic judgment under Runtime-mediated authority |

Both owners consume and produce Yao values. Ownership determines who selects the next semantic
step; it does not change the meaning of values, effects, capabilities, causal identity, or terminal
Outcome.

The Runtime Control Loop always owns admission, capability settlement, physical execution,
persistence, recovery, approval, cancellation, budgets, and delivery.

## 3. Compilation pipeline

A conforming implementation MUST separate these stages:

```text
UTF-8 source
  -> spanned concrete syntax
  -> resolved AST
  -> typed HIR with inferred effects
  -> validated Program
  -> pure evaluator and/or Runtime Plan IR
```

Source syntax MUST NOT be reparsed at an effect-resume boundary. Durable state records the
validated representation, machine continuation, lexical environment, budgets, pending causal
identity, and terminal state.

Pure subexpressions MAY be constant-folded only when doing so preserves failures, source
diagnostics, canonical identity, and effect ordering.

## 4. Deterministic evaluation order

Outside `par`, evaluation is left-to-right. Argument expressions are fully evaluated before an
effect request. `seq`, short-circuit boolean operators, `if`, `match`, and `fallback` use the order
defined by Yao Core.

The deterministic machine advances without I/O until it:

1. reaches a terminal value;
2. reaches a classified failure;
3. reaches an effect boundary and emits a typed Effect Request; or
4. reaches a structured parallel boundary and emits a typed Branch Group Request.

The machine MUST NOT directly execute a Tool, call a model provider, mutate a host object, or start
an untracked task.

## 5. Effect hand-off

Every emitted Effect Request has a stable identity derived from the parent Plan identity and a
monotonic effect sequence. The Runtime MUST atomically persist the parent waiting state and the
child authority, or provide behavior observationally equivalent under crash and replay.

Replaying a persisted waiting machine yields the same Effect Request identity. A completion may
resume only the exact pending identity and effect kind. Duplicate exact completions are
idempotent; stale or foreign completions are rejected.

Authorization is checked both at Program admission and at hand-off. The latter is authoritative.

## 6. Nested inference

An `eval`-owned nested `infer` creates a causally linked model-owned Evaluation. The request
contains the fully evaluated typed arguments, result contract, effective evidence-tool ceiling,
parent Program identity, and producing source span.

Only a terminal child Outcome may resume the parent. The Runtime decodes it into the declared Yao
type. Invalid decoding is a classified inference failure and may be handled by `fallback`.

Provider reasoning text, partial output, or an unverified self-claim MUST NOT be used as the typed
terminal value.

## 7. Structured parallel execution

### 7.1 Branch creation

Lowering `par` creates one durable Branch Group and one child branch continuation per source
branch. The Branch Group identity is derived from the parent Plan identity and the `par` effect
sequence. Branch identity additionally includes the normalized branch name.

Creation of the parent wait, Branch Group, and child branch authorities MUST be atomic or
recoverably idempotent from one durable intent. A crash MUST NOT leave an admitted branch invisible
to the join.

### 7.2 Scheduling and isolation

Each branch receives an immutable snapshot of the lexical environment. Branch machines have
independent continuation stacks, budgets, pending effects, and terminal states. The Runtime may
schedule them in any physical order and may restrict simultaneous work.

Source order is semantic only for result construction and canonical identity. It does not impose
a happens-before relationship between branches.

### 7.3 Join

The parent waits until every branch is terminal. Successful results are assembled in source order.
If any branch failed, the parent receives one classified parallel failure containing every branch
name, status, failure classification, and available successful result reference.

Cancellation is propagated from parent to non-terminal branches. A failure in one branch does not
erase already admitted siblings and does not pretend their external effects were rolled back.

### 7.4 Restart equivalence

After any durable boundary, a different worker MUST be able to reconstruct the Branch Group and
produce the same join value or failure. Tests MUST inject restarts before group creation, after
partial creation, while children wait, after one child completes, after all complete but before
join, and after parent resumption.

## 8. Program Value admission and execution

Model output intended as a Program Value enters a quarantined candidate state. It has no executable
authority. Admission performs the complete Yao Core Program Value pipeline and records:

- canonical validated representation and content hash;
- original source and spans as provenance;
- producer Evaluation, Attempt, model route, and terminal Event identity;
- declared and inferred output/effect contracts;
- effective capability ceiling at creation;
- validation version and diagnostics.

`run` creates a durable child Plan linked to the Program Value hash. Current capabilities are
recomputed and intersected with the stored ceiling. Revoked authority is not restored by a
previously validated Program Value.

The parent waits on the child Plan terminal state. The child cannot access caller bindings, mutate
the parent machine, or extend aggregate budgets. It receives only the immutable host environment
explicitly permitted by the Runtime profile. Nested Program execution consumes a profile limit.
The Morphz v0.1 budget policy transfers the remaining aggregate budget to the child and does not
refund unused child budget after join; this conservative rule is stable across restarts.

## 9. Host effect receipts

A Host effect is a durable authority boundary. Before returning its result to deterministic
evaluation, the Runtime MUST persist an immutable receipt keyed by the parent Plan identity and
effect sequence. The receipt binds the exact operation, fully evaluated arguments, normalized
typed result, route, and causal identities.

If a worker crashes after the Host operation is committed but before the parent checkpoint, replay
MUST return the stored result. Reusing the same receipt identity with different operation or
arguments is an integrity failure. Operations that create proposals or immutable objects MUST NOT
be submitted a second time during such replay.

## 10. Failure classes

A Runtime MUST distinguish at least:

| Class | Examples | Catchable by `fallback` |
| --- | --- | --- |
| `value` | decode error, division by zero, missing field | yes |
| `inference` | invalid typed result, provider terminal failure | yes |
| `tool` | Tool-declared failure | yes, subject to Tool policy |
| `parallel` | one or more joined branch failures | yes |
| `resource` | dynamic collection or child-work limit | yes unless integrity is threatened |
| `cancelled` | Principal or supervisor cancellation | no |
| `authority` | revoked capability, invalid lease | no |
| `integrity` | hash mismatch, foreign completion, corrupt state | no |
| `admission` | syntax, type, effect, or capability rejection before execution | not applicable |

Failures MUST preserve causal identity and source span where available. A Runtime MUST NOT convert
an integrity or authority failure into ordinary program data.

## 11. Budgets

Budgets are hierarchical. A parent Program supplies ceilings to nested inference, parallel
branches, and Program Values. Child work consumes the aggregate parent budget even when physical
execution is concurrent. Restart restores the last durable remaining budget; it does not refill
it.

At minimum, implementations MUST account for Tool effects, inference effects, branch count,
typed-IR steps, Program Value nesting, and elapsed/deadline policy.

## 12. Observability

Every effect, branch, Program Value admission, sub-plan, resume, failure, and terminal Outcome MUST
be attributable to:

- Agent and Context;
- parent Evaluation and Plan;
- Objective when present;
- source artifact and canonical Program hash;
- source span or generated provenance;
- Principal and effective capability decision;
- stable causal parent and effect/branch sequence.

Internal scheduler implementation details MAY remain private. Observable causal semantics MUST be
portable.

## 13. Compatibility execution

Legacy untyped Yao accepted by the reference implementation is compiled into typed HIR using
`String` literals, `Json` Tool results, explicit legacy truthiness, and the existing sequential map
limit. Its persisted Plan IR remains readable across the migration. Newly typed constructs MUST
use this specification even when invoked from a legacy-compatible Harness.

## 14. Conformance test matrix

The reference conformance suite MUST include:

1. golden parser/diagnostic and canonical-encoding fixtures;
2. table-driven type/effect acceptance and rejection;
3. pure evaluator property tests and differential tests against lowered execution;
4. mock Tool/model tests for each effect and failure class;
5. deterministic serialization/resume tests at every machine frame;
6. SQLite and PostgreSQL crash-window tests for single effects, Branch Groups, and sub-plans;
7. fuzzing for parser, decoder, canonicalizer, and Program Value admission;
8. legacy Harness corpus tests;
9. resource-limit and adversarial model-output tests;
10. end-to-end tests proving the same observable result before and after worker replacement.
