#!/usr/bin/python3
"""Install exact Cargo-produced native test executables in an isolated CI host.

This is test setup, not a production interpreter allowlist or a chmod of the
checkout. The service authenticates the actual root-owned executable objects.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

# These are the actual native Runtime test images that exercise command/PTY
# admission. This explicit CI-only list does not authorize arbitrary workspace
# programs, interpreters or future tests. A new sandbox-using target must be
# reviewed and added here; otherwise service authentication fails closed.
SANDBOX_TEST_TARGETS = frozenset({
    "native_sandbox_contract", "activation_approval_checkpoint", "attempt_loop",
    "response_annotations_runtime", "runtime_store_conformance", "terminal_handoff",
})


def selected_artifacts(lines, workspace=False):
    artifacts = {}
    for line in lines:
        value = json.loads(line)
        if value.get("reason") != "compiler-artifact" or not value.get("executable") or not value["profile"]["test"]:
            continue
        target = value["target"]
        role = "lib" if target["name"] == "morphz" and target["kind"] == ["lib"] else \
               "native" if target["name"] == "native_sandbox_contract" and target["kind"] == ["test"] else \
               target["name"] if workspace and target["kind"] == ["test"] and target["name"] in SANDBOX_TEST_TARGETS else None
        if role:
            if role in artifacts:
                raise ValueError("duplicate native test executable")
            artifacts[role] = Path(value["executable"])
    required = {"lib", "native"}
    if workspace:
        required |= SANDBOX_TEST_TARGETS - {"native_sandbox_contract"}
    if set(artifacts) != required:
        raise ValueError("every declared Runtime sandbox test executable is required")
    return artifacts


def main(log, workspace=False, install_service=False):
    if sys.platform != "linux" or os.getuid() != 0 or os.environ.get("MORPHZ_LINUX_SANDBOX_TEST") != "1":
        raise PermissionError("explicit isolated CI administrator setup required")
    artifacts = selected_artifacts(Path(log).read_text().splitlines(), workspace)
    destination = Path("/usr/local/libexec/morphz-runtime-ci")
    destination.parent.mkdir(mode=0o755, exist_ok=True)
    destination.mkdir(mode=0o755)  # refuse reuse/overwrite
    entries = {}
    for role, source in artifacts.items():
        source = source.resolve(strict=True)
        installed = destination / role
        shutil.copyfile(source, installed)
        os.chmod(installed, 0o555)
        with installed.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        entries[str(source)] = {"installed": str(installed), "sha256": digest}
    with (destination / "manifest.json").open("x") as stream:
        json.dump({"version": 1, "entries": entries}, stream)
    os.chmod(destination / "manifest.json", 0o444)
    if install_service:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from install import install
        install([entry["installed"] for entry in entries.values()])
    print(json.dumps({"installed_native_tests": sorted(artifacts)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cargo_artifacts")
    parser.add_argument("--workspace", action="store_true")
    parser.add_argument("--install-service", action="store_true")
    args = parser.parse_args()
    main(args.cargo_artifacts, args.workspace, args.install_service)
