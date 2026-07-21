#!/usr/bin/env python3
"""Bridge the official π-Bench test channel to a persistent Morphz server.

The benchmark emits ``sender_id`` (persona) and ``chat_id`` (task) on every
message.  The bridge maps one persona to one Morphz Principal + Context and one
task to one Session.  This preserves shared Mind while keeping task transcripts
structurally separate.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any


def env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name, default)
    if value is None or not value.strip():
        raise RuntimeError(f"missing required environment variable: {name}")
    return value.strip()


def stable_id(prefix: str, raw: str) -> str:
    readable = re.sub(r"[^A-Za-z0-9_-]+", "-", raw).strip("-")[:48] or "unknown"
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:10]
    return f"{prefix}-{readable}-{digest}"


def request_json(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    body: dict[str, Any] | None = None,
    timeout: float = 60.0,
) -> dict[str, Any]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Accept", "application/json")
    if data is not None:
        request.add_header("Content-Type", "application/json")
    for name, value in (headers or {}).items():
        request.add_header(name, value)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read()
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {url} failed: HTTP {error.code}: {detail}") from error
    if not payload:
        return {}
    decoded = json.loads(payload)
    if not isinstance(decoded, dict):
        raise RuntimeError(f"{method} {url} returned a non-object JSON payload")
    return decoded


@dataclass
class SessionTrace:
    session_id: str
    started_at: str
    turn: int = 0


@dataclass
class Bridge:
    test_server_url: str
    morphz_url: str
    morphz_token: str
    context_id: str
    model_id: str
    trace_root: Path
    reply_timeout: float
    sessions: dict[tuple[str, str], SessionTrace] = field(default_factory=dict)

    def morphz_headers(self, sender_id: str) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.morphz_token}",
            "X-Morphz-Principal": stable_id("principal", sender_id),
            "X-Morphz-Principal-Name": sender_id,
        }

    def test_request(
        self, method: str, path: str, body: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        return request_json(method, f"{self.test_server_url}{path}", body=body)

    def morphz_request(
        self,
        method: str,
        path: str,
        sender_id: str,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return request_json(
            method,
            f"{self.morphz_url}{path}",
            headers=self.morphz_headers(sender_id),
            body=body,
        )

    def persona_context_id(self, sender_id: str) -> str:
        """Return the stable shared Context for one π-Bench persona.

        Tasks belonging to the same persona intentionally share Mind. Different
        personas must not share a Context, otherwise one official episode can
        contaminate another and invalidate both PROC/COMP results.
        """
        return stable_id("pibench-context", f"{self.context_id}:{sender_id}")

    def ensure_context(self, sender_id: str) -> str:
        context_id = self.persona_context_id(sender_id)
        try:
            self.morphz_request(
                "POST",
                "/api/contexts",
                sender_id,
                {
                    "id": context_id,
                    "title": f"π-Bench · {sender_id}",
                },
            )
        except RuntimeError as error:
            # Context creation is idempotent at the bridge boundary. A conflict
            # means another task for the same persona created it first.
            if "HTTP 409" not in str(error):
                raise
        return context_id

    def ensure_session(self, sender_id: str, chat_id: str) -> SessionTrace:
        key = (sender_id, chat_id)
        if key in self.sessions:
            return self.sessions[key]
        context_id = self.ensure_context(sender_id)
        session_id = stable_id("pibench-session", f"{sender_id}:{chat_id}")
        try:
            self.morphz_request("GET", f"/api/sessions/{session_id}", sender_id)
        except RuntimeError as error:
            if "HTTP 404" not in str(error):
                raise
            self.morphz_request(
                "POST",
                "/api/sessions",
                sender_id,
                {
                    "id": session_id,
                    "title": f"π-Bench · {chat_id}",
                    "mount": {
                        "type": "existing_context",
                        "context_id": context_id,
                    },
                },
            )
        trace = SessionTrace(
            session_id=session_id,
            started_at=datetime.now().strftime("%Y%m%d_%H%M%S"),
        )
        self.sessions[key] = trace
        return trace

    def session_events(
        self, sender_id: str, session_id: str, after: int | None = None
    ) -> list[dict[str, Any]]:
        query = {"limit": "1000"}
        if after is not None:
            query["after_sequence"] = str(after)
        encoded = urllib.parse.urlencode(query)
        response = self.morphz_request(
            "GET", f"/api/sessions/{session_id}/events?{encoded}", sender_id
        )
        events = response.get("events") or []
        return [event for event in events if isinstance(event, dict)]

    @staticmethod
    def last_sequence(events: list[dict[str, Any]]) -> int:
        return max((int(event.get("sequence") or 0) for event in events), default=0)

    def send_test_reply(
        self,
        chat_id: str,
        content: str,
        *,
        progress: bool = False,
    ) -> None:
        self.test_request(
            "POST",
            "/send",
            {
                "chat_id": chat_id,
                "content": content,
                "media": [],
                "meta": {"_progress": True} if progress else {},
            },
        )

    def wait_for_reply(
        self,
        sender_id: str,
        chat_id: str,
        trace: SessionTrace,
        baseline_sequence: int,
    ) -> tuple[str, list[dict[str, Any]]]:
        deadline = time.monotonic() + self.reply_timeout
        cursor = baseline_sequence
        observed: list[dict[str, Any]] = []
        while time.monotonic() < deadline:
            events = self.session_events(sender_id, trace.session_id, cursor)
            if events:
                observed.extend(events)
                cursor = max(cursor, self.last_sequence(events))
            for event in events:
                topic = str(event.get("topic") or "")
                payload = event.get("payload") or {}
                text = str(payload.get("text") or "") if isinstance(payload, dict) else ""
                if topic in {"chat/reply", "chat/outbound_message"}:
                    return text, observed
                if topic == "chat/no_reply":
                    return "[Morphz completed without a user-visible reply]", observed
            time.sleep(0.5)
        raise TimeoutError(
            f"Morphz reply timed out after {self.reply_timeout:.0f}s "
            f"for sender={sender_id} chat={chat_id}"
        )

    @staticmethod
    def event_text(event: dict[str, Any]) -> str:
        payload = event.get("payload") or {}
        return str(payload.get("text") or "") if isinstance(payload, dict) else ""

    def trace_messages(self, events: list[dict[str, Any]]) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = []
        for event in sorted(events, key=lambda item: int(item.get("sequence") or 0)):
            topic = str(event.get("topic") or "")
            payload = event.get("payload") or {}
            if not isinstance(payload, dict):
                payload = {}
            text = self.event_text(event)
            if topic == "chat/user_message":
                messages.append({"role": "user", "content": text})
            elif topic in {"chat/reply", "chat/outbound_message"}:
                messages.append({"role": "assistant", "content": text})
            elif topic == "chat/assistant_call":
                calls = payload.get("tool_calls")
                if isinstance(calls, list) and calls:
                    messages.append(
                        {"role": "assistant", "content": text or None, "tool_calls": calls}
                    )
            elif topic == "chat/tool_output":
                messages.append(
                    {
                        "role": "tool",
                        "name": str(payload.get("tool_name") or "tool"),
                        "tool_call_id": str(payload.get("tool_call_id") or ""),
                        "content": text,
                    }
                )
        return messages

    def write_trace(
        self,
        sender_id: str,
        chat_id: str,
        trace: SessionTrace,
        user_input: str,
        output: str,
    ) -> None:
        trace.turn += 1
        events = self.session_events(sender_id, trace.session_id)
        messages = self.trace_messages(events)
        tool_steps = []
        for event in events:
            if event.get("topic") != "chat/tool_output":
                continue
            payload = event.get("payload") or {}
            if not isinstance(payload, dict):
                continue
            tool_steps.append(
                {
                    "name": str(payload.get("tool_name") or "tool"),
                    "arguments": payload.get("arguments") or {},
                    "result": self.event_text(event),
                }
            )
        target = (
            self.trace_root
            / self.model_id.replace("/", "_")
            / sender_id.replace("/", "_")
            / chat_id.replace("/", "_")
            / trace.started_at
        )
        target.mkdir(parents=True, exist_ok=True)
        payload = {
            "session_key": trace.session_id,
            "session_started_at": trace.started_at,
            "channel": "test",
            "chat_id": chat_id,
            "input": user_input,
            "sender_id": sender_id,
            "model": self.model_id,
            "messages": messages,
            "llm_steps": [],
            "tool_steps": tool_steps,
            "output": output,
            "iterations": 0,
            "tools_used": [step["name"] for step in tool_steps],
            "error": None,
        }
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        path = target / f"turn_{timestamp}_{trace.turn:03d}.json"
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def handle(self, message: dict[str, Any]) -> None:
        sender_id = str(message.get("sender_id") or "unknown_user")
        chat_id = str(message.get("chat_id") or "unknown_task")
        content = str(message.get("content") or "")
        if content.strip() == "/new":
            self.ensure_session(sender_id, chat_id)
            self.send_test_reply(chat_id, "New session started")
            return
        trace = self.ensure_session(sender_id, chat_id)
        before = self.session_events(sender_id, trace.session_id)
        baseline = self.last_sequence(before)
        self.morphz_request(
            "POST",
            f"/api/sessions/{trace.session_id}/messages",
            sender_id,
            {
                "text": content,
                "client_message_id": stable_id(
                    "pibench-message", f"{sender_id}:{chat_id}:{trace.turn}:{content}"
                ),
            },
        )
        reply, _ = self.wait_for_reply(sender_id, chat_id, trace, baseline)
        self.write_trace(sender_id, chat_id, trace, content, reply)
        self.send_test_reply(chat_id, reply)

    def run(self) -> None:
        print(
            f"[morphz-pibench] bridge ready test={self.test_server_url} "
            f"morphz={self.morphz_url} context-namespace={self.context_id}",
            flush=True,
        )
        while True:
            payload = self.test_request("GET", "/poll?timeout=30")
            messages = payload.get("messages") or []
            if not messages:
                time.sleep(0.25)
                continue
            for message in messages:
                if isinstance(message, dict):
                    try:
                        self.handle(message)
                    except Exception as error:
                        print(f"[morphz-pibench] message failed: {error}", file=sys.stderr)
                        chat_id = str(message.get("chat_id") or "unknown_task")
                        self.send_test_reply(chat_id, f"[Morphz bridge error: {error}]")


def main() -> None:
    bridge = Bridge(
        test_server_url=env("BENCH_TEST_SERVER_URL", "http://127.0.0.1:9999").rstrip("/"),
        morphz_url=env("MORPHZ_PI_URL", "http://127.0.0.1:8081").rstrip("/"),
        morphz_token=env("MORPHZ_API_TOKEN"),
        context_id=env("MORPHZ_PI_CONTEXT_ID", "context-default"),
        model_id=env("MODEL_ID", "morphz"),
        trace_root=Path(env("MORPHZ_PI_TRACE_LOGS_DIR", "/root/.nanobot/trace_logs")),
        reply_timeout=float(env("MORPHZ_PI_REPLY_TIMEOUT_SECS", "2400")),
    )
    bridge.run()


if __name__ == "__main__":
    main()
