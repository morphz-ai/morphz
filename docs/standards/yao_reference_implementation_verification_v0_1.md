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
legacy compatibility.

## 2. Automated evidence

| Requirement area | Principal automated evidence | Status |
| --- | --- | --- |
| UTF-8 syntax, precise spans, escapes, comments, malformed input, source and nesting limits | `yao::syntax::tests` | Passing |
| Parser robustness | 4,096 deterministic generated short inputs in `arbitrary_short_inputs_never_panic` | Passing |
| Canonical source and typed identity | `yao::canonical::tests` | Passing |
| Named records/unions, exhaustive `match`, collections, `Option`, `Result`, `Ref`, `Program` | `yao::sema::tests`, `yao::eval::tests` | Passing |
| Static effect inference, effect ceilings, Tool scope, Host effects, effect-normal form | `yao::sema::tests`, `sexpr_eval::tests` | Passing |
| Pure evaluation, checked decoding, overflow/failure paths, branch scope and deterministic `par` order | `yao::eval::tests`, `sexpr_eval::tests` | Passing |
| Explicit typed-v0.1 admission and legacy source compatibility | `explicit_root_version_is_the_only_typed_compatibility_boundary` and legacy evaluator corpus | Passing |
| Typed inference request/response, continuation serialization and exact resume | `sexpr_eval::tests`, `plan_execution::tests` | Passing |
| Durable `par` children, branch isolation, all-terminal barrier, ordered join, aggregate failure and restart | `typed_par_*` tests in `sexpr_eval` and `plan_execution` | Passing |
| Program Value admission, canonical hash, effect/output bounds, caller-local isolation, durable child and shared depth budget | `program_*`, `generated_program_*`, and `nested_program_*` tests | Passing |
| Runtime environment injection and typed optional projections | `runtime_context_is_injected_*`, `host_view_normalizes_*` | Passing |
| Host receipt replay, candidate sealing, reference non-forgeability, same-Context Evidence and Objective authority | Host tests in `plan_execution::tests` and candidate tests in `yao::eval::tests` | Passing |
| SQLite Plan wait migration, indexes, terminal fence trigger and restart lifecycle | SQLite migration and `memory::sqlite::plan_execution::tests` | Passing |
| Regression against the complete Morphz workspace | `cargo test --workspace` | Passing |

## 3. Reproducible gates

The 2026-08-21 verification run used:

```text
cargo test -p yao-lang
cargo test -p morphz sexpr_eval::tests --lib
cargo test -p morphz plan_execution::tests --lib
cargo test -p morphz plan_execution_program_wait_migration_preserves_rows_indexes_and_fence_trigger --lib
cargo clippy -p yao-lang --all-targets -- -D warnings
cargo clippy -p morphz --all-targets -- -D warnings
cargo clippy -p morphz-evals --all-targets -- -D warnings
cargo test --workspace
```

The language crate completed 33 tests. The focused Morphz evaluator and Plan suites completed 44
and 17 tests respectively. The complete workspace completed 1,172 tests with no failures; six
tests that explicitly require a live external login or manual terminal inspection remained
ignored by their existing declarations.

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
