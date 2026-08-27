"""Frozen protocol helpers for the ME-07 strong-memory comparison."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


FORMAL_ARMS = ("morphz", "amem", "mem0")
DOMAINS = ("travel", "customer_support", "shopping_assistant")
RETRIEVE_TOP_K = 3
TRAIN_TRAJECTORIES_PER_DOMAIN = 100
FORBIDDEN_SECRET_KEYS = {
    "api_key",
    "authorization",
    "credential",
    "password",
    "private_key",
    "secret",
    "token",
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def load_protocol_lock(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("protocol lock must be a JSON object")
    return value


def validate_protocol_lock(lock: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if tuple(lock.get("formal_arms") or ()) != FORMAL_ARMS:
        errors.append("formal_arms")
    forbidden = set(lock.get("forbidden_formal_arms") or ())
    if not {"no_memory", "messages_only"}.issubset(forbidden):
        errors.append("forbidden_formal_arms")
    dataset = lock.get("dataset") or {}
    if tuple(dataset.get("domains") or ()) != DOMAINS:
        errors.append("dataset.domains")
    if dataset.get("train_trajectories_per_domain") != TRAIN_TRAJECTORIES_PER_DOMAIN:
        errors.append("dataset.train_trajectories_per_domain")
    run = lock.get("formal_run") or {}
    if run.get("retrieve_learnings_top_k") != RETRIEVE_TOP_K:
        errors.append("formal_run.retrieve_learnings_top_k")
    if run.get("retrieval_mutates_memory") is not False:
        errors.append("formal_run.retrieval_mutates_memory")
    agent = lock.get("agent_model") or {}
    expected_agent = {
        "route": "gpt-5.6-sol",
        "physical_model": "gpt-5.6-sol",
        "reasoning_effort": "max",
        "provider": "cliproxyapi",
        "api": "responses",
        "fallback": False,
    }
    for key, expected in expected_agent.items():
        if agent.get(key) != expected:
            errors.append(f"agent_model.{key}")
    evaluator = lock.get("locked_evaluation_model") or {}
    if evaluator.get("model") != "gpt-5.4" or evaluator.get("provider") != "azure_openai":
        errors.append("locked_evaluation_model")
    if evaluator.get("substitution_allowed") is not False:
        errors.append("locked_evaluation_model.substitution_allowed")
    errors.extend(f"secret:{path}" for path in find_secret_paths(lock))
    return errors


def find_secret_paths(value: Any, prefix: str = "") -> list[str]:
    hits: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            normalized = str(key).lower()
            if normalized in FORBIDDEN_SECRET_KEYS or any(
                normalized.endswith("_" + suffix) for suffix in FORBIDDEN_SECRET_KEYS
            ):
                hits.append(path)
            hits.extend(find_secret_paths(child, path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            hits.extend(find_secret_paths(child, f"{prefix}[{index}]"))
    return hits


def discover_train_trajectories(train_root: Path, domain: str) -> list[Path]:
    if domain not in DOMAINS:
        raise ValueError(f"unsupported domain: {domain}")
    root = train_root.resolve()
    normalized = root.as_posix().rstrip("/")
    if not normalized.endswith("datasets/train_task_trajectories"):
        raise ValueError("learning input must be the official datasets/train_task_trajectories root")
    paths = sorted((root / domain).glob("*.json"))
    if len(paths) != TRAIN_TRAJECTORIES_PER_DOMAIN:
        raise ValueError(
            f"expected {TRAIN_TRAJECTORIES_PER_DOMAIN} train trajectories for {domain}, got {len(paths)}"
        )
    return paths


def canonicalize_trajectory(path: Path, domain: str) -> str:
    value = json.loads(path.read_text(encoding="utf-8"))
    conversation = value.get("conversation") if isinstance(value, dict) else None
    if not isinstance(conversation, list):
        raise ValueError(f"trajectory missing conversation list: {path}")
    normalized_messages: list[dict[str, Any]] = []
    for message in conversation:
        if not isinstance(message, dict):
            raise ValueError(f"trajectory contains non-object message: {path}")
        normalized: dict[str, Any] = {
            "role": str(message.get("role") or ""),
            "content": message.get("content") or "",
        }
        calls = message.get("tool_calls") or []
        if calls:
            normalized["tool_calls"] = [
                {
                    "name": str(call.get("name") or ""),
                    "arguments": call.get("arguments") or {},
                    "result": call.get("result"),
                }
                for call in calls
            ]
        normalized_messages.append(normalized)
    envelope = {
        "schema": "state-bench-train-trajectory-v1",
        "domain": domain,
        "trajectory_id": path.stem,
        "conversation": normalized_messages,
    }
    return canonical_json(envelope)
