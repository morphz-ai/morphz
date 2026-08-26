from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from benchmarks.state_bench.overlay.morphz_state_bench.protocol import (
    canonicalize_trajectory,
    load_protocol_lock,
    validate_protocol_lock,
)


ROOT = Path(__file__).resolve().parents[1]


class ProtocolTest(unittest.TestCase):
    def test_checked_in_protocol_lock_is_valid(self) -> None:
        lock = load_protocol_lock(ROOT / "protocol_lock.json")
        self.assertEqual(validate_protocol_lock(lock), [])

    def test_canonical_trajectory_is_stable_and_keeps_tool_evidence(self) -> None:
        value = {
            "conversation": [
                {"role": "user", "content": "cancel"},
                {
                    "role": "assistant",
                    "content": "preview",
                    "tool_calls": [
                        {
                            "name": "cancel_booking",
                            "arguments": {"confirm": False, "id": "B1"},
                            "result": {"status": "preview"},
                        }
                    ],
                },
            ]
        }
        with tempfile.TemporaryDirectory() as raw:
            path = Path(raw) / "train-1.json"
            path.write_text(json.dumps(value), encoding="utf-8")
            first = canonicalize_trajectory(path, "travel")
            second = canonicalize_trajectory(path, "travel")
        self.assertEqual(first, second)
        decoded = json.loads(first)
        call = decoded["conversation"][1]["tool_calls"][0]
        self.assertEqual(call["name"], "cancel_booking")
        self.assertEqual(call["result"], {"status": "preview"})


if __name__ == "__main__":
    unittest.main()
