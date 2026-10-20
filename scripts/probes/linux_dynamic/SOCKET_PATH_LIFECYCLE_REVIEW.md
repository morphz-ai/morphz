# Paired C/D socket pathname lifecycle diagnostic

Status: isolated experiment only, no production adoption or local policy changes.

Run 16, commit `23dd17c76cc2a91a49d4f09b9649476a06e00035`, failed on
Ubuntu kernel `6.17.0-1022-azure`. The inner entry's inherited FD 4 was a valid
stream socket (`fstat=0`, `is_socket=1`, `SO_TYPE=1`), but `read` of the admission
acknowledgement returned EACCES. It did not reach the worker. Empty run-scoped
kernel audit output does not identify the precise denying hook.

Run 15 used a different kernel, `7.0.0-1017-azure`, and reached the worker.
Consequently separate-run outcomes cannot establish a source-only cause.

## Exact paired change

Both lanes use the existing C policy: the bootstrap alone has the previously
isolated `attach_disconnected` diagnostic flag and exact `&work` stacking
target. The work policy is unchanged, including `mediate_deleted`. These are
not newly granted production permissions.

C uses the exact run 16 controller. D moves only its `admit.sock` unlink:

- In both lanes the listener is closed and cleared before sending `HOST`.
- C unlinks at that moment.
- D keeps the non-listening pathname until the unchanged worker-ready receipt
  arrives, or a refused/disconnected startup child exits. It then unlinks.
- All failure cleanup still removes a retained path through the existing
  cleanup code. There is no reconnect, second listener, new FD, policy rule,
  altered admission byte, changed syscall, retry or weakened assertion.

The test checks whether deleted-path lifetime affects the inherited socket
permission check. This is a hypothesis, not a finding. The retained name cannot
accept a new connection after its listener has closed.

## Gates and evidence

The original controller, entry, worker, loader, policy, bwrap diagnostic patch
and old A/B/C driver remain byte-identical. Generated C/D bundles have exactly
five inputs and differ only in controller bytes. The generator checks the
original controller hash and unique anchors; edited, extra or symlink inputs
are rejected. Both lanes run on the same machine and diagnostic bwrap binary.

D starts only after C's unchanged independent resource/installed-source
checks. C must either completely pass, or reproduce the exact valid-socket
FD 4 read EACCES with no admission or readiness. A different failure stops
the experiment, rather than being treated as equivalent.

Each lane runs the original full dynamic controller, not a reduced handshake
test. Independent exact profile collection, no-live-user checks, unchanged
kernel settings and binary restoration remain required. A failed C remains a
failed campaign and keeps the aggregate red even if D succeeds. Existing
independent `always()` restoration and failure artifact upload are retained.

Local validation covers generation, exact stage/error evidence, unchanged
policies/entry, inert default, cleanup-before-next-lane, original failure
retention and restoration failure retention. Local pure tests do not prove
AppArmor or Linux admission. Production integration, dynamic policy-service
installation, hardlink/delegated-FD coverage and all cross-platform release
checks remain separate pending gates.
