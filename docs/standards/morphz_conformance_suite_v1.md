# Morphz Conformance Suite v1

> Status: Draft suite definition; standalone public runner not yet extracted
>
> Steward: Newvar
>
> Date: 2026-08-21
>
> Chinese translation: [zh-CN](zh-CN/morphz_conformance_suite_v1.md)

## 1. Purpose

The Conformance Suite turns the Structured Context Specification into independently reproducible
behavior. It has three goals:

1. prevent the official Morphz implementation from drifting away from the specification;
2. allow independent implementations to demonstrate compatible behavior;
3. make compatibility an evidence-backed claim rather than a branding assertion.

Conformance measures protocol behavior. It does not certify the quality, safety, or intelligence of
an Agent built on top of the protocol.

## 2. Public and official layers

### 2.1 Open base suite

The normative base suite MUST be open source and runnable without a Newvar cloud account. It MUST
contain the fixtures, expected state transitions, failure cases, and report schema needed to verify
each public requirement.

No hidden test may be the sole definition of a normative semantic rule.

### 2.2 Official verification

Newvar MAY provide an official verification service containing additional interoperability,
long-running, adversarial, resource-pressure, and security tests. These tests MAY protect exact
fixtures against gaming, but every failure MUST map to a published specification requirement.

Passing the open suite permits a factual claim such as "passes Morphz SC-Core v1 self-test."
Use of an official compatibility mark requires the separate trademark policy and a signed official
report.

## 3. Target interface

The standalone runner should test an implementation through a small adapter rather than importing
Morphz internals. An adapter MUST expose equivalent operations for:

- create and reopen a Context;
- append and read Events;
- read the current Context revision and Projections;
- submit Context transactions;
- create, mount, retire, and restore Sessions as required by the profile;
- inject deterministic failures at documented transaction boundaries;
- restart the implementation;
- run concurrent operations;
- export a canonical conformance report.

Reference adapters MAY be provided for the Morphz Rust RuntimeStore, HTTP API, and future SDKs.

## 4. Required test groups

### C1: Identity and lifecycle

- Context, Agent, Session, Event, and Frame identifiers remain stable across reads and restart.
- Session identity is not substituted for Context or Agent identity.
- Retiring a Session changes attention state without deleting its history.

### C2: Event immutability and ordering

- committed Events cannot be mutated in place;
- Event order is deterministic within its declared authority domain;
- corrections append new Events;
- direct causal references survive replay.

### C3: Frame operations

- create, derive, revise, retire, restore, protect, unprotect, place, relate, and unrelate produce
  the specified state transitions;
- revise preserves Frame identity and increments revision;
- retired Frames disappear from the active projection but remain recoverable;
- protected Frames cannot be retired without the required transition and audit reason;
- declared sources remain attached to derived cognition.

### C4: Transaction atomicity

- a valid multi-operation transaction commits all changes and one coherent revision;
- a syntactic, permission, reference, or lifecycle failure commits none of them;
- Event History and all affected Projections agree after commit;
- retrying an idempotent transaction does not create duplicate effects.

### C5: Conflict and rebase

- incompatible writes to the same Frame cannot silently overwrite one another;
- independent Frame writes may either conflict conservatively or rebase safely according to the
  declared profile;
- an invalidated declared source causes rejection;
- global rollback and checkpoint operations use an adequate Context-level fence.

### C6: Reality and provenance

- a source Event cannot be referenced before it exists or outside its authorization scope;
- previews remain distinguishable from full source content;
- derived Frames preserve declared evidence references;
- Runtime facts cannot be rewritten through an Agent-owned transaction.

### C7: Attention and recall

- projection exclusion, retirement, and deletion remain observably distinct;
- recall resolves stable references to the correct original source;
- resource pressure does not silently author or rewrite semantic Frame content.

### C8: Session and causal routing

- different authorized Sessions can share committed Mind without sharing unrelated local evidence;
- late results return to the causal Thread or Activation that created them;
- explicit cross-Session delivery preserves source and destination;
- concurrent work cannot commit more than one terminal outcome for the same activation identity.

### C9: Durability and recovery

- committed transactions survive restart;
- pre-commit failure leaves the old state intact;
- post-commit failure reconstructs the committed state;
- Projection rebuild equals the authoritative current state;
- interrupted leases or work ownership obey the selected distributed profile.

### C10: Canonical representation and versioning

- canonical fixtures serialize byte-for-byte identically;
- unknown optional extensions are handled according to negotiation rules;
- unsupported required extensions fail visibly;
- version reports identify the specification, suite, implementation, and profile exactly.

## 5. Profile matrix

| Test group | SC-Core | SC-Durable | SC-Concurrent | SC-Distributed |
| --- | :---: | :---: | :---: | :---: |
| C1 Identity and lifecycle | required | required | required | required |
| C2 Event immutability | required | required | required | required |
| C3 Frame operations | required | required | required | required |
| C4 Transaction atomicity | required | required | required | required |
| C5 Conflict and rebase | basic | basic | required | required |
| C6 Reality and provenance | required | required | required | required |
| C7 Attention and recall | required | required | required | required |
| C8 Session and causal routing | optional | optional | required | required |
| C9 Durability and recovery | optional | required | required | required |
| C10 Representation/versioning | required | required | required | required |
| Multi-process lease/fencing cases | optional | optional | optional | required |

"Basic" means stale incompatible writes MUST be rejected; safe automatic rebase is not required.

## 6. Report format

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

Skipped required tests make the selected profile incomplete. Reports SHOULD also include a human
readable summary and enough deterministic evidence to reproduce failures without exposing secrets.

## 7. Compatibility claims

Permitted claims MUST identify all three versions: specification, suite, and profile. "Morphz
compatible" without versions is not a sufficient technical claim.

An implementation loses an official claim when:

- its released artifact differs from the tested artifact;
- a required test was skipped or disabled;
- the signed report expires under the future certification policy;
- a material security or semantic defect invalidates the result.

The compatibility mark and the Morphz name are governed separately from the open-source code
license.

## 8. Current implementation mapping

Morphz already contains important internal predecessors:

- `morphz/tests/runtime_store_conformance.rs` exercises SQLite/PostgreSQL RuntimeStore behavior;
- Scheduler Kernel tests cover authoritative transitions and backend parity;
- attempt-loop tests cover Context transaction failure, deduplication, and continuation;
- long-run and context-pressure evaluations observe Context behavior over real model trajectories.

These tests are evidence and extraction sources, not yet the standalone public suite. Before
claiming SC-Core v1 conformance, Newvar MUST:

1. map each normative requirement to a stable test identifier;
2. remove assumptions that require private Morphz types where observable behavior is sufficient;
3. publish at least one external adapter boundary;
4. produce a clean signed report against a released Morphz artifact;
5. publish the compatibility and trademark policy.

## 9. Suite evolution

Changing expected normative behavior requires an accepted MEP and a matching specification change.
Adding coverage for existing behavior may use a normal pull request when the new test cannot change
the result of a previously conformant implementation without exposing an actual specification
violation.

Every conformance test MUST link to the exact specification requirement it verifies.
