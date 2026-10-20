# Local candidate delta and evidence index

Scope: independent `/tmp/morphz-linux-dynamic-probe.uUkbhj` only. No production
file, main workflow, repository index, running Runtime, host privilege setting,
kernel policy or remote branch was modified.

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

No Linux C compilation, AppArmor parser invocation, privileged installation,
bwrap launch, dynamic payload, Docker, Cargo, remote CI or original-app test was
performed for this candidate.

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
