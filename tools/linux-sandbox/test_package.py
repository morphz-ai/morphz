"""Release inventory tests; these do not claim native installation success."""
import ast
from pathlib import Path
import tempfile
import unittest

from install import SOURCES
from package import BUNDLE_FILES, stage


class ReleasePackageTests(unittest.TestCase):
    def test_bundle_contains_exact_installer_dependencies_and_no_test_authority(self):
        source = Path(__file__).resolve().parent
        with tempfile.TemporaryDirectory() as directory:
            destination = stage(directory)
            self.assertEqual({p.name for p in destination.iterdir()}, set(BUNDLE_FILES))
            self.assertEqual(set(BUNDLE_FILES),
                             {*SOURCES, "launcher.c", "mounts.c", "mounts.h", "bootstrap.py", "install.py", "INSTALL.md"})
            for name in BUNDLE_FILES:
                self.assertEqual((destination / name).read_bytes(), (source / name).read_bytes())
                self.assertFalse((destination / name).is_symlink())
                self.assertEqual((destination / name).stat().st_mode & 0o777, 0o644)
                if name.endswith(".py"):
                    tree = ast.parse((destination / name).read_text())
                    for node in ast.walk(tree):
                        if isinstance(node, ast.ImportFrom) and node.module:
                            local = source / (node.module + ".py")
                            if local.is_file():
                                self.assertIn(local.name, BUNDLE_FILES)
            with self.assertRaises(FileExistsError):
                stage(directory)

    def test_linux_archives_and_release_gate_include_the_packaged_implementation(self):
        workflow = (Path(__file__).resolve().parents[2] / ".github/workflows/release.yml").read_text()
        bundles = workflow.split("\n  linux-bundles:\n", 1)[1].split("\n  linux-bundle-sandbox:\n", 1)[0]
        self.assertIn("python3 tools/linux-sandbox/package.py dist/morphz-bundle", bundles)
        self.assertIn("python3 tools/linux-sandbox/package.py dist/morphz-edge-bundle", bundles)
        self.assertEqual(bundles.count("dashboard third_party linux-sandbox"), 2)
        gate = workflow.split("\n  linux-bundle-sandbox:\n", 1)[1].split("\n  macos-bundles:\n", 1)[0]
        self.assertIn("needs: linux-bundles", gate)
        self.assertIn("ubuntu-24.04-arm", gate)
        self.assertIn("actions/download-artifact@", gate)
        self.assertIn("--native-linux-sandbox", gate)
        self.assertIn('"$runtime_image/linux-sandbox/install.py"', gate)
        self.assertNotIn("cargo ", gate)
        self.assertNotIn("continue-on-error", gate)
        self.assertNotIn("sysctl -w", gate)
        publish = workflow.split("\n  publish:\n", 1)[1]
        self.assertIn("linux-bundle-sandbox", publish.split("\n    runs-on:", 1)[0])


if __name__ == "__main__":
    unittest.main()
