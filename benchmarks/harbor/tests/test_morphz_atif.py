from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from harbor.models.trajectories import Trajectory
from harbor.utils.trajectory_validator import TrajectoryValidator

from benchmarks.harbor.morphz_atif import write_trajectory


class MorphzAtifTest(unittest.TestCase):
    def test_projects_structured_runtime_events_to_atif_v17(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            db_path = root / "morphz.db"
            connection = sqlite3.connect(db_path)
            connection.execute(
                "CREATE TABLE events ("
                "id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, actor TEXT NOT NULL, "
                "type TEXT NOT NULL, topic TEXT NOT NULL, payload TEXT NOT NULL)"
            )

            def add(
                event_id: str,
                actor: str,
                event_type: str,
                topic: str,
                payload: dict[str, object],
            ) -> None:
                connection.execute(
                    "INSERT INTO events (id, timestamp, actor, type, topic, payload) "
                    "VALUES (?, '2026-08-20T05:00:00Z', ?, ?, ?, ?)",
                    (event_id, actor, event_type, topic, json.dumps(payload)),
                )

            add(
                "user-1",
                "User",
                "user_message",
                "chat/user_message",
                {"text": "repair the project", "context_id": "ctx", "session_id": "s"},
            )
            add(
                "state-1",
                "Runtime-Orchestrator",
                "runtime_control",
                "runtime/model_attempt_state",
                {
                    "attempt_id": "model-1",
                    "state": "streaming",
                    "model_binding": {"physical_model": "gpt-5.6-sol"},
                },
            )
            add(
                "usage-1",
                "Model-Provider",
                "runtime_control",
                "runtime/model_usage",
                {
                    "attempt_id": "model-1",
                    "usage": {
                        "input_tokens": 120,
                        "cached_input_tokens": 20,
                        "output_tokens": 30,
                        "reasoning_tokens": 9,
                        "total_tokens": 150,
                    },
                    "model_binding": {"physical_model": "gpt-5.6-sol"},
                },
            )
            add(
                "reasoning-1",
                "Model-Provider",
                "runtime_control",
                "runtime/model_reasoning_summary",
                {"attempt_id": "model-1", "text": "Inspect then edit."},
            )
            add(
                "call-model-1",
                "Agent-Morphz",
                "agent_call",
                "chat/assistant_call",
                {
                    "attempt_id": "activation-1",
                    "model_attempt_id": "model-1",
                    "text": "",
                    "tool_calls": [
                        {
                            "id": "tool-1",
                            "func_name": "exec",
                            "arguments": {"command": "cargo test"},
                        }
                    ],
                },
            )
            add(
                "output-1",
                "System-Executor",
                "tool_output",
                "chat/tool_output",
                {
                    "attempt_id": "activation-1",
                    "tool_call_id": "tool-1",
                    "tool_name": "exec",
                    "tool_status": "success",
                    "text": "tests passed",
                },
            )
            add(
                "background-output-1",
                "System-TaskMonitor",
                "tool_output",
                "chat/tool_output",
                {
                    "attempt_id": "activation-1",
                    "caused_by": "tool-1:background",
                    "tool_name": "exec",
                    "tool_status": "success",
                    "text": "background task finished",
                },
            )
            add(
                "tx-1",
                "Agent-Context",
                "context_transaction",
                "chat/context_tx_committed",
                {
                    "transaction_id": "tx-1",
                    "before_version": 2,
                    "after_version": 3,
                    "reason": "record-test-result",
                    "transaction": "(context-tx ...)",
                },
            )
            add(
                "reply-1",
                "Agent-Morphz",
                "agent_call",
                "chat/reply",
                {
                    "attempt_id": "activation-1",
                    "model_attempt_id": "model-1",
                    "text": "The project is repaired.",
                },
            )
            connection.commit()
            connection.close()

            output = root / "trajectory.json"
            trajectory = write_trajectory(
                db_path,
                output,
                instruction="repair the project",
                session_id="s",
                context_id="ctx",
                agent_version="paper-eval-runtime-v3",
                configured_model="gpt-5.6-sol",
            )

            self.assertEqual(trajectory.schema_version, "ATIF-v1.7")
            self.assertEqual(trajectory.agent.model_name, "gpt-5.6-sol")
            self.assertEqual(trajectory.agent.extra["permission_mode"], "full_access")
            self.assertEqual(trajectory.final_metrics.total_prompt_tokens, 120)
            self.assertEqual(trajectory.final_metrics.total_completion_tokens, 30)
            agent_step = next(step for step in trajectory.steps if step.source == "agent")
            self.assertEqual(agent_step.message, "The project is repaired.")
            self.assertEqual(agent_step.reasoning_content, "Inspect then edit.")
            self.assertEqual(agent_step.tool_calls[0].function_name, "exec")
            self.assertEqual(
                agent_step.observation.results[0].source_call_id,
                "tool-1",
            )
            self.assertEqual(
                agent_step.observation.results[1].source_call_id,
                "tool-1",
            )
            self.assertFalse(
                any("unmatched tool observation" in step.message for step in trajectory.steps)
            )
            self.assertTrue(
                any(
                    step.source == "system"
                    and "Context transaction" in step.message
                    for step in trajectory.steps
                )
            )
            Trajectory.model_validate_json(output.read_text(encoding="utf-8"))
            validator = TrajectoryValidator()
            self.assertTrue(validator.validate(output), validator.get_errors())


if __name__ == "__main__":
    unittest.main()
