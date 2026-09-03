# Contributing to Morphz

## Standards and governance

Morphz uses founder-led open governance. Before changing Structured Context semantics, public
compatibility, cross-module architecture, or project governance, read [GOVERNANCE.md](GOVERNANCE.md)
and [MEP-0001](docs/meps/MEP-0001-specification-governance.md). Such changes require a Morphz
Enhancement Proposal rather than an implementation-only pull request.

The Draft standard workspace is indexed at
[docs/standards/README.md](docs/standards/README.md). Until a document reaches Final status, the
current source code and contract tests remain authoritative for claims about implemented behavior.

Before contributing specification text, conformance fixtures, or code intended to implement a
Draft standard, read the active [IPR Status Notice](docs/standards/IPR_STATUS.md), the repository
[license scope](LICENSE_SCOPE.md), and the [patent policy](PATENTS.md). Licensing source code or
specification text does not grant a trademark, compatibility-mark, or certification right.

## Contribution license and provenance

Unless a submission is conspicuously marked `Not a Contribution` or a separate written agreement
applies, every contribution intentionally submitted for inclusion in Apache-2.0 material is
provided under the [Apache License, Version 2.0](LICENSE), including the copyright and patent grants
in Sections 2, 3, and 5.

Contributors must have the right to submit the material and make those grants. Contributions must
not contain third-party code, data, model weights, confidential information, or patent-restricted
material unless their provenance and compatible license are recorded in the pull request and
accepted by a Maintainer.

Morphz uses the [Developer Certificate of Origin 1.1](https://developercertificate.org/) as a
lightweight provenance attestation. Sign each commit with:

```text
Signed-off-by: Your Name <your.email@example.com>
```

`git commit -s` adds the line automatically. The sign-off certifies the DCO; it does not transfer
copyright ownership to Newvar. Corporate contributors are responsible for confirming that the
signer is authorized to contribute on the organization's behalf.

A contributor who knows that a submission may be covered by a patent application or patent they
control must follow the disclosure process in [PATENTS.md](PATENTS.md).

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

## Local Cargo disk hygiene

On macOS, Rust's fast `unpacked` debug-info mode leaves `*.rcgu.o` files beside build outputs.
They make iterative linking faster, but frequent test and feature combinations can accumulate
hundreds of gigabytes because Cargo does not impose a target-directory size limit.

Inspect the repository cache after a long development or test session:

```sh
./scripts/prune-cargo-target.sh --dry-run
./scripts/prune-cargo-target.sh
```

It removes unpacked debug objects and incremental sessions that have not been used for 24 hours.
When `cargo-sweep` is installed it also removes stale hashed artifacts from the same retention
window. Current-day incremental state, dependency libraries, metadata, fingerprints, and binaries
remain available, so the hot edit/build loop stays incremental. The command refuses to run while
Cargo or rustc is active, validates `CACHEDIR.TAG`, and reports target size and reclaimed space.
Use `MORPHZ_CARGO_CACHE_MIN_AGE_MINUTES` to choose another retention window, or pass a Cargo target
directory as the first argument. The former `prune-cargo-unpacked-debuginfo.sh` name remains as a
compatibility entrypoint.
