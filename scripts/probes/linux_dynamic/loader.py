#!/usr/bin/python3
"""One-shot isolated root loader. No payload/command execution interface."""

import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

# Python runs with -I: opt into exactly the root-owned sibling module, not cwd,
# user site-packages, PYTHONPATH or a caller-selected module directory.
if __name__ == "__main__":
    directory = Path(__file__).resolve().parent
    for item in (directory, directory / "policy_contract.py"):
        metadata = item.lstat()
        if metadata.st_uid != 0 or metadata.st_mode & 0o022:
            raise PermissionError("trusted loader/module ownership required")
    sys.path.insert(0, str(directory))

from policy_contract import decode, label_uses, path, profile_source, token, validate_request


def trusted_file(file):
    info = file.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError(f"untrusted helper file: {file}")


def owned(stage):
    if os.geteuid() != 0:
        raise PermissionError("loader must be explicitly invoked by the isolated administrator")
    if os.environ.get("MORPHZ_ISOLATED_DYNAMIC_PROBE") != "1":
        raise PermissionError("isolated campaign marker missing")
    path(str(stage))
    if not re.fullmatch(r"morphz-dynamic-[a-f0-9]{32}", stage.name):
        raise ValueError("not an isolated stage")
    if stage.parent != Path("/tmp") or stage.resolve() != stage:
        raise ValueError("unexpected stage location")
    for directory in (stage, stage / "trusted", stage / "launches"):
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError(f"untrusted stage directory: {directory}")
    for name in ("loader.py", "policy_contract.py", "entry", "worker.py"):
        trusted_file(stage / "trusted" / name)


def parser(operation, policy):
    trusted_file(Path("/usr/sbin/apparmor_parser"))
    result = subprocess.run(
        ["/usr/sbin/apparmor_parser", operation, "--skip-cache", str(policy)],
        env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C"},
        capture_output=True, text=True, timeout=15, check=False,
    )
    print(json.dumps({"kind": "parser", "operation": operation,
                      "code": result.returncode, "stdout": result.stdout,
                      "stderr": result.stderr}), flush=True)
    if result.returncode:
        raise RuntimeError("exact policy parser command failed")


def users(profile_names):
    found = []
    for process in Path("/proc").iterdir():
        if not process.name.isdigit():
            continue
        try:
            label = (process / "attr/current").read_text().strip()
        except (FileNotFoundError, ProcessLookupError):
            continue
        except PermissionError as error:
            # No claim that an unreadable process has left the profile.
            raise RuntimeError("cannot prove profile is unused") from error
        if label_uses(label, profile_names):
            found.append(int(process.name))
    return found


def main():
    arguments = argparse.ArgumentParser()
    arguments.add_argument("operation", choices=("acquire", "collect"))
    arguments.add_argument("--stage", type=Path, required=True)
    arguments.add_argument("--uid", type=int, required=True)
    arguments.add_argument("--launch-id")
    args = arguments.parse_args()
    owned(args.stage)
    if args.uid <= 0:
        raise ValueError("workload must not run as root")
    if args.operation == "acquire":
        request = decode(sys.stdin.buffer.read(65537))
        manifest = validate_request(request, args.stage, args.uid)
        destination = Path(manifest["manifest"])
        policy = destination.with_suffix(".apparmor")
        # Exclusive immutable files: never replace an earlier launch/profile.
        raw = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
        for file, body in ((destination, raw), (policy, profile_source(manifest).encode())):
            fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o444)
            with os.fdopen(fd, "wb") as stream:
                stream.write(body)
                stream.flush()
                os.fsync(stream.fileno())
        # Preserve both source/manifest if parsing or loading fails.
        parser("--add", policy)
        print(json.dumps({"kind": "acquired", "manifest": str(destination),
                          "policy_hash": manifest["policy_hash"],
                          "profile": manifest["profile"]}), flush=True)
    else:
        launch_id = token(args.launch_id)
        destination = args.stage / "launches" / f"{launch_id}.json"
        trusted_file(destination)
        manifest = decode(destination.read_bytes())
        if manifest["uid"] != args.uid or manifest["stage"] != str(args.stage):
            raise ValueError("collect ownership mismatch")
        names = [manifest["bootstrap"], manifest["profile"]]
        live = users(names)
        if live:
            print(json.dumps({"kind": "collection_refused", "live_pids": live}), flush=True)
            return 75
        parser("--remove", destination.with_suffix(".apparmor"))
        # Keep immutable evidence; removal does not delete unrelated stage data.
        print(json.dumps({"kind": "collected", "profiles": names}), flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({"kind": "loader_error", "error": repr(error)}), file=sys.stderr)
        sys.exit(1)
