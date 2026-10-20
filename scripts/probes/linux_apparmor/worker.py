#!/usr/bin/env python3
"""Synthetic child for the isolated AppArmor experiment; not a Runtime backend."""

import argparse
import ctypes
import errno
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


PREFIX = "MORPHZ_PROBE_JSON "
WORK = Path("/probe/work")


def emit(kind, **values):
    print(PREFIX + json.dumps({"kind": kind, **values}, sort_keys=True), flush=True)


def label():
    return Path("/proc/self/attr/current").read_text().strip()


def status():
    data = Path("/proc/self/status").read_text()
    return {
        key: next(line.split(":", 1)[1].strip() for line in data.splitlines()
                  if line.startswith(key + ":"))
        for key in ("NoNewPrivs", "CapEff", "CapPrm", "CapAmb")
    }


def read_file(path):
    try:
        return {"ok": True, "bytes_hex": path.read_bytes().hex()}
    except OSError as error:
        return {"ok": False, "errno": error.errno, "error": str(error)}


def do_action(action):
    operation = action["op"]
    if operation == "read":
        return read_file(WORK / action["path"])
    if operation == "write":
        try:
            (WORK / action["path"]).write_text(action["text"])
            return {"ok": True}
        except OSError as error:
            return {"ok": False, "errno": error.errno, "error": str(error)}
    if operation == "rename":
        try:
            (WORK / action["source"]).rename(WORK / action["target"])
            return {"ok": True}
        except OSError as error:
            return {"ok": False, "errno": error.errno, "error": str(error)}
    if operation == "hardlink":
        try:
            os.link(WORK / action["source"], WORK / action["target"])
            return {"ok": True}
        except OSError as error:
            return {"ok": False, "errno": error.errno, "error": str(error)}
    if operation == "cat":
        result = subprocess.run(
            ["/bin/cat", str(WORK / action["path"])],
            capture_output=True, timeout=5, check=False,
        )
        return {
            "returncode": result.returncode,
            "stdout_hex": result.stdout.hex(),
            "stderr": result.stderr.decode(errors="replace"),
        }
    if operation == "escape":
        library = ctypes.CDLL("libapparmor.so.1", use_errno=True)
        library.aa_change_profile.argtypes = [ctypes.c_char_p]
        library.aa_change_profile.restype = ctypes.c_int
        ctypes.set_errno(0)
        result = library.aa_change_profile(b"unconfined")
        return {"returncode": result, "errno": ctypes.get_errno(), "label": label()}
    if operation == "namespace":
        # No external helper, setuid fallback or added capability is permitted.
        library = ctypes.CDLL(None, use_errno=True)
        library.unshare.argtypes = [ctypes.c_int]
        library.unshare.restype = ctypes.c_int
        ctypes.set_errno(0)
        result = library.unshare(0x10000000)  # CLONE_NEWUSER
        return {"returncode": result, "errno": ctypes.get_errno(), "label": label()}
    if operation == "interrupt":
        interrupts = []
        previous = signal.signal(
            signal.SIGINT, lambda signum, _frame: interrupts.append(signum)
        )
        started = time.monotonic()
        try:
            child = subprocess.Popen(["/bin/sleep", "30"])
            emit("interrupt_ready", id=action["id"], child_pid=child.pid)
            try:
                code = child.wait(timeout=8)
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait()
            return {
                "returncode": code,
                "received_sigint": bool(interrupts),
                "elapsed": time.monotonic() - started,
            }
        finally:
            signal.signal(signal.SIGINT, previous)
    raise ValueError(f"unknown synthetic operation: {operation}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--expect-label", required=True)
    arguments = parser.parse_args()
    observed = label()
    # This check happens before any synthetic payload or ready signal. A missing,
    # complain, stacked, or otherwise unexpected profile is not accepted.
    if observed != arguments.expect_label:
        emit("admission_rejected", expected=arguments.expect_label, actual=observed)
        return 78
    security = status()
    if security["NoNewPrivs"] != "1" or any(
        int(security[key], 16) for key in ("CapEff", "CapPrm", "CapAmb")
    ):
        emit("admission_rejected", status=security)
        return 78
    try:
        tty = os.open("/dev/tty", os.O_RDWR | os.O_NOCTTY)
        os.close(tty)
        controlling_tty = True
    except OSError as error:
        controlling_tty = False
        if error.errno not in (errno.ENXIO, errno.ENODEV, errno.ENOENT):
            raise
    emit(
        "ready", label=observed, status=security, isatty=os.isatty(0),
        controlling_tty=controlling_tty, pid=os.getpid(), pgrp=os.getpgrp(),
        session=os.getsid(0),
    )
    for line in sys.stdin:
        action = json.loads(line)
        if action["op"] == "exit":
            emit("bye")
            return 0
        try:
            result = do_action(action)
        except Exception as error:
            emit("worker_error", id=action["id"], error=repr(error))
            return 1
        emit("result", id=action["id"], **result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
