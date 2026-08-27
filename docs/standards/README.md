# Morphz Technical Standards

> Status: Draft standards workspace
>
> Steward: Newvar
>
> Canonical language: English
>
> Last updated: 2026-08-25
>
> 中文翻译：[zh-CN](zh-CN/README.md)

This directory contains the public technical foundation through which Morphz intends to define,
implement, and verify Structured Context, Agent Trajectory, Cognitive Applications, portable
Harness execution, Yao, and Mind Frame Exchange.

## Naming roles

- **Structured Context** is the implementation-neutral technical category.
- **Morphz Structured Context** is the Newvar-stewarded standards family defined here.
- **Agent Trajectory** is the portable, causally structured state-transition record of Agent
  experience; it is not a synonym for Event History, an observability Trace, or a chat transcript.
- **Mind Frame Exchange (MFX)** is the portable protocol boundary through which independent Agents
  exchange selected cognition without transferring identity or remote write authority.
- **Mind Frame Bundle** is the MFX exchange artifact for one Frame or a selected cognitive subgraph;
  receiving a Bundle does not make its content part of the receiver's Mind.
- **Cognitive Application** is the product- and ecosystem-level unit that packages reusable
  cognitive practice for an existing Agent; mounting one does not create or replace Agent identity.
- **Harness** is the portable Evaluation Loop and practice-contract abstraction defined by the
  Morphz Harness Specification.
- **HNS** is the `.hns` Harness Package distribution profile; **Yao** is its current source language.
- **COA** and `.coa` are reserved candidate names for a future Cognitive Application Package
  Profile above HNS. No current Draft defines that format or permits a `.coa` compatibility claim.
- **Morphz Runtime** is Newvar's official reference implementation, not the definition of the
  standard.
- **Morphz SC Compatible** is a reserved future compatibility mark whose use will require a
  published trademark policy and qualifying conformance evidence.

Independent implementations may satisfy the observable standard without copying Morphz Runtime
internals. This Draft intentionally retains Morphz in the standards-family name while keeping the
category and conformance semantics implementation-independent.

## Structured Context deliverables

1. [Structured Context Constitution v1](structured_context_constitution_v1.md)
   defines the stable principles that give the category its identity.
2. [Morphz Structured Context Specification v1](morphz_structured_context_specification_v1.md)
   defines the normative object model, authority boundaries, transactions, and observable
   semantics.
3. [Morphz Conformance Suite v1](morphz_conformance_suite_v1.md)
   defines how independent implementations demonstrate compatibility.

## Agent Trajectory deliverables

1. [Morphz Agent Trajectory Specification v0.1](morphz_agent_trajectory_specification_v0_1.md)
   defines the portable state-transition, causal, authority, Outcome, Verifier, Reward, data-rights,
   evaluation, and training semantics of Agent experience.
2. [Agent Trajectory Reference Implementation Verification v0.1](morphz_agent_trajectory_reference_implementation_verification_v0_1.md)
   maps Morphz export, validation, immutable Verifier/Reward facts, recovery, rights enforcement,
   and Training Episode derivation to executable evidence and reference JSON Schemas.

## Mind Frame Exchange deliverables

1. [Morphz Mind Frame Exchange Protocol v0.1](morphz_mind_frame_exchange_protocol_v0_1.md)
   defines the portable Bundle model, cross-authority identity and lineage, evidence closure,
   rights, offline interpretation, optional remote resolution, quarantine, and local adoption
   boundaries.
2. [Morphz Union Mind Federation Vision v1](../morphz_union_mind_federation_vision_v1.md)
   is a non-normative product vision for discovery, subscription, distributed cognitive
   activation, collective computation, and multi-authority collaboration above MFX.
3. [Morphz Cognitive Federation Architecture v1](../morphz_cognitive_federation_architecture_v1.md)
   is a non-normative conceptual architecture for Shared Mind Projection, Distributed Sparse
   Cognitive Activation, federated computation, collective deliberation, semantic settlement,
   state consensus, and Union-owned cognition. It creates no MFX-Core conformance requirement.

## Harness deliverables

1. [Morphz Harness Specification v0.1](morphz_harness_specification_v0_1.md)
   defines the portable execution semantics, control boundary, exact Binding, and lifecycle of a
   Harness.
2. [HNS Package Format Specification v0.1](hns_package_format_specification_v0_1.md)
   defines the `.hns` physical forms, logical artifacts, normalization, identity, and Loader
   behavior.

## Yao language deliverables

1. [Yao Core Language Specification v0.1](yao_core_language_specification_v0_1.md)
   defines the implementation-independent typed language, effects, structured concurrency, and
   Program Values.
2. [Yao Evaluation Semantics v0.1](yao_evaluation_semantics_v0_1.md)
   defines model-owned and Runtime-owned evaluation, durable lowering, recovery, and failure
   semantics.
3. [Yao Morphz Runtime Profile v0.1](yao_morphz_runtime_profile_v0_1.md)
   defines Morphz host objects, effects, capability settlement, lowering targets, and resource
   limits.
4. [Yao Reference Implementation Verification v0.1](yao_reference_implementation_verification_v0_1.md)
   maps Draft requirements to executable evidence and records the remaining implementation gaps.

[Project governance](../../GOVERNANCE.md) and
[MEP-0001](../meps/MEP-0001-specification-governance.md) define how all standards and the official
implementation evolve. The [IPR Status Notice](IPR_STATUS.md) records the provisional copyright,
patent, contribution, and trademark position while the documents remain Drafts.

## Authority order

For Structured Context, the normative hierarchy is defined by Constitution section 4. As a
non-normative index summary, conflicts are resolved in this order:

1. the Constitution;
2. the current Final Structured Context Specification;
3. the matching Conformance Suite, which may verify but cannot redefine the Specification;
4. accepted Standards Track MEPs only after incorporation into a versioned normative release;
5. Morphz Runtime, the official reference implementation;
6. explanatory design documents and examples.

For the Harness standards family, conflicts are resolved in this order until a Harness Constitution
or equivalent governance instrument is adopted:

1. the current Final Morphz Harness Specification;
2. the matching Final HNS Package Format Specification for `.hns` Package claims;
3. the matching Harness Conformance Suite, which may verify but cannot redefine either
   Specification;
4. accepted Standards Track MEPs only after incorporation into a versioned normative release;
5. Morphz Runtime, the official reference implementation;
6. explanatory architecture documents and examples.

For the Agent Trajectory standards family, conflicts are resolved in this order until a dedicated
Constitution or equivalent governance instrument is adopted:

1. the current Final Morphz Agent Trajectory Specification;
2. the matching Agent Trajectory Conformance Suite and Profile documents, which may verify but
   cannot redefine the Specification;
3. accepted Standards Track MEPs only after incorporation into a versioned normative release;
4. Morphz Runtime and its official exporter, as reference implementations;
5. explanatory architecture documents, datasets, and examples.

For the Mind Frame Exchange standards family, conflicts are resolved in this order until a
dedicated Constitution or equivalent governance instrument is adopted:

1. the current Final Morphz Mind Frame Exchange Protocol;
2. matching Final Profiles and the MFX Conformance Suite, which may verify but cannot redefine the
   Protocol;
3. accepted Standards Track MEPs only after incorporation into a versioned normative release;
4. Morphz Runtime and its official Exporter, Verifier, Importer, and Resolver, as reference
   implementations;
5. explanatory architecture and Union Mind Federation vision documents.

An MEP records and approves a change, but becomes normative only after the resulting requirement is
incorporated into a versioned Constitution or Specification release.

Until these documents leave Draft status, the source code, database contract tests, and the
[Runtime implementation status](../morphz_runtime_core_implementation_status_v1.md) remain the
authority for claims about what Morphz Runtime currently implements. They do not override the Draft
review target or turn implementation details into normative requirements. A Draft requirement is
not evidence that the implementation already satisfies it.

## Language and publication

The Draft standards use English as their canonical normative language because they are intended to
be globally consumable. Chinese translations and explanatory material are maintained separately.
Translations cannot silently change normative meaning; disagreements are resolved against the
identified English canonical document.

## Non-normative roadmap

The [Morphz Standards and Interoperability Roadmap v1](../roadmap/morphz_standards_and_interoperability_roadmap_v1.md)
describes the planned development of Agent Trajectory, Outcome and Verifier semantics, reference
environments, independent implementations, and extension interfaces. It creates no conformance
obligation and does not override the authority order in this directory.
