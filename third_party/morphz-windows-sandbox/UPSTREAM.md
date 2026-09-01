# Upstream provenance

This crate is derived from the OpenAI Codex repository at revision
`94cbbddafc1776d5e377bca1b05932c697e82238`, directory
`codex-rs/windows-sandbox-rs`.

Morphz vendors the implementation so that its installed executables, local
accounts and groups, named pipes, private desktops, firewall/WFP resources,
mutexes, logs and environment variables have Morphz product identity. The
security mechanisms remain the upstream Restricted Token, ACL/capability SID,
WFP, private desktop and Job Object design. Product-facing renaming must never
be represented as original authorship: OpenAI Codex remains the upstream source
and the Apache-2.0 license is preserved in `LICENSE` and `NOTICE`.

Morphz-specific changes are intentionally limited to:

- product/resource naming and installable helper names;
- Morphz dependency wiring and telemetry isolation;
- diagnostics and fixes required by Morphz's native Windows regression suite.

The old `CodexSandbox*` operating-system resources are not automatically
deleted during migration because they may belong to a real Codex installation.
Morphz provisions and owns a disjoint `MorphzSandbox*` resource set.
