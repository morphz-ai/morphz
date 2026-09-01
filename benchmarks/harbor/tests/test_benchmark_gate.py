from __future__ import annotations

import hashlib
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from benchmarks.harbor.benchmark_gate import audit_gate
from benchmarks.harbor.benchmark_integrity import POLICY_MARKER, POLICY_VERSION


class BenchmarkGateTest(unittest.TestCase):
    def test_accepts_one_isolated_clean_trial(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            job = Path(raw_dir)
            trial_name = "task-one__trial"
            trial = job / trial_name
            agent = trial / "agent"
            agent.mkdir(parents=True)
            trajectory = {
                "session_id": "session-one",
                "agent": {
                    "extra": {
                        "context_id": "context-one",
                        "permission_mode": "full_access",
                        "harness": {
                            "id": "terminal-task",
                            "version": "0.1.0",
                            "artifact_hash": "sha256:test-harness",
                            "binding_count": 1,
                            "package_identity_count": 1,
                            "bindings": [
                                {
                                    "evaluation_id": "evaluation-one",
                                    "scope": "evaluation",
                                }
                            ],
                        },
                    }
                },
                "steps": [
                    {
                        "source": "agent",
                        "llm_call_count": 1,
                        "model_name": "openai/gpt-5.6-sol",
                        "reasoning_effort": "max",
                        "message": "done",
                    }
                ],
                "extra": {"context_id": "context-one"},
            }
            trajectory_path = agent / "trajectory.json"
            trajectory_path.write_text(json.dumps(trajectory), encoding="utf-8")
            digest = hashlib.sha256(trajectory_path.read_bytes()).hexdigest()
            (agent / "instruction.md").write_text(
                "task\n" + POLICY_MARKER + "\n", encoding="utf-8"
            )
            (trial / "benchmark_integrity.json").write_text(
                json.dumps(
                    {
                        "policy_version": POLICY_VERSION,
                        "disqualified": False,
                        "finding_count": 0,
                        "trajectory_sha256": digest,
                    }
                ),
                encoding="utf-8",
            )
            database = agent / "morphz.db"
            with sqlite3.connect(database) as connection:
                connection.execute("CREATE TABLE events (topic TEXT, payload TEXT)")
                connection.execute(
                    "INSERT INTO events VALUES ('chat/user_message', ?)",
                    (
                        json.dumps(
                            {
                                "context_id": "context-one",
                                "session_id": "session-one",
                            }
                        ),
                    ),
                )
            (job / "strict_result.json").write_text(
                json.dumps(
                    {
                        "integrity_gate_passed": True,
                        "run_identity": {
                            "model": "gpt-5.6-sol",
                            "provider_model": "openai/gpt-5.6-sol",
                            "harness": {
                                "id": "terminal-task",
                                "version": "0.1.0",
                                "artifact_hash": "sha256:test-harness",
                                "source_sha256": "sha256:test-source",
                            },
                        },
                        "trials": [
                            {
                                "trial": trial_name,
                                "task_name": "terminal-bench/task-one",
                                "raw_reward": 1.0,
                                "strict_reward": 1.0,
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            (job / "job.log").write_text("clean launcher log\n", encoding="utf-8")
            (agent / "morphz.stdout.log").write_text(
                "Provider returned HTTP 503: auth_unavailable\n", encoding="utf-8"
            )

            audit = audit_gate(
                job,
                expected_trials=1,
                credential="test-only-secret-not-present",
                atif_validator=lambda _path: [],
            )

            self.assertTrue(audit["gate_passed"])
            self.assertTrue(audit["checks"]["isolation"])
            self.assertFalse(audit["checks"]["provider_clean"])
            self.assertNotIn("provider_clean", audit["required_checks"])
            self.assertEqual(audit["provider_errors"]["http_503"], 1)
            self.assertEqual(audit["provider_errors"]["auth_unavailable"], 1)
            self.assertEqual(audit["credential_hit_paths"], [])


if __name__ == "__main__":
    unittest.main()
