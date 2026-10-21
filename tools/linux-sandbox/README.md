# Linux continuous-path sandbox service

Implementation in progress under the approved 2026-10-21 service/launcher plan.
This directory is **not yet installed, enabled, or a completed Runtime fix**.
The old strict terminal failure remains open until the actual Runtime path and
original CI test pass; this compiler cannot replace that acceptance.

The service accepts only the Runtime's typed, already-approved `SandboxPolicy`.
It never accepts shell commands, arbitrary AppArmor source, or requested profile
names. Registration must bind kernel peer identity, pidfd/start identity, actual
label and administrator-trusted executable identity. UID alone is insufficient.
The non-setuid launcher, pinned root descriptors, immutable policy generations,
private admission and cgroup-backed lifetime tracking remain required before
production integration. No automatic sudo or global security-setting changes.

`policy.py` is the pure deterministic compiler shared by the forthcoming service
and its tests. It preserves separate read/write denials, dynamic read/write roots,
exact literals and explicit rejection of symbolic globs. Its generated bootstrap
allows general execution because it stays in the final stack; **only the trusted
launcher may run before verified work-profile admission**. A general command may
never run in bootstrap alone. Kernel enforcement is not implied by string tests.

Local pure checks (no root, kernel policy or filesystem changes):

```sh
python3 -B -m unittest discover -s tools/linux-sandbox -p 'test_*.py' -v
```

The isolated `linux-sandbox-service.yml` workflow also loads the compiler's real
profiles through the distribution AppArmor parser. A fixed non-root worker
enters the exact enforcing stack before the host creates protected files. It
checks literal Unicode/metacharacter paths, `openat`, allowed siblings, separate
read/write denials, ancestor renaming, symlinks and replacement/recreation. The
worker and artifacts contain only synthetic data. This is a compiler/kernel
gate, not a substitute for the service, mount handoff, PTY or Runtime tests.
Neither this workflow nor the compiler changes global sysctl settings.

`peer.py` is the caller-authentication building block. Each bounded seqpacket
must carry matching connection and per-message kernel credentials plus a live
kernel pidfd; inherited connections and passed descriptor capabilities are
rejected. The actual process must retain matching IDs, namespace, exact role
label, no tracer/capabilities and an administrator-installed executable object.
Allowed executable objects and their ancestors must be root-owned and not user
writable; names, request JSON and the UID alone confer no authority. Registration
must retain the pidfd and revalidate again before admission. The separate kernel
fixture uses Python only as a **test** executable; a production registry must
contain the installed Runtime/launcher, not a general interpreter. This component
does not yet implement registration, mount identity or lifecycle management.

`roots.py` pins actual directory objects under the caller's non-root identity,
with no capabilities and without following root or ancestor symlinks. It retains
close-on-exec descriptors and kernel mount/inode identity, rejects observed
source replacement, and preserves read-first/write-last grant ordering. A
pathname check alone is never claimed to prevent a later rename: the launcher
must mount from these retained descriptors and verify destination identity
before admission. The separate unprivileged kernel gate tests live changes,
replacement, literal paths and descriptor cleanup. This component is not yet
connected to Bubblewrap or a production registration service.

Mandatory next gates: authenticated service; pinned-object mount handoff;
exact enforcing-stack/UID/
capability/NoNewPrivs confirmation before command execution; inherited-FD closure;
real exec and private PTY; background descendants and crash recovery; unchanged
Runtime terminal test and full CI. Installation only in isolated Linux/CI until
those gates are met and a production deployment is explicitly in scope.
