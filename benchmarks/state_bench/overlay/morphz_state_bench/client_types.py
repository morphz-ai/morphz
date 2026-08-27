"""Provider-neutral response types shared by the custom client and agent."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class GeneratedToolCall:
    name: str
    arguments: dict[str, Any]


@dataclass(slots=True)
class GeneratedTurn:
    text: str
    tool_calls: list[GeneratedToolCall] = field(default_factory=list)
    usage: Any | None = None
    response_id: str | None = None
    response_model: str | None = None
