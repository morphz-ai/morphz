from __future__ import annotations

import argparse
import unittest
from pathlib import Path

from benchmarks.harbor.run_benchmark import harbor_command


class HarborCommandTest(unittest.TestCase):
    def test_emits_each_precommitted_task_filter(self) -> None:
        args = argparse.Namespace(
            jobs_dir=Path("jobs"),
            attempts=1,
            concurrency=1,
            dataset_path=None,
            limit=None,
            task=["git-multibranch", "db-wal-recovery"],
            upload=False,
            public=False,
        )
        lock = {
            "terminal_bench": {
                "dataset": "terminal-bench/terminal-bench-2-1",
                "registry_ref": "sha256:test",
            }
        }

        command = harbor_command(args, lock)

        filters = [
            command[index + 1]
            for index, value in enumerate(command)
            if value == "--include-task-name"
        ]
        self.assertEqual(
            filters,
            ["terminal-bench/git-multibranch", "terminal-bench/db-wal-recovery"],
        )


if __name__ == "__main__":
    unittest.main()
