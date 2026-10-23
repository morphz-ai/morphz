"""Use real staged files to keep diagnostics out of public release assets."""

import hashlib
import importlib.util
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "scripts/verify-release-assets.py"
SPEC = importlib.util.spec_from_file_location("release_assets", HELPER)
ASSETS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ASSETS)


class ReleaseAssetTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="morphz release assets ")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name) / "dist"
        self.directory.mkdir()
        for name in ASSETS.ARCHIVES:
            content = ("synthetic archive bytes: " + name).encode()
            (self.directory / name).write_bytes(content)
            digest = hashlib.sha256(content).hexdigest()
            (self.directory / (name + ".sha256")).write_text(f"{digest}  {name}\n", encoding="ascii")
        for name in ("install.sh", "install.ps1", "release-ci-admission.json"):
            (self.directory / name).write_text("synthetic public fixture\n", encoding="utf8")

    def cli(self):
        return subprocess.run([sys.executable, "-B", str(HELPER), str(self.directory)],
                              capture_output=True, text=True)

    def assert_rejected(self, message):
        with self.assertRaisesRegex(ASSETS.AssetError, message):
            ASSETS.verify(self.directory)
        result = self.cli()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "", "A rejected inventory must never emit partial upload arguments")
        self.assertIn("Release assets rejected", result.stderr)

    def test_exact_inventory_is_23_regular_files_and_cli_keeps_spaces_in_paths(self):
        assets = ASSETS.verify(self.directory)
        self.assertEqual(len(assets), 23)
        self.assertEqual(len(set(assets)), 23)
        self.assertEqual({asset.name for asset in assets}, set(ASSETS.ASSETS))
        self.assertEqual(sum(name.endswith((".tar.gz", ".zip")) for name in ASSETS.ASSETS), 10)
        self.assertEqual(sum(name.endswith(".sha256") for name in ASSETS.ASSETS), 10)
        result = self.cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), [str(asset) for asset in assets])

    def test_unexpected_diagnostic_file_is_not_published(self):
        (self.directory / "native-admission.log").write_text("synthetic private diagnostic")
        self.assert_rejected("unexpected=.*native-admission")

    def test_unexpected_diagnostic_directory_is_not_published(self):
        diagnostics = self.directory / "installed-sandbox-evidence"
        diagnostics.mkdir()
        (diagnostics / "service.log").write_text("synthetic diagnostic")
        self.assert_rejected("unexpected=.*installed-sandbox-evidence")

    def test_each_missing_expected_file_is_rejected(self):
        for name in ASSETS.ASSETS:
            with self.subTest(name=name):
                file = self.directory / name
                content = file.read_bytes()
                file.unlink()
                with self.assertRaisesRegex(ASSETS.AssetError, "missing="):
                    ASSETS.verify(self.directory)
                file.write_bytes(content)

    def test_expected_archive_name_cannot_hide_a_directory(self):
        archive = self.directory / ASSETS.ARCHIVES[0]
        archive.unlink()
        archive.mkdir()
        self.assert_rejected("regular file")

    def test_symlink_archive_checksum_installer_and_receipt_are_rejected(self):
        target = self.directory.parent / "outside"
        target.write_text("synthetic outside file")
        for name in (ASSETS.ARCHIVES[0], ASSETS.ARCHIVES[0] + ".sha256", "install.sh", "release-ci-admission.json"):
            with self.subTest(name=name):
                file = self.directory / name
                content = file.read_bytes()
                file.unlink()
                file.symlink_to(target)
                with self.assertRaisesRegex(ASSETS.AssetError, "regular file"):
                    ASSETS.verify(self.directory)
                file.unlink()
                file.write_bytes(content)

    def test_root_cannot_be_a_symlink(self):
        alias = self.directory.parent / "dist-alias"
        alias.symlink_to(self.directory, target_is_directory=True)
        with self.assertRaisesRegex(ASSETS.AssetError, "real directory"):
            ASSETS.verify(alias)

    def test_mutated_archive_fails_real_sha256_verification(self):
        with (self.directory / ASSETS.ARCHIVES[0]).open("ab") as archive:
            archive.write(b"changed bytes")
        self.assert_rejected("checksum mismatch")

    def test_real_producer_checksum_record_formats_are_accepted(self):
        for index, name in enumerate(ASSETS.ARCHIVES):
            file = self.directory / (name + ".sha256")
            record = file.read_text().rstrip("\n")
            # Unix shasum emits a newline, PowerShell emits none; binary-mode
            # sha256sum uses '*'. All still bind exactly the intended archive.
            if name.endswith(".zip"):
                file.write_text(record, encoding="ascii")
            elif index % 2:
                file.write_bytes((record.replace("  ", " *") + "\r\n").encode("ascii"))
        self.assertEqual(len(ASSETS.verify(self.directory)), 23)

    def test_checksum_record_cannot_refer_to_another_file_or_multiple_records(self):
        name = ASSETS.ARCHIVES[0]
        file = self.directory / (name + ".sha256")
        original = file.read_text()
        for content in (original.replace(name, "../different.tar.gz"), original + original,
                        "0" * 64, original.replace("  ", " "), "not-a-digest  " + name):
            with self.subTest(content=content):
                file.write_text(content)
                with self.assertRaisesRegex(ASSETS.AssetError, "exact archive"):
                    ASSETS.verify(self.directory)
        file.write_text(original)

    def test_empty_asset_and_large_or_nonascii_checksum_are_rejected(self):
        name = ASSETS.ARCHIVES[0] + ".sha256"
        checksum = self.directory / name
        for content, message in ((b"", "nonempty regular file"), (b"x" * 4097, "too large"),
                                 (b"\xff", "must be ASCII")):
            with self.subTest(message=message):
                checksum.write_bytes(content)
                with self.assertRaisesRegex(ASSETS.AssetError, message):
                    ASSETS.verify(self.directory)

    def test_plain_command_exit_is_not_hidden_before_bash_upload_array(self):
        # Execute the same producer-before-mapfile boundary used in publish.
        # A corrupt inventory must stop bash before any would-upload command.
        (self.directory / ASSETS.ARCHIVES[0]).write_bytes(b"corrupted")
        listing = self.directory.parent / "assets.txt"
        command = (f"{shlex.quote(sys.executable)} -B {shlex.quote(str(HELPER))} "
                   f"{shlex.quote(str(self.directory))} > {shlex.quote(str(listing))}\n"
                   f"mapfile -t release_assets < {shlex.quote(str(listing))}\n"
                   "printf 'would-upload %s\\n' \"${release_assets[@]}\"\n")
        result = subprocess.run(["bash", "-euo", "pipefail", "-c", command], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("checksum mismatch", result.stderr)


if __name__ == "__main__":
    unittest.main()
