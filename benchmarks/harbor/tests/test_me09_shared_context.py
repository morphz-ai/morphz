from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from benchmarks.harbor.run_me09_shared_context import (
    DEFAULT_MANIFEST,
    _context_db_authority_count,
    _harness_binding_count,
    _sha256,
    _harbor_command,
    _write_runtime_config,
    load_and_validate_manifest,
)
from benchmarks.harbor.summarize_me09_shared_context import event_root_turn_id
from benchmarks.harbor.shared_context_agent import (
    SharedContextMorphzAgent,
    _message_body,
    _turn_snapshot,
)


class Me09SharedContextTest(unittest.TestCase):
    def test_message_request_is_explicitly_unharnessed(self) -> None:
        body = _message_body(
            instruction="solve the task",
            client_message_id="me09-00-test",
            target_id="me09-target-00",
        )
        self.assertNotIn("harness", body)
        self.assertEqual(body["reasoning_effort"], "max")
        self.assertEqual(body["target_id"], "me09-target-00")

    def test_harness_binding_gate_requires_zero_events(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            db_path = Path(raw_dir) / "shared.db"
            connection = sqlite3.connect(db_path)
            connection.execute("CREATE TABLE events (topic TEXT NOT NULL)")
            connection.commit()
            connection.close()
            self.assertEqual(_harness_binding_count(db_path), 0)

            connection = sqlite3.connect(db_path)
            connection.execute(
                "INSERT INTO events(topic) VALUES "
                "('runtime/evaluation_harness_binding')"
            )
            connection.commit()
            connection.close()
            self.assertEqual(_harness_binding_count(db_path), 1)

    def test_root_user_message_uses_its_event_id_as_root_turn(self) -> None:
        self.assertEqual(
            event_root_turn_id(
                {
                    "id": "msg-root",
                    "root_turn_id": None,
                    "topic": "chat/user_message",
                }
            ),
            "msg-root",
        )
        self.assertEqual(
            event_root_turn_id(
                {
                    "id": "reply-event",
                    "root_turn_id": "msg-root",
                    "topic": "chat/reply",
                }
            ),
            "msg-root",
        )

    def test_frozen_binary_digest_helper_reads_exact_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            artifact = Path(raw_dir) / "morphz"
            artifact.write_bytes(b"same-runtime-as-me08")
            self.assertEqual(
                _sha256(artifact),
                "033f879bb46218edebdc437b6ba70885b1a5c8b87ba41616e29c6bd2ecb1bbfb",
            )

    def test_manifest_is_exact_eight_lane_partition_of_89_tasks(self) -> None:
        manifest = load_and_validate_manifest(DEFAULT_MANIFEST)
        self.assertEqual(manifest["task_count"], 89)
        self.assertEqual(len(manifest["lanes"]), 8)
        self.assertEqual(
            sorted(len(lane["tasks"]) for lane in manifest["lanes"]),
            [11, 11, 11, 11, 11, 11, 11, 12],
        )
        tasks = [task for lane in manifest["lanes"] for task in lane["tasks"]]
        self.assertEqual(len(set(tasks)), 89)

    def test_runtime_config_supports_explicit_session_working_set_limit(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            config_path = Path(raw_dir) / "morphz.toml"
            _write_runtime_config(
                config_path,
                protocol="openai-responses",
                base_url="http://127.0.0.1:8317/v1",
                max_sessions=50,
            )
            config = config_path.read_text(encoding="utf-8")
            self.assertIn(
                '[orchestrator.session_working_set]\nactive_window = "24h"\nmax_sessions = 50',
                config,
            )
            self.assertNotIn("[experimental]", config)

    def test_runtime_config_explicitly_selects_context_db_arm(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            config_path = Path(raw_dir) / "morphz.toml"
            _write_runtime_config(
                config_path,
                protocol="openai-responses",
                base_url="http://127.0.0.1:8317/v1",
                max_sessions=50,
                context_store="contextdb",
            )
            config = config_path.read_text(encoding="utf-8")
            self.assertIn(
                '[storage]\nbackend = "sqlite"\ncognitive_store = "context_db"',
                config,
            )
            self.assertNotIn("[experimental]", config)

    def test_context_db_arm_gate_reads_the_authoritative_context_row(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            db_path = Path(raw_dir) / "shared.db"
            connection = sqlite3.connect(db_path)
            connection.execute(
                "CREATE TABLE experimental_contextdb_contexts "
                "(context_id TEXT PRIMARY KEY)"
            )
            connection.execute(
                "INSERT INTO experimental_contextdb_contexts(context_id) VALUES (?)",
                ("me09-shared-context",),
            )
            connection.commit()
            connection.close()
            self.assertEqual(
                _context_db_authority_count(db_path, "me09-shared-context"), 1
            )
            self.assertEqual(
                _context_db_authority_count(db_path, "another-context"), 0
            )

    def test_agent_rejects_task_outside_selected_lane(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            agent = SharedContextMorphzAgent(
                logs_dir=Path(raw_dir), model_name="custom/gpt-5.6-sol"
            )
            agent.session_id = "write-compressor__trial__agent"
            with mock.patch.dict(
                os.environ,
                {
                    "MORPHZ_ME09_LANE_ID": "0",
                    "MORPHZ_ME09_MANIFEST": str(DEFAULT_MANIFEST),
                },
                clear=False,
            ):
                self.assertEqual(
                    agent._lane(),
                    (0, "me09-session-00", "me09-target-00"),
                )
            with mock.patch.dict(
                os.environ,
                {
                    "MORPHZ_ME09_LANE_ID": "1",
                    "MORPHZ_ME09_MANIFEST": str(DEFAULT_MANIFEST),
                },
                clear=False,
            ):
                with self.assertRaisesRegex(ValueError, "not assigned"):
                    agent._lane()

    def test_turn_snapshot_fences_session_and_root(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            db_path = Path(raw_dir) / "shared.db"
            connection = sqlite3.connect(db_path)
            connection.executescript(
                """
                CREATE TABLE threads (
                    id TEXT, revision INTEGER, status TEXT,
                    delivery_status TEXT, result_event_id TEXT,
                    session_id TEXT, root_turn_id TEXT
                );
                CREATE TABLE events (
                    id TEXT, session_id TEXT, root_turn_id TEXT,
                    topic TEXT, payload TEXT
                );
                """
            )
            connection.execute(
                "INSERT INTO threads VALUES "
                "('thread-a', 3, 'completed', 'delivered', 'reply-a', 's-a', 'turn-a')"
            )
            connection.execute(
                "INSERT INTO events VALUES "
                "('reply-a', 's-a', 'turn-a', 'chat/reply', ?)",
                (json.dumps({"text": "answer a"}),),
            )
            connection.execute(
                "INSERT INTO events VALUES "
                "('reply-b', 's-b', 'turn-b', 'chat/reply', ?)",
                (json.dumps({"text": "answer b"}),),
            )
            connection.commit()
            connection.close()

            snapshot = _turn_snapshot(
                db_path, session_id="s-a", root_turn_id="turn-a"
            )
            self.assertEqual(snapshot["reply_event_id"], "reply-a")
            self.assertEqual(snapshot["reply_text"], "answer a")
            self.assertEqual(snapshot["thread"]["id"], "thread-a")

    def test_each_harbor_invocation_selects_one_official_task(self) -> None:
        command = _harbor_command(
            jobs_dir=Path("/tmp/jobs"),
            task="write-compressor",
            dataset="terminal-bench/terminal-bench-2-1",
            dataset_ref="sha256:test",
        )
        self.assertIn("benchmarks.harbor.shared_context_agent:SharedContextMorphzAgent", command)
        self.assertEqual(command[command.index("--n-concurrent") + 1], "1")
        self.assertEqual(command[command.index("--n-attempts") + 1], "1")
        self.assertEqual(
            command[command.index("--include-task-name") + 1],
            "terminal-bench/write-compressor",
        )

    def test_edge_pairing_retries_only_the_explicit_sqlite_busy_case(self) -> None:
        script = Path(__file__).parents[1].joinpath("run_me09_edge.sh").read_text()
        self.assertIn('grep -Fq "database is locked"', script)
        self.assertIn("for attempt in {1..8}", script)
        self.assertIn('if ! grep -Fq "database is locked"', script)
        self.assertNotIn("cyber_policy", script)


if __name__ == "__main__":
    unittest.main()
