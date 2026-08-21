# Morphz Agent Trajectory Specification v0.1

> Status: Draft specification candidate
>
> Steward: Newvar
>
> Reference implementation: Morphz Runtime
>
> Canonical language: English
>
> Date: 2026-08-21
>
> Chinese translation: [zh-CN](zh-CN/morphz_agent_trajectory_specification_v0_1.md)

## 1. Scope

This specification defines an implementation-independent model for recording, exchanging,
evaluating, and learning from Agent experience. Its primary object is an **Agent Trajectory**: a
finite, versioned, causally structured projection of authoritative execution facts and state
transitions within a declared scope.

This specification defines:

- the distinction between Agent Trajectory, Event History, Trace, Episode, Rollout, and Dataset;
- the logical contents of an Agent Trajectory Bundle;
- causal, state-transition, authority, provenance, outcome, verification, and reward semantics;
- completeness, transformation, redaction, data-rights, and integrity declarations;
- Core, Evaluation, and Training conformance profiles.

This specification does not define a model architecture, optimizer, universal reward function,
Event Store schema, scheduler implementation, or requirement to persist private chain-of-thought.
It does not make collection, upload, redistribution, or training consent implicit.

The [Morphz Structured Context Specification](morphz_structured_context_specification_v1.md),
[Morphz Harness Specification](morphz_harness_specification_v0_1.md), and
[Yao specifications](yao_core_language_specification_v0_1.md) provide related semantics. An Agent
Trajectory implementation MAY use different internal abstractions when it preserves the observable
requirements of the claimed profile.

## 2. Normative language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD
NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY**, and **OPTIONAL** in this document are to be
interpreted as described in BCP 14, [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119.html) and
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174.html), when, and only when, they appear in all
capitals.

Examples, rationale, and implementation notes are non-normative unless explicitly identified
otherwise.

## 3. Foundational model

### 3.1 State transition, not transcript

The canonical subject of an Agent Trajectory is a structured state transition, not a message
sequence. A message is one possible Event or Observation. It MUST NOT be assumed to contain the
complete state, authority, cause, effect, or result of an Agent action.

A state-transition view can be summarized as:

```text
Structured State View
  -> Agent or Runtime Decision
  -> Proposed and admitted Action
  -> Effect and Observation
  -> State Delta and resulting State
  -> Outcome, Verifier Result, and optional Reward Record
```

The representation MAY omit unavailable or prohibited content, but it MUST declare material
omissions and MUST NOT silently convert missing information into an empty value or negative label.

### 3.2 Fact, projection, and interpretation

An authoritative Event records that something occurred. A State View, Trace, Episode, Agent
Trajectory, score, and Dataset are projections or interpretations of authoritative facts for a
declared purpose.

An exported Agent Trajectory MUST preserve references to its authoritative sources when those
references may be disclosed. Export does not make the Bundle the source system's new authority and
MUST NOT rewrite the source Event History.

### 3.3 Causal graph, not incidental order

An Agent Trajectory is a directed acyclic causal graph. A total storage sequence or wall-clock timestamp
MAY be included for audit and presentation, but neither alone establishes causation.

Parallel branches, joins, retries, recovery, delegation, and external callbacks MUST remain
distinguishable when they are material to the represented outcome.

### 3.4 Evidence before reward

Runtime facts, Outcome claims, Verifier Results, and Reward Records have distinct authority. A
Reward Record is a versioned interpretation of identified facts for a particular learning or
evaluation purpose. It MUST NOT replace or mutate the facts from which it was derived.

### 3.5 Explicit data rights

Source-code availability, local execution, or use of an open specification MUST NOT be interpreted
as consent to collect, upload, redistribute, or train on Agent Trajectories. Each exported Bundle
MUST carry an explicit rights and disclosure declaration.

## 4. Terminology

### 4.1 Agent Trajectory

An **Agent Trajectory** is a finite, versioned, causally structured projection of authoritative
execution facts that represents one or more linked state transitions within a declared boundary.
It is the portable experience object defined by this specification.

An Agent Trajectory MAY cover one Agent or several cooperating Agents. It MAY cover an Objective,
an Attempt, a bounded Evaluation, or another explicitly defined scope.

### 4.2 Event, Event History, and Event Store

An **Event** is an immutable record of an occurrence. **Event History** is the authoritative ordered
history of such Events within its authority domain. An **Event Store** is a storage implementation
for Event History and related projections.

Event Store is an implementation role, not a portable training-data format. A conforming exporter
projects Event History and authoritative state into an Agent Trajectory Bundle without requiring a
consumer to adopt the source database schema.

### 4.3 State, State View, State Reference, and State Delta

- **State** is the authoritative or declared condition of the relevant system at a boundary.
- **State View** is the exact projection available to a specified actor or evaluator.
- **State Reference** identifies a versioned State or State View without duplicating it inline.
- **State Delta** records declared changes between two State boundaries.

A State View MUST distinguish Agent-visible material from Runtime-only authority when both are
represented.

### 4.4 Trajectory Node and Causal Edge

A **Trajectory Node** is a stable unit in the portable causal graph. It MAY represent an input,
decision, action, admission, effect, observation, state transaction, branch, join, verification, or
terminal transition.

A **Causal Edge** states a typed relation between two Nodes, such as `caused_by`, `triggered_by`,
`depends_on`, `joins`, `retries`, `resumes`, or `verifies`. Profiles MAY define additional edge
types. An unknown edge type MUST NOT be interpreted as temporal order only.

### 4.5 Action, Effect, Observation, and Effect Receipt

- An **Action** is a proposed or admitted operation selected by an Agent, model, Harness, Runtime,
  Principal, or deterministic program.
- An **Effect** is an interaction with Runtime-owned state or an external environment.
- An **Observation** is a represented result or fact made available to an Agent or evaluator.
- An **Effect Receipt** is an immutable Runtime record binding an admitted Effect to its operation,
  arguments, route, causal identity, status, and result reference.

Proposal, admission, execution, and commitment are different states and MUST NOT be collapsed when
the distinction affects authority, safety, recovery, or outcome interpretation.

### 4.6 Outcome, Verifier Result, and Reward Record

- An **Outcome** is a claimed or externally reported result for a declared scope.
- A **Verifier Result** is the result of an identified, versioned verifier checking a stated
  property against declared evidence.
- A **Reward Record** is a versioned mapping from identified facts and Verifier Results to scalar,
  vector, ordinal, preference, label, or other learning signals.

Verifier success does not automatically mean that the complete Objective was achieved. Outcome
success does not automatically define a universal Reward.

### 4.7 Rollout, Episode, Trace, and Dataset

- A **Rollout** is one execution instance under declared task, environment, policy, and binding
  conditions. A Rollout produces authoritative facts from which an Agent Trajectory may be
  exported.
- An **Episode** is a bounded projection selected from one or more Agent Trajectories for replay,
  evaluation, or training. Its selection and termination rules MUST be explicit.
- A **Trace** is an observability-oriented projection used to inspect operational execution. A
  Trace MAY be derived from an Agent Trajectory or share source Events with it, but Trace and Agent
  Trajectory are not synonyms.
- A **Dataset** is a versioned collection of Agent Trajectories, Episodes, labels, transformations,
  and rights declarations prepared for a stated use.

## 5. Conformance profiles

### 5.1 AT-Core

AT-Core defines the portable causal and state-transition record. A conforming AT-Core Bundle MUST
provide:

- specification version, Profile claims, and stable Trajectory identity;
- source, scope, boundary, and completeness declarations;
- stable Nodes and typed causal Edges;
- actor and authority identity where known and disclosable;
- State References, State Views, or declared unavailable-state markers sufficient to interpret
  represented transitions;
- Outcome references or an explicit declaration that no Outcome is available;
- transformation, disclosure, rights, and integrity metadata.

### 5.2 AT-Evaluation

AT-Evaluation extends AT-Core for reproducible evaluation. It additionally MUST provide:

- task and Environment Version identity or declared equivalent conditions;
- termination reason and relevant budget or resource observations;
- Verifier identity, version, scope, evidence inputs, status, and result;
- enough binding information to distinguish model, Harness, program, tool, and environment changes
  that could affect comparison;
- an explicit statement of uncontrolled or unavailable variables.

### 5.3 AT-Training

AT-Training extends AT-Core for learning and optimization. It additionally MUST provide:

- the exact State View or State View reference available at every included target decision;
- selected Action, structured output, or Program Value and its admission status;
- resulting Observation, State Delta, terminal status, or declared missing target;
- training masks identifying fields that are inputs, targets, metadata, or excluded content;
- Reward Record or label references when such signals are supplied;
- model, policy, Harness, and relevant decoding identities when available;
- explicit permission for the stated training use.

AT-Training does not require one optimizer, tokenizer, model family, or Reward Policy.

## 6. Agent Trajectory Bundle

### 6.1 Required top-level fields

The portable logical Bundle contains the following fields:

| Field | Requirement | Meaning |
| --- | --- | --- |
| `spec_version` | REQUIRED | Agent Trajectory specification version |
| `profiles` | REQUIRED | Claimed conformance Profiles |
| `trajectory_id` | REQUIRED | Stable identity for this exported Trajectory |
| `source` | REQUIRED | Source implementation, exporter, and authority metadata |
| `scope` | REQUIRED | Included Agents, Contexts, Objectives, Attempts, Evaluations, and boundaries |
| `completeness` | REQUIRED | `complete`, `partial`, or `open`, with qualifications |
| `bindings` | REQUIRED | Known task, environment, Harness, program, model, and policy identities |
| `states` | REQUIRED | State References, available State Views, snapshots, and deltas |
| `nodes` | REQUIRED | Stable Trajectory Nodes |
| `edges` | REQUIRED | Typed causal Edges |
| `outcomes` | REQUIRED | Outcomes or explicit absence |
| `verifier_results` | REQUIRED | Verifier Results or explicit absence |
| `reward_records` | REQUIRED | Reward Records or explicit absence |
| `transform` | REQUIRED | Export, filtering, redaction, and derivation lineage |
| `disclosure` | REQUIRED | Omitted classes, redaction state, and confidentiality metadata |
| `rights` | REQUIRED | Allowed collection, use, training, and redistribution scopes |
| `integrity` | REQUIRED | Digest/signature declarations or explicit absence |
| `extensions` | OPTIONAL | Namespaced extension data |

An empty required collection is an explicit empty collection, not proof that no corresponding fact
exists in the source system.

### 6.2 Source and scope

`source` MUST identify the producing implementation and exporter version. When the exporter reads
from authoritative Event History, it SHOULD identify the authority domain and source revision or
cursor without exposing prohibited infrastructure details.

`scope` MUST declare the selection rule and boundaries used to construct the Trajectory. A Bundle
MUST NOT claim `complete` merely because every selected Node was exported. `complete` means that all
material in-scope causal facts required by the claimed Profile are represented or explicitly
declared unavailable under that Profile.

`partial` means that the declared boundary is closed but material in-scope information was omitted,
redacted, unavailable, or not captured. `open` means that execution or the selected boundary has not
yet reached a terminal cutoff. A change from `open` to `complete` or `partial` creates a new Bundle
revision or derived Bundle; it does not mutate a previously signed artifact.

### 6.3 Bindings

Bindings SHOULD use content identities rather than floating names. Where applicable, they include:

- task and Environment Version;
- exact Cognitive Application identity when one was selected;
- Agent, Principal, Context, Session, Objective, and Attempt;
- exact Harness Package and Evaluation Binding;
- Yao source or validated Program identity;
- model Provider, model identity, policy revision, and decoding configuration;
- Tool, Execution Target, capability, sandbox, and verifier versions.

Unavailable or intentionally undisclosed bindings MUST be distinguished from bindings that did not
exist.

## 7. Identity, ordering, and causal closure

### 7.1 Stable identity

Trajectory, Node, State, Outcome, Verifier Result, Reward Record, and referenced Artifact identities
MUST be stable within the declared authority domain. Re-export MUST NOT assign a previous stable
identity to semantically different content.

Identifiers MAY be opaque. Content-derived identifiers MUST declare the digest algorithm and
canonicalization method.

### 7.2 Ordering

A Bundle MAY carry authoritative sequence numbers, logical clocks, and timestamps. Consumers MUST
NOT infer a causal edge from adjacent array positions or timestamps alone.

When two Nodes are concurrent, an exporter MUST NOT invent an order merely to create a linear
transcript. Presentation layers MAY display a deterministic order while preserving concurrency in
the causal graph.

### 7.3 Causal closure and external parents

Every included Node with a known material causal parent MUST either:

1. include that parent;
2. include a typed external-parent reference;
3. include a redacted-parent marker with the reason and permitted metadata; or
4. declare that the source could not determine the parent.

Filtering or redaction MUST NOT re-parent a Node to a convenient visible ancestor. A child MUST
retain its actual causal boundary even when parent contents are unavailable.

Retries, replay, resume, and recovery MUST preserve the relationship between the original intent,
attempt identity, Effect Receipt, and later completion. Duplicate delivery MUST NOT be represented
as a new successful Effect when the Runtime treated it as idempotent replay.

## 8. State-transition semantics

### 8.1 Transition components

A represented decision transition SHOULD make the following components addressable:

1. `state_before` or a versioned reference;
2. the actor-specific State View and `read_set` actually available;
3. the decision, proposal, Action, or Program Value;
4. admission, authorization, and effective capability decision;
5. Effect Requests and immutable Effect Receipts;
6. resulting Observations and evidence;
7. `state_delta` or `write_set`;
8. `state_after` revision or digest;
9. terminal, suspended, waiting, rejected, or failed status.

Profiles MAY group these components into several Nodes. The causal links between them MUST remain
recoverable from the Bundle.

### 8.2 Structured Context

When the source uses Structured Context, a State View SHOULD preserve the distinctions among
Runtime-owned Kernel, Agent-owned Mind, Inbox or Observations, Session scope, Attention, and
Context revision.

An AT-Training producer MUST identify the State View actually available at a target decision. It
MUST NOT substitute a later reconstructed State without declaring that transformation.

### 8.3 References and deltas

Full State snapshots are OPTIONAL. Producers SHOULD use content-addressed State References,
`read_set`, `write_set`, and State Deltas when they preserve the claimed semantics with less
duplication.

A consumer MUST be able to distinguish:

- unchanged state;
- an explicitly empty value;
- omitted or redacted state;
- unavailable source state;
- a State Reference whose content is not included in this Bundle.

## 9. Action, authority, and effect semantics

Every material Action SHOULD identify its actor and authority class: Agent, model, Harness,
deterministic program, Runtime, Principal, verifier, or external system.

An Agent or model proposal MUST NOT be represented as an executed Effect. An admitted Effect MUST
identify the Runtime authority or equivalent system that admitted it. An external side effect MUST
have an Effect Receipt or an explicit declaration that no authoritative receipt exists.

Capability grants, approvals, denials, lease expiry, revocation, sandbox boundaries, and Execution
Target selection MUST be represented when they materially affect execution or interpretation.
Secret values MUST NOT be included merely to reproduce an authority decision; stable secret aliases
or capability references SHOULD be used instead.

## 10. Outcome, verification, and reward

### 10.1 Outcome

Every Outcome MUST identify:

- the scope it claims to describe;
- its producer and authority class;
- status and terminality;
- supporting Evidence References when available;
- the Node or boundary at which it was asserted;
- later invalidation or supersession, if known in scope.

Agent self-report, Runtime completion, user acceptance, and external-world success are distinct
Outcome authorities and MUST NOT be silently merged.

### 10.2 Verifier Result

Every Verifier Result MUST identify the verifier, version, checked property, input evidence,
execution environment when material, result status, and output. Result status SHOULD distinguish
at least `pass`, `fail`, `indeterminate`, `error`, and `invalidated`.

A Verifier Result MUST NOT claim facts outside the verifier's declared scope. A later verifier MAY
invalidate an earlier result by adding a new record; it MUST NOT edit the earlier record.

### 10.3 Reward Record

Every Reward Record MUST identify:

- Reward Policy identity and version;
- source Outcomes, Verifier Results, costs, or labels;
- scope and attribution target;
- signal type and value;
- aggregation or normalization method when applied;
- producer and creation time;
- whether the record was produced online or retrospectively.

The signal MAY be scalar, vector, ordinal, categorical, preference-based, or step-level. This
specification does not define a universal scalar Reward. New Reward Records MAY be derived later
without changing the underlying Agent Trajectory facts.

## 11. Model, Harness, and Program provenance

When a model participates in a target decision, the Bundle SHOULD identify the Provider, model,
policy revision, request identity, relevant decoding configuration, and the exact State View or
serialized request Artifact supplied to it.

Raw prompts and raw model output are OPTIONAL and subject to disclosure rights. If omitted, the
Bundle SHOULD retain authorized content identities and structured boundary metadata sufficient to
explain the omission.

Private chain-of-thought is not required for any Profile. A model-produced reasoning summary MAY be
included as non-authoritative model output and MUST NOT be represented as a Runtime fact.

Harness-governed work SHOULD identify the exact Cognitive Application identity when one was
selected, plus the exact Harness Package, Evaluation Binding, Contract, and Entry Program. A Yao
program or Program Value SHOULD use its canonical validated identity and source provenance rather
than an unversioned display string.

## 12. Training semantics

### 12.1 Training unit

AT-Training treats the basic learning unit as a structured transition such as:

```text
(State View, read set, policy binding)
  -> Action or Program
  -> Observation, State Delta, Outcome, and learning signals
```

Serializing this unit as text for a particular model does not turn the source semantics into a chat
transcript. A training adapter MUST retain enough references to relate serialized inputs and
targets back to the structured transition.

### 12.2 Targets and masks

An AT-Training Episode MUST declare which fields are:

- model inputs;
- supervised targets;
- environment outputs;
- metadata only;
- excluded from loss;
- unavailable, redacted, or unknown.

Consumers MUST NOT train on a field solely because it is present. Presence, visibility, training
permission, and loss participation are separate declarations.

### 12.3 Process and terminal signals

Step-level signals MAY attribute value to a Node, Edge, branch, State Delta, or decision. Terminal
signals MAY apply to an Episode, Attempt, Objective, or external Outcome.

An exporter MUST NOT spread one terminal Reward uniformly across earlier Nodes unless the declared
Reward Policy explicitly performs that operation. Failed Trajectories MAY contain useful actions;
successful Trajectories MAY contain wasteful or unsafe actions.

## 13. Transformation, redaction, and rights

### 13.1 Transformation lineage

Every derived Bundle MUST identify its immediate source Bundle or source authority when permitted,
the transformation implementation and version, and all material operations such as selection,
normalization, retokenization, redaction, labeling, merging, or reward derivation.

A transformation MUST NOT silently upgrade `partial` or `open` data to `complete`.

### 13.2 Redaction and omission

Redaction MUST preserve causal shape where permitted. A redacted value MUST remain distinguishable
from an absent, empty, false, failed, or unknown value.

Producers SHOULD avoid publishing digests of low-entropy secrets because such digests may permit
offline guessing. Credentials, private keys, raw secrets, and unnecessary personal data MUST NOT be
included in a portable Bundle.

### 13.3 Rights declaration

The rights declaration MUST independently state whether the Bundle may be:

- retained;
- used for local evaluation;
- used for hosted evaluation;
- used for model or policy training;
- redistributed in original form;
- redistributed in transformed or aggregated form.

Unknown rights MUST NOT be interpreted as permission. A derived Dataset MUST NOT expand the rights
granted by its sources.

## 14. Serialization and extensions

The v0.1 exchange representation is UTF-8 JSON. Object-key order is not semantic. Array order is
semantic only where a field explicitly declares it. Identifiers and enumerated states are strings.
Timestamps use RFC 3339 when present.

Every Bundle MUST declare `spec_version`; unlike ephemeral source syntax, a persistent interchange
artifact requires explicit version negotiation. Consumers MUST reject an unsupported required
Profile and MUST NOT guess its semantics from field shape.

Extensions MUST use a collision-resistant namespace. An extension MUST NOT redefine a Core field.
Consumers MAY preserve and ignore unknown OPTIONAL extensions. A producer that requires an
extension for correct interpretation MUST declare it as a required Profile or required extension.

A future canonical-signature Profile will define byte-level canonicalization. Until then, an
`integrity` declaration MUST identify the exact canonicalization used for any Bundle digest or
signature.

## 15. Export and interoperability

A conforming exporter MUST derive Bundle facts deterministically from the declared source state,
subject to declared nondeterministic redaction or access policy. It MUST record exporter version,
selection boundary, and transformation lineage.

Operational telemetry MAY be mapped to or from a Trace format. Training adapters MAY map Episodes
to external dataset formats. Such mappings MUST preserve the distinction between:

- operational span and causal Node;
- logged message and State View;
- tool request and committed Effect;
- successful call and achieved Outcome;
- Verifier Result and Reward Record.

Lossy mappings MUST declare which semantic classes were discarded or approximated.

## 16. Security and integrity

Implementations MUST treat imported Agent Trajectories as untrusted data. Import MUST NOT execute
embedded programs, follow external references, invoke tools, restore capabilities, or trust
signatures without explicit validation and policy.

Implementations SHOULD defend against:

- identifier collision and causal-reference substitution;
- forged Outcome, verifier, capability, or Effect Receipt authority;
- replay presented as new execution;
- malicious or oversized inline Artifacts;
- prompt injection embedded in historical content;
- rights laundering through derived Datasets;
- inference of redacted information from metadata, digests, timing, or graph shape.

Signing proves control of a signing key; it does not prove that an Outcome is true or that training
use is permitted.

## 17. Conformance claims

An implementation MAY claim conformance as:

- an **AT Producer**, which emits Bundles for a named Profile;
- an **AT Consumer**, which validates and interprets Bundles for a named Profile;
- an **AT Exporter**, which deterministically projects a named authoritative source into Bundles;
- an **AT Adapter**, which transforms Bundles or Episodes into a named external format.

Every claim MUST identify the specification version, Profiles, implementation version, known
limitations, and published conformance evidence. Passing AT-Core does not imply AT-Evaluation or
AT-Training conformance.

This Draft does not establish a compatibility mark and is not evidence that Morphz Runtime already
implements every requirement.

## 18. Non-goals

This specification does not:

- define consciousness, intelligence, or a universal measure of Agent quality;
- require all Agent state to be public or centrally hosted;
- require full Context snapshots at every step;
- make messages the canonical unit of Agent experience;
- require collection or disclosure of private reasoning;
- define one training algorithm, tokenizer, or scalar Reward;
- treat an Agent Trajectory as legal proof without an applicable legal and evidentiary framework;
- require independent implementations to copy Morphz Runtime scheduling or storage internals.

## Appendix A. Reference implementation artifacts

The Morphz reference implementation publishes two non-normative machine-readable serialization
schemas alongside this Draft:

- [Agent Trajectory Bundle v0.1 JSON Schema](schema/morphz_agent_trajectory_bundle_v0_1.schema.json);
- [Training Episode v0.1 JSON Schema](schema/morphz_training_episode_v0_1.schema.json).

The [reference implementation verification record](morphz_agent_trajectory_reference_implementation_verification_v0_1.md)
maps the implemented exporter, verifier, immutable Verifier/Reward facts, permission gate, Episode
derivation, and recovery behavior to executable tests. These artifacts describe the current Morphz
serialization and evidence; they do not turn the Draft into a Final standard or make the JSON
representation the only conforming encoding.

## Appendix B. Non-normative compact example

```json
{
  "spec_version": "0.1",
  "profiles": ["AT-Core", "AT-Evaluation", "AT-Training"],
  "trajectory_id": "at:example:objective-42:attempt-2",
  "source": {
    "implementation": "Morphz Runtime",
    "exporter_version": "0.1.0",
    "authority_revision": "context-7@184"
  },
  "scope": {
    "objective_ids": ["objective-42"],
    "attempt_ids": ["attempt-2"],
    "selection": "attempt causal closure"
  },
  "completeness": { "status": "partial", "reason": "private user content redacted" },
  "bindings": {
    "harness": "sha256:harness-content-id",
    "program": "sha256:yao-program-id",
    "model": "provider:model:policy-revision",
    "environment": "env:repo-task:v3"
  },
  "states": [
    { "state_id": "state:17", "context_revision": 17, "availability": "referenced" },
    { "state_id": "state:18", "context_revision": 18, "availability": "referenced" }
  ],
  "nodes": [
    {
      "node_id": "node:decision-1",
      "kind": "decision",
      "actor": "agent:morphz-001",
      "state_before": "state:17",
      "read_set": ["frame:plan@4", "observation:test-failure"],
      "action": { "kind": "yao_program", "artifact": "sha256:yao-program-id" },
      "state_after": "state:18",
      "status": "committed"
    }
  ],
  "edges": [],
  "outcomes": [
    {
      "outcome_id": "outcome:1",
      "scope": "objective-42",
      "producer": "runtime:morphz",
      "authority_class": "runtime",
      "status": "succeeded",
      "terminal": true,
      "evidence_refs": ["receipt:test-run-9"]
    }
  ],
  "verifier_results": [
    {
      "verifier_result_id": "verify:1",
      "verifier": "repo-tests:v3",
      "checked_property": "declared test suite passes",
      "evidence_refs": ["receipt:test-run-9"],
      "status": "pass"
    }
  ],
  "reward_records": [
    {
      "reward_id": "reward:1",
      "policy": "tests-and-cost:v1",
      "sources": ["verify:1"],
      "scope": "objective-42",
      "attribution_target": "attempt-2",
      "signal_type": "scalar",
      "value": 0.91,
      "aggregation": "policy-defined weighted sum",
      "producer": "evaluator:newvar-baseline",
      "created_at": "2026-08-21T12:00:00Z",
      "timing": "retrospective"
    }
  ],
  "transform": {
    "exporter": "morphz-at-exporter@0.1.0",
    "operations": ["attempt_selection", "user_content_redaction"]
  },
  "disclosure": { "private_reasoning": "not_collected", "user_content": "redacted" },
  "rights": {
    "retention": true,
    "local_evaluation": true,
    "hosted_evaluation": false,
    "training": false,
    "redistribution_original": false,
    "redistribution_transformed": false
  },
  "integrity": { "status": "not_provided" },
  "extensions": {}
}
```

The example is intentionally compact rather than a complete fixture. The adjacent reference JSON
Schema describes the implemented serialization. Normative fixtures remain work for a future Agent
Trajectory Conformance Suite.
