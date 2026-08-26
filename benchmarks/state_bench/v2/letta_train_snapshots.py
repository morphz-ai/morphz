"""Build frozen Letta domain snapshots from canonical STATE-Bench episodes.

Only ``datasets/train_task_trajectories`` is accepted as input.  The script
gives each completed episode to one persistent Letta Agent per domain and lets
the Agent decide, through its native memory tools, which procedural lessons to
retain.  After each acknowledged episode, Letta's public ``reset-messages``
operation clears the short-term transcript while rebuilding the system context
from the updated native memory blocks.  This preserves the learned Agent state
without forcing 100 raw trajectories into one active message window.  It never
reads held-out task definitions, task environments, or oracle requirements.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import time
import uuid
import zipfile
from pathlib import Path
from typing import Any

from letta_client import Letta

from benchmarks.state_bench.v2.canonical_episode import (
    PROTOCOL_ID,
    load_canonical_episode,
    sha256_bytes,
)

DOMAINS = {"travel", "customer_support", "shopping_assistant"}


def _atomic_text(path: Path, value: str) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        stream.write(value)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def _atomic_json(path: Path, value: object) -> None:
    _atomic_text(
        path,
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    )


def _write_checkpoint(path: Path, exported: str, progress: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("agent.af", exported)
        archive.writestr(
            "progress.json",
            json.dumps(progress, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        )
    with temporary.open("rb") as stream:
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def _read_checkpoint(path: Path) -> tuple[str, dict[str, Any]]:
    with zipfile.ZipFile(path, "r") as archive:
        if set(archive.namelist()) != {"agent.af", "progress.json"}:
            raise RuntimeError("invalid Letta training checkpoint members")
        exported = archive.read("agent.af").decode()
        progress = json.loads(archive.read("progress.json"))
    if not isinstance(progress, dict):
        raise TypeError("Letta checkpoint progress is not an object")
    if progress.get("snapshot_sha256") != sha256_bytes(exported.encode()):
        raise RuntimeError("Letta checkpoint snapshot digest mismatch")
    return exported, progress


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
    parser.add_argument("--resume", action="store_true")
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
    if args.resume:
        if not args.artifact_dir.is_dir():
            raise FileNotFoundError(
                f"cannot resume missing Letta artifact directory: {args.artifact_dir}"
            )
    else:
        args.artifact_dir.mkdir(parents=True, exist_ok=False)
    client = Letta(base_url=args.base_url)
    snapshot_path = args.snapshot_dir / f"{args.domain}.af"
    checkpoint_path = args.artifact_dir / f"{args.domain}-letta-checkpoint.zip"
    progress_path = args.artifact_dir / f"{args.domain}-letta-progress.json"
    if args.resume:
        exported, progress = _read_checkpoint(checkpoint_path)
        if progress.get("protocol_id") != PROTOCOL_ID:
            raise RuntimeError("Letta checkpoint protocol mismatch")
        if progress.get("domain") != args.domain:
            raise RuntimeError("Letta checkpoint domain mismatch")
        completed_episodes = progress.get("episodes")
        if not isinstance(completed_episodes, list):
            raise TypeError("Letta checkpoint episodes are not a list")
        for index, prior in enumerate(completed_episodes):
            episode, _serialized = load_canonical_episode(files[index], args.domain)
            if (
                prior.get("task_id") != episode["task_id"]
                or prior.get("source_sha256") != episode["source_sha256"]
            ):
                raise RuntimeError(
                    f"Letta checkpoint input prefix mismatch at episode {index + 1}"
                )
        with io.BytesIO(exported.encode()) as stream:
            imported = client.agents.import_file(
                file=stream,
                append_copy_suffix=True,
                override_existing_tools=True,
            )
        if len(imported.agent_ids) != 1:
            raise RuntimeError("Letta checkpoint must contain exactly one Agent")
        agent = client.agents.retrieve(imported.agent_ids[0])
        episodes: list[dict[str, Any]] = list(completed_episodes)
        totals = {
            key: int(value) for key, value in (progress.get("usage") or {}).items()
        }
        expected_usage_keys = {
            "input_tokens",
            "cached_input_tokens",
            "output_tokens",
            "reasoning_tokens",
        }
        if set(totals) != expected_usage_keys:
            raise RuntimeError("Letta checkpoint usage keys mismatch")
    else:
        if snapshot_path.exists() or checkpoint_path.exists() or progress_path.exists():
            raise FileExistsError("refusing to overwrite Letta training artifacts")
        agent = _create_agent(client, args.domain, args.model_endpoint)
        episodes = []
        totals = {
            "input_tokens": 0,
            "cached_input_tokens": 0,
            "output_tokens": 0,
            "reasoning_tokens": 0,
        }
    if _binding(agent)["model"] != "gpt-5.6-sol":
        raise RuntimeError("Letta checkpoint model binding mismatch")
    started = time.monotonic()
    for index, path in enumerate(files[len(episodes) :], start=len(episodes) + 1):
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
        reset_state = client.agents.messages.reset(
            agent.id,
            add_default_initial_messages=False,
            timeout=120,
        )
        state = reset_state or client.agents.retrieve(agent.id)
        if _binding(state) != _binding(agent):
            raise RuntimeError("Letta binding changed after episodic context reset")
        active_message_count = len(state.message_ids or [])
        if active_message_count != 1:
            raise RuntimeError(
                "Letta episodic reset did not leave exactly one active system message: "
                f"{active_message_count}"
            )
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
                "episodic_context_reset": True,
                "active_message_count_after_reset": active_message_count,
            }
        )
        progress = {
            "protocol_id": PROTOCOL_ID,
            "kind": "letta_training_checkpoint",
            "reportable_score": False,
            "domain": args.domain,
            "episode_count": len(episodes),
            "episodes": episodes,
            "usage": totals,
            "snapshot_sha256": sha256_bytes(exported.encode()),
            "episodic_context_reset": True,
        }
        _write_checkpoint(checkpoint_path, exported, progress)
        _atomic_text(snapshot_path, exported)
        _atomic_json(progress_path, progress)
        print(
            json.dumps(
                {
                    "domain": args.domain,
                    "episode": len(episodes),
                    "task_id": episode["task_id"],
                    "checkpoint_sha256": sha256_bytes(checkpoint_path.read_bytes()),
                },
                ensure_ascii=False,
            ),
            flush=True,
        )

    exported, checkpoint_progress = _read_checkpoint(checkpoint_path)
    if checkpoint_progress.get("episode_count") != len(files):
        raise RuntimeError("Letta final checkpoint episode count mismatch")
    if snapshot_path.read_text(encoding="utf-8") != exported:
        raise RuntimeError("Letta final snapshot differs from atomic checkpoint")
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
        "checkpoint": str(checkpoint_path),
        "checkpoint_sha256": sha256_bytes(checkpoint_path.read_bytes()),
        "episodic_context_reset": True,
        "passed": len(episodes) == len(files)
        and all(episode["episodic_context_reset"] for episode in episodes)
        and all(
            episode["active_message_count_after_reset"] == 1 for episode in episodes
        ),
    }
    receipt_path = args.artifact_dir / f"{args.domain}-letta-training-receipt.json"
    _atomic_json(receipt_path, receipt)
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
