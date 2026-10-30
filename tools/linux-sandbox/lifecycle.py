"""Durable policy leases and cgroup lifetime ownership for the Linux service.

Only the authenticated service may call this module. It never runs user work,
moves a numeric PID, kills a task, or treats a disconnected caller as proof that
work has exited. The native launcher receives one cgroup.procs descriptor, writes
literal '0' to move itself, and closes it before admitting any work.
"""
from dataclasses import asdict
import ctypes
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import uuid

from policy import LAUNCH_ID, MAX_REQUEST_BYTES, Policy, compile_profiles, decode_request, profile_names


class LifecycleError(RuntimeError):
    pass


def launch_name(value):
    if not isinstance(value, str) or not LAUNCH_ID.fullmatch(value):
        raise LifecycleError("invalid service-generated launch identity")
    return value


def profile_binding(record, source):
    """Bind the exact saved source to its immutable launch and typed policy.

    This is corruption/mismatch detection inside administrator-owned state,
    not a signature authorizing an untrusted caller to supply profile source.
    """
    launch = launch_name(record["launch"])
    policy = Policy.from_request(record["policy"])
    if not isinstance(source, bytes) or not 0 < len(source) <= MAX_REQUEST_BYTES * 8:
        raise LifecycleError("saved policy source exceeds its bounded size")
    return hashlib.sha256(b"morphz-sandbox-profile-v1\0" + launch.encode("ascii") + b"\0" +
                          policy.digest().encode("ascii") + b"\0" + source).hexdigest()


def verify_saved_profile(record, source):
    binding = profile_binding(record, source)
    if "profile_sha256" in record:
        if record["profile_sha256"] != binding:
            raise LifecycleError("saved policy source, launch or policy binding changed")
    else:
        # Pre-binding records can be migrated only while the exact original
        # compiler is available. Never bless unknown source during an upgrade.
        compiled = compile_profiles(Policy.from_request(record["policy"]), record["launch"])
        if source != compiled.source.encode("utf-8"):
            raise LifecycleError("unbound legacy policy differs from the current compiler")
    return binding


def privileged_linux():
    if sys.platform != "linux" or os.getresuid() != (0, 0, 0):
        raise LifecycleError("administrator Linux service required")


def trusted_directory(path, private=False):
    """Open without following any path component or trusting a caller symlink."""
    path = str(path)
    if not path.startswith("/") or path == "/" or any(
            item in ("", ".", "..") for item in path.split("/")[1:]):
        raise LifecycleError("service directory must be canonical and absolute")
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for component in path.split("/")[1:]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW,
                            dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
            info = os.fstat(descriptor)
            if info.st_uid != 0 or info.st_mode & 0o022:
                raise LifecycleError("service directory or ancestor is writable by non-root")
        if private and os.fstat(descriptor).st_mode & 0o077:
            raise LifecycleError("persistent service state must be administrator-private")
        result, descriptor = descriptor, -1
        return result
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def read_file(directory, name, limit=MAX_REQUEST_BYTES * 8):
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or info.st_nlink != 1:
            raise LifecycleError("untrusted persistent service record")
        value = bytearray()
        while len(value) <= limit:
            part = os.read(descriptor, min(65536, limit + 1 - len(value)))
            if not part:
                return bytes(value)
            value.extend(part)
        raise LifecycleError("persistent record exceeds bound")
    finally:
        os.close(descriptor)


class StateStore:
    """Single-writer, fsync-backed records; recovery never revives an admission."""
    def __init__(self, path):
        privileged_linux()
        self.path = Path(path)
        self.directory = trusted_directory(path, private=True)
        self.lock = -1
        try:
            self.lock = os.open("service.lock", os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW,
                                0o600, dir_fd=self.directory)
            info = os.fstat(self.lock)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_nlink != 1:
                raise LifecycleError("invalid service lock")
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BaseException:
            self.close()
            raise

    def close(self):
        for name in ("lock", "directory"):
            descriptor = getattr(self, name, -1)
            if descriptor >= 0:
                os.close(descriptor)
                setattr(self, name, -1)

    def _directory(self, launch):
        return os.open(launch_name(launch), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                       dir_fd=self.directory)

    def _write(self, directory, name, raw):
        if name == "record.json" and len(raw) > MAX_REQUEST_BYTES:
            raise LifecycleError("durable lease record exceeds its bounded size")
        temporary = ".pending-" + uuid.uuid4().hex
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
                             0o600, dir_fd=directory)
        try:
            remaining = memoryview(raw)
            while remaining:
                count = os.write(descriptor, remaining)
                if count <= 0:
                    raise LifecycleError("short persistent record write")
                remaining = remaining[count:]
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.rename(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)

    def create(self, record, compiled):
        launch = launch_name(record["launch"])
        source = compiled.source.encode("utf-8")
        if record.get("profile_sha256") != profile_binding(record, source):
            raise LifecycleError("new lease lacks its exact immutable profile binding")
        os.mkdir(launch, 0o700, dir_fd=self.directory)
        os.fsync(self.directory)
        descriptor = self._directory(launch)
        try:
            # No kernel resource exists until both immutable inputs are durable.
            self._write(descriptor, "profile.apparmor", source)
            self._write(descriptor, "record.json", json.dumps(record, sort_keys=True).encode("ascii"))
        finally:
            os.close(descriptor)

    def save(self, record):
        descriptor = self._directory(record["launch"])
        try:
            self._write(descriptor, "record.json", json.dumps(record, sort_keys=True).encode("ascii"))
        finally:
            os.close(descriptor)

    def records(self):
        result = []
        for launch in sorted(os.listdir(self.directory)):
            if launch == "service.lock":
                continue
            launch_name(launch)  # unknown entries are not silently removed
            descriptor = self._directory(launch)
            try:
                info = os.fstat(descriptor)
                if info.st_uid != 0 or info.st_mode & 0o077:
                    raise LifecycleError("untrusted lease directory")
                try:
                    record = decode_request(read_file(descriptor, "record.json", MAX_REQUEST_BYTES))
                except FileNotFoundError:
                    # Crash before registration was durable: no kernel call was
                    # possible. Retain evidence, never infer a reusable lease.
                    continue
                if record.get("launch") != launch:
                    raise LifecycleError("lease filename and identity differ")
                binding = verify_saved_profile(record, read_file(descriptor, "profile.apparmor"))
                if "profile_sha256" not in record:
                    record["profile_sha256"] = binding
                    self.save(record)  # fsync migration before any kernel operation
                result.append(record)
            finally:
                os.close(descriptor)
        return result

    def source_path(self, launch):
        return str(self.path / launch_name(launch) / "profile.apparmor")


class Cgroups:
    """Root-owned cgroup v2 subtree; no delegation of directory permissions."""
    def __init__(self, path):
        privileged_linux()
        self.path = str(path)
        if not self.path.startswith("/sys/fs/cgroup/"):
            raise LifecycleError("a dedicated cgroup v2 subtree is required")
        self.directory = trusted_directory(self.path)
        try:
            buffer = ctypes.create_string_buffer(256)
            libc = ctypes.CDLL(None, use_errno=True)
            if libc.fstatfs(self.directory, ctypes.byref(buffer)) or ctypes.c_long.from_buffer(buffer).value != 0x63677270:
                raise LifecycleError("lifetime directory is not a real cgroup v2 filesystem")
            # The service runs in the host cgroup namespace. A mount of another
            # namespace/subtree cannot be used to invent membership paths.
            mountinfo = Path("/proc/self/mountinfo").read_text().splitlines()
            if not any(line.split()[3:5] == ["/", "/sys/fs/cgroup"] and
                       " - cgroup2 " in line for line in mountinfo):
                raise LifecycleError("host cgroup v2 root mount is required")
            self.relative = self.path.removeprefix("/sys/fs/cgroup")
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.directory >= 0:
            os.close(self.directory)
            self.directory = -1

    def identity(self, launch):
        try:
            info = os.stat(launch_name(launch), dir_fd=self.directory, follow_symlinks=False)
        except FileNotFoundError:
            return None
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise LifecycleError("untrusted lifetime cgroup")
        return [info.st_dev, info.st_ino]

    def create(self, launch):
        os.mkdir(launch_name(launch), 0o700, dir_fd=self.directory)
        return self.identity(launch)

    def require_identity(self, record):
        actual = self.identity(record["launch"])
        if actual is None or actual != record["cgroup"]:
            raise LifecycleError("lifetime cgroup disappeared or was replaced")

    def join_descriptor(self, record):
        self.require_identity(record)
        directory = os.open(record["launch"], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                            dir_fd=self.directory)
        try:
            descriptor = os.open("cgroup.procs", os.O_WRONLY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=directory)
            try:
                self.require_identity(record)
                return descriptor
            except BaseException:
                os.close(descriptor)
                raise
        finally:
            os.close(directory)

    def has_member(self, record, frame):
        from peer import read_bounded_at, require_live
        self.require_identity(record)
        require_live(frame)
        directory = os.open(f"/proc/{frame.pid}", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            actual = read_bounded_at(directory, "cgroup").splitlines()
            expected = f"0::{self.relative}/{record['launch']}"
            result = actual == [expected]
            require_live(frame)
            return result
        finally:
            os.close(directory)

    def remove_if_empty(self, record):
        actual = self.identity(record["launch"])
        if actual is None:
            return True  # recovery after removal but before durable phase write
        if record["cgroup"] is not None and actual != record["cgroup"]:
            raise LifecycleError("refusing to remove a replacement cgroup")
        try:
            # Kernel rmdir is the atomic admission/lifetime boundary. A check
            # of cgroup.events followed by profile unload would race a join.
            os.rmdir(record["launch"], dir_fd=self.directory)
            return True
        except OSError as error:
            if error.errno in (errno.EBUSY, errno.ENOTEMPTY):
                return False
            raise


class Profiles:
    def __init__(self, store):
        privileged_linux()
        self.store = store

    def _run(self, operation, launch):
        completed = subprocess.run(["/usr/sbin/apparmor_parser", operation, "--skip-cache",
                                    self.store.source_path(launch)], capture_output=True, timeout=20,
                                   env={"PATH": "/usr/sbin:/usr/bin:/bin", "LANG": "C"}, check=False)
        if completed.returncode:
            raise LifecycleError("AppArmor policy operation failed: " +
                                 completed.stderr.decode("utf-8", errors="replace")[:4096])

    def loaded(self, record):
        names = profile_names(Policy.from_request(record["policy"]), record["launch"])
        actual = set(Path("/sys/kernel/security/apparmor/profiles").read_text().splitlines())
        for name in names:
            if any(line.startswith(name + " ") and line != name + " (enforce)" for line in actual):
                raise LifecycleError("lease policy is not enforcing")
        return [name for name in names if name + " (enforce)" in actual]

    def add(self, record):
        if self.loaded(record):
            raise LifecycleError("unique immutable profile generation already exists")
        self._run("--add", record["launch"])
        if len(self.loaded(record)) != 2:
            raise LifecycleError("kernel did not load both enforcing profiles")

    def remove(self, record):
        if not self.loaded(record):
            return
        error = None
        try:
            self._run("--remove", record["launch"])
        except LifecycleError as problem:
            error = problem
        if self.loaded(record):
            raise error or LifecycleError("kernel retained a lease profile after removal")


class Leases:
    """Service-owned state machine. Caller authentication is a separate gate."""
    def __init__(self, store, cgroups, profiles):
        self.store, self.cgroups, self.profiles = store, cgroups, profiles
        self.records = {}

    def recover(self):
        for record in self.store.records():
            if record["phase"] == "removed":
                continue
            if record["phase"] not in ("preparing", "registered", "claimed", "admitted", "closing"):
                raise LifecycleError("unknown durable lease phase")
            # A service restart never recreates caller authority from saved PID
            # numbers. Existing descendants stay protected; no new claim opens.
            record["phase"] = "closing"
            self.store.save(record)
            self.records[record["launch"]] = record
            self.collect(record["launch"])

    def register(self, policy, owner):
        if len(self.records) >= 256 or sum(item["owner"]["uid"] == owner["uid"]
                                         for item in self.records.values()) >= 32:
            raise LifecycleError("bounded active policy lease limit reached")
        launch = uuid.uuid4().hex
        compiled = compile_profiles(policy, launch)
        record = {"launch": launch, "policy": json.loads(json.dumps(asdict(policy))), "owner": owner,
                  "phase": "preparing", "cgroup": None}
        record["profile_sha256"] = profile_binding(record, compiled.source.encode("utf-8"))
        # Reserve space for phase and cgroup metadata before creating anything.
        if len(json.dumps(record, sort_keys=True).encode("ascii")) + 128 > MAX_REQUEST_BYTES:
            raise LifecycleError("durable policy with kernel identity exceeds the registration bound")
        self.store.create(record, compiled)
        self.records[launch] = record
        try:
            record["cgroup"] = self.cgroups.create(launch)
            self.store.save(record)
            self.profiles.add(record)
            record["phase"] = "registered"
            self.store.save(record)
        except BaseException:
            self.close_admission(launch)
            self.collect(launch)
            raise
        return launch

    def claim(self, launch):
        record = self.records[launch_name(launch)]
        if record["phase"] != "registered":
            raise LifecycleError("lease cannot be claimed twice or after closure")
        descriptor = self.cgroups.join_descriptor(record)
        try:
            record["phase"] = "claimed"
            self.store.save(record)
            return descriptor
        except BaseException:
            os.close(descriptor)
            raise

    def mark_admitted(self, launch):
        # This is INTERNAL, not a socket operation. The caller must first prove
        # mounted objects, exact labels, membership and descriptor closure.
        record = self.records[launch_name(launch)]
        if record["phase"] != "claimed":
            raise LifecycleError("unclaimed lease cannot admit work")
        record["phase"] = "admitted"
        self.store.save(record)

    def close_admission(self, launch):
        record = self.records[launch_name(launch)]
        record["phase"] = "closing"
        self.store.save(record)

    def collect(self, launch):
        record = self.records[launch_name(launch)]
        if record["phase"] != "closing":
            raise LifecycleError("admission must close before any resource collection")
        if not self.cgroups.remove_if_empty(record):
            if len(self.profiles.loaded(record)) != 2:
                raise LifecycleError("live lease lost an enforcing profile; refusing recovery")
            return False
        # No child exists and even an outstanding, previously issued procs FD
        # now refers to a dead cgroup (ENODEV). Only now may policy be unloaded.
        self.profiles.remove(record)
        record["phase"] = "removed"
        self.store.save(record)
        del self.records[launch]
        return True
