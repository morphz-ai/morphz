"""One common STATE-Bench agent used by all three ME-07 memory arms."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from state_bench.agents.base import AgentRuntimeContext, AgentToolCallRequest, AgentTurnResponse, BaseAgent

from morphz_state_bench.backends import FixtureBackend, StrongMemoryBackend, create_backend
from morphz_state_bench.protocol import RETRIEVE_TOP_K


RETRIEVE_TOOL = {
    "type": "function",
    "name": "retrieve_learnings",
    "description": "Retrieve procedural learnings relevant to the current task and conversation.",
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "A concise query describing the current request, constraints, and likely procedure.",
            },
            "top_k": {
                "type": "integer",
                "description": "Benchmark-fixed maximum number of learnings. Use 3.",
                "minimum": 1,
            },
        },
        "required": ["query"],
        "additionalProperties": False,
    },
}

RETRIEVAL_INSTRUCTION = """# Procedural Learning Retrieval
Before the first substantive answer for each task, call `retrieve_learnings` with a concise query grounded in the current request, domain, constraints, and conversation facts. Use the benchmark-fixed top_k value of 3. Retrieved items are guidance learned from past trajectories; apply them only when consistent with current policies, tools, and observed state. The retrieval tool is read-only."""


class MorphzStrongMemoryAgent(BaseAgent):
    """Identical reasoning/tool loop across Morphz, A-MEM and Mem0 arms."""

    def __init__(
        self,
        client,
        system_prompt: str,
        tools: list[dict[str, Any]],
        tool_handlers: dict[str, Any],
        runtime_context: AgentRuntimeContext | None = None,
        retrieve_learnings_top_k: int = RETRIEVE_TOP_K,
        agent_reasoning_effort: str | None = None,
        backend: StrongMemoryBackend | None = None,
        **_kwargs,
    ):
        super().__init__(runtime_context=runtime_context)
        if retrieve_learnings_top_k != RETRIEVE_TOP_K:
            raise ValueError(f"ME-07 requires retrieve_learnings_top_k={RETRIEVE_TOP_K}")
        if agent_reasoning_effort not in (None, "max"):
            raise ValueError("ME-07 agent reasoning effort must be max")
        if runtime_context is None and backend is None:
            raise ValueError("runtime_context is required outside no-model tests")
        self.client = client
        self.system_prompt = system_prompt.rstrip() + "\n\n" + RETRIEVAL_INSTRUCTION
        self.retrieve_learnings_top_k = RETRIEVE_TOP_K
        self.retrieval_calls = 0
        self.observed_response_models: set[str] = set()
        if backend is not None:
            self.backend = backend
            self.arm = backend.arm
        else:
            arm = os.environ["MORPHZ_STATE_BENCH_ARM"]
            artifact_root = Path(os.environ["MORPHZ_STATE_BENCH_ARTIFACT_ROOT"]).resolve()
            self.backend = create_backend(
                arm,
                artifact_root,
                domain=runtime_context.domain,
                task_id=runtime_context.task_id,
                output_dir=runtime_context.output_dir,
            )
            self.arm = arm

    def memory_tool_schemas(self) -> list[dict[str, Any]]:
        return [RETRIEVE_TOOL]

    def memory_tool_handlers(self) -> dict[str, Any]:
        return {"retrieve_learnings": self._handle_retrieve_learnings}

    def _handle_retrieve_learnings(self, arguments: dict[str, Any]) -> dict[str, list[str]]:
        query = arguments.get("query")
        if not isinstance(query, str) or not query.strip():
            raise ValueError("retrieve_learnings requires a non-empty query")
        requested = arguments.get("top_k", RETRIEVE_TOP_K)
        if not isinstance(requested, int) or isinstance(requested, bool) or requested < 1:
            raise ValueError("retrieve_learnings top_k must be an integer >= 1")
        learnings = self.backend.retrieve(query.strip(), RETRIEVE_TOP_K)
        if not isinstance(learnings, list) or any(not isinstance(item, str) for item in learnings):
            raise TypeError("memory backend must return list[str]")
        if len(learnings) > RETRIEVE_TOP_K:
            raise ValueError("memory backend exceeded benchmark-fixed top_k")
        self.retrieval_calls += 1
        return {"learnings": learnings}

    def generate_next_turn(
        self,
        *,
        system_prompt: str,
        conversation: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> AgentTurnResponse:
        generated = self.client.generate(
            system_prompt=self.system_prompt,
            conversation=conversation,
            tools=tools,
        )
        if generated.usage is not None:
            self.add_response_usage(generated.usage, category="agent_turn")
        if generated.response_model:
            self.observed_response_models.add(str(generated.response_model))
        return AgentTurnResponse(
            text=generated.text,
            tool_calls=[
                AgentToolCallRequest(name=call.name, arguments=call.arguments)
                for call in generated.tool_calls
            ],
        )

    def ingest_trajectory(self, trajectory: Any) -> None:
        trajectory.metadata["me07_memory"] = {
            "protocol_id": "ME-07-STATE-Bench-strong-memory-v1",
            "arm": self.arm,
            "retrieve_learnings_top_k": RETRIEVE_TOP_K,
            "retrieval_calls": self.retrieval_calls,
            "retrieval_read_only": True,
            "backend": self.backend.audit_metadata(),
            "observed_response_models": sorted(self.observed_response_models),
        }


__all__ = ["MorphzStrongMemoryAgent", "FixtureBackend"]
