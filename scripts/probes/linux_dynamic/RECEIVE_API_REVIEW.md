# Fixed acknowledgement: read versus recv, isolated comparison only

Run 18 disproved pathname-unlink timing as a sufficient fix on the observed
Ubuntu 6.17 kernel: both variants denied `read(4)` before admission, while
the FD remained a valid stream socket. No worker or future-path security
test ran.

Primary Linux v6.17 sources show separate mediation paths:

- https://github.com/torvalds/linux/blob/v6.17/security/apparmor/lsm.c
  maps file permission and socket receive to different entry points.
- https://github.com/torvalds/linux/blob/v6.17/security/apparmor/af_unix.c
  implements security-boundary revalidation in `aa_unix_file_perm`.
  Blob inspected: `9129766d1e9c7c5d917e593a3c41690278f5c088`.

Inference, not a measured kernel-hook diagnosis: the different API path
could explain why the authenticated startup message can be sent but the
acknowledgement read is denied after profile stacking. The experiment
compares the existing `read(fd, buffer, size)` against `recv(fd, buffer,
size, 0)` in the fixed acknowledgement function. There is no error fallback,
policy relaxation, new socket, reconnect, new peer, reordered admission,
changed byte sequence, longer timeout, or model-supplied argument.

The trusted launcher reads only its already-connected startup socket here.
Its peer authentication, manifest validation, strict expected bytes,
profile stack, all extra-FD closure and no-payload-before-admission rule
remain unchanged. The original controller, worker and policy are identical
between the two lanes. The worker receives no control FD.

The experiment must not confuse API success with sandbox security: full
future-secret-path, abstract/anonymous-socket, inherited-FD, profile escape,
PTY, cancellation, process lifetime and collection checks remain mandatory.
A failed read baseline stays failed even if recv succeeds. An unrelated
baseline failure prevents the comparison. Resource gates, unchanged-kernel
checks and exact original Bubblewrap restoration remain required.

This is authorized disposable Linux diagnosis, not a proposal to bypass
production permission failures or grant broad Unix permissions. Production
integration and the privileged policy-service deployment still need review.
