from __future__ import annotations

import unittest

from benchmarks.state_bench.overlay.morphz_state_bench.backends import parse_morphz_recall_page


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


if __name__ == "__main__":
    unittest.main()
