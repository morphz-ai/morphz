"""Minimal auditable Responses API client for ME-07 adapters."""

from __future__ import annotations

import json
import os
from typing import Any

import httpx


class ME07ResponsesClient:
    """Bind exactly to GPT-5.6 Sol/max/no-fallback through CLIProxyAPI."""

    def __init__(
        self,
        *,
        model: str = "gpt-5.6-sol",
        base_url: str | None = None,
        api_key: str | None = None,
        timeout_seconds: float = 1800,
    ):
        self.model = model
        self.base_url = (base_url or os.environ.get("OPENAI_BASE_URL") or "").rstrip(
            "/"
        )
        self.api_key = api_key or os.environ.get("OPENAI_API_KEY") or ""
        if not self.base_url or not self.api_key:
            raise RuntimeError(
                "ME-07 Responses client requires proxy URL and client key"
            )
        self._http = httpx.Client(timeout=timeout_seconds)
        self.receipts: list[dict[str, Any]] = []

    @staticmethod
    def output_text(response: dict[str, Any]) -> str:
        texts: list[str] = []
        for item in response.get("output", []):
            if item.get("type") != "message":
                continue
            for content in item.get("content", []):
                if content.get("type") == "output_text" and isinstance(
                    content.get("text"), str
                ):
                    texts.append(content["text"])
        return "\n".join(texts)

    @staticmethod
    def function_calls(response: dict[str, Any]) -> list[dict[str, Any]]:
        calls: list[dict[str, Any]] = []
        for item in response.get("output", []):
            if item.get("type") != "function_call":
                continue
            arguments = json.loads(item.get("arguments", "{}"))
            if not isinstance(arguments, dict):
                raise TypeError("Responses function-call arguments are not an object")
            calls.append(
                {
                    "name": item["name"],
                    "arguments": arguments,
                    "call_id": item["call_id"],
                }
            )
        return calls

    def create(
        self,
        *,
        input_items: list[dict[str, Any]],
        instructions: str | None = None,
        tools: list[dict[str, Any]] | None = None,
        previous_response_id: str | None = None,
        response_format: dict[str, Any] | None = None,
        max_output_tokens: int = 8192,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.model,
            "input": input_items,
            "reasoning": {"effort": "max"},
            "max_output_tokens": max_output_tokens,
            "store": True,
        }
        if instructions:
            payload["instructions"] = instructions
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        if previous_response_id:
            payload["previous_response_id"] = previous_response_id
        if response_format:
            payload["text"] = {"format": response_format}

        response = self._http.post(
            f"{self.base_url}/responses",
            headers={"authorization": f"Bearer {self.api_key}"},
            json=payload,
        )
        if response.is_error:
            detail = response.text[:2000]
            raise RuntimeError(
                f"ME-07 Responses request failed with HTTP {response.status_code}: {detail}"
            )
        value = response.json()
        if value.get("model") != self.model:
            raise RuntimeError(
                f"ME-07 physical model mismatch: {value.get('model')!r} != {self.model!r}"
            )
        usage = value.get("usage") or {}
        self.receipts.append(
            {
                "response_id": value.get("id"),
                "model": value.get("model"),
                "status": value.get("status"),
                "usage": usage,
                "reasoning_effort": "max",
                "fallback": False,
            }
        )
        return value

    def close(self) -> None:
        self._http.close()
