# Dynamic Linux policy prototype — review bundle only

**Status: second isolated Ubuntu run accepted the corrected policy but bwrap
stopped at UID-map setup before any payload. The next revision only records
startup diagnostics; it does not relax policy.** Read
[KERNEL_REVIEW.md](KERNEL_REVIEW.md) for the rejected initial transition and
[STACKED_BOUNDARY_REVIEW.md](STACKED_BOUNDARY_REVIEW.md) for the reviewed revision.

This directory is independent of Morphz's source tree and existing CI. Nothing
here has been installed on the developer machine or added to main. The candidate
has been pushed only to `probe/linux-dynamic-apparmor-20261020` and run with
explicit privileges on its disposable GitHub runner. The default controller
invocation remains prepare-only.

## What is implemented

- Fixed typed request: compiler ABI, run/launch IDs, exec or PTY, canonical cwd,
  1–4 authorized synthetic roots with read/write access, network allow/deny.
- A bounded compiler freezes root device/inode identities and immutable manifest
  hash. It rejects extra fields, duplicate JSON keys, non-root UID mismatches,
  symlink roots, raw AppArmor text, arbitrary commands, and unrecognized paths.
- One-shot root loader loads generated policy; it never launches a payload.
  Duplicate IDs use exclusive files and cannot replace an existing profile.
- A non-setuid C entry uses system json-c and libapparmor. No handwritten JSON
  parser and no dependency is added to the main project.
- Bootstrap remains stacked for the full payload lifetime. Its fixed executable
  list includes the synthetic worker's exact Python/Bash/cat/sleep paths; trusted
  entry's fixed argv, not a no-interpreter bootstrap rule, guarantees the
  pre-admission chain. The final work profile still forbids namespace creation,
  mounts and further profile transitions.
- Controller authenticates a private Unix admission with kernel peer UID/PID,
  descendant relationship, executable, exact label, namespace identities, root
  mount modes, and private `/tmp`. It closes the listener before `GO`.
- Payload is finite synthetic Python, not a general user command API. PTY uses
  controlling-terminal setup plus real interactive Bash. Ctrl-C must produce
  exact `-SIGINT` from the foreground sleep; normal shutdown requires bye,
  exit 0 and Bash's post-worker receipt.
- Cleanup failures retain the original failure. Live label users prevent policy
  unload. Only the exact generated profiles and known launched processes are
  addressed; immutable manifests remain as evidence.

## Current checks

Run without privileges:

```sh
python3 -B -m unittest -v test_contract.py
python3 -B controller.py
```

The first check currently contains 23 pure unit/source tests; the second prints
`prepare_only`. Neither is a Linux/AppArmor, compiled-entry, or runtime acceptance
test. Run 1 passed the previous 19 checks and C compilation, then failed at
AppArmor parsing. Run 2 passed 22 checks, C compilation, policy add and remove,
but failed bwrap UID-map startup. See `REVIEW_DELTA.md`.

## Planned dynamic campaign, not yet reached after the startup blocker

1. Create workspace A, load its policy, admit a worker in a child cwd.
2. After a real ready barrier, host creates `.env`, `.ssh/key`,
   `.morphz/config.toml`; direct open and cat must reject with empty secret output.
3. Verify ordinary create/edit/rename under the workspace and `.morphz`, immediate
   host edits, denied rename of protected ancestor, denied escape, refusal to
   collect while the worker is alive.
   Reject and disconnect two other admissions: exact refusal, no worker output,
   and absent per-launch host-visible sentinel are required; a positive lane
   independently verifies that the worker creates its own sentinel.
4. Create workspace B after A. Grant an extra read-only root only to one PTY
   launch, verify that root, strict Ctrl-C and protection after Ctrl-C.
5. Launch B again without the extra root; the previous grant must not persist.
6. Compare frozen network deny and allow against a real bound host loopback
   listener. Allow must connect and deliver a fixed synthetic greeting.
   In the shared-network allow lane, a real abstract Unix listener must still
   reject connection, and anonymous socketpair communication must be denied;
   both require EACCES/EPERM rather than a missing listener or timeout.
7. Graceful close and exact policy collection; unexpected fallback kill is a
   failed cleanup, never a success.

This minimal campaign does not repeat the prior probe's 244 receipts or claim to
replace its evidence. It is specifically about dynamic policy and a trusted
startup chain. The source-level NNP contradiction has a reviewed stacking
candidate, but no kernel test has demonstrated this revised scope yet.

## Isolation and intended dependencies

The proposed future runner is fixed `ubuntu-24.04`, using system `bubblewrap`,
`apparmor`, `apparmor-utils`, `libapparmor-dev`, `libjson-c-dev`, and GCC. It must
record installed versions, kernel, AppArmor state, source hashes, and unchanged
sysctl values. No privileged Docker, host-directory mount, developer-machine
installation, or sysctl edit is permitted.

Build invocation (passed on the first isolated Ubuntu run):

```sh
cc -std=c11 -Wall -Wextra -Werror -O2 entry.c -o entry -ljson-c -lapparmor
```

Execution would require explicit `--execute`, Linux, non-root controller, and
`MORPHZ_ISOLATED_DYNAMIC_PROBE=1`; only exact install/load/collect operations use
runner `sudo`. This is an isolated administrator/test arrangement, **not** an
installed production authorization mechanism. `--uid` is not a standalone
authorization token.

## Costs and unresolved boundaries

- Exact protected ancestor directory `w` denial prevents rename/rmdir/replacement
  of that ancestor and may prevent payload mkdir of a missing ancestor. Ordinary
  children remain writable; the restriction is intentional and not cost-free.
- Paths are limited to an explicit ASCII synthetic grammar. Unicode, symlink
  aliases, real Runtime permission approvals and full glob support are not
  implemented here; this restriction must not be imposed on the product silently.
- Pre-existing hardlink aliases and external/SCM_RIGHTS FD delegation are not
  solved by path denies. Entry closes inherited descriptors before payload; an
  adversarial inherited-FD dynamic case remains to be added and verified.
- Loader's `/proc` liveness scan plus exact nonreusable launch identity is a
  campaign lifecycle check, not a concurrent multi-client production lease or
  atomic unload protocol. A hostile trusted-host peer is outside this probe.
- Crash/recovery, missing/complain profiles, deliberate peer/namespace spoofing,
  incomplete parser load, and all inherited-FD lanes are not dynamically covered
  yet. The explicit wrong-ACK and disconnect lanes are written but not run.
  Do not count static assertions as those scenarios passing.
- Restrictive bootstrap permissions, namespace/mount mediation and kernel NNP
  transition semantics still need real isolated kernel validation. C libraries
  and warning-clean compilation passed both runs; corrected policy syntax passed
  run 2. UID-map startup remains unresolved. Diagnostic run 3 reads only
  dumpability/UID/proc ownership and this profile family's bounded kernel audit.

Any production adoption still requires review of installation privilege,
authorization and cleanup boundaries, then Rust exec/PTY integration and the
original Linux CI tests in their strict original order.
