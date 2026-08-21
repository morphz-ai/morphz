# Contributing to Morphz

## Standards and governance

Morphz uses founder-led open governance. Before changing Structured Context semantics, public
compatibility, cross-module architecture, or project governance, read [GOVERNANCE.md](GOVERNANCE.md)
and [MEP-0001](docs/meps/MEP-0001-specification-governance.md). Such changes require a Morphz
Enhancement Proposal rather than an implementation-only pull request.

The Draft standard workspace is indexed at
[docs/standards/README.md](docs/standards/README.md). Until a document reaches Final status, the
current source code and contract tests remain authoritative for claims about implemented behavior.

Before contributing specification text, conformance fixtures, or code intended to implement the
Draft standard, read the provisional
[IPR Status Notice](docs/standards/IPR_STATUS.md). A contribution does not create an unrecorded
patent, trademark, or certification promise.

## Source language

Morphz uses English for identifiers, developer comments, doc comments, commit messages, raw
diagnostic logs, and protocol-facing Runtime error messages. This keeps the open-source codebase
searchable and gives persisted execution results, model-visible tool output, and support material
one canonical diagnostic language.

Non-English text remains appropriate when it is product content rather than developer prose:

- localized Dashboard, Setup, TUI, and CLI resources;
- language-specific tokenizer, parser, and retrieval fixtures;
- protocol examples whose language is the behavior under test;
- user-authored content and externally supplied data.

An intentional non-English Rust-comment example must include
`source-language: allow-non-english-example` on the same line. CI rejects other non-English Rust
comments.

## Diagnostic events and localization

Raw diagnostic logs are a machine and operator interface, not a localized UI:

- the message template is canonical English;
- operational warnings and errors carry a stable, namespaced `event_code` field;
- variable data belongs in structured fields rather than interpolated prose;
- an `event_code` describes one semantic condition and must not be reused for a different condition;
- changing user-facing wording does not rename the code.

Durable runtime Events continue to use their existing stable `event_type`. A diagnostic
`event_code` identifies a tracing record and does not replace a persisted Event.

Dashboard, Setup, TUI, and CLI may translate an event for users by mapping its stable code to an
i18n resource. They must preserve the code and structured fields in diagnostic details. This keeps
raw logs uniform while retaining localized product experiences.

The same boundary applies to returned errors that cross protocol or model boundaries. Protocol
implementations and model-visible execution paths emit canonical English. A localized product
surface may translate a stable error or diagnostic code, but must retain the canonical code and
English detail for debugging. Yao diagnostics use `DiagnosticCode` for this purpose; wording must
never be parsed as control flow. Readers may continue to recognize historical localized persisted
values for compatibility, but new writers must not produce them.
