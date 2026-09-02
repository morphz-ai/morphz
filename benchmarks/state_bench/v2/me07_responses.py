"""Minimal auditable Responses API client for ME-07 adapters."""

from __future__ import annotations

import json
import os
import time
from collections.abc import Callable
from typing import Any

import httpx


class ME07ResponsesClient:
    """Bind exactly to GPT-5.6 Sol/max/no-fallback through CLIProxyAPI."""

    _TRANSIENT_HTTP_STATUSES = frozenset({429, 502, 503, 504})

    def __init__(
        self,
        *,
        model: str = "gpt-5.6-sol",
        base_url: str | None = None,
        api_key: str | None = None,
        timeout_seconds: float = 1800,
        max_transport_attempts: int = 4,
        retry_base_delay_seconds: float = 1.0,
        retry_sleep: Callable[[float], None] | None = None,
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
        if max_transport_attempts < 1:
            raise ValueError("max_transport_attempts must be positive")
        if retry_base_delay_seconds < 0:
            raise ValueError("retry_base_delay_seconds cannot be negative")
        self._max_transport_attempts = max_transport_attempts
        self._retry_base_delay_seconds = retry_base_delay_seconds
        self._retry_sleep = retry_sleep or time.sleep
        self._http = httpx.Client(timeout=timeout_seconds)
        self.receipts: list[dict[str, Any]] = []

    def _retry_delay(self, response: httpx.Response, attempt: int) -> float:
        retry_after = response.headers.get("retry-after")
        if retry_after is not None:
            try:
                return min(30.0, max(0.0, float(retry_after)))
            except ValueError:
                pass
        return min(30.0, self._retry_base_delay_seconds * (2 ** (attempt - 1)))

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

        transient_failures: list[dict[str, Any]] = []
        response: httpx.Response | None = None
        for attempt in range(1, self._max_transport_attempts + 1):
            response = self._http.post(
                f"{self.base_url}/responses",
                headers={"authorization": f"Bearer {self.api_key}"},
                json=payload,
            )
            if not response.is_error:
                break
            detail = response.text[:2000]
            retryable = response.status_code in self._TRANSIENT_HTTP_STATUSES
            if retryable and attempt < self._max_transport_attempts:
                delay = self._retry_delay(response, attempt)
                transient_failures.append(
                    {
                        "attempt": attempt,
                        "status_code": response.status_code,
                        "retry_delay_seconds": delay,
                        "detail": detail[:500],
                    }
                )
                self._retry_sleep(delay)
                continue
            raise RuntimeError(
                "ME-07 Responses request failed after "
                f"{attempt} transport attempt(s) with HTTP "
                f"{response.status_code}: {detail}"
            )
        if response is None:  # pragma: no cover - constructor validation makes this unreachable
            raise RuntimeError("ME-07 Responses request made no transport attempt")
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
                "transport_attempts": 1 + len(transient_failures),
                "transient_transport_failures": transient_failures,
            }
        )
        return value

    def close(self) -> None:
        self._http.close()
