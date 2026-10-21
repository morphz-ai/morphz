"""Pure inventory/hash checks; installation and execution need isolated Linux."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from stage_runtime_tests import SANDBOX_TEST_TARGETS, selected_artifacts
from run_runtime_test import select_executable


def artifact(name, kind, test=True):
    return json.dumps({"reason": "compiler-artifact", "executable": f"/tmp/{name}-native",
                       "profile": {"test": test}, "target": {"name": name, "kind": [kind]}})


class CiStagingTests(unittest.TestCase):
    def test_only_exact_native_test_targets_are_selected(self):
        original = [artifact("morphz", "lib"), artifact("native_sandbox_contract", "test")]
        self.assertEqual(set(selected_artifacts(original)), {"lib", "native"})
        unrelated = [artifact("python3", "bin"), artifact("shell", "test"), artifact("morphz", "bin", False)]
        self.assertEqual(selected_artifacts(original + unrelated), selected_artifacts(original))
        for bad in (original[:1], original + original[:1],
                    [original[0], artifact("native_sandbox_contract", "bin")]):
            with self.assertRaises(ValueError):
                selected_artifacts(bad)
        with self.assertRaises(ValueError):
            selected_artifacts(original, workspace=True)
        complete = [artifact("morphz", "lib"), *[artifact(name, "test") for name in SANDBOX_TEST_TARGETS]]
        self.assertEqual(len(selected_artifacts(complete, workspace=True)), len(SANDBOX_TEST_TARGETS) + 1)

    def test_stale_source_or_installed_binary_never_runs_as_a_new_build(self):
        with tempfile.TemporaryDirectory() as directory:
            source, installed, other = [Path(directory) / name for name in ("cargo-test", "installed", "other")]
            for path in (source, installed, other):
                path.write_bytes(b"same fixture bytes")
            manifest = {"version": 1, "entries": {str(source.resolve()): {
                "installed": str(installed), "sha256": hashlib.sha256(source.read_bytes()).hexdigest()}}}
            self.assertEqual(select_executable(source, manifest), str(installed))
            self.assertEqual(select_executable(other, manifest), str(other.resolve()))
            source.write_bytes(b"new build")
            with self.assertRaisesRegex(ValueError, "differs"):
                select_executable(source, manifest)
            source.write_bytes(b"same fixture bytes")
            installed.write_bytes(b"changed installed image")
            with self.assertRaisesRegex(ValueError, "differs"):
                select_executable(source, manifest)


if __name__ == "__main__":
    unittest.main()
