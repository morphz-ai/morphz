# Linux sandbox administrator installation

This bundle contains the exact source components required by the accompanying
Runtime. Merely extracting it or installing `morphz` does not authorize or start
a privileged service. The normal user-level installer does not perform this
administrator setup. Do not register a user-writable executable or interpreter
as a trusted Runtime.

## Current acceptance boundary

Installation, actual Runtime exec/PTY, upgrades, rollback and drained uninstall
are wired to isolated Linux CI, not existing production machines. A release must
pass that native gate on its exact commit before this boundary is accepted. The
default operation still refuses an existing installation: changes require an
explicit administrator operation below. A source/unit test is not native
acceptance; inspect the installed lifecycle job's actual kernel results.

The tested baseline is Ubuntu 24.04, AppArmor 4, Bubblewrap 0.9 and cgroup v2,
with a kernel supporting per-message Unix pidfds (Linux 6.5 or newer) and
recursive `mount_setattr`. A binary's GLIBC 2.35 compatibility floor does not
mean that the sandbox supports an older kernel or AppArmor installation.
Other distributions require their own native validation. Missing requirements
fail closed before the work command; there is no automatic full-access fallback.

## First installation in an approved isolated Linux environment

1. Verify the release archive's published checksum, then have the administrator
   extract the complete archive into a new root-owned, non-user-writable version
   directory. Every ancestor and the native Runtime image must be root-owned and
   non-user-writable. Preserve the `linux-sandbox/` directory with the image.
2. Install the distribution dependencies explicitly: `apparmor`,
   `apparmor-utils`, `bubblewrap`, `gcc`, `libc6-dev`, `binutils`,
   `libapparmor-dev`, `libjson-c-dev` and Python 3. The installer compiles a static,
   non-setuid launcher using these local dependencies. It does not distribute
   a prelinked system-library binary or change global user-namespace settings.
3. From that verified version directory, an administrator invokes:

   ```sh
   sudo /usr/bin/python3 -I -B linux-sandbox/install.py --runtime /absolute/root-owned/version/morphz
   sudo systemctl daemon-reload
   sudo systemctl start morphz-sandbox.service
   sudo journalctl -u morphz-sandbox.service --no-pager
   ```

   Replace the example Runtime path with the actual installed native image.
   When installing an execution node, use its actual root-owned `morphz-edge`
   path. Repeat `--runtime` only for specific administrator-approved native
   Runtime images; never register Python, a shell, Cargo or an arbitrary user
   checkout. The Runtime and all work commands continue to run as a non-root user.
4. Verify actual restricted command execution and the late-created protected-file
   boundary, not only `--version` or service startup. The release CI performs this
   check using the packaged Runtime's authenticated terminal API without a model
   call. It creates `.env` only after the terminal has been admitted and requires
   a real permission denial, an outside-write denial, and an allowed local write.

`systemctl enable` and production deployment are separate administrator choices;
the installer does neither. On an installation failure it retains any completed
immutable generation/configuration for diagnosis instead of deleting live state.

## Diagnosis and recovery

Use `journalctl -u morphz-sandbox.service` and the Runtime's concrete admission
error. Confirm the exact running native image is registered, its ownership is
intact, the service is ready and AppArmor is enforcing. Do not fix a refusal by
disabling AppArmor, changing global sysctls, broadening directory grants, granting
the Agent root, or switching to full access automatically.

An administrative service restart closes pending admissions but does not remove
the enforcing profiles of existing commands. Durable lease recovery retains
protection while descendants remain. Do not delete `/var/lib/morphz-sandbox`,
unload its profiles, replace an installed generation in place or delete a trusted
Runtime image while work is active.

## Explicit upgrades and rollback

Extract each verified new bundle into a **new root-owned version directory**.
The installer checks every source file and ancestor before importing any local
module. A user-writable checkout, symlink, hard-linked source or pre-existing
Python bytecode cache is refused. The Runtime allowlist must be supplied in full
on every upgrade; include the old Runtime image if its existing process must
continue creating new commands.

```sh
sudo /usr/bin/python3 -I -B /root-owned/new-version/linux-sandbox/install.py \
  --upgrade --runtime /root-owned/old-version/morphz --runtime /root-owned/new-version/morphz
```

The result records `selected` and `previous` launcher paths. Each path names an
immutable `v1-<24 hex digits>` generation. The installer holds a separate
administrator lock, stages and verifies a complete content manifest, normally
stops only the service process (`KillMode=process`), atomically switches one
configuration and requires readiness from the exact systemd MainPID/start-time
and selected generation. New admissions may fail closed during this short
transition. Already admitted work is not killed or restarted: its cgroup and
original enforcing profiles remain, and recovery uses their exact saved source,
not the new compiler. Service overrides that could kill descendants are refused.

If the new service cannot become ready, the operation fails and restores the
prior configuration/service. It never removes live profiles as a recovery trick.
If the installer itself is interrupted, its fsynced transaction prevents another
unrelated change; explicitly restore its previous selection with:

```sh
sudo /usr/bin/python3 -I -B /root-owned/new-version/linux-sandbox/install.py --recover
```

The same journal covers initial installation and uninstall. After an interrupted
first install, `--recover` completes its selected config/unit without starting or
enabling the service. After an interrupted uninstall it restores the original
config/unit, enabled setting and previously running service. Audit records and
immutable images are never discarded as a recovery shortcut.

To select a previously verified, retained generation, pass its **exact basename**
from the earlier receipt, not a filesystem path:

```sh
sudo /usr/bin/python3 -I -B /root-owned/new-version/linux-sandbox/install.py \
  --rollback v1-0123456789abcdef01234567
```

That example is a placeholder, not a real installed generation. Rollback verifies
the retained manifest and original Runtime allowlist, then uses the same atomic
transition and automatic failure recovery as upgrade. No generation, lease or
trusted Runtime image is automatically deleted.

The unpublished initial experimental installer had no content manifest/readiness
contract. Its installations are explicitly rejected **before stopping the old
service**, rather than claiming an unprovable automatic rollback. They need a
separately reviewed administrator migration after existing work has drained.
Morphz 0.1.3 did not install this new service. This is not an upgrade path for an
arbitrary pre-existing privileged daemon.

## Refuse active uninstall; remove only after drain

```sh
sudo /usr/bin/python3 -I -B /root-owned/version/linux-sandbox/install.py --uninstall
```

Uninstall closes new admissions and exclusively locks durable state. It may
collect a lease only after the kernel atomically removes its **empty** cgroup;
only then can its profiles be unloaded. If any protected descendant or unknown
cgroup/profile remains, uninstall fails and restores the previously active
service. It has no `--force`, does not kill work and does not silently broaden
access. Once all work has exited, it disables/removes just the service unit and
active configuration. Root-owned immutable generations, lease/audit records and
the administrator lock remain available for diagnosis/reinstallation; no broad
recursive cleanup runs. Restricted Runtime work then fails closed until the
administrator installs/starts the service again.

The isolated CI lifecycle gate keeps the same admitted worker alive across a
real systemd upgrade, explicit rollback, an injected new-service startup failure
and a refused active uninstall. It checks its PID, late-created `.env` denial,
outside-write denial, allowed local writes and frozen profile source after each
transition; then rechecks actual Rust Runtime PTY/command boundaries before a
successful drained uninstall. Separate SIGKILL probes stop first installation
between config/unit writes and uninstall between unit/config removal, then
require real `--recover` success. Evidence is archived even when a step fails.
