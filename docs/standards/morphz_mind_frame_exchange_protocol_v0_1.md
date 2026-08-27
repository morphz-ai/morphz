# Morphz Mind Frame Exchange Protocol v0.1

> Status: Draft specification
>
> Steward: Newvar
>
> Reference implementation: Morphz Runtime (planned)
>
> Canonical language: English
>
> Date: 2026-08-25
>
> Chinese translation: [zh-CN](zh-CN/morphz_mind_frame_exchange_protocol_v0_1.md)

## 1. Scope

The Morphz Mind Frame Exchange Protocol (**MFX**) defines how an Agent can export a selected
cognitive subgraph and how another Agent can verify, quarantine, evaluate, and optionally adopt
that cognition without transferring Agent identity or granting the publisher authority over the
receiver's Mind.

The primary portable object is a **Mind Frame Bundle**. A Bundle can contain one Frame or several
Frames together with Relations, evidence lineage, revision information, disclosure and rights
declarations, integrity metadata, and optional Remote Resolver capabilities.

MFX v0.1 defines:

- one logical Bundle model for Single Frame, Frame Bundle, and Mind Projection exchange;
- source identity, revision, lineage, and reference semantics across authority domains;
- offline interpretation and optional remote resolution;
- disclosure, data-rights, integrity, and extension requirements;
- quarantine, evaluation, adoption, derivation, and rejection semantics;
- the boundary between imported cognition, local Mind membership, residency, and per-Evaluation
  activation;
- Core Producer, Consumer, Verifier, Resolver, and Importer roles.

MFX v0.1 does not define a universal knowledge ontology, truth score, automatic semantic merge,
live shared Context, federated query network, reputation market, payment system, or transfer of an
entire Agent, Kernel, Session history, private Inbox, credentials, or hidden model reasoning.

The [Morphz Structured Context Specification](morphz_structured_context_specification_v1.md)
defines Frame and Context semantics. The
[Morphz Agent Trajectory Specification](morphz_agent_trajectory_specification_v0_1.md) defines the
portable causal experience model whose evidence and rights concepts MFX reuses. The non-normative
[Morphz Union Mind Federation Vision](../morphz_union_mind_federation_vision_v1.md) describes a
possible federation layer above MFX.

## 2. Normative language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD
NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY**, and **OPTIONAL** in this document are to be
interpreted as described in BCP 14, [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119.html) and
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174.html), when, and only when, they appear in all
capitals.

Examples and rationale are non-normative unless explicitly identified otherwise.

## 3. Foundational principles

### 3.1 Selected cognition, not Agent transfer

MFX exchanges a deliberately selected cognitive subgraph. A Bundle MUST NOT imply transfer of the
source Agent's identity, ownership, authority, permissions, personality as a whole, private
Sessions, or complete Mind.

An exporter MUST apply an explicit selection boundary. Material outside that boundary is not part
of the Bundle merely because it exists in the source Context.

### 3.2 Import is not belief

Receiving, parsing, verifying, retaining, or evaluating a Bundle MUST NOT by itself make its Frames
members of the receiver's active Mind. A receiver MUST make adoption an explicit authorized state
transition.

Cryptographic integrity proves control of a key or consistency of bytes. It does not prove that a
Frame is true, useful, safe, current, or applicable to the receiver.

### 3.3 Cognitive sovereignty

The receiver owns the decision to adopt, revise, relate, retire, activate, or reject imported
cognition. By default, adoption creates a local Frame with immutable lineage to the source Frame.
The publisher MUST NOT acquire write authority over the local Frame.

Protocols that mirror or subscribe to a remote identity require a future Profile. They MUST NOT be
silently inferred from MFX-Core import.

### 3.4 Evidence and interpretation remain distinct

A Frame body is Agent-authored cognition. An Evidence Descriptor records or references material
that may support, contradict, qualify, or contextualize that cognition. Presence of evidence does
not make the Frame a Runtime fact, and MFX MUST preserve the distinction.

### 3.5 Offline Core, optional online resolution

A conforming MFX-Core Bundle MUST be parseable, structurally verifiable, and semantically
classifiable without network access. Optional Remote Resolvers can provide additional evidence,
revision, or supersession information, but unavailability of a Resolver MUST NOT make the Bundle
unparseable.

An Importer MUST NOT automatically follow arbitrary URLs embedded in a Bundle. Remote access is an
explicit policy-controlled operation.

### 3.6 Open body, closed envelope

MFX standardizes the exchange envelope, identity, lineage, rights, and lifecycle boundaries. It
does not standardize a universal business ontology for Frame bodies. A body format can define
syntax and decoding without claiming universal semantic meaning.

## 4. Terminology

### 4.1 Mind Frame

A **Mind Frame** is a stable Agent-authored cognitive unit as defined by Morphz Structured Context.
It has a source identity, revision, body, lifecycle state, and optional source references and
Relations.

### 4.2 Mind Frame Bundle

A **Mind Frame Bundle** is the single MFX exchange artifact. Its selection may contain:

- one independent Frame;
- several Frames and their dependency graph;
- a selective Mind Projection from a source Context.

These are selection modes of one logical object, not separate wire formats.

### 4.3 Source Frame Reference

A **Source Frame Reference** identifies a Frame revision inside a declared authority domain. The
portable identity tuple is:

```text
authority_domain + agent_id + context_id + frame_id + revision
```

No component may be silently substituted for another. A local opaque form MAY encode this tuple if
the canonical components remain recoverable or cryptographically bound.

### 4.4 Local adopted Frame

A **Local adopted Frame** is a receiver-owned Frame created after evaluation of imported cognition.
It has its own local identity and retains a `derived_from`, `forked_from`, or equivalent immutable
lineage reference to one or more Source Frame References.

### 4.5 Evidence Descriptor

An **Evidence Descriptor** is a portable description of a source Event, Observation, Outcome,
Artifact, Agent Trajectory node, external record, or redacted/unavailable source. It is not
necessarily the evidence content itself.

### 4.6 Remote Resolver

A **Remote Resolver** is an optional authority endpoint that supports declared MFX resolution
capabilities. A Resolver response is a statement by that authority; it is not universal truth.

### 4.7 Quarantine

**Quarantine** is receiver-controlled storage and evaluation in which imported content remains
outside active local Mind membership and cannot exercise authority or execute embedded content.

### 4.8 Adoption, residency, and activation

- **Adoption** makes a local Frame part of the receiver's semantic Mind.
- **Residency** determines whether a Frame belongs to the receiver's default Frame Working Set.
- **Activation** determines whether a Frame is present in one particular Evaluation's Context
  Encoding.

These are independent states. Adoption MUST NOT imply permanent residency or universal activation.

## 5. Bundle logical model

### 5.1 Required top-level fields

A Mind Frame Bundle contains the following logical fields:

| Field | Requirement | Meaning |
| --- | --- | --- |
| `spec_version` | REQUIRED | MFX specification version |
| `profiles` | REQUIRED | Claimed conformance Profiles |
| `bundle_id` | REQUIRED | Stable identity of this exported Bundle |
| `source` | REQUIRED | Producer, exporter, authority domain, and source revision |
| `selection` | REQUIRED | Declared Frame selection and closure policy |
| `completeness` | REQUIRED | `complete`, `partial`, or `open`, with qualifications |
| `frames` | REQUIRED | Exported Frame revisions; may be an explicit empty list only for diagnostics |
| `relations` | REQUIRED | Exported typed Relations |
| `evidence` | REQUIRED | Evidence Descriptors or explicit absence |
| `transform` | REQUIRED | Selection, filtering, redaction, and derivation history |
| `disclosure` | REQUIRED | Omitted classes and confidentiality state |
| `rights` | REQUIRED | Permitted receiver operations and audience constraints |
| `integrity` | REQUIRED | Digest/signature declarations or explicit absence |
| `resolvers` | OPTIONAL | Policy-gated Remote Resolver declarations |
| `extensions` | OPTIONAL | Namespaced extension data |

An empty required collection does not prove that the corresponding source class did not exist.

### 5.2 Source

`source` MUST identify:

- producing implementation and exporter version;
- authority domain;
- source Agent and Context;
- source Mind revision or equivalent export boundary;
- export time when disclosed;
- optional issuer identity and signing-key reference.

The exporter MUST NOT claim authority over a Context it cannot authenticate or otherwise bind to
its export process.

### 5.3 Selection and completeness

`selection` MUST state how root Frames were chosen and how dependency closure was calculated.
Examples include an explicit Frame list, Relation traversal, or a named Projection rule.

`complete` means all material content required by the claimed Profile and selection boundary is
included or explicitly represented by a permitted external reference. `partial` means the boundary
is closed but material information was omitted, redacted, unavailable, or not captured. `open`
means the selected source state can still change under the declared export boundary.

An exporter MUST NOT describe a Bundle as complete merely because all selected rows were emitted.

### 5.4 Frame record

Each Frame record MUST contain:

- a Source Frame Reference;
- body availability and Body Value or a permitted omission marker;
- source lifecycle state at export;
- source protection state when permitted and material;
- declared source references;
- provenance state;
- content digest when body content is present;
- optional applicability, counterexample, uncertainty, and revision-history claims authored by the
  source Agent.

Agent-authored claims MUST remain distinguishable from Runtime-derived identity and Event facts.

### 5.5 Relation record

A Relation record MUST identify its subject, relation name, object, creating authority, and source
revision. Relation names are open unless a Profile defines them. Consumers MUST NOT infer standard
business meaning from an unknown Relation.

The `supersedes` Relation indicates a source Agent assertion of replacement. It does not require a
receiver to retire a local Frame.

### 5.6 Body Value and body format

A Body Value MUST declare:

- `format`;
- `encoding` when the format does not define one;
- inline content, an Artifact reference, or an explicit omission state;
- digest algorithm and value when content is available.

MFX v0.1 defines these base format identifiers:

- `morphz.sexpr`: UTF-8 Morphz S-expression body;
- `text.utf8`: opaque UTF-8 text with no universal ontology.

Additional body formats require a namespaced extension or Profile. A body format describes how to
decode content; it MUST NOT be treated as proof that the content is safe or semantically correct.

## 6. Identity, revisions, and lineage

### 6.1 Source identity is immutable

Re-exporting the same source Frame revision MUST preserve its Source Frame Reference. A producer
MUST NOT reuse a Source Frame Reference for semantically different content.

When the source system detects identity corruption or historical migration uncertainty, it MUST
declare the uncertainty rather than mint a misleading continuity claim.

### 6.2 Bundle identity

`bundle_id` MUST be stable for the exact declared selection, source boundary, transformation, and
content. A new source revision, selection, redaction, rights declaration, or transformation that
changes interpretation MUST create a new Bundle identity or explicit Bundle revision.

### 6.3 Local adoption lineage

MFX-Core adoption SHOULD create a receiver-local Frame identity. The adoption transaction MUST
record:

- source Bundle identity;
- Source Frame Reference;
- adoption mode such as `derived_from` or `forked_from`;
- verifier result and policy identity used for admission;
- local Principal or Agent authority responsible for adoption;
- local creation revision.

The receiver MAY revise the local Frame subject to local Structured Context semantics. Such a
revision MUST NOT be published as a revision authored by the original source authority.

### 6.4 No implicit remote write authority

Resolver availability, signature validity, subscription metadata, or shared relation names MUST
NOT grant the publisher permission to mutate, retire, restore, protect, activate, or disclose a
receiver-local Frame.

## 7. Evidence closure and remote resolution

### 7.1 Evidence availability states

Every material Evidence Descriptor MUST declare one of:

- `inline`: permitted content is included;
- `artifact`: content is in a digest-bound Artifact;
- `remote`: a Resolver may provide it under policy;
- `redacted`: content existed but was intentionally withheld;
- `unavailable`: the exporter could not retrieve it;
- `unknown`: the source could not determine whether it existed.

Redacted, unavailable, and unknown are distinct from empty or false.

### 7.2 Portable evidence references

A local Event or Observation ID that is not meaningful outside its authority domain MUST be paired
with the authority domain and source type. An exporter MUST NOT turn an unreachable local ID into a
false portable claim.

When a Frame materially depends on omitted evidence, the Bundle MUST include an external-parent,
redacted-parent, unavailable-parent, or equivalent closure marker. Filtering MUST NOT silently
re-parent cognition to a convenient visible source.

### 7.3 Remote Resolver declaration

A Resolver declaration MUST include:

- protocol identifier and version;
- authority domain;
- endpoint or endpoint-discovery identifier;
- supported capabilities;
- authentication and authorization method identifiers;
- optional expiry and signing-key references.

MFX v0.1 reserves these capability names:

- `resolve_frame`;
- `resolve_evidence`;
- `check_revision`;
- `list_superseding_frames`;
- `get_withdrawal_statement`.

A capability name declares availability, not permission. Each request remains subject to the
receiver's policy and the Resolver's authorization decision.

### 7.4 Resolver invocation policy

An Importer MUST NOT automatically access a Resolver merely because a Bundle contains an endpoint.
Before network access, the receiver MUST apply an explicit policy that covers at least:

- allowed authority domains and endpoint schemes;
- DNS, redirect, loopback, link-local, private-network, and metadata-service restrictions;
- credential scope and disclosure;
- request purpose and requested identifiers;
- response size, timeout, and content limits;
- audit and user/Principal approval requirements.

An Importer MUST treat redirects and endpoint changes as new network decisions. It MUST NOT send
receiver secrets, local Frame bodies, query context, or private identity unless the applicable
policy explicitly authorizes those fields.

### 7.5 Resolver response binding

A Resolver response SHOULD be signed and MUST bind its authority domain, capability, requested
reference, returned revision, content digest, issuance time, and expiry when present. A Consumer
MUST NOT combine content from one response with identity or signatures from another.

Resolver failure, refusal, or disappearance does not invalidate the bytes already present in a
Bundle. It changes what can currently be verified and MUST be represented as such.

## 8. Disclosure and rights

### 8.1 Explicit rights

Use of an open implementation or public specification MUST NOT be interpreted as permission to
collect, retain, adopt, derive from, host-process, redistribute, or train on a Bundle.

The rights declaration MUST explicitly address at least:

- inspection and verification;
- retention;
- local evaluation;
- hosted evaluation;
- adoption into local Mind;
- creation of derived cognition;
- Remote Resolver access;
- redistribution of original and transformed content;
- training use.

Unknown or absent permission MUST be treated as denied. Derived Frames and derived Bundles MUST NOT
expand the rights granted by their sources.

### 8.2 Audience and time constraints

A rights declaration MAY restrict authorized Principals, organizations, Agent identities,
authority domains, purposes, jurisdictions, validity periods, or downstream recipients. Machine-
readable flags do not replace applicable law, contract, or human-readable license terms.

### 8.3 Disclosure

The disclosure declaration MUST state whether the Bundle contains or omits:

- user or Principal content;
- private Session material;
- raw evidence payloads;
- inferred sensitive attributes;
- model-private reasoning;
- confidential Frame bodies or Relations;
- source identities and timing metadata.

Redaction SHOULD minimize both content leakage and metadata inference. A digest of low-entropy
secret content can itself leak information and MUST NOT be published merely to prove redaction.

## 9. Integrity

An integrity declaration MUST identify its status, digest algorithm, canonicalization, covered
fields, and signature scheme when present. `unsigned` or `unavailable` is an explicit state, not a
verification success.

Until a canonical-signature Profile is finalized, a producer MUST identify the exact
canonicalization used for any digest or signature. Object-key order MUST NOT be assumed semantic
unless the declared canonicalization says otherwise.

Verification MUST distinguish at least:

- structurally valid;
- digest-valid;
- signature-valid for a declared key;
- authority binding validated;
- evidence resolved or unresolved;
- policy-admissible or denied;
- semantically evaluated or unevaluated.

No single boolean `trusted` field is conformant with these distinctions.

## 10. Import, quarantine, and adoption

### 10.1 Required state separation

An MFX Importer MUST preserve the following conceptual states, even if its internal names differ:

```text
received -> verified -> quarantined -> evaluated -> adopted | rejected
```

Failure at any stage MUST NOT silently advance the Bundle to a later state. Re-evaluation under a
new policy or new evidence MUST create a new auditable decision.

### 10.2 Quarantine requirements

Quarantined content MUST:

- remain outside active local Mind membership;
- remain outside default Context Encoding;
- have no Tool, capability, credential, or Runtime authority;
- not execute embedded Yao, Harness, scripts, links, or instructions;
- be subject to resource and decompression limits;
- retain source identity, rights, disclosure, and integrity metadata;
- be removable without mutating local authoritative cognition.

An Agent MAY inspect quarantined cognition in an isolated Evaluation whose authority and disclosure
boundary are explicit.

### 10.3 Evaluation

An evaluation MAY compare imported cognition against local Frames, evidence, Outcomes, policies,
or domain verifiers. Its result SHOULD record:

- evaluated Bundle and Frame identities;
- local State View or declared comparison boundary;
- evidence and Resolver responses consulted;
- compatibility, applicability, uncertainty, and conflict findings;
- evaluator, model, Cognitive Application, and policy identities when material;
- recommended action without conflating that recommendation with commit.

### 10.4 Adoption

Adoption MUST be an authorized local Context transaction. It MUST create or revise only receiver-
owned state and preserve source lineage. The adoption decision MAY:

- create a local Frame from the imported body;
- derive a new local Frame that combines imported and local cognition;
- retain several competing local hypotheses;
- create Relations to existing local Frames;
- keep the Bundle quarantined for later evidence;
- reject the Bundle.

Adoption MUST NOT automatically retire a conflicting local Frame or copy source protection state as
receiver authority.

### 10.5 Cognitive use after adoption

An adopted Frame is eligible for local recall and activation. Whether it is resident by default and
whether it appears in a particular Evaluation are separate local decisions. An implementation MUST
NOT represent a physically retained but non-adopted Bundle as active cognition.

## 11. Updates, supersession, and withdrawal

A source authority MAY publish a newer Frame revision, superseding Frame, correction, or withdrawal
statement. Such a statement is new information and MUST NOT mutate an earlier immutable Bundle.

A receiver MAY use Remote Resolver or future subscription Profiles to discover updates. Discovery
MUST NOT automatically revise or delete receiver-local Frames. The receiver evaluates the update
and commits its own local transition.

Withdrawal means the source authority no longer endorses or distributes a source assertion under
the stated conditions. It cannot erase cognition already learned by another Agent, rewrite local
Event History, or prove that the old assertion was false. Legal or contractual deletion duties are
separate obligations and MUST be enforced by the relevant product and authority policies.

## 12. Serialization and extensions

The v0.1 exchange representation is UTF-8 JSON. Every Bundle MUST declare `spec_version`. Object-key
order is not semantic. Array order is semantic only where a field explicitly declares it.
Timestamps use RFC 3339 when present.

Consumers MUST reject unsupported REQUIRED Profiles and MUST NOT guess their semantics from field
shape. Extensions MUST use collision-resistant namespaces and MUST NOT redefine Core fields.
Unknown optional extensions MAY be preserved and ignored. An extension required for correct
interpretation MUST be declared as required.

JSON is the v0.1 transport representation, not the Frame ontology. Future encodings MAY be defined
when they preserve the same logical model and negotiation semantics.

## 13. Security considerations

All imported Frame bodies, Relations, evidence, metadata, Resolver declarations, and signatures are
untrusted input. Implementations MUST defend against at least:

- prompt injection and instruction smuggling inside cognition or evidence;
- malicious Yao, Harness, script, URI, or Artifact execution;
- identifier collision and authority-domain substitution;
- digest/signature confusion and canonicalization ambiguity;
- decompression bombs, oversized graphs, deep nesting, and cyclic dependency attacks;
- SSRF, DNS rebinding, redirect abuse, metadata-service access, and credential leakage;
- malicious or compromised Remote Resolvers;
- rights laundering through local derivation or transformed redistribution;
- private Session or Principal re-identification through content or metadata;
- stale, withdrawn, poisoned, or selectively redacted cognition;
- attention pollution, personality drift, and denial of Context capacity;
- majority or reputation signals being mistaken for truth.

Importers SHOULD default to no network, no execution, no adoption, and no redistribution until an
explicit policy authorizes each transition.

## 14. Conformance roles and Profiles

### 14.1 Roles

An implementation MAY claim one or more roles:

- **MFX Producer**: creates logical Bundles;
- **MFX Exporter**: deterministically projects an authoritative source into Bundles;
- **MFX Consumer**: parses and interprets Bundles;
- **MFX Verifier**: validates structure, identity, integrity, and claimed Profiles;
- **MFX Importer**: enforces quarantine and adoption boundaries;
- **MFX Resolver**: serves policy-controlled remote resolution capabilities.

### 14.2 Profiles

MFX v0.1 defines or reserves:

- **MFX-Core**: offline Bundle model, identity, Frame, Relation, evidence-state, disclosure, rights,
  integrity declaration, and extension behavior;
- **MFX-Importer**: quarantine, evaluation-record, and local adoption boundaries;
- **MFX-Remote-Resolver**: capability discovery, policy-gated resolution, and response binding;
- **MFX-Signed**: reserved for canonical signatures;
- **MFX-Subscription**: reserved for remote revision feeds and cursors;
- **MFX-Federation**: reserved for Union Mind federation semantics.

Only MFX-Core, MFX-Importer, and MFX-Remote-Resolver are described by this Draft. Reserved Profiles
MUST NOT be claimed until a normative extension defines them.

### 14.3 Minimum conformance evidence

A future open conformance suite SHOULD verify at least:

- deterministic export of the same source boundary;
- stable Source Frame References and Bundle identity;
- complete/partial/open and evidence-availability distinctions;
- rejection of malformed, cyclic, oversized, and authority-substituted Bundles;
- offline parsing without Resolver access;
- no automatic URL or Resolver invocation;
- quarantine isolation and no embedded execution;
- explicit adoption transaction and local lineage preservation;
- no publisher write authority over adopted Frames;
- rights denial by default and no derived-rights expansion;
- Resolver endpoint policy, request binding, redirect handling, and response verification;
- update and withdrawal statements remaining non-mutating local inputs.

Self-test results are not public certification. Official compatibility marks require separate
governance, trademark policy, and qualifying evidence.

## 15. Relationship to other Morphz standards

### 15.1 Structured Context

Structured Context defines what a Frame is and how local Context transactions preserve identity,
revision, lifecycle, provenance, and conflict semantics. MFX defines the portable boundary between
two Context authorities. MFX does not redefine local Context transaction semantics.

### 15.2 Agent Trajectory

Agent Trajectory records causally structured experience and state transition. MFX transfers
selected cognition produced from experience. A Bundle MAY reference Agent Trajectory nodes or
Bundles as evidence, but the two artifacts are not interchangeable.

### 15.3 Cognitive Applications, Harness, and Yao

A Cognitive Application or Harness MAY export, evaluate, or adopt cognition subject to Runtime
authority. A Frame body MAY describe procedural knowledge, but importing a Frame MUST NOT mount a
Harness or execute Yao. Executable packaging requires its own admitted artifact and capability
boundary.

### 15.4 Union Mind Federation

Union Mind Federation can build discovery, query, subscription, attribution, and collaborative
cognition above MFX. Federation MUST preserve the source authority and receiver sovereignty
principles defined here. This Draft does not make Federation a Core requirement.

## 16. Open decisions before Candidate status

The following require explicit review, an MEP, or a later Profile:

1. canonical JSON Schema and byte-level canonicalization;
2. global authority-domain discovery and key rotation;
3. the exact rights vocabulary and interaction with human-readable licenses;
4. Artifact packaging and maximum portable Bundle limits;
5. standard applicability, uncertainty, and counterexample vocabularies, if any;
6. Resolver authentication, privacy-preserving queries, and response caching;
7. subscription cursors, update feeds, and mirror identity;
8. cross-authority reputation and verification-result portability;
9. Union Mind discovery, Federated Recall, and collaborative governance;
10. final specification-text, patent, contribution, and compatibility-mark policies.

## Appendix A: Non-normative JSON skeleton

```json
{
  "spec_version": "0.1",
  "profiles": ["MFX-Core", "MFX-Importer"],
  "bundle_id": "mfxb:sha256:...",
  "source": {
    "implementation": "morphz",
    "exporter_version": "0.1.0",
    "authority_domain": "agent.example",
    "agent_id": "agent-a",
    "context_id": "context-main",
    "mind_revision": 42
  },
  "selection": {
    "roots": ["frame-experience-7"],
    "closure": "declared-sources-and-relations"
  },
  "completeness": {
    "status": "partial",
    "reason": "one private evidence body was redacted",
    "material_omissions": ["evidence:event-private-2"]
  },
  "frames": [
    {
      "source_ref": {
        "authority_domain": "agent.example",
        "agent_id": "agent-a",
        "context_id": "context-main",
        "frame_id": "frame-experience-7",
        "revision": 3
      },
      "body": {
        "format": "morphz.sexpr",
        "encoding": "utf-8",
        "content": "(experience (claim \"...\") (scope \"...\"))",
        "digest": "sha256:..."
      },
      "lifecycle": "active",
      "sources": ["evidence:event-1", "evidence:event-private-2"]
    }
  ],
  "relations": [],
  "evidence": [
    {
      "evidence_id": "evidence:event-1",
      "kind": "event",
      "availability": "remote",
      "source_ref": "event-1",
      "digest": "sha256:..."
    },
    {
      "evidence_id": "evidence:event-private-2",
      "kind": "event",
      "availability": "redacted",
      "reason": "private-session-content"
    }
  ],
  "transform": {
    "operations": ["select", "redact"]
  },
  "disclosure": {
    "user_content": "redacted",
    "private_reasoning": "omitted"
  },
  "rights": {
    "inspect": true,
    "retain": true,
    "local_evaluation": true,
    "hosted_evaluation": false,
    "adopt": true,
    "derive": true,
    "remote_resolve": true,
    "redistribute_original": false,
    "redistribute_transformed": false,
    "training": false
  },
  "integrity": {
    "status": "digest",
    "algorithm": "sha256",
    "canonicalization": "mfx-json-draft-0.1",
    "digest": "sha256:..."
  },
  "resolvers": [
    {
      "protocol": "mfx-resolver/0.1",
      "authority_domain": "agent.example",
      "endpoint": "https://agent.example/mfx",
      "capabilities": ["resolve_evidence", "check_revision"]
    }
  ],
  "extensions": {}
}
```

