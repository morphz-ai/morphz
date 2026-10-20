#!/usr/bin/env python3
"""Opt-in, disposable GitHub runner feasibility probe. Never runs Morphz."""

import argparse
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import pty
import re
import select
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import termios
import time
import traceback
import uuid


PREFIX = b"MORPHZ_PROBE_JSON "
POLICY_PATHS = (".env", ".ssh", ".morphz/config.toml")
DENIED_ERRNOS = (errno.EACCES, errno.EPERM)
SYSCTLS = (
    "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
    "/proc/sys/kernel/apparmor_restrict_unprivileged_unconfined",
)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def command(argv, **kwargs):
    return subprocess.run(argv, capture_output=True, text=True, check=True, **kwargs)


def interrupt_succeeded(result):
    return (
        result["received_sigint"]
        and result["returncode"] == -signal.SIGINT
        and 0 <= result["elapsed"] < 5
    )


def foreground_job_isolated(event, tasks, foreground, wrapper_pid):
    monitor = next((task for task in tasks if task["pid"] == wrapper_pid), None)
    worker, child, shell = event["worker"], event["child"], event["shell"]
    if monitor is None or foreground is None or foreground <= 0:
        return False
    translated = []
    for inside in (worker, child, shell):
        matches = [
            task for task in tasks
            if len(task["namespace_ids"].get("NSpid", [])) > 1
            and task["namespace_ids"]["NSpid"][-1] == inside["pid"]
        ]
        if len(matches) != 1:
            return False
        translated.append(matches[0])
    host_worker, host_child, host_shell = translated
    return (
        worker["pgrp"] > 0
        and child["pgrp"] == worker["pgrp"] == worker["tpgid"]
        and child["tpgid"] == worker["pgrp"]
        and shell["pgrp"] != worker["pgrp"]
        and shell["tpgid"] == worker["pgrp"]
        and host_worker["pgrp"] == host_child["pgrp"] == foreground
        and host_shell["pgrp"] != foreground
        and monitor["pgrp"] != foreground
    )


def is_nodev_null_mask(result):
    return (
        result["is_character_device"]
        and result["device_major"] == 1
        and result["device_minor"] == 3
        and len(result["mounts"]) == 1
        and "nodev" in result["mounts"][0]["options"]
        and "ro" in result["mounts"][0]["options"]
    )


def owned_profile_processes(profile):
    matches = []
    for process in Path("/proc").iterdir():
        if not process.name.isdigit():
            continue
        try:
            if process.stat().st_uid != os.geteuid():
                continue
            current = (process / "attr/current").read_text().strip()
        except FileNotFoundError:
            continue
        except ProcessLookupError:
            continue
        # An unreadable live same-UID task is not evidence that cleanup is safe.
        if profile in current:
            matches.append(int(process.name))
    return matches


def profile_source(name):
    if not re.fullmatch(r"morphz_probe_[a-f0-9]{20}", name):
        raise ValueError("profile name must be generated, not supplied by a command")
    denial = "\n".join(
        f'  audit deny "/tmp/probe/work/{path}" rwklmx,\n'
        f'  audit deny "/tmp/probe/work/{path}/**" rwklmx,'
        for path in POLICY_PATHS
    )
    ancestors = sorted({
        str(parent)
        for path in POLICY_PATHS
        for parent in PurePosixPath(path).parents
        if str(parent) != "."
    })
    # Exact directories only: child-file writes remain permitted. This has an
    # explicit compatibility cost: the ancestor itself cannot be created,
    # removed, renamed, or replaced by the confined payload.
    denial += "\n" + "\n".join(
        f'  audit deny "/tmp/probe/work/{ancestor}/" w,'
        for ancestor in ancestors
    )
    body = f"""
  / r,
  /** mrwlkix,
  signal,
{denial}
"""
    # The bootstrap has no automatic executable attachment and is used only by
    # this controller's fixed bwrap command. Payloads never execute in it.
    # No sysctl changes, privileged bwrap, CAP_SYS_ADMIN, or production policy.
    return f"""abi <abi/4.0>,
profile {name}_bootstrap flags=(unconfined) {{
  userns,
  change_profile -> {name}_enforced,
  change_profile -> {name}_complain,
}}
profile {name}_enforced flags=(mediate_deleted) {{
{body}}}
profile {name}_complain flags=(complain,mediate_deleted) {{
{body}}}
"""


def payload_command(profile, mode, lane, expect_label):
    worker = [
        "/usr/bin/python3", "-B", "/tmp/probe/code/worker.py",
        "--expect-label", expect_label or f"{profile}_{lane} (enforce)",
    ]
    inner = worker
    if mode == "pty":
        # Like the production Terminal, keep an actual interactive Bash with
        # job control. Do not exec-replace it with Python: that recreates the
        # failed third-run monitor/worker shared-foreground-group topology.
        script = (
            shlex.join(worker)
            + "; probe_worker_status=$?; "
            + "printf 'MORPHZ_PROBE_JSON "
            + "{\"kind\":\"worker_exit\",\"returncode\":%s}\\n' \"$probe_worker_status\"; "
            + 'if [ "$probe_worker_status" -ne 0 ]; then exit "$probe_worker_status"; fi; '
            + "/usr/bin/printf '%s\\n' "
            + shlex.quote('MORPHZ_PROBE_JSON {"kind":"shell_continued"}')
            + "; exit 0"
        )
        inner = ["/bin/bash", "--noprofile", "--norc", "-i", "-c", script]
    if lane != "baseline":
        inner = ["/usr/bin/aa-exec", "-p", f"{profile}_{lane}", "--", *inner]
    return inner


def process_topology(pid):
    """Only inspect identity/group fields, never command lines or environment."""
    proc = Path("/proc") / str(pid)
    fields = (proc / "stat").read_text().rsplit(")", 1)[1].split()
    status = (proc / "status").read_text().splitlines()
    return {
        "pid": pid, "ppid": int(fields[1]), "pgrp": int(fields[2]),
        "session": int(fields[3]), "tpgid": int(fields[5]),
        "namespace_ids": {
            key: [int(value) for value in line.split(":", 1)[1].split()]
            for line in status
            for key in ("NSpid", "NSpgid", "NSsid")
            if line.startswith(key + ":")
        },
    }


class Evidence:
    def __init__(self, output):
        self.output = output
        self.records = []
        self.checks = []

    def record(self, kind, **data):
        entry = {"kind": kind, **data}
        self.records.append(entry)
        with (self.output / "events.jsonl").open("a") as stream:
            stream.write(json.dumps(entry, sort_keys=True) + "\n")
        print(json.dumps(entry, sort_keys=True), flush=True)

    def check(self, name, passed, **data):
        entry = {"name": name, "passed": bool(passed), **data}
        self.checks.append(entry)
        self.record("assertion", **entry)
        if not passed:
            raise AssertionError(name)


class Worker:
    def __init__(self, evidence, profile, code, workspace, mode, lane="enforced",
                 expect_label=None, mask_existing=False):
        self.evidence = evidence
        self.mode = mode
        self.lane = lane
        self.buffer = b""
        self.index = 0
        self.master = None
        self.workspace = workspace
        self.admitted = False
        self.closed = False
        bwrap = [
            "/usr/bin/bwrap", "--die-with-parent",
            "--ro-bind", "/", "/", "--dev", "/dev",
            "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-net",
            "--proc", "/proc", "--cap-drop", "ALL",
            "--tmpfs", "/home", "--tmpfs", "/root", "--tmpfs", "/tmp",
            # The immutable root cannot acquire a new /probe mount target.
            # These carrier directories live only in the private /tmp tmpfs.
            "--dir", "/tmp/probe", "--ro-bind", str(code), "/tmp/probe/code",
            "--bind", str(workspace), "/tmp/probe/work",
            "--clearenv", "--setenv", "PATH", "/usr/bin:/bin",
            "--setenv", "HOME", "/tmp/probe/work", "--setenv", "LANG", "C.UTF-8",
            "--chdir", "/tmp/probe/work",
        ]
        if mode == "exec":
            bwrap += ["--new-session"]
        if mask_existing:
            bwrap += ["--ro-bind", "/dev/null", "/tmp/probe/work/.env"]
        inner = payload_command(profile, mode, lane, expect_label)
        argv = [
            "/usr/bin/aa-exec", "-p", f"{profile}_bootstrap", "--",
            *bwrap, "--", *inner,
        ]
        self.evidence.record(
            "spawn", mode=mode, lane=lane, argv=argv,
            fixture_root=str(workspace), mask_existing=mask_existing,
        )
        clean_env = {
            "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
            "LANG": "C.UTF-8", "HOME": str(workspace),
        }
        if mode == "pty":
            master, slave = pty.openpty()
            attributes = termios.tcgetattr(slave)
            attributes[3] &= ~termios.ECHO
            termios.tcsetattr(slave, termios.TCSANOW, attributes)

            def own_terminal():
                os.setsid()
                fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

            try:
                self.process = subprocess.Popen(
                    argv, stdin=slave, stdout=slave, stderr=slave,
                    preexec_fn=own_terminal, close_fds=True, env=clean_env,
                )
            finally:
                os.close(slave)
            self.master = master
            self.reader = master
            self.writer = master
        else:
            self.process = subprocess.Popen(
                argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, start_new_session=True,
                close_fds=True, env=clean_env,
            )
            self.reader = self.process.stdout.fileno()
            self.writer = self.process.stdin.fileno()

    def record_topology(self, point):
        tasks = []
        pending = [self.process.pid]
        visited = set()
        while pending:
            pid = pending.pop(0)
            if pid in visited:
                continue
            visited.add(pid)
            if len(visited) > 64:
                raise RuntimeError("unexpectedly large probe-owned process tree")
            try:
                tasks.append(process_topology(pid))
                children = Path(f"/proc/{pid}/task/{pid}/children").read_text()
                pending.extend(int(value) for value in children.split())
            except (FileNotFoundError, ProcessLookupError):
                self.evidence.record("topology_task_exited", point=point, pid=pid)
        foreground = os.tcgetpgrp(self.master) if self.master is not None else None
        self.evidence.record(
            "process_topology", mode=self.mode, lane=self.lane, point=point,
            wrapper_pid=self.process.pid, terminal_foreground_pgrp=foreground,
            tasks=tasks,
        )
        return tasks, foreground

    def next_event(self, timeout=12):
        deadline = time.monotonic() + timeout
        while True:
            if b"\n" in self.buffer:
                line, self.buffer = self.buffer.split(b"\n", 1)
                line = line.rstrip(b"\r")
                if line.startswith(PREFIX):
                    event = json.loads(line[len(PREFIX):])
                    if event["kind"] == "ready":
                        self.admitted = True
                    self.evidence.record(
                        "child_event", mode=self.mode, lane=self.lane, event=event
                    )
                    return event
                self.evidence.record(
                    "child_output", mode=self.mode, lane=self.lane,
                    text=line.decode(errors="replace"),
                )
                continue
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"no child event: {self.mode}/{self.lane}")
            if not select.select([self.reader], [], [], remaining)[0]:
                continue
            try:
                chunk = os.read(self.reader, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                chunk = b""
            if not chunk:
                if self.buffer:
                    self.evidence.record(
                        "child_tail", text=self.buffer.decode(errors="replace")
                    )
                    self.buffer = b""
                raise RuntimeError(
                    f"child ended before event: {self.process.poll()}"
                )
            self.buffer += chunk

    def request(self, op, **arguments):
        self.index += 1
        action = {"op": op, "id": self.index, **arguments}
        os.write(self.writer, (json.dumps(action) + "\n").encode())
        event = self.next_event()
        if op == "interrupt":
            self.evidence.check(
                "pty interrupt starts a real foreground child",
                event["kind"] == "interrupt_ready" and event["id"] == self.index,
            )
            tasks, foreground = self.record_topology("before_ctrl_c")
            self.evidence.check(
                "foreground job group excludes shell and Bubblewrap monitor",
                foreground_job_isolated(event, tasks, foreground, self.process.pid),
            )
            os.write(self.writer, b"\x03")
            event = self.next_event()
            self.record_topology("after_ctrl_c")
        self.evidence.check(
            f"{self.mode}/{self.lane}/{op} returned correlated receipt",
            event["kind"] == "result" and event["id"] == self.index,
        )
        return event

    def close(self):
        if self.closed:
            return None
        self.closed = True
        cleanup_errors = []
        if self.admitted:
            try:
                self.evidence.check(
                    "admitted worker remains alive until orderly shutdown",
                    self.process.poll() is None,
                )
                os.write(self.writer, b'{"op":"exit"}\n')
                event = self.next_event(timeout=3)
                self.evidence.check("admitted worker acknowledges shutdown", event["kind"] == "bye")
                if self.mode == "pty":
                    event = self.next_event(timeout=3)
                    self.evidence.check(
                        "interactive shell observes worker exit zero",
                        event["kind"] == "worker_exit" and event["returncode"] == 0,
                    )
                    event = self.next_event(timeout=3)
                    self.evidence.check(
                        "interactive shell continues a fixed command after worker",
                        event["kind"] == "shell_continued",
                    )
                self.process.wait(timeout=3)
                self.evidence.check("admitted worker exits successfully", self.process.returncode == 0)
            except Exception as error:
                cleanup_errors.append(error)
                self.evidence.record("worker_shutdown_failed", mode=self.mode, lane=self.lane, error=repr(error))
        elif self.process.poll() is None:
            # Expected missing/complain admission refusal must exit by itself.
            # A child that never became ready does not owe a normal bye receipt.
            try:
                self.process.wait(timeout=3)
            except Exception as error:
                cleanup_errors.append(error)
                self.evidence.record("refused_worker_did_not_exit", mode=self.mode, lane=self.lane, error=repr(error))
        if self.process.poll() is None:
            # Reap our own private group even on failure, but never count a
            # forced kill as a successful orderly close.
            error = RuntimeError("probe worker required forced cleanup")
            cleanup_errors.append(error)
            self.evidence.record("forced_worker_cleanup", mode=self.mode, lane=self.lane)
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.process.wait(timeout=3)
        if self.master is not None:
            os.close(self.master)
        else:
            self.process.stdin.close()
            self.process.stdout.close()
        self.evidence.record(
            "closed", mode=self.mode, lane=self.lane, returncode=self.process.returncode
        )
        return cleanup_errors[0] if cleanup_errors else None

    def __enter__(self):
        return self

    def __exit__(self, exception_type, _exception, _traceback):
        try:
            cleanup_error = self.close()
        except Exception as error:
            cleanup_error = error
            self.evidence.record(
                "worker_cleanup_failed", mode=self.mode, lane=self.lane, error=repr(error)
            )
        # Preserve the original failed security assertion if one is unwinding;
        # otherwise cleanup failure itself makes the mode fail.
        if cleanup_error is not None and exception_type is None:
            raise cleanup_error
        return False


def ready(evidence, worker):
    event = worker.next_event()
    evidence.check("child admitted only after label/security check", event["kind"] == "ready")
    evidence.check(
        f"{worker.mode} controlling-terminal semantics",
        event["isatty"] == (worker.mode == "pty")
        and event["controlling_tty"] == (worker.mode == "pty"),
    )
    worker.record_topology("ready")
    return event


def denied_read(evidence, worker, path, title):
    result = worker.request("read", path=path)
    evidence.check(title, not result["ok"] and result.get("errno") in DENIED_ERRNOS)
    result = worker.request("cat", path=path)
    evidence.check(
        title + " / real cat fails with zero content",
        result["returncode"] != 0 and result["stdout_hex"] == "",
    )


def run_mode(evidence, profile, code, root, mode):
    workspace = root / mode
    workspace.mkdir()
    marker = f"SYNTHETIC_ONLY_{mode}_{uuid.uuid4().hex}"
    # Reproduce the old missing-leaf hole with a synchronized, bwrap-only lane.
    # No protected file is created before this child signals readiness.
    with Worker(
        evidence, profile, code, workspace, mode, lane="baseline",
        expect_label=f"{profile}_bootstrap (unconfined)",
    ) as child:
        ready(evidence, child)
        evidence.check("baseline starts with absent .env", not (workspace / ".env").exists())
        (workspace / ".env").write_text(marker)
        result = child.request("read", path=".env")
        evidence.check(
            f"{mode} baseline reproduces future-file byte disclosure",
            result["ok"] and bytes.fromhex(result["bytes_hex"]).decode() == marker,
        )
    with Worker(
        evidence, profile, code, workspace, mode, lane="baseline",
        expect_label=f"{profile}_bootstrap (unconfined)", mask_existing=True,
    ) as child:
        ready(evidence, child)
        inspection = child.request("inspect_mask", path=".env")
        evidence.check(
            f"{mode} baseline mask is the real null character device on a nodev read-only bind",
            is_nodev_null_mask(inspection),
        )
        denied_read(evidence, child, ".env", f"{mode} baseline existing-file nodev mask denies reading")
    (workspace / ".env").unlink()

    with Worker(evidence, profile, code, workspace, mode) as child:
        ready(evidence, child)
        evidence.check("candidate starts with absent .env", not (workspace / ".env").exists())
        result = child.request("mkdir", path=".morphz")
        evidence.check(
            "explicit ancestor policy cost: absent protected parent cannot be created by child",
            not result["ok"] and result["errno"] in DENIED_ERRNOS
            and not (workspace / ".morphz").exists(),
        )
        (workspace / ".env").write_text(marker)
        denied_read(evidence, child, ".env", f"{mode}: create after start is denied")
        result = child.request("write", path=".env", text="must_not_write")
        evidence.check("protected write denied", not result["ok"] and result["errno"] in DENIED_ERRNOS)
        evidence.check("protected contents unchanged", (workspace / ".env").read_text() == marker)
        result = child.request("rename", source=".env", target="renamed-secret")
        evidence.check(
            "child cannot directly rename protected file into an allowed path",
            not result["ok"] and result["errno"] in DENIED_ERRNOS
            and (workspace / ".env").read_text() == marker
            and not (workspace / "renamed-secret").exists(),
        )

        (workspace / ".env").unlink()
        (workspace / "replacement").write_text(marker + "_REPLACED")
        (workspace / "replacement").replace(workspace / ".env")
        denied_read(evidence, child, ".env", f"{mode}: replacement remains denied")
        for relative in (".ssh/key", ".morphz/config.toml"):
            destination = workspace / relative
            destination.parent.mkdir(exist_ok=True)
            destination.write_text(marker + "_LATE_PARENT")
            denied_read(evidence, child, relative, f"{mode}: late parent {relative} denied")

        for content in ("CHILD_CREATE", "CHILD_EDIT"):
            result = child.request("write", path=".morphz/ordinary.txt", text=content)
            evidence.check(
                "exact ancestor denial preserves ordinary child-file creation and editing",
                result["ok"] and (workspace / ".morphz/ordinary.txt").read_text() == content,
            )
            result = child.request("read", path=".morphz/ordinary.txt")
            evidence.check(
                "ordinary file inside protected ancestor remains readable",
                result["ok"] and result["bytes_hex"] == content.encode().hex(),
            )
        result = child.request(
            "rename", source=".morphz/ordinary.txt", target=".morphz/ordinary-renamed.txt"
        )
        evidence.check(
            "exact ancestor denial preserves ordinary child-file rename",
            result["ok"] and not (workspace / ".morphz/ordinary.txt").exists()
            and (workspace / ".morphz/ordinary-renamed.txt").read_text() == "CHILD_EDIT",
        )
        result = child.request("mkdir", path="ordinary-dir")
        evidence.check("unrelated directory creation remains allowed", result["ok"])
        result = child.request("rename", source="ordinary-dir", target="ordinary-dir-renamed")
        evidence.check(
            "unrelated directory rename remains allowed",
            result["ok"] and not (workspace / "ordinary-dir").exists()
            and (workspace / "ordinary-dir-renamed").is_dir(),
        )
        result = child.request("rmdir", path="ordinary-dir-renamed")
        evidence.check(
            "unrelated directory removal remains allowed",
            result["ok"] and not (workspace / "ordinary-dir-renamed").exists(),
        )

        (workspace / "ordinary.txt").write_text("HOST_ONE")
        result = child.request("read", path="ordinary.txt")
        evidence.check("new ordinary host file visible live", result["ok"] and result["bytes_hex"] == b"HOST_ONE".hex())
        (workspace / "ordinary.txt").write_text("HOST_TWO")
        result = child.request("read", path="ordinary.txt")
        evidence.check("host edits visible live", result["ok"] and result["bytes_hex"] == b"HOST_TWO".hex())
        result = child.request("write", path="child-created.txt", text="CHILD_WRITE")
        evidence.check(
            "normal child writes immediately visible on host",
            result["ok"] and (workspace / "child-created.txt").read_text() == "CHILD_WRITE",
        )
        result = child.request("rename", source="child-created.txt", target="renamed.txt")
        evidence.check(
            "normal child rename immediately visible on host",
            result["ok"] and not (workspace / "child-created.txt").exists()
            and (workspace / "renamed.txt").read_text() == "CHILD_WRITE",
        )
        (workspace / "ordinary-alias").symlink_to(".env")
        denied_read(evidence, child, "ordinary-alias", f"{mode}: symlink cannot reveal denied path")
        result = child.request("hardlink", source=".env", target="hardlink-copy")
        evidence.check(
            "confined child cannot manufacture readable hardlink alias",
            not result["ok"] and result["errno"] in DENIED_ERRNOS
            and not (workspace / "hardlink-copy").exists(),
        )
        result = child.request("escape")
        evidence.check(
            "child cannot change back to unconfined",
            result["returncode"] == -1 and result["errno"] in DENIED_ERRNOS
            and result["label"] == f"{profile}_enforced (enforce)",
        )
        result = child.request("namespace")
        evidence.check(
            "child cannot create another user namespace",
            result["returncode"] == -1 and result["errno"] in DENIED_ERRNOS,
        )
        if mode == "pty":
            result = child.request("interrupt")
            evidence.check(
                "PTY Ctrl-C interrupts the real foreground sleep and preserves worker",
                interrupt_succeeded(result),
            )
            denied_read(evidence, child, ".env", "PTY remains confined after Ctrl-C")
            result = child.request("write", path="after-interrupt.txt", text="STILL_ALIVE")
            evidence.check(
                "PTY worker still performs allowed actions after Ctrl-C",
                result["ok"] and (workspace / "after-interrupt.txt").read_text() == "STILL_ALIVE",
            )

    # Fresh exec/PTY sees the same denial, not only the long-lived process.
    with Worker(evidence, profile, code, workspace, mode) as child:
        ready(evidence, child)
        denied_read(evidence, child, ".env", f"{mode}: fresh process existing-file denial")

    with Worker(
        evidence, profile, code, workspace, mode, lane="complain",
        expect_label=f"{profile}_complain (enforce)",
    ) as child:
        event = child.next_event()
        evidence.check(
            "complain mode fails admission before ready/payload",
            event["kind"] == "admission_rejected",
        )
        child.process.wait(timeout=5)
        evidence.check("complain refusal has nonzero status", child.process.returncode != 0)

    with Worker(
        evidence, profile, code, workspace, mode, lane="missing",
    ) as child:
        try:
            event = child.next_event()
        except RuntimeError:
            event = None
        child.process.wait(timeout=5)
        evidence.check(
            "missing profile refuses payload instead of falling back",
            event is None and child.process.returncode != 0,
        )

    # The third run proved the old exact-leaf policy leaks after ancestor rename.
    # This candidate deliberately adds exact ancestor-directory write denial.
    # Keep these strict checks last; earlier independent receipts are retained.
    with Worker(evidence, profile, code, workspace, mode) as child:
        ready(evidence, child)
        result = child.request("rename", source=".morphz", target="moved-parent")
        # Preserve byte evidence if the newly claimed protection still fails.
        if result["ok"]:
            child.request("read", path="moved-parent/config.toml")
        evidence.check(
            f"{mode}: protected ancestor source rename denied and contents preserved",
            not result["ok"] and result.get("errno") in DENIED_ERRNOS
            and not (workspace / "moved-parent").exists()
            and (workspace / ".morphz/config.toml").read_text() == marker + "_LATE_PARENT",
        )
        (workspace / "incoming-parent").mkdir()
        (workspace / "incoming-parent/ordinary.txt").write_text("ORDINARY_PARENT")
        result = child.request(
            "rename_exchange", source="incoming-parent", target=".morphz"
        )
        if result["ok"]:
            child.request("read", path="incoming-parent/config.toml")
        evidence.check(
            f"{mode}: protected ancestor target exchange denied and both directories preserved",
            not result["ok"] and result.get("errno") in DENIED_ERRNOS
            and (workspace / ".morphz/config.toml").read_text() == marker + "_LATE_PARENT"
            and (workspace / "incoming-parent/ordinary.txt").read_text() == "ORDINARY_PARENT",
        )
        denied_read(evidence, child, ".morphz/config.toml", "ancestor attacks do not expose the secret")
        # The same exact-directory rule has a real compatibility cost. Use an
        # empty directory so ENOTEMPTY cannot stand in for permission denial.
        (workspace / ".morphz/config.toml").unlink()
        (workspace / ".morphz/ordinary-renamed.txt").unlink()
        result = child.request("rmdir", path=".morphz")
        evidence.check(
            "explicit ancestor policy cost: even empty protected parent cannot be removed",
            not result["ok"] and result["errno"] in DENIED_ERRNOS
            and (workspace / ".morphz").is_dir(),
        )
        result = child.request("rename", source="incoming-parent", target=".morphz")
        evidence.check(
            "explicit ancestor policy cost: empty protected parent cannot be replaced",
            not result["ok"] and result["errno"] in DENIED_ERRNOS
            and (workspace / ".morphz").is_dir()
            and (workspace / "incoming-parent/ordinary.txt").read_text() == "ORDINARY_PARENT",
        )


def run(output):
    if sys.platform != "linux" or os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("This probe only runs in an explicitly dispatched disposable GitHub Linux runner")
    if os.environ.get("MORPHZ_ISOLATED_APPARMOR_PROBE") != "1" or os.geteuid() == 0:
        raise RuntimeError("Explicit opt-in and a non-root controller are required")
    for program in ("bwrap", "aa-exec", "apparmor_parser", "sudo", "python3"):
        if shutil.which(program) is None:
            raise RuntimeError(f"required official package executable missing: {program}")
    output.mkdir(parents=True, exist_ok=False)
    evidence = Evidence(output)
    before = {path: Path(path).read_text() if Path(path).exists() else None for path in SYSCTLS}
    code = Path(__file__).resolve().parent
    evidence.record(
        "environment", kernel=os.uname().release, uid=os.geteuid(), sysctls=before,
        source_hashes={path.name: digest(path) for path in code.glob("*.py")},
        packages=command(["dpkg-query", "-W", "bubblewrap", "apparmor", "apparmor-utils"]).stdout,
        apparmor_enabled=Path("/sys/module/apparmor/parameters/enabled").read_text().strip(),
    )
    profile = "morphz_probe_" + uuid.uuid4().hex[:20]
    policy = output / "generated.apparmor"
    policy.write_text(profile_source(profile))
    evidence.record("profile", name=profile, sha256=digest(policy), source=policy.read_text())
    # sudo is used solely for loading/removing these generated profiles. Payload
    # execution is non-root, capability-free and under the enforced label.
    loaded = False
    succeeded = False
    try:
        result = command(["sudo", "-n", "apparmor_parser", "--add", "--skip-cache", str(policy)])
        loaded = True
        evidence.record("profile_loaded", stdout=result.stdout, stderr=result.stderr)
        errors = []
        with tempfile.TemporaryDirectory(prefix="morphz-probe-fixtures-") as fixture:
            for mode in ("exec", "pty"):
                try:
                    run_mode(evidence, profile, code, Path(fixture), mode)
                except Exception as error:
                    evidence.record("mode_failed", mode=mode, error=repr(error), traceback=traceback.format_exc())
                    errors.append(mode)
        if errors:
            raise AssertionError(f"failed modes: {', '.join(errors)}")
        succeeded = True
    except Exception as error:
        evidence.record(
            "failure", error=repr(error), traceback=traceback.format_exc(),
            stdout=getattr(error, "stdout", None), stderr=getattr(error, "stderr", None),
        )
        raise
    finally:
        # Worker context managers terminate and reap only their own processes
        # before this point. Never remove an active confinement profile.
        original_error = sys.exc_info()[1]
        cleanup_error = None
        try:
            if loaded:
                active = owned_profile_processes(profile)
                evidence.check("all own confined tasks exited before unloading policy", not active, active_pids=active)
                result = command(["sudo", "-n", "apparmor_parser", "--remove", "--skip-cache", str(policy)])
                evidence.record("profile_removed", stdout=result.stdout, stderr=result.stderr)
            after = {path: Path(path).read_text() if Path(path).exists() else None for path in SYSCTLS}
            evidence.check("global AppArmor sysctls unchanged", before == after)
        except Exception as error:
            cleanup_error = error
            evidence.record("cleanup_failed", error=repr(error), traceback=traceback.format_exc())
        summary = {
            "status": "passed" if succeeded and cleanup_error is None else "failed",
            "checks": evidence.checks,
            "limitations": [
                "isolated feasibility only; no production Runtime integration",
                "broad test profile is not a reviewed production policy",
                "exact ancestor denial additionally prevents ancestor mkdir/rmdir/rename/replacement",
                "no claim about pre-existing hardlink aliases or inherited protected descriptors",
                "no claim about broker authentication, policy lifecycle or crash recovery",
                "probe emulates existing mount/session shape; it is not the real Rust test",
            ],
        }
        (output / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
        if cleanup_error is not None and original_error is None:
            raise cleanup_error
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    sys.exit(run(parser.parse_args().output.resolve()))
