"""Build frozen Mem0 domain snapshots from canonical STATE-Bench episodes."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any

from benchmarks.state_bench.v2.canonical_episode import (
    PROTOCOL_ID,
    load_canonical_episode,
)
from benchmarks.state_bench.v2.me07_responses import ME07ResponsesClient
from benchmarks.state_bench.v2.mem0_reference import (
    create_mem0_memory,
    memory_results,
)

DOMAINS = {"travel", "customer_support", "shopping_assistant"}


def _tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        digest.update(path.relative_to(root).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def _atomic_json(path: Path, value: object) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def _resume_prefix(
    *,
    files: list[Path],
    domain: str,
    memories: list[dict[str, Any]],
    expected_count: int,
) -> list[dict[str, Any]]:
    """Prove an explicitly authorized, already-durable training prefix.

    Mem0 stamps every retained memory with the canonical source task and digest.
    Recovery is accepted only when every selected prefix episode has at least one
    exact durable witness and no memory claims a source outside that prefix.  This
    intentionally refuses to infer completion from a merely non-empty snapshot.
    """

    if expected_count < 1 or expected_count >= len(files):
        raise ValueError("--resume-prefix-count must be between 1 and episode_count-1")
    by_source: dict[str, list[dict[str, Any]]] = {}
    for item in memories:
        metadata = item.get("metadata")
        if not isinstance(metadata, dict):
            raise RuntimeError("existing Mem0 memory lacks structured metadata")
        if metadata.get("protocol_id") != PROTOCOL_ID:
            raise RuntimeError("existing Mem0 memory has a different protocol_id")
        if metadata.get("source_partition") != "train_task_trajectories":
            raise RuntimeError("existing Mem0 memory has a different source partition")
        task_id = metadata.get("source_task_id")
        if not isinstance(task_id, str) or not task_id:
            raise RuntimeError("existing Mem0 memory lacks source_task_id")
        by_source.setdefault(task_id, []).append(item)

    recovered: list[dict[str, Any]] = []
    expected_sources: set[str] = set()
    for index, path in enumerate(files[:expected_count], start=1):
        episode, _serialized = load_canonical_episode(path, domain)
        task_id = episode["task_id"]
        witnesses = by_source.get(task_id, [])
        matching = [
            item
            for item in witnesses
            if item["metadata"].get("source_sha256") == episode["source_sha256"]
        ]
        if not matching:
            raise RuntimeError(
                f"resume prefix episode {index} lacks an exact durable witness: {task_id}"
            )
        if len(matching) != len(witnesses):
            raise RuntimeError(
                f"resume prefix episode {index} has conflicting source digests: {task_id}"
            )
        expected_sources.add(task_id)
        recovered.append(
            {
                "index": index,
                "task_id": task_id,
                "source_sha256": episode["source_sha256"],
                "events": [],
                "llm_receipts": [],
                "memory_count_after": None,
                "recovered_from_durable_snapshot": True,
                "durable_witness_memory_ids": sorted(
                    str(item.get("id")) for item in matching
                ),
            }
        )

    unexpected_sources = sorted(set(by_source) - expected_sources)
    if unexpected_sources:
        raise RuntimeError(
            "existing Mem0 snapshot contains sources after/outside the declared "
            f"resume prefix: {unexpected_sources}"
        )
    return recovered


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--domain", required=True, choices=sorted(DOMAINS))
    parser.add_argument("--input-root", type=Path, required=True)
    parser.add_argument("--snapshot-dir", type=Path, required=True)
    parser.add_argument("--artifact-dir", type=Path, required=True)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--require-add", action="store_true")
    parser.add_argument(
        "--resume-prefix-count",
        type=int,
        help=(
            "resume an interrupted non-empty snapshot after proving this exact "
            "canonical prefix from durable source metadata"
        ),
    )
    args = parser.parse_args()

    expected_suffix = Path("datasets/train_task_trajectories")
    input_root = args.input_root.resolve(strict=True)
    if input_root.parts[-len(expected_suffix.parts) :] != expected_suffix.parts:
        raise ValueError(
            "ME-07 Mem0 training input must end in datasets/train_task_trajectories"
        )
    files = sorted((input_root / args.domain).glob("*.json"))
    if len(files) != 100:
        raise RuntimeError(
            f"expected 100 {args.domain} train trajectories, got {len(files)}"
        )
    if args.limit is not None:
        if args.limit < 1 or args.limit > len(files):
            raise ValueError("--limit must be between 1 and 100")
        files = files[: args.limit]

    root = args.snapshot_dir / args.domain
    resume = args.resume_prefix_count is not None
    if not resume and root.exists() and any(root.iterdir()):
        raise FileExistsError(f"refusing to overwrite non-empty Mem0 snapshot: {root}")
    if resume and (not root.is_dir() or not any(root.iterdir())):
        raise FileNotFoundError(f"cannot resume empty or missing Mem0 snapshot: {root}")
    root.mkdir(parents=True, exist_ok=True)
    args.artifact_dir.mkdir(parents=True, exist_ok=True)
    response_client = ME07ResponsesClient()
    memory = create_mem0_memory(
        root=root, domain=args.domain, responses_client=response_client
    )
    namespace = f"me07-{args.domain}"
    started = time.monotonic()
    initial_memories = memory_results(
        memory.get_all(filters={"agent_id": namespace}, top_k=10_000)
    )
    if resume:
        episodes = _resume_prefix(
            files=files,
            domain=args.domain,
            memories=initial_memories,
            expected_count=args.resume_prefix_count,
        )
    else:
        episodes = []
    progress_path = args.artifact_dir / f"{args.domain}-mem0-training-progress.json"
    for index, path in enumerate(files[len(episodes) :], start=len(episodes) + 1):
        episode, serialized = load_canonical_episode(path, args.domain)
        before = len(response_client.receipts)
        result = memory.add(
            [
                {
                    "role": "user",
                    "content": (
                        "Completed historical training episode. Extract only reusable "
                        "procedural lessons from this canonical trajectory:\n\n"
                        f"<canonical_episode>{serialized}</canonical_episode>"
                    ),
                }
            ],
            agent_id=namespace,
            metadata={
                "protocol_id": PROTOCOL_ID,
                "source_partition": "train_task_trajectories",
                "source_task_id": episode["task_id"],
                "source_sha256": episode["source_sha256"],
            },
            infer=True,
        )
        added = memory_results(result)
        if args.require_add and not added:
            raise RuntimeError(f"Mem0 extracted no memory from {path.name}")
        all_memories = memory_results(
            memory.get_all(filters={"agent_id": namespace}, top_k=10_000)
        )
        episodes.append(
            {
                "index": index,
                "task_id": episode["task_id"],
                "source_sha256": episode["source_sha256"],
                "events": [
                    {
                        "id": item.get("id"),
                        "event": item.get("event"),
                        "memory": item.get("memory"),
                    }
                    for item in added
                ],
                "llm_receipts": response_client.receipts[before:],
                "memory_count_after": len(all_memories),
            }
        )
        _atomic_json(
            progress_path,
            {
                "protocol_id": PROTOCOL_ID,
                "domain": args.domain,
                "episode_count": len(episodes),
                "last_episode": episodes[-1],
                "resume_prefix_count": args.resume_prefix_count,
                "snapshot_root": str(root),
            },
        )

    all_memories = memory_results(
        memory.get_all(filters={"agent_id": namespace}, top_k=10_000)
    )
    vector_client = getattr(memory.vector_store, "client", None)
    if vector_client is not None and hasattr(vector_client, "close"):
        vector_client.close()
    response_client.close()
    receipt = {
        "protocol_id": PROTOCOL_ID,
        "gate_or_run": "gate" if args.limit is not None else "formal_training",
        "reportable_score": False,
        "domain": args.domain,
        "namespace": namespace,
        "binding": {
            "model": "gpt-5.6-sol",
            "reasoning_effort": "max",
            "provider": "cliproxyapi",
            "api": "responses",
            "fallback": False,
            "embedding_model": "nomic-embed-text:latest",
            "embedding_provider": "ollama",
            "embedding_dimension": 768,
            "vector_store": "qdrant-local",
        },
        "input_root": str(input_root),
        "episode_count": len(files),
        "episodes": episodes,
        "final_memories": all_memories,
        "final_memory_count": len(all_memories),
        "elapsed_seconds": round(time.monotonic() - started, 3),
        "snapshot_root": str(root),
        "snapshot_sha256": _tree_digest(root),
        "resume": {
            "used": resume,
            "durable_prefix_count": args.resume_prefix_count,
            "recovered_episode_receipts_available": not resume,
        },
        "passed": len(episodes) == len(files) and bool(all_memories),
    }
    receipt_path = args.artifact_dir / f"{args.domain}-mem0-training-receipt.json"
    _atomic_json(receipt_path, receipt)
    print(
        json.dumps(
            {
                "receipt": str(receipt_path),
                "snapshot_root": str(root),
                "episodes": len(episodes),
                "memories": len(all_memories),
                "passed": receipt["passed"],
            },
            ensure_ascii=False,
        )
    )
    return 0 if receipt["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
