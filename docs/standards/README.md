# Morphz Structured Context Standards

> Status: Draft standards workspace
>
> Steward: Newvar
>
> Last updated: 2026-08-21
>
> 中文翻译：[zh-CN](zh-CN/README.md)

This directory contains the public technical foundation through which Morphz intends to define,
implement, and verify structured context systems.

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

## Authority order

Once the first public specification is finalized, conflicts are resolved in this order:

1. the Constitution;
2. the current Final Structured Context Specification;
3. the matching Conformance Suite, which may verify but cannot redefine the Specification;
4. the official Morphz reference implementation;
5. Final Morphz Enhancement Proposals, explanatory design documents, and examples.

An MEP records and approves a change, but becomes normative only after the resulting requirement is
incorporated into a versioned Constitution or Specification release.

Until these documents leave Draft status, the source code, database contract tests, and the
[Runtime implementation status](../morphz_runtime_core_implementation_status_v1.md) remain the
authority for claims about what Morphz currently implements. A Draft requirement is not evidence
that the implementation already satisfies it.

## Language and publication

The Draft standards are written in English because they are intended to become globally consumable
normative documents. Chinese translations and explanatory material may be maintained separately.
Each release MUST identify one canonical language; translations cannot silently change normative
meaning.
