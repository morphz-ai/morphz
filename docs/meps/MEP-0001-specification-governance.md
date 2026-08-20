# MEP-0001: Specification Governance and MEP Process

- Status: Draft
- Type: Process
- Author: Newvar
- Created: 2026-08-21
- Requires: Structured Context Constitution v1 Draft
- Chinese translation: [zh-CN](zh-CN/MEP-0001-specification-governance.md)

## 1. Summary

This proposal establishes Morphz Enhancement Proposals as the durable process for changing the
Structured Context standard, compatibility rules, core architecture, and project governance.

MEPs allow community members to shape Morphz without turning core semantic evolution into either an
undocumented company decision or an unbounded repository vote.

## 2. When an MEP is required

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

## 3. MEP types

- **Constitutional**: changes a constitutional principle.
- **Standards Track**: changes normative behavior, compatibility, or a conformance profile.
- **Architecture**: establishes a stable cross-module design or extension boundary.
- **Process**: changes governance, contribution, release, or MEP procedure.
- **Informational**: records guidance or rationale without creating a normative requirement.

## 4. Required document sections

Every non-informational MEP MUST include:

1. summary and motivation;
2. current behavior and problem statement;
3. proposed semantics;
4. authority and security implications;
5. compatibility and migration plan;
6. reference implementation plan;
7. conformance and evaluation plan;
8. rejected alternatives;
9. unresolved questions;
10. rollout and rollback conditions.

A Standards Track MEP cannot reach Final status until the specification change, reference
implementation, and required conformance cases are merged or the MEP explicitly defines a staged
activation version.

## 5. Lifecycle

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

## 6. Submission and review

1. The author opens an issue or discussion to test scope and find a sponsoring Maintainer.
2. A sponsoring Maintainer assigns the next MEP number.
3. The author submits the document under `docs/meps/`.
4. Core Maintainers classify the proposal and identify affected specification and conformance
   sections.
5. Formal Discussion remains open for a reasonable review period. Fourteen calendar days is the
   default for Standards Track proposals; the Project Lead MAY shorten it before the first stable
   release when the reason is recorded.
6. The responsible Maintainers summarize objections, alternatives, and required changes.
7. The approval authority changes the status and records the decision.

Review is based on technical merit, constitutional alignment, compatibility cost, evidence, and
ecosystem impact. It is not decided by comment count or a simple majority vote.

## 7. Approval authority

| MEP type | Required approval |
| --- | --- |
| Informational | sponsoring Maintainer |
| Architecture | responsible Module Maintainers plus one Core Maintainer |
| Standards Track | Core Maintainer review plus Project Lead approval |
| Process | Core Maintainer review plus Project Lead approval |
| Constitutional | Core Maintainer review plus explicit Project Lead approval |

The Project Lead MAY delegate routine Architecture decisions but cannot silently delegate ownership
of the Constitution, official compatibility mark, or release identity.

## 8. Community authorship and maintenance

An MEP belongs to its recorded authors, not to the sponsoring Maintainer. Meaningful co-authorship
MUST be preserved through later revisions. An accepted MEP SHOULD identify maintainers for its
implementation and conformance coverage.

Authors do not gain permanent unilateral control over the resulting standard. They gain recognized
authorship and may earn scoped Maintainer authority through sustained work.

## 9. Experimental extensions

Experiments MAY proceed before an MEP is accepted when they:

- use an explicit experimental namespace or feature gate;
- do not claim stable compatibility;
- do not alter existing normative behavior by default;
- publish removal or migration expectations.

Successful experiments require an MEP before becoming part of the stable standard.

## 10. Emergency changes

The Project Lead and Security Team MAY temporarily change or disable behavior to contain an active
security, data-loss, or ecosystem integrity incident. The change MUST be narrowly scoped.

When disclosure becomes safe, the project MUST publish the affected requirements, rationale,
compatibility impact, and either a retrospective MEP or a rollback plan.

## 11. Rationale

Morphz needs both coherence and participation. Purely private control would make the public standard
untrustworthy; unrestricted voting would make early core semantics vulnerable to transient
majorities and incompatible implementations.

The MEP process therefore gives contributors a visible route to authorship, review, and scoped
authority while keeping Newvar accountable for the coherence of the official Structured Context
standard and reference implementation.
