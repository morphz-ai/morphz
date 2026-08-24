from __future__ import annotations

import unittest
from pathlib import Path

from benchmarks.harbor.run_four_arm_comparison import (
    DEFAULT_TASK_SET,
    arm_commands,
    load_task_set,
    require_harness_gates,
)


class FourArmComparisonTest(unittest.TestCase):
    def test_frozen_task_set_contains_the_two_prior_20_task_cohorts(self) -> None:
        _, tasks = load_task_set(DEFAULT_TASK_SET)
        self.assertEqual(len(tasks), 40)
        self.assertEqual(len(set(tasks)), 40)
        self.assertIn("caffe-cifar-10", tasks)
        self.assertIn("raman-fitting", tasks)
        self.assertIn("vulnerable-secret", tasks)

    def test_commands_are_four_single_attempt_isolated_arms(self) -> None:
        _, tasks = load_task_set(DEFAULT_TASK_SET)
        commands = arm_commands(
            tasks=tasks,
            jobs_root=Path("suite/jobs"),
            concurrency=1,
        )

        self.assertEqual(
            set(commands),
            {
                "morphz-native",
                "morphz-v0.5",
                "morphz-dialectical-practice",
                "official-codex",
            },
        )
        self.assertIn("none", commands["morphz-native"])
        self.assertIn("minimal-v0.5", commands["morphz-v0.5"])
        self.assertIn(
            "dialectical-practice-v0.1",
            commands["morphz-dialectical-practice"],
        )
        for command in commands.values():
            self.assertIn("--expect-trials", command)
            self.assertEqual(command[command.index("--expect-trials") + 1], "40")
            self.assertEqual(command.count("--task"), 40)

    def test_both_candidate_harnesses_pass_the_static_gate(self) -> None:
        reports = require_harness_gates()
        self.assertTrue(reports["morphz-v0.5"]["eligible_for_model_run"])
        self.assertTrue(
            reports["morphz-dialectical-practice"]["eligible_for_model_run"]
        )


if __name__ == "__main__":
    unittest.main()
