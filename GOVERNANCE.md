# Morphz Project Governance

> Status: Draft for adoption before the public open-source launch
>
> Steward: Newvar
>
> Date: 2026-08-21
>
> Chinese translation: [zh-CN](GOVERNANCE.zh-CN.md)

## 1. Governance model

Morphz uses founder-led open governance during its formative stage. Discussion, proposals,
rationales, and compatibility effects are public. Final responsibility for the core Structured
Context standard and official releases remains with Newvar and the Project Lead.

Open source grants the right to use, study, modify, and fork the licensed code. It does not make all
technical decisions a vote, transfer the Morphz trademarks, or make a fork an official Morphz
release.

This model exists to keep the core semantics coherent while giving sustained contributors a real,
documented path to authority.

## 2. Project authorities

### Newvar

Newvar is the founding steward and is responsible for:

- the Morphz name, marks, domains, and official project identity;
- official repositories, documentation sites, registries, and release infrastructure;
- release signing keys and compatibility marks;
- appointment of the Project Lead and initial Core Maintainers;
- final stewardship of the Structured Context Constitution and public specification.

### Project Lead

The Project Lead is the final decision-maker for:

- Constitutional and Core Specification MEPs;
- official release scope and timing;
- disputes that cannot be resolved by the responsible Maintainers;
- emergency security and compatibility decisions;
- appointment or removal of Core Maintainers with a published rationale.

The Project Lead SHOULD seek rough consensus and MUST record the rationale for decisions that
override substantial maintainer consensus.

## 3. Contributor roles

### Contributor

Anyone who participates through issues, discussions, documentation, tests, design, code, or
community support.

### Reviewer

A trusted Contributor who can review a defined area but cannot merge without the responsible
Maintainer's approval.

### Module Maintainer

A Contributor with merge authority for an explicit module or extension surface, such as a Provider,
Execution Target, Harness, storage adapter, SDK, UI, evaluation, or documentation area.

### Core Maintainer

A Maintainer trusted to review changes to Structured Context semantics, Runtime authority,
transactions, Event/Projection behavior, compatibility, and release-critical infrastructure.

### Project Lead

The accountable architectural and release authority described above.

Roles are earned through sustained judgment, review quality, reliability, and alignment with the
published Constitution. Employment by Newvar is neither automatically sufficient nor always
required, although Newvar retains the stewardship rights listed in section 2.

## 4. Authority by change type

| Change | Normal approval |
| --- | --- |
| typo, example, or non-semantic documentation | area Maintainer |
| isolated bug fix with no protocol effect | module Maintainer |
| Provider, Target, Harness, UI, SDK, or adapter extension | responsible module Maintainer |
| new public extension point | Core Maintainer; MEP when ecosystem-wide |
| Structured Context normative behavior | accepted MEP plus Core Maintainer review |
| Constitution or governance | dedicated MEP plus Project Lead approval |
| official release and compatibility mark | Project Lead or delegated Release Maintainer |
| embargoed security response | Security Team under the emergency process |

No implementation pull request can silently change a normative requirement. A core behavior change
MUST update the specification, conformance coverage, and migration statement together.

## 5. Morphz Enhancement Proposals

MEPs are required for changes that affect:

- constitutional principles;
- public Structured Context semantics;
- compatibility or version negotiation;
- cross-module architecture and stable extension boundaries;
- the conformance profiles or official claim rules;
- project governance.

Ordinary implementation work does not require an MEP. The complete process is defined in
[MEP-0001](docs/meps/MEP-0001-specification-governance.md).

## 6. Contributor path to authority

Morphz intends to make upstream contribution more valuable than maintaining a divergent fork.
Accordingly, the project SHOULD provide:

- timely public review and visible ownership of pending work;
- authorship credit on MEPs, releases, and major documentation;
- scoped merge authority for proven Module Maintainers;
- an official extension registry and compatibility matrix;
- clear promotion and inactivity rules;
- a path from extension maintenance to Core Maintainer review responsibility.

Authority is scoped rather than all-or-nothing. A leading Provider Maintainer need not control core
Context semantics, while a Core Maintainer does not automatically control every community module.

## 7. Core and extension boundaries

The core contains the Constitution, normative Structured Context semantics, Context transactions,
Event/Projection authority, causal routing, compatibility, and the minimal reference Runtime needed
to verify them.

Providers, Execution Targets, Harnesses, domain packages, storage adapters, SDKs, UI, deployment,
and evaluations are extension surfaces unless a Final MEP places a specific semantic requirement in
the core.

Extensions MAY move quickly. The core SHOULD change slowly and only with specification evidence,
conformance cases, and migration analysis.

## 8. Releases and official status

An official release MUST:

- originate from an official Newvar-controlled repository;
- identify the source revision and applicable specification version;
- be signed through the official release process;
- publish compatibility and migration notes;
- pass the release's required test and conformance gates.

Forks may use the open-source license according to its terms. They may not present themselves as an
official Morphz release or use compatibility marks outside the future trademark policy.

## 9. Transparency and conflicts

Maintainers MUST disclose material conflicts when reviewing a proposal that privileges their own
commercial service, employer, or implementation. A conflict does not automatically disqualify a
Maintainer, but the decision and additional reviewers MUST be visible.

Private discussion is appropriate for embargoed security reports, personal conduct matters, legal
obligations, and unreleased credentials. Semantic and compatibility decisions MUST return to a
public durable record when the embargo or confidentiality need ends.

## 10. Inactivity and removal

Maintainer status reflects active responsibility, not permanent ownership. A Maintainer may move to
emeritus status after sustained inactivity. Removal for security, conduct, or repeated breach of
project responsibility requires a recorded decision by the Project Lead; sensitive personal detail
need not be published.

## 11. Future governance

Founder-led governance is not declared permanent. A future MEP may introduce a technical steering
council, independent standards body, or foundation when ecosystem adoption makes neutrality more
valuable than concentrated early-stage coherence.

No future transition is implied merely by contributor count, funding, or elapsed time. It requires
an explicit proposal defining trademark, release, specification, and infrastructure authority.
