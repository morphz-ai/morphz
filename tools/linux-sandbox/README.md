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

`mounts.c` / `mounts.h` implement the native launcher's non-root directory pinning,
mount-plan construction, destination identity/access verification, and inherited
descriptor closure. The actual Bubblewrap 0.9 bind implementation resolves FD
source names to paths: passing an FD-shaped source is **not** by itself a race
fix. The post-mount admission comparison is mandatory and rejects a different
device/inode or read/write mode before any work command can execute. The isolated
native driver tests these same primitives with the distribution binary, including
source replacement after pinning and an intentionally wrong admission identity.
It is not an authenticated production launcher or a completed Runtime hookup.

Only the trusted bootstrap layer uses `attach_disconnected` for Bubblewrap's
user-namespace/proc setup. The retained work layer has no such flag or setup
capabilities; both layers still have to permit any work access. The existing
continuous-denial and exact-stack kernel gates remain mandatory.

`registration.py` now authenticates typed registration and a single-use claim
using separate installed Runtime/launcher executable registries, retained kernel
pidfds, exact identities and the live parent relationship. A disconnected socket
does not revoke running work. There is **no public admission operation** here:
the mounted-root and final label gate still must be connected before this can be
used to launch general work through the Runtime.

`lifecycle.py` owns durable, immutable per-launch records, enforcing AppArmor
generations and administrator-owned cgroup v2 lifetime subtrees. The launcher
receives a root-opened `cgroup.procs` capability and writes literal `0`, joining
itself without a numeric-PID lookup/move race. It must close that descriptor
before work. Admission is closed before kernel `rmdir` of the cgroup; only a
successful removal (no live processes/descendants and no future joins possible)
permits profile unloading. A still-open old descriptor cannot resurrect a
removed group. UID/PID values saved to disk never restore authentication after
service restart: recovery closes admissions and preserves protection while any
descendant lives. There is no automatic task kill in this implementation.

The isolated lifetime gate uses distinct root-owned native fixture peers (not a
trusted Python interpreter), an actual Unix control socket, actual cgroup joins,
background descendants and a real `SIGKILL`/restart of the fixture service. It
tests late protected-file creation, allowed writes, capability-FD closure,
same-UID impostors and a held/stale join capability. It does not claim that
general-work admission, private PTY integration or the original Runtime test has
passed. Fixture cleanup kills only synthetic processes in its unique recorded
cgroups; neither the service core nor a Mac/production node does so.

Mandatory next gates: authenticated service; pinned-object mount handoff;
exact enforcing-stack/UID/
capability/NoNewPrivs confirmation before command execution; inherited-FD closure;
real exec and private PTY; background descendants and crash recovery; unchanged
Runtime terminal test and full CI. Installation only in isolated Linux/CI until
those gates are met and a production deployment is explicitly in scope.
