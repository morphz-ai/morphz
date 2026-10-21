#!/usr/bin/python3
"""Fixed isolated Linux processes for caller-identity acceptance, not a daemon.

System Python is an explicitly test-only trusted executable here. A production
registry must contain the installed Runtime/launcher, never an interpreter.
"""

import argparse
import array
from dataclasses import asdict
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from peer import PeerError, TrustedExecutables, authorize, configure_listener, receive_frame  # noqa: E402


def client(path, mode):
    if os.getuid() == 0:
        raise PermissionError("fixed client must not run as root")
    with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as connection:
        connection.settimeout(8)
        connection.connect(path)
        if mode == "inherited":
            child = os.fork()
            if child:
                _, status = os.waitpid(child, 0)
                if os.waitstatus_to_exitcode(status):
                    raise RuntimeError("inherited client failed")
                return
        body = b'{"pid":1,"uid":0,"role":"administrator"}'  # never identity authority
        if mode == "rights":
            descriptor = os.open("/dev/null", os.O_RDONLY)
            try:
                connection.sendmsg([body], [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                                             array.array("i", [descriptor]))])
            finally:
                os.close(descriptor)
        else:
            connection.send(body)
        if mode != "exited":
            connection.recv(32)
        if mode == "inherited":
            os._exit(0)


def execute(args):
    if (sys.platform != "linux" or os.geteuid() != 0 or args.uid <= 0 or args.gid <= 0 or
            os.environ.get("MORPHZ_LINUX_SANDBOX_TEST") != "1"):
        raise PermissionError("explicit isolated Linux administrator invocation required")
    output = args.output.absolute()
    if output.parent.resolve(strict=True) != output.parent:
        raise ValueError("evidence parent must already exist without symlinks")
    output.mkdir(mode=0o755)
    os.chmod(output, 0o755)
    trusted = output / "trusted"
    trusted.mkdir(mode=0o755)
    for name in ("policy.py", "peer.py", "peer_kernel_contract.py"):
        shutil.copyfile(Path(__file__).parent / name, trusted / name)
        os.chmod(trusted / name, 0o444)
    python = str(Path("/usr/bin/python3").resolve(strict=True))
    record = {"scope": "kernel-peer-authentication-only", "cases": []}

    def save():
        (output / "result.json").write_text(json.dumps(record, indent=2) + "\n")

    try:
        with TrustedExecutables([python]) as registry, TrustedExecutables(["/usr/bin/true"]) as wrong_role:
            cases = ("live", "wrong-executable", "wrong-label", "inherited", "rights", "exited")
            for mode in cases:
                process = None
                frame = None
                path = output / f"{mode}.sock"
                detail = {"case": mode}
                record["cases"].append(detail)
                with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as listener:
                    configure_listener(listener)
                    listener.settimeout(8)
                    listener.bind(str(path))
                    os.chmod(path, 0o666)
                    listener.listen(1)
                    process = subprocess.Popen([
                        "/usr/bin/setpriv", "--reuid", str(args.uid), "--regid", str(args.gid),
                        "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all", "--",
                        python, "-I", "-B", str(trusted / "peer_kernel_contract.py"),
                        "--client", str(path), "--mode", mode,
                    ], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                        env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
                    try:
                        if mode == "exited":
                            process.wait(timeout=8)
                        connection, _ = listener.accept()
                        with connection:
                            connection.settimeout(8)
                            descriptors_before = len(list(Path("/proc/self/fd").iterdir()))
                            try:
                                frame = receive_frame(connection)
                                identity = authorize(frame, wrong_role if mode == "wrong-executable" else registry,
                                                     labels=("not-the-runtime-label",) if mode == "wrong-label"
                                                     else ("unconfined",))
                                detail["identity"] = asdict(identity)
                                if mode != "live" or identity.uid != args.uid or identity.pid != process.pid:
                                    raise AssertionError("a negative client gained authority or the real PID/UID was lost")
                                if identity != authorize(frame, registry):
                                    raise AssertionError("same live caller did not revalidate")
                            except PeerError as error:
                                detail["refusal"] = str(error)
                                if mode == "live":
                                    raise
                            finally:
                                if frame is not None:
                                    frame.close()
                                try:
                                    connection.send(b"DONE")
                                except BrokenPipeError:
                                    if mode != "exited":
                                        raise
                            detail["descriptors_after"] = len(list(Path("/proc/self/fd").iterdir()))
                            if descriptors_before != detail["descriptors_after"]:
                                raise AssertionError("received pidfd or rejected rights leaked")
                        stdout, stderr = process.communicate(timeout=8)
                        detail.update(code=process.returncode, stdout=stdout, stderr=stderr)
                        if process.returncode != 0:
                            raise AssertionError("fixed client failed before its expected boundary")
                        detail["passed"] = True
                        save()
                    finally:
                        if frame is not None:
                            frame.close()
                        if process is not None and process.poll() is None:
                            process.terminate()
                            process.wait(timeout=8)
                        path.unlink(missing_ok=True)
        record["ok"] = True
    except BaseException as error:
        record["ok"] = False
        record["error"] = repr(error)
        raise
    finally:
        save()
    print(json.dumps({"ok": record["ok"], "cases": len(record["cases"]), "scope": record["scope"]}))


if __name__ == "__main__":
    cli = argparse.ArgumentParser()
    cli.add_argument("--client")
    cli.add_argument("--mode")
    cli.add_argument("--uid", type=int, default=0)
    cli.add_argument("--gid", type=int, default=0)
    cli.add_argument("--output", type=Path)
    arguments = cli.parse_args()
    if arguments.client:
        client(arguments.client, arguments.mode)
    elif arguments.output is not None:
        execute(arguments)
    else:
        cli.error("explicit isolated evidence directory is required")
