"""Finite synthetic workload; never a production command execution interface."""

import argparse
import ctypes
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys

PREFIX = "DYNAMIC_JSON "


def emit(**record):
    print(PREFIX + json.dumps(record, sort_keys=True), flush=True)


def identity():
    status = {}
    for line in Path("/proc/self/status").read_text().splitlines():
        key, _, value = line.partition(":")
        if key in {"CapEff", "CapPrm", "CapInh", "CapAmb", "CapBnd", "NoNewPrivs"}:
            status[key] = value.strip()
    return {
        "pid": os.getpid(), "ppid": os.getppid(), "sid": os.getsid(0),
        "pgid": os.getpgrp(), "tpgid": os.tcgetpgrp(0) if os.isatty(0) else None,
        "label": Path("/proc/self/attr/current").read_text().strip(),
        "cwd": os.getcwd(), "uid": os.getuid(), "status": status,
        "fds": sorted(int(item) for item in os.listdir("/proc/self/fd") if item.isdigit()),
    }


def outcome(action):
    try:
        return {"ok": True, "value": action()}
    except OSError as error:
        return {"ok": False, "errno": error.errno, "error": str(error)}


def read_check(path):
    opened = outcome(lambda: Path(path).read_text())
    cat = subprocess.run(
        ["/bin/cat", path], text=True, capture_output=True, timeout=5, check=False,
    )
    return {"open": opened, "cat_code": cat.returncode,
            "cat_stdout": cat.stdout, "cat_stderr": cat.stderr}


def operations(request, profile):
    op = request["op"]
    if op == "read":
        return read_check(request["path"])
    if op == "ordinary":
        parent = Path(request["path"])
        parent.mkdir(exist_ok=True)
        original, renamed = parent / "ordinary.txt", parent / "renamed.txt"
        original.write_text("ordinary-v1")
        original.write_text("ordinary-v2")
        original.rename(renamed)
        value = renamed.read_text()
        renamed.unlink()
        return {"value": value, "identity": identity()}
    if op == "rename":
        return outcome(lambda: os.rename(request["source"], request["destination"]))
    if op == "network":
        def connect():
            with socket.create_connection(("127.0.0.1", int(request["port"])), timeout=2) as sock:
                sock.sendall(b"DYNAMIC_SYNTHETIC\n")
                return "sent-to-live-loopback-listener"
        return outcome(connect)
    if op == "escape":
        library = ctypes.CDLL("libapparmor.so.1", use_errno=True)
        library.aa_change_profile.argtypes = [ctypes.c_char_p]
        attempts = {}
        bootstrap = next(part for part in profile.split("//&") if part.endswith("_boot"))
        for name in ("unconfined", bootstrap):
            ctypes.set_errno(0)
            code = library.aa_change_profile(name.encode())
            attempts[name] = {"code": code, "errno": ctypes.get_errno()}
        libc = ctypes.CDLL(None, use_errno=True)
        ctypes.set_errno(0)
        code = libc.unshare(0x10000000)  # CLONE_NEWUSER, not a global setting.
        return {"change_profile": attempts,
                "new_user_namespace": {"code": code, "errno": ctypes.get_errno()},
                "identity": identity()}
    if op == "interrupt":
        signals = []
        previous = signal.signal(signal.SIGINT, lambda number, frame: signals.append(number))
        child = subprocess.Popen(["/bin/sleep", "30"])
        emit(event="interrupt_ready", id=request["id"], child_pid=child.pid,
             child_pgid=os.getpgid(child.pid), identity=identity())
        try:
            code = child.wait(timeout=8)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=3)
            signal.signal(signal.SIGINT, previous)
        return {"returncode": code, "signals": signals, "identity": identity()}
    if op == "identity":
        return identity()
    raise ValueError("unknown synthetic operation")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    arguments = parser.parse_args()
    actual = identity()
    if actual["label"] != arguments.profile + " (enforce)":
        raise RuntimeError("worker did not inherit exact enforcing profile")
    work = next(part for part in arguments.profile.split("//&") if part.endswith("_work"))
    Path(".dynamic-worker-started-" + work).write_text(arguments.profile)
    emit(event="ready", identity=actual)
    for line in sys.stdin:
        request = json.loads(line)
        if request["op"] == "exit":
            emit(event="bye", id=request["id"], identity=identity())
            return 0
        try:
            value = operations(request, arguments.profile)
            emit(event="result", id=request["id"], value=value)
        except Exception as error:
            emit(event="operation_error", id=request.get("id"), error=repr(error))
    raise RuntimeError("unexpected input EOF before explicit exit")


if __name__ == "__main__":
    sys.exit(main())
