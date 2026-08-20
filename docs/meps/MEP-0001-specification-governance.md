# MEP-0001: Specification Governance and MEP Process

- Status: Draft
- Type: Process
- Author: Newvar
- Created: 2026-08-21
- Bootstrap set: Constitution v1 Draft, Governance Draft, Specification v1 Draft, Suite v1 Draft
- Canonical language: English
- Chinese translation: [zh-CN](zh-CN/MEP-0001-specification-governance.md)

## 1. Summary

This proposal establishes Morphz Enhancement Proposals as the durable process for changing the
Structured Context standard, compatibility rules, core architecture, and project governance.

MEPs allow community members to shape Morphz without turning core semantic evolution into either an
undocumented company decision or an unbounded repository vote.

## 2. Initial bootstrap

The first Constitution, Governance document, MEP-0001, Draft Specification, and Draft Conformance
Suite are adopted together by Newvar as the founding bootstrap set. This simultaneous adoption
resolves the otherwise circular requirement that the process must already exist before it can adopt
itself.

Bootstrap adoption does not make a Draft specification Final, does not establish a compatibility
claim, and does not grant intellectual-property rights. After the bootstrap set is adopted, every
later change MUST follow the process and authority rules it establishes.

## 3. When an MEP is required

An MEP is required for:

- a Constitution amendment;
- new or changed normative Structured Context behavior;
- a breaking public API, wire, persistence, or compatibility change;
- a new conformance profile or compatibility claim rule;
- a stable cross-module extension point;
- a change to governance, maintainer authority, or the MEP process itself;
- a decision the Project Lead designates as ecosystem-wide.

An MEP is normally not required for:

- bug fixes that restore already specified behavior;
- implementation refactoring with no observable semantic effect;
- individual Provider, Target, Harness, UI, or documentation additions inside a stable extension
  boundary;
- experiments that are explicitly namespaced and disabled from compatibility claims.

## 4. MEP types

- **Constitutional**: changes a constitutional principle.
- **Standards Track**: changes normative behavior, compatibility, or a conformance profile.
- **Architecture**: establishes a stable cross-module design or extension boundary.
- **Process**: changes governance, contribution, release, or MEP procedure.
- **Informational**: records guidance or rationale without creating a normative requirement.

## 5. Required document sections

Every non-informational MEP MUST include:

1. summary and motivation;
2. current behavior and problem statement;
3. proposed semantics;
4. authority and security implications;
5. intellectual-property and patent implications;
6. compatibility and migration plan;
7. reference implementation plan;
8. conformance and evaluation plan;
9. rejected alternatives;
10. unresolved questions;
11. rollout and rollback conditions.

A Standards Track MEP cannot reach Final status until the Specification change, Morphz Runtime
change, and required conformance cases are merged, or the MEP explicitly defines a staged activation
version. A change affecting essential patent claims, licensing, compatibility marks, or contributor
commitments also requires the corresponding published policy update before Final status.

## 6. Lifecycle

```text
Idea → Draft → Discussion → Accepted → Final
                  ├────────→ Rejected
                  └────────→ Withdrawn
Final ──────────────────────→ Superseded
```

- **Idea**: informal issue or discussion; no MEP number required.
- **Draft**: complete enough for architectural review and assigned an MEP number.
- **Discussion**: the responsible Maintainer has opened formal review.
- **Accepted**: the semantic direction is approved; implementation may still be incomplete.
- **Final**: all activation requirements have been satisfied.
- **Rejected**: reviewed and declined with rationale.
- **Withdrawn**: closed by the author before a final decision.
- **Superseded**: replaced by a newer Final MEP.

Merged Draft or Accepted text is not automatically normative. Only the resulting versioned
Constitution or Specification release establishes normative behavior.

## 7. Submission and review

1. The author opens an issue or discussion to test scope and find a sponsoring Maintainer.
2. A sponsoring Maintainer assigns the next MEP number.
3. The author submits the document under `docs/meps/`.
4. Core Maintainers classify the proposal and identify affected Specification and conformance
   sections.
5. Formal Discussion remains open for a reasonable review period. Fourteen calendar days is the
   default for Standards Track proposals; the Project Lead MAY shorten it before the first stable
   release when the reason is recorded.
6. The responsible Maintainers summarize objections, alternatives, and required changes.
7. The approval authority changes the status and records the decision.

Review is based on technical merit, constitutional alignment, compatibility cost, evidence,
security, intellectual-property effects, and ecosystem impact. It is not decided by comment count
or a simple majority vote.

## 8. Approval authority

| MEP type | Required approval |
| --- | --- |
| Informational | sponsoring Maintainer |
| Architecture | responsible Module Maintainers plus one Core Maintainer |
| Standards Track | Core Maintainer review plus Project Lead approval |
| Process | Core Maintainer review plus Project Lead approval |
| Constitutional | Core Maintainer review plus explicit Project Lead approval |

The Project Lead MAY delegate routine Architecture decisions but cannot silently delegate ownership
of the Constitution, official compatibility mark, or release identity.

## 9. Errata and authoritative interpretations

Suspected errors and ambiguities MUST be recorded in a public issue or errata registry and linked to
the affected document version.

- A Maintainer MAY merge an editorial correction that cannot change conformant behavior. The change
  MUST be recorded as errata and included in the next patch release.
- An ambiguity that could change implementation behavior or conformance results requires a public
  interpretation. The Project Lead MAY issue a recorded interim interpretation after Core
  Maintainer review.
- An interpretation that adds or changes a normative requirement, profile membership, wire
  behavior, or compatibility result requires a Standards Track MEP and a versioned normative
  release. The interim interpretation MUST NOT silently redefine an already released version.

## 10. Community authorship and maintenance

An MEP belongs to its recorded authors, not to the sponsoring Maintainer. Meaningful co-authorship
MUST be preserved through later revisions. An accepted MEP SHOULD identify maintainers for its
implementation and conformance coverage.

Authors do not gain permanent unilateral control over the resulting standard. They gain recognized
authorship and may earn scoped Maintainer authority through sustained work.

## 11. Experimental extensions

Experiments MAY proceed before an MEP is accepted when they:

- use an explicit experimental namespace or feature gate;
- do not claim stable compatibility;
- do not alter existing normative behavior by default;
- publish removal or migration expectations.

Successful experiments require an MEP before becoming part of the stable standard.

## 12. Emergency changes

The Project Lead and Security Team MAY temporarily change or disable behavior to contain an active
security, data-loss, or ecosystem integrity incident. The change MUST be narrowly scoped.

When disclosure becomes safe, the project MUST publish the affected requirements, rationale,
compatibility impact, and either a retrospective MEP or a rollback plan.

## 13. Rationale

Morphz needs both coherence and participation. Purely private control would make the public standard
untrustworthy; unrestricted voting would make early core semantics vulnerable to transient
majorities and incompatible implementations.

The MEP process therefore gives contributors a visible route to authorship, review, and scoped
authority while keeping Newvar accountable for the coherence of the official Structured Context
standard and Morphz Runtime.
