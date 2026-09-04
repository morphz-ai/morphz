#!/usr/bin/env python3
"""Build and sign the provider-neutral Morphz Edge release manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import subprocess
from datetime import datetime, timezone


def artifact(value: str) -> dict[str, object]:
    try:
        platform, architecture, path_text, url = value.split("=", 3)
    except ValueError as error:
        raise argparse.ArgumentTypeError(
            "artifact must be PLATFORM=ARCHITECTURE=PATH=HTTPS_URL"
        ) from error
    path = pathlib.Path(path_text)
    if not path.is_file():
        raise argparse.ArgumentTypeError(f"artifact does not exist: {path}")
    if not url.startswith("https://"):
        raise argparse.ArgumentTypeError("artifact URL must use HTTPS")
    content = path.read_bytes()
    item: dict[str, object] = {
        "platform": platform,
        "architecture": architecture,
        "url": url,
        "sha256": hashlib.sha256(content).hexdigest(),
        "size_bytes": len(content),
    }
    if platform == "windows":
        if path.suffix.lower() != ".zip":
            raise argparse.ArgumentTypeError(
                "Windows artifacts must be ZIP bundles containing morphz-edge.exe and its sandbox helpers"
            )
        item["archive_format"] = "zip"
        item["entrypoint"] = "morphz-edge.exe"
    else:
        if not path.name.endswith(".tar.gz"):
            raise argparse.ArgumentTypeError(
                "macOS and Linux artifacts must be tar.gz bundles containing morphz-edge and its license records"
            )
        item["archive_format"] = "tar.gz"
        item["entrypoint"] = "morphz-edge"
    return item


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--signing-key", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument("--artifact", action="append", required=True, type=artifact)
    args = parser.parse_args()
    if not args.signing_key.is_file():
        parser.error("the release signing key does not exist")
    try:
        key_info = subprocess.run(
            ["openssl", "ec", "-in", str(args.signing_key), "-text", "-noout"],
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError:
        parser.error("the release signing key must be an EC private key")
    if "ASN1 OID: prime256v1" not in (key_info.stdout + key_info.stderr):
        parser.error("the release signing key must use P-256 (prime256v1)")
    identities = {(item["platform"], item["architecture"]) for item in args.artifact}
    if len(identities) != len(args.artifact):
        parser.error("each platform/architecture may appear only once")
    manifest = {
        "schema_version": 1,
        "version": args.version,
        "published_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "artifacts": sorted(
            args.artifact,
            key=lambda item: (item["platform"], item["architecture"]),
        ),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    subprocess.run(
        [
            "openssl",
            "dgst",
            "-sha256",
            "-sign",
            str(args.signing_key),
            "-out",
            str(args.output) + ".sig",
            str(args.output),
        ],
        check=True,
    )


if __name__ == "__main__":
    main()
