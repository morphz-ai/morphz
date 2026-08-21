# Yao Morphz Runtime Profile v0.1

> Status: Draft
>
> Steward: Newvar
>
> Canonical language: English
>
> Last updated: 2026-08-21
>
> Chinese translation: [zh-CN](zh-CN/yao_morphz_runtime_profile_v0_1.md)

## 1. Purpose

This profile binds Yao Core to Morphz Runtime without exposing the scheduler as a language-owned
control plane. It defines stable host object kinds, immutable views, host effects, capability
settlement, lowering targets, and resource limits.

## 2. Boundary rule

An operation belongs in this profile when its correctness depends on Yao typing, causal identity,
transactionality, recovery, or Runtime authority settlement. A replaceable domain capability
belongs behind a Tool schema.

Yao programs may observe and request changes to semantic Runtime objects. They MUST NOT directly
mutate database rows, leases, revisions, queues, workers, scheduler jobs, thread activations, or
provider clients.

## 3. Host object kinds

The profile defines these opaque reference kinds:

```text
Agent Objective Evaluation Context Evidence Outcome
HarnessBinding CapabilitySet Principal ExecutionTarget Program
```

`Thread` MAY appear as a read-only causal/diagnostic reference. `Activation`, `ExecutionJob`,
`PlanExecution`, queue, lease, fence, and database record types are not language objects.

References are non-forgeable and serialize as tagged identities. Equality compares kind and stable
identity; source programs cannot construct references from strings.

## 4. Evaluation environment

At Program admission, Morphz provides a typed immutable `runtime` record:

```text
runtime.agent              Ref<Agent>
runtime.evaluation         Ref<Evaluation>
runtime.context            Ref<Context>
runtime.objective          Option<Ref<Objective>>
runtime.harness            Option<Ref<HarnessBinding>>
runtime.capabilities       Ref<CapabilitySet>
runtime.principal          Option<Ref<Principal>>
runtime.execution_target   Option<Ref<ExecutionTarget>>
```

Programs reference these values as `$runtime.context`, for example. The snapshot identity is bound
to the Evaluation. Reading it is pure. Fetching a newer or expanded host view is an explicit host
effect.

## 5. Immutable views

```lisp
(host.view REF (returns TYPE))
```

`host.view` requests a profile-defined immutable projection and has effect `(host view.KIND)`.
The Runtime validates that `TYPE` is an allowed projection for the reference kind and that the
Principal may observe it. A view contains semantic fields, not storage or scheduler internals.

The initial v0.1 projections are:

- `ObjectiveView`: id, stated objective, semantic status, wait condition summary, completion intent,
  revision, and verified progress summary;
- `EvaluationView`: id, owner, causal parent, start time, budget summary, and result contract;
- `ContextView`: id, Agent identity, active Mind projection identity, and authorized summary;
- `EvidenceView`: id, kind, content hash, producer, source, verification status, and references;
- `OutcomeView`: id, status, value/evidence references, verifier status, and causal producer;
- `HarnessBindingView`: package id, version, source artifact hash, and binding identity;
- `CapabilitySetView`: namespaced capability descriptions without secret material;
- `PrincipalView` and `ExecutionTargetView`: authorized identity and policy summaries.

## 6. Evidence and Outcome values

Yao constructs proposed semantic values before committing them:

```lisp
(evidence
  (kind "test-result")
  (value EXPR)
  (refs REF...))

(outcome
  (status succeeded|failed|blocked)
  (value EXPR)
  (evidence REF...))
```

These constructors are pure and produce typed candidate values. Persistence is explicit:

```lisp
(evidence.commit CANDIDATE)
(outcome.commit CANDIDATE)
```

The effects are `(host evidence.commit)` and `(host outcome.commit)`. The Runtime verifies route,
authority, evidence identity, completion contract, and immutable Event construction. A committed
result returns `Ref<Evidence>` or `Ref<Outcome>`.

The candidate types are sealed Runtime values. Source can construct them only with `evidence` and
`outcome`; `decode`, raw JSON, and tagged look-alikes cannot construct them. Before commit, Morphz
revalidates the complete transport shape and proves that every referenced Evidence is a Runtime-
committed Event in the same Context.

## 7. Objective effects

The initial Objective operations are:

```lisp
(objective.report
  (objective REF)
  (progress EXPR)
  (evidence REF...))

(objective.propose-wait
  (objective REF)
  (condition EXPR)
  (reason String))

(objective.propose-completion
  (objective REF)
  (outcome REF))
```

They have correspondingly namespaced host effects. They submit typed, revision-aware proposals to
the Objective authority. The Runtime decides whether to commit a transition. A program cannot set
Objective status or revision directly.

## 8. Context effects

The initial Context operation is:

```lisp
(context.propose TRANSACTION)
```

`TRANSACTION` will become a typed Context transaction value in the Structured Context profile. The
effect is `(host context.propose)`. In the current Draft implementation the argument is `Json` and
the operation returns an immutable proposal receipt; it does not directly mutate Context or Mind.
A later profile revision may define validation of protected Frames, conflict rules, transaction
budgets, and a narrower typed result.

## 9. Lowering

Morphz lowers effectful Yao HIR to the following durable authorities:

| Yao construct | Morphz authority |
| --- | --- |
| `call` | `ExecutionJob` or an equivalent mediated Tool completion |
| nested `infer` | child `Evaluation` / `ThreadActivation` |
| `par` | Plan Branch Group plus child `PlanExecution` continuations |
| `run` | child `PlanExecution` bound to a validated Program Value |
| `host.*` | typed Runtime command and immutable Event/transaction |
| terminal value | Plan Outcome |

The public Yao causal schema uses Program, Effect, Branch, Outcome, and Evidence terminology. Morphz
internal row names and scheduling strategies are not normative.

## 10. Capability settlement

Profile capabilities include:

```lisp
(tool TOOL)
infer
(host view.KIND)
(host evidence.commit)
(host outcome.commit)
(host objective.report)
(host objective.propose-wait)
(host objective.propose-completion)
(host context.propose)
(program EFFECT...)
```

`Program<T, E>` creation requires permission to receive a program with upper bound `E`; `run`
requires current permission for every inferred child effect. Secrets and raw provider credentials
are never values in a `CapabilitySetView`.

## 11. Resource profile

Morphz v0.1 publishes these default hard ceilings:

| Resource | Ceiling |
| --- | ---: |
| source bytes | 256 KiB |
| syntax nesting | 128 |
| semantic expression depth | 32 |
| typed HIR nodes | 4,096 |
| record or map fields | 256 |
| sequential `map` elements | 64 |
| Tool effects per root Program | 128 |
| nested inference effects | 8 |
| parallel branches per `par` | 32 |
| simultaneously scheduled branches | deployment-configured, at most 32 |
| Program Value nesting | 4 |

Deployments MAY lower ceilings. Raising them creates a different resource profile and MUST remain
finite.

## 12. Source and storage migration profile

Morphz `.hns` entries, `eval` Function Calls, and Program Value candidates MUST use the one typed
Yao source language and MUST NOT contain `(version ...)`. Existing Plan IR schema version 1 MAY
remain decodable until a documented migration removes it. That decoder is storage-only and MUST
NOT be reachable as a legacy source admission path.

## 13. Security requirements

Morphz MUST test and enforce:

- reference non-forgeability and Context/Agent route isolation;
- no authority gain through `requires`, `infer`, `par`, or Program Values;
- no secret exposure through host views, diagnostics, canonical encodings, or provenance;
- effect identity fencing and exact-parent resumption;
- revision checks for Objective and Context proposals;
- cancellation propagation and denial of stale Program Value authority;
- content-hash verification before Program Value execution;
- bounded decoding of adversarial model output.

## 14. Implementation status

As of 2026-08-21, the reference implementation includes the spanned parser, typed/effect-checked
HIR, pure evaluator, exact typed inference decoding, named records/unions and exhaustive `match`,
structured `par`, admitted Program Values with durable child Plans, and the injected `$runtime`
snapshot. Caller-local bindings do not enter generated Program children, and remaining Program
budgets are transferred without refill.

Morphz also persists replay-safe Host receipts, authorized immutable views, Evidence/Outcome
commits, and Objective/Context proposal records. Candidate transport is revalidated at the Host
boundary, referenced Evidence must be a same-Context Runtime commit, and Objective operations must
carry the current Objective Ref. These proposal operations currently record intent only: applying
Objective transitions and Context transactions remains owned by their existing authorities and is
not yet performed by Yao. ExecutionTarget view injection, cancellation propagation across all
child Plans, and a narrower typed Context transaction profile remain Draft work; this
implementation therefore does not yet claim complete v0.1 conformance.
