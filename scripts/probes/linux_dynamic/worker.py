"""Finite synthetic workload; never a production command execution interface."""

import argparse
import ctypes
import errno
import json
import os
from pathlib import Path
import signal
import socket
import stat
import subprocess
import sys
import traceback

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


def unix_boundary(name):
    if not isinstance(name, str) or not name.startswith("morphz-dynamic-") or not name.replace("-", "").isalnum():
        raise ValueError("only generated synthetic abstract socket names")
    phase = "create"
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
            peer.settimeout(2)
            phase = "connect"
            peer.connect("\0" + name)
            phase = "send"
            peer.sendall(b"DYNAMIC_UNIX_SYNTHETIC\n")
        abstract = {"ok": True, "phase": phase}
    except OSError as error:
        abstract = {"ok": False, "phase": phase, "errno": error.errno, "error": str(error)}
    phase, pair = "socketpair", None
    try:
        pair = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        phase = "send"
        pair[0].send(b"DYNAMIC_ANONYMOUS_SYNTHETIC\n")
        phase = "receive"
        pair[1].settimeout(2)
        value = pair[1].recv(64)
        anonymous = {"ok": True, "phase": phase, "received": value.decode()}
    except OSError as error:
        anonymous = {"ok": False, "phase": phase, "errno": error.errno, "error": str(error)}
    finally:
        if pair is not None:
            for peer in pair:
                peer.close()
    return {"abstract": abstract, "anonymous": anonymous}


def socket_type_evidence(fd):
    """Inspect the existing descriptor without opening, duplicating or closing it."""
    library = ctypes.CDLL(None, use_errno=True)
    operation = library.getsockopt
    operation.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int,
                          ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint)]
    operation.restype = ctypes.c_int
    value = ctypes.c_int(-1)
    length = ctypes.c_uint(ctypes.sizeof(value))
    ctypes.set_errno(0)
    result = operation(fd, socket.SOL_SOCKET, socket.SO_TYPE,
                       ctypes.byref(value), ctypes.byref(length))
    error = ctypes.get_errno() if result != 0 else 0
    if result == 0 and length.value != ctypes.sizeof(value):
        raise RuntimeError("unexpected SO_TYPE result size")
    return {"result": result, "errno": error, "socket_type": value.value if result == 0 else None}


def descriptor_identity(fd):
    try:
        info = os.fstat(fd)
        return {"fd": fd, "dev": info.st_dev,
                "ino": info.st_ino, "kind": stat.S_IFMT(info.st_mode)}
    except OSError as error:
        diagnostic = {"fd": fd, "fstat_errno": error.errno}
        # A denied metadata read is not proof of absence. Only an independent
        # ENOTSOCK result excludes this descriptor from an injected SOCKET
        # target. A real socket with unreadable identity must still fail.
        if error.errno == errno.EACCES:
            try:
                evidence = socket_type_evidence(fd)
                diagnostic["so_type"] = evidence
            except Exception as inspection_error:
                evidence = None
                diagnostic["so_type_error"] = repr(inspection_error)
            if evidence == {"result": -1, "errno": errno.ENOTSOCK, "socket_type": None}:
                return {"fd": fd, "kind": None, "proven_not_socket": True,
                        "inspection": diagnostic}
        error.fd_inspection = diagnostic
        raise


def inherited_fd_check(target, nonce):
    """Finite synthetic leak attempt, never a general FD write operation."""
    if (not isinstance(target, dict) or set(target) != {"dev", "ino"}
            or any(type(value) is not int or value <= 0 for value in target.values())
            or not isinstance(nonce, str) or not nonce.startswith("DYNAMIC_FD_")
            or len(nonce) != 44 or nonce[-1] != "\n"
            or any(char not in "0123456789abcdef" for char in nonce[11:-1])):
        raise ValueError("invalid synthetic inherited-socket target")
    rows, matching, attempts = [], [], []
    # Keep scandir's own descriptor alive throughout enumeration: no transient
    # closed directory FD can be mistaken for successful target absence.
    with os.scandir("/proc/self/fd") as entries:
        for entry in entries:
            if not entry.name.isdecimal():
                raise RuntimeError("unexpected proc FD entry")
            fd = int(entry.name)
            # Inspect the object, not its proc magic-link pathname. Keep denied
            # metadata diagnostics and require positive non-socket evidence.
            row = descriptor_identity(fd)
            rows.append(row)
            if (row.get("dev"), row.get("ino"), row["kind"]) == (
                    target["dev"], target["ino"], stat.S_IFSOCK):
                matching.append(row["fd"])
    for fd in matching:
        # If the chain leaks this exact inode (even under another FD number),
        # actively attempt nonce transmission. Presence alone already fails.
        duplicate = os.dup(fd)
        try:
            with socket.socket(fileno=duplicate) as peer:
                duplicate = None
                peer.settimeout(2)
                peer.sendall(nonce.encode())
                attempts.append({"fd": fd, "sent": True})
        except OSError as error:
            attempts.append({"fd": fd, "sent": False, "errno": error.errno, "error": str(error)})
        finally:
            if duplicate is not None:
                os.close(duplicate)
    return {"target": target, "fds": sorted(rows, key=lambda row: row["fd"]),
            "matching_fds": matching, "send_attempts": attempts}


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
    if op == "unix_boundary":
        return unix_boundary(request["name"])
    if op == "inherited_fd":
        return inherited_fd_check(request["target"], request["nonce"])
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
            emit(event="operation_error", id=request.get("id"), error=repr(error),
                 diagnostic={
                     "type": type(error).__name__, "errno": getattr(error, "errno", None),
                     "filename": getattr(error, "filename", None),
                     "filename2": getattr(error, "filename2", None),
                     "fd_inspection": getattr(error, "fd_inspection", None),
                     "traceback": "".join(traceback.format_exception(type(error), error, error.__traceback__)),
                 })
    raise RuntimeError("unexpected input EOF before explicit exit")


if __name__ == "__main__":
    sys.exit(main())
