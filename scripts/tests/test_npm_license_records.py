import base64
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]
ROOT = SCRIPTS.parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


bundle = module("bundle", "generate-third-party-licenses.py")
refresh = module("refresh", "update-npm-license-records.py")


class NpmLicenseRecordsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="morphz-license-records-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        shutil.copytree(ROOT / "third_party/licenses", self.root / "third_party/licenses")
        original = json.loads((ROOT / "application/package-lock.json").read_text())
        self.lock = {"packages": {
            key: value for key, value in original["packages"].items()
            if key.startswith("node_modules/") and value.get("optional") and not value.get("dev", False)
        }}
        (self.root / "application").mkdir()
        (self.root / "application/package-lock.json").write_text(json.dumps(self.lock))
        self.manifest_path = self.root / bundle.NPM_LICENSE_RECORDS
        self.manifest = json.loads(self.manifest_path.read_text())
        mocked_root = patch.object(bundle, "REPOSITORY_ROOT", self.root)
        mocked_root.start()
        self.addCleanup(mocked_root.stop)

    def test_same_bundle_with_macos_linux_windows_or_no_optional_installations(self):
        outputs = []
        for platform in ("darwin", "linux", "win32", None):
            installed = self.root / "application/node_modules"
            if installed.exists():
                shutil.rmtree(installed)
            for path in self.lock["packages"]:
                if platform is not None and platform in path:
                    directory = self.root / "application" / path
                    directory.mkdir(parents=True)
                    (directory / "LICENSE").write_text("Host installation must not choose this text")
            output = bundle.render_bundle("test", "test", bundle.npm_packages("application"))
            self.assertNotIn("Host installation must not choose this text", output)
            outputs.append(output)
        self.assertTrue(all(output == outputs[0] for output in outputs))

    def test_locked_package_identity_and_integrity_changes_are_rejected(self):
        path = "node_modules/@emnapi/runtime"
        for field in ("name", "version", "license", "resolved", "integrity"):
            with self.subTest(field=field):
                changed = copy.deepcopy(self.lock)
                changed["packages"][path][field] = "changed"
                with self.assertRaisesRegex(RuntimeError, "locked identity/integrity"):
                    bundle.npm_optional_license_files("application", changed)

    def test_new_removed_and_unrecorded_optional_packages_require_refresh(self):
        changed = copy.deepcopy(self.lock)
        changed["packages"]["node_modules/new-native"] = changed["packages"].pop("node_modules/@emnapi/runtime")
        with self.assertRaisesRegex(RuntimeError, "do not match lockfile"):
            bundle.npm_optional_license_files("application", changed)

    def test_source_package_identity_cannot_drift_from_lock(self):
        self.manifest["sources"]["@napi-rs/canvas@1.0.8"]["package"]["integrity"] = "changed"
        self.manifest_path.write_text(json.dumps(self.manifest))
        with self.assertRaisesRegex(RuntimeError, "source differs from lockfile"):
            bundle.npm_optional_license_files("application", self.lock)

    def test_corrupt_missing_or_escaping_text_cannot_fall_back_to_template(self):
        source = self.manifest["sources"]["@emnapi/runtime@1.11.3"]
        entry = source["files"][0]
        license_path = self.root / entry["path"]
        original = license_path.read_bytes()
        license_path.write_bytes(original + b"\nchanged")
        with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
            bundle.npm_optional_license_files("application", self.lock)
        license_path.unlink()
        with self.assertRaisesRegex(RuntimeError, "missing/oversized"):
            bundle.npm_optional_license_files("application", self.lock)
        entry["path"] = "../outside-license"
        self.manifest_path.write_text(json.dumps(self.manifest))
        with self.assertRaisesRegex(RuntimeError, "unsafe"):
            bundle.npm_optional_license_files("application", self.lock)

    def test_combined_sharp_notices_and_actual_canvas_author_are_preserved(self):
        paths = bundle.npm_optional_license_files("application", self.lock)
        for platform in ("win32-arm64", "win32-ia32", "win32-x64", "wasm32"):
            with self.subTest(platform=platform):
                text = "\n".join(path.read_text() for path in paths[f"node_modules/@img/sharp-{platform}"])
                self.assertIn("Apache License", text)
                self.assertIn("GNU LESSER GENERAL PUBLIC LICENSE", text)
                if platform == "wasm32":
                    self.assertIn("Permission is hereby granted", text)
        canvas = "\n".join(path.read_text() for path in paths["node_modules/@napi-rs/canvas-linux-x64-gnu"])
        self.assertIn("Copyright (c) 2020 lynweklm@gmail.com", canvas)
        self.assertEqual(paths["node_modules/@napi-rs/canvas"], paths["node_modules/@napi-rs/canvas-linux-x64-gnu"])

    def test_existing_libvips_audit_stays_distinct_from_direct_archive_evidence(self):
        record = self.manifest["packages"]["application"]["node_modules/@img/sharp-libvips-linux-x64"]
        source = self.manifest["sources"][record["source"]]
        self.assertEqual(source["kind"], "reviewed-upstream-notices")
        self.assertEqual(len(source["files"]), 3)
        self.assertIn("SOURCE.md", source["provenance"])
        source = self.manifest["sources"]["@img/sharp-linux-x64@0.35.5"]
        self.assertEqual(source["kind"], "npm-archive")
        self.assertTrue(source["package"]["integrity"].startswith("sha512-"))
        self.assertTrue(all(entry["archive_path"].startswith("package/") for entry in source["files"]))

    def test_dashboard_without_production_optional_packages_does_not_need_records(self):
        self.assertEqual(bundle.npm_optional_license_files("dashboard", {"packages": {}}), {})


class ArchiveVerificationTest(unittest.TestCase):
    def test_git_windows_checkout_preserves_integrity_pinned_license_bytes(self):
        # core.autocrlf is independent of npm's platform selection. Exercise a
        # real Git checkout, or the blob checks could fail only on Windows.
        with tempfile.TemporaryDirectory(prefix="morphz-license-checkout-") as temp:
            root = Path(temp)
            source = root / "source"
            source.mkdir()
            subprocess.run(["git", "init", "-q", str(source)], check=True)
            files = [
                "third_party/licenses/.gitattributes",
                "third_party/licenses/LGPL-3.0.txt",
                "third_party/licenses/npm/dc1f5d2d43c5531dfe0acaf4e950ea5dbe3e61e1850cf0e983bda7efc10d6693.txt",
            ]
            for name in files:
                destination = source / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / name, destination)
            subprocess.run(["git", "-c", "core.autocrlf=true", "add", "."], cwd=source, check=True, capture_output=True)
            checkout = root / "checkout"
            subprocess.run([
                "git", "-c", "core.autocrlf=true", "checkout-index", "--all",
                f"--prefix={checkout}/",
            ], cwd=source, check=True, capture_output=True)
            for name in files[1:]:
                self.assertEqual((checkout / name).read_bytes(), (ROOT / name).read_bytes())

    def test_exact_archive_bytes_must_match_locked_sha512(self):
        raw = b"official package archive bytes"
        digest = hashlib.sha512(raw).digest()
        integrity = "sha512-" + base64.b64encode(digest).decode()
        refresh.verify_integrity(digest, integrity)
        with self.assertRaisesRegex(RuntimeError, "integrity mismatch"):
            refresh.verify_integrity(hashlib.sha512(raw + b"tampered").digest(), integrity)
        with self.assertRaisesRegex(RuntimeError, "unsupported SRI"):
            refresh.verify_integrity(digest, "sha256-" + base64.b64encode(digest).decode())

    def test_archive_reader_retains_nested_notices_without_extracting_binaries(self):
        identity = {"name": "fixture", "version": "1.0.0", "license": "Apache-2.0 AND MIT"}
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w:gz") as tar:
            for name, content in (
                ("package/package.json", json.dumps(identity).encode()),
                ("package/LICENSE", b"Apache text"),
                ("package/vendor/NOTICE", b"MIT author"),
                ("package/native.node", b"not executable by this reader"),
                ("../LICENSE", b"unsafe outside path"),
            ):
                member = tarfile.TarInfo(name)
                member.size = len(content)
                tar.addfile(member, io.BytesIO(content))
        raw = output.getvalue()
        self.assertEqual(refresh.extract_licenses(io.BytesIO(raw), identity), [
            ("package/LICENSE", b"Apache text"),
            ("package/vendor/NOTICE", b"MIT author"),
        ])
        with self.assertRaisesRegex(RuntimeError, "metadata differs"):
            refresh.extract_licenses(io.BytesIO(raw), {**identity, "version": "2.0.0"})


if __name__ == "__main__":
    unittest.main()
