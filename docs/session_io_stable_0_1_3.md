# Session IO — 0.1.3 promotion gate

The supported scope is the existing IO v1 envelope, lossless JSON, registered
formats, Chat, attachments, typed paging, durable delivery/retry, cancellation,
recovery, directed input, and authenticated history/streams. Promotion neither
changes persisted format hashes nor adds unsupported activation/encoding modes.
It does not claim multi-tenant Cloud readiness or acceptance of a public MEP.

## Implementation

- Ordinary builds always provide IO; there is no enable/disable switch.
  Discovery reports `experimental: false`. Desktop uses an ordinary build.
- Trusted definitions use `session_io.formats`; project configuration cannot
  install definitions or change the host's IO policy.
- Experimental build/process flags and the old descriptor configuration key
  are removed, not aliased. Only normal `session_io` configuration is supported.
  Persisted format definitions and accepted requests are unchanged.
- Promotion does not install the explicit old-writer fence or silently
  migrate/replay user data. Downgrade still requires a pre-IO backup.
- Empty inherited model aliases no longer prevent unlabelled direct Clients
  from executing. PostgreSQL ingress preserves per-task model/depth choices
  and does not batch different policies into one task.

## Required gates

- Default-build library/CLI regression and `tests/session_io.rs`, including
  default configuration, typed output, attachment ownership, cancellation,
  restart, exact numbers and HTTP/SSE authentication.
- macOS and Windows IO/attachment concurrency tests in CI.
- The reusable `.github/workflows/session-io.yml` runs actual PostgreSQL IO,
  output concurrency, explicit fences and three actual v0.1.2 binary probes,
  including live-writer cutover and backup restoration. It is required by both
  normal CI and release publication; ignored tests are explicitly included
  against separate newly-created fixture databases.
- Default Runtime + application IPC, directed continuation and identity
  fixtures; the capability probe must observe stable IO from the live process.
- Release-critical tests, all-feature Clippy, security/license checks and
  checksummed platform bundles.

The historical September 10 acceptance remains unchanged. Current gate results
are recorded below after execution; this document alone is not a passing CI run.

## Current validation

Local validation on 2026-09-25, using ordinary default builds:

- Runtime library: 1,408 passed, 10 explicitly ignored; CLI binary: 31 passed.
- IO unit/fence/concurrency: 22 passed including the opt-in PostgreSQL cases.
- IO integration: 14 passed including PostgreSQL with its explicit fence.
- Actual v0.1.2 binary probes: 3 passed (SQLite/PostgreSQL cutover and restore).
- SQLite/PostgreSQL RuntimeStore conformance: 7 passed.
- Delegation/continuation attempt-loop regressions: 79 passed; CLI contract: 6 passed.
- Application: 407 unit tests and typecheck passed; real Runtime IPC, directed
  continuation and two-identity/restart fixtures passed without experimental flags.
- The packaged-binary probe passed against the local default Runtime: stable
  discovery, authenticated access and no automatic database fence.
- All-target/all-feature Clippy with warnings denied, Rust formatting, workflow
  lint, protocol/diagnostic checks and the locked Rust license check passed.

These are local results, not a claim that all hosted-platform jobs have already
passed. CI results for the release commit and the required release jobs remain
authoritative for publication. No personal Runtime, profile, credentials or
database was modified by the isolated fixtures.
