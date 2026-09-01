from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from benchmarks.harbor import run_contextdb_me08_historical as runner


class ContextDbMe08HistoricalTest(unittest.TestCase):
    @staticmethod
    def _write_complete_candidate(root: Path, task: str = "task-a") -> Path:
        jobs_dir = root / "jobs"
        job = jobs_dir / "job-1"
        trial = job / f"{task}__trial"
        trial.mkdir(parents=True)
        (job / "strict_result.json").write_text(
            json.dumps(
                {
                    "audit_complete": True,
                    "trials": [
                        {
                            "task_name": f"terminal-bench/{task}",
                            "raw_reward": 0.0,
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        (trial / "context_store_audit.json").write_text(
            json.dumps(
                {
                    "context_store": "contextdb",
                    "context_db_authority_count": 1,
                }
            ),
            encoding="utf-8",
        )
        return jobs_dir

    def test_runtime_image_uses_the_pinned_installed_toolchain(self) -> None:
        dockerfile = (runner.REPO_ROOT / "benchmarks/harbor/runtime.Dockerfile").read_text(
            encoding="utf-8"
        )
        self.assertIn(
            "ARG RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu",
            dockerfile,
        )
        self.assertIn("ENV RUSTUP_TOOLCHAIN=${RUSTUP_TOOLCHAIN}", dockerfile)
        self.assertNotIn("cargo-config.china.toml", dockerfile)

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

    def test_nonzero_harbor_status_keeps_complete_strict_outcome(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            jobs_dir = self._write_complete_candidate(root)
            job, rewards = runner.load_candidate_outcome(
                jobs_dir=jobs_dir,
                tasks=["task-a"],
                return_code=1,
                logs_dir=root / "logs",
            )
            self.assertEqual(job, jobs_dir / "job-1")
            self.assertEqual(rewards, {"task-a": 0})

    def test_nonzero_harbor_status_rejects_incomplete_outcome(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            jobs_dir = root / "jobs"
            jobs_dir.mkdir()
            with self.assertRaisesRegex(
                RuntimeError,
                "failed before a complete strict outcome",
            ):
                runner.load_candidate_outcome(
                    jobs_dir=jobs_dir,
                    tasks=["task-a"],
                    return_code=1,
                    logs_dir=root / "logs",
                )


if __name__ == "__main__":
    unittest.main()
