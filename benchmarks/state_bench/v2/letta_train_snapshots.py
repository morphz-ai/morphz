"""Build frozen Letta domain snapshots from canonical STATE-Bench episodes.

Only ``datasets/train_task_trajectories`` is accepted as input.  The script
gives each completed episode to one persistent Letta Agent per domain and lets
the Agent decide, through its native memory tools, which procedural lessons to
retain.  It never reads held-out task definitions, task environments, or
oracle requirements.
"""

from __future__ import annotations

import argparse
import json
import time
import uuid
from pathlib import Path
from typing import Any

from letta_client import Letta

from benchmarks.state_bench.v2.canonical_episode import (
    PROTOCOL_ID,
    load_canonical_episode,
    sha256_bytes,
)

DOMAINS = {"travel", "customer_support", "shopping_assistant"}


def _assistant_texts(response: object) -> list[str]:
    return [
        message.content
        for message in getattr(response, "messages", []) or []
        if getattr(message, "message_type", None) == "assistant_message"
        and isinstance(getattr(message, "content", None), str)
    ]


def _native_tools(response: object) -> list[str]:
    tools: list[str] = []
    for message in getattr(response, "messages", []) or []:
        if getattr(message, "message_type", None) != "tool_call_message":
            continue
        name = getattr(getattr(message, "tool_call", None), "name", None)
        if isinstance(name, str):
            tools.append(name)
    return tools


def _usage(response: object) -> dict[str, int]:
    usage = getattr(response, "usage", None)
    return {
        "input_tokens": int(getattr(usage, "prompt_tokens", 0) or 0),
        "cached_input_tokens": int(getattr(usage, "cached_input_tokens", 0) or 0),
        "output_tokens": int(getattr(usage, "completion_tokens", 0) or 0),
        "reasoning_tokens": int(getattr(usage, "reasoning_tokens", 0) or 0),
    }


def _binding(state: Any) -> dict[str, Any]:
    llm = state.llm_config
    embedding = state.embedding_config
    return {
        "model": llm.model,
        "model_endpoint_type": llm.model_endpoint_type,
        "model_endpoint": llm.model_endpoint,
        "reasoning_effort": llm.reasoning_effort,
        "context_window": llm.context_window,
        "fallback": False,
        "embedding_model": embedding.embedding_model if embedding else None,
        "embedding_endpoint_type": (
            embedding.embedding_endpoint_type if embedding else None
        ),
        "embedding_dimension": embedding.embedding_dim if embedding else None,
    }


def _create_agent(client: Letta, domain: str, model_endpoint: str) -> Any:
    return client.agents.create(
        name=f"me07-letta-train-{domain}-{uuid.uuid4().hex[:8]}",
        agent_type="letta_v1_agent",
        system=(
            "You are a persistent customer-service Agent learning from completed "
            f"historical episodes in the {domain} domain. Distill reusable procedural "
            "knowledge, constraints, verification habits, and failure-avoidance lessons "
            "using your native Letta memory tools. Do not treat episode-specific IDs, "
            "dates, prices, or user records as current facts. Never invent a lesson that "
            "is absent from the supplied trajectory. During held-out work, use the same "
            "durable memory while following the task-specific system prompt and tools."
        ),
        llm_config={
            "context_window": 256_000,
            "model": "gpt-5.6-sol",
            "model_endpoint_type": "openai",
            "model_endpoint": model_endpoint,
            "handle": "openai/gpt-5.6-sol",
            "provider_name": "openai",
            "reasoning_effort": "max",
            "parallel_tool_calls": False,
        },
        embedding_config={
            "embedding_dim": 768,
            "embedding_endpoint_type": "ollama",
            "embedding_model": "nomic-embed-text:latest",
            "embedding_endpoint": "http://127.0.0.1:11434",
            "handle": "ollama/nomic-embed-text:latest",
            "batch_size": 32,
        },
        include_base_tools=True,
        include_base_tool_rules=True,
        memory_blocks=[
            {
                "label": "persona",
                "value": (
                    "You are the Letta public-Agent-system arm of ME-07. "
                    "Maintain reusable, evidence-grounded procedural memory."
                ),
            },
            {
                "label": "human",
                "value": (
                    "The evaluator supplies completed training episodes first, then "
                    "independent held-out customer tasks."
                ),
            },
        ],
        metadata={"protocol_id": PROTOCOL_ID, "domain": domain, "partition": "train"},
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--domain", required=True, choices=sorted(DOMAINS))
    parser.add_argument("--input-root", type=Path, required=True)
    parser.add_argument("--snapshot-dir", type=Path, required=True)
    parser.add_argument("--artifact-dir", type=Path, required=True)
    parser.add_argument("--base-url", default="http://127.0.0.1:8283")
    parser.add_argument("--model-endpoint", default="http://127.0.0.1:18317/v1")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--require-memory-tool", action="store_true")
    args = parser.parse_args()

    expected_suffix = Path("datasets/train_task_trajectories")
    input_root = args.input_root.resolve(strict=True)
    if input_root.parts[-len(expected_suffix.parts) :] != expected_suffix.parts:
        raise ValueError(
            "ME-07 Letta training input must end in datasets/train_task_trajectories"
        )
    domain_dir = input_root / args.domain
    files = sorted(domain_dir.glob("*.json"))
    if len(files) != 100:
        raise RuntimeError(
            f"expected 100 {args.domain} train trajectories, got {len(files)}"
        )
    if args.limit is not None:
        if args.limit < 1 or args.limit > len(files):
            raise ValueError("--limit must be between 1 and 100")
        files = files[: args.limit]

    args.snapshot_dir.mkdir(parents=True, exist_ok=True)
    args.artifact_dir.mkdir(parents=True, exist_ok=True)
    client = Letta(base_url=args.base_url)
    agent = _create_agent(client, args.domain, args.model_endpoint)
    started = time.monotonic()
    episodes: list[dict[str, Any]] = []
    totals = {
        "input_tokens": 0,
        "cached_input_tokens": 0,
        "output_tokens": 0,
        "reasoning_tokens": 0,
    }
    for index, path in enumerate(files, start=1):
        episode, serialized = load_canonical_episode(path, args.domain)
        response = client.agents.messages.create(
            agent_id=agent.id,
            input=(
                "Offline learning episode. Study the canonical completed trajectory "
                "below. Use native Letta memory tools to retain only reusable lessons "
                "that could improve later tasks in this domain; do not memorize transient "
                "record values as current truth. When finished, reply exactly "
                "TRAINING_EPISODE_INGESTED.\n\n"
                f"<canonical_episode>{serialized}</canonical_episode>"
            ),
            max_steps=16,
            timeout=1800,
        )
        texts = _assistant_texts(response)
        tools = _native_tools(response)
        usage = _usage(response)
        for key, value in usage.items():
            totals[key] += value
        if texts != ["TRAINING_EPISODE_INGESTED"]:
            raise RuntimeError(
                f"Letta failed episode acknowledgement {path.name}: {texts}"
            )
        if args.require_memory_tool and not any(
            name in {"memory_insert", "memory_replace"} for name in tools
        ):
            raise RuntimeError(f"Letta did not use native memory for {path.name}")
        exported = client.agents.export_file(
            agent.id, use_legacy_format=False, scrub_messages=False
        )
        episodes.append(
            {
                "index": index,
                "task_id": episode["task_id"],
                "source_sha256": episode["source_sha256"],
                "native_tools": tools,
                "usage": usage,
                "state_sha256": sha256_bytes(exported.encode()),
            }
        )

    exported = client.agents.export_file(
        agent.id, use_legacy_format=False, scrub_messages=False
    )
    snapshot_path = args.snapshot_dir / f"{args.domain}.af"
    snapshot_path.write_text(exported, encoding="utf-8")
    state = client.agents.retrieve(agent.id)
    blocks = [
        {"label": block.label, "value": block.value}
        for block in client.agents.blocks.list(agent.id)
    ]
    receipt = {
        "protocol_id": PROTOCOL_ID,
        "gate_or_run": "gate" if args.limit is not None else "formal_training",
        "reportable_score": False,
        "domain": args.domain,
        "agent_id": agent.id,
        "binding": _binding(state),
        "input_root": str(input_root),
        "episode_count": len(files),
        "episodes": episodes,
        "usage": totals,
        "elapsed_seconds": round(time.monotonic() - started, 3),
        "memory_blocks": blocks,
        "snapshot": str(snapshot_path),
        "snapshot_sha256": sha256_bytes(exported.encode()),
        "passed": len(episodes) == len(files),
    }
    receipt_path = args.artifact_dir / f"{args.domain}-letta-training-receipt.json"
    receipt_path.write_text(
        json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "receipt": str(receipt_path),
                "snapshot": str(snapshot_path),
                "episodes": len(episodes),
                "passed": receipt["passed"],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
