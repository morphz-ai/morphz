# Morphz Conformance Suite v1

> Status: Draft suite definition; standalone public runner not yet extracted
>
> Steward: Newvar
>
> Canonical language: English
>
> Date: 2026-08-21
>
> Chinese translation: [zh-CN](zh-CN/morphz_conformance_suite_v1.md)

## 1. Purpose

The Conformance Suite turns the Structured Context Specification into independently reproducible
behavior. It has three goals:

1. prevent Morphz Runtime from drifting away from the Specification;
2. allow independent implementations to demonstrate compatible behavior;
3. make compatibility an evidence-backed claim rather than a branding assertion.

Conformance measures protocol behavior. It does not certify the quality, safety, security, or
intelligence of an Agent or Runtime.

## 2. Normative language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD
NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY**, and **OPTIONAL** in this document are to be
interpreted as described in BCP 14, [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119.html) and
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174.html), when, and only when, they appear in all
capitals.

## 3. Public and official layers

### 3.1 Open base suite

The normative base suite MUST be open source and runnable without a Newvar cloud account. It MUST
contain the fixtures, expected state transitions, failure cases, and report schema needed to verify
each public requirement.

No hidden test may be the sole definition of a normative semantic rule.

### 3.2 Official verification

Newvar MAY provide an official verification service containing additional interoperability,
long-running, adversarial, resource-pressure, and security tests. These tests MAY protect exact
fixtures against gaming, but every failure MUST map to a published Specification requirement.

Passing the open suite permits a factual claim such as "passes Morphz SC-Core v1 self-test." Use of
an official compatibility mark requires the separate trademark policy and a signed official report.

## 4. Target interface

The standalone runner SHOULD test an implementation through a small adapter rather than importing
Morphz Runtime internals. An adapter MUST expose equivalent operations for:

- create and reopen a Context;
- append and read Events;
- read the current Context revision and Projections;
- submit Context transactions;
- create, mount, retire, and restore Sessions as required by the profile;
- inject deterministic failures at documented transaction boundaries;
- restart the implementation;
- run concurrent operations;
- export a conformance report.

Reference adapters MAY be provided for the Morphz RuntimeStore, HTTP API, and future SDKs.

## 5. Test groups

### C1: Identity and lifecycle

- Context, Agent, Principal, Session, Event, and Frame identifiers remain stable across applicable
  reads and restarts;
- Principal, Session, Context, and Agent identities are not substituted for one another;
- retiring a Session changes Attention state without deleting its history.

### C2: Event immutability and ordering

- committed Events cannot be mutated in place;
- Event order is deterministic within its declared authority domain;
- corrections append new Events;
- direct causal references survive replay where the claimed profile includes replay.

### C3: Frame operations

- create, derive, revise, retire, restore, protect, unprotect, place, relate, and unrelate produce
  the specified state transitions;
- revise preserves Frame identity and increments revision;
- retired Frames disappear from the active Projection but remain recoverable;
- protected Frames cannot be retired without the required transition and audit reason;
- declared sources remain attached to derived cognition.

### C4: Transaction atomicity

- a valid multi-operation transaction commits all changes and one coherent revision;
- a syntactic, permission, reference, or lifecycle failure commits none of them;
- Event History and all affected Projections agree after commit.

### C5: Conflict and rebase

- **C5.1:** incompatible writes to the same Frame revision cannot silently overwrite one another;
- **C5.2:** creating the same stable Frame identifier with different content is rejected;
- **C5.3:** an invalidated declared source causes rejection;
- **C5.4:** independent Frame writes either conflict conservatively or rebase safely without
  corrupting either change;
- **C5.5 (reserved):** checkpoint and rollback fencing has no active conformance case until a
  profile defines their portable semantics.

### C6: Reality and provenance

- Runtime facts and Agent-authored conclusions remain observably distinguishable;
- a source Event cannot be referenced before it exists or outside its authorization and Causal
  Scope;
- previews remain distinguishable from full source content;
- derived Frames preserve declared evidence references;
- Runtime facts cannot be rewritten through an Agent-owned transaction;
- recency, frequency, usage, or latest-version status alone does not label an Observation
  semantically authoritative.

### C7: Attention and recall

- Projection exclusion, retirement, and deletion remain observably distinct;
- recall resolves stable references to the correct original source;
- resource pressure does not silently author or rewrite semantic Frame content.

### C8: Session and causal routing

- different authorized Sessions can share committed Mind without sharing unrelated local evidence;
- late results return to the declared Causal Scope or Evaluation that created them;
- explicit cross-Session delivery preserves source and destination;
- concurrent work does not widen the evidence or authority available to an Evaluation.

### C9: Durability, retry, and recovery

- committed transactions survive restart;
- pre-commit failure leaves the old state intact;
- post-commit failure reconstructs the committed state;
- Projection rebuild equals the authoritative current state;
- retrying a transaction with a stable request or transaction identity does not create duplicate
  effects;
- interrupted leases or work ownership obey the selected distributed profile.

### C10: Versioning and extension negotiation

- version reports identify the Specification, Suite, implementation, and profile exactly;
- unknown optional extensions are handled according to negotiation rules;
- unsupported required extensions fail visibly.

### C11: Canonical representation (reserved)

No canonical byte fixtures are active while Specification section 10 remains reserved.
Byte-for-byte serialization equality MUST NOT be required for Draft conformance. C11 becomes active
only with a matching versioned Specification definition and fixture set.

### C12: Security boundaries

- unauthorized Context, Session, source, recall, and cross-Session access fails visibly;
- forged or guessed stable references do not bypass authorization;
- replay with a stable request identity cannot duplicate committed effects in profiles requiring
  idempotency;
- resource exhaustion does not silently rewrite semantic state;
- reports and diagnostics do not expose configured test credentials or secrets.

## 6. Profile matrix

| Test group | SC-Core | SC-Durable | SC-Concurrent | SC-Distributed |
| --- | :---: | :---: | :---: | :---: |
| C1 Identity and lifecycle | required | required | required | required |
| C2 Event immutability | required | required | required | required |
| C3 Frame operations | required | required | required | required |
| C4 Transaction atomicity | required | required | required | required |
| C5.1-C5.4 Conflict and rebase | required | required | required | required |
| C5.5 Checkpoint/rollback fencing | reserved | reserved | reserved | reserved |
| C6 Reality and provenance | required | required | required | required |
| C7 Attention and recall | required | required | required | required |
| C8 Session and causal routing | optional | optional | required | required |
| C9 Durability, retry, and recovery | optional | required | required | required |
| C10 Versioning/extensions | required | required | required | required |
| C11 Canonical representation | reserved | reserved | reserved | reserved |
| C12 Security boundaries | required | required | required | required |
| Multi-process lease/fencing cases | optional | optional | optional | required |

"Required" means every active case in the group MUST pass. "Optional" means the group does not
affect the selected profile claim but any reported result MUST be truthful. "Reserved" means no
conformance claim may depend on the group until a later Specification and Suite release activates
it.

## 7. Report format

Every run MUST produce a machine-readable report containing at least:

```json
{
  "specification": "morphz-structured-context/1.0.0-draft",
  "suite": "morphz-conformance/1.0.0-draft",
  "profile": "SC-Core",
  "implementation": {
    "name": "example-runtime",
    "version": "0.1.0",
    "revision": "source-revision-or-build-id"
  },
  "environment": {
    "adapter": "adapter-name-and-version",
    "storage": "implementation-defined"
  },
  "started_at": "RFC3339 timestamp",
  "results": [],
  "summary": {
    "passed": 0,
    "failed": 0,
    "skipped": 0
  }
}
```

Skipped required tests make the selected profile incomplete. Reports SHOULD also include a
human-readable summary and enough deterministic evidence to reproduce failures without exposing
secrets.

## 8. Compatibility claims

Permitted claims MUST identify all three versions: Specification, Suite, and profile. "Morphz
compatible" without versions is not a sufficient technical claim.

An implementation loses an official claim when:

- its released artifact differs from the tested artifact;
- a required test was skipped or disabled;
- the signed report expires under a future certification policy;
- a material security or semantic defect invalidates the result.

The compatibility mark and the Morphz name are governed separately from source-code and
specification-text licenses. The provisional [IPR Status Notice](IPR_STATUS.md) grants no mark or
certification right.

## 9. Current implementation mapping

Morphz Runtime already contains important internal predecessors:

- `morphz/tests/runtime_store_conformance.rs` exercises SQLite/PostgreSQL RuntimeStore behavior;
- Scheduler Kernel tests cover authoritative transitions and backend parity;
- attempt-loop tests cover Context transaction failure, deduplication, and continuation;
- long-run and context-pressure evaluations observe Context behavior over real model trajectories.

These tests are evidence and extraction sources, not yet the standalone public suite. Before
claiming SC-Core v1 conformance, Newvar MUST:

1. map each normative requirement to a stable test identifier;
2. remove assumptions that require private Morphz Runtime types where observable behavior is
   sufficient;
3. publish at least one external adapter boundary;
4. produce a clean signed report against a released Morphz Runtime artifact;
5. publish final source-code, specification-text, patent, contribution, compatibility, and trademark
   policies.

## 10. Suite evolution and errata

Changing expected normative behavior requires an accepted Standards Track MEP and a matching
Specification change. Adding coverage for existing behavior MAY use a normal pull request when the
new test cannot change the result of a previously conformant implementation without exposing an
actual Specification violation.

Every conformance test MUST link to the exact Specification requirement it verifies. Suspected
errors follow the public errata and interpretation process in
[MEP-0001](../meps/MEP-0001-specification-governance.md).
