from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from benchmarks.harbor import run_contextdb_me08_ab as runner


class ContextDbMe08AbTest(unittest.TestCase):
    def test_pilot_is_the_frozen_first_eight_me08_tasks(self) -> None:
        self.assertEqual(runner.load_pilot_tasks(), runner.load_all_tasks()[:8])
        self.assertEqual(len(runner.load_pilot_tasks()), 8)

    def test_each_arm_keeps_eight_isolated_trials(self) -> None:
        tasks = runner.load_pilot_tasks()
        command = runner.arm_command(
            arm="contextdb",
            tasks=tasks,
            jobs_dir=Path("/tmp/jobs"),
            binary=Path("/tmp/morphz"),
            watcher=Path("/tmp/morphz-harbor-wait"),
            toolchain_lock=Path("/tmp/contextdb.lock.json"),
        )
        self.assertEqual(command[command.index("--concurrency") + 1], "8")
        self.assertEqual(command[command.index("--context-store") + 1], "contextdb")
        self.assertEqual(command[command.index("--expect-trials") + 1], "8")

    def test_toolchain_locks_bind_features_and_exact_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            binary = root / "morphz"
            watcher = root / "watcher"
            binary.write_bytes(b"contextdb-binary")
            watcher.write_bytes(b"watcher")
            base = {
                "terminal_bench": {"task_count": 89},
                "model": {"physical_model": "gpt-5.6-sol"},
                "permissions": {"mode": "full_access"},
            }
            legacy = runner.build_toolchain_lock(
                base,
                arm="legacy",
                commit="a" * 40,
                binary=binary,
                watcher=watcher,
            )
            contextdb = runner.build_toolchain_lock(
                base,
                arm="contextdb",
                commit="a" * 40,
                binary=binary,
                watcher=watcher,
            )
            self.assertEqual(legacy["runtime"]["build_features"], [])
            self.assertEqual(
                contextdb["runtime"]["build_features"],
                ["experimental-context-db"],
            )
            self.assertEqual(
                contextdb["runtime"]["binary_sha256"],
                runner.sha256_file(binary),
            )


if __name__ == "__main__":
    unittest.main()
