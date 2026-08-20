# Structured Context Constitution v1

> Status: Draft
>
> Steward: Newvar
>
> Reference implementation: Morphz Runtime
>
> Canonical language: English
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

## 2. Normative language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD
NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY**, and **OPTIONAL** in this document are to be
interpreted as described in BCP 14, [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119.html) and
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174.html), when, and only when, they appear in all
capitals.

## 3. Constitutional principles

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

Runtime ordering, recency, frequency, and resource usage establish physical facts. They do not by
themselves establish semantic truth or authority. A newer physical version alone does not justify a
broader conclusion.

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

### Article 8: Principal, Session, Agent, and Context are different identities

A Principal is an authenticated or authorized external actor or authority. A Session is an
interaction connection, not the cognitive identity itself. Multiple Sessions MAY share one Context;
an Agent MAY use multiple Contexts. Implementations MUST NOT rely on "one chat equals one mind" as a
hidden invariant, and MUST NOT substitute a Principal, Session, Agent, or Context identity for
another.

An implementation MAY support Context branching or delegation. When it does, each branch or
delegation MUST have explicit identity, provenance, authorization, and lifecycle semantics.
Branching and delegation are not required by SC-Core unless a later profile says otherwise.

### Article 9: Concurrency cannot weaken truthfulness

Concurrent work MAY improve throughput, but it MUST NOT silently overwrite committed cognition,
misroute a result, or expose evidence outside its authorized causal scope. Conflict detection,
fencing, and recovery are part of Context semantics rather than optional storage details.

### Article 10: Observable semantics are implementation-independent

An implementation claiming compatibility MUST satisfy the published specification and the
corresponding public conformance profile. Passing because it copies Morphz Runtime internals is not
required; producing the required observable behavior is.

### Article 11: Evolution is explicit

Changes to constitutional principles, normative protocol behavior, compatibility profiles, or
conformance claims MUST follow the public Morphz Enhancement Proposal process. A new implementation
detail does not automatically become part of the standard.

### Article 12: Authority must remain auditable

Decisions affecting normative semantics, compatibility, or authoritative interpretation MUST leave
a durable public proposal, rationale, and compatibility record. Stewardship is final authority with
visible responsibility, not undocumented private mutation. Organizational roles, release control,
and compatibility marks are defined in Governance rather than in this Constitution.

## 4. Normative hierarchy

When normative documents conflict, the following order controls:

1. the current version of this Constitution;
2. the current Final Morphz Structured Context Specification for the claimed version;
3. the matching Conformance Suite, which verifies but MUST NOT redefine the Specification;
4. accepted Standards Track MEPs only to the extent that they have been incorporated into a
   versioned Constitution or Specification release;
5. Morphz Runtime and other implementations, which provide evidence but do not define the standard;
6. explanatory documents, examples, and non-normative implementation notes.

Draft specifications and suites define review targets, not released compatibility obligations. A
test that cannot be traced to a controlling normative requirement MUST NOT create one by itself.

## 5. Constitutional boundary

The Constitution does not standardize:

- a specific model provider or model architecture;
- a fixed Mind schema or domain ontology;
- a storage engine, programming language, or transport protocol;
- a user interface or deployment topology;
- the commercial terms of hosted Morphz services;
- the quality of an Agent's reasoning merely because its Runtime is conformant.

Those concerns may be specified by lower-level profiles without changing the identity of Structured
Context.

## 6. Amendment and initial adoption

The initial Constitution, Governance document, MEP process, Draft Specification, and Draft
Conformance Suite MAY be adopted together through the bootstrap rule in MEP-0001. This exception
exists only to establish the process and MUST NOT be used for later amendments.

Every subsequent amendment requires a dedicated Constitutional MEP. It MUST explain why an ordinary
specification change is insufficient, provide migration and ecosystem impact analysis, and be
approved by the Project Lead after review by the Core Maintainers. The amendment becomes effective
only when merged into a versioned Constitution release.
