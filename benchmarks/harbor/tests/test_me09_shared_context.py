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
    _sha256,
    _harbor_command,
    load_and_validate_manifest,
)
from benchmarks.harbor.shared_context_agent import (
    SharedContextMorphzAgent,
    _turn_snapshot,
)


class Me09SharedContextTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
