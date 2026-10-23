#!/usr/bin/python3
"""Fixed systemd entry; one atomic administrator config selects a generation."""
import json
import os
from pathlib import Path
import re
import stat
import sys

BASE = Path("/usr/local/libexec/morphz-sandbox")
CONFIG = Path("/etc/morphz-sandbox/config.json")


def trusted(path, directory=False):
    if not path.is_absolute() or str(path) != os.path.normpath(path):
        raise PermissionError("noncanonical installed path")
    current = Path("/")
    for part in path.parts[1:]:
        current = current / part
        info = current.lstat()
        final = current == path
        if (info.st_uid != 0 or info.st_mode & 0o022 or
                not (stat.S_ISDIR(info.st_mode) if not final or directory else
                     stat.S_ISREG(info.st_mode) and info.st_nlink == 1)):
            raise PermissionError("installed service code is not administrator-owned")


def main():
    if sys.platform != "linux" or os.getresuid() != (0, 0, 0) or len(sys.argv) != 1:
        raise PermissionError("installed administrator service only")
    trusted(CONFIG)
    config = json.loads(CONFIG.read_bytes())
    if not isinstance(config, dict) or not isinstance(config.get("launcher"), str):
        raise ValueError("invalid installed generation selector")
    launcher = Path(config["launcher"])
    if (launcher.parent.parent != BASE or launcher.name != "launcher" or
            not re.fullmatch(r"v1-[0-9a-f]{24}", launcher.parent.name)):
        raise ValueError("configuration does not select an installed generation")
    trusted(launcher)
    source = launcher.parent / "service.py"
    trusted(source)
    os.execve("/usr/bin/python3", ["/usr/bin/python3", "-I", "-B", str(source)],
              {"PATH": "/usr/sbin:/usr/bin:/bin", "LANG": "C.UTF-8"})


if __name__ == "__main__":
    main()
