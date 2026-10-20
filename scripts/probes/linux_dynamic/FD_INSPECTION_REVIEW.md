# Injected-socket inspection: distinguish identity refusal from non-socket FDs

Isolated probe candidate only. No production policy, Runtime code or macOS
permission change.

Run 17 reached the worker on kernel 7.0, then `os.fstat` failed with EACCES.
That traceback did not identify the FD. The earlier 6.17 admission-read
failure is separate and remains unresolved.

This revision does not exempt stderr, standard descriptors, or arbitrary
metadata errors. Every enumerated descriptor is inspected while the proc
directory FD remains open. Successful fstat evidence and exact injected
socket identity matching remain unchanged.

If and only if fstat returns EACCES, the worker additionally invokes
`getsockopt(SOL_SOCKET, SO_TYPE)` on the same existing FD. An exact ENOTSOCK
result proves this FD cannot be the injected socket, so it is retained as
an explicitly identified non-socket row, with both diagnostic results.
EBADF, EACCES, EPERM, an actual socket with unreadable identity, unexpected
result size, or a failed inspection still fails the boundary. There is no
open, duplicate, close, permission grant, guessed identity or blind write
in this additional type check.

The primary kernel reference inspected is Linux v6.17 `net/socket.c`, blob
`682969deaed35df05666cc7711e5e29f7a445c07`:
https://github.com/torvalds/linux/blob/v6.17/net/socket.c
`__sys_getsockopt` distinguishes EBADF, non-socket file operations
(ENOTSOCK), and socket permission/option processing. This source reference
is not a substitute for the actual Ubuntu/AppArmor candidate run.

Host-side positive injection, pre-GO full FD inspection, matching-inode
nonce attempt, post-exit peer EOF, no live profile users, exact profile
collection, kernel-setting checks and binary restoration are unchanged.
This proves the synthetic injected-socket property, not arbitrary
descriptor confidentiality. Any actual socket whose identity cannot be
inspected remains a failure, including a leaked socket moved to FD 0/1/2.

Local tests include actual file/socket/closed-FD probes, positive leaked
socket transmission, refused socket identity, every standard FD number,
incomplete enumeration, missing type evidence, and original exception
preservation. They are not AppArmor acceptance.

The paired socket-path driver remains unchanged. On a worker failure it
still refuses to run D. A passing worker scan does not erase the earlier
failure or establish that the socket-path lifetime hypothesis is correct.
