from __future__ import annotations

import json

import httpx
import pytest

from benchmarks.state_bench.v2.me07_responses import ME07ResponsesClient


def _response_payload() -> dict[str, object]:
    return {
        "id": "resp-test",
        "model": "gpt-5.6-sol",
        "status": "completed",
        "output": [],
        "usage": {},
    }


def test_transient_responses_failures_retry_with_auditable_receipt() -> None:
    attempts = 0
    sleeps: list[float] = []

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(
                408,
                json={"error": {"code": "response_stream_disconnected"}},
            )
        if attempts == 2:
            return httpx.Response(
                502,
                json={"error": {"code": "server_is_overloaded"}},
            )
        return httpx.Response(200, json=_response_payload())

    client = ME07ResponsesClient(
        base_url="https://example.test/v1",
        api_key="test-key",
        retry_base_delay_seconds=0.25,
        retry_sleep=sleeps.append,
    )
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        value = client.create(input_items=[])
    finally:
        client.close()

    assert value["id"] == "resp-test"
    assert attempts == 3
    assert sleeps == [0.25, 0.5]
    assert client.receipts == [
        {
            "response_id": "resp-test",
            "model": "gpt-5.6-sol",
            "status": "completed",
            "usage": {},
            "reasoning_effort": "max",
            "fallback": False,
            "transport_attempts": 3,
            "transient_transport_failures": [
                {
                    "attempt": 1,
                    "status_code": 408,
                    "retry_delay_seconds": 0.25,
                    "detail": json.dumps(
                        {"error": {"code": "response_stream_disconnected"}},
                        separators=(",", ":"),
                    ),
                },
                {
                    "attempt": 2,
                    "status_code": 502,
                    "retry_delay_seconds": 0.5,
                    "detail": json.dumps(
                        {"error": {"code": "server_is_overloaded"}},
                        separators=(",", ":"),
                    ),
                },
            ],
        }
    ]


def test_transport_exception_retries_with_auditable_receipt() -> None:
    attempts = 0
    sleeps: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise httpx.ReadTimeout("stream stalled", request=request)
        return httpx.Response(200, json=_response_payload())

    client = ME07ResponsesClient(
        base_url="https://example.test/v1",
        api_key="test-key",
        retry_base_delay_seconds=0.25,
        retry_sleep=sleeps.append,
    )
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        value = client.create(input_items=[])
    finally:
        client.close()

    assert value["id"] == "resp-test"
    assert attempts == 2
    assert sleeps == [0.25]
    assert client.receipts[0]["transport_attempts"] == 2
    assert client.receipts[0]["transient_transport_failures"] == [
        {
            "attempt": 1,
            "error_type": "ReadTimeout",
            "retry_delay_seconds": 0.25,
            "detail": "stream stalled",
        }
    ]


def test_non_transient_responses_failure_is_not_retried() -> None:
    attempts = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(400, text="invalid request")

    client = ME07ResponsesClient(
        base_url="https://example.test/v1",
        api_key="test-key",
        retry_sleep=lambda _delay: pytest.fail("non-transient failure retried"),
    )
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(RuntimeError, match=r"after 1 transport attempt\(s\)"):
            client.create(input_items=[])
    finally:
        client.close()

    assert attempts == 1
