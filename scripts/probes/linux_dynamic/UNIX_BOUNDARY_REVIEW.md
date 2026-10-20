# Test-only boundary correction after run10 — review draft, not run

## Evidence and unchanged scope

Run10 `39458431838`, SHA `7716c76f87fafd63510d33a58f2daabb90584b9c`,
remains failed. Its C receipt 62 denied real host abstract connect (EACCES)
but allowed a same-process socketpair. The historical artifact and report are
unchanged:

- `/tmp/morphz-dynamic-ci-39458431838.gTNv0k/isolated-linux-dynamic-39458431838-1`
- `/tmp/morphz-full-app-regressions-20261020.OxfoEB/linux-dynamic-run10-result-and-unix-boundary.md`

The product's network isolation contract never prohibited same-domain self-IPC.
No new seccomp deny, removed Unix create, or broader AppArmor rule is justified
by that self-imposed probe assertion. Earlier prose describing anonymous IPC as
a negative is superseded by this explicit revision, not retroactively validated.

`policy_contract.py`, `entry.c`, `loader.py`, NNP, fixed FD3/FD4 handoff, diagnostic
Bubblewrap source/patch, workflow, and A/B/C driver remain byte-identical.
A still retains the UID-map failure, B the exact stack-target failure.
C still differs only by the previously reviewed bootstrap flag and exact
`&work` target. This revision changes controller/finite synthetic worker
observations and tests, not those three security policies.

## Three independent checks

1. Self socketpair is a **functional positive**: actual send and receive of the
   fixed synthetic greeting. A denial here is not a security success.
2. One actual host abstract listener is tested twice in the network-allow lane.
   Before the confined attempt, the unconfined controller connects with the
   same UID/GID, and the listener verifies exact kernel PID/UID/GID, bytes and
   EOF. The same listener remains bound for the confined attempt, which must
   report connect-stage EACCES/EPERM and no accepted connection. Missing
   listener, timeout, create refusal, wrong credentials or empty positive
   output cannot count as the intended negative.
3. The first exec launch receives one synthetic **extra inherited socket**.
   This is outside the entry protocol, not an additional authority mechanism:
   - Controller creates a socketpair, duplicates the child endpoint to a
     CLOEXEC slot at least 64, records `(st_dev, st_ino, S_IFSOCK)`, and uses
     `Popen(pass_fds=...)`. Parent endpoint copies are closed immediately after
     spawn. Fixed slots 3/4 and entry argv are unchanged.
   - Outer is authenticated exactly as before. While its pidfd is held and it
     waits for HOST, host enumerates **all** its FDs and requires the exact
     socket object at the injected slot. It also enumerates the controller's
     FDs and requires no remaining copy of the injection endpoint.
   - Inner's real credentials, identity, label and namespaces are checked as
     before. While its pidfd is held and it waits for GO, host enumerates all
     inner FDs; no duplicate of the target object may remain at any number.
     The worker sentinel must still be absent. Existing entry source closes
     extra FDs before sending this admission frame; no new hook is added.
   - Payload independently enumerates all FDs. **If the object is present,
     it attempts to send the bounded synthetic nonce through that object**,
     and records both presence and the send result. Either successful or
     denied send still fails the closure assertion: permission denial cannot
     disguise a leaked descriptor. An unrelated reused FD number is not used.
   - After explicit worker bye, wrapper exit 0, and host-copy closure, the
     retained peer must reach actual EOF with zero bytes. Timeout, silence,
     forced kill, failed startup, unreadable proc entries, missing injection,
     incomplete enumeration or payload error cannot establish a pass.

The A/B failed-startup lanes still record resource cleanup, but never claim
this FD boundary was validated. If aa-exec replaces/closes the endpoint before
outer, the injection positive fails before HOST. That is a probe evidence gap;
we will not add permissions or bypass the chain to manufacture a denial.

## Local validation and pending actual result

Local tests cover semantic positive/negative separation; full object matching
and duplicate slots; missing/wrong injection; proc inspection refusal; peer
nonce/timeout/EOF; payload actual nonce transmission over a local socketpair
(Linux proc identity mocked on macOS); refused send still failure; fixed
barrier ordering; and nonzero/never-ready cleanup cannot claim boundary success.
These tests do not establish AppArmor behavior or Linux inheritance.
Local command `python3 -B -m unittest discover -s . -p 'test_*.py' -v`
passed **81/81**; log:
`/tmp/morphz-full-app-regressions-20261020.OxfoEB/linux-dynamic-boundary-candidate-unit.log`.

Proposed next command, only after root review and separate authorization to
publish: existing isolated Ubuntu workflow and unchanged three-lane driver.
Its A/B failures stay visible even if C passes, with independent restoration
and exact profile cleanup. No next run has been started by this draft.

## Remaining non-claims

This synthetic inherited-object check is not all pathname Unix, SCM_RIGHTS,
pre-existing hardlink, delegated FD, arbitrary exec or cross-lane isolation.
NetworkAllow does not promise blanket cross-lane denial. Production trusted
installation, attach_disconnected aliasing risk, general command compatibility
and deployment authority still require separate design review. No main tree,
original application, host policy, permissions or production implementation
changes are included.
