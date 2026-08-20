# Morphz Structured Context Standards

> Status: Draft standards workspace
>
> Steward: Newvar
>
> Canonical language: English
>
> Last updated: 2026-08-21
>
> 中文翻译：[zh-CN](zh-CN/README.md)

This directory contains the public technical foundation through which Morphz intends to define,
implement, and verify structured context systems.

## Naming roles

- **Structured Context** is the implementation-neutral technical category.
- **Morphz Structured Context** is the Newvar-stewarded standards family defined here.
- **Morphz Runtime** is Newvar's official reference implementation, not the definition of the
  standard.
- **Morphz SC Compatible** is a reserved future compatibility mark whose use will require a
  published trademark policy and qualifying conformance evidence.

Independent implementations may satisfy the observable standard without copying Morphz Runtime
internals. This Draft intentionally retains Morphz in the standards-family name while keeping the
category and conformance semantics implementation-independent.

## Deliverables

1. [Structured Context Constitution v1](structured_context_constitution_v1.md)
   defines the stable principles that give the category its identity.
2. [Morphz Structured Context Specification v1](morphz_structured_context_specification_v1.md)
   defines the normative object model, authority boundaries, transactions, and observable
   semantics.
3. [Morphz Conformance Suite v1](morphz_conformance_suite_v1.md)
   defines how independent implementations demonstrate compatibility.
4. [Project governance](../../GOVERNANCE.md) and
   [MEP-0001](../meps/MEP-0001-specification-governance.md) define how the standard and official
   implementation evolve.
5. [IPR Status Notice](IPR_STATUS.md) records the provisional copyright, patent, contribution, and
   trademark position while the documents remain Drafts.

## Authority order

The normative hierarchy is defined by Constitution section 4. As a non-normative index summary,
conflicts are resolved in this order:

1. the Constitution;
2. the current Final Structured Context Specification;
3. the matching Conformance Suite, which may verify but cannot redefine the Specification;
4. accepted Standards Track MEPs only after incorporation into a versioned normative release;
5. Morphz Runtime, the official reference implementation;
6. explanatory design documents and examples.

An MEP records and approves a change, but becomes normative only after the resulting requirement is
incorporated into a versioned Constitution or Specification release.

Until these documents leave Draft status, the source code, database contract tests, and the
[Runtime implementation status](../morphz_runtime_core_implementation_status_v1.md) remain the
authority for claims about what Morphz Runtime currently implements. They do not override the Draft
review target or turn implementation details into normative requirements. A Draft requirement is
not evidence that the implementation already satisfies it.

## Language and publication

The Draft standards use English as their canonical normative language because they are intended to
be globally consumable. Chinese translations and explanatory material are maintained separately.
Translations cannot silently change normative meaning; disagreements are resolved against the
identified English canonical document.
