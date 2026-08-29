from __future__ import annotations

import argparse
import io
import json
import os
import subprocess
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

from benchmarks.harbor.run_benchmark import (
    expected_trial_count_error,
    expected_job_shape,
    formal_run_intent_error,
    frozen_run_identity,
    harbor_command,
    parse_args,
    provider_ipv4_base_url,
    provider_model_preflight,
    provider_prompt_cache_strategy,
    require_docker_network_capacity,
    runtime_provider_config,
    runtime_provider_model,
    runtime_version,
)


class HarborCommandTest(unittest.TestCase):
    def test_docker_network_capacity_probe_creates_and_removes_every_slot(self) -> None:
        commands: list[list[str]] = []

        def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
            commands.append(command)
            return subprocess.CompletedProcess(command, 0, stdout="network-id\n", stderr="")

        with patch(
            "benchmarks.harbor.run_benchmark.subprocess.run", side_effect=run
        ):
            require_docker_network_capacity(8)

        creates = [command for command in commands if command[1:3] == ["network", "create"]]
        removes = [command for command in commands if command[1:3] == ["network", "rm"]]
        self.assertEqual(len(creates), 8)
        self.assertEqual(len(removes), 8)
        self.assertEqual(
            {command[-1] for command in creates},
            {command[-1] for command in removes},
        )

    def test_docker_network_capacity_probe_fails_closed_and_cleans_partial_set(self) -> None:
        commands: list[list[str]] = []
        create_count = 0

        def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
            nonlocal create_count
            commands.append(command)
            if command[1:3] == ["network", "create"]:
                create_count += 1
                if create_count == 4:
                    return subprocess.CompletedProcess(
                        command, 1, stdout="", stderr="address pool exhausted"
                    )
            return subprocess.CompletedProcess(command, 0, stdout="network-id\n", stderr="")

        with patch(
            "benchmarks.harbor.run_benchmark.subprocess.run", side_effect=run
        ):
            with self.assertRaisesRegex(RuntimeError, "only 3 of 8"):
                require_docker_network_capacity(8)

        removes = [command for command in commands if command[1:3] == ["network", "rm"]]
        self.assertEqual(len(removes), 3)

    def test_model_run_requires_acknowledged_trial_count(self) -> None:
        args = argparse.Namespace(mode="full", expect_trials=None)
        self.assertIn(
            "require --expect-trials",
            expected_trial_count_error(args, 20) or "",
        )

    def test_acknowledged_trial_count_must_match_resolution(self) -> None:
        args = argparse.Namespace(mode="full", expect_trials=20)
        self.assertIn(
            "resolved 89",
            expected_trial_count_error(args, 89) or "",
        )

    def test_matching_trial_count_is_accepted(self) -> None:
        args = argparse.Namespace(mode="full", expect_trials=20)
        self.assertIsNone(expected_trial_count_error(args, 20))

    @patch("sys.argv", ["run_benchmark.py", "full"])
    def test_full_parser_defaults_to_single_diagnostic_attempt(self) -> None:
        args = parse_args()
        self.assertEqual(args.attempts, 1)
        self.assertFalse(args.confirm_89x5_formal)
        self.assertIsNone(args.expect_trials)

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

    def test_provider_model_uses_exact_environment_identifier(self) -> None:
        with patch.dict(
            os.environ,
            {"MORPHZ_PROVIDER_MODEL": "openai/gpt-5.6-sol"},
            clear=True,
        ):
            self.assertEqual(runtime_provider_model(), "openai/gpt-5.6-sol")

    def test_provider_model_preflight_falls_back_to_responses_on_405(self) -> None:
        catalog_error = urllib.error.HTTPError(
            "https://provider.invalid/v1/models",
            405,
            "Method Not Allowed",
            {},
            io.BytesIO(b"{}"),
        )
        response = unittest.mock.MagicMock()
        response.__enter__.return_value = io.BytesIO(
            json.dumps(
                {
                    "model": "openai/gpt-5.6-sol",
                    "status": "completed",
                }
            ).encode()
        )
        with patch(
            "benchmarks.harbor.run_benchmark.urllib.request.urlopen",
            side_effect=[catalog_error, response],
        ):
            method = provider_model_preflight(
                "https://provider.invalid/v1",
                "test-key",
                "openai/gpt-5.6-sol",
            )
        self.assertEqual(method, "responses")

    @patch(
        "benchmarks.harbor.run_benchmark.socket.getaddrinfo",
        return_value=[(2, 1, 6, "", ("104.18.6.192", 443))],
    )
    def test_https_provider_keeps_hostname_for_tls_while_recording_ipv4(
        self, _resolve: object
    ) -> None:
        effective, host, address = provider_ipv4_base_url(
            "https://api.openai.com/v1"
        )
        self.assertEqual(effective, "https://api.openai.com/v1")
        self.assertEqual(host, "api.openai.com")
        self.assertEqual(address, "104.18.6.192")

    def test_prompt_cache_strategy_is_exact_endpoint_or_operator_declared(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(
                provider_prompt_cache_strategy(
                    "https://api.openai.com/v1", "openai-responses"
                ),
                "explicit-content-boundaries",
            )
            self.assertEqual(
                provider_prompt_cache_strategy(
                    "http://172.17.0.1:8317/v1", "openai-responses"
                ),
                "auto",
            )
        with patch.dict(
            os.environ,
            {"MORPHZ_PROMPT_CACHE_STRATEGY": "implicit-message-boundaries"},
            clear=True,
        ):
            self.assertEqual(
                provider_prompt_cache_strategy(
                    "http://172.17.0.1:8317/v1", "openai-responses"
                ),
                "implicit-message-boundaries",
            )

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
            harness_mode="bound",
            harness_profile="dialectical-practice-v0.1",
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
            "harness_profiles": {
                "dialectical-practice-v0.1": {
                    "id": "terminal-task-dialectical-practice",
                    "version": "0.1.0",
                    "artifact_hash": "sha256:harness",
                    "source_sha256": "sha256:source",
                }
            },
        }

        identity = frozen_run_identity(args, lock)

        self.assertEqual(identity["infrastructure_git_commit"], "infra123")
        self.assertEqual(identity["runtime_git_commit"], "runtime123")
        self.assertEqual(identity["dataset_registry_ref"], "sha256:dataset")
        self.assertEqual(identity["model"], "gpt-5.6-sol")
        self.assertEqual(identity["concurrency"], 5)
        self.assertEqual(identity["max_retries"], 0)
        self.assertEqual(
            identity["harness"]["id"], "terminal-task-dialectical-practice"
        )
        self.assertEqual(
            identity["harness"]["artifact_hash"], "sha256:harness"
        )
        self.assertEqual(
            identity["task_filters"], ["db-wal-recovery", "git-multibranch"]
        )

    @patch(
        "benchmarks.harbor.run_benchmark.infrastructure_identity",
        return_value={
            "infrastructure_git_commit": "infra123",
            "infrastructure_git_tags": [],
            "infrastructure_tracked_clean": True,
        },
    )
    def test_native_control_identity_records_no_harness(
        self, _identity: object
    ) -> None:
        args = argparse.Namespace(
            attempts=1,
            concurrency=1,
            harness_mode="none",
            task=["raman-fitting"],
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
            "harness": {
                "id": "terminal-task",
                "version": "0.4.0",
                "artifact_hash": "sha256:harness",
                "source_sha256": "sha256:source",
            },
        }

        identity = frozen_run_identity(args, lock)

        self.assertEqual(identity["harness_mode"], "none")
        self.assertIsNone(identity["harness"])

    @patch(
        "benchmarks.harbor.run_benchmark.infrastructure_identity",
        return_value={
            "infrastructure_git_commit": "infra123",
            "infrastructure_git_tags": [],
            "infrastructure_tracked_clean": True,
        },
    )
    def test_bound_identity_requires_an_explicit_profile(
        self, _identity: object
    ) -> None:
        args = argparse.Namespace(
            attempts=1,
            concurrency=1,
            harness_mode="bound",
            harness_profile=None,
            task=[],
        )
        lock = {
            "runtime": {},
            "terminal_bench": {},
            "model": {},
            "permissions": {},
        }
        with self.assertRaisesRegex(RuntimeError, "requires --harness-profile"):
            frozen_run_identity(args, lock)


if __name__ == "__main__":
    unittest.main()
