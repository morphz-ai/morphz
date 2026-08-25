import json
import tempfile
import unittest
from pathlib import Path

from benchmarks.harbor.run_two_arm_remaining_49 import (
    EXPECTED_CODEX_VERSION,
    PROTOCOL,
    commands,
    exact_binomial_two_sided,
    load_tasks,
)


class Remaining49ProtocolTest(unittest.TestCase):
    def test_frozen_task_partition(self) -> None:
        manifest, tasks, prior = load_tasks()
        self.assertEqual(PROTOCOL, manifest["protocol"])
        self.assertEqual(49, len(tasks))
        self.assertEqual(40, len(prior))
        self.assertEqual(89, len(set(tasks) | set(prior)))
        self.assertFalse(set(tasks) & set(prior))

    def test_commands_are_two_single_attempt_arms(self) -> None:
        _, tasks, _ = load_tasks()
        with tempfile.TemporaryDirectory() as root:
            result = commands(tasks, Path(root))
        self.assertEqual({"morphz-native", "official-codex"}, set(result))
        for command in result.values():
            self.assertIn("--concurrency", command)
            self.assertEqual("3", command[command.index("--concurrency") + 1])
            self.assertIn("--expect-trials", command)
            self.assertEqual("49", command[command.index("--expect-trials") + 1])
        self.assertIn("--harness-mode", result["morphz-native"])
        self.assertEqual("none", result["morphz-native"][result["morphz-native"].index("--harness-mode") + 1])
        self.assertEqual("0.149.1", EXPECTED_CODEX_VERSION)

    def test_exact_binomial(self) -> None:
        self.assertEqual(1.0, exact_binomial_two_sided(0, 0))
        self.assertAlmostEqual(1.0, exact_binomial_two_sided(1, 1))
        self.assertAlmostEqual(0.0625, exact_binomial_two_sided(5, 0))


if __name__ == "__main__":
    unittest.main()
