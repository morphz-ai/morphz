#!/usr/bin/env python3
import concurrent.futures
import json
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.request import urlopen

workspace = Path(sys.argv[1]).resolve()
report_path = Path(sys.argv[2]).resolve()
checks = []


def check(name, fn):
    try:
        detail = fn()
        checks.append({"id": name, "passed": True, "detail": str(detail or "ok")})
    except Exception as exc:
        checks.append({"id": name, "passed": False, "detail": repr(exc)})


def run(args, cwd=workspace, ok=True, timeout=180):
    result = subprocess.run(args, cwd=cwd, text=True, capture_output=True, timeout=timeout)
    if ok and result.returncode != 0:
        raise RuntimeError(f"command failed {args}: {result.stderr[-2000:]}")
    return result


def manifest(path, name, version, deps=None, payload="payload"):
    path.mkdir(parents=True, exist_ok=True)
    deps = deps or {}
    lines = ["[package]", f'name = "{name}"', f'version = "{version}"', "", "[dependencies]"]
    lines += [f'{key} = "{value}"' for key, value in deps.items()]
    (path / "forgedepot.toml").write_text("\n".join(lines) + "\n")
    (path / "payload.txt").write_text(payload)


def binary():
    for item in [workspace / "target/debug/forgedepot", workspace / "target/release/forgedepot"]:
        if item.is_file():
            return item
    raise RuntimeError("forgedepot binary not found")


def cli(root, *args, ok=True):
    return run([str(binary()), "--root", str(root), *map(str, args)], ok=ok)


check("cargo-test-offline", lambda: run(["cargo", "test", "--offline", "--all-targets"], timeout=600).stdout[-1000:])
check("cargo-build-offline", lambda: run(["cargo", "build", "--offline"], timeout=600).stdout[-1000:])

temp = Path(tempfile.mkdtemp(prefix="forgedepot-hidden-"))
root = temp / "registry"
packages = temp / "packages"
lock_old = temp / "old.lock"
lock_new = temp / "new.lock"
dest = temp / "install"


def functional():
    cli(root, "init")
    cli(root, "init")
    manifest(packages / "util-1.0", "util", "1.0.0", payload="util-v1")
    manifest(packages / "util-1.1", "util", "1.1.0", payload="util-v11")
    manifest(packages / "app", "app", "2.0.0", {"util": "^1.0"}, "app-v2")
    for item in [packages / "util-1.0", packages / "util-1.1", packages / "app"]:
        cli(root, "publish", item)
    cli(root, "publish", packages / "util-1.1")
    cli(root, "resolve", "app@^2", "--lock", lock_old)
    old = json.loads(lock_old.read_text())
    selected = {p["name"]: p["version"] for p in old["packages"]}
    assert selected.get("util") == "1.1.0", selected
    cli(root, "yank", "util@1.1.0")
    cli(root, "install", "--lock", lock_old, "--dest", dest)
    assert (dest / "util" / "1.1.0" / "payload.txt").read_text() == "util-v11"
    cli(root, "resolve", "app@^2", "--lock", lock_new)
    new = json.loads(lock_new.read_text())
    selected = {p["name"]: p["version"] for p in new["packages"]}
    assert selected.get("util") == "1.0.0", selected
    search = json.loads(cli(root, "search", "uti", "--json").stdout)
    assert any(p["version"] == "1.1.0" and p["yanked"] for p in search)
    return "resolve/install/yank/search contract passed"


check("functional-contract", functional)


def concurrent_publish():
    manifest(packages / "race", "race", "1.0.0", payload="race")
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda _: cli(root, "publish", packages / "race", ok=False), range(6)))
    assert all(result.returncode == 0 for result in results), [r.stderr for r in results]
    return "six duplicate publishers were idempotent"


check("concurrent-idempotent-publish", concurrent_publish)


def conflicting_publish():
    manifest(packages / "race-conflict", "race", "1.0.0", payload="different")
    result = cli(root, "publish", packages / "race-conflict", ok=False)
    assert result.returncode != 0
    return result.stderr[-500:]


check("conflicting-publish-rejected", conflicting_publish)


def corrupt_blob():
    lock = json.loads(lock_new.read_text())
    target = next(p for p in lock["packages"] if p["name"] == "util")
    blob = root / "blobs" / "sha256" / target["sha256"]
    if blob.is_dir():
        file = next(p for p in blob.rglob("*") if p.is_file())
        file.write_text("corrupt")
    else:
        blob.write_text("corrupt")
    result = cli(root, "install", "--lock", lock_new, "--dest", temp / "corrupt-dest", ok=False)
    assert result.returncode != 0
    return result.stderr[-500:]


check("blob-corruption-detected", corrupt_blob)


def http_health():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    ready = temp / "ready.txt"
    proc = subprocess.Popen(
        [str(binary()), "--root", str(root), "serve", "--bind", f"127.0.0.1:{port}", "--ready-file", str(ready)],
        cwd=workspace, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        deadline = time.time() + 15
        while time.time() < deadline and not ready.exists() and proc.poll() is None:
            time.sleep(0.1)
        assert ready.exists(), proc.stderr.read() if proc.poll() is not None else "ready file absent"
        with urlopen(f"http://127.0.0.1:{port}/health", timeout=3) as response:
            payload = json.loads(response.read())
            assert response.status == 200 and payload
        with urlopen(f"http://127.0.0.1:{port}/api/packages?q=app", timeout=3) as response:
            assert isinstance(json.loads(response.read()), list)
        return "health and search endpoints passed"
    finally:
        if proc.poll() is None:
            proc.send_signal(signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()


check("http-contract", http_health)

passed = all(item["passed"] for item in checks)
report_path.write_text(json.dumps({"passed": passed, "checks": checks, "stdout": "", "stderr": ""}, ensure_ascii=False, indent=2))
shutil.rmtree(temp, ignore_errors=True)
raise SystemExit(0 if passed else 1)
