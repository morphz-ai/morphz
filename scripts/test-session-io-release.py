#!/usr/bin/env python3
"""Probe the actual packaged Runtime with isolated data and no model calls."""
import argparse
import hashlib
import json
import os
from contextlib import closing
from pathlib import Path
import secrets
import shlex
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def native_linux_sandbox(request, root, workspace):
    """Exercise the packaged HTTP/PTY path, never an extra test executable."""
    identity = "release-sandbox-" + secrets.token_hex(8)
    session = request("/api/sessions", {"id": identity, "mount": {"type": "new_blank_context"}})
    assert session["id"] == identity, session
    base = f"/api/sessions/{identity}/terminals"
    opened = request(base, {"command_id": identity,
                            "scope_ref": hashlib.sha256(identity.encode()).hexdigest()})
    assert opened["connected"] is True, opened
    terminal = base + "/" + opened["terminal"]["id"]

    def send(data):
        current = request(terminal)
        return request(terminal + "/commands", {
            "command_id": "release-command-" + secrets.token_hex(8),
            "expected_revision": current["terminal"]["revision"],
            "action": {"type": "input", "data": data},
        })

    def wait_line(marker):
        deadline = time.monotonic() + 20
        while True:
            view = request(terminal)
            text = (view.get("screen") or {}).get("text", "")
            # The echoed shell input is not proof that its command ran.
            if marker in [line.strip() for line in text.splitlines()]:
                return view
            if time.monotonic() >= deadline or not view["connected"]:
                raise AssertionError(f"packaged terminal did not produce {marker!r}: {view}")
            time.sleep(0.1)

    try:
        ready = "READY-" + secrets.token_hex(8)
        send("stty -echo; printf '\\n%s\\n' " + shlex.quote(ready) + "\n")
        wait_line(ready)
        secret = workspace / ".env"
        assert not secret.exists(), "protected file must be created after actual PTY admission"
        secret.write_text("synthetic release-only secret", encoding="utf-8")
        outside = root / "outside"
        forbidden = outside / "must-not-exist"
        marker = "SANDBOX-" + secrets.token_hex(8)
        worker = (
            "import errno\nfrom pathlib import Path\n"
            "try:\n    Path('.env').read_bytes()\n"
            "except OSError as error:\n    assert error.errno in (errno.EACCES, errno.EPERM), error\n"
            "else:\n    raise AssertionError('late protected read succeeded')\n"
            # The outside path is explicitly readable, not merely hidden by
            # the private HOME/tmp mounts. A missing mount is not write denial.
            f"assert Path({str(outside / 'readable.txt')!r}).read_text() == 'read-only witness'\n"
            f"try:\n    Path({str(forbidden)!r}).write_text('must be denied')\n"
            "except OSError as error:\n    assert error.errno in (errno.EACCES, errno.EPERM, errno.EROFS), error\n"
            "else:\n    raise AssertionError('outside write succeeded')\n"
            "Path('allowed.txt').write_text('allowed packaged Runtime write')\n"
            f"print({marker!r}, flush=True)\n"
        )
        send("/usr/bin/python3 -c " + shlex.quote(worker) + "\n")
        wait_line(marker)
        assert (workspace / "allowed.txt").read_text() == "allowed packaged Runtime write"
        assert secret.read_text() == "synthetic release-only secret"
        assert (outside / "readable.txt").read_text() == "read-only witness"
        assert not forbidden.exists(), "outside write changed the host"
        print("PASS: packaged Runtime admitted a real PTY; late protected read and outside write "
              "denied; allowed write persisted; zero model calls")
    finally:
        if request(terminal)["connected"]:
            send("exit\n")
            deadline = time.monotonic() + 10
            while request(terminal)["connected"]:
                if time.monotonic() >= deadline:
                    raise AssertionError("synthetic release terminal did not exit during cleanup")
                time.sleep(0.1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--native-linux-sandbox", action="store_true")
    args = parser.parse_args()
    if args.native_linux_sandbox and (sys.platform != "linux" or os.geteuid() == 0):
        raise PermissionError("native packaged sandbox probe requires an isolated non-root Linux user")
    binary = str(args.binary.resolve(strict=True))
    with tempfile.TemporaryDirectory(prefix="morphz-stable-io-") as directory:
        root = Path(directory)
        workspace = root / "workspace"
        workspace.mkdir()
        read_roots = []
        if args.native_linux_sandbox:
            outside = root / "outside"
            outside.mkdir()
            (outside / "readable.txt").write_text("read-only witness", encoding="utf-8")
            read_roots.append(str(outside))
        token = secrets.token_hex(32)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        config = root / "runtime.toml"
        config.write_text(
            '[llm]\nmodel="fixture"\n'
            '[accounts.fixture]\nauth_adapter="none"\nprovider="fixture"\n'
            '[services.fixture]\nadapter="protocol-compatible"\n'
            'protocol="openai-chat"\nbase_url="http://127.0.0.1:9/v1"\naccounts=["fixture"]\n'
            '[[models.fixture.targets]]\nservice="fixture"\naccount="fixture"\n'
            'physical_model="fixture"\ncapabilities=["tools"]\n'
            f'[permissions]\nworkspace_root={json.dumps(str(workspace))}\n'
            f'read_roots={json.dumps(read_roots)}\n'
            f'[background_task]\nartifact_dir={json.dumps(str(root / "artifacts"))}\n',
            encoding="utf-8",
        )
        env = {key: value for key, value in os.environ.items()
               if key in ("PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TMPDIR", "TEMP", "TMP", "LANG")}
        env.update(HOME=str(root), USERPROFILE=str(root), MORPHZ_HOME=str(root / "host"),
                   MORPHZ_DASHBOARD_TOKEN=token, MORPHZ_STORAGE_SQLITE_PATH=str(root / "runtime.db"))
        with (root / "runtime.log").open("w+") as log:
            child = subprocess.Popen(
                [binary, "serve", "--bind", f"127.0.0.1:{port}", "--cwd", str(workspace),
                 "--config-file", str(config), "--log-level", "warn"],
                cwd=root, env=env, stdout=log, stderr=log,
            )
            try:
                url = f"http://127.0.0.1:{port}/api/session-io/capabilities"
                deadline = time.monotonic() + 30
                while True:
                    if child.poll() is not None:
                        log.seek(0)
                        raise AssertionError(f"Runtime exited before readiness: {log.read()}")
                    try:
                        with urlopen(Request(url, headers={"Authorization": f"Bearer {token}"}), timeout=2) as response:
                            capabilities = json.load(response)
                        break
                    except (URLError, TimeoutError):
                        if time.monotonic() >= deadline:
                            log.seek(0)
                            raise AssertionError(f"Runtime readiness timed out: {log.read()}")
                        time.sleep(0.1)
                assert capabilities["enabled"] is True, capabilities
                assert capabilities["experimental"] is False, capabilities
                assert capabilities["io_versions"] == ["1"], capabilities
                try:
                    urlopen(url, timeout=2)
                    raise AssertionError("Unauthenticated IO discovery was accepted")
                except HTTPError as error:
                    assert error.code in (401, 403), error.code
                with closing(sqlite3.connect(root / "runtime.db")) as database:
                    installed = database.execute(
                        "SELECT count(*) FROM sqlite_master WHERE name='morphz_session_io_guard'"
                    ).fetchone()[0]
                    assert installed == 0, "Startup must not install an old-writer fence"
                print("PASS: packaged Runtime exposes authenticated stable IO by default; no automatic fence")
                if args.native_linux_sandbox:
                    def request(path, body=None):
                        encoded = None if body is None else json.dumps(body).encode("utf-8")
                        req = Request(f"http://127.0.0.1:{port}" + path, data=encoded,
                                      headers={"Authorization": f"Bearer {token}",
                                               "Content-Type": "application/json"})
                        try:
                            with urlopen(req, timeout=30) as response:
                                return json.load(response)
                        except HTTPError as error:
                            raise AssertionError(f"{path}: HTTP {error.code}: "
                                                 f"{error.read().decode('utf-8', errors='replace')}") from error
                    native_linux_sandbox(request, root, workspace)
            finally:
                child.terminate()
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=10)


if __name__ == "__main__":
    main()
