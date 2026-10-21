#!/usr/bin/python3
"""Install exact Cargo-produced native test executables in an isolated CI host.

This is test setup, not a production interpreter allowlist or a chmod of the
checkout. The service authenticates the actual root-owned executable objects.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import sys


def main(log):
    if sys.platform != "linux" or os.getuid() != 0 or os.environ.get("MORPHZ_LINUX_SANDBOX_TEST") != "1":
        raise PermissionError("explicit isolated CI administrator setup required")
    artifacts = {}
    for line in Path(log).read_text().splitlines():
        value = json.loads(line)
        if value.get("reason") != "compiler-artifact" or not value.get("executable") or not value["profile"]["test"]:
            continue
        target = value["target"]
        role = "lib" if target["name"] == "morphz" and target["kind"] == ["lib"] else \
               "native" if target["name"] == "native_sandbox_contract" else None
        if role:
            if role in artifacts:
                raise ValueError("duplicate native test executable")
            artifacts[role] = Path(value["executable"]).resolve(strict=True)
    if set(artifacts) != {"lib", "native"}:
        raise ValueError("both actual Runtime library and public sandbox test executables are required")
    destination = Path("/usr/local/libexec/morphz-runtime-ci")
    destination.parent.mkdir(mode=0o755, exist_ok=True)
    destination.mkdir(mode=0o755)  # refuse reuse/overwrite
    for role, source in artifacts.items():
        shutil.copyfile(source, destination / role)
        os.chmod(destination / role, 0o555)
    print(json.dumps({"installed_native_tests": sorted(artifacts)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cargo_artifacts")
    main(parser.parse_args().cargo_artifacts)
