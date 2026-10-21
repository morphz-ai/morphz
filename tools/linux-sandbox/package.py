#!/usr/bin/env python3
"""Stage inert installation sources; never install or start privileged code."""
import argparse
from pathlib import Path
import shutil

from install import SOURCES


BUNDLE_FILES = (*SOURCES, "launcher.c", "mounts.c", "mounts.h", "install.py", "INSTALL.md")


def stage(bundle):
    source = Path(__file__).resolve().parent
    destination = Path(bundle) / "linux-sandbox"
    # Packaging must not silently merge an old implementation into a new image.
    destination.mkdir()
    for name in BUNDLE_FILES:
        item = source / name
        if item.is_symlink() or not item.is_file():
            raise ValueError(f"missing regular installation source: {name}")
        shutil.copyfile(item, destination / name)
        (destination / name).chmod(0o644)
    return destination


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path, help="existing release bundle directory")
    print(stage(parser.parse_args().bundle))
