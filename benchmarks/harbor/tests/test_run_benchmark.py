from __future__ import annotations

import argparse
import os
import unittest
from pathlib import Path
from unittest.mock import patch

from benchmarks.harbor.run_benchmark import (
    expected_job_shape,
    harbor_command,
    runtime_provider_config,
    runtime_version,
)


class HarborCommandTest(unittest.TestCase):
    def test_cloud_provider_route_requires_no_host_morphz_config(self) -> None:
        environment = {
            "MORPHZ_PROVIDER_BASE_URL": "http://10.0.0.4:8317/v1",
            "MORPHZ_PROVIDER_PROTOCOL": "openai-responses",
            "MORPHZ_PROVIDER_API_KEY": "test-only",
        }
        with patch.dict(os.environ, environment, clear=True):
            self.assertEqual(
                runtime_provider_config(),
                (
                    "http://10.0.0.4:8317/v1",
                    "openai-responses",
                    "test-only",
                ),
            )

    def test_cloud_provider_route_requires_explicit_api_key(self) -> None:
        with patch.dict(
            os.environ,
            {"MORPHZ_PROVIDER_BASE_URL": "http://10.0.0.4:8317/v1"},
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "MORPHZ_PROVIDER_API_KEY"):
                runtime_provider_config()

    def test_runtime_identity_comes_from_lock(self) -> None:
        self.assertEqual(
            runtime_version(
                {
                    "runtime": {
                        "git_tag": "paper-eval-runtime-v4",
                        "git_commit": "abc123",
                    }
                }
            ),
            "paper-eval-runtime-v4@abc123",
        )

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

    def test_expected_job_shape_requires_every_fixed_pilot_trial(self) -> None:
        args = argparse.Namespace(
            attempts=1,
            limit=None,
            task=["git-multibranch", "db-wal-recovery"],
        )
        count, tasks = expected_job_shape(
            args, {"terminal_bench": {"task_count": 89}}
        )
        self.assertEqual(count, 2)
        self.assertEqual(tasks, {"git-multibranch", "db-wal-recovery"})

    def test_expected_job_shape_uses_locked_full_dataset_count(self) -> None:
        args = argparse.Namespace(attempts=5, limit=None, task=[])
        count, tasks = expected_job_shape(
            args, {"terminal_bench": {"task_count": 89}}
        )
        self.assertEqual(count, 445)
        self.assertIsNone(tasks)


if __name__ == "__main__":
    unittest.main()
