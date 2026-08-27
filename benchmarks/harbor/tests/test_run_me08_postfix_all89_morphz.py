import unittest
from pathlib import Path

from benchmarks.harbor import run_me08_postfix_all89_morphz as runner


class PostfixAll89MorphzTest(unittest.TestCase):
    def test_task_union_is_exactly_89_unique_tasks(self) -> None:
        tasks, _, _ = runner.load_tasks()
        self.assertEqual(len(tasks), 89)
        self.assertEqual(len(set(tasks)), 89)

    def test_morphz_arm_is_frozen_to_concurrency_eight(self) -> None:
        tasks, _, _ = runner.load_tasks()
        for arm in runner.RUN_ARMS:
            command = runner.arm_command(arm, tasks, Path("/tmp/jobs"))
            flag = "--concurrency"
            self.assertIn(flag, command)
            self.assertEqual(command[command.index(flag) + 1], "8")
            self.assertIn("--expect-trials", command)
            self.assertEqual(command[command.index("--expect-trials") + 1], "89")

    def test_only_morphz_is_run_with_maximum_eight_trials(self) -> None:
        self.assertEqual(runner.CONCURRENCY_PER_ARM, 8)
        self.assertEqual(runner.RUN_ARMS, ("morphz-native",))


if __name__ == "__main__":
    unittest.main()
