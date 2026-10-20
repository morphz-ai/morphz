# Bootstrap pathname counterfactual — isolated, not production

## Run 10 draft: exact stacking permission, three retained lanes

Status: local draft and pure tests only; not pushed or run. This revision
supersedes the original two-lane execution description below, which is kept
as history. Root approved preparation of this exact three-lane comparison;
publication/execution still requires review of the completed diff.

Run 9 is retained at commit `c7fc9d9bb190f501ae61037b6a352e4832b0cd06`,
<https://github.com/morphz-ai/morphz/actions/runs/39454837932>.
Its artifact remains at
`/tmp/morphz-dynamic-ci-39454837932.rPuu7U/isolated-linux-dynamic-39454837932-1`.
The attach-only baseline completed both UID/GID mapping rounds and authenticated
the outer process, then reported
`dynamic entry refused: stack exact work profile (errno=13)`.
It did not send inner admission or reach worker readiness. The receiver's
generic credential/EOF message is not the causal error.

The [AppArmor 4.0 stack API documentation](https://apparmor.net/man/4.0/aa_stack_profile/)
and exact Ubuntu 4.0.1 source regression use `&target` for the stacking
transition. The current bootstrap already allows `/proc/** rw`; this draft
adds no proc rule, capability, ptrace grant, exec rule, socket grant or NNP
change. It does not attribute the API's errno to an unobserved open/write
syscall. Source evidence and hashes are in
`/tmp/morphz-full-app-regressions-20261020.OxfoEB/linux-dynamic-run9-stack-rule-review.md`.

| Lane | Fixed inputs | Required before proceeding |
|---|---|---|
| A `control` | Original frozen policy and launch chain | Exact original pre-write UID-map open EACCES, independent resource cleanup |
| B `bootstrap_attach_disconnected` | Generated A copy; only bootstrap declaration gets `attach_disconnected` | Both mapping rounds succeeded, one exact outer authentication, exact final stack API EACCES, no admission/ready, independent cleanup |
| C `bootstrap_attach_disconnected_stack` | Generated B copy; only exact work target gains `&` | Run the unchanged full dynamic controller; record actual outcome and cleanup |

C changes precisely one source line relative to B:

```diff
-  change_profile -> {manifest["profile"]},
+  change_profile -> &{manifest["profile"]},
```

No ordinary replacement target is retained beside the stacking target, and
there is no wildcard profile target. The generator refuses an altered B source.
Original `policy_contract.py`, `entry.c`, controller, loader, worker, diagnostic
patch/runner and workflow remain byte-identical to run 9. Both generated bundles
contain only the five existing runtime inputs. All non-policy bytes, including
the same compiled entry, are identical across the three lanes.

The diagnostic bwrap is installed once and used by all lanes. Actual binary
identity, frozen sources and exact generated bundles are checked around each
campaign. Each campaign must pass the existing independent profile collection,
no-live-user and unchanged-kernel resource gate. B's failure stage is checked
only after this gate; any missing evidence, different errno/stage, premature
admission, forced kill or cleanup error prevents C.

Both baseline campaign failures stay failures. The aggregate remains failed
even if C passes; the driver explicitly evaluates all three campaign outcomes
instead of calling the original diagnostic runner's two-variant aggregator.
The original finally restoration and independent workflow always-restoration
remain unchanged. C has no shortened assertion set and no new retry path.

Local verification:

- `python3 -B -m unittest discover -s . -p 'test_*.py' -v`: 68/68 pure tests.
  Five additional tests cover exact B-to-C bytes/worker identity, wrong
  candidate input, exact B evidence and negative variants, and refusal to
  start C after B's cleanup or failure-stage mismatch.
- Both new stage matching and unchanged resource gates were applied read-only
  to run 9's real A/B receipts and stderr; both matched while preserving
  `campaign_passed: false`. This is historical evidence parsing, not a new
  Linux execution or security pass.
- Default invocation remains inert. No local policy installation, sudo,
  network request, C build, remote push or GitHub run was performed.

The workflow's existing step display name still describes the preceding
pathname comparison; its actual driver is now the explicitly recorded A/B/C
comparison. No workflow behavior or permission changed.

Remaining boundaries: `attach_disconnected` alias risk is not resolved for
production. Dynamic sandbox admission, live authorization/revocation, future
protected paths and PTY have not passed this candidate yet. Pre-existing
hardlinks, delegated FDs, arbitrary production commands, trusted component
installation and production authorization remain outside demonstrated proof.
This draft and any future isolated pass do not authorize production adoption.

## Historical two-lane review (retained, superseded above)

The preceding diagnostic is retained at commit
`7c72e933b474808e12adedf26c340b2015eda0fe`,
<https://github.com/morphz-ai/morphz/actions/runs/39443043724>.
In the same child, the inherited directory FD (mount 30) and relative UID-map
stat/open failed while absolute `/proc/self/uid_map` (current proc mount 68)
stat/O_RDONLY-open/fstat succeeded. Parent read/readby audit was not a child
ptrace syscall. This supports a disconnected-path hypothesis, not a deployed fix.

## Exactly what this experiment changes

The original `policy_contract.py`, loader, entry, worker, controller, diagnostic
C patch, permissions and request schema remain frozen and unchanged.
The new default-inert `bootstrap_path_counterfactual.py` generates a separate
fixed bundle whose only source difference is:

```diff
-profile {manifest["bootstrap"]} {
+profile {manifest["bootstrap"]} flags=(attach_disconnected) {
```

The worker profile is byte-identical. No new rule, capability, ptrace access,
NNP/userns setting, syscall permission, executable, raw policy input or command
is added. No user/model-selectable mode is accepted by the trusted loader.

`bwrap_diagnostic_runner.campaign` receives one optional internal source
directory argument. Its default behavior, clean environment, process-group
ownership, timeout, signal cleanup and result preservation are unchanged.

## Execution and identity controls

1. Build the same pinned Ubuntu source pair as before. Install the diagnostic
   binary once under the existing private backup lease.
2. Run the original, fixed control bundle. Before and after every campaign,
   verify the actual `/usr/bin/bwrap` identity and frozen source inputs.
3. Require exact root-installed source hashes, the existing independent
   no-live-user/profile-removal cleanup gate, and the specific original
   pre-write UID-map open EACCES. A different failure or unexpected control
   success stops the comparison.
4. Run the generated candidate on the same runner and exact same installed
   binary. Keep the existing dynamic controller assertions unchanged.
5. Restore the original binary in `finally` and in a separate always step.
   Preserve any campaign error and any independent restoration failure.

The control remains a failed campaign. Even if the candidate passes, the
aggregate job does not become green by reclassifying the control; results are
reported separately. It is a causal experiment, not the production CI gate.

## Security meaning and coverage limit

AppArmor's [official documentation](https://apparmor.dev/man/apparmor.d/) warns
that `attach_disconnected` can alias paths. The flag is a debugging/policy
development mechanism, not a production recommendation here. It changes how
the bootstrap's existing grants can match disconnected objects, so it is a
real security interpretation change, not cosmetic configuration.

Bootstrap remains intersected with the unchanged worker policy after verified
admission. The experiment still has to pass actual future-path protection,
ordinary editing, protected-ancestor source rename, dynamic workspace,
additional-root read/revocation, read-only mount admission, network/socket and
PTY controls. The older static probe's broader destination-rename/symlink
matrix is not counted as coverage of this dynamic startup.

Pre-existing hardlinks, delegated FDs, arbitrary production commands, and
production installation/authorization remain unproven. Passing these lanes
would not authorize production adoption or further permission additions.

## Checks

51 pure tests pass locally, including eight new checks for inert default,
single declaration/unchanged worker bytes, modified/extra/symlink input refusal,
exact failed-control retention, independently installed source identity,
single binary installation/order, refusal to proceed after cleanup failure,
and retention of both original and restoration errors.

The patch applicability and original mapping logic checks from the previous
diagnostic remain unchanged. The new candidate has not yet run on Linux.
