"""Convert a Morphz event store into Harbor's ATIF-v1.7 trajectory.

The event store remains the authority.  This module is intentionally a
post-run, read-only projection: it never changes Runtime state and never
reconstructs actions from console prose when structured Events are available.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from harbor.models.trajectories import (
    Agent,
    FinalMetrics,
    Metrics,
    Observation,
    ObservationResult,
    Step,
    ToolCall,
    Trajectory,
)
from harbor.utils.trajectory_utils import format_trajectory_json


@dataclass(frozen=True)
class EventRecord:
    sequence: int
    event_id: str
    timestamp: str
    actor: str
    event_type: str
    topic: str
    payload: dict[str, Any]


@dataclass
class StepDraft:
    sequence: int
    timestamp: str | None
    source: str
    message: str
    attempt_id: str | None = None
    reasoning_content: str | None = None
    tool_calls: list[ToolCall] = field(default_factory=list)
    observation_results: list[ObservationResult] = field(default_factory=list)
    event_ids: list[str] = field(default_factory=list)
    llm_call_count: int | None = None


def _read_events(db_path: Path) -> list[EventRecord]:
    if not db_path.is_file():
        raise FileNotFoundError(f"Morphz event store does not exist: {db_path}")
    connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = connection.execute(
            "SELECT rowid, id, timestamp, actor, type, topic, payload "
            "FROM events ORDER BY rowid"
        ).fetchall()
    finally:
        connection.close()
    events: list[EventRecord] = []
    for sequence, event_id, timestamp, actor, event_type, topic, raw_payload in rows:
        try:
            payload = json.loads(raw_payload)
        except (json.JSONDecodeError, TypeError):
            payload = {"raw_payload": str(raw_payload)}
        if not isinstance(payload, dict):
            payload = {"value": payload}
        events.append(
            EventRecord(
                sequence=int(sequence),
                event_id=str(event_id),
                timestamp=str(timestamp),
                actor=str(actor),
                event_type=str(event_type),
                topic=str(topic),
                payload=payload,
            )
        )
    return events


def _attempt_id(payload: dict[str, Any]) -> str | None:
    value = payload.get("model_attempt_id") or payload.get("attempt_id")
    return str(value) if value else None


def _integer(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def _arguments(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {"raw": value}
        return parsed if isinstance(parsed, dict) else {"value": parsed}
    return {} if value is None else {"value": value}


def _tool_call(value: Any, fallback_id: str) -> ToolCall | None:
    if not isinstance(value, dict):
        return None
    function = value.get("function")
    function = function if isinstance(function, dict) else {}
    call_id = value.get("id") or value.get("tool_call_id") or fallback_id
    name = (
        value.get("name")
        or value.get("func_name")
        or value.get("tool_name")
        or function.get("name")
    )
    if not name:
        return None
    raw_arguments = value.get("arguments", function.get("arguments"))
    return ToolCall(
        tool_call_id=str(call_id),
        function_name=str(name),
        arguments=_arguments(raw_arguments),
        extra={"morphz_call_shape": "structured_event"},
    )


def _usage(payload: dict[str, Any]) -> dict[str, Any]:
    value = payload.get("usage")
    return value if isinstance(value, dict) else {}


def _metrics(usage: dict[str, Any]) -> Metrics | None:
    prompt_tokens = _integer(usage.get("input_tokens"))
    completion_tokens = _integer(usage.get("output_tokens"))
    cached_tokens = _integer(usage.get("cached_input_tokens"))
    if prompt_tokens is None and completion_tokens is None and cached_tokens is None:
        return None
    extra: dict[str, Any] = {}
    for source, target in (
        ("uncached_input_tokens", "uncached_input_tokens"),
        ("cache_write_input_tokens", "cache_write_input_tokens"),
        ("reasoning_tokens", "reasoning_tokens"),
        ("total_tokens", "provider_total_tokens"),
    ):
        if (value := _integer(usage.get(source))) is not None:
            extra[target] = value
    return Metrics(
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        cached_tokens=cached_tokens,
        extra=extra or None,
    )


def _binding_model(payload: dict[str, Any]) -> str | None:
    binding = payload.get("model_binding")
    if not isinstance(binding, dict):
        return None
    value = binding.get("physical_model")
    return str(value) if value else None


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_trajectory(
    db_path: Path,
    *,
    instruction: str,
    session_id: str,
    context_id: str,
    agent_version: str,
    configured_model: str,
    reasoning_effort: str = "max",
    permission_mode: str = "full_access",
) -> Trajectory:
    events = _read_events(db_path)

    usage_by_attempt: dict[str, dict[str, Any]] = {}
    reasoning_by_attempt: dict[str, str] = {}
    model_by_attempt: dict[str, str] = {}
    for event in events:
        attempt_id = _attempt_id(event.payload)
        if not attempt_id:
            continue
        if event.topic == "runtime/model_usage":
            usage_by_attempt[attempt_id] = _usage(event.payload)
        elif event.topic == "runtime/model_reasoning_summary":
            text = event.payload.get("text")
            if isinstance(text, str) and text:
                reasoning_by_attempt[attempt_id] = text
        if (physical_model := _binding_model(event.payload)) is not None:
            model_by_attempt[attempt_id] = physical_model

    drafts: list[StepDraft] = []
    assistant_by_attempt: dict[str, StepDraft] = {}
    assistant_by_tool_call: dict[str, StepDraft] = {}
    matched_output_ids: set[str] = set()
    saw_user_message = False

    for event in events:
        payload = event.payload
        if event.topic == "chat/user_message":
            text = payload.get("text")
            if isinstance(text, str) and text.strip():
                saw_user_message = True
                drafts.append(
                    StepDraft(
                        sequence=event.sequence,
                        timestamp=event.timestamp,
                        source="user",
                        message=text,
                        event_ids=[event.event_id],
                    )
                )
            continue

        if event.topic == "chat/assistant_call":
            attempt_id = _attempt_id(payload)
            raw_calls = payload.get("tool_calls")
            calls: list[ToolCall] = []
            if isinstance(raw_calls, list):
                for index, raw_call in enumerate(raw_calls, start=1):
                    call = _tool_call(raw_call, f"{event.event_id}:call:{index}")
                    if call is not None:
                        calls.append(call)
            text = payload.get("text")
            draft = StepDraft(
                sequence=event.sequence,
                timestamp=event.timestamp,
                source="agent",
                message=text if isinstance(text, str) else "",
                attempt_id=attempt_id,
                reasoning_content=reasoning_by_attempt.get(attempt_id or ""),
                tool_calls=calls,
                event_ids=[event.event_id],
                llm_call_count=1,
            )
            drafts.append(draft)
            if attempt_id:
                assistant_by_attempt[attempt_id] = draft
            for call in calls:
                assistant_by_tool_call[call.tool_call_id] = draft
            continue

        if event.topic == "chat/reply":
            text = payload.get("text")
            text = text if isinstance(text, str) else ""
            attempt_id = _attempt_id(payload)
            existing = assistant_by_attempt.get(attempt_id or "")
            if existing is not None:
                if text and (not existing.message or existing.message != text):
                    existing.message = text
                existing.event_ids.append(event.event_id)
            else:
                drafts.append(
                    StepDraft(
                        sequence=event.sequence,
                        timestamp=event.timestamp,
                        source="agent",
                        message=text,
                        attempt_id=attempt_id,
                        reasoning_content=reasoning_by_attempt.get(attempt_id or ""),
                        event_ids=[event.event_id],
                        llm_call_count=1 if attempt_id else 0,
                    )
                )
            continue

        if event.topic == "chat/context_tx_committed":
            receipt = {
                key: payload.get(key)
                for key in (
                    "transaction_id",
                    "before_version",
                    "after_version",
                    "reason",
                    "transaction",
                )
                if key in payload
            }
            drafts.append(
                StepDraft(
                    sequence=event.sequence,
                    timestamp=event.timestamp,
                    source="system",
                    message="Morphz committed a structured Context transaction.",
                    observation_results=[
                        ObservationResult(
                            content=json.dumps(receipt, ensure_ascii=False),
                            extra={"morphz_topic": event.topic, "event_id": event.event_id},
                        )
                    ],
                    event_ids=[event.event_id],
                )
            )

    for event in events:
        if event.topic != "chat/tool_output":
            continue
        payload = event.payload
        tool_call_id = payload.get("tool_call_id") or payload.get("caused_by")
        if not tool_call_id:
            continue
        draft = assistant_by_tool_call.get(str(tool_call_id))
        if draft is None:
            continue
        content = payload.get("text")
        draft.observation_results.append(
            ObservationResult(
                source_call_id=str(tool_call_id),
                content=content if isinstance(content, str) else json.dumps(content),
                extra={
                    "morphz_topic": event.topic,
                    "event_id": event.event_id,
                    "tool_status": payload.get("tool_status"),
                },
            )
        )
        draft.event_ids.append(event.event_id)
        matched_output_ids.add(event.event_id)

    for event in events:
        if event.topic != "chat/tool_output" or event.event_id in matched_output_ids:
            continue
        payload = event.payload
        content = payload.get("text")
        drafts.append(
            StepDraft(
                sequence=event.sequence,
                timestamp=event.timestamp,
                source="system",
                message="Morphz Runtime produced an unmatched tool observation.",
                observation_results=[
                    ObservationResult(
                        content=content if isinstance(content, str) else json.dumps(content),
                        extra={
                            "morphz_topic": event.topic,
                            "event_id": event.event_id,
                            "tool_name": payload.get("tool_name"),
                            "tool_status": payload.get("tool_status"),
                        },
                    )
                ],
                event_ids=[event.event_id],
            )
        )

    if not saw_user_message:
        drafts.append(
            StepDraft(
                sequence=0,
                timestamp=events[0].timestamp if events else None,
                source="user",
                message=instruction,
                event_ids=["harbor:instruction"],
            )
        )
    if not drafts:
        drafts.append(
            StepDraft(
                sequence=0,
                timestamp=None,
                source="system",
                message="Morphz Runtime completed without a projectable dialogue Event.",
                event_ids=["morphz:empty-projection"],
            )
        )

    steps: list[Step] = []
    for step_id, draft in enumerate(sorted(drafts, key=lambda item: item.sequence), start=1):
        metrics = _metrics(usage_by_attempt.get(draft.attempt_id or "", {}))
        model_name = model_by_attempt.get(draft.attempt_id or "", configured_model)
        steps.append(
            Step(
                step_id=step_id,
                timestamp=draft.timestamp,
                source=draft.source,
                model_name=model_name if draft.source == "agent" and draft.llm_call_count else None,
                reasoning_effort=(
                    reasoning_effort
                    if draft.source == "agent" and draft.llm_call_count
                    else None
                ),
                message=draft.message,
                reasoning_content=(
                    draft.reasoning_content
                    if draft.source == "agent" and draft.llm_call_count
                    else None
                ),
                tool_calls=draft.tool_calls or None,
                observation=(
                    Observation(results=draft.observation_results)
                    if draft.observation_results
                    else None
                ),
                metrics=metrics if draft.source == "agent" and draft.llm_call_count else None,
                llm_call_count=draft.llm_call_count,
                extra={
                    "morphz_event_ids": draft.event_ids,
                    "morphz_attempt_id": draft.attempt_id,
                },
            )
        )

    total_prompt = 0
    total_completion = 0
    total_cached = 0
    has_prompt = False
    has_completion = False
    has_cached = False
    for usage in usage_by_attempt.values():
        if (value := _integer(usage.get("input_tokens"))) is not None:
            total_prompt += value
            has_prompt = True
        if (value := _integer(usage.get("output_tokens"))) is not None:
            total_completion += value
            has_completion = True
        if (value := _integer(usage.get("cached_input_tokens"))) is not None:
            total_cached += value
            has_cached = True

    return Trajectory(
        schema_version="ATIF-v1.7",
        session_id=session_id,
        trajectory_id=f"morphz:{context_id}:{session_id}",
        agent=Agent(
            name="morphz",
            version=agent_version,
            model_name=configured_model,
            extra={
                "context_id": context_id,
                "reasoning_effort": reasoning_effort,
                "permission_mode": permission_mode,
            },
        ),
        steps=steps,
        notes=(
            "Read-only ATIF projection of the authoritative Morphz SQLite Event store. "
            "Structured Context transactions are represented as Runtime observations."
        ),
        final_metrics=FinalMetrics(
            total_prompt_tokens=total_prompt if has_prompt else None,
            total_completion_tokens=total_completion if has_completion else None,
            total_cached_tokens=total_cached if has_cached else None,
            total_steps=len(steps),
            extra={"unique_model_attempts_with_usage": len(usage_by_attempt)},
        ),
        extra={
            "source": "morphz_sqlite_event_store",
            "event_store_sha256": _sha256(db_path),
            "event_count": len(events),
            "context_id": context_id,
        },
    )


def write_trajectory(
    db_path: Path,
    output_path: Path,
    **kwargs: Any,
) -> Trajectory:
    trajectory = build_trajectory(db_path, **kwargs)
    output_path.write_text(
        format_trajectory_json(trajectory.to_json_dict()) + "\n",
        encoding="utf-8",
    )
    return trajectory
