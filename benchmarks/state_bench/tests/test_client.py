from __future__ import annotations

import unittest

from benchmarks.state_bench.overlay.clients.cliproxy_responses_client import canonical_to_responses_input


class ClientConversionTest(unittest.TestCase):
    def test_canonical_tool_result_is_not_duplicated(self) -> None:
        conversation = [
            {"role": "user", "content": "look up B1"},
            {
                "role": "assistant",
                "content": "checking",
                "tool_calls": [
                    {"name": "get_booking", "arguments": {"id": "B1"}, "result": {"status": "ok"}}
                ],
            },
            {
                "role": "tool",
                "content": [
                    {"name": "get_booking", "arguments": {"id": "B1"}, "result": {"status": "ok"}}
                ],
            },
        ]
        items = canonical_to_responses_input(conversation)
        self.assertEqual(sum(item.get("type") == "function_call" for item in items), 1)
        self.assertEqual(sum(item.get("type") == "function_call_output" for item in items), 1)


if __name__ == "__main__":
    unittest.main()
