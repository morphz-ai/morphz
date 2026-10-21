"""Service-side proof of the actual native launch, before general work runs.

The outer trusted launcher stays alive with the original root descriptors. The
inner trusted launcher has already mounted, stacked both enforcing profiles,
and closed every capability except its private admission socket. Neither a
model field nor a 'ready' string is accepted as proof of these kernel facts.
"""
from dataclasses import dataclass
import os
import re
import stat

from lifecycle import launch_name
from peer import PeerError, authorize, parse_security_state, read_bounded_at, require_live
from policy import Policy, compile_profiles, contains, literal_path


def root_specifications(policy):
    return tuple((path, writable) for paths, writable in
                 ((policy.read_roots, False), (policy.write_roots, True)) for path in paths)


def root_descriptors(value, count):
    if (not isinstance(value, list) or len(value) != count or
            any(type(item) is not int or not 3 <= item < 1048576 for item in value) or
            len(set(value)) != len(value)):
        raise PeerError("expected one distinct bounded directory descriptor per registered root")
    return tuple(value)


def process_directory(frame):
    require_live(frame)
    return os.open(f"/proc/{frame.pid}", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)


def namespace_key(directory, name):
    value = os.stat("ns/" + name, dir_fd=directory)
    return value.st_dev, value.st_ino


def directory_in_process(directory, path):
    """Walk the actual process root; only the final component may be a file."""
    literal_path(path)
    descriptor = os.open("root", os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC, dir_fd=directory)
    try:
        parts = path.split("/")[1:]
        for index, part in enumerate(parts):
            if part:
                child = os.open(part, os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC |
                                (os.O_DIRECTORY if index < len(parts) - 1 else 0),
                                dir_fd=descriptor)
                os.close(descriptor)
                descriptor = child
        result, descriptor = descriptor, -1
        return result
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def object_key(descriptor):
    info = os.fstat(descriptor)
    if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
        raise PeerError("root capability is not a regular file or directory")
    return info.st_dev, info.st_ino


def verify_mount_boundaries(raw, policy):
    """Check the whole mount table, not only destinations of positive grants."""
    mounts = {}
    for line in raw.splitlines():
        fields = line.split()
        try:
            separator = fields.index("-")
            if separator < 6 or len(fields) < separator + 4:
                raise ValueError("short mount entry")
            path = re.sub(r"\\([0-7]{3})", lambda m: chr(int(m[1], 8)), fields[4])
            literal_path(path)
            flags = set(fields[5].split(","))
            filesystem = fields[separator + 1]
            if not ({"ro", "rw"} & flags) or {"ro", "rw"}.issubset(flags):
                raise ValueError("ambiguous mount access")
        except (ValueError, IndexError) as error:
            raise PeerError("incomplete mounted filesystem evidence") from error
        mounts[path] = (flags, filesystem)
        if "rw" in flags and not any(contains(root, path) for root in
                                     (*policy.write_roots, "/dev", "/proc")):
            raise PeerError(f"writable filesystem outside approved roots: {path!r} ({filesystem})")
    if "/" not in mounts or ("/" not in policy.write_roots and "ro" not in mounts["/"][0]):
        raise PeerError("read-only host baseline is missing")
    for path in policy.hidden_roots:
        # Explicit grants mounted after a private root may intentionally expose
        # that root again. The initial '/' read baseline is not such a grant.
        if any(root != "/" and contains(root, path)
               for root in (*policy.read_roots, *policy.write_roots)):
            continue
        flags, filesystem = mounts.get(path, (set(), ""))
        if filesystem != "tmpfs" or "ro" not in flags:
            raise PeerError("unapproved home or temporary directory was not hidden read-only")


def require_closed_capabilities(directory):
    # stdin/stdout/stderr belong to the Runtime's pipe/private PTY. The only
    # other handle at this barrier is the inner launcher's admission socket.
    # In particular no root, manifest, cgroup or host directory FD may survive.
    fds = os.open("fd", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC, dir_fd=directory)
    try:
        names = sorted(int(name) for name in os.listdir(fds))
        if len(names) != 4 or names[:3] != [0, 1, 2] or not stat.S_ISSOCK(
                os.stat(str(names[3]), dir_fd=fds).st_mode):
            raise PeerError("work entry retains unexpected host capability descriptors")
    finally:
        os.close(fds)


@dataclass
class RootPin:
    path: str
    writable: bool
    source_fd: int
    descriptor: int
    identity: tuple


class Admission:
    def __init__(self, registration):
        self.registration = registration
        self.pins = {}

    def close(self, launch=None):
        for key in list(self.pins) if launch is None else [launch]:
            for pin in self.pins.pop(key, ()):
                os.close(pin.descriptor)

    def outer(self, launch):
        registration = self.registration
        owner = registration._owner(launch)
        binding = registration.launchers.get(launch)
        if binding is None or authorize(binding[0], registration.launcher_executables) != binding[1]:
            raise PeerError("original trusted outer launcher is no longer alive and unchanged")
        if not registration.leases.cgroups.has_member(registration.leases.records[launch], binding[0]):
            raise PeerError("outer launcher has not joined this lease's lifetime group")
        return owner, binding

    def pin(self, launch, frame, descriptors):
        launch = launch_name(launch)
        record = self.registration.leases.records[launch]
        if record["phase"] != "claimed" or launch in self.pins:
            raise PeerError("root objects can be bound only once to a claimed lease")
        _owner, (_outer, identity) = self.outer(launch)
        if authorize(frame, self.registration.launcher_executables) != identity:
            raise PeerError("only the authenticated outer launcher can bind root objects")
        specifications = root_specifications(Policy.from_request(record["policy"]))
        numbers = root_descriptors(descriptors, len(specifications))
        directory = process_directory(frame)
        pins = []
        try:
            for (path, writable), number in zip(specifications, numbers):
                descriptor = os.open(f"fd/{number}", os.O_PATH | os.O_CLOEXEC,
                                     dir_fd=directory)
                try:
                    identity = object_key(descriptor)
                    current = directory_in_process(directory, path)
                    try:
                        if object_key(current) != identity:
                            raise PeerError("root name was replaced before its object binding")
                    finally:
                        os.close(current)
                    pins.append(RootPin(path, writable, number, descriptor, identity))
                except BaseException:
                    os.close(descriptor)
                    raise
            self.outer(launch)
            require_live(frame)
            self.pins[launch] = pins
            return [{"path": pin.path, "writable": pin.writable,
                     "device": pin.identity[0], "inode": pin.identity[1]} for pin in pins]
        except BaseException:
            for pin in pins:
                os.close(pin.descriptor)
            raise
        finally:
            os.close(directory)

    def admit(self, launch, frame):
        """Call only on the service-owned per-lease private admission endpoint."""
        launch = launch_name(launch)
        record = self.registration.leases.records[launch]
        if record["phase"] != "claimed" or launch not in self.pins:
            raise PeerError("work has no unconsumed pinned-object admission")
        policy = Policy.from_request(record["policy"])
        owner, (outer, _identity) = self.outer(launch)
        compiled = compile_profiles(policy, launch)
        labels = (f"{compiled.bootstrap}//&{compiled.work} (enforce)",
                  f"{compiled.work}//&{compiled.bootstrap} (enforce)")
        kwargs = {"labels": labels, "parent_namespace": owner.user_namespace, "no_new_privs": True}
        identity = authorize(frame, self.registration.launcher_executables, **kwargs)
        if (identity.uid, identity.gid) != (owner.uid, owner.gid):
            raise PeerError("inner launcher changed the registered user identity")
        if not self.registration.leases.cgroups.has_member(record, frame):
            raise PeerError("inner launcher is outside its registered lifetime group")
        directory, source = process_directory(frame), -1
        try:
            source = process_directory(outer)
            names = ("mnt", "pid", "ipc") + (("net",) if policy.network == "deny" else ())
            namespaces = {name: namespace_key(directory, name) for name in names}
            if any(value == namespace_key(source, name) for name, value in namespaces.items()):
                raise PeerError("required work namespace was not isolated")
            groups, _ = parse_security_state(read_bounded_at(directory, "status"), owner.uid, owner.gid)
            original_groups, _ = parse_security_state(read_bounded_at(source, "status"), owner.uid, owner.gid)
            if not set(groups).issubset(original_groups):
                raise PeerError("work entry gained supplementary groups")
            verify_mount_boundaries(read_bounded_at(directory, "mountinfo", 4 * 1024 * 1024), policy)
            for pin in self.pins[launch]:
                # The outer keeps the exact original object alive, even if a
                # host subsequently renames/replaces the source pathname.
                current = os.open(f"fd/{pin.source_fd}", os.O_PATH | os.O_CLOEXEC,
                                  dir_fd=source)
                mounted = -1
                try:
                    mounted = directory_in_process(directory, pin.path)
                    if object_key(current) != pin.identity or object_key(mounted) != pin.identity:
                        raise PeerError("mounted directory does not match the retained approved object")
                    writable = any(contains(root, pin.path) for root in policy.write_roots)
                    if bool(os.fstatvfs(mounted).f_flag & os.ST_RDONLY) == writable:
                        raise PeerError("mounted root has the wrong read/write boundary")
                finally:
                    os.close(current)
                    if mounted >= 0:
                        os.close(mounted)
            require_closed_capabilities(directory)
            if authorize(frame, self.registration.launcher_executables, **kwargs) != identity or any(
                    namespace_key(directory, name) != value for name, value in namespaces.items()):
                raise PeerError("inner launch identity changed during admission")
            self.outer(launch)
            require_live(frame)
            self.registration.leases.mark_admitted(launch)
            self.registration.signal_admitted(launch)
            return {"ok": True, "launch": launch, "admitted": True}
        finally:
            if source >= 0:
                os.close(source)
            os.close(directory)
