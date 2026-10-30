#!/usr/bin/python3
"""Cargo runner for exact CI-installed native test images, never a trusted peer.

Only the explicitly installed sandbox test targets are redirected. Other tests
run their normal Cargo executable and cannot authenticate to the policy service.
The immutable administrator manifest and both executable hashes prevent a stale
build from being reported as the newly compiled code.
"""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

MANIFEST = Path("/usr/local/libexec/morphz-runtime-ci/manifest.json")


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def select_executable(source, manifest):
    source = Path(source).resolve(strict=True)
    if not isinstance(manifest, dict) or set(manifest) != {"version", "entries"} or manifest["version"] != 1:
        raise ValueError("unsupported installed test manifest")
    entries = manifest["entries"]
    if not isinstance(entries, dict) or not 1 <= len(entries) <= 16:
        raise ValueError("invalid installed test inventory")
    entry = entries.get(str(source))
    if entry is None:
        return str(source)
    if not isinstance(entry, dict) or set(entry) != {"installed", "sha256"}:
        raise ValueError("invalid exact test image mapping")
    if digest(source) != entry["sha256"] or digest(entry["installed"]) != entry["sha256"]:
        raise ValueError("compiled test differs from administrator-installed image; reinstall this CI fixture")
    return entry["installed"]


if __name__ == "__main__":
    if sys.platform != "linux" or os.getuid() == 0 or len(sys.argv) < 2:
        raise PermissionError("native CI tests must run as the ordinary non-root runner")
    info = MANIFEST.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise PermissionError("test manifest is not administrator-owned")
    selected = select_executable(sys.argv[1], json.loads(MANIFEST.read_text()))
    os.execv(selected, [selected, *sys.argv[2:]])
