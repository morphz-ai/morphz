#!/usr/bin/env python3
"""Probe the actual packaged Runtime with isolated data and no model calls."""
import json
import os
from contextlib import closing
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def main():
    binary = str(Path(sys.argv[1]).resolve(strict=True))
    with tempfile.TemporaryDirectory(prefix="morphz-stable-io-") as directory:
        root = Path(directory)
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
            f'[permissions]\nworkspace_root={json.dumps(str(root))}\n'
            f'[background_task]\nartifact_dir={json.dumps(str(root / "artifacts"))}\n',
            encoding="utf-8",
        )
        env = {key: value for key, value in os.environ.items()
               if key in ("PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TMPDIR", "TEMP", "TMP", "LANG")}
        env.update(HOME=str(root), USERPROFILE=str(root), MORPHZ_HOME=str(root / "host"),
                   MORPHZ_DASHBOARD_TOKEN=token, MORPHZ_STORAGE_SQLITE_PATH=str(root / "runtime.db"))
        with (root / "runtime.log").open("w+") as log:
            child = subprocess.Popen(
                [binary, "serve", "--bind", f"127.0.0.1:{port}", "--cwd", str(root),
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
            finally:
                child.terminate()
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=10)


if __name__ == "__main__":
    main()
