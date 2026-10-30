#!/usr/bin/python3
"""Explicit Linux administrator install/upgrade/rollback/drained uninstall.

Never invoked automatically by Runtime. Existing descendants retain immutable
profiles, cgroups, images and leases through a service-generation change.
"""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time


def trusted_source_before_imports():
    """Only stdlib has run when administrator code first checks its bundle."""
    source = Path(os.path.abspath(__file__)).parent
    cache = source / "__pycache__"
    if cache.exists() or cache.is_symlink():
        # -B prevents writes, not reads. Release bundles contain only source;
        # do not execute a pre-existing, unvalidated bytecode cache as root.
        raise PermissionError("administrator installer bundle must not contain Python bytecode caches")
    names = ("install.py", "policy.py", "peer.py", "lifecycle.py", "registration.py",
             "admission.py", "server.py", "service.py", "bootstrap.py", "launcher.c", "mounts.c", "mounts.h", "INSTALL.md")
    if {entry.name for entry in source.iterdir()} != set(names):
        # Python may prefer extension modules or bytecode to a .py file. A
        # release source bundle has an exact inert inventory, never .so/.pyc.
        raise PermissionError("administrator installer requires the exact packaged source inventory")
    for name in names:
        target = source / name
        current = Path("/")
        for part in target.parts[1:]:
            current = current / part
            info = current.lstat()
            final = current == target
            if (info.st_uid != 0 or info.st_mode & 0o022 or
                    not (stat.S_ISREG(info.st_mode) and info.st_nlink == 1 if final else
                         stat.S_ISDIR(info.st_mode))):
                raise PermissionError("installer bundle and ancestors must be root-owned and non-user-writable")


if __name__ == "__main__":
    trusted_source_before_imports()

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lifecycle import Cgroups, Leases, Profiles, StateStore, read_file, trusted_directory
from peer import TrustedExecutables

SOURCES = ("policy.py", "peer.py", "lifecycle.py", "registration.py", "admission.py", "server.py", "service.py")
BUILD_SOURCES = (*SOURCES, "launcher.c", "mounts.c", "mounts.h", "bootstrap.py", "install.py")
BASE = Path("/usr/local/libexec/morphz-sandbox")
CONFIG = Path("/etc/morphz-sandbox/config.json")
UNIT = Path("/etc/systemd/system/morphz-sandbox.service")
STATE = Path("/var/lib/morphz-sandbox")
CGROUP = Path("/sys/fs/cgroup/morphz-sandbox-v1")
READY = Path("/run/morphz-sandbox/ready.json")
TRANSACTION = CONFIG.parent / "transaction.json"
ENV = {"PATH": "/usr/sbin:/usr/bin:/bin", "LANG": "C.UTF-8"}


def ensure_directory(path, mode):
    if not path.exists():
        path.mkdir(mode=mode)
    descriptor = trusted_directory(path, private=mode == 0o700)
    os.close(descriptor)


def read_trusted(path, limit=4 * 1024 * 1024):
    directory = trusted_directory(path.parent)
    try:
        return read_file(directory, path.name, limit)
    finally:
        os.close(directory)


def atomic_write(path, raw, mode=0o644):
    """Replace just one root-owned entry, then durably commit its directory."""
    directory = trusted_directory(path.parent)
    temporary = None
    try:
        if path.exists() or path.is_symlink():
            read_file(directory, path.name, 4 * 1024 * 1024)
        descriptor, temporary = tempfile.mkstemp(prefix=".admin-", dir=path.parent)
        try:
            os.fchmod(descriptor, mode)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            temporary = None
            os.fsync(directory)
        finally:
            if temporary is not None:
                os.unlink(temporary)
    finally:
        os.close(directory)


def unlink_trusted(path):
    directory = trusted_directory(path.parent)
    try:
        read_file(directory, path.name, 4 * 1024 * 1024)
        os.unlink(path.name, dir_fd=directory)
        os.fsync(directory)
    finally:
        os.close(directory)


@contextlib.contextmanager
def administration():
    if sys.platform != "linux" or os.getresuid() != (0, 0, 0):
        raise PermissionError("explicit Linux administrator operation required")
    ensure_directory(CONFIG.parent, 0o755)
    directory = trusted_directory(CONFIG.parent)
    descriptor = -1
    try:
        descriptor = os.open("admin.lock", os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW,
                             0o600, dir_fd=directory)
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_nlink != 1:
            raise PermissionError("untrusted administrator lock")
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        os.close(directory)


def unit_source():
    return ("[Unit]\nDescription=Morphz continuous Linux sandbox policies\nAfter=apparmor.service\n"
            "Requires=apparmor.service\n\n[Service]\nType=simple\n"
            f"ExecStart=/usr/bin/python3 -I -B {BASE}/bootstrap.py\n"
            "Restart=on-failure\nRestartSec=1\nKillMode=process\nTimeoutStopSec=30\n"
            "RuntimeDirectory=morphz-sandbox\nRuntimeDirectoryMode=0755\n"
            "RuntimeDirectoryPreserve=yes\n"
            "StateDirectory=morphz-sandbox\nStateDirectoryMode=0700\n"
            "UMask=0077\nNoNewPrivileges=yes\n\n[Install]\nWantedBy=multi-user.target\n").encode()


def systemctl(*arguments, check=True):
    return subprocess.run(["/bin/systemctl", *arguments], check=check, capture_output=True,
                          text=True, timeout=45, env=ENV)


def active():
    return systemctl("is-active", "--quiet", "morphz-sandbox.service", check=False).returncode == 0


def service_safety():
    # An override changing KillMode would kill protected descendants. Refuse
    # it before asking systemd to stop even when the main process has exited.
    mode = systemctl("show", "morphz-sandbox.service", "--property=KillMode", "--value").stdout.strip()
    drops = systemctl("show", "morphz-sandbox.service", "--property=DropInPaths", "--value").stdout.strip()
    if mode != "process" or drops:
        raise PermissionError("unsupported service overrides or descendant-killing KillMode")


def stop_service():
    service_safety()
    systemctl("stop", "morphz-sandbox.service")
    if active():
        raise RuntimeError("service did not stop; refusing configuration changes")


def start_service(config):
    systemctl("reset-failed", "morphz-sandbox.service", check=False)
    systemctl("start", "morphz-sandbox.service")
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        pid = systemctl("show", "morphz-sandbox.service", "--property=MainPID", "--value").stdout.strip()
        try:
            ready = json.loads(read_trusted(READY))
            start_ticks = int(Path(f"/proc/{int(pid)}/stat").read_text().rpartition(")")[2].split()[19])
            if active() and ready == {"pid": int(pid), "start_ticks": start_ticks,
                                     "launcher": config["launcher"], "abi": 1}:
                return
        except (FileNotFoundError, ValueError):
            pass
        time.sleep(0.1)
    raise RuntimeError("installed service did not confirm this exact generation ready")


def validate_config(value):
    if (not isinstance(value, dict) or set(value) != {"abi", "launcher", "runtimes"} or
            type(value["abi"]) is not int or value["abi"] != 1 or
            not isinstance(value["launcher"], str) or not isinstance(value["runtimes"], list) or
            not 1 <= len(value["runtimes"]) <= 16 or any(not isinstance(item, str) for item in value["runtimes"])):
        raise ValueError("invalid installed sandbox configuration")
    path = Path(value["launcher"])
    if path.parent.parent != BASE or path.name != "launcher" or not re.fullmatch(r"v1-[0-9a-f]{24}", path.parent.name):
        raise ValueError("configuration must select an immutable installed generation")
    with TrustedExecutables([value["launcher"]]), TrustedExecutables(value["runtimes"]):
        pass
    return value


def generation_config(name):
    if not isinstance(name, str) or not re.fullmatch(r"v1-[0-9a-f]{24}", name):
        raise ValueError("select an exact installed v1 generation, not an arbitrary path")
    destination = BASE / name
    manifest = json.loads(read_trusted(destination / "installation.json"))
    if not isinstance(manifest, dict) or set(manifest) != {"config", "sha256"}:
        raise ValueError("invalid installed generation manifest")
    config = validate_config(manifest["config"])
    if Path(config["launcher"]).parent != destination or set(manifest["sha256"]) != {*SOURCES, "launcher"}:
        raise ValueError("generation manifest selects different code")
    for item, expected in manifest["sha256"].items():
        if hashlib.sha256(read_trusted(destination / item)).hexdigest() != expected:
            raise ValueError("installed generation content changed")
    return config


def prepare_generation(runtimes):
    with TrustedExecutables(runtimes):
        pass
    for path in (Path("/usr/local/libexec"), BASE):
        ensure_directory(path, 0o755)
    source = Path(__file__).resolve().parent
    # Copy trusted bounded inputs before compiling. A writable checkout or
    # symlink must never become privileged installed service code.
    raw = {name: read_trusted(source / name) for name in BUILD_SOURCES}
    digest = hashlib.sha256()
    for name in BUILD_SOURCES:
        digest.update(name.encode() + b"\0" + raw[name])
    digest.update(json.dumps(runtimes, separators=(",", ":")).encode())
    destination = BASE / ("v1-" + digest.hexdigest()[:24])
    if destination.exists() or destination.is_symlink():
        existing = generation_config(destination.name)
        if existing["runtimes"] != runtimes:
            raise ValueError("immutable generation Runtime allowlist differs")
        return existing
    staging = Path(tempfile.mkdtemp(prefix=".install-", dir=BASE))
    try:
        for name in (*SOURCES, "launcher.c", "mounts.c", "mounts.h"):
            (staging / name).write_bytes(raw[name])
            os.chmod(staging / name, 0o444)
        subprocess.run(["/usr/bin/cc", "-std=c11", "-static", "-Wall", "-Wextra", "-Werror", "-O2",
                        "-fstack-protector-strong", "-D_FORTIFY_SOURCE=2",
                        str(staging / "launcher.c"), str(staging / "mounts.c"),
                        "-o", str(staging / "launcher"), "-ljson-c", "-lapparmor", "-pthread"],
                       check=True, timeout=60, env=ENV)
        segments = subprocess.check_output(["/usr/bin/readelf", "-l", str(staging / "launcher")], text=True)
        if "INTERP" in segments:
            raise RuntimeError("sandbox launcher unexpectedly has a dynamic interpreter")
        os.chmod(staging / "launcher", 0o555)
        for name in ("launcher.c", "mounts.c", "mounts.h"):
            (staging / name).unlink()
        config = {"abi": 1, "launcher": str(destination / "launcher"), "runtimes": runtimes}
        manifest = {"config": config, "sha256": {
            name: hashlib.sha256((staging / name).read_bytes()).hexdigest() for name in (*SOURCES, "launcher")}}
        atomic_write(staging / "installation.json", json.dumps(manifest, sort_keys=True).encode(), 0o444)
        for item in staging.iterdir():
            with item.open("rb") as stream:
                os.fsync(stream.fileno())
        os.chmod(staging, 0o755)
        staging.rename(destination)
        descriptor = trusted_directory(BASE)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        return generation_config(destination.name)
    finally:
        if staging.exists():
            shutil.rmtree(staging)  # exact private staging path, never a live generation


def bootstrap_install():
    source = read_trusted(Path(__file__).resolve().parent / "bootstrap.py")
    target = BASE / "bootstrap.py"
    if target.exists() or target.is_symlink():
        if read_trusted(target) != source:
            raise ValueError("fixed bootstrap revision differs; explicit migration required")
    else:
        atomic_write(target, source, 0o444)


def existing_config():
    config = validate_config(json.loads(read_trusted(CONFIG)))
    generation = Path(config["launcher"]).parent
    if not (generation / "installation.json").exists():
        raise ValueError("legacy experimental service lacks the versioned lifecycle contract; refusing to stop it")
    if generation_config(generation.name) != config:
        raise ValueError("current generation and configuration disagree")
    return config


def ensure_no_transaction():
    if TRANSACTION.exists() or TRANSACTION.is_symlink():
        raise RuntimeError("unfinished administrator transition; run --recover before another operation")


def transition(target):
    before = existing_config()
    if before == target:
        raise ValueError("generation is already selected")
    was_active = active()
    service_safety()
    journal = {"operation": "switch", "before": before, "target": target, "was_active": was_active}
    atomic_write(TRANSACTION, json.dumps(journal, sort_keys=True).encode(), 0o600)
    try:
        stop_service()
        # Bootstrap/unit remain generation-independent. A crash before the
        # atomic config flip still selects the complete old generation.
        bootstrap_install()
        atomic_write(UNIT, unit_source())
        systemctl("daemon-reload")
        atomic_write(CONFIG, json.dumps(target, sort_keys=True).encode())
        start_service(target)
    except BaseException as problem:
        try:
            stop_service()
            atomic_write(CONFIG, json.dumps(before, sort_keys=True).encode())
            systemctl("daemon-reload")
            if was_active:
                start_service(before)
            unlink_trusted(TRANSACTION)
        except BaseException as recovery:
            raise RuntimeError("transition failed; old kernel protections retained; explicit --recover required: " +
                               str(recovery)) from problem
        raise RuntimeError("transition failed; previous configuration/service restored") from problem
    unlink_trusted(TRANSACTION)
    return {"selected": target["launcher"], "previous": before["launcher"], "ready": True}


def recover():
    journal = json.loads(read_trusted(TRANSACTION))
    if not isinstance(journal, dict) or journal.get("operation") not in ("install", "switch", "uninstall"):
        raise ValueError("invalid administrator transition journal")
    if journal["operation"] == "install":
        if set(journal) != {"operation", "target"}:
            raise ValueError("invalid initial installation journal")
        target = validate_config(journal["target"])
        if generation_config(Path(target["launcher"]).parent.name) != target:
            raise ValueError("initial generation no longer matches its manifest")
        # Completing a first installation never starts or enables the service.
        if CONFIG.exists() and json.loads(read_trusted(CONFIG)) != target:
            raise ValueError("initial installation configuration was replaced")
        bootstrap_install()
        atomic_write(CONFIG, json.dumps(target, sort_keys=True).encode())
        atomic_write(UNIT, unit_source())
        systemctl("daemon-reload")
        unlink_trusted(TRANSACTION)
        return {"recovered_install": target["launcher"], "ready": False, "started": False}
    expected = {"operation", "before", "target", "was_active"} if journal["operation"] == "switch" else \
               {"operation", "before", "was_active", "enabled"}
    if set(journal) != expected or type(journal["was_active"]) is not bool:
        raise ValueError("invalid administrator recovery metadata")
    if journal["operation"] == "uninstall" and journal["enabled"] not in ("enabled", "enabled-runtime", "disabled"):
        raise ValueError("unsupported saved service enablement state")
    before = validate_config(journal["before"])
    if generation_config(Path(before["launcher"]).parent.name) != before:
        raise ValueError("recovery generation no longer matches its original configuration")
    bootstrap_install()
    # The uninstall may have removed either/both files before a crash. Restore
    # the known safe unit first so systemd always uses KillMode=process.
    atomic_write(UNIT, unit_source())
    atomic_write(CONFIG, json.dumps(before, sort_keys=True).encode())
    systemctl("daemon-reload")
    stop_service()
    if journal["operation"] == "uninstall" and journal["enabled"] in ("enabled", "enabled-runtime"):
        systemctl("enable", *(["--runtime"] if journal["enabled"] == "enabled-runtime" else []), "morphz-sandbox.service")
    if journal["was_active"]:
        start_service(before)
    unlink_trusted(TRANSACTION)
    return {"recovered": before["launcher"], "ready": journal["was_active"]}


def drained_uninstall():
    before = existing_config()
    was_active = active()
    enabled = systemctl("is-enabled", "morphz-sandbox.service", check=False).stdout.strip()
    if enabled not in ("enabled", "enabled-runtime", "disabled"):
        raise ValueError("unsupported service enablement state; refusing uninstall")
    service_safety()
    atomic_write(TRANSACTION, json.dumps({"operation": "uninstall", "before": before,
                                        "was_active": was_active, "enabled": enabled}, sort_keys=True).encode(), 0o600)
    try:
        stop_service()
        store, groups = StateStore(STATE), None
        try:
            # The literal subtree disappears on reboot. Recreate/verify only
            # this fixed administrator-owned path; old leases cannot recreate
            # authority and recovery collects them only after kernel emptiness.
            ensure_directory(CGROUP, 0o700)
            groups = Cgroups(CGROUP)
            leases = Leases(store, groups, Profiles(store))
            leases.recover()
            if leases.records:
                raise RuntimeError("protected work is still active; refusing uninstall without killing it")
            children = [name for name in os.listdir(groups.directory)
                        if stat.S_ISDIR(os.stat(name, dir_fd=groups.directory, follow_symlinks=False).st_mode)]
            if children:
                raise RuntimeError("unaccounted lifetime cgroups; refusing uninstall")
            if any(line.startswith("morphz_sbox_v1_") for line in
                   Path("/sys/kernel/security/apparmor/profiles").read_text().splitlines()):
                raise RuntimeError("unaccounted sandbox profiles; refusing uninstall")
            systemctl("disable", "morphz-sandbox.service")
            unlink_trusted(UNIT)
            unlink_trusted(CONFIG)
            systemctl("daemon-reload")
        finally:
            if groups is not None:
                groups.close()
            store.close()
    except BaseException:
        atomic_write(UNIT, unit_source())
        atomic_write(CONFIG, json.dumps(before, sort_keys=True).encode())
        systemctl("daemon-reload")
        if enabled in ("enabled", "enabled-runtime"):
            systemctl("enable", *(["--runtime"] if enabled == "enabled-runtime" else []), "morphz-sandbox.service")
        if was_active:
            start_service(before)
        unlink_trusted(TRANSACTION)
        raise
    unlink_trusted(TRANSACTION)
    # Keep audit records and immutable code; never recursively delete live state.
    return {"uninstalled": True, "active_leases": 0, "retained": [str(BASE), str(STATE)]}


def install(runtimes, operation="install", generation=None):
    with administration():
        if operation == "recover":
            return recover()
        ensure_no_transaction()
        if operation == "uninstall":
            return drained_uninstall()
        if operation == "rollback":
            return transition(generation_config(generation))
        if operation == "upgrade":
            existing_config()
            return transition(prepare_generation(runtimes))
        if CONFIG.exists() or CONFIG.is_symlink() or UNIT.exists() or UNIT.is_symlink():
            raise FileExistsError("sandbox installation already exists; use explicit --upgrade or --rollback")
        for path, mode in ((Path("/run/morphz-sandbox"), 0o755), (STATE, 0o700), (CGROUP, 0o700)):
            ensure_directory(path, mode)
        target = prepare_generation(runtimes)
        bootstrap_install()
        atomic_write(TRANSACTION, json.dumps({"operation": "install", "target": target}, sort_keys=True).encode(), 0o600)
        atomic_write(CONFIG, json.dumps(target, sort_keys=True).encode())
        atomic_write(UNIT, unit_source())
        unlink_trusted(TRANSACTION)
        return {"installed": str(Path(target["launcher"]).parent), "runtimes": runtimes,
                "started": False, "next": "systemctl daemon-reload; systemctl start morphz-sandbox"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    operations = parser.add_mutually_exclusive_group()
    operations.add_argument("--upgrade", action="store_true")
    operations.add_argument("--rollback", metavar="INSTALLED_GENERATION")
    operations.add_argument("--uninstall", action="store_true")
    operations.add_argument("--recover", action="store_true")
    parser.add_argument("--runtime", action="append", help="exact administrator-installed native Runtime image (repeatable)")
    args = parser.parse_args()
    operation = "upgrade" if args.upgrade else "rollback" if args.rollback else "uninstall" if args.uninstall else "recover" if args.recover else "install"
    if bool(args.runtime) != (operation in ("install", "upgrade")):
        parser.error("--runtime is required only for install/upgrade, forbidden for rollback/uninstall/recover")
    print(json.dumps(install(args.runtime, operation, args.rollback)))
