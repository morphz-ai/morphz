"""STATE-Bench-compatible updated evaluator for the ME-07 derived protocol."""

from __future__ import annotations

import hashlib
import json
import threading
from typing import Any

from state_bench.client import BaseLLMClient

from benchmarks.state_bench.v2.me07_responses import ME07ResponsesClient


def _digest(value: object) -> str:
    encoded = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


class ME07UpdatedEvaluatorClient(BaseLLMClient):
    """Expose the STATE-Bench simulator/judge interface over exact Sol/max.

    Upstream prompts, task definitions, deterministic state scoring, and JSON
    parsers remain unchanged.  Only the physical evaluation model and provider
    adapter differ from the historical Azure GPT-5.4 protocol.
    """

    def __init__(self, *, role: str):
        if role not in {"user_simulator", "judge"}:
            raise ValueError(f"invalid ME-07 evaluator role: {role}")
        self.role = role
        self._responses = ME07ResponsesClient()
        self._lock = threading.Lock()
        self.receipts: list[dict[str, Any]] = []

    @property
    def provider_name(self) -> str:
        return "cliproxyapi-responses"

    @property
    def model_name(self) -> str:
        return "gpt-5.6-sol"

    def _record(
        self,
        *,
        kind: str,
        input_value: object,
        instructions: str | None,
        max_tokens: int,
        requested_reasoning_effort: str | None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        provider_receipt = dict(self._responses.receipts[-1])
        receipt = {
            "role": self.role,
            "kind": kind,
            "input_sha256": _digest(input_value),
            "instructions_sha256": _digest(instructions or ""),
            "max_output_tokens": max_tokens,
            "requested_reasoning_effort": requested_reasoning_effort,
            "applied_reasoning_effort": "max",
            **provider_receipt,
            **(metadata or {}),
        }
        with self._lock:
            self.receipts.append(receipt)

    def complete_chat(
        self,
        messages: list[dict[str, str]],
        max_tokens: int = 8192,
        temperature: float | None = None,
    ) -> str:
        del temperature  # Sol/max does not admit a competing sampling setting.
        system_parts = [
            message["content"]
            for message in messages
            if message.get("role") == "system" and message.get("content")
        ]
        input_items = [
            dict(message) for message in messages if message.get("role") != "system"
        ]
        instructions = "\n\n".join(system_parts) or None
        response = self._responses.create(
            input_items=input_items,
            instructions=instructions,
            max_output_tokens=max_tokens,
        )
        text = self._responses.output_text(response)
        if not text.strip():
            raise RuntimeError("ME-07 user simulator returned empty text")
        self._record(
            kind="chat",
            input_value=input_items,
            instructions=instructions,
            max_tokens=max_tokens,
            requested_reasoning_effort=None,
        )
        return text

    def complete_json(
        self,
        prompt: str,
        system_prompt: str | None = None,
        max_tokens: int = 8192,
        reasoning_effort: str | None = None,
    ) -> dict[str, Any]:
        format_guard = "OUTPUT FORMAT: Return a valid JSON object."
        transport_prompt = f"{prompt}\n\n{format_guard}"
        input_items = [{"role": "user", "content": transport_prompt}]
        response = self._responses.create(
            input_items=input_items,
            instructions=system_prompt,
            response_format={"type": "json_object"},
            max_output_tokens=max_tokens,
        )
        text = self._responses.output_text(response)
        value = json.loads(text)
        if not isinstance(value, dict):
            raise TypeError("ME-07 evaluator JSON response is not an object")
        self._record(
            kind="json",
            input_value=input_items,
            instructions=system_prompt,
            max_tokens=max_tokens,
            requested_reasoning_effort=reasoning_effort,
            metadata={
                "upstream_prompt_sha256": _digest(prompt),
                "transport_format_guard": format_guard,
            },
        )
        return value

    def close(self) -> None:
        self._responses.close()


__all__ = ["ME07UpdatedEvaluatorClient"]
