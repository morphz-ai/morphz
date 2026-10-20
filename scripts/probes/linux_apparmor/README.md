# Isolated AppArmor + Bubblewrap feasibility probe

This is an explicitly authorized experiment on a disposable GitHub-hosted
Ubuntu 24.04 runner. It is **not a Morphz production backend**, does not repair
the existing Linux CI gate by itself, and must not be installed on the user's
Mac or a shared Linux host. No original profile, application database, model
credentials, task, or repository workspace is mounted as test data.

## What runs

The workflow installs distribution packages `bubblewrap`, `apparmor`, and
`apparmor-utils`. It never changes a sysctl, runs privileged bwrap, adds
capabilities to a payload, or starts Cargo. The non-root controller loads and
then removes three uniquely named AppArmor profiles using `sudo
apparmor_parser`. There is no executable attachment or replacement of an
existing profile.

The fixed bootstrap profile permits the namespace preparation phase without
disabling the runner's unprivileged-user-namespace restriction. Bubblewrap
sets up the read-only root, hidden home/temp roots, network/PID/user/IPC
namespaces, dropped capabilities, and a single **synthetic live writable
workspace**. Namespace-only mount carriers `/tmp/probe/code` and
`/tmp/probe/work` are created beneath the private `/tmp` tmpfs, never beneath
the read-only host root. Only after setup does `aa-exec` enter the enforced profile.
The child checks its exact kernel-reported `(enforce)` label, NoNewPrivs=1,
and zero effective/permitted/ambient capabilities before signalling readiness
or executing any synthetic action. Unknown/stacked/complain labels are not
silently accepted.

This experiment deliberately grants broad file permissions under the
read-only/masked mount baseline, then subtracts exact protected paths. That
is a measurement of deny-path feasibility, **not a reviewed least-privilege
production policy**. Production adoption still needs a separately reviewed
policy compiler, authenticated installer/broker, inherited-FD policy,
immutable profile identity, process-tree lifetime ownership, recovery, and
cross-platform integration.

## Actual evidence matrix

Each of `exec` (new session) and `pty` (independently allocated session and
controlling terminal, without bwrap's second setsid) exercises:

1. Bwrap-only missing-leaf baseline: the child signals readiness while `.env`
   does not exist; the controller then creates it; the child reads and returns
   the **exact synthetic bytes**. This verifies the old hole, not a real secret.
2. Bwrap `/dev/null` existing-file baseline: record `stat` and the exact
   `/proc/self/mountinfo` entry. Bubblewrap's ordinary read-only bind adds
   `nodev`, so the mask must be character device `1:3` on a read-only nodev
   mount; direct reads must return EACCES/EPERM and real `cat` must exit
   nonzero with no bytes. The second experiment disproved the original
   assumption that this behaved like a normally readable `/dev/null`.
   That failed run is retained; existing-leaf denial does not repair the
   separate future-leaf disclosure.
3. Candidate future `.env`, host unlink/replace, and late `.ssh` /
   `.morphz/config.toml` parent creation. Direct reads must get EACCES/EPERM;
   real `/bin/cat` must exit nonzero and return zero content.
4. A protected write and direct rename must fail and preserve the host bytes.
5. Ordinary host file creation/edits remain immediately visible; ordinary
   child creation/rename immediately updates the host workspace.
6. Symlink reads cannot expose protected bytes; creating a hardlink from the
   protected file must fail. This does not claim that a separate pre-existing
   hardlink under an unprotected pathname is an inode-level secret.
7. Child process inheritance (`cat`), attempted change to `unconfined`, and
   another user namespace. The latter two must return permission errors.
8. Fresh process after protected files exist: same real read failure.
9. Complain and missing profiles fail admission before any ready/payload.
10. For PTY only: write a real Ctrl-C byte to the terminal after a
    foreground `/bin/sleep` starts. It must be interrupted promptly; the
    direct child must exit with `-SIGINT` (not merely any nonzero status);
    the worker survives and remains unable to read `.env`.
11. Rename the otherwise allowed `.morphz` parent directory. Either that
    operation must be denied, or the child must still be unable to read
    `moved-parent/config.toml`. A byte disclosure is a **candidate limitation
    and probe failure**, not grounds to silently broaden the parent's write
    denial. This attack is last so the earlier matrix still has evidence.

Host mutation always occurs **after a JSON readiness receipt over the real
pipe/PTY**. There are no timing sleeps standing in for the race barrier.
The probe records errno, command exit status, zero/nonzero returned bytes,
labels, source/profile hashes, package versions, and unchanged sysctls.
Every failure remains an experiment failure; there is no retry-to-green,
fallback to unconfined execution, conditional skip, or weakened assertion.
Both exec and PTY are attempted once, even if one fails.

The controller reaps its own workers and verifies no same-UID task still
uses an owned profile before unloading it. If that cannot be established,
cleanup fails and the runner teardown remains the final boundary; the
controller does not unload a profile around a live task.
An admitted worker must return a `bye` receipt and exit zero. Timeout-driven
forced cleanup is recorded as a failure even when the process is recovered;
it cannot turn into a passing summary or hide the original assertion error.

## Running and publishing safely

Only these four files plus this README belong in a dedicated
`probe/linux-apparmor-*` branch:

```text
.github/workflows/linux-apparmor-probe.yml
scripts/probes/linux_apparmor/probe.py
scripts/probes/linux_apparmor/worker.py
scripts/probes/linux_apparmor/test_probe.py
scripts/probes/linux_apparmor/README.md
```

Create that branch from the reviewed remote baseline using an isolated
temporary Git index or separate managed checkout. Do not commit the current
large dirty workspace. Pushing that branch triggers only this workflow;
manual dispatch is also declared for later use when the workflow is
discoverable. The workflow has read-only contents permission and checkout
does not retain Git credentials.

The script refuses non-Linux, non-GitHub, root-controller, or missing explicit
opt-in execution. The exact CI command is:

```sh
MORPHZ_ISOLATED_APPARMOR_PROBE=1 python3 -B scripts/probes/linux_apparmor/probe.py \
  --output "$RUNNER_TEMP/morphz-apparmor-evidence"
```

Local static checks (no security claims):

```sh
python3 -B -m unittest discover -s scripts/probes/linux_apparmor -p test_probe.py -v
```

`events.jsonl`, generated policy, and `summary.json` are uploaded on success
or failure. Inspect them before proposing production adoption. Missing
AppArmor, unsupported ABI, namespace denial, no_new_privs transition failure,
or incorrect labels are **real feasibility failures**, not reasons to change
global system protection.

## Primary references

- [Ubuntu AppArmor policy grammar and enforcement](https://manpages.ubuntu.com/manpages/noble/man5/apparmor.d.5.html)
- [Ubuntu aa-exec profile selection](https://manpages.ubuntu.com/manpages/noble/man1/aa-exec.1.html)
- [AppArmor's unprivileged namespace restrictions](https://gitlab.com/apparmor/apparmor/-/wikis/unprivileged_userns_restriction)
- [AppArmor's no_new_privs boundary](https://gitlab.com/apparmor/apparmor/-/wikis/no_new_privs)
- [Bubblewrap v0.9.0 mount implementation](https://github.com/containers/bubblewrap/blob/v0.9.0/bubblewrap.c)

Production policy must not use unsafe `attach_disconnected` to silence path
resolution failures. Such failures are evidence to investigate.
