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

    def test_historical_four_arm_commands_are_disabled(self) -> None:
        _, tasks = load_task_set(DEFAULT_TASK_SET)
        with self.assertRaisesRegex(RuntimeError, "retired and deleted"):
            arm_commands(
                tasks=tasks,
                jobs_root=Path("suite/jobs"),
                concurrency=1,
            )

    def test_historical_four_arm_launcher_is_disabled(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "retired and deleted"):
            require_harness_gates()


if __name__ == "__main__":
    unittest.main()
