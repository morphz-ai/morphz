# Fixed manifest FD and authenticated inherited connection — local draft

Status: local `/tmp` draft for root review only. No push, new GitHub run, local
policy installation, production change, or successful Linux validation.

This implements only the five-point simplified candidate in
`/tmp/morphz-full-app-regressions-20261020.OxfoEB/linux-dynamic-manifest-admission-review-after-run8.md`.
The earlier signature / digest-in-label / FD-roundtrip recommendation remains
withdrawn. This draft adds none of those mechanisms.

## Evidence baseline and exact scope

Baseline bundle: `/tmp/morphz-dynamic-fd-base.BwDjdo`.
Latest actual remote result remains run **39445680722**, SHA
`8365ed952232ca13276943ad953437d91b875d9d`: control failed at `uid_map` open,
the one-flag candidate got past mapping then failed at the manifest owner check.
There was no ready worker, admission success, or dynamic protection evidence.

Changed implementation:

- `entry.c`: host-only owner check; fixed FD 3/4 handoff; exact bootstrap-only
  check before FD access; fixed inner argv; no inner pathname reconnect.
- `controller.py`: outer authentication, bounded credential-bearing records,
  actual inner identity checks, original manifest held through reply.
- `test_contract.py`: replace the old common `argc == 3` source assertion with
  the fixed outer/path and inner/FD interfaces.
- `test_startup_handoff.py`: 12 pure mocked/source tests with positive and
  negative branches. They do not execute Linux confinement.
- `bwrap_diagnostic_runner.py`: only the two startup-source hash pins change.
  The initial stale-pin failure is preserved, not reclassified as a pass.

`policy_contract.py`, `loader.py`, `worker.py`, workflow, diagnostic bwrap patch,
and `bootstrap_path_counterfactual.py` are byte-for-byte unchanged. There is no
new capability, ptrace rule, filesystem rule, socket permission, model contract,
signing key, policy label format, or command execution API.

## Minimal chain

1. Loader's existing checks create a root-owned, non-writable stage/launches and
   an exclusive root-owned manifest. Controller retains `O_RDONLY | O_NOFOLLOW`
   FD; outer independently opens and checks host UID 0, regular type, mode,
   size, access, descriptor content, and the exact current bootstrap label.
   No pathname is reopened after namespace entry.
2. Outer connects to the existing fixed pathname before `bwrap`. It requires
   `SO_PEERCRED.pid == getppid()` with an unchanged parent, same host UID/GID,
   and actual `SO_PEERSEC == unconfined`, matching this probe's existing host
   requirement. This is stronger than trusting a caller-provided parent PID or
   same UID alone. Controller simultaneously checks its originally spawned
   direct child, entry executable, exact bootstrap, and host namespace IDs.
3. After `HOST`, outer moves the two open descriptions to fixed FD 3 (read-only
   manifest) and FD 4 (already authenticated client endpoint). `dup2` clears
   CLOEXEC only on these handoff slots, using scratch slots to avoid aliasing.
   Root-reference FDs are opened afterward. The fixed `bwrap` chain and all
   namespace/capability/NNP arguments are unchanged; final argv is `entry --inner`.
4. Inner first checks the real kernel label is exactly one enforcing generated
   bootstrap label. Only then can it read fixed FD 3. It retains the existing
   workload UID and roots/NNP/capability checks, without comparing namespace
   file UID to host root or accepting any overflow-owner value. It closes
   manifest FD, stacks the exact corresponding work profile, closes preparation
   FDs except FD 4, and sends its admission record over the inherited endpoint.
5. `SO_PASSCRED` is enabled before connect; each bounded `recvmsg` fragment must
   carry exactly one same-sender `SCM_CREDENTIALS`. Controller does **not** treat
   the socket's original `SO_PEERCRED` as inner identity. It requires a different
   live descendant PID, UID/GID, matching launch fields and manifest dev/ino/
   mode/size/access, exact stack, entry executable, namespaces and mounts.
   A pidfd and starttime check stay active through each response; identity is
   rechecked immediately before sending. NO/EOF may then legitimately terminate
   inner, so intentional refusal is not misreported as a liveness failure.
   Inner closes FD 4 and all remaining preparation FDs before fixed payload exec.

The manifest's namespace UID is not an authentication source. Inner's FD
metadata is evidence from the trusted fixed entry, not a substitute for that
chain. An arbitrary sealed FD proves no source; a business process is already
under bootstrap∩work and is rejected by the initial bootstrap-only check.
Re-entering a bootstrap-only state is forbidden by the unchanged work policy.
The threat model still excludes compromised host root, trusted Runtime/entry,
and the trusted same-UID host account.

Malformed, credential-less, mixed-sender, truncated, multi-frame and oversized
records are refused. Unexpected SCM_RIGHTS descriptors are closed and rejected;
this does not introduce an FD-transfer protocol. No GO or disconnected admission
still prevents payload execution. There is no fallback owner, socket, profile,
unconfined worker, or retry with relaxed permissions.

## Local verification, not dynamic acceptance

Command:

```sh
python3 -B -m unittest discover -s . -p 'test_*.py' -v
```

- First: **62 passed, 1 error** — frozen startup hashes still referenced the
  pre-draft files. Log:
  `/tmp/morphz-full-app-regressions-20261020.OxfoEB/linux-fixed-fd-pure-first.log`.
- After updating exactly the entry/controller pins: **63 passed**. Log:
  `/tmp/morphz-full-app-regressions-20261020.OxfoEB/linux-fixed-fd-pure-final.log`.

New tests cover frame fragmentation and credential integrity, rejection/closure
of passed rights, host-owner/read-only/type/size requirements, live/dead/reused
sender checks and pidfd cleanup, exact original outer identity and namespace,
bootstrap-before-FD access, fixed slots, no inner reconnect, and closure ordering.
Existing policy, cleanup, refusal, bwrap restoration and control/candidate tests
remain in this same invocation.

No C/Linux build or syscall probe has run for this draft. The official Ubuntu
source retained with run 8 says other inherited FDs are passed to the executable
child (`bubblewrap.c` around lines 3343–3374). That is a source basis only, not
proof that this particular bwrap/AppArmor/PTY chain successfully preserves FD
3/4. The host parent identity, SCM_CREDENTIALS after namespace transitions,
accepted-socket credential inheritance, pidfd/proc inspection permissions, and
connected pathname mediation after listener unlink still require actual Linux
evidence; failure must be preserved, not bypassed.

## Next gates require review and separate authorization

No run is started by this draft. If authorized later, use the existing isolated
Ubuntu workflow, not production/main:

1. Compile this entry with the existing `-Wall -Wextra -Werror` command.
2. Preserve the original-policy control and its exact uid-map refusal. If this
   startup change fails earlier, report that failure; do not skip the control.
3. Only after exact resource cleanup, run the separate bootstrap
   `attach_disconnected` diagnostic candidate using the same entry/bwrap.
4. Verify actual outer→inner inode/readonly FD and real credential identity,
   successful and rejected/disconnected admission, no payload startup before GO,
   exec/PTY operation, and no startup/control/root descriptors in payload.
5. The unchanged dynamic workspace, denied future path, authorized extra root,
   no cross-request authorization leak, network and PTY Ctrl-C gates are still
   required. Old static receipts cannot stand in for this run.
6. Genuine worker re-entry with fabricated/sealed descriptors, wrong-peer/no-GO
   startup, path replacement while the FD is held, and descriptor-leak evidence
   remain dynamic negative tests to design within the reviewed scope. The local
   mocked/source tests are not those attack executions.
7. Preserve control/candidate outcomes separately, precise cleanup receipts and
   both original-bwrap restoration checks even if candidate fails.

## Production blockers explicitly remain

- `attach_disconnected` is still an isolated diagnostic candidate with aliasing
  risk, retained across bootstrap∩work. No production adoption is authorized.
- Installing root loader/entry or introducing a privileged launch path requires
  a separate production review and user decision. No daemon/sudoers change here.
- Dynamic Runtime grants/revocation across actual request lifetimes and portable-
  pty integration are not proven by this isolated Python controller.
- Ancestor-directory restrictions, existing hardlinks and delegated FD scope are
  not solved by manifest transport. The production Linux future-protected-path
  regression remains unresolved until a reviewed implementation and original
  tests pass without weakening assertions.
