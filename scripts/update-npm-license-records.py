#!/usr/bin/env python3
"""Refresh optional npm license records from lock-pinned official archives.

Explicit maintenance command, never run by bundle generation/check or npm install.
Only license texts are retained; archives are streamed to temporary files, checked
against lockfile SRI and discarded. No package code or lifecycle script is run.
"""
from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
import tempfile
from urllib.parse import urlparse
from urllib.request import urlopen

spec = importlib.util.spec_from_file_location(
    "license_bundle", Path(__file__).with_name("generate-third-party-licenses.py"))
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)
ROOT = bundle.REPOSITORY_ROOT
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
EMSCRIPTEN_COMMIT = "d6c521a7f05449857c76bd99e396895583cf2083"  # 6.0.10


def verify_integrity(digest: bytes, integrity: str) -> None:
    # Current lockfiles use SHA-512. Reject unsupported forms instead of silently
    # reducing the check to a metadata lookup or an unverified download.
    algorithm, encoded = integrity.split("-", 1)
    if algorithm != "sha512" or digest != base64.b64decode(encoded, validate=True):
        raise RuntimeError("npm archive integrity mismatch or unsupported SRI")


def extract_licenses(archive, identity: dict) -> list[tuple[str, bytes]]:
    files = []
    metadata = None
    versions = None
    with tarfile.open(fileobj=archive, mode="r:gz") as tar:
        for member in tar:
            path = PurePosixPath(member.name)
            if not member.isfile() or not path.parts or path.parts[0] != "package" or ".." in path.parts:
                continue
            is_license = path.name.lower().startswith(bundle.LICENSE_PREFIXES)
            # Sharp publishes its actual author/third-party notices here, not
            # in LICENSE. Preserve the complete original file, not a guessed
            # SPDX template or a platform-independent notice subset.
            sharp_readme = identity["name"].startswith("@img/sharp-") and member.name == "package/README.md"
            wasm_versions = identity["name"] == "@img/sharp-wasm32" and member.name == "package/versions.json"
            if member.name != "package/package.json" and not is_license and not sharp_readme and not wasm_versions:
                continue
            if member.size > bundle.MAX_LICENSE_BYTES:
                raise RuntimeError(f"oversized archive metadata/license: {member.name}")
            content = tar.extractfile(member).read()
            if member.name == "package/package.json":
                metadata = json.loads(content)
            elif wasm_versions:
                versions = json.loads(content)
            else:
                content.decode("utf-8")  # Do not silently corrupt legal text.
                files.append((member.name, content))
    if metadata is None or any(metadata.get(key) != identity[key] for key in ("name", "version", "license")):
        raise RuntimeError(f"npm archive metadata differs from lock: {identity['name']}")
    if not files:
        raise RuntimeError(f"archive has no license text: {identity['name']}")
    if identity["name"] == "@img/sharp-wasm32" and (versions or {}).get("emscripten") != "6.0.10":
        raise RuntimeError("WASM component licenses require a new Emscripten version review")
    return sorted(files)


def archive_licenses(identity: dict) -> list[tuple[str, bytes]]:
    url = identity["resolved"]
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.netloc != "registry.npmjs.org":
        raise RuntimeError("license archives must use the locked official npm registry URL")
    with tempfile.TemporaryFile() as archive, urlopen(url, timeout=60) as response:
        if response.url != url:
            raise RuntimeError("unexpected npm archive redirect")
        digest, size = hashlib.sha512(), 0
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_ARCHIVE_BYTES:
                raise RuntimeError(f"archive exceeds bounded download: {identity['name']}")
            digest.update(chunk)
            archive.write(chunk)
        verify_integrity(digest.digest(), identity["integrity"])
        archive.seek(0)
        files = extract_licenses(archive, identity)
    print(f"verified {identity['name']}@{identity['version']}: {size} bytes, {len(files)} license files")
    return files


def text_record(path: Path, archive_path: str | None = None) -> dict:
    result = {"path": str(path.relative_to(ROOT)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    if archive_path:
        result["archive_path"] = archive_path
    return result


def emscripten_records(destination: Path) -> list[dict]:
    files = []
    for name in ("LICENSE", "AUTHORS"):
        result = subprocess.run([
            "gh", "api", f"repos/emscripten-core/emscripten/contents/{name}?ref={EMSCRIPTEN_COMMIT}",
            "-H", "Accept: application/vnd.github.raw+json",
        ], check=True, capture_output=True, timeout=60)
        content = result.stdout
        if not content or len(content) > bundle.MAX_LICENSE_BYTES:
            raise RuntimeError("missing/oversized Emscripten attribution")
        content.decode("utf-8")
        output = destination / f"{hashlib.sha256(content).hexdigest()}.txt"
        output.write_bytes(content)
        files.append({**text_record(output), "upstream_path": name})
    return files


def refresh() -> None:
    destination = ROOT / "third_party/licenses/npm"
    destination.mkdir(exist_ok=True)
    manifest = {"format": 1, "packages": {}, "sources": {}}
    for directory in ("application", "dashboard"):
        lock = json.loads((ROOT / directory / "package-lock.json").read_text())
        records = {}
        for path, package in sorted(lock["packages"].items()):
            if not path.startswith("node_modules/") or not package.get("optional") or package.get("dev", False):
                continue
            identity = bundle.npm_identity(path, package)
            source_path = path
            if identity["name"].startswith("@napi-rs/canvas-"):
                # Native packages omit their MIT text. Preserve the matching
                # parent package's author notice, already used by this project.
                source_path = "node_modules/@napi-rs/canvas"
                parent = lock["packages"][source_path]
                if parent["version"] != identity["version"] or identity["license"] != "MIT":
                    raise RuntimeError("canvas attribution requires a new version/license review")
            if identity["name"].startswith("@img/sharp-libvips-"):
                if identity["version"] != "1.3.4" or identity["license"] != "LGPL-3.0-or-later":
                    raise RuntimeError("libvips notices require a new version/license review")
                source_id = "reviewed:sharp-libvips@1.3.4"
                manifest["sources"][source_id] = {
                    "kind": "reviewed-upstream-notices",
                    "provenance": "third_party/licenses/sharp-libvips-1.3.4/SOURCE.md",
                    "files": [text_record(ROOT / "third_party/licenses" / name) for name in (
                        "sharp-libvips-1.3.4/THIRD-PARTY-NOTICES.md", "LGPL-3.0.txt", "GPL-3.0.txt")],
                }
            else:
                source_identity = bundle.npm_identity(source_path, lock["packages"][source_path])
                source_id = f"{source_identity['name']}@{source_identity['version']}"
                if source_id not in manifest["sources"]:
                    files = []
                    for archive_path, content in archive_licenses(source_identity):
                        digest = hashlib.sha256(content).hexdigest()
                        output = destination / f"{digest}.txt"
                        output.write_bytes(content)
                        files.append(text_record(output, archive_path))
                    manifest["sources"][source_id] = {
                        "kind": "npm-archive", "lock_path": source_path,
                        "package": source_identity, "files": files,
                    }
            records[path] = {"package": identity, "source": source_id}
            if identity["name"].startswith("@img/sharp-") and " AND LGPL-3.0-or-later" in identity["license"]:
                terms_id = "reviewed:LGPL-3.0-terms"
                manifest["sources"][terms_id] = {
                    "kind": "reviewed-upstream-notices",
                    "provenance": "third_party/licenses/npm/README.md",
                    "files": [text_record(ROOT / "third_party/licenses" / name)
                              for name in ("LGPL-3.0.txt", "GPL-3.0.txt")],
                }
                records[path]["supplement_sources"] = [terms_id]
            if identity["name"] == "@img/sharp-wasm32":
                if identity["version"] != "0.35.5":
                    raise RuntimeError("WASM supplement requires a new package review")
                emscripten_id = "reviewed:emscripten@6.0.10"
                manifest["sources"][emscripten_id] = {
                    "kind": "reviewed-upstream-notices",
                    "provenance": f"https://github.com/emscripten-core/emscripten/tree/{EMSCRIPTEN_COMMIT}",
                    "files": emscripten_records(destination),
                }
                records[path]["supplement_sources"].append(emscripten_id)
        if records:
            manifest["packages"][directory] = records
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    refresh()
