"""Exact GPT-5.6 Sol/max Responses client for the ME-07 agent."""

from __future__ import annotations

import hashlib
import json
import os
from typing import Any

from state_bench.client import BaseLLMClient

from morphz_state_bench.client_types import GeneratedToolCall, GeneratedTurn


def _call_id(index: int, call_index: int, call: dict[str, Any]) -> str:
    encoded = json.dumps(call, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return f"call_replay_{index}_{call_index}_{hashlib.sha256(encoded).hexdigest()[:12]}"


def canonical_to_responses_input(conversation: list[dict[str, Any]]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for index, message in enumerate(conversation):
        role = message.get("role")
        if role == "tool":
            # The immediately preceding assistant record already carries the
            # same canonical tool results. This temporary STATE-Bench item is
            # for provider replay and must not be duplicated.
            continue
        content = message.get("content") or ""
        if role in {"user", "assistant", "system"} and content:
            items.append({"role": role, "content": content})
        for call_index, call in enumerate(message.get("tool_calls") or []):
            call_id = _call_id(index, call_index, call)
            items.append(
                {
                    "type": "function_call",
                    "call_id": call_id,
                    "name": str(call.get("name") or ""),
                    "arguments": json.dumps(
                        call.get("arguments") or {}, ensure_ascii=False, sort_keys=True, separators=(",", ":")
                    ),
                }
            )
            items.append(
                {
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": json.dumps(call.get("result"), ensure_ascii=False, sort_keys=True, separators=(",", ":")),
                }
            )
    return items


class CLIProxyResponsesClient(BaseLLMClient):
    """OpenAI-compatible Responses client with a fail-closed model contract."""

    def __init__(self, *, api_key: str, base_url: str, model: str, reasoning_effort: str):
        if model != "gpt-5.6-sol":
            raise ValueError("ME-07 agent model must be gpt-5.6-sol")
        if reasoning_effort != "max":
            raise ValueError("ME-07 agent reasoning effort must be max")
        from openai import OpenAI

        self._client = OpenAI(api_key=api_key, base_url=base_url.rstrip("/"))
        self._model = model
        self.reasoning_effort = reasoning_effort
        self.base_url = base_url.rstrip("/")

    @classmethod
    def from_env(cls) -> "CLIProxyResponsesClient":
        return cls(
            api_key=os.environ["MORPHZ_STATE_BENCH_AGENT_API_KEY"],
            base_url=os.environ["MORPHZ_STATE_BENCH_AGENT_BASE_URL"],
            model=os.environ.get("MORPHZ_STATE_BENCH_AGENT_MODEL", "gpt-5.6-sol"),
            reasoning_effort=os.environ.get("MORPHZ_STATE_BENCH_AGENT_REASONING", "max"),
        )

    @property
    def provider_name(self) -> str:
        return "cliproxyapi"

    @property
    def model_name(self) -> str:
        return self._model

    def generate(
        self,
        *,
        system_prompt: str,
        conversation: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> GeneratedTurn:
        response = self._client.responses.create(
            model=self._model,
            instructions=system_prompt,
            input=canonical_to_responses_input(conversation),
            tools=tools,
            reasoning={"effort": self.reasoning_effort},
            parallel_tool_calls=True,
            store=False,
        )
        tool_calls: list[GeneratedToolCall] = []
        for item in response.output:
            if getattr(item, "type", None) != "function_call":
                continue
            arguments = json.loads(item.arguments)
            if not isinstance(arguments, dict):
                raise TypeError("Responses function arguments must decode to an object")
            tool_calls.append(GeneratedToolCall(name=item.name, arguments=arguments))
        return GeneratedTurn(
            text=response.output_text or "",
            tool_calls=tool_calls,
            usage=response.usage,
            response_id=response.id,
            response_model=getattr(response, "model", None),
        )
