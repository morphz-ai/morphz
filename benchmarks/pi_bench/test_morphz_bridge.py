from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from benchmarks.pi_bench.morphz_bridge import Bridge, SessionTrace, stable_id


class MorphzPiBenchBridgeTest(unittest.TestCase):
    def test_stable_id_is_deterministic_and_input_sensitive(self) -> None:
        self.assertEqual(stable_id("session", "user:task"), stable_id("session", "user:task"))
        self.assertNotEqual(stable_id("session", "user:task"), stable_id("session", "user:other"))

    def test_trace_layout_matches_official_collector_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            bridge = Bridge(
                test_server_url="http://test.invalid",
                morphz_url="http://morphz.invalid",
                morphz_token="test-token",
                context_id="context-default",
                model_id="morphz/test",
                trace_root=Path(directory),
                reply_timeout=1.0,
            )
            trace = SessionTrace("session-1", "20260721_010203")
            events = [
                {
                    "sequence": 1,
                    "topic": "chat/user_message",
                    "payload": {"text": "hello"},
                },
                {
                    "sequence": 2,
                    "topic": "chat/reply",
                    "payload": {"text": "world"},
                },
            ]
            bridge.session_events = lambda *_args, **_kwargs: events  # type: ignore[method-assign]
            bridge.write_trace("researcher", "task-1", trace, "hello", "world")
            files = list(Path(directory).rglob("turn_*.json"))
            self.assertEqual(len(files), 1)
            relative = files[0].relative_to(Path(directory) / "morphz_test")
            self.assertEqual(relative.parts[:3], ("researcher", "task-1", "20260721_010203"))

    def test_persona_tasks_share_context_but_personas_are_isolated(self) -> None:
        bridge = Bridge(
            test_server_url="http://test.invalid",
            morphz_url="http://morphz.invalid",
            morphz_token="test-token",
            context_id="pibench-eval",
            model_id="morphz/test",
            trace_root=Path("/tmp/unused"),
            reply_timeout=1.0,
        )
        calls: list[tuple[str, str, str, dict | None]] = []

        def fake_request(method, path, sender_id, body=None):
            calls.append((method, path, sender_id, body))
            if method == "GET" and path.startswith("/api/sessions/"):
                raise RuntimeError("HTTP 404")
            return {}

        bridge.morphz_request = fake_request  # type: ignore[method-assign]
        bridge.ensure_session("alice", "task-1")
        bridge.ensure_session("alice", "task-2")
        bridge.ensure_session("bob", "task-1")

        session_creates = [
            body
            for method, path, _sender, body in calls
            if method == "POST" and path == "/api/sessions"
        ]
        alice_contexts = {
            body["mount"]["context_id"]
            for body in session_creates[:2]
            if body is not None
        }
        bob_context = session_creates[2]["mount"]["context_id"]
        self.assertEqual(len(alice_contexts), 1)
        self.assertNotEqual(next(iter(alice_contexts)), bob_context)


if __name__ == "__main__":
    unittest.main()
