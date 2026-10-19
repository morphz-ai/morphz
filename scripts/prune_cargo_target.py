#!/usr/bin/env python3
"""Collect superseded loose macOS rustc objects, not Cargo's reusable cache.

Unpacked DWARF points back to loose objects. Age alone is NOT evidence that an
object is disposable: protect the current executable's N_OSO debug map or the
current rlib's members. Unknown formats are deliberately left alone.
"""
import argparse
import contextlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import subprocess
import sys
import tempfile
import time

TAG = "Signature: 8a477f597d28d172789f06886806bc55"
OBJECT = re.compile(r"^(.+-[0-9a-f]{16})\..+\.rcgu\.o$")


def signature(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns,
            info.st_ctime_ns, info.st_nlink)


def macho_objects(path):
    """Read N_OSO names only, without loading binaries or invoking dsymutil."""
    with path.open("rb") as f:
        header = f.read(32)
        if len(header) != 32 or header[:4] != b"\xcf\xfa\xed\xfe":
            raise ValueError("not a thin little-endian 64-bit Mach-O")
        ncmds, cmdbytes = struct.unpack_from("<II", header, 16)
        if ncmds > 10000 or cmdbytes > 16 * 1024 * 1024:
            raise ValueError("invalid load commands")
        commands = f.read(cmdbytes)
        offset, table = 0, None
        for _ in range(ncmds):
            cmd, size = struct.unpack_from("<II", commands, offset)
            if size < 8 or offset + size > len(commands):
                raise ValueError("invalid load command")
            if cmd == 2:  # LC_SYMTAB
                table = struct.unpack_from("<IIII", commands, offset + 8)
            offset += size
        if table is None:
            raise ValueError("no symbol table")
        symoff, count, stroff, strsize = table
        if count * 16 > 128 * 1024 * 1024 or strsize > 128 * 1024 * 1024:
            raise ValueError("oversized symbol table")
        f.seek(stroff)
        strings = f.read(strsize)
        f.seek(symoff)
        symbols = f.read(count * 16)
        if len(strings) != strsize or len(symbols) != count * 16:
            raise ValueError("truncated symbol table")
        names = set()
        for pos in range(0, len(symbols), 16):
            if symbols[pos + 4] != 0x66:  # N_OSO, mach-o/stab.h
                continue
            start = struct.unpack_from("<I", symbols, pos)[0]
            end = strings.find(b"\0", start)
            if start >= len(strings) or end < 0:
                raise ValueError("invalid object name")
            names.add(strings[start:end].decode("utf8", errors="strict"))
        return names


def current_objects(artifact):
    with artifact.open("rb") as f:
        magic = f.read(8)
    if magic == b"!<arch>\n":
        result = subprocess.run(["ar", "t", str(artifact)], check=True,
                                capture_output=True, text=True, timeout=30)
        return set(result.stdout.splitlines())
    return macho_objects(artifact)


def build_busy():
    result = subprocess.run(["ps", "-A", "-o", "comm="], check=True,
                            capture_output=True, text=True)
    return any(Path(line.strip()).name in ("cargo", "rustc")
               for line in result.stdout.splitlines())


@contextlib.contextmanager
def cargo_lock(profile):
    # Cargo locks this exact file. Never unlink/recreate the lock inode.
    import fcntl
    fd = os.open(profile / ".cargo-lock", os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("Cargo lock must be a regular file")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def validate_target(raw):
    path = Path(raw).absolute()
    if path.is_symlink() or path.resolve() != path:
        raise ValueError("target must be an explicit canonical non-symlink path")
    if path in (Path("/"), Path.home(), Path.cwd()):
        raise ValueError("refusing broad target")
    tag = path / "CACHEDIR.TAG"
    info = tag.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > 4096 or not tag.read_text().startswith(TAG):
        raise ValueError("not a tagged Cargo target directory")
    return path


def collect(target, apply=False, minimum_age=1440, max_bytes=None):
    profile = target / "debug"
    report = dict(target=str(target), applied=apply, candidates=0,
                  candidate_bytes=0, removed=0, removed_bytes=0, groups=0,
                  preserved="incremental, fingerprints, build, dependencies, binaries, release")
    if not (profile / "deps").is_dir():
        return report
    if build_busy():
        raise BlockingIOError("cargo or rustc is running; collection skipped")
    with cargo_lock(profile):
        if build_busy():
            raise BlockingIOError("compiler started; collection skipped")
        deps = profile / "deps"
        if deps.resolve() != deps or (profile / ".fingerprint").resolve() != profile / ".fingerprint":
            raise ValueError("symlinked Cargo cache")
        # Binaries can reference objects from a dependency's previous build.
        # Inspect all published/debug executables, not only the object's crate.
        protected = set()
        binary_proofs = []
        seen = set()
        for directory in (profile, deps, profile / "examples"):
            if not directory.is_dir() or directory.is_symlink():
                continue
            for binary in directory.iterdir():
                if binary.is_symlink() or not binary.is_file() or binary.suffix not in ("", ".dylib", ".so"):
                    continue
                info = binary.stat()
                key = (info.st_dev, info.st_ino)
                if key in seen:
                    continue
                seen.add(key)
                with binary.open("rb") as f:
                    magic = f.read(4)
                if magic != b"\xcf\xfa\xed\xfe":
                    continue
                protected.update(macho_objects(binary))
                binary_proofs.append((binary, signature(info)))
        groups = {}
        cutoff = time.time() - minimum_age * 60
        for item in os.scandir(deps):
            match = OBJECT.fullmatch(item.name)
            if not match or item.is_symlink():
                continue
            info = item.stat(follow_symlinks=False)
            if stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_mtime < cutoff:
                groups.setdefault(match[1], []).append((Path(item.path), info))
        fingerprints = {}
        for directory in (profile / ".fingerprint").iterdir():
            if directory.is_symlink() or not directory.is_dir():
                continue
            # A completed target hash, NOT invoked.timestamp or a partial output.
            completed = [p for p in directory.iterdir()
                         if not p.is_symlink() and p.is_file() and
                         re.fullmatch(r"(?:test-|bin-|lib-|example-).+", p.name) and
                         p.suffix == "" and p.stat().st_size == 16]
            if completed:
                fingerprints[directory.name.rsplit("-", 1)[-1]] = completed
        for stem, objects in sorted(groups.items()):
            artifacts = [deps / stem, deps / ("lib" + stem + ".rlib")]
            artifact = next((p for p in artifacts if p.is_file() and not p.is_symlink()), None)
            dep = deps / (stem + ".d")
            completed = fingerprints.get(stem.rsplit("-", 1)[-1], [])
            if artifact is None or not dep.is_file() or dep.is_symlink() or not completed:
                continue
            snapshot = [(p, signature(p.stat())) for p in [artifact, dep, *completed]]
            try:
                names = current_objects(artifact)
            except (ValueError, OSError, struct.error, UnicodeError, subprocess.SubprocessError):
                continue  # Unknown/partial format is not deletion authority.
            report["groups"] += 1
            keep = {Path(n).name for n in names}
            artifact_time = artifact.stat().st_mtime_ns
            if apply and any(p.is_symlink() or signature(p.stat()) != sig for p, sig in binary_proofs):
                raise RuntimeError("published executable changed during collection")
            for path, info in objects:
                if path.name in keep or str(path) in protected or str(path) in names or info.st_mtime_ns > artifact_time:
                    continue
                allocated = info.st_blocks * 512
                report["candidates"] += 1
                report["candidate_bytes"] += allocated
                if not apply or (max_bytes is not None and report["removed_bytes"] + allocated > max_bytes):
                    continue
                # Recheck both proof and target while still holding Cargo's lock.
                if any(p.is_symlink() or signature(p.stat()) != sig for p, sig in snapshot):
                    raise RuntimeError("completed build changed during collection")
                if path.is_symlink() or signature(path.lstat()) != signature(info):
                    raise RuntimeError("object changed during collection")
                path.unlink()
                report["removed"] += 1
                report["removed_bytes"] += allocated
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--auto", action="store_true", help="bounded post-build collection; busy is a no-op")
    parser.add_argument("--minimum-age-minutes", type=int, default=1440)
    parser.add_argument("target", nargs="?", default=os.environ.get("CARGO_TARGET_DIR", str(Path(__file__).resolve().parent.parent / "target")))
    args = parser.parse_args()
    try:
        if args.minimum_age_minutes < 0:
            raise ValueError("minimum age must be non-negative")
        target = validate_target(args.target)
        stamp = target / ".morphz-object-collection.json"
        if stamp.is_symlink():
            raise ValueError("symlinked collection state")
        if args.auto:
            try:
                info = stamp.lstat()
                if not stat.S_ISREG(info.st_mode) or info.st_size > 65536:
                    raise ValueError("oversized collection state")
                if time.time() - json.loads(stamp.read_text())["collected_at"] < 86400:
                    return 0
            except (OSError, ValueError, KeyError, TypeError):
                pass
        report = collect(target, args.apply or args.auto, args.minimum_age_minutes,
                         16 * 1024 ** 3 if args.auto else None)
        if args.auto:
            with tempfile.NamedTemporaryFile(mode="w", prefix=".morphz-object-collection-", dir=target, delete=False) as output:
                pending = output.name
                json.dump({"collected_at": time.time(), **report}, output)
            os.replace(pending, stamp)
        print(json.dumps(report))
    except (OSError, ValueError, RuntimeError, ImportError, struct.error) as error:
        print(json.dumps({"skipped": str(error)}), file=sys.stderr)
        return 0 if args.auto else 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
