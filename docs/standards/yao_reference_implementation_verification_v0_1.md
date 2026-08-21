# Yao Reference Implementation Verification v0.1

> Status: Draft implementation evidence
>
> Steward: Newvar
>
> Last updated: 2026-08-21
>
> Chinese translation: [zh-CN](zh-CN/yao_reference_implementation_verification_v0_1.md)

## 1. Purpose

This document maps the Yao v0.1 Draft specifications to automated evidence in the Morphz reference
implementation. It is an implementation verification record, not a conformance certificate and
not a substitute for the normative specifications.

The test boundary deliberately includes more than successful examples. It exercises invalid and
adversarial source, static authority rejection, deterministic identity, serialization and resume,
partial parallel completion, failure aggregation, forged Host values, database migration, and
legacy-source rejection.

## 2. Automated evidence

| Requirement area | Principal automated evidence | Status |
| --- | --- | --- |
| UTF-8 syntax, precise spans, escapes, comments, malformed input, source and nesting limits | `yao::syntax::tests` | Passing |
| Parser robustness | 4,096 deterministic generated short inputs in `arbitrary_short_inputs_never_panic` | Passing |
| Canonical source and typed identity | `yao::canonical::tests` | Passing |
| Named records/unions, exhaustive `match`, collections, `Option`, `Result`, `Ref`, `Program` | `yao::sema::tests`, `yao::eval::tests` | Passing |
| Static effect inference, effect ceilings, Tool scope, Host effects, effect-normal form | `yao::sema::tests`, `sexpr_eval::tests` | Passing |
| Pure evaluation, checked decoding, overflow/failure paths, branch scope and deterministic `par` order | `yao::eval::tests`, `sexpr_eval::tests` | Passing |
| One unversioned typed source language and rejection of `(version ...)` | `typed_source_is_the_only_public_source_language_and_rejects_version_forms` and migration-only legacy fixtures | Passing |
| Exact type names and rejection of the historical lowercase `text` / `json` aliases | `rejects_historical_lowercase_type_aliases`, `rejects_unknown_and_recursive_named_types` | Passing |
| One shared model-visible Yao Language Card with a size budget | `language_card_is_parseable_bounded_and_unversioned`, Context protocol and `eval` Tool contract tests | Passing |
| Typed inference request/response, continuation serialization and exact resume | `sexpr_eval::tests`, `plan_execution::tests` | Passing |
| Durable infer starts with an empty Tool set unless the node explicitly declares a narrower set | `plan_infer_tool_scope_never_inherits_parent_tools_implicitly`, `infer_may_gather_evidence_but_is_never_offered_eval`, `plan_infer_handoff` | Passing |
| Durable `par` children, branch isolation, all-terminal barrier, ordered join, aggregate failure and restart | `typed_par_*` tests in `sexpr_eval` and `plan_execution` | Passing |
| Program Value exact-object transport, admission, canonical hash, effect/output bounds, caller-local isolation, durable child and shared depth budget | `program_admission_requires_object_transport_*`, `program_*`, `generated_program_*`, and `nested_program_*` tests | Passing |
| Typed Harness entry, quote-preserving canonicalization, explicit model Tool upper bound and actual Function Calling narrowing | `typed_program_string_identity_survives_package_normalization`, `model_owned_entry_requires_an_explicit_tool_upper_bound`, Harness and Orchestrator tests | Passing |
| Runtime environment injection and typed optional projections | `runtime_context_is_injected_*`, `host_view_normalizes_*` | Passing |
| Host receipt replay, candidate sealing, reference non-forgeability, same-Context Evidence and Objective authority | Host tests in `plan_execution::tests` and candidate tests in `yao::eval::tests` | Passing |
| SQLite Plan wait migration, indexes, terminal fence trigger and restart lifecycle | SQLite migration and `memory::sqlite::plan_execution::tests` | Passing |
| Production Runtime, CLI, durable handoff, store conformance, evaluation package and vector extension regressions | the package and integration gates listed below | Passing |

## 3. Reproducible gates

The 2026-08-21 verification run used:

```text
cargo test -p yao-lang --offline
cargo test -p morphz --lib --offline -- --test-threads=1
cargo test -p morphz --bin morphz --offline -- --test-threads=1
cargo test -p morphz --test attempt_loop --offline -- --test-threads=1
cargo test -p morphz --test cli_contract --offline -- --test-threads=1
cargo test -p morphz --test objective_group_handoff --offline -- --test-threads=1
cargo test -p morphz --test plan_infer_handoff --offline -- --test-threads=1
cargo test -p morphz --test runtime_stability --offline -- --test-threads=1
cargo test -p morphz --test runtime_store_conformance --offline -- --test-threads=1
cargo test -p morphz --test terminal_handoff --offline -- --test-threads=1
cargo test -p morphz-evals --lib --offline -- --test-threads=1
cargo test -p morphz-memory-vector --offline -- --test-threads=1
cargo clippy --workspace --all-targets --offline -- -D warnings
```

The language crate completed 36 tests. The focused Morphz evaluator, Plan and Harness suites
completed 44, 17 and 25 tests respectively. The gates above completed 1,147 tests with no
failures; six tests that explicitly require a live external login or manual terminal inspection
remained ignored by their existing declarations. The shared Language Card also passed its hard
4,800-character artifact limit and 1,200-estimated-token Context Encoding limit.

Tests that bind local mock servers or exercise Morphz's own macOS sandbox must run outside a
restrictive parent sandbox. Running them inside another sandbox fails at operating-system setup
with `Operation not permitted` before the test subject executes.

## 4. Draft gaps

The following normative targets do not yet have complete implementation evidence and therefore
remain Draft:

- parent cancellation propagation through every non-terminal `par` and Program child;
- applied Objective transitions and typed Context transactions after proposal recording;
- injected and authorized `ExecutionTargetView` behavior;
- live PostgreSQL crash-window testing for each new Yao wait boundary;
- persistent fuzzing of semantic decoding, canonicalization, and Program admission beyond the
  deterministic parser robustness corpus;
- interoperability with an independent Yao implementation.

No release may claim complete Yao v0.1 conformance while these gaps remain or without a separately
published conformance suite and versioned evidence bundle.
