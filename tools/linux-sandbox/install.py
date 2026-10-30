#!/usr/bin/python3
"""Explicit administrator installation; never invoked automatically by Runtime.

Install only in isolated CI until the production acceptance gates are complete.
Executable generations are immutable. This initial installer refuses upgrades
instead of replacing an active policy compiler or silently dropping trust.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lifecycle import trusted_directory
from peer import TrustedExecutables

SOURCES = ("policy.py", "peer.py", "lifecycle.py", "registration.py", "admission.py", "server.py", "service.py")
BASE = Path("/usr/local/libexec/morphz-sandbox")
CONFIG = Path("/etc/morphz-sandbox/config.json")
UNIT = Path("/etc/systemd/system/morphz-sandbox.service")


def ensure_directory(path, mode):
    if not path.exists():
        path.mkdir(mode=mode)
    fd = trusted_directory(path, private=mode == 0o700)
    os.close(fd)


def install(runtimes):
    if sys.platform != "linux" or os.getresuid() != (0, 0, 0):
        raise PermissionError("explicit Linux administrator installation required")
    if CONFIG.exists() or CONFIG.is_symlink() or UNIT.exists() or UNIT.is_symlink():
        raise FileExistsError("sandbox installation already exists; refusing an implicit upgrade")
    with TrustedExecutables(runtimes):
        pass
    for path in (Path("/usr/local/libexec"), BASE, CONFIG.parent):
        ensure_directory(path, 0o755)
    for path, mode in ((Path("/run/morphz-sandbox"), 0o755),
                       (Path("/var/lib/morphz-sandbox"), 0o700),
                       (Path("/sys/fs/cgroup/morphz-sandbox-v1"), 0o700)):
        ensure_directory(path, mode)
    source = Path(__file__).resolve().parent
    digest = hashlib.sha256()
    for name in (*SOURCES, "launcher.c", "mounts.c", "mounts.h"):
        digest.update(name.encode() + b"\0" + (source / name).read_bytes())
    destination = BASE / ("v1-" + digest.hexdigest()[:24])
    if destination.exists():
        raise FileExistsError("immutable installation generation already exists")
    staging = Path(tempfile.mkdtemp(prefix=".install-", dir=BASE))
    try:
        for name in SOURCES:
            shutil.copyfile(source / name, staging / name)
            os.chmod(staging / name, 0o444)
        subprocess.run(["/usr/bin/cc", "-std=c11", "-static", "-Wall", "-Wextra", "-Werror", "-O2",
                        "-fstack-protector-strong", "-D_FORTIFY_SOURCE=2",
                        str(source / "launcher.c"), str(source / "mounts.c"),
                        "-o", str(staging / "launcher"), "-ljson-c", "-lapparmor", "-pthread"],
                       check=True, timeout=60, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
        # A dynamic loader would consume LD_PRELOAD before main(). The launcher
        # must be static, and bwrap receives a separate fixed clean environment.
        segments = subprocess.check_output(["/usr/bin/readelf", "-l", str(staging / "launcher")], text=True)
        if "INTERP" in segments:
            raise RuntimeError("sandbox launcher unexpectedly has a dynamic interpreter")
        os.chmod(staging / "launcher", 0o555)
        os.chmod(staging, 0o755)
        staging.rename(destination)
        config = {"abi": 1, "launcher": str(destination / "launcher"), "runtimes": runtimes}
        with CONFIG.open("x") as stream:
            json.dump(config, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(CONFIG, 0o644)
        with UNIT.open("x") as stream:
            stream.write("[Unit]\nDescription=Morphz continuous Linux sandbox policies\nAfter=apparmor.service\n"
                         "Requires=apparmor.service\n\n[Service]\nType=simple\n"
                         f"ExecStart=/usr/bin/python3 -I -B {destination}/service.py\n"
                         "Restart=on-failure\nRestartSec=1\nKillMode=process\n"
                         "RuntimeDirectory=morphz-sandbox\nRuntimeDirectoryMode=0755\n"
                         "StateDirectory=morphz-sandbox\nStateDirectoryMode=0700\n"
                         "UMask=0077\nNoNewPrivileges=yes\n\n[Install]\nWantedBy=multi-user.target\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(UNIT, 0o644)
        print(json.dumps({"installed": str(destination), "runtimes": runtimes,
                          "started": False, "next": "systemctl daemon-reload; systemctl start morphz-sandbox"}))
    finally:
        # Remove only the exact staging directory allocated above. An installed
        # generation/config is retained on failure for diagnosis and recovery.
        if staging.exists():
            shutil.rmtree(staging)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", action="append", required=True,
                        help="administrator-installed native Runtime executable (repeatable)")
    install(parser.parse_args().runtime)
