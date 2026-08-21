# Morphz Agent Trajectory Reference Implementation Verification v0.1

> Status: Draft implementation evidence
>
> Steward: Newvar
>
> Last updated: 2026-08-21
>
> Chinese translation: [zh-CN](zh-CN/morphz_agent_trajectory_reference_implementation_verification_v0_1.md)

## 1. Purpose

This document records executable evidence for the Morphz reference implementation of the
[Agent Trajectory Specification v0.1](morphz_agent_trajectory_specification_v0_1.md). It is not a
conformance certificate. The Event Store remains authoritative; export, verification, Reward
interpretation, and Episode derivation never rewrite source execution facts.

The implementation closes one practical loop:

```text
authoritative Event History
  -> bounded Agent Trajectory export
  -> structural and integrity verification
  -> immutable Verifier Result
  -> separate immutable Reward Record
  -> permission-checked Training Episode
```

## 2. Implemented surfaces

| Surface | Reference implementation behavior | Evidence |
| --- | --- | --- |
| Deterministic export | Selects a bounded Context/Object/Activation scope through indexed Event queries; orders by sequence, time, and identity; emits stable Bundle identity | `exporter_preserves_causality_redacts_secrets_and_seals_integrity` |
| Causal projection | Emits typed edges for declared parent fields, preserves out-of-scope parents, and derives ordered Plan-effect edges | exporter and verifier tests in `trajectory::tests` |
| State boundaries | Projects Context before/after/snapshot revisions as stable State references and validates every Node-State reference | exporter and structural verifier tests |
| Disclosure and rights | Recursively redacts credential-shaped fields, redacts user content by default, records omissions, and denies training by default | exporter and permission tests |
| Integrity and untrusted input | Seals Bundles with a declared SHA-256 serialization digest; verifies identity uniqueness, cross-references, causal acyclicity, scope consistency, and digest without executing payloads | `verifier_rejects_tampering_and_causal_cycles` and cross-reference tests |
| Verifier Result | Commits a deterministic immutable Event only after each Evidence reference is found in the same Context; exact replay is idempotent | `trajectory_verifier_and_reward_facts_are_durable_idempotent_and_exportable` |
| Reward Record | Commits a separate deterministic interpretation whose sources must be existing Outcome, Verifier Result, or Reward Record facts in the same Context | Runtime integration test and training-loop test |
| Training Episode | Requires both the `AT-Training` Profile and explicit `rights.training=true`; emits explicit model-input, supervised-target, environment-output, and loss-mask roles | `verifier_reward_and_training_episode_form_a_permissioned_loop` |
| Administrative API | Exposes Bundle export/validation, fact commit, Episode derivation, and pure Episode validation through the Rust SDK | SDK compile and library tests |
| Operator interface | Exposes `trajectory export`, `trajectory verify`, and `trajectory episode` through the CLI | `trajectory_commands_preserve_scope_rights_and_input_file` |

The current reference JSON forms are described by:

- [Agent Trajectory Bundle schema](schema/morphz_agent_trajectory_bundle_v0_1.schema.json);
- [Training Episode schema](schema/morphz_training_episode_v0_1.schema.json).

## 3. Recovery and authority properties

- Verifier and Reward identities are content-derived. Repeating the same commit returns the
  existing Event; an identity occupied by different content is rejected.
- Verifier Evidence and Reward sources are resolved through Context-scoped Event queries before
  persistence.
- Reward Records never mutate Outcome or Verifier facts and cannot silently become source truth.
- Bundle verification is pure and never executes embedded payloads, follows external references,
  restores capabilities, or writes Runtime state.
- Episode derivation is refused when the Bundle lacks the Training Profile or explicit training
  permission.

## 4. Reproducible gates

The focused evidence can be reproduced with:

```text
cargo test -p morphz trajectory --lib --offline -- --nocapture
cargo test -p morphz typed_context_proposal_commits_once_and_recovers_the_commit_window --lib --offline
cargo test -p morphz objective_wait_proposal_uses_authority_and_replays_without_a_second_transition --lib --offline
cargo test -p morphz objective_completion_proposal_consumes_committed_outcome_and_replays_intent --lib --offline
cargo test -p morphz trajectory_verifier_and_reward_facts_are_durable_idempotent_and_exportable --lib --offline
```

Repository release gates additionally run the complete Yao and Morphz unit/integration suites,
format checks, Clippy, JSON parsing of the reference schemas, and `git diff --check`.

## 5. Current limits

- The exporter preserves external-parent declarations but does not recursively fetch an unbounded
  causal closure outside the requested selection.
- Context State is currently exported primarily by exact version reference and optional delta, not
  by automatically disclosing a complete Context snapshot.
- AT-Evaluation environment and model bindings are best-effort projections from represented facts;
  a deployment must declare unavailable bindings instead of overstating reproducibility.
- The current integrity Profile is a declared deterministic digest, not a canonical signature or
  proof that represented Outcomes are true.
- Dataset sharding, consent revocation workflows, trainer-specific adapters, independent
  implementation interoperability, and a normative conformance suite remain future work.

These limits keep the current claim narrow: Morphz provides a tested reference pipeline for
portable structured experience and permissioned Episode derivation, not complete Agent Trajectory
v0.1 conformance.
