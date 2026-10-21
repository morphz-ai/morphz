"""Non-root directory-object pins for the approved Linux launcher boundary.

This is not a permission decision or a mount implementation. The trusted
launcher receives an authenticated, frozen policy, opens the actual objects as
the calling user, retains these descriptors until admission, and closes them
before executing work. Mount sources must use the descriptors, never reopen
the original source strings after verification.
"""

from dataclasses import dataclass
import json
import os
import stat
import sys

from policy import Policy, literal_path


class RootError(PermissionError):
    pass


def require_unprivileged():
    if sys.platform != "linux" or not hasattr(os, "O_PATH"):
        raise RootError("directory-object pins require the supported Linux kernel")
    uid, gid = os.getuid(), os.getgid()
    if uid <= 0 or os.getresuid() != (uid,) * 3 or os.getresgid() != (gid,) * 3:
        raise RootError("roots must be opened using the caller's non-root identity")
    with open("/proc/self/status", encoding="ascii") as stream:
        fields = dict(line.split(":", 1) for line in stream if ":" in line)
    for name, identity in (("Uid", uid), ("Gid", gid)):
        if fields.get(name, "").split() != [str(identity)] * 4:
            raise RootError("root opener has a different filesystem identity")
    if any(int(fields.get(name, "-1").strip(), 16) != 0
           for name in ("CapEff", "CapPrm", "CapInh", "CapAmb")):
        raise RootError("root opener must not carry capabilities")


def open_directory(path):
    """Walk pinned parents without resolving any symlink, including ancestors."""
    literal_path(path)
    flags = os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    descriptor = os.open("/", flags)
    try:
        for component in path.split("/")[1:]:
            if component:
                child = os.open(component, flags, dir_fd=descriptor)
                os.close(descriptor)
                descriptor = child
        result, descriptor = descriptor, -1
        return result
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def directory_identity(descriptor):
    metadata = os.fstat(descriptor)
    if not stat.S_ISDIR(metadata.st_mode):
        raise RootError("pinned object is not a directory")
    with open(f"/proc/self/fdinfo/{descriptor}", encoding="ascii") as stream:
        fields = dict(line.split(":", 1) for line in stream if ":" in line)
    try:
        mount_id = int(fields["mnt_id"].strip())
    except (KeyError, ValueError) as error:
        raise RootError("kernel did not identify the pinned source mount") from error
    if mount_id <= 0:
        raise RootError("invalid source mount identity")
    # Directory contents and timestamps may legitimately change while the
    # object stays the same. They are not part of its stable identity.
    return metadata.st_dev, metadata.st_ino, mount_id


@dataclass(frozen=True)
class DirectoryPin:
    path: str
    descriptor: int
    identity: tuple[int, int, int]


class PinnedRoots:
    def __init__(self, policy):
        require_unprivileged()
        self.pins = {}
        self.closed = False
        # A directly constructed dataclass must pass the same typed boundary.
        from dataclasses import asdict
        self.policy = Policy.from_request(json.loads(json.dumps(asdict(policy))))
        try:
            for path in sorted(set((*self.policy.read_roots, *self.policy.write_roots,
                                    self.policy.cwd))):
                descriptor = open_directory(path)
                try:
                    pin = DirectoryPin(path, descriptor, directory_identity(descriptor))
                    self.pins[path] = pin
                except BaseException:
                    os.close(descriptor)
                    raise
            self.verify_source_bindings()
        except BaseException:
            self.close()
            raise

    def _require_open(self):
        require_unprivileged()
        if self.closed:
            raise RootError("directory pins have already been closed")
        for pin in self.pins.values():
            if os.get_inheritable(pin.descriptor) or directory_identity(pin.descriptor) != pin.identity:
                raise RootError("directory descriptor was replaced or made inheritable")

    def verify_source_bindings(self):
        """Reject already-observed source replacement; retain FD authority later.

        This verification is not a promise that a pathname cannot change after
        the check. The subsequent mount handoff must use the retained FD, and
        admission must verify the actual mounted inode at its destination.
        """
        self._require_open()
        for pin in self.pins.values():
            current = open_directory(pin.path)
            try:
                if directory_identity(current) != pin.identity:
                    raise RootError("approved directory name was replaced after pinning")
            finally:
                os.close(current)

    def mount_bindings(self):
        """Preserve existing read-first/write-last semantics, without mounting."""
        self._require_open()
        bindings = []
        for roots, access in ((self.policy.read_roots, "read"), (self.policy.write_roots, "write")):
            for path in sorted(roots, key=lambda value: (value.count("/"), value)):
                if access == "read" and path == "/":
                    # The baseline is already read-only. Rebinding / after
                    # hiding HOME/TMP would expose those data roots again.
                    continue
                pin = self.pins[path]
                bindings.append((access, pin.descriptor, path, pin.identity))
        return tuple(bindings)

    def close(self):
        if self.closed:
            return
        for pin in self.pins.values():
            os.close(pin.descriptor)
        self.pins.clear()
        self.closed = True

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()
