from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from benchmarks.harbor import run_contextdb_me08_historical as runner


class ContextDbMe08HistoricalTest(unittest.TestCase):
    def test_pilot_is_the_frozen_first_eight_me08_tasks(self) -> None:
        self.assertEqual(runner.load_pilot_tasks(), runner.load_all_tasks()[:8])
        self.assertEqual(len(runner.load_pilot_tasks()), 8)

    def test_candidate_keeps_eight_isolated_trials(self) -> None:
        tasks = runner.load_pilot_tasks()
        command = runner.candidate_command(
            tasks=tasks,
            jobs_dir=Path("/tmp/jobs"),
            binary=Path("/tmp/morphz"),
            watcher=Path("/tmp/morphz-harbor-wait"),
            toolchain_lock=Path("/tmp/contextdb.lock.json"),
        )
        self.assertEqual(command[command.index("--concurrency") + 1], "8")
        self.assertEqual(command[command.index("--context-store") + 1], "contextdb")
        self.assertEqual(command[command.index("--expect-trials") + 1], "8")

    def test_historical_baseline_has_six_complete_distinct_runs(self) -> None:
        runs = runner.load_historical_runs()
        self.assertEqual(len(runs), 6)
        self.assertEqual(
            sorted(run["passed_all_89"] for run in runs.values()),
            [69, 71, 72, 72, 72, 73],
        )
        for run in runs.values():
            self.assertEqual(len(run["rewards"]), 89)

    def test_pilot_baseline_has_six_observations_per_task(self) -> None:
        tasks = runner.load_pilot_tasks()
        baseline = runner.historical_baseline(tasks)
        self.assertEqual(baseline["source_count"], 6)
        for task in tasks:
            self.assertEqual(baseline["per_task"][task]["observations"], 6)

    def test_toolchain_lock_binds_feature_and_exact_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            binary = root / "morphz"
            watcher = root / "watcher"
            binary.write_bytes(b"contextdb-binary")
            watcher.write_bytes(b"watcher")
            base = {
                "terminal_bench": {"task_count": 89},
                "model": {"physical_model": "gpt-5.6-sol"},
                "permissions": {"mode": "full_access"},
            }
            contextdb = runner.build_toolchain_lock(
                base,
                commit="a" * 40,
                binary=binary,
                watcher=watcher,
            )
            self.assertEqual(
                contextdb["runtime"]["build_features"],
                ["experimental-context-db"],
            )
            self.assertEqual(
                contextdb["runtime"]["binary_sha256"],
                runner.sha256_file(binary),
            )

    def test_comparison_flags_failure_on_historically_stable_task(self) -> None:
        tasks = ["task-a", "task-b"]
        baseline = {
            "subset_passed_min": 1,
            "subset_passed_max": 2,
            "subset_passed_mean": 1.5,
            "per_task": {
                "task-a": {"passes": 6, "observations": 6, "pass_rate": 1.0},
                "task-b": {"passes": 3, "observations": 6, "pass_rate": 0.5},
            },
        }
        comparison = runner.compare_with_history(
            tasks,
            {"task-a": 0, "task-b": 1},
            baseline,
        )
        self.assertTrue(comparison["requires_regression_audit"])
        self.assertEqual(
            comparison["historically_always_passed_contextdb_failed"],
            ["task-a"],
        )


if __name__ == "__main__":
    unittest.main()
