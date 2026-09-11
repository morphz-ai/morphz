# Windows managed shell argument preservation

Status: argument-layer fix verified; rebuilt native sandbox and cloud Edge
acceptance still pending. Production and the installed Windows bundle are unchanged.

A real Provider-to-Windows Edge run exposed a command-line encoding defect.
The model supplied ordinary nested quotes, without literal backslashes, as in
`powershell -NoProfile -Command "Write-Output 'MORPHZ_OK'"`. The native helper
launches `cmd.exe /D /S /C` but encoded the entire script tail using CRT argv
quoting. That inserted backslashes before the inner quotes. PowerShell then
printed a quoted expression rather than running the intended script; a nested
`cmd /c` command also failed to parse. This was not an approval denial.

The new portable command-line module keeps ordinary executable arguments under
CRT quoting, while a recognized single `cmd /C` script tail retains its source
inside the outer quote pair consumed by `/S`. The existing `/D`, `/S`, `/Q`
switches are preserved; `/S` is added when absent. Pipe and ConPTY launch paths
now use the same serializer. No filesystem authority, permission profile, token,
network setting, protected path, CWD junction or Job Object policy is relaxed.

The quoted-PowerShell regression failed with the original serializer, showing
the unwanted backslashes, then passed with the fix. The sandbox crate's 30
portable library tests pass. On a real Windows x64 machine, an isolated offline
probe using the installed Rust 1.97.1 toolchain passed all four module tests,
including actual PowerShell, nested cmd and a filename containing spaces and
`&`; each command produced byte-identical files through relative paths. The
probe directory was removed after completion. This is native argument handling,
not yet restricted-token sandbox execution.

The opt-in native sandbox regression now includes those same ordinary quoted
commands, in addition to its existing outside/protected-path, network and
process-tree checks. It must be run with newly built helpers. The earlier
Base64-only PowerShell test did not exercise this boundary and must not be used
to claim the new path passed.

The restricted account's displayed CWD may be a junction under its own profile;
that display alone is not evidence of a wrong workspace. The new file assertions
check the requested physical workspace rather than relying on printed CWD text.
Upstream provenance and local changes remain documented in the vendored crate's
`UPSTREAM.md`; this fix does not claim original authorship of that sandbox.
