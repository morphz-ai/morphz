# Revised isolated candidate: retained bootstrap plus work stack

Status: parent approved this revision for the `/tmp` prototype; the retained-stack
code and local checks are now implemented. **No privileged or remote run is
authorized by this document; no dynamic result is claimed.** The original blocked
revision's hashes are retained in `BLOCKED_REVISION_SHA256`.

## Decision requested

Approve or reject this narrow revision for the isolated prototype:

`controller → bootstrap entry → fixed bwrap → trusted inner entry`

`→ aa_stack_profile(work) → verify both profiles → authenticated admission`

`→ fixed synthetic payload, still under bootstrap ∩ work`

Do not replace bootstrap, clear NNP, use an unconfined flag, patch bwrap, or allow
the workload to select a profile. The review changes **where the pre-admission
command guarantee lives**: it is guaranteed by the immutable trusted entry's
finite interface, not by a bootstrap kernel policy which forbids all
interpreters for the entire process lifetime.

## Why retaining bootstrap is necessary in this candidate

Bubblewrap unconditionally sets NNP. Linux 6.17's non-stacking change-profile
path rejects a different confined label which drops the original confinement;
the stacking path instead retains the old label and merges the target. See
[bwrap 0.9.0](https://github.com/containers/bubblewrap/blob/v0.9.0/bubblewrap.c#L2684-L2686)
and [Linux's transition implementation](https://github.com/torvalds/linux/blob/v6.17/security/apparmor/domain.c#L1523-L1545).

This establishes a source-level reason to test stacking; it does not establish
that our generated profiles, parser syntax, libraries, mounts or target runner
will work. The kernel and parser versions must be recorded during a later run.

## Permissions retained for the entire lifetime

Both profiles remain enforcing. For a mediated operation, permission in bootstrap
alone is not enough: work must also permit it. No profile is removed while the
launch or any descendants remain alive.

| Operation | Bootstrap must allow | Work must allow / reject | Effective payload boundary |
|---|---|---|---|
| Execute | Fixed trusted entry and bwrap; for this probe also exact system Python, Bash, cat and sleep paths using `ix` | Ordinary executable inheritance; explicit deny for sudo/parser/loader execution | Exact probe executables only, with both profiles inherited |
| Read/mmap | Existing broad read/mmap for binaries/libraries and namespace setup | Broad allowed reads minus exact protected leaves and aliases in scope | Either deny wins; protected leaf read remains denied |
| Write/link/lock | Necessary namespace setup paths and synthetic stage roots; ordinary child writes within roots | Workspace accesses, but explicit deny of protected leaves and non-recursive ancestor `w` | Live ordinary files writable; protected ancestors cannot be renamed/replaced |
| Mount/remount/umount/pivot | Needed by trusted bwrap before final stack | No work-profile mount permission | Denied to payload; NNP and zero capabilities also verified |
| Create user namespace | Needed by bwrap before final stack | No work-profile `userns` permission | Denied after stacking |
| Linux capabilities | Narrow bwrap setup capabilities in bootstrap | No capabilities granted by work; entry verifies effective/permitted/ambient sets empty | No restored setup capability in payload |
| Profile transition | Only this launch's work target, sufficient for the intended one-way stack operation | No change/stack profile permission | No payload transition to bootstrap-only, unconfined, or another work profile |
| Network | Allow only the frozen mode's required families; deny mode gets no inet/inet6 allow | Same frozen mode; private network namespace for deny | Allow must pass real loopback positive control; deny cannot reach it |
| Admission Unix connection | Exact per-launch socket only | Same exact per-launch socket only | Kernel peer checks precede GO; listener removed before payload starts |
| Signal/job control | Allow process signals needed by bwrap/Bash | Preserve signal permissions required for real foreground SIGINT | Exact `sleep == -SIGINT`, worker and shell must survive normally |
| Controller inspection | `ptrace (readby) peer=unconfined` only | Same read-by permission | Trusted unconfined controller can read required `/proc` identity/namespace metadata; no workload tracing permission is added |

The revised compiler explicitly adds link/lock/ordinary-write permission within
synthetic stage paths, exact Python/Bash/cat/sleep execution paths, and network
allow control. For bwrap's pre-stack setup, exact `/tmp/newroot`, `/tmp/oldroot`,
`/newroot`, `/oldroot` setup paths and inet-dgram/netlink-raw setup sockets are
listed; the work component still does not grant mount/userns/network in its deny
lane. The fixed controller is required to be unconfined, and read-by inspection
from that peer is explicit in both profiles. **No unrestricted `/** x` rule was
added.** These rules have not yet been parser- or kernel-verified.

Bootstrap's exact capability list is `sys_admin`, `sys_chroot`, `net_admin`,
`sys_ptrace`, `setuid`, `setgid`, `setpcap`; the first six match bwrap's documented
setup requirement in its source
[`REQUIRED_CAPS_0`](https://github.com/containers/bubblewrap/blob/v0.9.0/bubblewrap.c#L673-L677).
The profile permission does not create host capabilities for the non-root entry.
After namespace setup all effective/permitted/ambient capability sets must be
zero, and work grants none of these capabilities.

For production, arbitrary user commands would require broader bootstrap exec
permissions than this fixed probe list. That is a real additional review point.
Passing a finite-worker probe would not prove a production general-command
launcher safe.

## Exact pre-admission chain and trusted code

The controller is a trusted test coordinator, not model-controlled:

1. Controller invokes the one-shot root loader with a typed request through the
   isolated runner's explicit sudo. Loader compiles immutable manifest/policy,
   loads exact new profile names, exits, and never executes a user command.
2. Non-root controller starts only:
   `aa-exec -p <derived-bootstrap> -- <root-owned-entry> --outer <manifest>`.
3. Outer entry permits exactly three argv elements, reads the root-owned immutable
   descriptor with system json-c, verifies UID/path/root object identity and exact
   bootstrap label, and constructs bwrap argv itself. No request may supply a
   command string, executable, profile name, extra bwrap flag or pre-exec hook.
4. Bwrap starts only the same root-owned entry with `--inner <same-manifest>`.
5. Inner entry verifies bootstrap and object identities, dropped capabilities and
   NNP. It adds the single registered work profile and verifies the exact combined
   label. Verification must accept only the two expected components in the
   kernel's actual canonical presentation, both enforcing; no extra component,
   missing component, complain/mixed mode or unconfined component.
6. Inner closes all unrelated FDs, opens the exact private admission socket and
   waits. Controller checks SO_PEERCRED, descendant identity, `/proc/PID/exe`,
   label, mount flags, namespace identities, IDs and policy hash; it removes the
   listener and then sends exactly `GO\n`.
7. Only after GO, inner executes one of two fixed payload argv:
   - exec: `/usr/bin/python3 -I -B <trusted-worker> --profile <expected-stack>`
   - PTY: `/bin/bash --noprofile --norc -i -c <constant-script> ...`; the constant
     script invokes that same Python worker, propagates failure, prints one shell
     continuation receipt and exits. Manifest data is positional data, not shell
     code.

The trusted computing base now explicitly includes loader/compiler, C entry,
controller admission checks, system bwrap and system parser/libs. The root entry
is not setuid. The test sudo arrangement is not a production authorization
design. A local attacker already controlling the trusted host controller is
outside this isolated campaign's proof.

## Failure behavior — payload must not run

The source control flow must retain all of these hard stops:

- Bad typed request, mismatched UID, modified root object, unknown field,
  duplicate nonce, wrong manifest owner/mode, parser error: refuse before launch
  or admission; never fall back to FullAccess or unconfined.
- Missing/wrong/complain bootstrap: entry exits before bwrap.
- Stack call denied, either component missing, mismatched final label, elevated
  capability or absent NNP: exit before connecting or executing payload.
- Admission EOF, timeout, wrong bytes, peer/namespace/mount/hash mismatch:
  nonzero entry exit. No retry with weaker policy, no alternate direct exec.
- A failed cleanup is recorded independently; fallback killing an owned process
  does not convert the scenario to pass. A live or unreadable label-user scan
  prevents profile unload.

A source-level test cannot prove “no payload.” The next dynamic candidate must
include a deliberately rejected/closed admission lane with a host-observed
sentinel/worker-readiness absence and nonzero exit, plus a correctly admitted
positive lane. Refusal tests must not merely assert an arbitrary nonzero code.

## Small implementation delta if approved

1. Compiler: exact additional fixed exec paths and required ordinary file/network
   permissions in bootstrap; work's protection/transition/mount/userns deny
   boundary unchanged.
2. Entry: stack API in place of replacement API; exact two-component label
   verification and expected stack delivered to the fixed worker.
3. Controller/loader: final-stack peer verification; liveness/collection must
   detect either component inside stacked labels, not match only a profile prefix.
   Retain single live launch denial and post-exit collection checks.
4. Add static checks for both-component enforcement and absence of profile
   dropping/general command argv, plus a real rejected-admission lane to the
   staged campaign. Keep source, hashes and original blocked revision evidence.
5. Parent re-reviews diff before any remote publication. Dynamic results remain
   isolated feasibility evidence, not production or original CI acceptance.

## Explicit remaining limits

Protected-ancestor rename/mkdir/rmdir restrictions remain. Dynamic roots are
synthetic ASCII exact paths only. Pre-existing hardlink aliases, external FD
delegation, production caller authorization, atomic multi-client collection and
general command execution are not established by this revision. No privilege
service is installed or implied by approval of this isolated candidate.
