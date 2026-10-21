"""Pure inventory/hash checks; installation and execution need isolated Linux."""
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

from stage_runtime_tests import SANDBOX_TEST_TARGETS, selected_artifacts
from run_runtime_test import select_executable


def artifact(name, kind, test=True):
    return json.dumps({"reason": "compiler-artifact", "executable": f"/tmp/{name}-native",
                       "profile": {"test": test}, "target": {"name": name, "kind": [kind]}})


class CiStagingTests(unittest.TestCase):
    def test_release_keeps_the_installed_runtime_and_real_kernel_gates(self):
        workflows = Path(__file__).resolve().parents[2] / ".github/workflows"
        release = (workflows / "release.yml").read_text()
        self.assertNotIn("sysctl -w", release)
        self.assertIn("    uses: ./.github/workflows/linux-sandbox-service.yml", release)
        self.assertIn("  workflow_call:\n", (workflows / "linux-sandbox-service.yml").read_text())
        self.assertIn("needs: [release-readiness, session-io, linux-sandbox,", release)
        readiness = release.split("\n  release-readiness:\n", 1)[1].split("\n  linux-bundles:\n", 1)[0]
        self.assertIn("MORPHZ_REQUIRE_LINUX_SANDBOX_ATTACK_TEST: \"1\"", readiness)
        self.assertIn("MORPHZ_LINUX_SANDBOX_TEST=1", readiness)
        self.assertIn("stage_runtime_tests.py", readiness)
        self.assertIn("--install-service", readiness)
        self.assertIn("CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER:", readiness)
        self.assertIn("run_runtime_test.py", readiness)
        targets = "--lib --bin morphz --test session_io --test native_sandbox_contract"
        self.assertIn(targets + " --no-run --message-format=json", readiness)
        self.assertIn(targets + " --no-fail-fast -- --test-threads=1", readiness)
        self.assertNotIn("continue-on-error", readiness)

    def test_logged_native_failure_fails_the_actual_workflow_command(self):
        workflow = (Path(__file__).resolve().parents[2] /
                    ".github/workflows/linux-sandbox-service.yml").read_text()
        step = workflow.split(
            "      - name: Verify actual Runtime command admission and post-admission protected paths\n", 1
        )[1].split("\n      - ", 1)[0]
        self.assertIn("        shell: bash\n", step)
        self.assertNotIn("continue-on-error", step)
        command = step.split("        run: ", 1)[1].strip()
        native = "/usr/local/libexec/morphz-runtime-ci/native"
        self.assertEqual(command.count(native), 1)
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "native-test-fixture"
            executable.write_text('#!/bin/sh\nprintf "native fixture output\\n"\nexit "$FIXTURE_EXIT"\n')
            executable.chmod(0o700)
            for code in (7, 0):
                # This is GitHub's explicit `shell: bash` invocation, not the
                # implicit bash -e shell that loses the producer's exit status.
                result = subprocess.run(
                    ["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c",
                     command.replace(native, shlex.quote(str(executable)))],
                    env={**os.environ, "RUNNER_TEMP": directory, "FIXTURE_EXIT": str(code)},
                    capture_output=True, text=True, check=False,
                )
                self.assertEqual(result.returncode, code, result.stderr)
                self.assertEqual((Path(directory) / "native-admission.log").read_text(),
                                 "native fixture output\n")

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
