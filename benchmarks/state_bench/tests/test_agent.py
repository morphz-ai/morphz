from __future__ import annotations

import unittest

from state_bench.agents.base import AgentRuntimeContext

from benchmarks.state_bench.overlay.agents.morphz_strong_memory_agent import MorphzStrongMemoryAgent
from benchmarks.state_bench.overlay.morphz_state_bench.backends import FixtureBackend


class AgentTest(unittest.TestCase):
    def _agent(self, backend: FixtureBackend) -> MorphzStrongMemoryAgent:
        return MorphzStrongMemoryAgent(
            object(),
            "system",
            [],
            {},
            runtime_context=AgentRuntimeContext(
                task_id="t1",
                user_id="u1",
                domain="travel",
                now="2026-08-26T00:00:00Z",
            ),
            retrieve_learnings_top_k=3,
            agent_reasoning_effort="max",
            backend=backend,
        )

    def test_requested_top_k_cannot_expand_formal_limit(self) -> None:
        backend = FixtureBackend(["a", "b", "c", "d"])
        agent = self._agent(backend)
        result = agent.memory_tool_handlers()["retrieve_learnings"](
            {"query": "booking policy", "top_k": 999}
        )
        self.assertEqual(result, {"learnings": ["a", "b", "c"]})
        self.assertEqual(backend.calls, [{"query": "booking policy", "top_k": 3}])

    def test_invalid_formal_top_k_is_rejected_at_construction(self) -> None:
        with self.assertRaisesRegex(ValueError, "top_k=3"):
            MorphzStrongMemoryAgent(
                object(),
                "system",
                [],
                {},
                runtime_context=AgentRuntimeContext(
                    task_id="t1", user_id="u1", domain="travel", now="2026-08-26T00:00:00Z"
                ),
                retrieve_learnings_top_k=5,
                backend=FixtureBackend([]),
            )


if __name__ == "__main__":
    unittest.main()
