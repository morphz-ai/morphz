"""Execute a local ME-07 command through the cloud CLIProxyAPI tunnel.

Only the cloud proxy's client key is read over SSH.  The key is placed in the
child environment and is never written or printed.  OAuth/provider credentials
remain on the cloud host.
"""

from __future__ import annotations

import argparse
import os
import shlex
import subprocess
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ssh-key", type=Path, required=True)
    parser.add_argument("--ssh-host", required=True)
    parser.add_argument("--proxy-url", default="http://127.0.0.1:18317/v1")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command
    if command[:1] == ["--"]:
        command = command[1:]
    if not command:
        parser.error("a child command is required after --")

    remote_reader = (
        "import yaml;"
        "value=yaml.safe_load(open('/etc/cliproxyapi/config.yaml'))['api-keys'];"
        "assert isinstance(value,list) and len(value)==1;"
        "print(value[0],end='')"
    )
    remote_command = f"python3 -c {shlex.quote(remote_reader)}"
    client_key = subprocess.check_output(
        [
            "ssh",
            "-i",
            str(args.ssh_key),
            "-o",
            "BatchMode=yes",
            args.ssh_host,
            remote_command,
        ],
        text=True,
    )
    if not client_key or "\n" in client_key or "\r" in client_key:
        raise RuntimeError("cloud CLIProxy returned an invalid client key")

    environment = os.environ.copy()
    environment.update(
        {
            "OPENAI_API_KEY": client_key,
            "OPENAI_BASE_URL": args.proxy_url,
        }
    )
    os.execvpe(command[0], command, environment)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1) from error
