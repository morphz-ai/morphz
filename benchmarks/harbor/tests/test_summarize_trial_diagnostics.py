import json
import tempfile
import unittest
from pathlib import Path

from benchmarks.harbor.summarize_trial_diagnostics import load_job, summarize


def write_trial(
    job: Path,
    task: str,
    *,
    raw_reward: int,
    execution_seconds: int,
    exception_type: str | None = None,
    input_tokens: int = 100,
) -> None:
    trial = job / f"{task}__trial"
    (trial / "agent").mkdir(parents=True)
    result = {
        "task_name": f"terminal-bench/{task}",
        "verifier_result": {"rewards": {"reward": raw_reward}},
        "agent_result": {
            "n_input_tokens": input_tokens,
            "n_cache_tokens": 10,
            "n_output_tokens": 20,
            "cost_usd": None,
        },
        "exception_info": (
            {"exception_type": exception_type, "exception_message": "boom"}
            if exception_type
            else None
        ),
        "started_at": "2026-08-26T00:00:00Z",
        "finished_at": "2026-08-26T00:02:00Z",
        "agent_execution": {
            "started_at": "2026-08-26T00:00:10Z",
            "finished_at": f"2026-08-26T00:00:{10 + execution_seconds:02d}Z",
        },
    }
    (trial / "result.json").write_text(json.dumps(result), encoding="utf-8")
    trajectory = {
        "final_metrics": {
            "total_steps": 4,
            "extra": {"unique_model_attempts_with_usage": 3},
        },
        "steps": [
            {
                "source": "agent",
                "tool_calls": [{"function_name": "exec"}],
            }
        ],
    }
    (trial / "agent" / "trajectory.json").write_text(
        json.dumps(trajectory), encoding="utf-8"
    )


class SummarizeTrialDiagnosticsTest(unittest.TestCase):
    def test_preserves_reward_and_reports_paired_diagnostics(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            morphz = root / "morphz"
            codex = root / "codex"
            write_trial(
                morphz,
                "alpha",
                raw_reward=1,
                execution_seconds=20,
                input_tokens=200,
            )
            write_trial(
                morphz,
                "beta",
                raw_reward=0,
                execution_seconds=40,
                exception_type="AgentTimeoutError",
                input_tokens=300,
            )
            write_trial(
                codex,
                "alpha",
                raw_reward=1,
                execution_seconds=40,
                input_tokens=400,
            )
            write_trial(
                codex,
                "beta",
                raw_reward=1,
                execution_seconds=20,
                input_tokens=500,
            )

            report = summarize(load_job(morphz, 2), load_job(codex, 2))

            self.assertTrue(report["official_reward_unchanged"])
            self.assertTrue(report["diagnostic_only"])
            self.assertEqual(report["arms"]["morphz-native"]["passed"], 1)
            self.assertEqual(report["arms"]["official-codex"]["passed"], 2)
            self.assertEqual(
                report["arms"]["morphz-native"]["exception_counts"],
                {"AgentTimeoutError": 1},
            )
            self.assertNotIn("exception_message", report["per_task"][1]["morphz"])
            self.assertEqual(
                len(report["per_task"][1]["morphz"]["exception_message_sha256"]),
                64,
            )
            self.assertEqual(report["arms"]["morphz-native"]["tokens"]["input"], 500)
            self.assertEqual(report["paired_execution"]["morphz_faster"], 1)
            self.assertEqual(report["paired_execution"]["codex_faster"], 1)
            self.assertEqual(
                report["paired_execution"]["ratio_distribution"]["median"], 1.25
            )
            self.assertEqual(
                report["per_task"][1]["morphz"]["trajectory"]["model_attempts"],
                3,
            )

    def test_rejects_different_task_sets(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            morphz = root / "morphz"
            codex = root / "codex"
            write_trial(morphz, "alpha", raw_reward=1, execution_seconds=20)
            write_trial(codex, "beta", raw_reward=1, execution_seconds=20)
            with self.assertRaisesRegex(RuntimeError, "task sets differ"):
                summarize(load_job(morphz), load_job(codex))


if __name__ == "__main__":
    unittest.main()
