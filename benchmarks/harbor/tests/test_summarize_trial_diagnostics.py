import json
import sqlite3
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


def write_runtime_state(
    trial: Path,
    *,
    replies: int = 0,
    activation_statuses: tuple[str, ...] = (),
    active_objectives: int = 0,
    pending_dependency: bool = False,
) -> None:
    connection = sqlite3.connect(trial / "agent" / "morphz.db")
    connection.executescript(
        """
        CREATE TABLE events(topic TEXT NOT NULL, timestamp TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE thread_activations(id TEXT PRIMARY KEY, status TEXT NOT NULL);
        CREATE TABLE objectives(id TEXT PRIMARY KEY, status TEXT NOT NULL, active_evaluation_id TEXT);
        CREATE TABLE scheduler_dependencies(
            dependency_kind TEXT NOT NULL,
            dependency_id TEXT NOT NULL,
            required INTEGER NOT NULL,
            status TEXT NOT NULL
        );
        """
    )
    for index in range(replies):
        connection.execute(
            "INSERT INTO events VALUES (?, ?, ?)",
            ("chat/reply", f"2026-08-26T00:00:{index:02d}Z", "{}"),
        )
    connection.execute(
        "INSERT INTO events VALUES (?, ?, ?)",
        (
            "runtime/model_attempt_state",
            "2026-08-26T00:01:00Z",
            json.dumps(
                {
                    "attempt_id": "attempt-1",
                    "state": "streaming",
                    "terminal": False,
                    "detail": "provider request active",
                }
            ),
        ),
    )
    for index, status in enumerate(activation_statuses):
        connection.execute(
            "INSERT INTO thread_activations VALUES (?, ?)",
            (f"activation-{index}", status),
        )
    for index in range(active_objectives):
        connection.execute(
            "INSERT INTO objectives VALUES (?, ?, NULL)",
            (f"objective-{index}", "active"),
        )
    if pending_dependency:
        connection.execute(
            "INSERT INTO scheduler_dependencies VALUES (?, ?, 1, ?)",
            ("resource", "model-route:test", "pending"),
        )
    connection.commit()
    connection.close()


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
            self.assertEqual(
                report["arms"]["morphz-native"]["timeout_classifications"],
                {"runtime_state_unavailable": 1},
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

    def test_timeout_classification_uses_durable_runtime_authority(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            job = Path(temporary) / "job"
            write_trial(
                job,
                "terminal",
                raw_reward=1,
                execution_seconds=20,
                exception_type="AgentTimeoutError",
            )
            write_runtime_state(
                job / "terminal__trial",
                replies=1,
                activation_statuses=("completed",),
            )
            write_trial(
                job,
                "provider-wait",
                raw_reward=0,
                execution_seconds=20,
                exception_type="AgentTimeoutError",
            )
            write_runtime_state(
                job / "provider-wait__trial",
                activation_statuses=("completed",),
                pending_dependency=True,
            )
            write_trial(
                job,
                "active",
                raw_reward=0,
                execution_seconds=20,
                exception_type="AgentTimeoutError",
            )
            write_runtime_state(
                job / "active__trial",
                activation_statuses=("completed", "running"),
            )
            write_trial(
                job,
                "gap",
                raw_reward=0,
                execution_seconds=20,
                exception_type="AgentTimeoutError",
            )
            write_runtime_state(
                job / "gap__trial",
                activation_statuses=("completed",),
            )

            trials = load_job(job, 4)

            self.assertEqual(
                trials["terminal"]["timeout_classification"],
                "durable_terminal_present",
            )
            self.assertEqual(
                trials["provider-wait"]["timeout_classification"],
                "pending_scheduler_dependency",
            )
            self.assertEqual(
                trials["active"]["timeout_classification"],
                "active_activation_at_timeout",
            )
            self.assertEqual(
                trials["gap"]["timeout_classification"],
                "suspected_scheduler_convergence_gap",
            )
            self.assertEqual(
                trials["active"]["runtime_state"]["last_model_attempt_state"][
                    "state"
                ],
                "streaming",
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
