# Kernel transition review — blocked candidate, not ready to run

Date: 2026-10-20. This record preserves a design contradiction discovered before
any privileged execution, compilation against Linux headers, or remote publication.

## Confirmed source-level blocker

The initial approved sketch used:

`confined bootstrap → bwrap → aa_change_profile(work) → admission → payload`

The first implementation mirrored this sketch; its pre-revision hashes are
retained in `BLOCKED_REVISION_SHA256`. It cannot be presented as a usable
candidate on the kernel reviewed:

1. Bubblewrap 0.9.0 unconditionally sets `PR_SET_NO_NEW_PRIVS` before namespace
   setup. Removing the same call in our outer entry therefore does not fix this.
   [Official source, lines 2684–2686](https://github.com/containers/bubblewrap/blob/v0.9.0/bubblewrap.c#L2684-L2686)
2. Linux 6.17 AppArmor checks non-stacking `aa_change_profile` under
   `no_new_privs`; a new label that is not a subset of the original confined label
   returns `-EPERM`, independently of the explicit change-profile permission.
   [Official source, lines 1523–1538](https://github.com/torvalds/linux/blob/v6.17/security/apparmor/domain.c#L1523-L1538)
3. The same source treats stacking separately. This suggests a candidate, not a
   claim of dynamic success: retain bootstrap and add the work profile rather
   than replace bootstrap.

The initial 11 passing unit/source tests did not exercise this kernel condition. No
AppArmor parser or bwrap command has been run by this bundle.

## Smallest revision, subsequently approved for isolated local implementation

The updated candidate uses `aa_stack_profile(work)` and validates the exact final combined label,
including both enforcing components. The work profile still denies protected
paths, additional namespace creation, policy mutation, and transition out.

Because stacked profiles intersect permissions, bootstrap must also permit the
executables and file operations required by the final synthetic worker. For this
probe these can be a fixed list (Python, Bash, cat, sleep); production arbitrary
commands would require a broader execution allow rule in bootstrap. That changes
the sketch's claim that **kernel bootstrap alone** can only execute entry/bwrap.

The finite pre-admission chain would instead be guaranteed by the root-owned
entry with fixed argv and typed immutable descriptor, plus authenticated
controller admission. No untrusted program is intentionally started before the
stack has been verified. This is a real trusted-code boundary and must be
reviewed explicitly, not described as equivalent to a kernel executable
allowlist or proven privilege separation.

Alternatives:

- Returning to `flags=(unconfined)` would evade the desired boundary. Not adopted.
- Removing NNP from entry does not change bwrap's own unconditional NNP.
- Replacing/patching bwrap's namespace setup would add a larger trusted Linux
  launcher, not a minimal correction. Not implemented.
- Marking this candidate green based on static tests is not acceptable.

See `STACKED_BOUNDARY_REVIEW.md` for the reviewed trust-boundary revision. No
remote execution or production installation follows automatically from it.

Production installation, system-service/setuid choices, full Runtime root/glob
semantics, pre-existing hardlink aliases, delegated FDs, and general lease
authentication remain separately unapproved or unverified.
