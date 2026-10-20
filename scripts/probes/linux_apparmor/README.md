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
For PTY, the same profile also covers a fixed `bash --noprofile --norc -i`
interactive shell which starts the worker as a foreground job. The child
checks its exact kernel-reported `(enforce)` label, NoNewPrivs=1,
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

## Fourth candidate: explicit costs and retained failed evidence

The third run, [39417850479](https://github.com/morphz-ai/morphz/actions/runs/39417850479),
at commit `2e7d1de376d16820c04a13813d509914ed88bbbe`, **failed**:
renaming `.morphz` to `moved-parent` disclosed the synthetic protected file.
Its original generated-policy SHA-256 is
`f7bafbfebefff978ed5f441394046846442c004f65a190ff5fd7ebbbfd836e0f`;
its original event-log SHA-256 is
`206b17232ee2f1d830c41dc00376acd05c5e65d1c2a52d1ab2e6169ebaca9e2c`.
The artifacts and source commit remain unchanged.

This next isolated candidate **adds**, rather than silently assumes, exact
`deny w` rules for each renameable directory ancestor of a protected leaf.
For this fixture that is `/tmp/probe/work/.morphz/`, not
`/tmp/probe/work/.morphz/**`. Ordinary child-file operations must remain
available. The cost is real: the confined process can no longer create,
remove, rename, or replace `.morphz` itself, even when empty or when its
protected file does not yet exist. Trusted host creation is still live.
This change is authorized for the experiment only, not production policy.

The third run's direct Python PTY worker also shared the terminal foreground
group with the outer Bubblewrap monitor: Ctrl-C ended the monitor with
`-SIGINT` before any child-result receipt. That topology is not the production
interactive-shell topology. The next probe keeps actual Bash job control,
records PID/PGID/SID/terminal foreground groups and namespace PID mappings,
and requires the foreground worker/sleep group to exclude both shell and
monitor. It does not ignore SIGINT or weaken the exact child-exit check.

Neither change solves pre-existing hardlink aliases or delegated/inherited
secret file descriptors. AppArmor is a path-based policy, not an inode or
already-open-descriptor revocation guarantee. Both the probe and portable-pty
close unrelated descriptors before exec; deliberate FD injection and any
future broker's descriptor-transfer policy remain unverified. Host-side
exposure through another alias is outside this candidate's claimed boundary.

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
   child creation/rename immediately updates the host workspace. Files inside
   `.morphz` remain creatable, readable, editable, and renameable. Unrelated
   directories remain creatable, renameable, and removable.
6. Symlink reads cannot expose protected bytes; creating a hardlink from the
   protected file must fail. This does not claim that a separate pre-existing
   hardlink under an unprotected pathname is an inode-level secret.
7. Child process inheritance (`cat`), attempted change to `unconfined`, and
   another user namespace. The latter two must return permission errors.
8. Fresh process after protected files exist: same real read failure.
9. Complain and missing profiles fail admission before any ready/payload.
10. For PTY only: write a real Ctrl-C byte to the terminal after a
    foreground `/bin/sleep` starts and process-group telemetry verifies that
    shell/monitor are excluded from that foreground job. It must be interrupted promptly; the
    direct child must exit with `-SIGINT` (not merely any nonzero status);
    the worker survives, performs another allowed write, and remains unable
    to read `.env`. On normal worker exit, Bash must observe its zero status,
    continue a separate fixed harmless command, and itself exit zero.
11. Rename the now explicitly protected `.morphz` ancestor: require a real
    permission error and preserved secret, not merely an unreadable renamed
    path. A reverse `renameat2(RENAME_EXCHANGE)` into that ancestor must also
    fail and preserve both directories. If either unexpectedly succeeds,
    record the attempted secret read before failing the scenario.
12. Record the compatibility cost as enforced behavior: child-side creation
    of a missing protected ancestor, removal of an empty ancestor, and
    replacement of that empty ancestor by an ordinary directory all fail
    with EACCES/EPERM. The directory is emptied by the trusted synthetic
    controller before removal/replacement so ENOTEMPTY cannot masquerade
    as permission enforcement.

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
- [GNU Bash job-control process groups](https://www.gnu.org/software/bash/manual/html_node/Job-Control-Basics.html)
- [Linux v7.0 AppArmor delegated/cached descriptor semantics](https://github.com/torvalds/linux/blob/v7.0/security/apparmor/file.c)

Production policy must not use unsafe `attach_disconnected` to silence path
resolution failures. Such failures are evidence to investigate.
