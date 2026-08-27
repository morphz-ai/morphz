from __future__ import annotations

import unittest

from benchmarks.state_bench.overlay.morphz_state_bench.backends import (
    Mem0Backend,
    _resolve_env_placeholders,
    parse_morphz_recall_page,
)


class BackendsTest(unittest.TestCase):
    def test_morphz_recall_uses_only_live_frames_and_fixed_limit(self) -> None:
        page = {
            "matches": [
                {"document_kind": "event", "preview": "raw event", "retired": False},
                {"document_kind": "frame", "preview": "first", "retired": False},
                {"kind": "frame", "preview": "retired", "retired": True},
                {"kind": "frame", "preview": "second", "retired": False},
                {"kind": "frame", "preview": "third", "retired": False},
                {"kind": "frame", "preview": "fourth", "retired": False},
            ]
        }
        self.assertEqual(parse_morphz_recall_page(page, 3), ["first", "second", "third"])

    def test_morphz_recall_rejects_non_page(self) -> None:
        with self.assertRaisesRegex(ValueError, "matches"):
            parse_morphz_recall_page({}, 3)

    def test_artifact_and_environment_placeholders_are_resolved(self) -> None:
        import os
        from pathlib import Path
        import tempfile

        with tempfile.TemporaryDirectory() as temp:
            os.environ["ME07_TEST_VALUE"] = "resolved"
            try:
                value = _resolve_env_placeholders(
                    {
                        "root": "${ARTIFACT_DIR}/qdrant",
                        "value": "${ME07_TEST_VALUE}",
                    },
                    artifact_dir=Path(temp),
                )
            finally:
                os.environ.pop("ME07_TEST_VALUE", None)
        self.assertTrue(value["root"].endswith("/qdrant"))
        self.assertEqual(value["value"], "resolved")

    def test_mem0_retrieval_uses_agent_scope(self) -> None:
        class FakeMemory:
            def __init__(self):
                self.filters = None

            def search(self, _query, *, top_k, filters):
                self.filters = filters
                return {"results": [{"memory": "procedure", "score": 1.0}][:top_k]}

        backend = Mem0Backend.__new__(Mem0Backend)
        backend.memory = FakeMemory()
        backend.agent_id = "state-bench-travel"
        self.assertEqual(backend.retrieve("cancel flight", 3), ["procedure"])
        self.assertEqual(backend.memory.filters, {"agent_id": "state-bench-travel"})


if __name__ == "__main__":
    unittest.main()
