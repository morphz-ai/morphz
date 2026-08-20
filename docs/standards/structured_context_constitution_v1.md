# Structured Context Constitution v1

> Status: Draft
>
> Steward: Newvar
>
> Reference implementation: Morphz
>
> Date: 2026-08-21
>
> Chinese translation: [zh-CN](zh-CN/structured_context_constitution_v1.md)

## 1. Purpose

The Constitution defines the identity of a structured context system. It is intentionally smaller
and more stable than the protocol specification. Implementations may differ in language, storage,
deployment, model provider, user interface, and internal optimization while preserving these
principles.

Morphz begins with the following proposition:

> Context is a first-class, persistent, versioned cognitive state that an Agent can explicitly
> inspect and transform. It is not merely a prompt assembled by a Runtime or an automatically
> compressed transcript.

## 2. Constitutional principles

### Article 1: Context is first-class state

A Context has a stable identity, an observable revision history, and a lifecycle independent of a
single model request or process. Restarting a Runtime or replacing a model MUST NOT silently create
a different cognitive identity.

### Article 2: The Agent owns cognitive meaning

The Agent decides what it currently believes, questions, plans, protects, revises, derives, or
retires. The Runtime MUST NOT silently assign semantic importance, manufacture conclusions, or
replace the Agent's Mind with an opaque summary.

The Mind remains schema-light. An implementation MAY provide templates and domain packages, but it
MUST NOT require a universal fixed ontology as the meaning of cognition.

### Article 3: The Runtime owns the reality boundary

The Runtime is authoritative for identities, permissions, event order, direct causality, resource
limits, transaction results, tool execution results, and control-state transitions. The Agent MAY
interpret these facts but MUST NOT be able to rewrite them as if they had occurred differently.

### Article 4: History and cognition are distinct

Event History records what happened. Mind records what the Agent is currently carrying forward.
Kernel records the Runtime's authoritative operating state. Inbox and Observation deliver facts for
the Agent to process. Removing an item from active attention MUST NOT retroactively erase the event
that produced it.

### Article 5: Cognitive change is explicit and transactional

Mutating the Mind or its attention state MUST occur through an explicit, validated transaction.
Transactions MUST either commit their declared changes atomically or leave the previous state
intact. Rejected or conflicted changes MUST be observable to the caller.

### Article 6: Provenance and causality survive transformation

Derived cognition MUST be able to retain stable references to its declared evidence. The Runtime
MUST preserve physical order and direct causal relationships; the Agent remains responsible for the
semantic strength of its conclusions.

### Article 7: Attention is not deletion

Retiring, swapping, excluding, compacting, or otherwise removing information from a model request
MUST have explicit semantics. Temporary absence from a prompt MUST NOT be represented as physical
deletion. Recoverable information MUST retain a stable path to recall or restoration.

### Article 8: Session, Agent, and Context are different identities

A Session is an interaction connection, not the cognitive identity itself. Multiple Sessions MAY
share one Context; an Agent MAY use multiple Contexts; a Context MAY be branched or delegated under
explicit rules. Implementations MUST NOT rely on "one chat equals one mind" as a hidden invariant.

### Article 9: Concurrency cannot weaken truthfulness

Concurrent work MAY improve throughput, but it MUST NOT silently overwrite committed cognition,
misroute a result, or expose evidence outside its authorized causal scope. Conflict detection,
fencing, and recovery are part of Context semantics rather than optional storage details.

### Article 10: Observable semantics are implementation-independent

An implementation claiming compatibility MUST satisfy the published specification and the
corresponding public conformance profile. Passing because it copies Morphz internals is not
required; producing the required observable behavior is.

### Article 11: Evolution is explicit

Changes to constitutional principles, normative protocol behavior, compatibility profiles, or
conformance claims MUST follow the public Morphz Enhancement Proposal process. A new implementation
detail does not automatically become part of the standard.

### Article 12: Authority must remain auditable

Newvar stewards the official standard, releases, and compatibility marks during the founder-led
stage. Decisions affecting the public standard MUST leave a durable proposal, rationale, and
compatibility record. Stewardship is final authority with visible responsibility, not undocumented
private mutation.

## 3. Constitutional boundary

The Constitution does not standardize:

- a specific model provider or model architecture;
- a fixed Mind schema or domain ontology;
- a storage engine, programming language, or transport protocol;
- a user interface or deployment topology;
- the commercial terms of hosted Morphz services;
- the quality of an Agent's reasoning merely because its Runtime is conformant.

Those concerns may be specified by lower-level profiles without changing the identity of Structured
Context.

## 4. Amendment rule

An amendment requires a dedicated Constitutional MEP. It MUST explain why an ordinary specification
change is insufficient, provide migration and ecosystem impact analysis, and be approved by the
Project Lead after review by the Core Maintainers. The amendment becomes effective only when merged
into a versioned Constitution release.
