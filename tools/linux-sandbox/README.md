# Linux continuous-path sandbox service

Implementation in progress under the approved 2026-10-21 service/launcher plan.
This directory is **not yet installed, enabled, or a completed Runtime fix**.
The old strict terminal failure remains open until the actual Runtime path and
original CI test pass; this compiler cannot replace that acceptance.

The service accepts only the Runtime's typed, already-approved `SandboxPolicy`.
It never accepts shell commands, arbitrary AppArmor source, or requested profile
names. Registration must bind kernel peer identity, pidfd/start identity, actual
label and administrator-trusted executable identity. UID alone is insufficient.
The non-setuid launcher, pinned root descriptors, immutable policy generations,
private admission and cgroup-backed lifetime tracking remain required before
production integration. No automatic sudo or global security-setting changes.

`policy.py` is the pure deterministic compiler shared by the forthcoming service
and its tests. It preserves separate read/write denials, dynamic read/write roots,
exact literals and explicit rejection of symbolic globs. Its generated bootstrap
allows general execution because it stays in the final stack; **only the trusted
launcher may run before verified work-profile admission**. A general command may
never run in bootstrap alone. Kernel enforcement is not implied by string tests.

Local pure checks (no root, kernel policy or filesystem changes):

```sh
python3 -B -m unittest discover -s tools/linux-sandbox -p 'test_*.py' -v
```

The isolated `linux-sandbox-service.yml` workflow also loads the compiler's real
profiles through the distribution AppArmor parser. A fixed non-root worker
enters the exact enforcing stack before the host creates protected files. It
checks literal Unicode/metacharacter paths, `openat`, allowed siblings, separate
read/write denials, ancestor renaming, symlinks and replacement/recreation. The
worker and artifacts contain only synthetic data. This is a compiler/kernel
gate, not a substitute for the service, mount handoff, PTY or Runtime tests.
Neither this workflow nor the compiler changes global sysctl settings.

Mandatory next gates: real AppArmor 4.0 parser and adversarial literal-path tests;
authenticated service; pinned-object mount handoff; exact enforcing-stack/UID/
capability/NoNewPrivs confirmation before command execution; inherited-FD closure;
real exec and private PTY; background descendants and crash recovery; unchanged
Runtime terminal test and full CI. Installation only in isolated Linux/CI until
those gates are met and a production deployment is explicitly in scope.
