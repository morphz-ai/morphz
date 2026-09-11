# Windows managed shell argument preservation

Status: rebuilt native security regression passes; real-provider Cloud Windows
Edge acceptance remains pending. Production and the installed Windows bundle are
unchanged.

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

The complete four-binary Windows bundle was subsequently built from `80d6d3e9`
in an isolated source directory. Its first full native regression stopped at
the old assertion that `del /f /q` must return a nonzero status for an outside
file. A direct probe with those same rebuilt restricted-token helpers showed
status 0 and `Could Not Find ...`, while the controller independently verified
the outside file still existed with unchanged bytes. Protected `.env` reading
returned `Access is denied` / status 1. Ordinary quoted PowerShell, nested cmd
and the quoted metacharacter filename each produced the exact expected bytes
inside the physical workspace. This is genuine native sandbox execution, not
just the earlier argument probe. The rejected malformed diagnostic request
(boolean network instead of the `deny` enum) remains separate from these results.

The DEL regression now checks unchanged bytes directly, and additionally uses
ordinary quoted PowerShell `Remove-Item -ErrorAction Stop` to require an actual
failure status and preserved file. Network and process-tree assertions remain
unchanged and must still finish in the complete regression. This test correction
does not grant the restricted account any extra capability.

Follow-up `7888cfe516` finished at `2026-09-11T04:02:05.317Z`: the entire opt-in
native sandbox test passed in 25.73 seconds, with no ignored tests in that
selection. It exercised allowed writes, outside write/removal preservation,
protected reads, encoded and ordinary quoted PowerShell, nested cmd, metacharacter
filenames, the existing denied-network case and terminating the managed process
tree before its delayed write. The latter network case observes failed TCP
connection under network-deny; it is not a separate WFP-vs-network-path analysis.
The original four binaries were unchanged from build commit `80d6d3e9`; only the
test source was corrected and rebuilt. The owned remote source/build/probe
directory was removed after downloading and verifying all four artifacts.

Verified bundle SHA-256:

| Binary | SHA-256 |
| --- | --- |
| `morphz-edge.exe` | `4cfd2b0ffa5ef82e44a94a1339c0c25719ab505fea9cde4d9edba2c368b96a5c` |
| `morphz-windows-sandbox-runner.exe` | `f7fe65130b3e488b6645f5d8e8787fc49d4eaa77eff02b4b1e8ea3eb6d5c6181` |
| `morphz-windows-command-runner.exe` | `140a509dd4cad34955323d572b5a9bae5284a09975798add61dcc0a5a7e4305c` |
| `morphz-windows-sandbox-setup.exe` | `168b088031a9ad0213a0f1066e179e0ef7f915e833d0f7e31d17e93613709ba1` |

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
