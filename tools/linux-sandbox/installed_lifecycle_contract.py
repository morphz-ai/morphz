#!/usr/bin/python3
"""Isolated CI: actual installed systemd upgrade/rollback/drained uninstall.

This is destructive only to the disposable runner's explicitly installed CI
service. It never runs on a normal host and never adds arbitrary interpreters
to the Runtime allowlist. Production Runtime exec/PTY contracts run separately.
"""
import argparse
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from install import CONFIG, STATE, generation_config, read_trusted, start_service

FIXTURE = Path("/usr/local/libexec/morphz-sandbox-lifecycle-ci")
SOURCE = Path("/usr/local/libexec/morphz-sandbox-source-ci/linux-sandbox")
WORKER = '''import errno, json, os, sys
print(json.dumps({"ready": True, "pid": os.getpid()}), flush=True)
for line in sys.stdin:
    if line == "exit\\n":
        break
    if line != "probe\\n":
        raise RuntimeError("fixed synthetic operation only")
    def denied(path, flags):
        try:
            fd = os.open(path, flags)
        except OSError as error:
            return error.errno in (errno.EACCES, errno.EPERM, errno.EROFS)
        os.close(fd)
        return False
    secret = denied(".env", os.O_RDONLY)
    outside = denied("/usr/local/libexec/morphz-sandbox-lifecycle-ci/outside", os.O_WRONLY)
    with open("ordinary", "a") as stream:
        stream.write("worker\\n")
    print(json.dumps({"protected_denied": secret, "outside_denied": outside,
                      "allowed_write": True, "pid": os.getpid()}), flush=True)
'''


def main(args):
    if (sys.platform != "linux" or os.getresuid() != (0, 0, 0) or args.uid <= 0 or args.gid <= 0 or
            os.environ.get("MORPHZ_LINUX_SANDBOX_TEST") != "1"):
        raise PermissionError("explicit isolated Linux CI administrator fixture only")
    installed = json.loads(read_trusted(CONFIG))
    # An unrelated existing production installation cannot be accepted as CI.
    if not installed["runtimes"] or any(not item.startswith("/usr/local/libexec/morphz-runtime-ci/")
                                       for item in installed["runtimes"]):
        raise PermissionError("only exact CI native Runtime installations may enter this contract")
    output = args.output.absolute()
    output.mkdir(mode=0o755)
    record = {"scope": "installed-systemd-lifecycle", "kernel": os.uname().release, "assertions": []}
    streams = []
    process = None
    buffer = bytearray()

    def check(name, condition, detail=None):
        record["assertions"].append({"name": name, "passed": bool(condition), "detail": detail})
        (output / "result.json").write_text(json.dumps(record, indent=2) + "\n")
        if not condition:
            raise AssertionError(name)

    def invoke(source=SOURCE, *arguments, success=True):
        result = subprocess.run(["/usr/bin/python3", "-I", "-B", str(source / "install.py"), *arguments],
                                capture_output=True, text=True, timeout=120,
                                env={"PATH": "/usr/sbin:/usr/bin:/bin", "LANG": "C.UTF-8"})
        with (output / "administrator.log").open("a") as stream:
            stream.write(json.dumps({"arguments": list(arguments), "code": result.returncode,
                                     "stdout": result.stdout, "stderr": result.stderr}) + "\n")
        if success and result.returncode:
            raise RuntimeError("actual administrator operation failed: " + result.stderr)
        return result

    def receive():
        deadline = time.monotonic() + 12
        descriptor = process.stdout.fileno()
        while b"\n" not in buffer:
            if not select.select([descriptor], [], [], max(0, deadline - time.monotonic()))[0]:
                raise TimeoutError("protected installed worker reply")
            part = os.read(descriptor, 4096)
            if not part:
                raise RuntimeError("protected worker exited before requested reply")
            buffer.extend(part)
        line, _, remainder = buffer.partition(b"\n")
        buffer[:] = remainder
        return json.loads(line)

    def probe(name, expected_pid):
        process.stdin.write(b"probe\n")
        process.stdin.flush()
        result = receive()
        check(name, result == {"protected_denied": True, "outside_denied": True,
                              "allowed_write": True, "pid": expected_pid}, result)

    def variant(name, filename, mutation):
        destination = FIXTURE / name
        shutil.copytree(SOURCE, destination)
        path = destination / filename
        original = path.read_text()
        changed = mutation(original)
        check(name + ": isolated fault changes the intended source", changed != original)
        path.write_text(changed)
        os.chmod(path, 0o444)
        return destination

    def frozen(launch):
        return (STATE / launch / "profile.apparmor").read_bytes()

    def native_boundaries(stage, workspace):
        for test in ("terminal::tests::terminal_sandbox_denies_outside_writes_and_protected_files",
                     "sandbox::linux::tests::native_bubblewrap_only_private_pty_retains_controlling_terminal"):
            result = subprocess.run(["/usr/bin/setpriv", "--reuid", str(args.uid), "--regid", str(args.gid),
                                     "--clear-groups", "--", "/usr/local/libexec/morphz-runtime-ci/lib",
                                     test, "--exact", "--nocapture", "--test-threads=1"],
                                    capture_output=True, text=True, timeout=90,
                                    env={**os.environ, "HOME": str(workspace), "TMPDIR": "/tmp"})
            suffix = "runtime-pty.log" if "terminal_sandbox" in test else "runtime-command.log"
            (output / (stage + "-" + suffix)).write_text(result.stdout + result.stderr)
            check("actual Runtime boundary after " + stage + ": " + test,
                  result.returncode == 0 and "1 passed" in result.stdout, result.returncode)

    try:
        FIXTURE.mkdir(mode=0o755)
        (FIXTURE / "worker.py").write_text(WORKER)
        (FIXTURE / "outside").write_text("outside must not be writable\n")
        os.chmod(FIXTURE / "worker.py", 0o444)
        # The outside file really is writable by this UID on the host: denial
        # must come from the installed sandbox's read-only mount, not ownership.
        os.chown(FIXTURE / "outside", args.uid, args.gid)
        os.chmod(FIXTURE / "outside", 0o600)
        source = Path(__file__).resolve().parent
        subprocess.run(["/usr/bin/cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2",
                        "-DMORPHZ_TEST_RUNTIME", "-DMORPHZ_TEST_INSTALLED", str(source / "mounts.c"),
                        str(source / "lifecycle_kernel_client.c"), "-o", str(FIXTURE / "native"),
                        "-ljson-c", "-lapparmor"], check=True, timeout=45)
        os.chmod(FIXTURE / "native", 0o555)
        arguments = [part for runtime in [*installed["runtimes"], str(FIXTURE / "native")]
                     for part in ("--runtime", runtime)]
        invoke(SOURCE, "--upgrade", *arguments)
        baseline = json.loads(read_trusted(CONFIG))
        check("installed baseline validates its exact immutable manifest",
              generation_config(Path(baseline["launcher"]).parent.name) == baseline)
        untrusted = output / "untrusted-source"
        shutil.copytree(SOURCE, untrusted)
        os.chown(untrusted, args.uid, args.gid)
        refused_source = invoke(untrusted, "--upgrade", *arguments, success=False)
        check("root invocation refuses user-writable source before service imports or changes",
              refused_source.returncode != 0 and "root-owned and non-user-writable" in refused_source.stderr and
              json.loads(read_trusted(CONFIG)) == baseline and not (CONFIG.parent / "transaction.json").exists())
        unexpected = variant("unexpected-import-source", "INSTALL.md", lambda value: value + "\nCI import inventory probe\n")
        (unexpected / "lifecycle.so").write_bytes(b"not executable; must never be imported")
        refused_source = invoke(unexpected, "--upgrade", *arguments, success=False)
        check("unexpected extension module is refused before privileged local imports",
              refused_source.returncode != 0 and "exact packaged source inventory" in refused_source.stderr and
              json.loads(read_trusted(CONFIG)) == baseline and not (CONFIG.parent / "transaction.json").exists())

        workspace = output / "work"
        workspace.mkdir(mode=0o700)
        os.chown(workspace, args.uid, args.gid)
        ordinary = workspace / "ordinary"
        ordinary.write_text("host\n")
        os.chown(ordinary, args.uid, args.gid)
        os.chmod(ordinary, 0o600)
        policy = {"abi": 1, "mode": "exec", "cwd": str(workspace), "read_roots": [],
                  "write_roots": [str(workspace)], "denied_read_paths": [str(workspace / ".env")],
                  "denied_write_paths": [str(workspace / ".env")], "denied_read_patterns": [],
                  "denied_write_patterns": [], "network": "deny", "hidden_roots": ["/home", "/tmp"]}
        policy_path = FIXTURE / "policy.json"
        policy_path.write_text(json.dumps(policy))
        os.chmod(policy_path, 0o444)
        errors = (output / "native.stderr.log").open("wb")
        streams.append(errors)
        process = subprocess.Popen(["/usr/bin/setpriv", "--reuid", str(args.uid), "--regid", str(args.gid),
                                   "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all", "--",
                                   str(FIXTURE / "native"), "/run/morphz-sandbox/control.sock", str(policy_path),
                                   baseline["launcher"], "installed-normal", "fixed", "fixed", "fixed"],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors,
                                  env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
        launch = receive()["registered"]
        ready = receive()
        check("real installed static launcher admits the fixed non-root worker", ready.get("ready"), ready)
        pid = ready["pid"]
        check("protected file is created only after actual installed admission", not (workspace / ".env").exists())
        (workspace / ".env").write_text("synthetic late secret\n")
        os.chown(workspace / ".env", args.uid, args.gid)
        os.chmod(workspace / ".env", 0o600)
        original_source = frozen(launch)
        probe("initial installed worker denies late protected read and outside write", pid)

        newer = variant("next-source", "policy.py", lambda value: value.replace(
            'source = f"""abi <abi/4.0>,', 'source = f"""abi <abi/4.0>,\n# installed lifecycle next compiler', 1))
        invoke(newer, "--upgrade", *arguments)
        selected = json.loads(read_trusted(CONFIG))
        check("upgrade switches to a different complete immutable generation",
              selected["launcher"] != baseline["launcher"] and generation_config(Path(selected["launcher"]).parent.name) == selected)
        check("upgrade never recompiles or rewrites the live profile source", frozen(launch) == original_source)
        probe("same worker retains protection and allowed writes after upgrade", pid)
        native_boundaries("upgrade", workspace)
        check("new Runtime commands use the upgraded compiler while old work stays protected",
              any(b"# installed lifecycle next compiler" in path.read_bytes()
                  for path in STATE.glob("*/profile.apparmor")) and frozen(launch) == original_source)

        invoke(SOURCE, "--rollback", Path(baseline["launcher"]).parent.name)
        check("explicit rollback restores exact baseline configuration", json.loads(read_trusted(CONFIG)) == baseline)
        probe("same worker retains protection after rollback", pid)

        broken = variant("broken-source", "service.py", lambda value: value.replace(
            "def main():\n", "def main():\n    raise RuntimeError('isolated injected startup failure')\n", 1))
        failed = invoke(broken, "--upgrade", *arguments, success=False)
        check("failed new service automatically restores the prior generation",
              failed.returncode != 0 and "previous configuration/service restored" in failed.stderr and
              json.loads(read_trusted(CONFIG)) == baseline and not (CONFIG.parent / "transaction.json").exists())
        probe("same worker stays protected through failed upgrade and automatic recovery", pid)

        refused = invoke(SOURCE, "--uninstall", success=False)
        check("active uninstall is refused and the original service is restored",
              refused.returncode != 0 and "protected work is still active" in refused.stderr and
              json.loads(read_trusted(CONFIG)) == baseline and frozen(launch) == original_source)
        probe("active-uninstall refusal neither kills work nor removes its protection", pid)
        process.stdin.write(b"exit\n")
        process.stdin.flush()
        check("protected worker exits normally", process.wait(timeout=12) == 0)

        native_boundaries("rollback", workspace)
        result = invoke(SOURCE, "--uninstall")
        receipt = json.loads(result.stdout)
        check("drained uninstall removes only enabled configuration, not evidence or generations",
              receipt.get("uninstalled") and receipt.get("active_leases") == 0 and
              not CONFIG.exists() and not Path("/etc/systemd/system/morphz-sandbox.service").exists() and
              STATE.is_dir() and Path(baseline["launcher"]).is_file() and Path(selected["launcher"]).is_file())
        check("normal service restart cannot silently re-enable an uninstalled sandbox",
              subprocess.run(["/bin/systemctl", "is-active", "--quiet", "morphz-sandbox.service"]).returncode != 0)

        initial_crash = variant("initial-crash-source", "install.py", lambda value: value.replace(
            "        atomic_write(CONFIG, json.dumps(target, sort_keys=True).encode())\n"
            "        atomic_write(UNIT, unit_source())\n        unlink_trusted(TRANSACTION)",
            "        atomic_write(CONFIG, json.dumps(target, sort_keys=True).encode())\n"
            "        os.kill(os.getpid(), 9)  # isolated CI crash, not a production hook\n"
            "        atomic_write(UNIT, unit_source())\n        unlink_trusted(TRANSACTION)", 1))
        crashed = invoke(initial_crash, *arguments, success=False)
        check("SIGKILL between initial config/unit writes retains a durable install journal",
              crashed.returncode == -9 and CONFIG.exists() and
              not Path("/etc/systemd/system/morphz-sandbox.service").exists() and
              (CONFIG.parent / "transaction.json").is_file())
        recovered = invoke(SOURCE, "--recover")
        check("explicit recovery completes interrupted first install without starting work",
              json.loads(recovered.stdout).get("started") is False and
              Path("/etc/systemd/system/morphz-sandbox.service").is_file() and
              not (CONFIG.parent / "transaction.json").exists())
        restored = json.loads(read_trusted(CONFIG))
        start_service(restored)

        uninstall_crash = variant("uninstall-crash-source", "install.py", lambda value: value.replace(
            "            unlink_trusted(UNIT)\n", "            unlink_trusted(UNIT)\n"
            "            os.kill(os.getpid(), 9)  # isolated CI crash, not a production hook\n", 1))
        crashed = invoke(uninstall_crash, "--uninstall", success=False)
        check("SIGKILL between uninstall unit/config removal retains recovery authority",
              crashed.returncode == -9 and CONFIG.exists() and
              not Path("/etc/systemd/system/morphz-sandbox.service").exists() and
              (CONFIG.parent / "transaction.json").is_file())
        recovered = invoke(SOURCE, "--recover")
        check("explicit uninstall recovery restores configuration and exact ready generation",
              json.loads(recovered.stdout).get("ready") is True and
              json.loads(read_trusted(CONFIG)) == restored and
              Path("/etc/systemd/system/morphz-sandbox.service").is_file() and
              not (CONFIG.parent / "transaction.json").exists())
        invoke(SOURCE, "--uninstall")
        check("final successful drain leaves no enabled service configuration", not CONFIG.exists())
    finally:
        # Only this script's fixed worker may be asked to exit. On any failure
        # retain service/config/profiles for diagnostics rather than wiping them.
        if process is not None and process.poll() is None:
            try:
                process.stdin.write(b"exit\n")
                process.stdin.flush()
                process.wait(timeout=12)
            except (BrokenPipeError, subprocess.TimeoutExpired):
                pass
        for stream in streams:
            stream.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--uid", type=int, required=True)
    parser.add_argument("--gid", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    main(parser.parse_args())
