from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from benchmarks.harbor import run_me08_postfix_targeted as runner


class Me08PostfixTargetedTest(unittest.TestCase):
    def test_runner_materializes_jobs_boundary_before_launch(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            output_root = Path(temp_dir) / "smoke"

            def fake_run(*args, **kwargs):  # type: ignore[no-untyped-def]
                command = args[0]
                if command[:2] == ["git", "rev-parse"]:
                    return type("Completed", (), {"stdout": "test-commit\n"})()
                self.assertTrue((output_root / "jobs").is_dir())
                return type("Completed", (), {"returncode": 2})()

            argv = [
                "run_me08_postfix_targeted.py",
                "smoke",
                "--output-root",
                str(output_root),
            ]
            with (
                patch.object(sys, "argv", argv),
                patch.object(runner.subprocess, "run", side_effect=fake_run),
                patch.object(runner, "sample_resources", return_value=None),
            ):
                self.assertEqual(runner.main(), 2)

            self.assertTrue((output_root / "jobs").is_dir())
            self.assertTrue((output_root / "launcher_result.json").is_file())


if __name__ == "__main__":
    unittest.main()
