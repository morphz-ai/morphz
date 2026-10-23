#!/usr/bin/python3
"""Installed entry point. Accepts no command line overrides or model work."""
import json
import os
from pathlib import Path
import signal
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lifecycle import Cgroups, Leases, Profiles, StateStore, read_file, trusted_directory
from peer import TrustedExecutables
from registration import Registration
from server import ServiceLoop

CONFIG = Path("/etc/morphz-sandbox/config.json")
CONTROL = Path("/run/morphz-sandbox/control.sock")
STATE = Path("/var/lib/morphz-sandbox")
CGROUP = Path("/sys/fs/cgroup/morphz-sandbox-v1")
READY = "ready.json"


def installed_config():
    directory = trusted_directory(CONFIG.parent)
    try:
        config = json.loads(read_file(directory, CONFIG.name))
    finally:
        os.close(directory)
    if (not isinstance(config, dict) or set(config) != {"abi", "launcher", "runtimes"} or
            type(config["abi"]) is not int or config["abi"] != 1 or
            not isinstance(config["launcher"], str) or not isinstance(config["runtimes"], list) or
            not 1 <= len(config["runtimes"]) <= 16 or
            any(not isinstance(value, str) for value in config["runtimes"])):
        raise ValueError("invalid administrator-owned sandbox configuration")
    return config


def main():
    if len(sys.argv) != 1 or sys.platform != "linux" or os.getresuid() != (0, 0, 0):
        raise PermissionError("installed Linux administrator service only")
    config = installed_config()
    # Installer/systemd own persistent paths. The fixed cgroup disappears on
    # reboot; re-create only this service's literal subtree, then verify it.
    CGROUP.mkdir(mode=0o700, exist_ok=True)
    store, groups = StateStore(STATE), Cgroups(CGROUP)
    registration = loop = None
    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        leases = Leases(store, groups, Profiles(store))
        leases.recover()
        with TrustedExecutables(config["runtimes"]) as runtimes, \
                TrustedExecutables([config["launcher"]]) as launchers:
            registration = Registration(leases, runtimes, launchers)
            loop = ServiceLoop(registration, CONTROL)
            # Readiness is emitted only after recovery, pinned executable
            # verification, the exclusive state lock and real control bind.
            # The installer binds this root-owned record to systemd's MainPID.
            store._write(loop.directory, READY, json.dumps(
                {"pid": os.getpid(), "start_ticks": int(Path("/proc/self/stat").read_text().rpartition(")")[2].split()[19]),
                 "launcher": config["launcher"], "abi": 1}).encode())
            print(json.dumps({"ready": True, "abi": 1, "recovered": len(leases.records)}), flush=True)
            while not stopping:
                loop.step()
    finally:
        if loop is not None:
            try:
                ready = json.loads(read_file(loop.directory, READY))
                if ready.get("pid") == os.getpid():
                    os.unlink(READY, dir_fd=loop.directory)
            except FileNotFoundError:
                pass
            loop.close()
        if registration is not None:
            registration.close()
        groups.close()
        store.close()


if __name__ == "__main__":
    main()
