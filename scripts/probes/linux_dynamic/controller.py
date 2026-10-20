"""Isolated Linux campaign. Default is prepare-only; no production installation."""

import argparse
from contextlib import contextmanager
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import termios
import time
import traceback
import uuid

from policy_contract import ABI, PROBE_EXECUTABLES, decode, stack_labels, validate_request

TRUSTED = ("loader.py", "policy_contract.py", "worker.py", "entry")
MARKER = "MORPHZ_ISOLATED_DYNAMIC_PROBE"
CLEAN_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"}
PREFIX = "DYNAMIC_JSON "
KERNEL_READONLY = (
    "/sys/module/apparmor/parameters/enabled",
    "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
    "/proc/sys/kernel/unprivileged_userns_clone",
    "/proc/sys/user/max_user_namespaces",
)


def kernel_settings():
    result = {}
    for name in KERNEL_READONLY:
        try:
            result[name] = Path(name).read_text().strip()
        except OSError as error:
            result[name] = {"unavailable_errno": error.errno}
    return result


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def exception_diagnostic(error, phase):
    """Preserve the original failure; diagnostics never affect its verdict."""
    return {
        "phase": phase, "type": type(error).__name__, "errno": getattr(error, "errno", None),
        "filename": getattr(error, "filename", None),
        "filename2": getattr(error, "filename2", None),
        "traceback": "".join(traceback.format_exception(type(error), error, error.__traceback__)),
    }


def command(argv, *, input_data=None, timeout=20):
    result = subprocess.run(argv, input=input_data, text=True, capture_output=True,
                            timeout=timeout, env=CLEAN_ENV, check=False)
    return {"argv": argv, "code": result.returncode,
            "stdout": result.stdout, "stderr": result.stderr}


def must(record):
    if record["code"] != 0:
        raise RuntimeError(json.dumps(record))
    return record


def ungranted_root_unreadable(result):
    return (result["open"].get("errno") == errno.ENOENT
            and result["cat_code"] != 0
            and result["cat_stdout"] == "")


def abstract_connection_denied(result):
    return (result.get("ok") is False and result.get("phase") == "connect"
            and result.get("errno") in (errno.EACCES, errno.EPERM)
            and not result.get("received"))


def self_ipc_works(result):
    return (result.get("ok") is True and result.get("phase") == "receive"
            and result.get("received") == "DYNAMIC_ANONYMOUS_SYNTHETIC\n")


def fd_table(pid):
    """Complete snapshot while the authenticated single-threaded entry is blocked.

    Any unreadable/disappearing FD is an inspection failure, never an absent
    target. The host calls this with the sender pidfd held before HOST / GO.
    """
    rows = []
    with os.scandir(f"/proc/{pid}/fd") as entries:
        for entry in entries:
            if not entry.name.isdecimal():
                raise RuntimeError("unexpected proc FD entry")
            info = os.stat(entry.path)
            rows.append({"fd": int(entry.name), "dev": info.st_dev,
                         "ino": info.st_ino, "kind": stat.S_IFMT(info.st_mode),
                         "link": os.readlink(entry.path)})
    return sorted(rows, key=lambda row: row["fd"])


def matching_socket_fds(rows, target):
    return [row["fd"] for row in rows if
            (row["dev"], row["ino"], row["kind"]) ==
            (target["dev"], target["ino"], stat.S_IFSOCK)]


def require_outer_injection(rows, target, injected_fd):
    matching = matching_socket_fds(rows, target)
    if injected_fd not in matching:
        raise RuntimeError("synthetic socket was not actually inherited by outer")
    return matching


def peer_eof(peer, timeout=3):
    """No data is insufficient: require actual EOF, bounded bytes and time."""
    deadline = time.monotonic() + timeout
    data = bytearray()
    try:
        while len(data) <= 128:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("peer EOF deadline expired")
            peer.settimeout(remaining)
            block = peer.recv(129 - len(data))
            if not block:
                return {"eof": True, "received_hex": data.hex(), "error": None}
            data.extend(block)
        return {"eof": False, "received_hex": data.hex(), "error": "byte bound exceeded"}
    except OSError as error:
        return {"eof": False, "received_hex": data.hex(),
                "error": repr(error), "errno": error.errno}


def inherited_fd_closed(outer_verified, inner_absent, payload, peer_result):
    return (outer_verified is True and inner_absent is True and payload is not None
            and payload.get("matching_fds") == [] and payload.get("send_attempts") == []
            and peer_result.get("eof") is True and peer_result.get("received_hex") == ""
            and peer_result.get("error") is None)


def abstract_reachable_same_uid(listener, name):
    """Positive control on this exact listener, before the confined attempt."""
    label = Path("/proc/self/attr/current").read_text().strip()
    if label != "unconfined":
        raise RuntimeError("abstract positive control must be unconfined")
    greeting = b"DYNAMIC_HOST_ABSTRACT_CONTROL\n"
    listener.settimeout(3)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(3)
        client.connect("\0" + name)
        client.sendall(greeting)
        client.shutdown(socket.SHUT_WR)
        connection, _ = listener.accept()
        with connection:
            credentials = struct.unpack("3i", connection.getsockopt(
                socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
            received = peer_eof(connection)
    evidence = {"peer": credentials, "label": label, **received}
    passed = (credentials == (os.getpid(), os.getuid(), os.getgid())
              and received["eof"] is True and received["error"] is None
              and received["received_hex"] == greeting.hex())
    listener.setblocking(False)
    if not passed:
        raise RuntimeError("same-UID abstract listener positive control failed: "
                           + json.dumps(evidence))
    return evidence


def privileged(*argv, input_data=None):
    return command(["/usr/bin/sudo", "-n", *map(str, argv)], input_data=input_data)


def scoped_kernel_ring(run_id):
    """Read, never clear, the kernel ring; retain only this synthetic family."""
    if (len(run_id) != 32 or
            any(character not in "0123456789abcdef" for character in run_id)):
        raise ValueError("exact synthetic run identifier required")
    result = privileged("/usr/bin/dmesg", "--color=never")
    prefix = "morphz_dynamic_" + run_id + "_"
    result["stdout"] = "\n".join(line for line in result["stdout"].splitlines()
                                if prefix in line)
    return result


def proc_identity(pid):
    raw = Path(f"/proc/{pid}/stat").read_text()
    tail = raw.rsplit(")", 1)[1].split()
    return {"pid": pid, "ppid": int(tail[1]), "starttime": int(tail[19])}


@contextmanager
def stable_sender(pid):
    """Host-only Linux pidfd pin; disappearing or changing peers fail closed."""
    if type(pid) is not int or pid <= 1:
        raise RuntimeError("invalid kernel sender PID")
    handle = os.pidfd_open(pid, 0)
    try:
        poller = select.poll()
        poller.register(handle, select.POLLIN)
        events = poller.poll(0)
        if events:
            failure = RuntimeError("sender already exited")
            failure.add_note("DYNAMIC_PIDFD_POLL " + json.dumps({"pid": pid, "events": events}))
            raise failure
        identity = proc_identity(pid)

        def verify_current():
            if poller.poll(0) or proc_identity(pid) != identity:
                raise RuntimeError("sender identity changed during admission")

        # Revalidate immediately before the reply, keeping pidfd open through
        # send. Do not demand survival after a deliberate NO/EOF response.
        yield identity, verify_current
    finally:
        os.close(handle)


def receive_startup(connection):
    """One bounded stream frame, authenticated by every received byte's sender.

    The connection was made by outer. Its SO_PEERCRED is not evidence of inner:
    SO_PASSCRED supplies kernel SCM_CREDENTIALS on the later inner sendmsg.
    """
    raw, sender = bytearray(), None
    credentials_size = struct.calcsize("3i")
    while not raw.endswith(b"\n"):
        block, ancillary, flags, _ = connection.recvmsg(
            4097 - len(raw), socket.CMSG_SPACE(credentials_size), socket.MSG_CMSG_CLOEXEC,
        )
        credentials, unexpected = [], False
        for level, kind, data in ancillary:
            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                # Reject rights, but close kernel-delivered FDs even on a
                # truncated/invalid frame. No FD round-trip protocol is used.
                width = struct.calcsize("i")
                for offset in range(0, len(data) - width + 1, width):
                    os.close(struct.unpack_from("i", data, offset)[0])
                unexpected = True
            elif (level == socket.SOL_SOCKET and kind == socket.SCM_CREDENTIALS
                  and len(data) == credentials_size):
                credentials.append(struct.unpack("3i", data))
            else:
                unexpected = True
        if (flags & (socket.MSG_CTRUNC | socket.MSG_TRUNC) or unexpected
                or len(credentials) != 1 or not block):
            raise RuntimeError("startup bytes lack one intact kernel credential")
        if sender is None:
            sender = credentials[0]
        if sender != credentials[0]:
            raise RuntimeError("startup frame mixed different senders")
        raw.extend(block)
        if len(raw) > 4096 or (b"\n" in raw and not raw.endswith(b"\n")):
            raise RuntimeError("startup frame bound or trailing data")
    if raw.count(b"\n") != 1:
        raise RuntimeError("multiple startup frames before acknowledgement")
    return decode(bytes(raw[:-1])), sender


def manifest_fd_identity(fd):
    info = os.fstat(fd)
    access = fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022
            or not 0 < info.st_size <= 65536 or access != os.O_RDONLY):
        raise RuntimeError("host manifest is not immutable root-owned read-only file")
    return {"dev": info.st_dev, "ino": info.st_ino, "size": info.st_size,
            "mode": info.st_mode, "access": access}


def expected_startup(manifest, phase, identity):
    return {
        **{key: manifest[key] for key in ("run_id", "launch_id", "policy_hash", "profile", "uid")},
        "phase": phase, "manifest_fd": identity,
    }


def verify_outer(peer, expected_process, record, manifest, manifest_identity, identity):
    pid, uid, gid = peer
    if (pid != expected_process["pid"] or uid != manifest["uid"] or gid != os.getgid()
            or record != expected_startup(manifest, "outer", manifest_identity)):
        raise RuntimeError("outer identity or manifest FD mismatch")
    if identity != expected_process or identity["ppid"] != os.getpid():
        raise RuntimeError("outer is not the original direct child")
    if os.readlink(f"/proc/{pid}/exe") != manifest["entry"]:
        raise RuntimeError("outer executable mismatch")
    label = Path(f"/proc/{pid}/attr/current").read_text().strip()
    if label != manifest["bootstrap"] + " (enforce)":
        raise RuntimeError("outer is not exact bootstrap-only")
    for kind in ("mnt", "pid", "user", "net"):
        if os.readlink(f"/proc/{pid}/ns/{kind}") != os.readlink(f"/proc/self/ns/{kind}"):
            raise RuntimeError("outer already left the host namespace")
    return {"peer": identity, "label": label, "manifest_fd": manifest_identity}


def descendant(pid, parent):
    seen = set()
    while pid > 1 and pid not in seen:
        if pid == parent:
            return True
        seen.add(pid)
        pid = proc_identity(pid)["ppid"]
    return False


def mount_table(pid):
    result = {}
    for line in Path(f"/proc/{pid}/mountinfo").read_text().splitlines():
        left, right = line.split(" - ", 1)
        fields, extra = left.split(), right.split()
        result[fields[4]] = {"options": fields[5].split(","), "fs": extra[0], "raw": line}
    return result


def verify_admission(peer_pid, peer_uid, child_pid, record, manifest):
    expected = {key: manifest[key] for key in ("run_id", "launch_id", "policy_hash", "profile", "uid")}
    if record != expected or peer_uid != manifest["uid"]:
        raise RuntimeError("admission identity/UID mismatch")
    if not descendant(peer_pid, child_pid):
        raise RuntimeError("admission did not originate in this launch")
    if os.readlink(f"/proc/{peer_pid}/exe") != manifest["entry"]:
        raise RuntimeError("admission executable mismatch")
    label = Path(f"/proc/{peer_pid}/attr/current").read_text().strip()
    if label not in stack_labels(manifest):
        raise RuntimeError("admission was not exact two-component enforced stack")
    namespaces = {}
    for kind in ("mnt", "pid", "user", "net"):
        current = os.readlink(f"/proc/{peer_pid}/ns/{kind}")
        host = os.readlink(f"/proc/self/ns/{kind}")
        namespaces[kind] = {"payload": current, "host": host}
        should_differ = kind != "net" or manifest["network"] == "deny"
        if (current != host) != should_differ:
            raise RuntimeError(f"unexpected {kind} namespace")
    mounts = mount_table(peer_pid)
    if "ro" not in mounts["/"]["options"] or mounts["/tmp"]["fs"] != "tmpfs":
        raise RuntimeError("root view is not read-only plus private tmpfs")
    for root in manifest["roots"]:
        options = mounts[root["path"]]["options"]
        if ("rw" in options) != (root["access"] == "write"):
            raise RuntimeError("root mount access mismatch")
    return {"peer": proc_identity(peer_pid), "label": label,
            "namespaces": namespaces, "mounts": mounts}


class Lane:
    def __init__(self, campaign, manifest, admission="allow", *, extra_fd_probe=False):
        if admission not in ("allow", "reject", "disconnect"):
            raise ValueError("only fixed synthetic admission lanes")
        self.campaign, self.manifest = campaign, manifest
        self.admission = admission
        self.rejection_verified = False
        self.process = None
        self.master = None
        self.transcript = []
        self.pending = bytearray()
        self.err = None
        self.ready = False
        self.closed = False
        self.expected_sequence = 0
        self.listener = None
        self.manifest_file = None
        self.extra_fd_probe = extra_fd_probe
        self.extra_child_fd = None
        self.extra_peer = None
        self.extra_target = None
        self.extra_outer_verified = False
        self.extra_inner_absent = False
        self.extra_payload = None
        self.socket_path = Path(manifest["control"]) / "admit.sock"
        self.campaign.lanes.append(self)

    @property
    def sentinel(self):
        return Path(self.manifest["cwd"]) / (".dynamic-worker-started-" + self.manifest["profile"])

    def start(self):
        self.campaign.phase = "lane_before_host"
        if self.sentinel.exists():
            raise RuntimeError("fresh per-launch sentinel already exists")
        control = Path(self.manifest["control"])
        control.mkdir(mode=0o700)
        self.manifest_file = os.open(self.manifest["manifest"], os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        expected_manifest = manifest_fd_identity(self.manifest_file)
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        # Before connect/data, so queued outer bytes also carry real credentials.
        self.listener.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
        self.listener.bind(str(self.socket_path))
        self.listener.listen(1)
        self.listener.settimeout(15)
        argv = ["/usr/bin/aa-exec", "-p", self.manifest["bootstrap"], "--",
                self.manifest["entry"], "--outer", self.manifest["manifest"]]
        pass_fds = ()
        if self.extra_fd_probe:
            # Synthetic endpoint only. Not part of entry's fixed FD3/FD4 ABI.
            self.extra_peer, child_end = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                self.extra_child_fd = fcntl.fcntl(child_end.fileno(), fcntl.F_DUPFD_CLOEXEC, 64)
                info = os.fstat(self.extra_child_fd)
                if not stat.S_ISSOCK(info.st_mode):
                    raise RuntimeError("injection target is not a socket")
                self.extra_target = {"dev": info.st_dev, "ino": info.st_ino}
                self.extra_injected_fd = self.extra_child_fd
                self.extra_nonce = "DYNAMIC_FD_" + uuid.uuid4().hex + "\n"
                pass_fds = (self.extra_child_fd,)
            finally:
                child_end.close()
        self.err = open(self.campaign.output / (self.manifest["launch_id"] + ".stderr"), "wb")
        if self.manifest["mode"] == "pty":
            self.master, slave = pty.openpty()
            settings = termios.tcgetattr(slave)
            settings[3] &= ~termios.ECHO
            termios.tcsetattr(slave, termios.TCSANOW, settings)
            def terminal_setup():
                os.setsid()
                fcntl.ioctl(0, termios.TIOCSCTTY, 0)
            self.process = subprocess.Popen(
                argv, stdin=slave, stdout=slave, stderr=self.err, env=CLEAN_ENV,
                close_fds=True, pass_fds=pass_fds, preexec_fn=terminal_setup,
            )
            os.close(slave)
        else:
            self.process = subprocess.Popen(
                argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.err,
                env=CLEAN_ENV, close_fds=True, pass_fds=pass_fds, start_new_session=True,
            )
        if self.extra_child_fd is not None:
            os.close(self.extra_child_fd)
            self.extra_child_fd = None  # All host copies of the injected end are closed.
        self.process_identity = proc_identity(self.process.pid)
        connection, _ = self.listener.accept()
        with connection:
            connection.settimeout(10)
            connected_peer = struct.unpack("3i", connection.getsockopt(
                socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
            outer_record, outer_peer = receive_startup(connection)
            if outer_peer != connected_peer:
                raise RuntimeError("outer sender differs from connection peer")
            with stable_sender(outer_peer[0]) as (outer_identity, verify_outer_sender):
                outer_evidence = verify_outer(
                    outer_peer, self.process_identity, outer_record, self.manifest,
                    expected_manifest, outer_identity,
                )
                self.campaign.record("outer_authenticated", True, launch=self.manifest["launch_id"],
                                     evidence=outer_evidence)
                if self.extra_fd_probe:
                    rows = fd_table(outer_peer[0])
                    matching = require_outer_injection(rows, self.extra_target, self.extra_injected_fd)
                    host_rows = fd_table(os.getpid())
                    if matching_socket_fds(host_rows, self.extra_target):
                        raise RuntimeError("host still retains an injected socket endpoint")
                    verify_outer_sender()
                    self.extra_outer_verified = True
                    self.campaign.record(
                        "synthetic_fd_outer_injection_proved", True,
                        launch=self.manifest["launch_id"], barrier="blocked-before-HOST",
                        peer=outer_identity, target=self.extra_target, fds=rows,
                        matching_fds=matching, pidfd_held=True,
                        host_injection_end_closed=self.extra_child_fd is None,
                        host_fds=host_rows,
                    )
                # Keep only this connected channel; inner must inherit, never reconnect.
                self.listener.close()
                self.listener = None
                self.socket_path.unlink()
                verify_outer_sender()
                connection.sendall(b"HOST\n")
            self.campaign.phase = "inner_receive_startup"
            inner_record, (peer_pid, peer_uid, peer_gid) = receive_startup(connection)
            if (peer_pid == connected_peer[0] or peer_gid != self.campaign.gid
                    or inner_record != expected_startup(self.manifest, "inner", expected_manifest)):
                raise RuntimeError("inner sender or inherited manifest FD mismatch")
            core_record = {key: inner_record[key] for key in
                           ("run_id", "launch_id", "policy_hash", "profile", "uid")}
            self.campaign.phase = "inner_pin_sender"
            with stable_sender(peer_pid) as (inner_identity, verify_inner_sender):
                self.campaign.phase = "inner_verify_admission"
                evidence = verify_admission(
                    peer_pid, peer_uid, self.process.pid, core_record, self.manifest,
                )
                if evidence["peer"] != inner_identity:
                    raise RuntimeError("inner identity changed while inspecting namespace")
                # Original FD and sender pidfd remain held through the reply.
                # Namespace owner numbers are never accepted as overflow root.
                self.campaign.phase = "inner_verify_host_manifest"
                if manifest_fd_identity(self.manifest_file) != expected_manifest:
                    raise RuntimeError("host manifest changed during startup")
                evidence["manifest_fd"] = inner_record["manifest_fd"]
                evidence["outer"] = outer_evidence["peer"]
                if self.extra_fd_probe:
                    self.campaign.phase = "inner_full_fd_table"
                    rows = fd_table(peer_pid)
                    matching = matching_socket_fds(rows, self.extra_target)
                    self.extra_inner_absent = not matching and not self.sentinel.exists()
                    verify_inner_sender()
                    self.campaign.record(
                        "synthetic_fd_absent_before_payload", self.extra_inner_absent,
                        launch=self.manifest["launch_id"], barrier="blocked-before-GO",
                        peer=inner_identity, target=self.extra_target, fds=rows,
                        matching_fds=matching, pidfd_held=True,
                        sentinel_absent=not self.sentinel.exists(),
                    )
                self.campaign.phase = "inner_revalidate_and_reply"
                verify_inner_sender()
                if self.admission == "allow":
                    connection.sendall(b"GO\n")
                elif self.admission == "reject":
                    connection.sendall(b"NO\n")
            # disconnect deliberately sends no acknowledgement; context closes.
        self.campaign.phase = "after_inner_reply"
        self.campaign.record("admission", True, launch=self.manifest["launch_id"], evidence=evidence)
        if self.admission != "allow":
            code = self.process.wait(timeout=5)
            stdout = self.drain()
            self.err.flush()
            stderr = Path(self.err.name).read_text()
            reason = ("admission refused" if self.admission == "reject"
                      else "admission acknowledgement")
            valid = (code == 78 and reason in stderr and not self.sentinel.exists()
                     and not any(line.startswith(PREFIX) for line in stdout.splitlines()))
            self.campaign.record("admission_negative_no_payload", valid,
                                 lane=self.admission, code=code, stdout=stdout, stderr=stderr,
                                 sentinel_absent=not self.sentinel.exists())
            if not valid:
                raise RuntimeError("negative admission lane did not prove expected refusal")
            self.rejection_verified = True
            return self
        ready = self.wait("ready")
        self.ready = True
        expected_label = ready["identity"]["label"]
        sentinel_valid = (self.sentinel.is_file()
                          and self.sentinel.read_text() + " (enforce)" == expected_label)
        self.campaign.record("ready_after_admission", sentinel_valid, evidence=ready,
                             sentinel=str(self.sentinel))
        if not sentinel_valid:
            raise RuntimeError("positive payload sentinel not verified")
        if self.extra_fd_probe:
            self.extra_payload = self.ask("inherited_fd", target=self.extra_target,
                                          nonce=self.extra_nonce)["value"]
            self.campaign.record(
                "synthetic_fd_payload_absent", self.extra_payload["matching_fds"] == []
                and self.extra_payload["send_attempts"] == [],
                launch=self.manifest["launch_id"], evidence=self.extra_payload,
            )
        return self

    def send(self, value):
        raw = (json.dumps(value) + "\n").encode()
        if self.master is not None:
            os.write(self.master, raw)
        else:
            self.process.stdin.write(raw)
            self.process.stdin.flush()

    def wait(self, event, request_id=None, timeout=12):
        deadline = time.monotonic() + timeout
        fd = self.master if self.master is not None else self.process.stdout.fileno()
        while time.monotonic() < deadline:
            while b"\n" in self.pending:
                raw, _, rest = self.pending.partition(b"\n")
                self.pending = bytearray(rest)
                line = raw.decode(errors="replace").rstrip("\r")
                self.transcript.append(line)
                if line.startswith(PREFIX):
                    item = json.loads(line[len(PREFIX):])
                    if item.get("event") == "operation_error":
                        raise RuntimeError(json.dumps(item))
                    if item.get("event") == event and (request_id is None or item.get("id") == request_id):
                        return item
            readable, _, _ = select.select([fd], [], [], max(0, deadline - time.monotonic()))
            if readable:
                try:
                    chunk = os.read(fd, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    chunk = b""
                if not chunk:
                    raise RuntimeError(f"worker EOF before {event}; exit={self.process.poll()}")
                self.pending.extend(chunk)
        raise TimeoutError(f"worker did not emit {event}")

    def ask(self, operation, **fields):
        self.expected_sequence += 1
        request_id = self.expected_sequence
        self.send({"id": request_id, "op": operation, **fields})
        if operation == "interrupt":
            ready = self.wait("interrupt_ready", request_id)
            if self.master is None:
                raise RuntimeError("interrupt is PTY-only")
            os.write(self.master, b"\x03")
            result = self.wait("result", request_id)
            result["interrupt_ready"] = ready
            return result
        return self.wait("bye" if operation == "exit" else "result", request_id)

    def drain(self):
        fd = self.master if self.master is not None else self.process.stdout.fileno()
        try:
            while select.select([fd], [], [], 0)[0]:
                block = os.read(fd, 65536)
                if not block:
                    break
                self.pending.extend(block)
        except OSError as error:
            if error.errno != errno.EIO or self.master is None:
                raise
        tail = self.pending.decode(errors="replace")
        self.pending.clear()
        self.transcript.append(tail)
        return tail

    def close(self):
        if self.closed:
            return
        cleanup_errors = []
        normal_exit = False
        extra_cleanup = None
        if self.process is not None:
            try:
                if self.rejection_verified:
                    if self.process.returncode != 78 or self.sentinel.exists():
                        raise RuntimeError("verified refusal no longer holds")
                elif not self.ready:
                    raise RuntimeError("startup did not reach verified worker readiness")
                else:
                    self.ask("exit")
                    code = self.process.wait(timeout=5)
                    if code != 0:
                        raise RuntimeError(f"normal worker exit was {code}")
                    tail = self.drain()
                    if self.master is not None and "DYNAMIC_SHELL_CONTINUED" not in tail:
                        raise RuntimeError("interactive Bash continuation receipt absent")
                    normal_exit = True
            except Exception as error:
                cleanup_errors.append(repr(error))
            if self.process.poll() is None:
                # Recovery is not a passing normal cleanup. Signal only our exact live child.
                try:
                    if proc_identity(self.process.pid) != self.process_identity:
                        raise RuntimeError("owned process identity changed; refuse signal")
                    os.killpg(self.process.pid, signal.SIGKILL)
                    self.process.wait(timeout=5)
                except Exception as error:
                    cleanup_errors.append(repr(error))
        if self.extra_child_fd is not None:
            os.close(self.extra_child_fd)
            self.extra_child_fd = None
        if self.extra_peer is not None:
            try:
                # EOF after normal bye + wrapper wait. Timeout or forced kill
                # can never establish the boundary; A/B remain incomplete.
                result = peer_eof(self.extra_peer)
                extra_cleanup = {"normal_exit": normal_exit,
                                 "host_injection_end_closed": self.extra_child_fd is None,
                                 **result}
                if normal_exit:
                    passed = inherited_fd_closed(
                        self.extra_outer_verified, self.extra_inner_absent,
                        self.extra_payload, result,
                    )
                    self.campaign.record(
                        "synthetic_fd_peer_eof_without_nonce", passed,
                        launch=self.manifest["launch_id"], evidence=result,
                        normal_exit=True, host_injection_end_closed=True,
                        target=self.extra_target,
                    )
                elif result["error"] is not None or not result["eof"]:
                    cleanup_errors.append("synthetic peer did not reach EOF during cleanup: "
                                          + json.dumps(result))
            finally:
                self.extra_peer.close()
                self.extra_peer = None
        if self.listener is not None:
            self.listener.close()
        if self.manifest_file is not None:
            os.close(self.manifest_file)
            self.manifest_file = None
        if self.socket_path.exists():
            self.socket_path.unlink()
        if self.err is not None:
            self.err.close()
        if self.master is not None:
            os.close(self.master)
        (self.campaign.output / (self.manifest["launch_id"] + ".transcript.json")).write_text(
            json.dumps(self.transcript, indent=2))
        self.closed = True
        self.campaign.record("lane_cleanup", not cleanup_errors,
                             launch=self.manifest["launch_id"], errors=cleanup_errors,
                             extra_fd_cleanup=extra_cleanup)


class Campaign:
    def __init__(self, output):
        self.run_id = uuid.uuid4().hex
        self.stage = Path("/tmp") / ("morphz-dynamic-" + self.run_id)
        self.output = Path(output).resolve()
        self.output.mkdir(parents=True, exist_ok=False)
        self.records, self.lanes, self.manifests = [], [], []
        self.uid, self.gid = os.getuid(), os.getgid()
        self.phase = "campaign_start"
        self.kernel_before = kernel_settings()
        self.started_at = int(time.time())

    def record(self, name, passed, **data):
        item = {"name": name, "passed": passed, **data}
        self.records.append(item)
        with open(self.output / "receipts.jsonl", "a") as stream:
            stream.write(json.dumps(item, sort_keys=True) + "\n")
        if not passed:
            print(json.dumps(item), file=sys.stderr, flush=True)

    def setup(self):
        source = Path(__file__).resolve().parent
        if Path("/proc/self/attr/current").read_text().strip() != "unconfined":
            raise RuntimeError("this probe only authorizes its explicit unconfined host controller")
        if self.kernel_before["/sys/module/apparmor/parameters/enabled"] != "Y":
            raise RuntimeError("AppArmor is not enabled; no fallback")
        versions = {
            "kernel": command(["/usr/bin/uname", "-a"]),
            "dependencies": command(["/usr/bin/dpkg-query", "-W", "-f=${Package} ${Version}\\n",
                                     "bubblewrap", "apparmor", "apparmor-utils",
                                     "libapparmor-dev", "libjson-c-dev", "gcc"]),
            "json_c": command(["/usr/bin/pkg-config", "--modversion", "json-c"]),
        }
        for record in versions.values():
            must(record)
        self.record("runner_environment", True, versions=versions, kernel_before=self.kernel_before)
        resolved = {}
        for executable in ("/usr/bin/bwrap", "/usr/bin/python3", "/bin/bash", "/bin/cat", "/bin/sleep"):
            target = Path(executable).resolve(strict=True)
            if str(target) not in PROBE_EXECUTABLES:
                raise RuntimeError("system executable outside reviewed fixed probe list: " + str(target))
            info = target.stat()
            if info.st_uid != 0 or info.st_mode & 0o022:
                raise RuntimeError("untrusted system executable: " + str(target))
            resolved[executable] = {"path": str(target), "sha256": sha(target)}
        self.record("system_executable_identities", True, evidence=resolved)
        for name in TRUSTED:
            if not (source / name).is_file():
                raise RuntimeError(f"build prerequisite missing: {name}")
        # mkdir is deliberately exclusive: never adopt or overwrite a previous stage.
        must(privileged("/usr/bin/mkdir", "-m", "0755", self.stage))
        for name in ("trusted", "launches"):
            must(privileged("/usr/bin/install", "-d", "-m", "0755", self.stage / name))
        for name in ("control", "workspaces"):
            must(privileged("/usr/bin/install", "-d", "-m", "0700", "-o", self.uid,
                            "-g", self.gid, self.stage / name))
        for name in TRUSTED:
            destination = self.stage / "trusted" / name
            must(privileged("/usr/bin/install", "-m", "0555", source / name, destination))
            if sha(source / name) != sha(destination):
                raise RuntimeError("installed trusted source hash changed")
        self.record("trusted_install", True, stage=str(self.stage),
                    hashes={name: sha(source / name) for name in TRUSTED})

    def loader(self, action, *, request=None, launch_id=None):
        argv = ["/usr/bin/env", "-i", "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
                "LANG=C.UTF-8", f"{MARKER}=1", "/usr/bin/python3", "-I", "-B",
                str(self.stage / "trusted/loader.py"), action, "--stage", str(self.stage),
                "--uid", str(self.uid)]
        if launch_id is not None:
            argv.extend(["--launch-id", launch_id])
        return privileged(*argv, input_data=json.dumps(request) if request is not None else None)

    def acquire(self, root, *, mode="exec", extra=None, cwd=None, network="deny"):
        roots = [{"path": str(root), "access": "write"}]
        if extra is not None:
            roots.append({"path": str(extra), "access": "read"})
        request = {"abi": ABI, "run_id": self.run_id, "launch_id": uuid.uuid4().hex,
                   "mode": mode, "cwd": str(cwd or root), "roots": roots, "network": network}
        manifest = validate_request(request, self.stage, self.uid)
        # Include failed/partial installations in exact-scope cleanup and evidence.
        self.manifests.append(manifest)
        result = self.loader("acquire", request=request)
        self.record("loader_acquire_result", result["code"] == 0, request=request, evidence=result)
        # Preserve generated sources even when the parser refuses the profile.
        for suffix in (".json", ".apparmor"):
            source = Path(manifest["manifest"]).with_suffix(suffix)
            if source.is_file():
                shutil.copyfile(source, self.output / source.name)
        must(result)
        actual = decode(Path(manifest["manifest"]).read_bytes())
        if actual != manifest:
            raise RuntimeError("loader did not freeze the exact approved request")
        self.record("acquired", True, request=request, manifest=manifest, loader=result)
        return manifest

    def deny_read(self, lane, path, name):
        result = lane.ask("read", path=str(path))["value"]
        passed = (result["open"].get("errno") in (errno.EACCES, errno.EPERM)
                  and result["cat_code"] != 0 and result["cat_stdout"] == "")
        self.record(name, passed, evidence=result)

    def ordinary(self, lane, directory):
        result = lane.ask("ordinary", path=str(directory))["value"]
        self.record("ordinary_create_edit_rename", result["value"] == "ordinary-v2", evidence=result)

    def run(self):
        root_a = self.stage / "workspaces/a"
        root_a.mkdir()
        sub = root_a / "sub"
        sub.mkdir()
        (root_a / "live.txt").write_text("A-before")
        first = self.acquire(root_a, cwd=sub)
        with_lane = Lane(self, first, extra_fd_probe=True).start()
        # The readiness receipt is the host-write barrier; no sleeps/racy timing fixture.
        (root_a / ".env").write_text("SYNTHETIC-A-SECRET")
        (root_a / ".ssh").mkdir()
        (root_a / ".ssh/key").write_text("SYNTHETIC-A-SSH")
        (root_a / ".morphz").mkdir()
        (root_a / ".morphz/config.toml").write_text("SYNTHETIC-A-CONFIG")
        (root_a / "live.txt").write_text("A-after")
        for relative in (".env", ".ssh/key", ".morphz/config.toml"):
            self.deny_read(with_lane, root_a / relative, "late_protected_path")
        live = with_lane.ask("read", path=str(root_a / "live.txt"))["value"]
        self.record("live_host_edit", live["open"].get("value") == "A-after", evidence=live)
        self.ordinary(with_lane, root_a / "ordinary")
        self.ordinary(with_lane, root_a / ".morphz")
        rename = with_lane.ask("rename", source=str(root_a / ".morphz"),
                               destination=str(root_a / "moved-config"))["value"]
        self.record("protected_ancestor_rename_denied",
                    rename.get("errno") in (errno.EACCES, errno.EPERM), evidence=rename)
        active = self.loader("collect", launch_id=first["launch_id"])
        self.record("collect_refuses_live_profile", active["code"] == 75, evidence=active)
        escape = with_lane.ask("escape")["value"]
        self.record("payload_cannot_change_profile_or_userns",
                    all(item["code"] == -1 and item["errno"] in (errno.EACCES, errno.EPERM)
                        for item in escape["change_profile"].values())
                    and escape["new_user_namespace"]["code"] == -1
                    and escape["identity"]["label"] in stack_labels(first),
                    evidence=escape)
        with_lane.close()

        for decision in ("reject", "disconnect"):
            refused = Lane(self, self.acquire(root_a, cwd=sub), admission=decision).start()
            refused.close()

        # A new root and additional authorized root are created after the first launch.
        root_b, extra = self.stage / "workspaces/b", self.stage / "workspaces/extra"
        root_b.mkdir()
        extra.mkdir()
        (extra / "approved.txt").write_text("SINGLE-LAUNCH-GRANT")
        second = self.acquire(root_b, mode="pty", extra=extra)
        terminal = Lane(self, second).start()
        granted = terminal.ask("read", path=str(extra / "approved.txt"))["value"]
        self.record("dynamic_extra_root_granted", granted["open"].get("value") == "SINGLE-LAUNCH-GRANT",
                    evidence=granted)
        (root_b / ".env").write_text("SYNTHETIC-B-SECRET")
        self.deny_read(terminal, root_b / ".env", "pty_late_secret_denied")
        interrupt = terminal.ask("interrupt")
        self.record("pty_foreground_ctrl_c", interrupt["value"]["returncode"] == -signal.SIGINT,
                    evidence=interrupt)
        self.deny_read(terminal, root_b / ".env", "pty_still_confined_after_ctrl_c")
        terminal.close()

        third = self.acquire(root_b)
        next_lane = Lane(self, third).start()
        not_granted = next_lane.ask("read", path=str(extra / "approved.txt"))["value"]
        self.record("extra_root_does_not_leak_to_next_request",
                    ungranted_root_unreadable(not_granted), evidence=not_granted)
        self.deny_read(next_lane, root_b / ".env", "fresh_exec_existing_secret_denied")
        next_lane.close()
        # A real host loopback listener is the allow control for the denied lane.
        # Accept is performed after the worker returns: both use a fixed greeting,
        # avoiding a helper thread before the PTY preexec boundary.
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen(2)
            listener.settimeout(3)
            port = listener.getsockname()[1]
            denied = Lane(self, self.acquire(root_b, network="deny")).start()
            negative = denied.ask("network", port=port)["value"]
            self.record("network_denied", negative.get("ok") is False, evidence=negative)
            denied.close()
            allowed = Lane(self, self.acquire(root_b, network="allow")).start()
            positive = allowed.ask("network", port=port)["value"]
            connection, _ = listener.accept()
            with connection:
                connection.settimeout(3)
                greeting = connection.recv(64)
            self.record("network_explicit_allow_control",
                        positive.get("ok") is True and greeting == b"DYNAMIC_SYNTHETIC\n",
                        evidence=positive, greeting=greeting.decode(errors="replace"))
            # Same network namespace as the real abstract listener: ENOENT or
            # ECONNREFUSED cannot masquerade as an AppArmor denial.
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as abstract_listener:
                abstract_name = "morphz-dynamic-" + uuid.uuid4().hex
                abstract_listener.bind("\0" + abstract_name)
                abstract_listener.listen(1)
                reachable = abstract_reachable_same_uid(abstract_listener, abstract_name)
                self.record("host_abstract_listener_same_uid_positive", True, evidence=reachable)
                unix_result = allowed.ask("unix_boundary", name=abstract_name)["value"]
                unexpected_connection = False
                try:
                    connection, _ = abstract_listener.accept()
                except BlockingIOError:
                    pass
                else:
                    unexpected_connection = True
                    connection.close()
                self.record("host_abstract_connection_denied",
                            abstract_connection_denied(unix_result["abstract"])
                            and not unexpected_connection,
                            evidence=unix_result["abstract"], listener_accepted=unexpected_connection)
                self.record("same_process_socketpair_functional_positive",
                            self_ipc_works(unix_result["anonymous"]),
                            evidence=unix_result["anonymous"])
            allowed.close()
        self.record("unique_immutable_profiles",
                    len({item["profile"] for item in self.manifests}) == len(self.manifests)
                    and all(decode(Path(item["manifest"]).read_bytes()) == item for item in self.manifests))

    def finish(self, error):
        if error is not None:
            self.record("campaign_error", False, error=repr(error),
                        diagnostic=exception_diagnostic(error, self.phase))
        # Only read audit lines for this synthetic profile family. This does not
        # alter audit/sysctl settings, capabilities, policy or launch behavior.
        try:
            audit = privileged("/usr/bin/journalctl", "-k", "--since", f"@{self.started_at}",
                               "--no-pager", "--output=short-unix", "--lines=2000")
            audit["stdout"] = "\n".join(line for line in audit["stdout"].splitlines()
                                       if "morphz_dynamic_" + self.run_id + "_" in line)
            self.record("kernel_audit_diagnostic", audit["code"] == 0, evidence=audit)
        except Exception as audit_error:
            self.record("kernel_audit_diagnostic", False, error=repr(audit_error))
        # The ring read is independent of journald delivery. Preserve the same
        # launch failure even if both sources contain no denial record.
        try:
            ring = scoped_kernel_ring(self.run_id)
            self.record("kernel_ring_diagnostic", ring["code"] == 0, evidence=ring)
        except Exception as ring_error:
            self.record("kernel_ring_diagnostic", False, error=repr(ring_error))
        for lane in self.lanes:
            if not lane.closed:
                try:
                    lane.close()
                except Exception as cleanup_error:
                    self.record("lane_cleanup_exception", False, error=repr(cleanup_error))
        for manifest in self.manifests:
            try:
                result = self.loader("collect", launch_id=manifest["launch_id"])
                self.record("profile_collection", result["code"] == 0, evidence=result)
            except Exception as cleanup_error:
                self.record("profile_collection_exception", False, error=repr(cleanup_error))
        after = kernel_settings()
        self.record("kernel_settings_unchanged", after == self.kernel_before,
                    before=self.kernel_before, after=after)
        passed = bool(self.manifests) and all(item["passed"] for item in self.records)
        summary = {"passed": passed, "run_id": self.run_id, "stage": str(self.stage),
                   "receipts": len(self.records),
                   "failures": [item for item in self.records if not item["passed"]],
                   "scope": "isolated prototype only; no production adoption"}
        (self.output / "summary.json").write_text(json.dumps(summary, indent=2))
        print(json.dumps(summary), flush=True)
        return 0 if passed else 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--output")
    args = parser.parse_args()
    if not args.execute:
        print(json.dumps({"mode": "prepare_only", "executed": False,
                          "next": "root review, then isolated Ubuntu workflow only"}))
        return 0
    if sys.platform != "linux" or os.geteuid() == 0 or os.environ.get(MARKER) != "1":
        raise RuntimeError("execution requires marked non-root isolated Linux runner")
    if not args.output:
        raise RuntimeError("explicit fresh evidence output directory required")
    campaign = Campaign(args.output)
    error = None
    def interrupted(number, frame):
        raise KeyboardInterrupt(f"isolated campaign received signal {number}")
    previous = {number: signal.signal(number, interrupted) for number in (signal.SIGINT, signal.SIGTERM)}
    try:
        campaign.setup()
        campaign.run()
    except BaseException as failure:
        error = failure
    finally:
        # One interruption triggers bounded cleanup; another cannot silently
        # turn a partial cleanup into successful completion.
        for number in previous:
            signal.signal(number, signal.SIG_IGN)
    try:
        return campaign.finish(error)
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)


if __name__ == "__main__":
    sys.exit(main())
