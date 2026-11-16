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

## Application development

The workspace application lives in `application/`. Read its `AGENTS.md` before changing it;
its shared business rules, Web adapter, and embedded Desktop host stay separate from Runtime
internals. Keep the existing Cargo workspace and the application npm lockfile independent.
Runtime-only builds must not require Electron or mobile SDKs.

Use Node.js 24.13 or newer for the application, even though the Dashboard has its own toolchain.
From the repository root, use `npm ci --prefix application`,
`npm --prefix application run build`, and `npm --prefix application test`.
After a cold application dependency install, prepare its pinned Electron binary once with
`node application/node_modules/electron/install.js` before running tests. Electron 44 otherwise
downloads on first import, which is unsafe in parallel test workers. The test entry verifies
the installed binary without importing, downloading or launching Electron; the full-test CI
jobs perform this dependency preparation explicitly, including on Linux.
The Linux full-inventory jobs use Xvfb for Electron's real native-window tests;
headless Chromium alone does not provide a display for those cases. Both the Node
inventory and the browser inventory launch Electron, so each CI command needs
its own authenticated Xvfb lifetime; a previous step's display does not persist.
The application workflow checks Web, macOS Desktop, and actual Runtime contracts separately.
Changes spanning an application contract and Runtime must include both sides and their tests in
one pull request. No application or mobile release is implied by a Runtime release tag.

See [the integration record](application/docs/25-repository-integration.md) for history,
compatibility, and original-profile acceptance requirements.

## CI change impact and complete release validation

The CI and Application entry workflows always create a change-impact plan and an
`affected checks` receipt. Selection uses the complete push range or the PR merge-base
range, including removed paths and both sides of renames. The plan is bound to the
checked-out commit. A selected job must succeed; failure, cancellation, a missing result
or an unexpected skip fails the receipt. Workflows do not use top-level path filters
that can leave required checks pending.

- Renderer `.tsx` views, CSS and static visual assets under `application/apps/web/`
  (excluding native Host adapters) retain the complete shared Web/Desktop
  Node inventories, browser inventories, native Desktop acceptance, source contracts
  and repeated native/timing regressions. They omit the unchanged full Rust Runtime,
  sandbox, Runtime release-build, independent Dashboard/site and cloud-storage jobs.
  Actual Runtime browser prerequisites remain enabled where the UI tests use them.
- `application/tests/` changes additionally retain the real Runtime/Host contract and
  PostgreSQL/S3 application inventories. They do not alter Runtime implementation.
- Website-only changes run website checks, except installer paths, which require full CI.
  Application Markdown documentation alone needs only the always-running admission checks.
- Runtime, SDKs, shared contracts, renderer clients/transport/data logic, Host adapters,
  native Desktop privileges, application dependencies,
  build scripts, CI policy/workflows and every unclassified path require full joint CI.
  Missing/unreadable history and classification-budget overflow also select full CI.
- Release branches, PRs into release branches and explicit manual workflow runs always
  select full joint CI. Test commands, capability requirements, assertion budgets and
  repetition counts are unchanged by selection.

A scoped green run cannot authorize a release. `verify-release-ci.py` still requires
every full Runtime and application job, both impact plans and both receipt gates on
the exact candidate commit and latest attempt from the canonical branch. If its latest
push was scoped, explicitly run both full workflows before publishing the tag:

```bash
gh workflow run ci.yml --ref main
gh workflow run application.yml --ref main
```

For an RC use its corresponding `release/X.Y.Z` branch. Keep the candidate commit fixed
while these checks run; the release gate refuses another SHA, a PR run, an older green
attempt, missing full jobs or any required skip. A newer failed or pending run cannot
borrow an earlier full green result.

## PostgreSQL Runtime test coverage

Runtime's PostgreSQL library contracts are explicitly ignored in default local
runs because they require an isolated database. CI must also run
`python3 scripts/test_runtime_postgres_lib.py` with its job-owned
`MORPHZ_TEST_POSTGRES_URL`; the runner requires exactly one executed test per
contract, including the real PTY contract, and never accepts a zero-test pass.
The separate Session IO workflow owns its PostgreSQL concurrency and fence
cases. `scripts/tests/test_runtime_postgres_ci.py` checks these owners against
the explicitly ignored PostgreSQL source inventory. A default-suite pass alone
does not cover these cases. Never supply business database credentials.

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

Use one configuration for development and tests (`line-tables-only` debug information,
incremental enabled). Do not add per-command `CARGO_PROFILE_DEV_DEBUG` /
`CARGO_PROFILE_TEST_DEBUG` overrides. For full variable inspection use an explicitly named
diagnostic profile rather than multiplying daily-cache variants.
The workspace bounds build concurrency to two jobs in `.cargo/config.toml`, including
ordinary direct Cargo invocations; an operator may explicitly override `CARGO_BUILD_JOBS`.

The canonical development/test entrypoint forwards arguments and exit status to Cargo and
performs bounded post-build collection at most once daily:

```sh
./scripts/cargo-dev.sh build --locked -p morphz --bin morphz
./scripts/cargo-dev.sh test --locked -p morphz --lib
```

Inspect or explicitly collect superseded objects:

```sh
./scripts/prune-cargo-target.sh --dry-run
./scripts/prune-cargo-target.sh --apply
```

Inspection is the default. Collection requires a tagged canonical Cargo target directory,
no active compiler, and the same exclusive `.cargo-lock` used by Cargo. It only removes
single-link loose macOS objects older than 24 hours, with a completed newer artifact,
dependency record and fingerprint, absent from all current executable debug maps and the
current library archive. Unknown formats, symlinks, partial builds and changed files fail
closed. Incremental directories (of any age), dependencies, fingerprints, build scripts,
executables and release products are never removed. There is no optional `cargo-sweep` or
legacy cleanup alias. Automatic collection is capped at 16 GiB per daily run and is a no-op
when another build is active. `--minimum-age-minutes` selects an explicit manual retention
window; the final positional argument selects an exact target directory.

The JSON report counts removed files and their allocated blocks, not guaranteed physical
free space: APFS clones and local Time Machine snapshots can retain those blocks. Do not
delete backup snapshots, running processes or user files as a side effect of Cargo cleanup.
