#!/usr/bin/python3
"""Distribution bwrap + native mount admission on isolated synthetic data.

This exercises the same native mount primitives intended for the launcher. It
does not substitute for service authentication, cgroup lifetime or Runtime tests.
"""
import argparse
import errno
import json
import os
from pathlib import Path
import select
import shutil
import socket
import subprocess
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))


def worker():
    print(json.dumps({"ready": True, "uid": os.getuid()}), flush=True)
    for line in sys.stdin:
        command = json.loads(line)
        try:
            if command["op"] == "exit":
                return
            if command["op"] == "fds":
                value = []
                for path in Path("/proc/self/fd").iterdir():
                    if int(path.name) <= 2:
                        continue
                    try:
                        value.append(os.readlink(path))
                    except FileNotFoundError:
                        pass  # the directory enumeration handle is now closed
            elif command["op"] == "read":
                value = Path(command["path"]).read_text()
            elif command["op"] == "write":
                Path(command["path"]).write_text("worker-written")
                value = "written"
            elif command["op"] == "tty":
                fd = os.open("/dev/tty", os.O_RDONLY | os.O_CLOEXEC)
                os.close(fd)
                value = True
            elif command["op"] == "boundary":
                value = {name: Path("/proc/self/" + name).read_text()
                         for name in ("status", "mountinfo")}
            else:
                raise ValueError("unknown fixed worker operation")
            result = {"ok": True, "value": value}
        except OSError as error:
            result = {"ok": False, "errno": error.errno}
        print(json.dumps(result), flush=True)


def execute(args):
    if (sys.platform != "linux" or os.getuid() != 0 or args.uid <= 0 or args.gid <= 0 or
            os.environ.get("MORPHZ_LINUX_SANDBOX_TEST") != "1"):
        raise PermissionError("explicit isolated Linux administrator invocation required")
    # The copied unprivileged worker does not carry or use the privileged-side
    # policy compiler. Import it only in the administrator fixture branch.
    from policy import ABI, Policy, compile_profiles
    output = args.output.absolute()
    if output.parent.resolve(strict=True) != output.parent:
        raise ValueError("evidence parent must be a real existing directory")
    output.mkdir(mode=0o755)
    trusted = output / "trusted"
    trusted.mkdir(mode=0o755)
    shutil.copyfile(__file__, trusted / "worker.py")
    os.chmod(trusted / "worker.py", 0o444)
    subprocess.run(["/usr/bin/cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2",
                    str(Path(__file__).parent / "mounts.c"),
                    str(Path(__file__).parent / "mount_kernel_entry.c"),
                    "-o", str(trusted / "entry"), "-ljson-c", "-lapparmor"], check=True, timeout=30)
    record = {"scope": "native-pinned-mount-admission", "assertions": [], "launches": []}

    def save():
        (output / "result.json").write_text(json.dumps(record, indent=2) + "\n")

    def check(name, condition, detail=None):
        record["assertions"].append({"name": name, "passed": bool(condition), "detail": detail})
        save()
        if not condition:
            raise AssertionError(name)

    def host_file(path, content="host-written"):
        path.write_text(content)
        os.chmod(path, 0o600)
        os.chown(path, args.uid, args.gid)

    def launch(name, wrong_identity=False, replace_after_pin=False, mount_regression=False):
        stage = output / name
        stage.mkdir(mode=0o755)
        workspace, reference = stage / "workspace", stage / "reference"
        for path in (workspace, reference):
            path.mkdir(mode=0o700)
            os.chown(path, args.uid, args.gid)
            host_file(path / "ordinary")
        protected = workspace / "future.env"
        policy = Policy.from_request({
            "abi": ABI, "mode": "exec", "cwd": str(workspace),
            "read_roots": [str(reference), str(trusted)], "write_roots": [str(workspace)],
            "denied_read_paths": [str(protected)], "denied_write_paths": [str(protected)],
            "denied_read_patterns": [], "denied_write_patterns": [], "network": "deny",
            "hidden_roots": ["/home", "/tmp"],
        })
        compiled = compile_profiles(policy, uuid.uuid4().hex)
        source = stage / "profile.apparmor"
        source.write_text(compiled.source)
        roots = []
        for path, writable in ((workspace, True), (reference, False), (trusted, False)):
            info = path.stat()
            roots.append({"path": str(path), "writable": writable,
                          "device": info.st_dev, "inode": info.st_ino})
        if wrong_identity:
            roots[0]["inode"] += 1
        manifest = stage / "manifest.json"
        manifest.write_text(json.dumps({"uid": args.uid, "gid": args.gid,
            "bootstrap": compiled.bootstrap, "work": compiled.work,
            "cwd": str(workspace), "roots": roots, "hidden": ["/home", "/tmp"],
            "entry": str(trusted / "entry"), "worker": str(trusted / "worker.py")}, separators=(",", ":")))
        os.chmod(manifest, 0o444)
        observation = {"name": name, "profiles": [compiled.bootstrap, compiled.work], "cleanup": False}
        record["launches"].append(observation)
        process = None
        loaded = False
        test_mounts = []
        host, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        # Manifest always occupies slot 3 in the fixed native test driver.
        if child.fileno() < 4:
            raise AssertionError("test control FD unexpectedly overlaps manifest")
        host.settimeout(12)
        stderr = (stage / "stderr.log").open("w")
        try:
            if mount_regression:
                # A real read-only submount inside a writable grant must stay
                # read-only. An inaccessible rw host submount must be sealed,
                # not excused because per-path remount traversal gets EACCES.
                nested = workspace / "readonly-child"
                nested.mkdir()
                subprocess.run(["/usr/bin/mount", "--bind", str(reference), str(nested)], check=True)
                test_mounts.append(nested)
                subprocess.run(["/usr/bin/mount", "-o", "remount,bind,ro", str(nested)], check=True)
                opaque = stage / "root-only"
                opaque.mkdir(mode=0o700)
                inaccessible = opaque / "data"
                inaccessible.mkdir()
                subprocess.run(["/usr/bin/mount", "-t", "tmpfs", "tmpfs", str(inaccessible)], check=True)
                test_mounts.append(inaccessible)
            parser = subprocess.run(["/usr/sbin/apparmor_parser", "--add", "--skip-cache", str(source)],
                                    text=True, capture_output=True, check=False, timeout=20)
            observation["parser"] = {"code": parser.returncode, "stderr": parser.stderr}
            save()
            if parser.returncode:
                raise RuntimeError(parser.stderr)
            loaded = True
            command = ["/usr/bin/setpriv", "--reuid", str(args.uid), "--regid", str(args.gid),
                       "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all",
                       "--", "/usr/bin/aa-exec", "-p", compiled.bootstrap, "--", str(trusted / "entry"),
                       "--outer", str(child.fileno()), str(manifest)]
            process = subprocess.Popen(command, pass_fds=(child.fileno(),), stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=stderr, text=True, bufsize=1, cwd=workspace,
                env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
            child.close()
            check(name + ": non-root caller pins objects before namespace setup", host.recv(32) == b"PIN")
            original = workspace
            if replace_after_pin:
                original = stage / "original-renamed"
                workspace.rename(original)
                workspace.mkdir(mode=0o700)
                os.chown(workspace, args.uid, args.gid)
                host_file(workspace / "ordinary", "replacement-not-authorized")
            host.send(b"G")
            admission = host.recv(32)
            if wrong_identity:
                code = process.wait(timeout=12)
                check(name + ": wrong mounted object never reaches work or readiness",
                      admission == b"" and code == 78 and process.stdout.read() == "")
                return
            check(name + ": mapped roots, privileges and exact work stack admitted", admission == b"READY", admission.decode())

            def receive():
                if not select.select([process.stdout], [], [], 8)[0]:
                    raise TimeoutError("fixed worker response")
                line = process.stdout.readline(16385)
                if not line or len(line) > 16384:
                    raise RuntimeError("fixed worker exited or exceeded response bound")
                return json.loads(line)

            def action(operation, path=None):
                process.stdin.write(json.dumps({"op": operation, "path": str(path) if path else None}) + "\n")
                process.stdin.flush()
                return receive()

            check(name + ": protected file absent when work becomes ready", receive().get("ready") and not protected.exists())
            check(name + ": no root, manifest or control descriptors reach work", action("fds") == {"ok": True, "value": []})
            boundary = action("boundary")
            check(name + ": work can inspect its own kernel boundary", boundary.get("ok") is True)
            security = dict(line.split(":", 1) for line in boundary["value"]["status"].splitlines() if ":" in line)
            check(name + ": no setup capability survives in any set", all(int(security[key], 16) == 0
                  for key in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")))
            table = boundary["value"]["mountinfo"]
            check(name + ": all mounts are private", not any(tag in table for tag in ("shared:", "master:", "propagate_from:")))
            if mount_regression:
                denied = action("write", nested / "ordinary")
                check(name + ": existing readonly child is never reopened writable", denied.get("ok") is False and denied.get("errno") == errno.EROFS, denied)
                entries = [line.split() for line in table.splitlines() if line.split()[4] == str(inaccessible)]
                check(name + ": inaccessible host data submount is sealed readonly", len(entries) == 1 and "ro" in entries[0][5].split(","), entries)
            check(name + ": original pinned directory, never same-name replacement", action("read", workspace / "ordinary") == {"ok": True, "value": "host-written"})
            host_file(original / "future.env")
            denied = action("read", protected)
            check(name + ": file created by host after ready is denied", denied.get("ok") is False and denied.get("errno") in (errno.EACCES, errno.EPERM), denied)
            check(name + ": allowed writes reach the original host object", action("write", workspace / "ordinary").get("ok") is True and (original / "ordinary").read_text() == "worker-written")
            host_file(original / "live", "live-host-update")
            check(name + ": host updates remain immediately readable", action("read", workspace / "live") == {"ok": True, "value": "live-host-update"})
            check(name + ": read-only root remains readable", action("read", reference / "ordinary").get("ok") is True)
            denied = action("write", reference / "ordinary")
            check(name + ": read-only root refuses mutation", denied.get("ok") is False and denied.get("errno") in (errno.EROFS, errno.EACCES, errno.EPERM), denied)
            check(name + ": ordinary exec has no inherited controlling terminal", action("tty").get("ok") is False)
            process.stdin.write('{"op":"exit"}\n')
            process.stdin.flush()
            check(name + ": worker exits normally", process.wait(timeout=8) == 0)
        finally:
            child.close()
            host.close()
            if process is not None and process.poll() is None:
                process.terminate()
                process.wait(timeout=8)
            stderr.close()
            for path in reversed(test_mounts):
                subprocess.run(["/usr/bin/umount", str(path)], check=True, timeout=10)
            if loaded:
                # The fixed worker never forks; bwrap's PID namespace dies with
                # this fixed process. Production lifetime uses a separate gate.
                removed = subprocess.run(["/usr/sbin/apparmor_parser", "--remove", "--skip-cache", str(source)],
                    text=True, capture_output=True, timeout=20, check=False)
                observation["cleanup"] = removed.returncode == 0
                observation["remove_stderr"] = removed.stderr
                if removed.returncode:
                    raise RuntimeError(removed.stderr)
            save()

    try:
        record["kernel"] = os.uname().release
        record["bwrap"] = subprocess.run(["/usr/bin/bwrap", "--version"], text=True, capture_output=True, check=True).stdout.strip()
        launch("normal")
        launch("nested-readonly-and-inaccessible-submounts", mount_regression=True)
        launch("root-replaced-after-pin", replace_after_pin=True)
        launch("wrong-mounted-identity", wrong_identity=True)
        record["ok"] = True
    except BaseException as error:
        record.update(ok=False, error=repr(error))
        raise
    finally:
        journal = subprocess.run(["/usr/bin/journalctl", "--dmesg", "--since=-5min", "--no-pager"],
                                 capture_output=True, text=True, check=False, timeout=15)
        record["kernel_denials"] = [line for line in journal.stdout.splitlines()
                                    if "apparmor=" in line and "morphz_sbox_v1_" in line]
        save()
    print(json.dumps({"ok": True, "scope": record["scope"], "assertions": len(record["assertions"])}))


if __name__ == "__main__":
    cli = argparse.ArgumentParser()
    cli.add_argument("--worker", action="store_true")
    cli.add_argument("--uid", type=int)
    cli.add_argument("--gid", type=int)
    cli.add_argument("--output", type=Path)
    arguments = cli.parse_args()
    if arguments.worker:
        worker()
    else:
        execute(arguments)
