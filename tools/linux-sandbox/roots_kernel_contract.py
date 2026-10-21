#!/usr/bin/python3
"""Actual Linux directory-object tests, invoked as a non-root isolated user.

No AppArmor, mount, production directory, permission escalation or daemon is
created here. This is the pinning component gate, not mount-handoff proof.
"""

import argparse
import json
import os
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from policy import ABI, Policy  # noqa: E402
from roots import PinnedRoots, RootError, require_unprivileged  # noqa: E402


def execute(output):
    require_unprivileged()
    if os.environ.get("MORPHZ_LINUX_SANDBOX_TEST") != "1":
        raise PermissionError("explicit isolated invocation required")
    output.mkdir(mode=0o700)  # exclusive: never overwrite an existing result
    record = {"scope": "directory-object-pins-only", "assertions": []}

    def save():
        (output / "result.json").write_text(json.dumps(record, indent=2) + "\n")

    def check(name, condition):
        record["assertions"].append({"name": name, "passed": bool(condition)})
        save()
        if not condition:
            raise AssertionError(name)

    def rejects(name, operation):
        try:
            with operation():
                pass
        except (RootError, OSError):
            check(name, True)
        else:
            check(name, False)

    def policy(root, **changes):
        return Policy.from_request({
            "abi": ABI, "mode": "exec", "cwd": str(root),
            "read_roots": [str(root)], "write_roots": [str(root)],
            "denied_read_paths": [], "denied_write_paths": [],
            "denied_read_patterns": [], "denied_write_patterns": [], "network": "deny", **changes,
        })

    def read_at(pin, name):
        fd = os.open(name, os.O_RDONLY | os.O_CLOEXEC, dir_fd=pin.descriptor)
        with os.fdopen(fd) as stream:
            return stream.read()

    descriptors_before = len(list(Path("/proc/self/fd").iterdir()))
    try:
        with tempfile.TemporaryDirectory(prefix="synthetic-roots-", dir=output) as temporary:
            base = Path(temporary)
            workspace = base / "workspace"
            workspace.mkdir()
            (workspace / "value").write_text("original")
            with PinnedRoots(policy(workspace)) as pins:
                pin = pins.pins[str(workspace)]
                check("read and write grants share one pinned object", len(pins.pins) == 1)
                check("directory descriptors do not inherit across exec", not os.get_inheritable(pin.descriptor))
                (workspace / "live").write_text("host-update")
                pins.verify_source_bindings()
                check("live contents do not change directory authority", read_at(pin, "live") == "host-update")
                workspace.rename(base / "retired-workspace")
                workspace.mkdir()
                (workspace / "value").write_text("replacement")
                try:
                    pins.verify_source_bindings()
                except RootError:
                    check("root replacement is rejected before admission", True)
                else:
                    check("root replacement is rejected before admission", False)
                check("retained descriptor still names the original object", read_at(pin, "value") == "original")
                check("mount source carries descriptor identity not a reopened source", all(
                    entry[1] == pin.descriptor and entry[3] == pin.identity for entry in pins.mount_bindings()))
            pins.close()
            try:
                pins.mount_bindings()
            except RootError:
                check("closed pins cannot authorize another launch", True)
            else:
                check("closed pins cannot authorize another launch", False)

            link = base / "root-link"
            link.symlink_to(workspace, target_is_directory=True)
            rejects("root symlink is not followed", lambda: PinnedRoots(policy(link)))
            child = workspace / "child"
            child.mkdir()
            rejects("symlink ancestor is not followed", lambda: PinnedRoots(policy(link / "child")))
            rejects("regular file cannot become a root", lambda: PinnedRoots(policy(workspace / "value")))
            rejects("missing root is not created implicitly", lambda: PinnedRoots(policy(base / "missing")))

            readonly = base / "reference"
            readonly.mkdir()
            with PinnedRoots(policy(readonly, read_roots=["/", str(readonly), str(workspace), str(child)],
                                    write_roots=[str(workspace), str(child)])) as pins:
                bindings = pins.mount_bindings()
                check("read-only cwd stays read-only and does not add a write grant",
                      str(readonly) not in [item[2] for item in bindings if item[0] == "write"])
                check("read-only baseline root is never rebound over hidden roots",
                      not any(item[0] == "read" and item[2] == "/" for item in bindings))
                check("nested grants preserve read-first and write-last ordering",
                      [item[0] for item in bindings] == ["read"] * 3 + ["write"] * 2 and
                      [item[2] for item in bindings[-2:]] == [str(workspace), str(child)])
            for name in ('中文 *?[a]"\\', "line\nname", "tab\tname"):
                unusual = base / name
                unusual.mkdir()
                with PinnedRoots(policy(unusual)) as pins:
                    check(f"literal root path {name!r}", str(unusual) in pins.pins)
        check("all successful and refused pins close their descriptors",
              len(list(Path("/proc/self/fd").iterdir())) == descriptors_before)
        record["ok"] = True
    except BaseException as error:
        record.update(ok=False, error=repr(error))
        raise
    finally:
        save()
    print(json.dumps({"ok": True, "scope": record["scope"], "assertions": len(record["assertions"])}))


if __name__ == "__main__":
    cli = argparse.ArgumentParser()
    cli.add_argument("--output", type=Path, required=True)
    arguments = cli.parse_args()
    execute(arguments.output.absolute())
