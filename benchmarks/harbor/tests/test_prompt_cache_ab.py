from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from benchmarks.harbor import run_prompt_cache_ab as ab


class PromptCacheAbTests(unittest.TestCase):
    def test_controlled_provider_environment_rejects_unknown_proxy_and_requires_key(
        self,
    ) -> None:
        with self.assertRaisesRegex(RuntimeError, "OpenAI Platform or Cloudflare"):
            ab.controlled_provider_environment(
                {
                    "MORPHZ_PROVIDER_BASE_URL": "http://172.17.0.1:8317/v1",
                    "MORPHZ_PROVIDER_API_KEY": "proxy-key",
                }
            )
        with self.assertRaisesRegex(RuntimeError, "MORPHZ_PROVIDER_API_KEY"):
            ab.controlled_provider_environment(
                {"MORPHZ_PROVIDER_BASE_URL": "https://api.openai.com/v1"}
            )
        prepared = ab.controlled_provider_environment(
            {
                "MORPHZ_PROVIDER_BASE_URL": "https://api.openai.com/v1/",
                "MORPHZ_PROVIDER_API_KEY": "platform-key",
            }
        )
        self.assertEqual(prepared["MORPHZ_PROVIDER_PROTOCOL"], "openai-responses")
        self.assertEqual(prepared["MORPHZ_PROVIDER_MODEL"], "gpt-5.6-sol")

    def test_controlled_provider_environment_accepts_exact_cloudflare_route(self) -> None:
        prepared = ab.controlled_provider_environment(
            {
                "MORPHZ_PROVIDER_BASE_URL": (
                    "https://api.cloudflare.com/client/v4/accounts/"
                    "0123456789abcdef0123456789abcdef/ai/v1"
                ),
                "MORPHZ_PROVIDER_PROTOCOL": "openai-responses",
                "MORPHZ_PROVIDER_MODEL": "openai/gpt-5.6-sol",
                "MORPHZ_PROVIDER_API_KEY": "cloudflare-key",
            }
        )
        self.assertEqual(
            prepared["MORPHZ_PROVIDER_MODEL"], "openai/gpt-5.6-sol"
        )

    def test_arm_command_is_one_exact_smoke_trial(self) -> None:
        with mock.patch.object(ab.sys, "executable", "/python"):
            command = ab.arm_command(
                binary=Path("/runtime/morphz"),
                watcher=Path("/runtime/watcher"),
                jobs_dir=Path("/jobs/implicit"),
                task="prove-plus-comm",
            )
        self.assertEqual(command[0], "/python")
        self.assertEqual(command[2], "smoke")
        self.assertEqual(command[command.index("--task") + 1], "prove-plus-comm")
        self.assertEqual(command[command.index("--attempts") + 1], "1")
        self.assertEqual(command[command.index("--concurrency") + 1], "1")
        self.assertEqual(command[command.index("--expect-trials") + 1], "1")

    def test_report_aggregates_provider_usage_and_reward(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            arms = {}
            for strategy, cached, reward in (
                ("implicit-prefix", 20, 1.0),
                ("explicit-content-boundaries", 90, 1.0),
            ):
                job = root / strategy
                trial = job / "trial-1"
                trial.mkdir(parents=True)
                (job / "strict_result.json").write_text(
                    json.dumps(
                        {
                            "integrity_gate_passed": True,
                            "run_identity": {
                                "prompt_cache_strategy": strategy,
                                "runtime_git_commit": "runtime-commit",
                                "runtime_binary_sha256": "runtime-sha",
                                "infrastructure_git_commit": "infra-commit",
                                "provider_model": "gpt-5.6-sol",
                            },
                            "trials": [
                                {
                                    "trial": "trial-1",
                                    "task_name": "terminal-bench/prove-plus-comm",
                                    "strict_reward": reward,
                                }
                            ],
                        }
                    ),
                    encoding="utf-8",
                )
                (trial / "result.json").write_text(
                    json.dumps(
                        {
                            "agent_result": {
                                "n_input_tokens": 100,
                                "n_cache_tokens": cached,
                                "n_output_tokens": 10,
                            }
                        }
                    ),
                    encoding="utf-8",
                )
                (trial / "agent").mkdir()
                (trial / "agent" / "trajectory.json").write_text(
                    json.dumps(
                        {
                            "steps": [
                                {
                                    "metrics": {
                                        "prompt_tokens": 10,
                                        "cached_tokens": 0,
                                    }
                                },
                                {
                                    "metrics": {
                                        "prompt_tokens": 90,
                                        "cached_tokens": cached,
                                    }
                                },
                            ],
                            "final_metrics": {
                                "extra": {"unique_model_attempts_with_usage": 2}
                            },
                        }
                    ),
                    encoding="utf-8",
                )
                arms[strategy] = ab.summarize_arm(strategy, job)
            report = ab.build_report(
                "prove-plus-comm",
                arms,
                provider="https://api.openai.com/v1",
                provider_model="gpt-5.6-sol",
            )
        self.assertAlmostEqual(
            report["explicit_minus_implicit_cache_hit_ratio"], 0.7
        )
        self.assertTrue(report["strict_reward_equal"])
        self.assertTrue(report["explicit_meets_85_percent"])
        self.assertEqual(
            report["arms"]["explicit-content-boundaries"]["model_attempts"], 2
        )
        self.assertEqual(
            report["arms"]["explicit-content-boundaries"][
                "cold_start_theoretical_max_cache_hit_ratio"
            ],
            0.9,
        )


if __name__ == "__main__":
    unittest.main()
