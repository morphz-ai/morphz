"""Launch the isolated ME-07 Letta server through the cloud CLIProxy tunnel.

The cloud proxy's client key is read over SSH and passed only in the child
process environment.  It is never written to disk or printed.  Upstream OAuth
credentials remain on the cloud host and are not accessed by this launcher.
"""

from __future__ import annotations

import argparse
import os
import shlex
import subprocess
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ssh-key", type=Path, required=True)
    parser.add_argument("--ssh-host", required=True)
    parser.add_argument("--proxy-url", default="http://127.0.0.1:18317/v1")
    parser.add_argument("--port", type=int, default=8283)
    parser.add_argument(
        "--letta-dir",
        type=Path,
        default=Path("/private/tmp/me07-letta-server-20260826"),
    )
    parser.add_argument(
        "--database-uri",
        default="postgresql://shafreeck@127.0.0.1:5432/me07_letta_20260826",
    )
    parser.add_argument(
        "--letta-bin",
        type=Path,
        default=Path("/private/tmp/morphz-me07-v2-venv/bin/letta"),
    )
    args = parser.parse_args()

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
            "LETTA_DIR": str(args.letta_dir),
            "LETTA_PG_URI": args.database_uri,
        }
    )
    executable = str(args.letta_bin.resolve(strict=True))
    os.execve(
        executable,
        [
            executable,
            "server",
            "--host",
            "127.0.0.1",
            "--port",
            str(args.port),
        ],
        environment,
    )


if __name__ == "__main__":
    main()
