# Bootstrap pathname counterfactual — isolated, not production

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
