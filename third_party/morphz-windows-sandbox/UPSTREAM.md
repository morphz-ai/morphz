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

The setup helper grants metadata/traversal on exact ancestors of approved roots
when the sandbox identity cannot resolve a permitted descendant (for example,
Node.js resolving its entry point). This is not read/list/write authority over
siblings. The ACE is non-inheritable, existing denies are retained, and paths
are opened without following junctions or creating missing ancestors. The
mutation uses `NtSetSecurityObject` on the same held `READ_CONTROL | WRITE_DAC`
handle, avoiding the Win32 inheritance propagation walk through the user's
directory tree. It does not request `MAXIMUM_ALLOWED`, which can conflict with
the sharing mode of handles already open on a live profile. See Microsoft's
[native security-object contract](https://learn.microsoft.com/windows-hardware/drivers/ddi/ntifs/nf-ntifs-zwsetsecurityobject).
The DACL builder preserves every existing ACE verbatim: `SetEntriesInAcl` with
`GRANT_ACCESS` is deliberately not used here because it can remove overlapping
deny bits. Native tests cover deny preservation, non-inheritance, existing
directory handles without delete sharing, and final/ancestor junction rejection.
No setup-version or identity migration is required: the existing command path
always refreshes root ACLs through this helper, including for provisioned users.

The old `CodexSandbox*` operating-system resources are not automatically
deleted during migration because they may belong to a real Codex installation.
Morphz provisions and owns a disjoint `MorphzSandbox*` resource set.
