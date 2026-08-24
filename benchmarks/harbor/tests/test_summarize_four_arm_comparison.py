from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from benchmarks.harbor.summarize_four_arm_comparison import (
    ARMS,
    exact_two_sided_binomial,
    summarize,
)


class SummarizeFourArmComparisonTest(unittest.TestCase):
    def test_exact_two_sided_binomial(self) -> None:
        self.assertEqual(exact_two_sided_binomial(0, 0), None)
        self.assertEqual(exact_two_sided_binomial(5, 0), 0.0625)
        self.assertEqual(exact_two_sided_binomial(3, 2), 1.0)

    def test_summarizes_paired_results(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "launcher_result.json").write_text(
                json.dumps({"phase": "full", "gate_passed": True}),
                encoding="utf-8",
            )
            rewards = {
                "morphz-native": [1.0, 0.0],
                "morphz-v0.5": [1.0, 1.0],
                "morphz-dialectical-practice": [0.0, 1.0],
                "official-codex": [0.0, 0.0],
            }
            for arm in ARMS:
                job = root / "jobs" / arm / "job-1"
                job.mkdir(parents=True)
                trials = [
                    {
                        "task_name": f"terminal-bench/task-{index}",
                        "strict_reward": value,
                    }
                    for index, value in enumerate(rewards[arm])
                ]
                (job / "strict_result.json").write_text(
                    json.dumps(
                        {
                            "integrity_gate_passed": True,
                            "trial_count": 2,
                            "raw_mean_reward": sum(rewards[arm]) / 2,
                            "strict_mean_reward": sum(rewards[arm]) / 2,
                            "disqualified_trials": 0,
                            "trials": trials,
                        }
                    ),
                    encoding="utf-8",
                )

            result = summarize(root)

        self.assertEqual(result["arms"]["morphz-v0.5"]["strict_pass_count"], 2)
        paired = result["paired_comparisons"]["morphz-v0.5_minus_morphz-native"]
        self.assertEqual(paired["treatment_wins"], 1)
        self.assertEqual(paired["control_wins"], 0)
        self.assertEqual(paired["ties_both_pass"], 1)
        self.assertEqual(paired["strict_mean_difference"], 0.5)


if __name__ == "__main__":
    unittest.main()
