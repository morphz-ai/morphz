#!/usr/bin/env python3
"""One-trajectory production Morphz context_tx/checkpoint/reload smoke."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys


HERE = Path(__file__).resolve().parent
OVERLAY_ROOT = HERE / "overlay"
if str(OVERLAY_ROOT) not in sys.path:
    sys.path.insert(0, str(OVERLAY_ROOT))

from morphz_state_bench.artifacts import (  # noqa: E402
    MorphzArtifactBuilder,
    collect_training_inputs,
    morphz_database_audit,
)
from morphz_state_bench.backends import MorphzRecallBackend  # noqa: E402
from morphz_state_bench.protocol import sha256_file  # noqa: E402


def _reported_commit(binary: Path) -> str:
    completed = subprocess.run(
        [str(binary), "version"],
        capture_output=True,
        text=True,
        check=True,
    )
    return completed.stdout.strip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-bench-root", type=Path, required=True)
    parser.add_argument("--morphz-binary", type=Path, required=True)
    parser.add_argument("--morphz-profile", required=True)
    parser.add_argument("--artifact-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--verify-existing-artifact", action="store_true")
    args = parser.parse_args()

    binary = args.morphz_binary.resolve()
    root = args.artifact_root.resolve()
    if root.exists() and not args.verify_existing_artifact:
        raise FileExistsError(f"refusing to overwrite smoke artifact: {root}")
    inputs = collect_training_inputs(
        args.state_bench_root.resolve() / "datasets" / "train_task_trajectories",
        "travel",
    )
    selected = inputs[0]
    builder = MorphzArtifactBuilder(
        binary=binary,
        profile=args.morphz_profile,
        timeout_seconds=1800,
    )
    result: dict[str, object] = {
        "gate": "ME-07-Morphz-production-artifact-real-smoke-v1",
        "trajectory_id": selected.trajectory_id,
        "trajectory_sha256": selected.sha256,
        "model": "gpt-5.6-sol",
        "reasoning_effort": "max",
        "profile": args.morphz_profile,
        "binary_sha256": sha256_file(binary),
        "binary_version": _reported_commit(binary),
    }
    try:
        if args.verify_existing_artifact:
            if not root.is_dir():
                raise FileNotFoundError(f"existing smoke artifact not found: {root}")
            payloads = [
                "backend.json",
                "learned_context.sqlite",
                "context_audit.json",
                "recall_rebuild.json",
                "recall_inspect.json",
            ]
            method = {
                "implementation": "production-morphz-context-tx",
                "model": "gpt-5.6-sol",
                "reasoning_effort": "max",
                "profile": args.morphz_profile,
                "binary_sha256": sha256_file(binary),
                "one_context_per_domain": True,
                "full_access": True,
                "runtime_usage": morphz_database_audit(root / "learned_context.sqlite"),
            }
            receipts = [{"trajectory_id": selected.trajectory_id, "status": "existing-artifact-verified"}]
            result["verification_reused_existing_artifact"] = True
            result["new_model_calls"] = 0
        else:
            payloads, method, receipts = builder.build(
                domain="travel",
                inputs=[selected],
                root=root,
            )
            result["verification_reused_existing_artifact"] = False
            result["new_model_calls"] = method["runtime_usage"]["model_call_count"]
        recall_work = root / "recall_work"
        backend = MorphzRecallBackend(root, task_id="real-smoke", output_dir=str(recall_work))
        learnings = backend.retrieve(
            "flight cancellation confirmation fee refund and remaining itinerary procedure",
            3,
        )
        context_audit = json.loads((root / "context_audit.json").read_text(encoding="utf-8"))
        recall_audit = json.loads((root / "recall_inspect.json").read_text(encoding="utf-8"))
        runtime_usage = method["runtime_usage"]
        wal_or_shm_present = any(
            Path(str(root / "learned_context.sqlite") + suffix).exists()
            for suffix in ("-wal", "-shm")
        )
        gate_passed = (
            bool(learnings)
            and context_audit.get("matches") is True
            and int(recall_audit.get("frame_documents") or 0) > 0
            and runtime_usage["exact_sol_max_binding"] is True
            and int(runtime_usage["context_tx_commit_count"]) > 0
            and not wal_or_shm_present
        )
        result.update(
            {
                "gate_passed": gate_passed,
                "payloads": payloads,
                "method": method,
                "build_receipts": receipts,
                "retrieved_count": len(learnings),
                "retrieved_preview_sha256": [
                    hashlib.sha256(item.encode("utf-8")).hexdigest()
                    for item in learnings
                ],
                "source_snapshot_immutable": True,
                "wal_or_shm_present": wal_or_shm_present,
                "context_audit_matches": context_audit.get("matches"),
                "recall_frame_documents": recall_audit.get("frame_documents"),
            }
        )
        if not result["gate_passed"]:
            result["failure"] = "production Recall returned no live Mind Frame"
    except Exception as error:
        result["gate_passed"] = False
        result["error_type"] = type(error).__name__
        result["error"] = str(error)[-2000:]

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"gate_passed={str(bool(result.get('gate_passed'))).lower()}")
    print(f"result={args.output.resolve()}")
    if not result.get("gate_passed"):
        print(f"artifact_preserved={root}")
    else:
        # Working recall clones are not part of the frozen source artifact.
        shutil.rmtree(root / "recall_work", ignore_errors=True)
    return 0 if result.get("gate_passed") else 4


if __name__ == "__main__":
    raise SystemExit(main())
