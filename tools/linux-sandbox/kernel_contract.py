#!/usr/bin/python3
"""Isolated kernel acceptance for the policy compiler, not a Runtime launcher.

The administrator half only loads unique synthetic profiles and starts this
fixed worker under a non-root UID. No user book, production node, shell text,
or Runtime state is an input. This does not test mount or caller authentication.
"""

import argparse
import ctypes
import errno
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
from policy import ABI, Policy, compile_profiles  # noqa: E402


def worker(bootstrap, work):
    if os.getuid() == 0 or os.geteuid() == 0:
        raise PermissionError("kernel worker must never run as root")
    apparmor = ctypes.CDLL("libapparmor.so.1", use_errno=True)
    for name, label in (("aa_change_profile", bootstrap), ("aa_stack_profile", work)):
        function = getattr(apparmor, name)
        function.argtypes = (ctypes.c_char_p,)
        function.restype = ctypes.c_int
        if function(label.encode()) != 0:
            raise OSError(ctypes.get_errno(), name)
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = (ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong)
    libc.prctl.restype = ctypes.c_int
    if libc.prctl(38, 1, 0, 0, 0):  # PR_SET_NO_NEW_PRIVS
        raise OSError(ctypes.get_errno(), "NoNewPrivs")
    label = Path("/proc/self/attr/current").read_text().strip()
    if label not in (f"{bootstrap}//&{work} (enforce)", f"{work}//&{bootstrap} (enforce)"):
        raise PermissionError("not the exact enforcing two-profile stack")
    state = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines()
                 if ":" in line)
    if state["NoNewPrivs"].strip() != "1" or any(
        int(state[field].strip(), 16) != 0 for field in ("CapEff", "CapPrm", "CapInh", "CapAmb")
    ):
        raise PermissionError("worker capabilities were not dropped")
    print(json.dumps({"ready": True, "label": label, "uid": os.getuid()}), flush=True)
    for line in sys.stdin:
        action = json.loads(line)
        if action["operation"] == "exit":
            return
        try:
            operation, path = action["operation"], action["path"]
            if operation == "read":
                with open(path, "rb") as stream:
                    value = stream.read(256).decode("utf-8")
            elif operation == "readat":
                directory = os.open(str(Path(path).parent), os.O_RDONLY | os.O_DIRECTORY)
                try:
                    descriptor = os.open(Path(path).name, os.O_RDONLY, dir_fd=directory)
                    with os.fdopen(descriptor, "rb") as stream:
                        value = stream.read(256).decode("utf-8")
                finally:
                    os.close(directory)
            elif operation == "write":
                with open(path, "wb") as stream:
                    stream.write(b"worker-written")
                value = "written"
            elif operation == "rename":
                os.rename(path, action["destination"])
                value = "renamed"
            else:
                raise ValueError("unregistered fixed test operation")
            answer = {"ok": True, "value": value}
        except OSError as error:
            answer = {"ok": False, "errno": error.errno}
        print(json.dumps(answer), flush=True)


def execute(args):
    if (sys.platform != "linux" or os.geteuid() != 0 or
            os.environ.get("MORPHZ_LINUX_SANDBOX_TEST") != "1" or args.uid <= 0 or args.gid <= 0):
        raise PermissionError("explicit isolated Linux administrator invocation required")
    output = args.output.absolute()
    if output.parent.resolve(strict=True) != output.parent:
        raise ValueError("evidence parent must be a real, existing directory")
    output.mkdir(mode=0o755)  # exclusive: never overwrite a previous run
    os.chmod(output, 0o755)
    workspace = output / "workspace"
    workspace.mkdir(mode=0o700)
    os.chown(workspace, args.uid, args.gid)
    trusted = output / "trusted"
    trusted.mkdir(mode=0o755)
    for name in ("kernel_contract.py", "policy.py"):
        shutil.copyfile(Path(__file__).parent / name, trusted / name)
        os.chmod(trusted / name, 0o444)
    record = {"scope": "compiler-and-kernel-only", "assertions": [], "cleanup": False}
    process = None
    loaded = False
    source = output / "profiles.apparmor"
    stderr = None

    def save():
        (output / "result.json").write_text(json.dumps(record, ensure_ascii=True, indent=2) + "\n")

    def check(name, condition, actual):
        record["assertions"].append({"name": name, "passed": bool(condition), "actual": actual})
        save()
        if not condition:
            raise AssertionError(name)

    def parser(operation):
        result = subprocess.run(["/usr/sbin/apparmor_parser", operation, "--skip-cache", str(source)],
                                text=True, capture_output=True, timeout=20, check=False)
        record.setdefault("parser", []).append({"operation": operation, "code": result.returncode,
                                               "stdout": result.stdout, "stderr": result.stderr})
        save()
        if result.returncode:
            raise RuntimeError(f"AppArmor {operation} failed: {result.stderr}")

    def receive():
        if not select.select([process.stdout], [], [], 8)[0]:
            raise TimeoutError("fixed worker did not respond")
        line = process.stdout.readline(16385)
        if not line or len(line) > 16384:
            raise RuntimeError("fixed worker exited or exceeded its response bound")
        return json.loads(line)

    def action(operation, path, **extra):
        process.stdin.write(json.dumps({"operation": operation, "path": str(path), **extra}) + "\n")
        process.stdin.flush()
        return receive()

    def denied(name, operation, path, **extra):
        answer = action(operation, path, **extra)
        check(name, answer.get("ok") is False and answer.get("errno") in (errno.EACCES, errno.EPERM), answer)

    def allowed(name, operation, path):
        answer = action(operation, path)
        check(name, answer.get("ok") is True, answer)

    def host_file(path, content="host-written"):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        os.chmod(path, 0o600)
        os.chown(path, args.uid, args.gid)
        parent = path.parent
        while parent != workspace.parent:
            os.chown(parent, args.uid, args.gid)
            parent = parent.parent

    try:
        record["environment"] = {
            "kernel": os.uname().release,
            "apparmor": subprocess.run(["/usr/sbin/apparmor_parser", "--version"],
                                       text=True, capture_output=True, check=True).stdout,
            "enabled": Path("/sys/module/apparmor/parameters/enabled").read_text().strip(),
        }
        names = ["plain", "space name", "目录中文", 'quote"name', "slash\\name", "star*name",
                 "question?name", "set[ab]name", "brace{a,b}name", "caret^name", "@{HOME}name",
                 "line\nname", "tab\tname", "return\rname"]
        protected = [workspace / ("deny-" + name) for name in names]
        read_denied, write_denied = workspace / "read-denied", workspace / "write-denied"
        nested = workspace / "parent" / "nested" / ".env"
        policy = Policy.from_request({
            "abi": ABI, "mode": "exec", "cwd": str(workspace),
            "read_roots": [str(workspace)], "write_roots": [str(workspace)],
            "denied_read_paths": [str(path) for path in (*protected, read_denied, nested)],
            "denied_write_paths": [str(path) for path in (*protected, write_denied, nested)],
            "denied_read_patterns": [], "denied_write_patterns": [], "network": "deny",
        })
        compiled = compile_profiles(policy, uuid.uuid4().hex)
        source.write_text(compiled.source)
        record["policy_hash"] = compiled.policy_hash
        record["profiles"] = [compiled.bootstrap, compiled.work]
        parser("--add")
        loaded = True
        stderr = (output / "worker-stderr.log").open("w")
        process = subprocess.Popen([
            "/usr/bin/setpriv", "--reuid", str(args.uid), "--regid", str(args.gid), "--clear-groups",
            "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all", "--",
            "/usr/bin/python3", "-I", "-B", str(trusted / "kernel_contract.py"), "--worker",
            "--bootstrap", compiled.bootstrap, "--work", compiled.work,
        ], text=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, bufsize=1,
            cwd=workspace, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
        ready = receive()
        check("real non-root enforcing stack is ready before host creates any protected leaf",
              ready.get("ready") is True and ready.get("uid") == args.uid and
              all(not path.exists() for path in (*protected, nested)), ready)
        for path in (*protected, nested, read_denied, write_denied):
            host_file(path)
        for index, path in enumerate(protected):
            denied(f"literal-{index}-future-read", "read", path)
            denied(f"literal-{index}-future-write", "write", path)
            denied(f"literal-{index}-openat", "readat", path)
            sibling = path.with_name(path.name + "-allowed")
            host_file(sibling)
            allowed(f"literal-{index}-sibling-read", "read", sibling)
            allowed(f"literal-{index}-sibling-write", "write", sibling)
        # A metacharacter must not accidentally become a wildcard in a deny rule.
        for name in ("deny-starANYname", "deny-questionXname", "deny-setaname", "deny-braceaname"):
            path = workspace / name
            host_file(path)
            allowed(f"not-a-pattern-{name}", "read", path)
        denied("missing parent created after readiness", "read", nested)
        denied("renaming protected ancestor is rejected", "rename", nested.parent.parent,
               destination=str(workspace / "moved-parent"))
        denied("read-only denial blocks reads", "read", read_denied)
        allowed("read-only denial does not invent write denial", "write", read_denied)
        allowed("write-only denial preserves reads", "read", write_denied)
        denied("write-only denial blocks writes", "write", write_denied)
        alias = workspace / "alias-to-protected"
        alias.symlink_to(protected[0])
        denied("symlink resolves to protected target", "read", alias)
        replacement = workspace / "replacement"
        host_file(replacement, "replaced")
        replacement.replace(protected[0])
        denied("host atomic replacement remains denied", "read", protected[0])
        protected[0].unlink()
        host_file(protected[0], "recreated")
        denied("host delete and recreate remains denied", "read", protected[0])
        process.stdin.write('{"operation":"exit"}\n')
        process.stdin.flush()
        check("worker exits normally", process.wait(timeout=8) == 0, process.returncode)
        record["ok"] = True
    except BaseException as error:
        record["ok"] = False
        record["error"] = repr(error)
        raise
    finally:
        if process is not None and process.poll() is None:
            process.terminate()
            process.wait(timeout=8)
        if stderr is not None:
            stderr.close()
        # This fixed worker never forks. This is not the production service's
        # cgroup-based lifetime proof and cannot be substituted for that gate.
        if loaded and (process is None or process.poll() is not None):
            parser("--remove")
            record["cleanup"] = True
        save()
    print(json.dumps({"ok": record["ok"], "assertions": len(record["assertions"]),
                      "evidence": str(output), "scope": record["scope"]}))


if __name__ == "__main__":
    cli = argparse.ArgumentParser()
    cli.add_argument("--worker", action="store_true")
    cli.add_argument("--bootstrap")
    cli.add_argument("--work")
    cli.add_argument("--uid", type=int, default=0)
    cli.add_argument("--gid", type=int, default=0)
    cli.add_argument("--output", type=Path)
    arguments = cli.parse_args()
    if arguments.worker:
        worker(arguments.bootstrap, arguments.work)
    elif arguments.output is not None:
        execute(arguments)
    else:
        cli.error("an explicit isolated evidence directory is required")
