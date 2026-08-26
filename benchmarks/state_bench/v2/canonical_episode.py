"""Canonical serializer shared by every ME-07 training arm."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

PROTOCOL_ID = "ME-07-STATE-Bench-public-agent-systems-v2"


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def load_canonical_episode(path: Path, domain: str) -> tuple[dict[str, Any], str]:
    raw = path.read_bytes()
    value = json.loads(raw)
    if set(value) != {"conversation"} or not isinstance(value["conversation"], list):
        raise ValueError(f"unexpected STATE-Bench training trajectory shape: {path}")
    episode = {
        "protocol_id": PROTOCOL_ID,
        "source_partition": "train_task_trajectories",
        "domain": domain,
        "task_id": path.stem,
        "source_sha256": sha256_bytes(raw),
        "conversation": value["conversation"],
    }
    serialized = json.dumps(
        episode, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    return episode, serialized
