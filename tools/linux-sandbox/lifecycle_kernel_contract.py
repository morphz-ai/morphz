#!/usr/bin/python3
"""Real kernel/service lifetime contract, with fixed native synthetic peers.

Not a general-work admission endpoint or a Runtime replacement. Registration,
kernel authentication, durable leases and reclamation are the implementation
components; the native work fixture has no arbitrary command interface.
"""
import argparse
import array
import json
import os
from pathlib import Path
import select
import shutil
import signal
import socket
import subprocess
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lifecycle import Cgroups, Leases, Profiles, StateStore  # noqa: E402
from peer import TrustedExecutables, configure_listener, receive_frame  # noqa: E402
from registration import Registration  # noqa: E402


def serve(config_path):
    if os.getuid() != 0 or os.environ.get("MORPHZ_LINUX_SANDBOX_TEST") != "1":
        raise PermissionError("isolated root fixture only")
    config = json.loads(Path(config_path).read_text())
    store, groups = StateStore(config["state"]), Cgroups(config["cgroup"])
    profiles = Profiles(store)
    leases = Leases(store, groups, profiles)
    leases.recover()
    with TrustedExecutables([config["runtime"]]) as runtimes, \
            TrustedExecutables([config["launcher"]]) as launchers:
        registration = Registration(leases, runtimes, launchers)
        endpoint = Path(config["socket"])
        # Fixture restart owns this unique root-owned endpoint directory.
        endpoint.unlink(missing_ok=True)
        with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as listener:
            configure_listener(listener)
            listener.bind(str(endpoint))
            os.chmod(endpoint, 0o666)
            listener.listen(16)
            listener.settimeout(0.1)
            print(json.dumps({"service_ready": True, "recovered": len(leases.records)}), flush=True)
            try:
                while True:
                    registration.collect_exited()
                    try:
                        connection, _ = listener.accept()
                    except TimeoutError:
                        continue
                    with connection:
                        connection.settimeout(2)
                        descriptor = None
                        try:
                            with receive_frame(connection) as frame:
                                reply, descriptor = registration.handle(frame)
                        except (ValueError, PermissionError, RuntimeError, KeyError) as error:
                            reply = {"ok": False, "error": type(error).__name__, "detail": str(error)}
                        try:
                            ancillary = [] if descriptor is None else [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                                                                        array.array("i", [descriptor]))]
                            connection.sendmsg([json.dumps(reply).encode()], ancillary)
                        except (BrokenPipeError, ConnectionResetError):
                            pass  # no disconnect-driven profile unload
                        finally:
                            if descriptor is not None:
                                os.close(descriptor)
            finally:
                registration.close()
                groups.close()
                store.close()


def execute(args):
    if (sys.platform != "linux" or os.getuid() != 0 or args.uid <= 0 or args.gid <= 0 or
            os.environ.get("MORPHZ_LINUX_SANDBOX_TEST") != "1"):
        raise PermissionError("explicit isolated Linux administrator invocation required")
    output = args.output.absolute()
    if output.parent.resolve(strict=True) != output.parent:
        raise ValueError("evidence parent must be an existing real directory")
    output.mkdir(mode=0o755)
    unique = "morphz-sandbox-ci-" + uuid.uuid4().hex
    installed = Path("/usr/local/lib") / unique
    state = Path("/var/lib") / unique
    endpoint_root = Path("/run") / unique
    group_root = Path("/sys/fs/cgroup") / unique
    for path, mode in ((installed, 0o755), (state, 0o700), (endpoint_root, 0o755), (group_root, 0o700)):
        path.mkdir(mode=mode)  # no reuse or deletion of an existing service
    record = {"scope": "authenticated-policy-registration-and-descendant-lifetime", "assertions": [],
              "kernel": os.uname().release, "cleanup": False}
    service = None
    peers = []
    background = []
    stream_buffers = {}
    streams = []

    def save():
        (output / "result.json").write_text(json.dumps(record, indent=2) + "\n")

    def check(name, condition, detail=None):
        record["assertions"].append({"name": name, "passed": bool(condition), "detail": detail})
        save()
        if not condition:
            raise AssertionError(name)

    def receive(stream, timeout=10):
        descriptor = stream.fileno()
        buffer = stream_buffers.setdefault(descriptor, bytearray())
        deadline = time.monotonic() + timeout
        while b"\n" not in buffer:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([descriptor], [], [], remaining)[0]:
                raise TimeoutError("fixed kernel contract peer response")
            part = os.read(descriptor, 4096)
            if not part:
                raise RuntimeError("fixed contract peer exited before reply")
            buffer.extend(part)
            if len(buffer) > 262144:
                raise RuntimeError("fixed reply exceeds bound")
        line, _, tail = buffer.partition(b"\n")
        stream_buffers[descriptor] = bytearray(tail)
        return json.loads(line)

    def wait_until(predicate, timeout=10):
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() >= deadline:
                return False
            if service is not None and service.poll() is not None:
                raise RuntimeError("fixture service exited")
            time.sleep(0.02)
        return True

    def launch_record(launch):
        return json.loads((state / launch / "record.json").read_text())

    def enforcing(launch):
        from policy import Policy, compile_profiles
        value = launch_record(launch)
        compiled = compile_profiles(Policy.from_request(value["policy"]), launch)
        active = set(Path("/sys/kernel/security/apparmor/profiles").read_text().splitlines())
        return all(name + " (enforce)" in active for name in (compiled.bootstrap, compiled.work))

    def start_service():
        nonlocal service
        stderr = (output / f"service-{len(streams)}.stderr.log").open("wb")
        streams.append(stderr)
        service = subprocess.Popen(["/usr/bin/python3", "-I", "-B", str(installed / "lifecycle_kernel_contract.py"),
                                    "--service", str(installed / "config.json")],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=stderr,
                                   env={"PATH": "/usr/sbin:/usr/bin:/bin", "LANG": "C.UTF-8",
                                        "MORPHZ_LINUX_SANDBOX_TEST": "1"})
        check("service starts with an exclusive state lock", receive(service.stdout)["service_ready"])

    def host_file(path, content):
        path.write_text(content)
        os.chmod(path, 0o600)
        os.chown(path, args.uid, args.gid)

    def start_peer(mode, binary="runtime"):
        workspace = output / mode
        workspace.mkdir(mode=0o700)
        os.chown(workspace, args.uid, args.gid)
        ordinary, protected = workspace / "ordinary", workspace / "future.env"
        host_file(ordinary, "host\n")
        policy = {"abi": 1, "mode": "exec", "cwd": str(workspace), "read_roots": [],
                  "write_roots": [str(workspace)], "denied_read_paths": [str(protected)],
                  "denied_write_paths": [str(protected)], "denied_read_patterns": [],
                  "denied_write_patterns": [], "network": "deny"}
        policy_path = installed / (mode + ".json")
        policy_path.write_text(json.dumps(policy))
        os.chmod(policy_path, 0o444)
        stderr = (output / f"{mode}.stderr.log").open("wb")
        streams.append(stderr)
        peer = subprocess.Popen(["/usr/bin/setpriv", "--reuid", str(args.uid), "--regid", str(args.gid),
            "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all", "--",
            str(installed / binary), str(endpoint_root / "control.sock"), str(policy_path),
            str(installed / "launcher"), mode, str(protected), str(ordinary), str(group_root / "cgroup.procs")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr,
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
        peers.append(peer)
        return peer, ordinary, protected

    try:
        for name in ("policy.py", "peer.py", "lifecycle.py", "registration.py", "lifecycle_kernel_contract.py"):
            shutil.copyfile(Path(__file__).parent / name, installed / name)
            os.chmod(installed / name, 0o444)
        for binary, flags in (("runtime", ["-DMORPHZ_TEST_RUNTIME"]), ("launcher", [])):
            subprocess.run(["/usr/bin/cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", *flags,
                            str(Path(__file__).parent / "mounts.c"),
                            str(Path(__file__).parent / "lifecycle_kernel_client.c"), "-o", str(installed / binary),
                            "-ljson-c", "-lapparmor"], check=True, timeout=30)
            os.chmod(installed / binary, 0o555)
        shutil.copyfile(installed / "runtime", installed / "rogue")
        os.chmod(installed / "rogue", 0o555)  # same bytes and UID, different unregistered object
        config = {"state": str(state), "cgroup": str(group_root), "socket": str(endpoint_root / "control.sock"),
                  "runtime": str(installed / "runtime"), "launcher": str(installed / "launcher")}
        (installed / "config.json").write_text(json.dumps(config))
        os.chmod(installed / "config.json", 0o444)
        start_service()
        duplicate = subprocess.run(["/usr/bin/python3", "-I", "-B", str(installed / "lifecycle_kernel_contract.py"),
                                    "--service", str(installed / "config.json")],
                                   capture_output=True, timeout=5,
                                   env={"PATH": "/usr/sbin:/usr/bin:/bin", "LANG": "C.UTF-8",
                                        "MORPHZ_LINUX_SANDBOX_TEST": "1"})
        check("a second service cannot overwrite or race the active state owner",
              duplicate.returncode != 0 and b"BlockingIOError" in duplicate.stderr and service.poll() is None)

        rogue, _, _ = start_peer("rogue", "rogue")
        check("same UID and same binary bytes do not authorize an unregistered executable object",
              receive(rogue.stdout) == {"rejected": True} and rogue.wait(timeout=5) == 0)

        peer, ordinary, protected = start_peer("background")
        launch = receive(peer.stdout)["registered"]
        ready = receive(peer.stdout)
        check("non-root launcher self-joins through a received root-opened capability",
              ready.get("ready") and ready.get("extra_fds") == 0, ready)
        child = ready["pid"]
        child_fd = os.pidfd_open(child)
        background.append(child_fd)
        check("kernel places the actual background child in exactly its lease cgroup",
              Path(f"/proc/{child}/cgroup").read_text().strip() == f"0::/{unique}/{launch}")
        check("launcher and Runtime can both exit while descendant remains", peer.wait(timeout=5) == 0)
        check("owner exit closes new admission without unloading descendant protection",
              wait_until(lambda: launch_record(launch)["phase"] == "closing") and enforcing(launch)
              and (group_root / launch).is_dir())
        check("protected path does not exist before fixed worker readiness", not protected.exists())
        host_file(protected, "synthetic-secret")
        peer.stdin.write(b"probe\n")
        peer.stdin.flush()
        result = receive(peer.stdout)
        check("future protected file denied, allowed writes work and no escape capability leaks",
              result.get("protected_denied") and result.get("allowed_write") and result.get("escape_denied")
              and result.get("extra_fds") == 0 and ordinary.read_text() == "host\nworker\n", result)

        newer, _, newer_protected = start_peer("background-newer")
        newer_launch = receive(newer.stdout)["registered"]
        newer_ready = receive(newer.stdout)
        background.append(os.pidfd_open(newer_ready["pid"]))
        check("concurrent generations keep different immutable profiles and cgroups",
              newer_ready.get("ready") and newer_launch != launch and newer.wait(timeout=5) == 0
              and enforcing(launch) and enforcing(newer_launch))
        host_file(newer_protected, "second-synthetic-secret")

        service.kill()  # actual SIGKILL, no service finally/cleanup runs
        service.wait(timeout=5)
        check("service crash leaves real kernel protection installed", enforcing(launch))
        peer.stdin.write(b"probe\n")
        peer.stdin.flush()
        result = receive(peer.stdout)
        check("background work remains protected while service is absent", result.get("protected_denied")
              and result.get("allowed_write") and result.get("escape_denied"), result)
        start_service()
        check("restart preserves live generation and never revives admission",
              enforcing(launch) and enforcing(newer_launch) and
              launch_record(launch)["phase"] == launch_record(newer_launch)["phase"] == "closing")
        peer.stdin.write(b"exit\n")
        peer.stdin.flush()
        check("only last descendant exit permits cgroup removal then policy unload",
              wait_until(lambda: launch_record(launch)["phase"] == "removed") and not enforcing(launch)
              and not (group_root / launch).exists())
        newer.stdin.write(b"probe\n")
        newer.stdin.flush()
        result = receive(newer.stdout)
        check("collecting one generation never weakens the concurrent live generation",
              enforcing(newer_launch) and result.get("protected_denied") and result.get("allowed_write"), result)
        newer.stdin.write(b"exit\n")
        newer.stdin.flush()
        check("independent final descendant exit reclaims the second generation",
              wait_until(lambda: launch_record(newer_launch)["phase"] == "removed") and not enforcing(newer_launch))

        held, _, _ = start_peer("held")
        held_launch = receive(held.stdout)["registered"]
        held_ready = receive(held.stdout)
        check("a launcher can hold an issued capability before joining", held_ready.get("held"), held_ready)
        held_fd = os.pidfd_open(held_ready["pid"])
        background.append(held_fd)
        held.kill()  # owner dies, but held child/capability still exists
        held.wait(timeout=5)
        check("owner death reclaims an empty group despite an outstanding join descriptor",
              wait_until(lambda: launch_record(held_launch)["phase"] == "removed") and not enforcing(held_launch))
        held.stdin.write(b"G")
        held.stdin.flush()
        result = receive(held.stdout)
        check("a stale join capability cannot enter or resurrect the removed group",
              result.get("stale_join_refused") is True, result)

        held_restart, _, _ = start_peer("held-restart")
        restarting_launch = receive(held_restart.stdout)["registered"]
        restarting_ready = receive(held_restart.stdout)
        background.append(os.pidfd_open(restarting_ready["pid"]))
        service.kill()
        service.wait(timeout=5)
        start_service()
        check("restart closes even a live owner's unadmitted claim instead of trusting saved PIDs",
              held_restart.poll() is None and launch_record(restarting_launch)["phase"] == "removed"
              and not enforcing(restarting_launch))
        held_restart.stdin.write(b"G")
        held_restart.stdin.flush()
        result = receive(held_restart.stdout)
        check("issued pre-crash capability cannot bypass recovery closure",
              result.get("stale_join_refused") is True and held_restart.wait(timeout=5) == 0, result)
        record["ok"] = True
    except BaseException as error:
        record.update(ok=False, error=repr(error))
        raise
    finally:
        # Fixture-only termination uses retained pidfds, not recycled numeric
        # PIDs. The service itself never kills work during lease collection.
        for descriptor in background:
            try:
                signal.pidfd_send_signal(descriptor, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.close(descriptor)
        for peer in peers:
            if peer.poll() is None:
                peer.kill()
                peer.wait(timeout=5)
        if service is not None and service.poll() is None:
            service.kill()
            service.wait(timeout=5)
        try:
            with_cleanup = StateStore(state)
            groups = Cgroups(group_root)
            profiles = Profiles(with_cleanup)
            leases = Leases(with_cleanup, groups, profiles)
            # Preserve original persistent inputs before any cleanup changes.
            shutil.copytree(state, output / "durable-state")
            for value in with_cleanup.records():
                if value["phase"] != "removed" and groups.identity(value["launch"]) is not None:
                    groups.require_identity(value)
                    # Only synthetic processes in this exact recorded fixture
                    # cgroup; also covers a child failing before its ready frame.
                    (group_root / value["launch"] / "cgroup.kill").write_text("1")
            deadline = time.monotonic() + 5
            while True:
                leases.recover()
                if not leases.records or time.monotonic() >= deadline:
                    break
                time.sleep(0.02)
            record["cleanup"] = not leases.records
            groups.close()
            with_cleanup.close()
            if record["cleanup"]:
                # Exact unique fixture roots validated above; no production
                # service, user data, global sysctl or existing cgroup is touched.
                group_root.rmdir()
                shutil.rmtree(installed)
                shutil.rmtree(state)
                shutil.rmtree(endpoint_root)
            else:
                record["retained_protection"] = str(state)
        except BaseException as cleanup_error:
            record["cleanup_error"] = repr(cleanup_error)
        for stream in streams:
            stream.close()
        save()
    if not record["cleanup"]:
        raise AssertionError("synthetic lifetime resources were not fully reclaimed")
    print(json.dumps({"ok": True, "assertions": len(record["assertions"]), "scope": record["scope"]}))


if __name__ == "__main__":
    cli = argparse.ArgumentParser()
    cli.add_argument("--service")
    cli.add_argument("--uid", type=int)
    cli.add_argument("--gid", type=int)
    cli.add_argument("--output", type=Path)
    arguments = cli.parse_args()
    if arguments.service:
        serve(arguments.service)
    else:
        execute(arguments)
