"""Frozen Mem0 OSS reference implementation for ME-07."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

os.environ.setdefault("MEM0_TELEMETRY", "False")

from mem0 import Memory

from benchmarks.state_bench.v2.me07_responses import ME07ResponsesClient

PROTOCOL_ID = "ME-07-STATE-Bench-public-agent-systems-v2"


class Mem0ResponsesLLM:
    """Use the protocol-locked Responses route for Mem0 add-time inference."""

    def __init__(self, client: ME07ResponsesClient):
        self.client = client

    def generate_response(
        self,
        messages: list[dict[str, str]],
        response_format: dict[str, Any] | None = None,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str = "auto",
        **_kwargs: Any,
    ) -> str | dict[str, Any]:
        del tool_choice
        normalized_tools: list[dict[str, Any]] = []
        for tool in tools or []:
            if tool.get("type") == "function" and isinstance(
                tool.get("function"), dict
            ):
                normalized_tools.append({"type": "function", **tool["function"]})
            else:
                normalized_tools.append(tool)
        response = self.client.create(
            input_items=messages,
            tools=normalized_tools or None,
            response_format=response_format,
        )
        calls = self.client.function_calls(response)
        text = self.client.output_text(response)
        if calls:
            return {
                "content": text,
                "tool_calls": [
                    {"name": call["name"], "arguments": call["arguments"]}
                    for call in calls
                ],
            }
        return text


def create_mem0_memory(
    *,
    root: Path,
    domain: str,
    responses_client: ME07ResponsesClient,
) -> Memory:
    root.mkdir(parents=True, exist_ok=True)
    config = {
        "version": "v1.1",
        "history_db_path": str(root / "history.sqlite"),
        "vector_store": {
            "provider": "qdrant",
            "config": {
                "collection_name": f"me07_{domain}",
                "embedding_model_dims": 768,
                "path": str(root / "qdrant"),
                "on_disk": True,
            },
        },
        "llm": {
            "provider": "openai",
            "config": {
                "model": "gpt-5.6-sol",
                "openai_base_url": responses_client.base_url,
                "api_key": responses_client.api_key,
                "reasoning_effort": "max",
                "max_tokens": 8192,
                "is_reasoning_model": True,
            },
        },
        "embedder": {
            "provider": "ollama",
            "config": {
                "model": "nomic-embed-text:latest",
                "embedding_dims": 768,
                "ollama_base_url": "http://127.0.0.1:11434",
            },
        },
        "custom_instructions": (
            "Extract reusable procedural customer-service knowledge, constraints, "
            "verification habits, and failure-avoidance lessons. Do not store "
            "episode-specific IDs, dates, prices, or user records as current truth. "
            "Never invent a lesson absent from the supplied completed trajectory."
        ),
    }
    memory = Memory.from_config(config)
    memory.llm = Mem0ResponsesLLM(responses_client)
    return memory


def memory_results(value: dict[str, Any] | list[Any]) -> list[dict[str, Any]]:
    if isinstance(value, dict):
        results = value.get("results", [])
    else:
        results = value
    if not isinstance(results, list):
        raise TypeError("Mem0 result payload does not contain a list")
    return [item for item in results if isinstance(item, dict)]
