#!/usr/bin/env python3
"""Validate the exact public release inventory before any GitHub publication."""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import re
import stat

ARCHIVES = (
    "morphz-linux-x86_64.tar.gz",
    "morphz-edge-linux-x86_64.tar.gz",
    "morphz-linux-aarch64.tar.gz",
    "morphz-edge-linux-aarch64.tar.gz",
    "morphz-macos-aarch64.tar.gz",
    "morphz-edge-macos-aarch64.tar.gz",
    "morphz-macos-x86_64.tar.gz",
    "morphz-edge-macos-x86_64.tar.gz",
    "morphz-windows-x86_64.zip",
    "morphz-edge-windows-x86_64.zip",
)
ASSETS = tuple(sorted((*ARCHIVES, *(name + ".sha256" for name in ARCHIVES),
                       "install.sh", "install.ps1", "release-ci-admission.json")))


class AssetError(ValueError):
    pass


def verify(directory: Path) -> list[Path]:
    if "\n" in str(directory) or "\r" in str(directory):
        raise AssetError("Release directory cannot contain line delimiters")
    if directory.is_symlink() or not directory.is_dir():
        raise AssetError("Release staging root must be a real directory, not a symlink")
    actual = {item.name for item in directory.iterdir()}
    missing, unexpected = set(ASSETS) - actual, actual - set(ASSETS)
    if missing or unexpected:
        raise AssetError(f"Release inventory mismatch: missing={sorted(missing)}, unexpected={sorted(unexpected)}")
    # lstat deliberately does not follow links. An artifact-shaped directory,
    # FIFO or link is not a release file even if its basename is expected.
    for name in ASSETS:
        metadata = (directory / name).lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size == 0:
            raise AssetError(f"Release asset must be a nonempty regular file: {name}")
    for name in ARCHIVES:
        checksum_path = directory / (name + ".sha256")
        if checksum_path.stat().st_size > 4096:
            raise AssetError(f"Release checksum record is too large: {checksum_path.name}")
        try:
            record = checksum_path.read_text(encoding="ascii")
        except UnicodeDecodeError as error:
            raise AssetError(f"Release checksum must be ASCII: {checksum_path.name}") from error
        match = re.fullmatch(r"([0-9a-f]{64}) [ *]" + re.escape(name) + r"\r?\n?", record)
        if not match:
            raise AssetError(f"Release checksum must name its exact archive: {checksum_path.name}")
        digest = hashlib.sha256()
        with (directory / name).open("rb") as archive:
            for block in iter(lambda: archive.read(1024 * 1024), b""):
                digest.update(block)
        if digest.hexdigest() != match.group(1):
            raise AssetError(f"Release archive checksum mismatch: {name}")
    return [directory / name for name in ASSETS]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    try:
        assets = verify(args.directory)
    except (AssetError, OSError) as error:
        parser.exit(1, f"Release assets rejected: {error}\n")
    # Do not emit a partial argument list: validation must finish before stdout.
    print("\n".join(str(asset) for asset in assets))


if __name__ == "__main__":
    main()
