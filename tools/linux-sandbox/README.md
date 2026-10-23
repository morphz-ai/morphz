# Linux continuous-path sandbox service

Implementation under the approved 2026-10-21 service/launcher plan. **Installed
only in isolated Linux CI, not on user/production machines.**

Current administrator instructions are in [INSTALL.md](INSTALL.md). The
[0.1.4 RC acceptance record](../../docs/releases/v0.1.4-rc.1-acceptance.md)
separates current release gates from the development evidence below. Explicit
upgrade, rollback, drained uninstall and crash recovery are now implemented;
they are not implicit overwrite or automatic privilege elevation.

The candidate at `8f3e4b04` passed the installed-service and compiler/kernel
jobs in [run 39952055226](https://github.com/morphz-ai/morphz/actions/runs/39952055226).
Its installed lifecycle archive records 33/33 assertions, including active-work
upgrade/rollback, automatic recovery from a failed upgrade, active-uninstall
refusal and recovery after two real administrator-process interruptions. This
is isolated Linux CI acceptance, not production deployment. A later candidate
must still pass its own exact-commit gates before publication.

## Development evidence history

The observations and pending gates in this section describe their named
historical commits/runs; old test counts and then-pending lifecycle work are
not the current candidate's status.

Earlier measured result: [run 39574236288](https://github.com/morphz-ai/morphz/actions/runs/39574236288)
at `fa1f2d0b` passed both jobs, with raw logs checked: four actual Runtime native
contracts, the unchanged late-file PTY regression, private-PTY/session separation,
the complete Runtime library (1664 passed, zero failed, 14 default-ignored),
and all five separately required PostgreSQL library contracts. Compiler/kernel
assertions (86), peer cases (6), object-pin assertions (18), native-mount assertions
(49) and lifetime assertions (35) also passed. These different scopes are not
added together or represented as production deployment acceptance.

`ignored` means not executed by the default command, not a pass. Of the fourteen
library cases, five PostgreSQL contracts execute explicitly in this workflow;
two more belong to the required Session IO PostgreSQL workflow. The other seven
are three provider/auth environment checks, one private SSE replay and three manual
TUI/PTY checks; this workflow does not claim their execution. Full CI now also
requires thirteen separately ignored PostgreSQL integration contracts (approval,
cancellation and input provenance); all thirteen actually ran and passed in
job `119126357268` of run `39571445223`. They are not part of the fourteen library
cases. Each required PostgreSQL invocation rejects zero-test or ignored-only
success, and a source-inventory guard rejects a new unowned PostgreSQL case.

The independent full Runtime run `39571445223` exposed a stale attempt-loop
fixture: two unread inputs can intentionally form one bounded dialogue batch.
The serial-turn test now holds the first actual model request before submitting
the second input, retaining the two replies, separate roots and max-concurrency-1
assertions. Two parallel-load fixture races likewise hold the actual tool/handler
stage instead of assuming a 600 ms tool or including database initialization in
the handler's non-blocking deadline. The complete local `attempt_loop` inventory
then passed 81/81 with zero ignored under default parallel execution. This is
test synchronization, not a change to Runtime batching or execution semantics;
the complete Runtime CI at `e1b8a7a5` then passed in
[run 39578427800](https://github.com/morphz-ai/morphz/actions/runs/39578427800).
Its full workspace test job, Linux/macOS/Windows native boundaries, PostgreSQL,
Session IO, lint and release build all passed. This does not turn the remaining
default-ignored provider/private/manual cases into passes, or establish complete
Application and release-installation acceptance.

Historical false-green result: `39568698033` passed the library and PostgreSQL
cases but its new namespace-handle native case still failed;
the CI page incorrectly reported success because the logging pipeline lacked
`pipefail`. That green status is **not** accepted as a passing run. The step now
uses explicit Bash with pipeline failure propagation, and a regression executes
that exact workflow command with both failing and successful fixture producers.
The namespace test correction records actual syscall errors and accepts only
EPERM/EACCES rejection, never a successful namespace transition. The corrected
case passed in `39569588210` and again in the latest failure-propagating workflow.
The Windows release's two native Cargo builds also use explicit Bash: a regression
executes the actual workflow commands and requires a failed first build to stop
before the successful second build could mask it. Full release validation is
separate from this controlled exit-status test.

Earlier progression: run `39560180501`
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
mount table, not a claimed setup result. Run `39568698033` passed 49 native mount
assertions, 35 policy-lifetime assertions and the installed Runtime library;
the separate native namespace-case failure was corrected and verified above.
No data-filesystem allowlist or relaxed write check was added.
Full CI, upgrade/uninstall and release
integration remain separate acceptance gates.

Linux Runtime and Edge archives now stage the exact inert `linux-sandbox/`
installation sources and `INSTALL.md`, without native test executables or a
trusted general interpreter. A new required release job downloads those actual
archives, installs their root-owned native images and packaged service in fresh
Ubuntu 24.04 x86_64/ARM64 runners, and exercises the packaged Runtime's public
terminal API. It requires post-admission `.env` read denial, outside-write denial
and an allowed live write, with no model call. Merely staging these sources or
adding the gate is not proof that it has passed; record its native result before
claiming release installation works. The regular user installer does not auto-
elevate, change global namespace settings or authorize its user-writable image.

The first packaged gates in run `39583176446` admitted actual x86_64/ARM64
terminals and denied the late-created protected read, but failed their outside-
write fixture: its `/tmp/.../outside` directory was hidden by the intended private
tmp mount, so the operation returned ENOENT rather than a permission denial.
The probe now creates and explicitly grants **read-only** access to that sibling
before admission, requires a successful witness read, and then requires the same
strict write-denial errors. It does not accept ENOENT as protection evidence or
change the implementation's mounts/permissions. The corrected native gates both
passed in [release run 39584810663](https://github.com/morphz-ai/morphz/actions/runs/39584810663)
at `4d5a748f` (jobs `119175493022` and `119175493136`). Raw logs confirm actual
packaged Runtime admission, a successful outside read before write rejection,
late-created protected-file read denial, allowed live writes and zero model
calls on x86_64 and ARM64. The entire release workflow also passed, including
Windows/macOS artifacts, readiness, installed-service and Session IO gates.
This proves first installation, not upgrade/uninstall acceptance or production
deployment. Edge was installed/registered and version-checked, not exercised as
an independent running Edge execution service by this probe.

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
now uses these checks for registration, object binding and private admission.
The previously failing mount refusal and namespace case are resolved in the
measured installed Runtime run; the complete workspace CI remains a separate gate.

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
full-library expansion passed in `39568698033`, but the failed native case
prevents treating that entire historical run as successful. The latest complete
installed-service workflow above passes without that failure.

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
The initial `install.py` required explicit root invocation and did not start
the service or change global sysctl settings. It refused implicit
upgrade/overwrite. Upgrade/uninstall and full Runtime CI were separate pending
gates at that stage. The current explicit lifecycle commands may restart the
service while preserving active work; see `INSTALL.md` for their boundaries.

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

Durable records now bind the exact saved AppArmor source to the typed policy and
unique launch identity with a domain-separated SHA-256 digest. Recovery checks
that administrator-owned binding, not a recompilation under the newest rule
generator. ABI-1 kernel names are derived separately from the stable typed policy
identity. Pre-binding records migrate only if the current compiler reproduces
their saved source exactly; unknown legacy source fails closed. No existing
source/profile is replaced. Local deterministic checks pass (51 tests), including
a regression that failed before this change. The expanded kernel fixture starts
a genuinely separate service process with a changed compiler, checks old live
descendants and new registrations together, and requires independent reclamation.
Its native CI result and formal installer upgrade/uninstall are still pending;
the local checks are not kernel or deployment evidence.

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
