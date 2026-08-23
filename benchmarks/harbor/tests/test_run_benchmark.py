from __future__ import annotations

import argparse
import os
import unittest
from pathlib import Path
from unittest.mock import patch

from benchmarks.harbor.run_benchmark import (
    expected_job_shape,
    formal_run_intent_error,
    frozen_run_identity,
    harbor_command,
    parse_args,
    runtime_provider_config,
    runtime_version,
)


class HarborCommandTest(unittest.TestCase):
    @patch("sys.argv", ["run_benchmark.py", "full"])
    def test_full_parser_defaults_to_single_diagnostic_attempt(self) -> None:
        args = parse_args()
        self.assertEqual(args.attempts, 1)
        self.assertFalse(args.confirm_89x5_formal)

    @patch(
        "sys.argv",
        [
            "run_benchmark.py",
            "full",
            "--attempts",
            "5",
            "--confirm-89x5-formal",
        ],
    )
    def test_parser_accepts_explicitly_confirmed_formal_shape(self) -> None:
        args = parse_args()
        self.assertEqual(args.attempts, 5)
        self.assertTrue(args.confirm_89x5_formal)

    @patch(
        "sys.argv",
        ["run_benchmark.py", "full", "--attempts", "5"],
    )
    def test_parser_rejects_unconfirmed_formal_shape(self) -> None:
        with self.assertRaises(SystemExit) as context:
            parse_args()
        self.assertEqual(context.exception.code, 2)

    def test_diagnostic_89x1_does_not_require_formal_confirmation(self) -> None:
        args = argparse.Namespace(
            mode="full",
            attempts=1,
            task=[],
            limit=None,
            confirm_89x5_formal=False,
        )
        self.assertIsNone(formal_run_intent_error(args))

    def test_unconfirmed_multi_attempt_run_is_rejected(self) -> None:
        args = argparse.Namespace(
            mode="full",
            attempts=5,
            task=[],
            limit=None,
            confirm_89x5_formal=False,
        )
        self.assertIn("blocked by default", formal_run_intent_error(args) or "")

    def test_confirmed_89x5_formal_run_is_accepted(self) -> None:
        args = argparse.Namespace(
            mode="full",
            attempts=5,
            task=[],
            limit=None,
            confirm_89x5_formal=True,
        )
        self.assertIsNone(formal_run_intent_error(args))

    def test_confirmation_cannot_bypass_exact_formal_shape(self) -> None:
        args = argparse.Namespace(
            mode="full",
            attempts=5,
            task=["git-multibranch"],
            limit=None,
            confirm_89x5_formal=True,
        )
        self.assertIn("complete unfiltered", formal_run_intent_error(args) or "")

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

    @patch(
        "benchmarks.harbor.run_benchmark.infrastructure_identity",
        return_value={
            "infrastructure_git_commit": "infra123",
            "infrastructure_git_tags": ["pilot-v5"],
            "infrastructure_tracked_clean": True,
        },
    )
    def test_frozen_run_identity_records_every_result_variable(
        self, _identity: object
    ) -> None:
        args = argparse.Namespace(
            attempts=1,
            concurrency=5,
            task=["db-wal-recovery", "git-multibranch"],
        )
        lock = {
            "runtime": {
                "git_tag": "paper-eval-runtime-v4",
                "git_commit": "runtime123",
                "binary_sha256": "binary-sha",
                "watcher_sha256": "watcher-sha",
            },
            "terminal_bench": {
                "dataset": "terminal-bench/terminal-bench-2-1",
                "registry_ref": "sha256:dataset",
                "source_commit": "dataset123",
            },
            "model": {
                "physical_model": "gpt-5.6-sol",
                "reasoning_effort": "max",
                "fallback": False,
            },
            "permissions": {"mode": "full_access"},
        }

        identity = frozen_run_identity(args, lock)

        self.assertEqual(identity["infrastructure_git_commit"], "infra123")
        self.assertEqual(identity["runtime_git_commit"], "runtime123")
        self.assertEqual(identity["dataset_registry_ref"], "sha256:dataset")
        self.assertEqual(identity["model"], "gpt-5.6-sol")
        self.assertEqual(identity["concurrency"], 5)
        self.assertEqual(identity["max_retries"], 0)
        self.assertEqual(
            identity["task_filters"], ["db-wal-recovery", "git-multibranch"]
        )


if __name__ == "__main__":
    unittest.main()
