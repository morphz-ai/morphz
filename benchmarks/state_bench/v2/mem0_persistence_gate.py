"""Reload and snapshot-isolation Gate for the ME-07 Mem0 arm."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path

from benchmarks.state_bench.v2.me07_responses import ME07ResponsesClient
from benchmarks.state_bench.v2.mem0_reference import (
    create_mem0_memory,
    memory_results,
)

GATE_ID = "ME-07-mem0-persistence-snapshot-v1"
ISOLATION_MARKER = "ME07-SNAPSHOT-ISOLATION-MARKER-9F31"


def _tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        digest.update(path.relative_to(root).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def _close(memory: object) -> None:
    vector_store = getattr(memory, "vector_store", None)
    client = getattr(vector_store, "client", None)
    if client is not None and hasattr(client, "close"):
        client.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--training-receipt", type=Path, required=True)
    parser.add_argument("--work-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    training = json.loads(args.training_receipt.read_text(encoding="utf-8"))
    if not training.get("passed") or training.get("episode_count") != 1:
        raise ValueError("Mem0 persistence Gate requires a passed one-episode receipt")
    source = Path(training["snapshot_root"]).resolve(strict=True)
    domain = str(training["domain"])
    namespace = str(training["namespace"])
    clone_a = args.work_root / "clone-a"
    clone_b = args.work_root / "clone-b"
    for target in [clone_a, clone_b]:
        if target.exists():
            raise FileExistsError(f"refusing to overwrite Mem0 Gate clone: {target}")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source, target)
    source_digest = _tree_digest(source)
    clone_a_digest = _tree_digest(clone_a)
    clone_b_digest = _tree_digest(clone_b)

    responses = ME07ResponsesClient()
    memory_a = create_mem0_memory(
        root=clone_a, domain=domain, responses_client=responses
    )
    memory_b = create_mem0_memory(
        root=clone_b, domain=domain, responses_client=responses
    )
    before_a = memory_results(
        memory_a.get_all(filters={"agent_id": namespace}, top_k=10_000)
    )
    before_b = memory_results(
        memory_b.get_all(filters={"agent_id": namespace}, top_k=10_000)
    )
    if not before_a or not before_b:
        raise RuntimeError("reloaded Mem0 snapshot contains no durable memory")
    query = str(before_a[0]["memory"])
    recall_a = memory_results(
        memory_a.search(query, top_k=3, filters={"agent_id": namespace})
    )
    recall_b = memory_results(
        memory_b.search(query, top_k=3, filters={"agent_id": namespace})
    )
    memory_a.add(
        [{"role": "user", "content": ISOLATION_MARKER}],
        agent_id=namespace,
        infer=False,
        metadata={"gate": GATE_ID},
    )
    after_a = memory_results(
        memory_a.get_all(filters={"agent_id": namespace}, top_k=10_000)
    )
    after_b = memory_results(
        memory_b.get_all(filters={"agent_id": namespace}, top_k=10_000)
    )
    _close(memory_a)
    _close(memory_b)
    responses.close()

    before_a_text = {str(item.get("memory")) for item in before_a}
    before_b_text = {str(item.get("memory")) for item in before_b}
    after_a_text = {str(item.get("memory")) for item in after_a}
    after_b_text = {str(item.get("memory")) for item in after_b}
    receipt = {
        "gate": GATE_ID,
        "reportable_score": False,
        "domain": domain,
        "namespace": namespace,
        "source": str(source),
        "source_digest": source_digest,
        "clone_a_digest_before_open": clone_a_digest,
        "clone_b_digest_before_open": clone_b_digest,
        "initial_clone_digests_match": (
            source_digest == clone_a_digest == clone_b_digest
        ),
        "persistent_memory_count": len(before_a),
        "clone_memory_sets_match": before_a_text == before_b_text,
        "recall_a": recall_a,
        "recall_b": recall_b,
        "isolation_marker_in_a": ISOLATION_MARKER in after_a_text,
        "isolation_marker_in_b": ISOLATION_MARKER in after_b_text,
        "llm_calls_during_reload_recall": responses.receipts,
    }
    receipt["passed"] = all(
        [
            receipt["initial_clone_digests_match"],
            receipt["clone_memory_sets_match"],
            bool(recall_a),
            bool(recall_b),
            receipt["isolation_marker_in_a"],
            not receipt["isolation_marker_in_b"],
            not receipt["llm_calls_during_reload_recall"],
        ]
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "output": str(args.output),
                "memories": len(before_a),
                "passed": receipt["passed"],
            },
            ensure_ascii=False,
        )
    )
    return 0 if receipt["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
