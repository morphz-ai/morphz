# Local candidate delta and evidence index

Scope: independent `/tmp/morphz-linux-dynamic-probe.uUkbhj` plus the explicitly
authorized isolated probe branch only. No production file, main workflow,
repository index, running Runtime or developer-machine policy was modified.

## Changes from the initially blocked draft

The initial hashes are retained in `BLOCKED_REVISION_SHA256`; the source-level
NNP refusal evidence is retained in `KERNEL_REVIEW.md`.

- `entry.c`: replace `aa_change_profile` with `aa_stack_profile`, require exactly
  bootstrap+work in enforce mode, close inherited FDs, enforce NNP and zero
  effective/permitted/inheritable/ambient capabilities, then wait for GO before
  fixed Python/Bash argv. Uses system json-c/libapparmor.
- `policy_contract.py`: fixed executable allowlist for this finite probe only;
  explicitly enumerated bwrap setup paths/capabilities and loopback-setup socket
  permissions. No `flags=(unconfined)` and no general bootstrap `/** x` rule.
  Work gets no namespace/mount/transition capabilities. Protected leaves and
  nonrecursive ancestor denies are unchanged.
- `loader.py`: isolated Python import path, root-owned immutable source checks,
  exact exclusive manifest/policy writes; liveness recognizes stacked components,
  not only label prefixes. Live or unreadable users prevent collection.
- `controller.py`: kernel-credential/executable/stack/mount/namespace admission;
  positive sentinel, wrong-ACK and disconnect no-payload lanes; unique dynamic
  roots, transient read-only extra root, child cwd, live host edits, networking
  positive/negative control, strict PTY SIGINT and graceful cleanup. Interrupted
  campaigns keep failure status and attempt bounded exact-resource cleanup.
- `worker.py`: finite synthetic operations only; exact stack receipt and
  host-visible per-launch start sentinel; no generic arbitrary-command API.
- `workflow.yml`: independent fixed Ubuntu 24.04 workflow, triggered only by
  the exact `probe/linux-dynamic-apparmor-20261020` push branch or explicit dispatch,
  with system json-c/AppArmor development dependencies, fixed compile command and
  evidence upload.

Parent subsequently authorized publication/run on that new isolated branch.
The parent tree is remote main `c1c44bd516f0cbdd029b49833c619f0901bdb05d`.
Its Application and CI workflows push-trigger only on `main`; Release only on
`v*` tags; Session IO is `workflow_call` only. No existing job or deployment will
be triggered by the new probe branch. The old `probe/linux-apparmor-20261020`
branch remains at `4e8c91bf160c1f9f49f56810deddb53b8edf4840`, retaining its
independent 244-receipt successful run and earlier failure evidence.

## Actually executed locally

`python3 -B -m unittest -v test_contract.py`

Result: **19 tests passed**, 0 failures. Coverage includes
typed rejection cases, exact stack component/mode acceptance, source-order
admission checks, mocked mount/peer checks, real cleanup control-flow unit tests,
and prepare-only behavior. These are unit/static/mocked checks, not kernel proof.
The final length check also caught and fixed a deterministic Unix socket path
overflow: the fixed name is now `admit.sock`, giving a 104-byte path rather than
108 bytes before NUL. No transport or permission boundary changed.

Parent review follow-up: the original `not_granted["cat_stdout"] == ""` was an
empty-output assertion using a variable named `not_granted`, not a negated
assertion. The final helper additionally requires `cat_code != 0`; its unit test
rejects a fake-success exit, leaked output and a successful direct read. This is
stronger independent command evidence, not a correction of reversed logic.

The above was the pre-publication local result. The first isolated Linux run
below supersedes only the "not run" status, not the failed or unverified gates.

## Isolated run 1: parser refusal, not a dynamic-security result

Commit `49486bdf94a241547e0edb2dd2c34641a9b665a1`; run
<https://github.com/morphz-ai/morphz/actions/runs/39431642758>.
The 19 source/unit checks and `-Wall -Wextra -Werror` C compilation passed.
AppArmor 4.0.1 refused line 23: `unix rule: invalid value for addr='/tmp/.../admit.sock'`.
No bwrap/payload/admission lane was reached. Collection also failed because the
same invalid source could not be parsed; the summary remained failed. Kernel
settings were unchanged.

Original artifacts remain at
`/tmp/morphz-dynamic-ci-39431642758.llgnpX/isolated-linux-dynamic-39431642758-1`.
The original commit and run remain available. The generated sources were not
uploaded after failed acquire; the next revision preserves them before raising.

### Correction for run 2

- Official [AppArmor 4.0.1 manual](https://gitlab.com/apparmor/apparmor/-/blob/v4.0.1/parser/apparmor.d.pod)
  specifies file rules for filesystem Unix socket paths. Fine-grained `addr=`
  uses abstract/anonymous addresses, not `/path`.
- Replace both invalid peer-address rules with exact `admit.sock` `rw` rules.
  Add only stream `create,setopt,getopt` lifecycle permissions. The
  [Linux create check](https://github.com/torvalds/linux/blob/v6.17/security/apparmor/af_unix.c#L195-L221)
  happens before the pathname is known; entry explicitly sets I/O timeouts.
  No generic Unix connect/send/receive/bind/listen rule is added.
- Existing broad file permissions are unchanged; the exact rule does not claim
  to exclude all other writable filesystem sockets. Admission identity and GO
  remain independently authenticated; this is not a production socket policy.
- Add a live abstract listener in the same network namespace as the allow lane,
  and an anonymous socketpair negative control. Require EACCES/EPERM with no
  communication; ENOENT, ECONNREFUSED, timeout or a leaked byte fails the check.
- Copy immutable manifest and generated source to evidence before propagating
  a failed loader result. Do not hide parser or cleanup errors.

Local result: **22/22** unit/source tests pass, prepare-only prints no execution.
The three added checks cover exact rule syntax/scope, failure-source retention,
and strict Unix negative-control verdicts. They do not prove kernel enforcement.

## Isolated run 2: syntax accepted, bwrap UID-map startup refused

Commit `631d23c5e8710274a28a3a83c0f0aab0373551ae`; run
<https://github.com/morphz-ai/morphz/actions/runs/39433007290>.
22 unit/source tests and C compilation passed. Exact policy add and remove
both succeeded. The child stopped with
`bwrap: setting up uid map: Permission denied`; admission timed out and no worker
or Unix negative-control lane ran. The final summary correctly failed.

Raw generated source, manifest, stderr, transcript and receipts are preserved at
`/tmp/morphz-dynamic-ci-39433007290.pi6g79/isolated-linux-dynamic-39433007290-1`.
Kernel settings remained unchanged. The runner kernel was `6.17.0-1022-azure`
(different from run 1 despite the same fixed Ubuntu runner label).

### Diagnostic-only delta for run 3

No policy rule changes. Fixed entry records UID, dumpability, uid_map ownership
and capabilities immediately before its existing bwrap exec. The controller
reads the runner's bounded kernel journal only for this generated profile family.
It does not set dumpability, add capabilities, modify sysctl or change profiles.
The purpose is to distinguish a DAC/proc-ownership issue from an AppArmor denial;
it is not a claim that UID-map failure has been repaired. A new unit/source check
guards this read-only scope. Root explicitly authorized this diagnostic pass.

## Required next review / still unproven

Read the entire `STACKED_BOUNDARY_REVIEW.md`, compiler, loader and C entry before
publishing. Review exact `/proc` read-by policy, bootstrap bwrap setup rules and
fixed executable paths; these have not been validated by the Linux parser/kernel.

Then a separately approved isolated run may establish whether the startup chain
actually works. It must retain failure artifacts rather than retry with weaker
rules. Production arbitrary exec, Unicode/globs, real dynamic approval
integration, pre-existing hardlinks, inherited/delegated FD adversaries,
multi-client lease collection and the original strict Runtime Linux test remain
unverified. The ancestor-directory restriction remains a real product cost.

## Run 3 retained; same-source syscall diagnostic prepared

Commit `e4bf3b2c1bbe29eb85c8d8777fea279a0dbce614`, run
<https://github.com/morphz-ai/morphz/actions/runs/39434084185> failed at the same
UID-map startup boundary. The 23 source checks, C build and policy add/remove
passed. Outer entry was dumpable with zero effective capabilities. Audit
boot-to-boot ptrace read denials are not by themselves proof of the fatal
syscall: bwrap also ignores failures during namespace identity lookups.
No ptrace/capability permission has been added.

The next prepared change is `bwrap_diagnostic_runner.py`, a pinned Ubuntu
`0.9.0-1ubuntu0.3` source baseline and diagnostic pair, with exact root-private
backup/staged replacement/restoration at `/usr/bin/bwrap` on the disposable
runner only. `BWRAP_DIAGNOSTIC_REVIEW.md` is the complete implementation review.
The existing policy, controller, loader, entry and worker hashes are unchanged.
Local pure/source tests are 37/37; Linux build and real syscall results are
pending. Preserve all three earlier failed runs; this preparation does not turn
them into passing security evidence.

## Run 4: source extraction allowlist stopped before any replacement

Commit `c62ab258ee1305dcd7d3f7fc323709b770c349c5`, run
<https://github.com/morphz-ai/morphz/actions/runs/39438767606>:
37 source tests and entry C compilation passed. The source-download checksums
passed, then the archive extractor refused Ubuntu's existing relative symlink
`debian/tests/upstream-usrmerge -> upstream`. No binary lease or campaign was
created, no `/usr/bin/bwrap` replacement happened, and the always-step explicitly
reported restoration not required. Raw artifacts remain retained.

The narrow preparation fix adds only that exact source-package name/target to
the existing two-source pinned extraction allowlist, retaining rejection of
hardlinks/devices/traversal/unreviewed links and Python's data extraction filter.
An added positive/negative unit test accepts that exact relative link but rejects
changed targets. No policy, privileges, build inputs or campaign assertions
change. This failure is a probe preparation defect, not Linux sandbox evidence.

## Run 5: same-source baseline reproduced; resource gate refined

Commit `48e129f77211a6bf3e1ec7f7b47bb8ab40bee3a6`, run
<https://github.com/morphz-ai/morphz/actions/runs/39439397618>:
both exact-source C variants compiled, and the unmodified Ubuntu-source baseline
reproduced `setting up uid map: Permission denied`. Original binary restoration
succeeded in both finally and always-step, verified by hash/owner/mode/caps.

The diagnostic variant was not run: the wrapper treated the deliberate failed
`startup did not reach verified worker readiness` assertion as proof of resource
leak. The original controller actually retained that semantic failure while
polling/stopping its owned process, then the root loader proved no live
boot/work profile users and removed both profiles; kernel settings were unchanged.

The next runner-only delta separates permission to run a second diagnostic from
the campaign verdict. It requires exactly one acquired manifest, cleanup and
root collection per launch (or the corresponding exact one-per-launch set for
multiple launches); exact parser removal/collected label pairs; unchanged kernel
settings; no wrapper kill/error or other cleanup error. Only the exact readiness
failure may remain alongside that independent resource evidence. The original
exit 1, failed readiness assertion and overall failed verdict remain unchanged.
Four added unit tests exercise missing/extra/duplicate receipts, wrong labels,
collection refusal, failed remove, unknown argv, other cleanup error, kernel
change and forced kill. The unchanged real baseline receipts pass only the
resource gate, not the campaign verdict.
