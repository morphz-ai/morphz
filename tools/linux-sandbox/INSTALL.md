# Linux sandbox administrator installation

This bundle contains the exact source components required by the accompanying
Runtime. Merely extracting it or installing `morphz` does not authorize or start
a privileged service. The normal user-level installer does not perform this
administrator setup. Do not register a user-writable executable or interpreter
as a trusted Runtime.

## Current acceptance boundary

Installation and execution are being validated in isolated Linux CI, not on
existing production machines. The initial installer deliberately refuses an
existing installation. Upgrade/uninstall acceptance is still required before
production rollout; do not remove configuration or running profiles to bypass
that refusal. Keep the previous installed generation and active work intact.

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
unload its profiles, or replace trusted code while work is active. The initial
installer is not an upgrade or uninstall procedure.
