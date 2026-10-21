# Linux continuous-path sandbox service

Implementation under the approved 2026-10-21 service/launcher plan. **Installed
only in isolated Linux CI, not on user/production machines.** Run `39560180501`
at `50844520` passed the actual administrator-installed Runtime command and PTY
path, including the unchanged original late-created protected-file terminal
regression. It also passed the separate compiler/kernel gates. This establishes
that the Runtime fix works for those cases, not that full CI or deployment is
complete. The expanded run `39562218985`, with a PostgreSQL service container,
failed closed at the full mount-table check: all three native contracts and 18
library cases could not start work. Its library result was 1646 passed, 18
failed, 14 ignored; four of the five separately invoked PostgreSQL contracts
passed, while the real PTY contract hit the same admission refusal. These are
not passing results, nor evidence of 18 unrelated bugs. The unexpected writable
mount must be identified without weakening data-write admission. Follow-up
`39563832420` identified `/run/docker/netns/...` (`nsfs`): Linux namespace handles
have immutable regular 0444 inodes and no write operation even when mountinfo
says `rw` ([kernel implementation](https://github.com/torvalds/linux/blob/v6.8/fs/nsfs.c)).
Admission now requires a pinned actual object, exact 0444 mode and a successful
kernel `NS_GET_NSTYPE` proof for that case, not a Docker path allowlist. Unknown
filesystems, writable regular files and missing proofs still fail. A new actual
Runtime contract opens a host network namespace handle and must reject writable
access, `setns` and new user namespaces; full CI supplies a real isolated bind
mount. The next run `39566260132` then identified a genuinely writable Docker
`overlay` mount beneath an inaccessible ancestor. Bubblewrap 0.9's per-path
recursive remount skips EACCES paths. The trusted inner launcher now creates a
private mount namespace, seals the entire tree with recursive `mount_setattr`,
and restores only pinned, previously writable mounts within positive grants.
Existing read-only children stay read-only, including inside a writable grant;
host mount propagation is disabled. Only the static bootstrap temporarily keeps
namespace-local SYS_ADMIN/SETPCAP; every capability set, including the bounding
set, is zero before work-profile admission. The service verifies the resulting
mount table, not a claimed setup result. Linux validation of this correction is
pending; no data-filesystem allowlist or relaxed write check was added.
Full CI, upgrade/uninstall and release
integration remain separate acceptance gates.

The service accepts only the Runtime's typed, already-approved `SandboxPolicy`.
It never accepts shell commands, arbitrary AppArmor source, or requested profile
names. Registration must bind kernel peer identity, pidfd/start identity, actual
label and administrator-trusted executable identity. UID alone is insufficient.
The non-setuid launcher, pinned root descriptors, immutable policy generations,
private admission and cgroup-backed lifetime tracking are connected to the
Runtime exec and private-PTY paths. Their complete validation remains required
before deployment. No automatic sudo or global security-setting changes.

`policy.py` is the pure deterministic compiler shared by the installed service
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
kernel pidfd; inherited public control connections and passed descriptor
capabilities are rejected. Private admission instead binds the connection to
the exact outer launcher and authenticates the inner per-message kernel sender.
The actual process must retain matching IDs, namespace, exact role
label, no tracer/capabilities and an administrator-installed executable object.
Allowed executable objects and their ancestors must be root-owned and not user
writable; names, request JSON and the UID alone confer no authority. Registration
must retain the pidfd and revalidate again before admission. The separate kernel
fixture uses Python only as a **test** executable; a production registry must
contain the installed Runtime/launcher, not a general interpreter. The controller
now uses these checks for registration, object binding and private admission;
the expanded actual-Runtime gate remains open because of the mount refusal above.

`roots.py` pins actual directory objects under the caller's non-root identity,
with no capabilities and without following root or ancestor symlinks. It retains
close-on-exec descriptors and kernel mount/inode identity, rejects observed
source replacement, and preserves read-first/write-last grant ordering. A
pathname check alone is never claimed to prevent a later rename: the launcher
must mount from these retained descriptors and verify destination identity
before admission. The separate unprivileged kernel gate tests live changes,
replacement, literal paths and descriptor cleanup. The Python component is a
separate fixture implementation; the actual launcher uses the native
object-pinning implementation below.

`mounts.c` / `mounts.h` implement the native launcher's non-root directory pinning,
mount-plan construction, destination identity/access verification, and inherited
descriptor closure. The actual Bubblewrap 0.9 bind implementation resolves FD
source names to paths: passing an FD-shaped source is **not** by itself a race
fix. The post-mount admission comparison is mandatory and rejects a different
device/inode or read/write mode before any work command can execute. The isolated
native driver tests these same primitives with the distribution binary, including
source replacement after pinning and an intentionally wrong admission identity.
That synthetic driver is not the installed authenticated launcher. The separate
installed-Runtime job exercises `launcher.c` and the actual Rust call paths.

Only the trusted bootstrap layer uses `attach_disconnected` for Bubblewrap's
user-namespace/proc setup. The retained work layer has no such flag or setup
capabilities; both layers still have to permit any work access. The existing
continuous-denial and exact-stack kernel gates remain mandatory.

`registration.py` now authenticates typed registration and a single-use claim
using separate installed Runtime/launcher executable registries, retained kernel
pidfds, exact identities and the live parent relationship. A disconnected socket
does not revoke running work. There is **no public admission operation** here.
`admission.py` and `server.py` implement the private gate: actual pinned/mounted
directory identity and access mode, exact enforce stack, namespace ancestry,
kernel identity, cgroup membership, NoNewPrivs and closed host capabilities.
The fixed Bubblewrap invocation creates two user namespaces for devpts setup;
both owners and the exact two-level ancestor are checked, not an arbitrary
descendant or a model-supplied depth.

Registration supplies a root-owned read-only startup pipe through SCM_RIGHTS.
Only the service writes its one-byte success receipt, after actual admission;
refusal/service loss is EOF, never a success marker. The work command receives
neither end, and command stdout cannot impersonate it. Current isolated native
peers verify success and refusal receipts alongside actual Bubblewrap admission.
Rust PreparedCommand/PreparedPty retain this private receipt. Exec metadata and
terminal readiness remain pending until it succeeds. The isolated job installs
actual root-owned native Runtime test executables and the real service. Run
`39560180501` passed two public execution tests, the original terminal regression,
and real private-PTY versus ordinary-command session separation. The later
full-library expansion currently fails as recorded above; the component gates
are not a substitute for it.

Old direct-Bubblewrap integration cases now invoke the installed public Runtime
path. Protected-read assertions open/read the actual file and require rejection,
instead of relying on the old `/dev/null` snapshot mask's zero-length metadata.
The old public shell test also now uses `set -e`: a failed intermediate check can
no longer be hidden by a successful final command. Writes, allowed siblings,
HOME grants and unchanged host bytes remain asserted; no test is ignored to
make this migration pass. The original terminal late-file test stays unchanged.

`launcher.c` is a static, non-setuid executable. User environment is frozen into
a sealed private handoff; distribution Bubblewrap receives a fixed clean
environment, and the user's environment becomes active only after admission.
The service checks the full mount table as well as individual approved objects.
`install.py` requires explicit root invocation and never starts a service or
changes global sysctl settings. It refuses implicit upgrade/overwrite. Formal
upgrade/uninstall lifecycle and full Runtime CI still remain acceptance gates.

Full workspace CI uses `stage_runtime_tests.py --workspace` to install an explicit
seven-image native test inventory, not every executable produced by Cargo.
`run_runtime_test.py` redirects only those exact images and verifies the current
Cargo artifact and installed executable against the root-owned manifest digest;
unlisted tests still run normally without policy-service authority. Neither
Python nor Cargo nor a user-writable checkout becomes a trusted Runtime. The
production registry remains bounded at 16 exact administrator-installed images.
The full suite retains all targets and doctests, continues collecting failures,
and separately requires the five PostgreSQL library cases. The other two IO
PostgreSQL cases retain their existing independent workflow owner.

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

Mandatory retained gates: authenticated service; pinned-object mount handoff;
exact enforcing-stack/UID/capability/NoNewPrivs confirmation before command
execution; inherited-FD closure; real exec and private PTY; background descendants
and crash recovery; the unchanged Runtime terminal test. Component successes do
not supersede a failure in the installed full inventory. Installation remains
isolated Linux/CI only until full CI and installation lifecycle pass and a
production deployment is explicitly in scope.
