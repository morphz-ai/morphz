# Morphz Harness Specification v0.1

> Status: Draft specification candidate
>
> Steward: Newvar
>
> Reference implementation: Morphz Runtime
>
> Canonical language: English
>
> Source baseline: Morphz Runtime and `.hns` loader as of 2026-08-21
>
> Date: 2026-08-21
>
> Chinese translation: [zh-CN](zh-CN/morphz_harness_specification_v0_1.md)
>
> Package format: [HNS Package Format Specification v0.1](hns_package_format_specification_v0_1.md)

## 1. Scope

This specification defines the portable execution semantics, authority boundaries, lifecycle, and
observable behavior of a Morphz Harness.

A Harness is a versioned cognitive program and practice contract mounted into one Evaluation. It
may replace the Runtime's default Evaluation Loop, but it does not replace the Runtime Control
Loop. A Harness can determine how an Evaluation reasons, calls tools, gathers evidence, verifies
results, and reaches an outcome. The Runtime remains authoritative for identity, scheduling,
transactions, permissions, physical effects, causality, durability, and recovery.

A Harness is the execution core through which a Cognitive Application can govern an Evaluation.
Cognitive Application is the product- and ecosystem-level unit that packages reusable cognitive
practice for an existing Agent. The terms are not synonyms: an Application may include additional
resources and integrations, while a Harness remains the bounded execution-semantic unit.

This specification defines Harness semantics independently from one source language or filesystem
layout. The companion HNS Package Format Specification defines the portable `.hns` distribution
profile. Yao is the source language used by that profile; it is not a synonym for Harness.

## 2. Normative language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD
NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY**, and **OPTIONAL** in this document are to be
interpreted as described in BCP 14, [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119.html) and
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174.html), when, and only when, they appear in all
capitals.

Examples, rationale, implementation notes, and implementation-status statements are non-normative
unless explicitly identified otherwise.

## 3. Core terms

### 3.1 Runtime Control Loop

The Runtime Control Loop is the system-owned lifecycle that authenticates requests, establishes
authority, creates and schedules work, persists state, executes physical effects, handles waiting,
and recovers interrupted execution.

### 3.2 Evaluation Loop

The Evaluation Loop is the bounded cognitive procedure used within one Evaluation to select the
next reasoning or execution step, incorporate results, determine whether more work is required,
and produce an Outcome.

### 3.3 Harness

A Harness is a portable semantic unit that supplies:

- one explicit Evaluation entry program;
- a stable practice Contract;
- declared capability requirements;
- optional read-only default cognitive material;
- optional evidence, outcome, verifier, and Skill semantics.

A Harness MAY replace the default Evaluation Loop. It MUST remain subordinate to the Runtime
Control Loop.

### 3.4 Harness Package

A Harness Package is an immutable, content-addressable distribution artifact containing the
material needed to identify, validate, bind, and execute a Harness. An installable portable Harness
Package conforming to this Draft uses the `.hns` profile defined by the companion format
specification.

### 3.5 Harness Installation

A Harness Installation is the admission of one exact Package into a Runtime catalog. Installation
MUST NOT activate the Harness or grant its requested capabilities.

### 3.6 Harness Binding

A Harness Binding is an immutable reference from one Evaluation to an exact Package identity. It
MUST contain, or address without ambiguity:

- Harness identifier;
- declared Harness version;
- content or artifact hash;
- Evaluation identity;
- optional Objective-default provenance.

### 3.7 Contract

A Contract is the stable, model-visible description of the domain objects, capabilities, evidence
semantics, and practice constraints supplied by the Harness. It is versioned package content and is
not Agent-authored Mind.

### 3.8 Entry Program and Evaluation Owner

An Entry Program is the single primary executable root selected by a Harness Binding. Its
Evaluation Owner is explicit:

- **Runtime-owned**: deterministic plan structure retains control and may delegate bounded
  inference steps to a model;
- **model-owned**: the model retains control of the Evaluation Loop while all tool effects remain
  mediated by the Runtime.

### 3.9 Default Mind

Default Mind is optional read-only cognitive material supplied by a Harness for a bound Evaluation.
It does not become persistent Agent Mind merely because the Harness is installed or mounted.

### 3.10 Outcome and Verifier

An Outcome is the terminal result claimed by an Evaluation. A Verifier is a declared procedure or
external authority capable of checking a stated property of that Outcome against identified
evidence. A Verifier result is evidence; it does not silently rewrite Agent belief.

### 3.11 Cognitive Application

A Cognitive Application is an independently identifiable and versioned product- and ecosystem-level
unit that packages reusable cognitive practice for a stable Agent. It is realized through at least
one Harness and MAY additionally include Skills, Verifiers, default cognitive material, interfaces,
domain resources, evaluation assets, and integrations when corresponding Profiles define them.

A Cognitive Application is not an Agent, Session, Harness, HNS Package, or external SDK client.
Installing, selecting, or binding one MUST NOT implicitly create, replace, clone, or merge Agent
identity. Installation alone grants no Runtime capability or execution authority.

Harness Core v0.1 standardizes one Primary Harness Binding per Evaluation. It does not yet define a
complete Cognitive Application Manifest, multi-Harness composition, user interface, marketplace,
commercial policy, or Cognitive Application conformance claim. One HNS Package MAY realize the
execution content of a minimal Cognitive Application without making the two terms equivalent.

The candidate name **COA** and suffix `.coa` are reserved for a future Cognitive Application
Package Profile above HNS. Such a Profile may define an Application Manifest that references one
or more exact HNS Package identities and packages application-level Skills, Verifiers, interfaces,
evaluation assets, domain resources, and integrations. This reservation does not define a format,
require Runtime support, or establish a compatibility claim in Harness Core v0.1.

## 4. Control and authority boundary

The following separation is normative:

| Concern | Harness authority | Runtime authority |
| --- | --- | --- |
| Evaluation reasoning and step selection | define within the bound program | invoke, suspend, resume, and bound |
| Contract and domain practice | declare | validate, mount, and identify |
| Tool requirement | request and narrow | authorize and enforce |
| Physical side effect | request | schedule, execute, record, and fence |
| Context or Mind mutation | propose through an allowed transaction | validate, commit, reject, and audit |
| Objective lifecycle | inform through an Outcome | create, transition, supervise, and recover |
| Event identity, order, and direct cause | interpret | establish and preserve |
| Recovery | provide resumable program structure | persist and resume without duplicating effects |

A conforming Harness MUST NOT:

1. create a private scheduler that bypasses the Runtime work model;
2. execute a physical Tool directly outside Runtime authorization and effect recording;
3. widen a Principal, deployment, target, sandbox, or Evaluation capability;
4. mutate Kernel state or persistent Mind except through an authorized Runtime operation;
5. treat a declared validator as proof that validation occurred;
6. replace an exact bound Package with another Package during the same Evaluation;
7. convert an unverified inference into a Runtime fact.

An implementation MAY internally optimize pure nodes. Such optimization MUST NOT change observable
authority, causal, failure, or recovery behavior.

## 5. Harness lifecycle

A portable lifecycle consists of:

```text
Package acquisition
  -> parse and structural validation
  -> content identity computation
  -> installation and admission
  -> exact selection
  -> Evaluation Binding
  -> Contract and default material mount
  -> entry execution
  -> Outcome or classified failure
  -> durable audit and optional verification
```

### 5.1 Installation and registration

A Runtime MUST validate Package structure before registration. Registration of the same Harness ID
and version with the same content identity MAY be idempotent. Registration of the same Harness ID
and version with different content MUST fail visibly.

Installation MUST NOT:

- start an Evaluation;
- import Default Mind into persistent Agent Mind;
- grant a Tool, network, filesystem, target, or secret capability;
- silently select the Package for future work.

### 5.2 Selection and binding

Every Harness-governed Evaluation MUST materialize an exact Evaluation Binding before Harness
content can influence execution. Floating references such as `latest` MUST NOT be stored as the
authoritative binding of a durable Evaluation.

An Objective MAY carry an exact Package reference as a default. The Objective default is not the
authoritative execution binding: each concrete Evaluation MUST materialize its own immutable
Binding, including provenance when it inherited the default.

Harness Core v0.1 permits at most one Primary Harness per Evaluation. Policy overlays, composition
graphs, and multiple Primary Harnesses are outside this Draft.

### 5.3 Mounting

After binding, the Runtime MUST make the exact Contract and Entry Program available to the
Evaluation. Optional Default Mind MUST be mounted read-only and scoped to the bound Evaluation.

If an implementation permits explicit import of Default Mind into persistent Agent Mind, that
import MUST be a separate authorized and auditable operation. It SHOULD preserve Harness ID,
version, content identity, and source provenance.

### 5.4 Termination

Termination MUST produce an observable terminal state, classified failure, wait state, or Runtime
transition. A Harness MUST NOT claim completion merely because its program returned syntactically.
The meaning and verification status of the Outcome MUST remain distinguishable.

## 6. Evaluation execution model

### 6.1 Explicit ownership

The Entry Program MUST declare whether its root is Runtime-owned or model-owned. Ownership MUST NOT
be inferred from incidental syntax or changed by wrapping the same operation in a sequence.

The HNS profile expresses this rule with explicit `(eval ...)` and `(infer ...)` roots.

### 6.2 Runtime-owned entry

A Runtime-owned entry MAY contain deterministic sequencing, binding, branching, bounded mapping,
fallback, Tool requests, and child inference requests.

When it reaches a physical effect, wait, approval, or child inference boundary, the Runtime MUST:

1. validate current authority and fencing state;
2. persist the child work and parent wait state atomically, or provide equivalent behavior;
3. release execution ownership while waiting;
4. route the durable result to the creating causal scope;
5. resume from the recorded program position without repeating completed non-idempotent effects.

### 6.3 Model-owned entry

A model-owned entry delegates step selection to the model. It MUST still use Runtime-mediated Tool,
Context, permission, budget, and delivery operations. Model ownership of the Evaluation Loop does
not grant ownership of the Runtime Control Loop.

A model-owned Entry Program MUST explicitly declare `(requires (tools ...))`. The declared set is
the complete model-visible Tool upper bound for that Evaluation after intersection with Package,
Principal, deployment, and Runtime policy. `(requires (tools))` declares pure inference with no
model-callable evidence Tool. Omission MUST be rejected rather than interpreted as inheritance or
unrestricted access.

### 6.4 Nested inference

A Runtime-owned program MAY create a bounded child inference. The child MUST have explicit causal
identity and an effective capability scope no wider than its parent. Only its declared terminal
result or classified failure may satisfy the parent wait; intermediate reasoning MUST NOT be
misrepresented as the terminal result.

### 6.5 Open-ended work

A Harness Entry Program describes one Evaluation. Open-ended semantic progress across an unknown
number of attempts SHOULD be represented by a Runtime-owned Objective or equivalent durable
supervisory construct. A Harness extension that adds loops or recursion MUST define resource,
recovery, and effect-idempotency limits and MUST NOT create an unobservable scheduler.

## 7. Capabilities and effects

A Harness declaration expresses requirements and restrictions, never authority. Effective
capabilities MUST be no wider than the intersection of:

```text
deployment and Runtime policy
intersect Principal authority
intersect Execution Target and sandbox policy
intersect Package declaration
intersect Entry Program declaration
intersect Evaluation or child capability lease
```

Missing required capabilities MUST produce an observable admission or execution failure. A Runtime
MUST NOT silently substitute a more privileged Tool.

Every external effect MUST be represented by a stable Runtime work identity or equivalent
idempotency and audit boundary. Retrying or recovering an Evaluation MUST NOT duplicate a completed
non-idempotent effect.

## 8. Context, state, and learning

Harness-owned temporary state MUST be namespaced and attributable to the exact Binding. Durable
Runtime state MUST remain outside the Package artifact.

A Harness MAY propose Context or Mind changes through authorized operations. The Runtime MUST
preserve the distinction between:

- immutable Package Contract;
- Evaluation-scoped Default Mind;
- Agent-authored persistent Mind;
- Runtime-owned facts and execution state.

Learning from Harness use is not implicit. Installing, binding, or completing a Harness MUST NOT by
itself overwrite persistent Agent cognition. Any retained learning MUST be an explicit transaction
with source or evidence references appropriate to the claimed semantics.

## 9. Evidence, Outcome, and verification

A Harness MAY define domain evidence types and expected verifier interfaces. It MUST preserve the
source, scope, and version needed to interpret an evidence item.

An Outcome SHOULD identify:

- the claim or delivered result;
- the Evaluation and exact Harness Binding;
- supporting evidence references;
- verification status and Verifier identity when verification occurred;
- unresolved limitations or classified failure.

A declared Verifier MUST execute through a Runtime-managed trust boundary. Untrusted validation
code MUST NOT be loaded as unrestricted native code into the Runtime process. A Verifier result MUST
record what was checked and against which input, environment, or revision.

This Draft does not define a universal reward function. Implementations MAY derive training or
evaluation signals from Outcomes and Verifier results, but MUST NOT describe an unverified Harness
completion signal as ground truth.

## 10. Failure and recovery

Failures MUST be classified sufficiently to distinguish at least:

- invalid Package or incompatible version;
- denied or missing capability;
- invalid Entry Program;
- model inference failure;
- Tool or target failure;
- verification failure;
- budget or resource exhaustion;
- stale execution or fencing rejection;
- Runtime internal failure.

For a durable profile, a restart MUST preserve the exact Binding and either resume from committed
state or expose a terminal failure. It MUST NOT silently restart from the Package root after partial
external effects unless all repeated effects are proven idempotent.

## 11. Compatibility and versioning

Harness specification versions, Package versions, the out-of-band Yao specification/IR revisions,
and Runtime versions are distinct. Yao source itself has no in-band version declaration.

- A Package version identifies publisher-declared Harness evolution.
- A content hash identifies exact Package content.
- A Harness specification version identifies portable semantics.
- A Yao specification or persisted IR revision identifies parsing or lowering behavior without
  becoming a source form.

An implementation MUST NOT infer content identity from a semantic version alone. An incompatible
Package MUST fail before its Entry Program produces an effect.

Patch, minor, and major interpretation of Package versions is publisher policy until a later MEP
defines a required version scheme. A Runtime SHOULD expose its supported Harness and HNS profiles
to installers and tooling.

## 12. Conformance profiles

This Draft reserves the following profiles:

- **Harness Core**: exact Binding, explicit Evaluation ownership, Contract mounting, capability
  narrowing, Runtime-mediated effects, and classified failure;
- **Harness Durable**: Harness Core plus persisted Binding, resumable execution, effect
  idempotency, and restart recovery;
- **Harness Verifiable**: Harness Durable plus portable Outcome, Evidence, and Verifier records;
- **Harness Distributed**: Harness Durable plus cross-process leases, fencing, target routing, and
  distributed recovery.

The matching conformance suite will define executable requirements. Morphz Runtime does not claim
public certification until a standalone suite and signed report are published.

## 13. Security considerations

Harness Packages, Contracts, Default Mind, Entry Programs, Skills, Tool results, and Verifiers are
potentially untrusted input.

A conforming Runtime MUST:

- validate Package structure and resource limits before activation;
- bind by exact content identity and reject same-version content replacement;
- authorize every external effect independently from Package declarations;
- prevent Package paths and resources from escaping their admitted boundary;
- prevent secrets from entering model-visible content unless explicitly authorized;
- record the Principal and effective capability scope for protected effects;
- limit model, Tool, storage, and execution resource consumption;
- fail visibly when required verification or authority is unavailable.

Package signatures and publisher trust improve provenance but do not grant execution authority.

## 14. Open decisions before Candidate status

The following decisions remain open:

1. canonical portable Outcome and Verifier schemas;
2. the first published Harness conformance fixtures and reports;
3. Package signing, publisher identity, revocation, and transparency-log profiles;
4. controlled Harness overlays and composition rules;
5. portable state namespaces and migration semantics;
6. dependency resolution and lockfile semantics;
7. compatibility-mark and trademark policy;
8. final intellectual-property and contribution terms.

Each decision requires an MEP or an explicitly recorded specification review.

## 15. Reference implementation status

As of the source baseline, Morphz Runtime implements the core `.hns` loader, normalized Package
identity, immutable registration by ID/version/hash, exact Objective-default and Evaluation
Bindings, one Primary Harness per Evaluation, read-only Contract and Default Mind mounting,
explicit `eval` and `infer` ownership, persistent plan execution, Runtime-mediated Tool work, child
inference handoff, and restart recovery paths.

Remote signed catalogs, general dependencies, Package migrations, portable Verifier records, and a
standalone conformance suite are not complete. This section is informative and cannot be used as a
conformance claim.

## 16. Intellectual-property status

This Draft is governed by the provisional [IPR Status Notice](IPR_STATUS.md). Publication for review
does not create an express or implied patent license, non-assertion promise, trademark license, or
certification right.

## 17. Errata and interpretations

Suspected errors or ambiguities MUST be recorded through the public issue and MEP process described
in [MEP-0001](../meps/MEP-0001-specification-governance.md). Any interpretation that changes
required observable behavior, profile membership, or compatibility results requires a Standards
Track MEP and a versioned specification update.
