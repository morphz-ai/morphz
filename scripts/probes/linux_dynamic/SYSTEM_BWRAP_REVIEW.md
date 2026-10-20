# Confirm the receiver correction with the original distribution executable

Run 19 (5596469881898b021df46f649c0d46946349e98f) compared read and recv on
one Ubuntu 6.17.0-1022 runner under identical policies, controller and worker.
The read baseline failed with the exact socket acknowledgement EACCES.
The recv lane passed all 80 recorded assertions and collected all 7 launches.
The combined job intentionally remained failed; no original failure is erased.

This follow-up uses the exact same recv entry transformation, policy, controller,
worker and resource gate, but runs the untouched distribution `/usr/bin/bwrap`.
It does not build or replace Bubblewrap, run a binary lease, modify kernel
settings or change a security rule. Before and after the campaign, the driver
requires the pinned distribution version, an empty successful `dpkg --verify`,
the canonical non-symlink binary, root ownership, mode 0755, no file capabilities
and an unchanged SHA-256. An independent always-step repeats that verification.

The admitted payloads remain finite synthetic operations. This does not prove
arbitrary command safety, a production daemon's authentication or crash recovery,
general root/glob semantics, existing hardlink confidentiality, or actual Rust
ExecTool/TerminalManager integration. Those production gates still require
design review and implementation; this is not an original-app update.
