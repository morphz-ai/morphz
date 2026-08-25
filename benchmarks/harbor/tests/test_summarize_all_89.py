from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from benchmarks.harbor.summarize_all_89 import exact_two_sided, summarize


def write_json(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload), encoding="utf-8")


def prior_payload(prefix: str, rewards: list[int]) -> dict[str, object]:
    return {
        "audit_complete": True,
        "trial_count": 40,
        "integrity_gate_passed": prefix == "morphz",
        "trials": [
            {
                "task_name": f"terminal-bench/prior-{index:02d}",
                "raw_reward": reward,
            }
            for index, reward in enumerate(rewards)
        ],
    }


def remaining_payload(morphz: list[int], codex: list[int]) -> dict[str, object]:
    return {
        "official_scoring_is_primary": True,
        "task_count": 49,
        "per_task": [
            {
                "task": f"remaining-{index:02d}",
                "morphz": morphz[index],
                "codex": codex[index],
            }
            for index in range(49)
        ],
    }


class SummarizeAll89Test(unittest.TestCase):
    def test_exact_two_sided(self) -> None:
        self.assertEqual(exact_two_sided(0, 0), 1.0)
        self.assertEqual(exact_two_sided(1, 0), 1.0)
        self.assertEqual(exact_two_sided(5, 0), 0.0625)
        self.assertEqual(exact_two_sided(3, 3), 1.0)

    def test_summarize_uses_raw_rewards_and_all_89_tasks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            prior_morphz = root / "prior_morphz.json"
            prior_codex = root / "prior_codex.json"
            remaining = root / "remaining.json"
            write_json(prior_morphz, prior_payload("morphz", [1] * 30 + [0] * 10))
            write_json(prior_codex, prior_payload("codex", [1] * 28 + [0] * 12))
            write_json(
                remaining,
                remaining_payload([1] * 31 + [0] * 18, [1] * 29 + [0] * 20),
            )

            summary = summarize(prior_morphz, prior_codex, remaining)

        self.assertEqual(summary["task_count"], 89)
        self.assertEqual(summary["arms"]["morphz-native"]["passed"], 61)
        self.assertEqual(summary["arms"]["official-codex"]["passed"], 57)
        self.assertEqual(
            summary["subsets"]["first_40"],
            {"morphz_passed": 30, "codex_passed": 28},
        )
        self.assertEqual(len(summary["per_task"]), 89)
        self.assertEqual(
            summary["bootstrap"],
            {"seed": 20260826, "repetitions": 10_000},
        )


if __name__ == "__main__":
    unittest.main()
