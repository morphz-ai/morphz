"""Isolated Linux campaign. Default is prepare-only; no production installation."""

import argparse
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import socket
import struct
import subprocess
import sys
import termios
import time
import uuid

from policy_contract import ABI, PROBE_EXECUTABLES, decode, stack_labels, validate_request

TRUSTED = ("loader.py", "policy_contract.py", "worker.py", "entry")
MARKER = "MORPHZ_ISOLATED_DYNAMIC_PROBE"
CLEAN_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"}
PREFIX = "DYNAMIC_JSON "
KERNEL_READONLY = (
    "/sys/module/apparmor/parameters/enabled",
    "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
    "/proc/sys/kernel/unprivileged_userns_clone",
    "/proc/sys/user/max_user_namespaces",
)


def kernel_settings():
    result = {}
    for name in KERNEL_READONLY:
        try:
            result[name] = Path(name).read_text().strip()
        except OSError as error:
            result[name] = {"unavailable_errno": error.errno}
    return result


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def command(argv, *, input_data=None, timeout=20):
    result = subprocess.run(argv, input=input_data, text=True, capture_output=True,
                            timeout=timeout, env=CLEAN_ENV, check=False)
    return {"argv": argv, "code": result.returncode,
            "stdout": result.stdout, "stderr": result.stderr}


def must(record):
    if record["code"] != 0:
        raise RuntimeError(json.dumps(record))
    return record


def ungranted_root_unreadable(result):
    return (result["open"].get("errno") == errno.ENOENT
            and result["cat_code"] != 0
            and result["cat_stdout"] == "")


def unix_communication_denied(result):
    return all(result[kind].get("ok") is False
               and result[kind].get("errno") in (errno.EACCES, errno.EPERM)
               and not result[kind].get("received")
               for kind in ("abstract", "anonymous"))


def privileged(*argv, input_data=None):
    return command(["/usr/bin/sudo", "-n", *map(str, argv)], input_data=input_data)


def proc_identity(pid):
    raw = Path(f"/proc/{pid}/stat").read_text()
    tail = raw.rsplit(")", 1)[1].split()
    return {"pid": pid, "ppid": int(tail[1]), "starttime": int(tail[19])}


def descendant(pid, parent):
    seen = set()
    while pid > 1 and pid not in seen:
        if pid == parent:
            return True
        seen.add(pid)
        pid = proc_identity(pid)["ppid"]
    return False


def mount_table(pid):
    result = {}
    for line in Path(f"/proc/{pid}/mountinfo").read_text().splitlines():
        left, right = line.split(" - ", 1)
        fields, extra = left.split(), right.split()
        result[fields[4]] = {"options": fields[5].split(","), "fs": extra[0], "raw": line}
    return result


def verify_admission(peer_pid, peer_uid, child_pid, record, manifest):
    expected = {key: manifest[key] for key in ("run_id", "launch_id", "policy_hash", "profile", "uid")}
    if record != expected or peer_uid != manifest["uid"]:
        raise RuntimeError("admission identity/UID mismatch")
    if not descendant(peer_pid, child_pid):
        raise RuntimeError("admission did not originate in this launch")
    if os.readlink(f"/proc/{peer_pid}/exe") != manifest["entry"]:
        raise RuntimeError("admission executable mismatch")
    label = Path(f"/proc/{peer_pid}/attr/current").read_text().strip()
    if label not in stack_labels(manifest):
        raise RuntimeError("admission was not exact two-component enforced stack")
    namespaces = {}
    for kind in ("mnt", "pid", "user", "net"):
        current = os.readlink(f"/proc/{peer_pid}/ns/{kind}")
        host = os.readlink(f"/proc/self/ns/{kind}")
        namespaces[kind] = {"payload": current, "host": host}
        should_differ = kind != "net" or manifest["network"] == "deny"
        if (current != host) != should_differ:
            raise RuntimeError(f"unexpected {kind} namespace")
    mounts = mount_table(peer_pid)
    if "ro" not in mounts["/"]["options"] or mounts["/tmp"]["fs"] != "tmpfs":
        raise RuntimeError("root view is not read-only plus private tmpfs")
    for root in manifest["roots"]:
        options = mounts[root["path"]]["options"]
        if ("rw" in options) != (root["access"] == "write"):
            raise RuntimeError("root mount access mismatch")
    return {"peer": proc_identity(peer_pid), "label": label,
            "namespaces": namespaces, "mounts": mounts}


class Lane:
    def __init__(self, campaign, manifest, admission="allow"):
        if admission not in ("allow", "reject", "disconnect"):
            raise ValueError("only fixed synthetic admission lanes")
        self.campaign, self.manifest = campaign, manifest
        self.admission = admission
        self.rejection_verified = False
        self.process = None
        self.master = None
        self.transcript = []
        self.pending = bytearray()
        self.err = None
        self.ready = False
        self.closed = False
        self.expected_sequence = 0
        self.listener = None
        self.socket_path = Path(manifest["control"]) / "admit.sock"
        self.campaign.lanes.append(self)

    @property
    def sentinel(self):
        return Path(self.manifest["cwd"]) / (".dynamic-worker-started-" + self.manifest["profile"])

    def start(self):
        if self.sentinel.exists():
            raise RuntimeError("fresh per-launch sentinel already exists")
        control = Path(self.manifest["control"])
        control.mkdir(mode=0o700)
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(str(self.socket_path))
        self.listener.listen(1)
        self.listener.settimeout(15)
        argv = ["/usr/bin/aa-exec", "-p", self.manifest["bootstrap"], "--",
                self.manifest["entry"], "--outer", self.manifest["manifest"]]
        self.err = open(self.campaign.output / (self.manifest["launch_id"] + ".stderr"), "wb")
        if self.manifest["mode"] == "pty":
            self.master, slave = pty.openpty()
            settings = termios.tcgetattr(slave)
            settings[3] &= ~termios.ECHO
            termios.tcsetattr(slave, termios.TCSANOW, settings)
            def terminal_setup():
                os.setsid()
                fcntl.ioctl(0, termios.TIOCSCTTY, 0)
            self.process = subprocess.Popen(
                argv, stdin=slave, stdout=slave, stderr=self.err, env=CLEAN_ENV,
                close_fds=True, preexec_fn=terminal_setup,
            )
            os.close(slave)
        else:
            self.process = subprocess.Popen(
                argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.err,
                env=CLEAN_ENV, close_fds=True, start_new_session=True,
            )
        self.process_identity = proc_identity(self.process.pid)
        connection, _ = self.listener.accept()
        with connection:
            connection.settimeout(10)
            peer_pid, peer_uid, _ = struct.unpack("3i", connection.getsockopt(
                socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
            raw = bytearray()
            while not raw.endswith(b"\n") and len(raw) < 4096:
                data = connection.recv(4096 - len(raw))
                if not data:
                    raise RuntimeError("admission EOF")
                raw.extend(data)
            evidence = verify_admission(
                peer_pid, peer_uid, self.process.pid, decode(bytes(raw)), self.manifest,
            )
            # No second admission can be accepted after the verified bootstrap.
            self.listener.close()
            self.listener = None
            self.socket_path.unlink()
            if self.admission == "allow":
                connection.sendall(b"GO\n")
            elif self.admission == "reject":
                connection.sendall(b"NO\n")
            # disconnect deliberately sends no acknowledgement; context closes.
        self.campaign.record("admission", True, launch=self.manifest["launch_id"], evidence=evidence)
        if self.admission != "allow":
            code = self.process.wait(timeout=5)
            stdout = self.drain()
            self.err.flush()
            stderr = Path(self.err.name).read_text()
            reason = ("admission refused" if self.admission == "reject"
                      else "admission acknowledgement")
            valid = (code == 78 and reason in stderr and not self.sentinel.exists()
                     and not any(line.startswith(PREFIX) for line in stdout.splitlines()))
            self.campaign.record("admission_negative_no_payload", valid,
                                 lane=self.admission, code=code, stdout=stdout, stderr=stderr,
                                 sentinel_absent=not self.sentinel.exists())
            if not valid:
                raise RuntimeError("negative admission lane did not prove expected refusal")
            self.rejection_verified = True
            return self
        ready = self.wait("ready")
        self.ready = True
        expected_label = ready["identity"]["label"]
        sentinel_valid = (self.sentinel.is_file()
                          and self.sentinel.read_text() + " (enforce)" == expected_label)
        self.campaign.record("ready_after_admission", sentinel_valid, evidence=ready,
                             sentinel=str(self.sentinel))
        if not sentinel_valid:
            raise RuntimeError("positive payload sentinel not verified")
        return self

    def send(self, value):
        raw = (json.dumps(value) + "\n").encode()
        if self.master is not None:
            os.write(self.master, raw)
        else:
            self.process.stdin.write(raw)
            self.process.stdin.flush()

    def wait(self, event, request_id=None, timeout=12):
        deadline = time.monotonic() + timeout
        fd = self.master if self.master is not None else self.process.stdout.fileno()
        while time.monotonic() < deadline:
            while b"\n" in self.pending:
                raw, _, rest = self.pending.partition(b"\n")
                self.pending = bytearray(rest)
                line = raw.decode(errors="replace").rstrip("\r")
                self.transcript.append(line)
                if line.startswith(PREFIX):
                    item = json.loads(line[len(PREFIX):])
                    if item.get("event") == "operation_error":
                        raise RuntimeError(json.dumps(item))
                    if item.get("event") == event and (request_id is None or item.get("id") == request_id):
                        return item
            readable, _, _ = select.select([fd], [], [], max(0, deadline - time.monotonic()))
            if readable:
                try:
                    chunk = os.read(fd, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    chunk = b""
                if not chunk:
                    raise RuntimeError(f"worker EOF before {event}; exit={self.process.poll()}")
                self.pending.extend(chunk)
        raise TimeoutError(f"worker did not emit {event}")

    def ask(self, operation, **fields):
        self.expected_sequence += 1
        request_id = self.expected_sequence
        self.send({"id": request_id, "op": operation, **fields})
        if operation == "interrupt":
            ready = self.wait("interrupt_ready", request_id)
            if self.master is None:
                raise RuntimeError("interrupt is PTY-only")
            os.write(self.master, b"\x03")
            result = self.wait("result", request_id)
            result["interrupt_ready"] = ready
            return result
        return self.wait("bye" if operation == "exit" else "result", request_id)

    def drain(self):
        fd = self.master if self.master is not None else self.process.stdout.fileno()
        try:
            while select.select([fd], [], [], 0)[0]:
                block = os.read(fd, 65536)
                if not block:
                    break
                self.pending.extend(block)
        except OSError as error:
            if error.errno != errno.EIO or self.master is None:
                raise
        tail = self.pending.decode(errors="replace")
        self.pending.clear()
        self.transcript.append(tail)
        return tail

    def close(self):
        if self.closed:
            return
        cleanup_errors = []
        if self.process is not None:
            try:
                if self.rejection_verified:
                    if self.process.returncode != 78 or self.sentinel.exists():
                        raise RuntimeError("verified refusal no longer holds")
                elif not self.ready:
                    raise RuntimeError("startup did not reach verified worker readiness")
                else:
                    self.ask("exit")
                    code = self.process.wait(timeout=5)
                    if code != 0:
                        raise RuntimeError(f"normal worker exit was {code}")
                    tail = self.drain()
                    if self.master is not None and "DYNAMIC_SHELL_CONTINUED" not in tail:
                        raise RuntimeError("interactive Bash continuation receipt absent")
            except Exception as error:
                cleanup_errors.append(repr(error))
            if self.process.poll() is None:
                # Recovery is not a passing normal cleanup. Signal only our exact live child.
                try:
                    if proc_identity(self.process.pid) != self.process_identity:
                        raise RuntimeError("owned process identity changed; refuse signal")
                    os.killpg(self.process.pid, signal.SIGKILL)
                    self.process.wait(timeout=5)
                except Exception as error:
                    cleanup_errors.append(repr(error))
        if self.listener is not None:
            self.listener.close()
        if self.socket_path.exists():
            self.socket_path.unlink()
        if self.err is not None:
            self.err.close()
        if self.master is not None:
            os.close(self.master)
        (self.campaign.output / (self.manifest["launch_id"] + ".transcript.json")).write_text(
            json.dumps(self.transcript, indent=2))
        self.closed = True
        self.campaign.record("lane_cleanup", not cleanup_errors,
                             launch=self.manifest["launch_id"], errors=cleanup_errors)


class Campaign:
    def __init__(self, output):
        self.run_id = uuid.uuid4().hex
        self.stage = Path("/tmp") / ("morphz-dynamic-" + self.run_id)
        self.output = Path(output).resolve()
        self.output.mkdir(parents=True, exist_ok=False)
        self.records, self.lanes, self.manifests = [], [], []
        self.uid, self.gid = os.getuid(), os.getgid()
        self.kernel_before = kernel_settings()

    def record(self, name, passed, **data):
        item = {"name": name, "passed": passed, **data}
        self.records.append(item)
        with open(self.output / "receipts.jsonl", "a") as stream:
            stream.write(json.dumps(item, sort_keys=True) + "\n")
        if not passed:
            print(json.dumps(item), file=sys.stderr, flush=True)

    def setup(self):
        source = Path(__file__).resolve().parent
        if Path("/proc/self/attr/current").read_text().strip() != "unconfined":
            raise RuntimeError("this probe only authorizes its explicit unconfined host controller")
        if self.kernel_before["/sys/module/apparmor/parameters/enabled"] != "Y":
            raise RuntimeError("AppArmor is not enabled; no fallback")
        versions = {
            "kernel": command(["/usr/bin/uname", "-a"]),
            "dependencies": command(["/usr/bin/dpkg-query", "-W", "-f=${Package} ${Version}\\n",
                                     "bubblewrap", "apparmor", "apparmor-utils",
                                     "libapparmor-dev", "libjson-c-dev", "gcc"]),
            "json_c": command(["/usr/bin/pkg-config", "--modversion", "json-c"]),
        }
        for record in versions.values():
            must(record)
        self.record("runner_environment", True, versions=versions, kernel_before=self.kernel_before)
        resolved = {}
        for executable in ("/usr/bin/bwrap", "/usr/bin/python3", "/bin/bash", "/bin/cat", "/bin/sleep"):
            target = Path(executable).resolve(strict=True)
            if str(target) not in PROBE_EXECUTABLES:
                raise RuntimeError("system executable outside reviewed fixed probe list: " + str(target))
            info = target.stat()
            if info.st_uid != 0 or info.st_mode & 0o022:
                raise RuntimeError("untrusted system executable: " + str(target))
            resolved[executable] = {"path": str(target), "sha256": sha(target)}
        self.record("system_executable_identities", True, evidence=resolved)
        for name in TRUSTED:
            if not (source / name).is_file():
                raise RuntimeError(f"build prerequisite missing: {name}")
        # mkdir is deliberately exclusive: never adopt or overwrite a previous stage.
        must(privileged("/usr/bin/mkdir", "-m", "0755", self.stage))
        for name in ("trusted", "launches"):
            must(privileged("/usr/bin/install", "-d", "-m", "0755", self.stage / name))
        for name in ("control", "workspaces"):
            must(privileged("/usr/bin/install", "-d", "-m", "0700", "-o", self.uid,
                            "-g", self.gid, self.stage / name))
        for name in TRUSTED:
            destination = self.stage / "trusted" / name
            must(privileged("/usr/bin/install", "-m", "0555", source / name, destination))
            if sha(source / name) != sha(destination):
                raise RuntimeError("installed trusted source hash changed")
        self.record("trusted_install", True, stage=str(self.stage),
                    hashes={name: sha(source / name) for name in TRUSTED})

    def loader(self, action, *, request=None, launch_id=None):
        argv = ["/usr/bin/env", "-i", "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
                "LANG=C.UTF-8", f"{MARKER}=1", "/usr/bin/python3", "-I", "-B",
                str(self.stage / "trusted/loader.py"), action, "--stage", str(self.stage),
                "--uid", str(self.uid)]
        if launch_id is not None:
            argv.extend(["--launch-id", launch_id])
        return privileged(*argv, input_data=json.dumps(request) if request is not None else None)

    def acquire(self, root, *, mode="exec", extra=None, cwd=None, network="deny"):
        roots = [{"path": str(root), "access": "write"}]
        if extra is not None:
            roots.append({"path": str(extra), "access": "read"})
        request = {"abi": ABI, "run_id": self.run_id, "launch_id": uuid.uuid4().hex,
                   "mode": mode, "cwd": str(cwd or root), "roots": roots, "network": network}
        manifest = validate_request(request, self.stage, self.uid)
        # Include failed/partial installations in exact-scope cleanup and evidence.
        self.manifests.append(manifest)
        result = self.loader("acquire", request=request)
        self.record("loader_acquire_result", result["code"] == 0, request=request, evidence=result)
        # Preserve generated sources even when the parser refuses the profile.
        for suffix in (".json", ".apparmor"):
            source = Path(manifest["manifest"]).with_suffix(suffix)
            if source.is_file():
                shutil.copyfile(source, self.output / source.name)
        must(result)
        actual = decode(Path(manifest["manifest"]).read_bytes())
        if actual != manifest:
            raise RuntimeError("loader did not freeze the exact approved request")
        self.record("acquired", True, request=request, manifest=manifest, loader=result)
        return manifest

    def deny_read(self, lane, path, name):
        result = lane.ask("read", path=str(path))["value"]
        passed = (result["open"].get("errno") in (errno.EACCES, errno.EPERM)
                  and result["cat_code"] != 0 and result["cat_stdout"] == "")
        self.record(name, passed, evidence=result)

    def ordinary(self, lane, directory):
        result = lane.ask("ordinary", path=str(directory))["value"]
        self.record("ordinary_create_edit_rename", result["value"] == "ordinary-v2", evidence=result)

    def run(self):
        root_a = self.stage / "workspaces/a"
        root_a.mkdir()
        sub = root_a / "sub"
        sub.mkdir()
        (root_a / "live.txt").write_text("A-before")
        first = self.acquire(root_a, cwd=sub)
        with_lane = Lane(self, first).start()
        # The readiness receipt is the host-write barrier; no sleeps/racy timing fixture.
        (root_a / ".env").write_text("SYNTHETIC-A-SECRET")
        (root_a / ".ssh").mkdir()
        (root_a / ".ssh/key").write_text("SYNTHETIC-A-SSH")
        (root_a / ".morphz").mkdir()
        (root_a / ".morphz/config.toml").write_text("SYNTHETIC-A-CONFIG")
        (root_a / "live.txt").write_text("A-after")
        for relative in (".env", ".ssh/key", ".morphz/config.toml"):
            self.deny_read(with_lane, root_a / relative, "late_protected_path")
        live = with_lane.ask("read", path=str(root_a / "live.txt"))["value"]
        self.record("live_host_edit", live["open"].get("value") == "A-after", evidence=live)
        self.ordinary(with_lane, root_a / "ordinary")
        self.ordinary(with_lane, root_a / ".morphz")
        rename = with_lane.ask("rename", source=str(root_a / ".morphz"),
                               destination=str(root_a / "moved-config"))["value"]
        self.record("protected_ancestor_rename_denied",
                    rename.get("errno") in (errno.EACCES, errno.EPERM), evidence=rename)
        active = self.loader("collect", launch_id=first["launch_id"])
        self.record("collect_refuses_live_profile", active["code"] == 75, evidence=active)
        escape = with_lane.ask("escape")["value"]
        self.record("payload_cannot_change_profile_or_userns",
                    all(item["code"] == -1 and item["errno"] in (errno.EACCES, errno.EPERM)
                        for item in escape["change_profile"].values())
                    and escape["new_user_namespace"]["code"] == -1
                    and escape["identity"]["label"] in stack_labels(first),
                    evidence=escape)
        with_lane.close()

        for decision in ("reject", "disconnect"):
            refused = Lane(self, self.acquire(root_a, cwd=sub), admission=decision).start()
            refused.close()

        # A new root and additional authorized root are created after the first launch.
        root_b, extra = self.stage / "workspaces/b", self.stage / "workspaces/extra"
        root_b.mkdir()
        extra.mkdir()
        (extra / "approved.txt").write_text("SINGLE-LAUNCH-GRANT")
        second = self.acquire(root_b, mode="pty", extra=extra)
        terminal = Lane(self, second).start()
        granted = terminal.ask("read", path=str(extra / "approved.txt"))["value"]
        self.record("dynamic_extra_root_granted", granted["open"].get("value") == "SINGLE-LAUNCH-GRANT",
                    evidence=granted)
        (root_b / ".env").write_text("SYNTHETIC-B-SECRET")
        self.deny_read(terminal, root_b / ".env", "pty_late_secret_denied")
        interrupt = terminal.ask("interrupt")
        self.record("pty_foreground_ctrl_c", interrupt["value"]["returncode"] == -signal.SIGINT,
                    evidence=interrupt)
        self.deny_read(terminal, root_b / ".env", "pty_still_confined_after_ctrl_c")
        terminal.close()

        third = self.acquire(root_b)
        next_lane = Lane(self, third).start()
        not_granted = next_lane.ask("read", path=str(extra / "approved.txt"))["value"]
        self.record("extra_root_does_not_leak_to_next_request",
                    ungranted_root_unreadable(not_granted), evidence=not_granted)
        self.deny_read(next_lane, root_b / ".env", "fresh_exec_existing_secret_denied")
        next_lane.close()
        # A real host loopback listener is the allow control for the denied lane.
        # Accept is performed after the worker returns: both use a fixed greeting,
        # avoiding a helper thread before the PTY preexec boundary.
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen(2)
            listener.settimeout(3)
            port = listener.getsockname()[1]
            denied = Lane(self, self.acquire(root_b, network="deny")).start()
            negative = denied.ask("network", port=port)["value"]
            self.record("network_denied", negative.get("ok") is False, evidence=negative)
            denied.close()
            allowed = Lane(self, self.acquire(root_b, network="allow")).start()
            positive = allowed.ask("network", port=port)["value"]
            connection, _ = listener.accept()
            with connection:
                connection.settimeout(3)
                greeting = connection.recv(64)
            self.record("network_explicit_allow_control",
                        positive.get("ok") is True and greeting == b"DYNAMIC_SYNTHETIC\n",
                        evidence=positive, greeting=greeting.decode(errors="replace"))
            # Same network namespace as the real abstract listener: ENOENT or
            # ECONNREFUSED cannot masquerade as an AppArmor denial.
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as abstract_listener:
                abstract_name = "morphz-dynamic-" + uuid.uuid4().hex
                abstract_listener.bind("\0" + abstract_name)
                abstract_listener.listen(1)
                abstract_listener.setblocking(False)
                unix_result = allowed.ask("unix_boundary", name=abstract_name)["value"]
                unexpected_connection = False
                try:
                    connection, _ = abstract_listener.accept()
                except BlockingIOError:
                    pass
                else:
                    unexpected_connection = True
                    connection.close()
                self.record("unix_lifecycle_does_not_allow_abstract_or_anonymous_communication",
                            unix_communication_denied(unix_result) and not unexpected_connection,
                            evidence=unix_result, listener_accepted=unexpected_connection)
            allowed.close()
        self.record("unique_immutable_profiles",
                    len({item["profile"] for item in self.manifests}) == len(self.manifests)
                    and all(decode(Path(item["manifest"]).read_bytes()) == item for item in self.manifests))

    def finish(self, error):
        if error is not None:
            self.record("campaign_error", False, error=repr(error))
        for lane in self.lanes:
            if not lane.closed:
                try:
                    lane.close()
                except Exception as cleanup_error:
                    self.record("lane_cleanup_exception", False, error=repr(cleanup_error))
        for manifest in self.manifests:
            try:
                result = self.loader("collect", launch_id=manifest["launch_id"])
                self.record("profile_collection", result["code"] == 0, evidence=result)
            except Exception as cleanup_error:
                self.record("profile_collection_exception", False, error=repr(cleanup_error))
        after = kernel_settings()
        self.record("kernel_settings_unchanged", after == self.kernel_before,
                    before=self.kernel_before, after=after)
        passed = bool(self.manifests) and all(item["passed"] for item in self.records)
        summary = {"passed": passed, "run_id": self.run_id, "stage": str(self.stage),
                   "receipts": len(self.records),
                   "failures": [item for item in self.records if not item["passed"]],
                   "scope": "isolated prototype only; no production adoption"}
        (self.output / "summary.json").write_text(json.dumps(summary, indent=2))
        print(json.dumps(summary), flush=True)
        return 0 if passed else 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--output")
    args = parser.parse_args()
    if not args.execute:
        print(json.dumps({"mode": "prepare_only", "executed": False,
                          "next": "root review, then isolated Ubuntu workflow only"}))
        return 0
    if sys.platform != "linux" or os.geteuid() == 0 or os.environ.get(MARKER) != "1":
        raise RuntimeError("execution requires marked non-root isolated Linux runner")
    if not args.output:
        raise RuntimeError("explicit fresh evidence output directory required")
    campaign = Campaign(args.output)
    error = None
    def interrupted(number, frame):
        raise KeyboardInterrupt(f"isolated campaign received signal {number}")
    previous = {number: signal.signal(number, interrupted) for number in (signal.SIGINT, signal.SIGTERM)}
    try:
        campaign.setup()
        campaign.run()
    except BaseException as failure:
        error = failure
    finally:
        # One interruption triggers bounded cleanup; another cannot silently
        # turn a partial cleanup into successful completion.
        for number in previous:
            signal.signal(number, signal.SIG_IGN)
    try:
        return campaign.finish(error)
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)


if __name__ == "__main__":
    sys.exit(main())
