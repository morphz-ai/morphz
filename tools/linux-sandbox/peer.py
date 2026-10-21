"""Kernel-bound caller identity for the isolated Linux policy service.

No identity, role, profile or authentication token is taken from request JSON.
The service must retain the received pidfd and revalidate immediately before
using a registration. A valid UID alone never authorizes a request.
"""

from dataclasses import dataclass
import errno
import fcntl
import os
from pathlib import PurePosixPath
import select
import socket
import stat
import struct
import sys

from policy import MAX_REQUEST_BYTES


# Linux UAPI asm-generic/socket.h and linux/socket.h. Initial supported target:
# Ubuntu 24.04 amd64 with a kernel supporting per-message pidfds (Linux >= 6.5).
SO_PASSPIDFD = 76
SCM_PIDFD = 4
INT = struct.Struct("i")
UCRED = struct.Struct("3i")


class PeerError(PermissionError):
    pass


def require_linux():
    if sys.platform != "linux":
        raise PeerError("Linux kernel peer identity is required")


def configure_listener(listener):
    require_linux()
    if listener.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) != socket.SOCK_SEQPACKET:
        raise PeerError("policy control requires bounded Unix seqpacket frames")
    # Set before bind/listen: queued connections/messages must carry real kernel
    # sender credentials and a pidfd, not a PID subsequently looked up by name.
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
    listener.setsockopt(socket.SOL_SOCKET, SO_PASSPIDFD, 1)


@dataclass
class PeerFrame:
    body: bytes
    pid: int
    uid: int
    gid: int
    pidfd: int

    def close(self):
        if self.pidfd >= 0:
            os.close(self.pidfd)
            self.pidfd = -1

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


def receive_frame(connection):
    require_linux()
    if connection.family != socket.AF_UNIX or connection.getsockopt(
            socket.SOL_SOCKET, socket.SO_TYPE) != socket.SOCK_SEQPACKET:
        raise PeerError("unexpected control transport")
    for option in (socket.SO_PASSCRED, SO_PASSPIDFD):
        if connection.getsockopt(socket.SOL_SOCKET, option) != 1:
            raise PeerError("kernel sender identity was not enabled before receipt")
    peer = UCRED.unpack(connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, UCRED.size))
    body, ancillary, flags, _ = connection.recvmsg(
        MAX_REQUEST_BYTES + 1,
        socket.CMSG_SPACE(UCRED.size) + socket.CMSG_SPACE(INT.size) + socket.CMSG_SPACE(16 * INT.size),
        socket.MSG_CMSG_CLOEXEC,
    )
    descriptors = []
    credentials = []
    pidfds = []
    invalid = bool(flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC))
    try:
        for level, kind, data in ancillary:
            if level == socket.SOL_SOCKET and kind in (socket.SCM_RIGHTS, SCM_PIDFD):
                fds = [entry[0] for entry in struct.iter_unpack("i", data[:len(data) // INT.size * INT.size])]
                descriptors.extend(fds)
                if kind == SCM_PIDFD and len(data) == INT.size:
                    pidfds.extend(fds)
                else:
                    invalid = True  # no caller-supplied FD capability in this protocol
            elif level == socket.SOL_SOCKET and kind == socket.SCM_CREDENTIALS and len(data) == UCRED.size:
                credentials.append(UCRED.unpack(data))
            else:
                invalid = True
        if invalid or len(credentials) != 1 or len(pidfds) != 1:
            raise PeerError("expected exactly one kernel credential and pidfd record, no passed rights")
        if not 0 < len(body) <= MAX_REQUEST_BYTES:
            raise PeerError("empty or oversized control frame")
        if credentials[0] != peer:
            raise PeerError("control connection was inherited or passed to another process")
        pid, uid, gid = peer
        if pid <= 1 or uid <= 0 or gid < 0:
            raise PeerError("policy caller must be a real non-root process")
        descriptor = pidfds[0]
        os.set_inheritable(descriptor, False)
        frame = PeerFrame(body, pid, uid, gid, descriptor)
        require_live(frame)
        descriptors.remove(descriptor)  # ownership transfers only on complete success
        return frame
    finally:
        for descriptor in descriptors:
            os.close(descriptor)


def read_bounded_at(directory, name, limit=65536):
    fd = os.open(name, os.O_RDONLY | os.O_CLOEXEC, dir_fd=directory)
    try:
        chunks = bytearray()
        while len(chunks) <= limit:
            part = os.read(fd, min(4096, limit + 1 - len(chunks)))
            if not part:
                return bytes(chunks).decode("utf-8", errors="strict")
            chunks.extend(part)
        raise PeerError("kernel identity record exceeds its bound")
    finally:
        os.close(fd)


def parse_start_identity(raw, expected_pid):
    prefix, separator, fields = raw.rpartition(")")
    values = fields.split()
    if not separator or not prefix.startswith(f"{expected_pid} (") or len(values) < 20:
        raise PeerError("malformed kernel process identity")
    try:
        parent, start = int(values[1]), int(values[19])
    except ValueError as error:
        raise PeerError("malformed parent/start identity") from error
    if parent < 0 or start < 0:
        raise PeerError("invalid parent/start identity")
    return parent, start


def require_live(frame):
    if frame.pidfd < 0:
        raise PeerError("caller lifetime handle is closed")
    poll = select.poll()
    poll.register(frame.pidfd, select.POLLIN | select.POLLHUP | select.POLLERR)
    if poll.poll(0):
        raise PeerError("caller process exited; its PID cannot be reused as authority")
    directory = os.open("/proc/self/fdinfo", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        info = dict(line.split(":", 1) for line in read_bounded_at(directory, str(frame.pidfd)).splitlines()
                    if ":" in line)
        if int(info.get("Pid", "-1").strip()) != frame.pid:
            raise PeerError("received pidfd does not bind this kernel sender")
    finally:
        os.close(directory)


def executable_key(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_mode, info.st_size, info.st_ctime_ns)


def parse_security_state(raw, uid, gid):
    status = dict(line.split(":", 1) for line in raw.splitlines() if ":" in line)
    try:
        for name, expected in (("Uid", uid), ("Gid", gid)):
            actual = tuple(int(value) for value in status.get(name, "").split())
            if actual != (expected,) * 4:
                raise PeerError("caller credentials changed or use a privileged identity")
        if int(status.get("TracerPid", "-1").strip()) != 0 or any(
                int(status.get(field, "-1").strip(), 16) != 0
                for field in ("CapEff", "CapPrm", "CapInh", "CapAmb")):
            raise PeerError("traced or capability-bearing callers are not admitted")
        groups = tuple(int(value) for value in status["Groups"].split())
        nnp = int(status["NoNewPrivs"].strip())
        if len(groups) > 65536 or any(value < 0 for value in groups) or nnp not in (0, 1):
            raise PeerError("invalid kernel groups or NoNewPrivs state")
        return groups, nnp
    except (KeyError, ValueError) as error:
        raise PeerError("incomplete kernel security identity") from error


class TrustedExecutables:
    """Pinned administrator-installed executable objects, not file basenames."""

    def __init__(self, paths):
        require_linux()
        self.descriptors = []
        self.keys = set()
        try:
            if not paths or len(paths) > 16:
                raise PeerError("administrator executable allowlist must be bounded and nonempty")
            for path in paths:
                canonical = PurePosixPath(path)
                if not canonical.is_absolute() or str(canonical) != path or ".." in canonical.parts:
                    raise PeerError("administrator executable path must be canonical and absolute")
                directory = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
                try:
                    for component in canonical.parts[1:-1]:
                        child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                        dir_fd=directory)
                        os.close(directory)
                        directory = child
                        metadata = os.fstat(directory)
                        if metadata.st_uid != 0 or metadata.st_mode & 0o022:
                            raise PeerError("trusted executable ancestor is writable by non-root")
                    descriptor = os.open(canonical.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                         dir_fd=directory)
                    self.descriptors.append(descriptor)
                    metadata = os.fstat(descriptor)
                    if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or
                            metadata.st_mode & 0o6022 or not metadata.st_mode & 0o111):
                        raise PeerError("trusted executable must be regular, root-owned, non-setuid and immutable to users")
                    try:
                        capabilities = os.getxattr(descriptor, "security.capability")
                    except OSError as error:
                        if error.errno != errno.ENODATA:
                            raise
                        capabilities = b""
                    if capabilities:
                        raise PeerError("trusted executable must not carry file capabilities")
                    self.keys.add(executable_key(metadata))
                finally:
                    os.close(directory)
        except BaseException:
            self.close()
            raise

    def close(self):
        for descriptor in self.descriptors:
            os.close(descriptor)
        self.descriptors.clear()
        self.keys.clear()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


@dataclass(frozen=True)
class PeerIdentity:
    pid: int
    uid: int
    gid: int
    parent: int
    start_ticks: int
    label: str
    executable: tuple
    user_namespace: tuple


def parse_single_id_map(raw, identity):
    """The launcher maps only its original non-root ID, not an ID range."""
    try:
        rows = [tuple(int(part) for part in line.split()) for line in raw.splitlines()]
    except ValueError as error:
        raise PeerError("invalid kernel identity mapping") from error
    if rows != [(identity, identity, 1)]:
        raise PeerError("work namespace does not retain exactly the registered non-root identity")


def authorize_namespace(directory, uid, gid, parent_namespace=None):
    descriptor = os.open("ns/user", os.O_RDONLY | os.O_CLOEXEC, dir_fd=directory)
    try:
        info = os.fstat(descriptor)
        actual = (info.st_dev, info.st_ino)
        if parent_namespace is None:
            expected = os.stat("/proc/self/ns/user")
            if actual != (expected.st_dev, expected.st_ino):
                raise PeerError("caller is in a different user namespace")
        else:
            # Linux UAPI NS_GET_PARENT = _IO(0xb7, 2). The kernel returns a
            # CLOEXEC namespace FD, never a request-supplied parent identity.
            parent = fcntl.ioctl(descriptor, 0xb702)
            try:
                info = os.fstat(parent)
                if (info.st_dev, info.st_ino) != parent_namespace:
                    raise PeerError("work user namespace is not the registered owner's direct child")
            finally:
                os.close(parent)
            parse_single_id_map(read_bounded_at(directory, "uid_map"), uid)
            parse_single_id_map(read_bounded_at(directory, "gid_map"), gid)
        return actual
    finally:
        os.close(descriptor)


def authorize(frame, executables, labels=("unconfined",), *, parent_namespace=None, no_new_privs=False):
    """Re-read all authority-bearing state; do not cache this across requests."""
    require_live(frame)
    directory = os.open(f"/proc/{frame.pid}", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW)
    executable = -1
    try:
        parent, start = parse_start_identity(read_bounded_at(directory, "stat"), frame.pid)
        security = parse_security_state(read_bounded_at(directory, "status"), frame.uid, frame.gid)
        if no_new_privs and security[1] != 1:
            raise PeerError("work entry has not committed NoNewPrivs")
        namespace_key = authorize_namespace(directory, frame.uid, frame.gid, parent_namespace)
        label = read_bounded_at(directory, "attr/current").strip()
        if label not in labels:
            raise PeerError("caller is not in the exact registered role label")
        executable = os.open("exe", os.O_RDONLY | os.O_CLOEXEC, dir_fd=directory)
        key = executable_key(os.fstat(executable))
        if key not in executables.keys:
            raise PeerError("caller executable object is not administrator-trusted for this role")
        # Refuse an exit/exec/credential/label race rather than authenticating a
        # later process by the old PID or an old executable by its current path.
        if (executable_key(os.stat("exe", dir_fd=directory)) != key or
                read_bounded_at(directory, "attr/current").strip() != label or
                parse_start_identity(read_bounded_at(directory, "stat"), frame.pid) != (parent, start) or
                parse_security_state(read_bounded_at(directory, "status"), frame.uid, frame.gid) != security or
                authorize_namespace(directory, frame.uid, frame.gid, parent_namespace) != namespace_key):
            raise PeerError("caller identity changed during authentication")
        require_live(frame)
        return PeerIdentity(frame.pid, frame.uid, frame.gid, parent, start, label, key, namespace_key)
    finally:
        if executable >= 0:
            os.close(executable)
        os.close(directory)
