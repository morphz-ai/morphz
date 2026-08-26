#!/usr/bin/env python3
"""One-trajectory native learning, persistence, and reload smoke for A-MEM and Mem0."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys


HERE = Path(__file__).resolve().parent
OVERLAY_ROOT = HERE / "overlay"
if str(OVERLAY_ROOT) not in sys.path:
    sys.path.insert(0, str(OVERLAY_ROOT))

from morphz_state_bench.artifacts import (  # noqa: E402
    AMemArtifactBuilder,
    Mem0ArtifactBuilder,
    collect_training_inputs,
)
from morphz_state_bench.backends import AMemBackend, Mem0Backend  # noqa: E402
from morphz_state_bench.protocol import sha256_file  # noqa: E402


def _preview_hashes(values: list[str]) -> list[str]:
    return [hashlib.sha256(value.encode("utf-8")).hexdigest() for value in values]


def _model_call_gate(path: Path) -> tuple[list[dict[str, object]], bool]:
    calls = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(calls, list):
        raise ValueError(f"model call receipt is not a list: {path}")
    exact_model = bool(calls) and all(
        isinstance(call, dict) and call.get("response_model") == "gpt-5.6-sol"
        for call in calls
    )
    return calls, exact_model


def _run_amem(
    root: Path,
    *,
    selected: object,
    memgym_root: Path,
    embedding_model_path: Path,
    api_key: str,
    base_url: str,
) -> dict[str, object]:
    builder = AMemArtifactBuilder(
        memgym_root=memgym_root,
        embedding_model_path=embedding_model_path,
        api_key=api_key,
        base_url=base_url,
    )
    payloads, method, receipts = builder.build(
        domain="travel",
        inputs=[selected],
        root=root,
    )
    os.environ["MORPHZ_STATE_BENCH_MEMGYM_ROOT"] = str(memgym_root)
    os.environ["MORPHZ_STATE_BENCH_EMBEDDING_MODEL_PATH"] = str(embedding_model_path)
    backend = AMemBackend(root)
    retrieved = backend.retrieve(
        "flight cancellation confirmation fee refund and remaining itinerary procedure",
        3,
    )
    calls, exact_model = _model_call_gate(root / "model_calls.json")
    return {
        "gate_passed": bool(retrieved) and exact_model and len(receipts) == 1,
        "payloads": payloads,
        "method": method,
        "build_receipts": receipts,
        "model_call_count": len(calls),
        "exact_response_model": exact_model,
        "retrieved_count": len(retrieved),
        "retrieved_preview_sha256": _preview_hashes(retrieved),
        "state_sha256": sha256_file(root / "amem_state.json"),
        "reloaded_from_frozen_state": True,
    }


def _run_mem0(
    root: Path,
    *,
    selected: object,
    mem0_root: Path,
    embedding_model_path: Path,
    api_key: str,
    base_url: str,
) -> dict[str, object]:
    builder = Mem0ArtifactBuilder(
        mem0_root=mem0_root,
        embedding_model_path=embedding_model_path,
        api_key=api_key,
        base_url=base_url,
    )
    payloads, method, receipts = builder.build(
        domain="travel",
        inputs=[selected],
        root=root,
    )
    os.environ["MORPHZ_STATE_BENCH_AGENT_API_KEY"] = api_key
    os.environ["MORPHZ_STATE_BENCH_AGENT_BASE_URL"] = base_url
    os.environ["MORPHZ_STATE_BENCH_EMBEDDING_MODEL_PATH"] = str(embedding_model_path)
    backend = Mem0Backend(root, domain="travel")
    try:
        retrieved = backend.retrieve(
            "flight cancellation confirmation fee refund and remaining itinerary procedure",
            3,
        )
    finally:
        client = getattr(getattr(backend.memory, "vector_store", None), "client", None)
        close = getattr(client, "close", None)
        if callable(close):
            close()
    calls, exact_model = _model_call_gate(root / "model_calls.json")
    return {
        "gate_passed": bool(retrieved) and exact_model and len(receipts) == 1,
        "payload_count": len(payloads),
        "method": method,
        "build_receipts": receipts,
        "model_call_count": len(calls),
        "exact_response_model": exact_model,
        "retrieved_count": len(retrieved),
        "retrieved_preview_sha256": _preview_hashes(retrieved),
        "config_sha256": sha256_file(root / "mem0_config.json"),
        "reloaded_from_frozen_store": True,
        "retrieval_scope": "agent_id",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-bench-root", type=Path, required=True)
    parser.add_argument("--memgym-root", type=Path, required=True)
    parser.add_argument("--mem0-root", type=Path, required=True)
    parser.add_argument("--embedding-model-path", type=Path, required=True)
    parser.add_argument("--artifact-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    api_key = os.environ.get("MORPHZ_STATE_BENCH_AGENT_API_KEY", "").strip()
    base_url = os.environ.get("MORPHZ_STATE_BENCH_AGENT_BASE_URL", "").strip()
    if not api_key or not base_url:
        raise RuntimeError("agent API credential and base URL are required")
    artifact_root = args.artifact_root.resolve()
    if artifact_root.exists():
        raise FileExistsError(f"refusing to overwrite smoke artifacts: {artifact_root}")
    artifact_root.mkdir(parents=True)
    inputs = collect_training_inputs(
        args.state_bench_root.resolve() / "datasets" / "train_task_trajectories",
        "travel",
    )
    selected = inputs[0]
    result: dict[str, object] = {
        "gate": "ME-07-A-MEM-Mem0-native-artifact-real-smoke-v1",
        "trajectory_id": selected.trajectory_id,
        "trajectory_sha256": selected.sha256,
        "model": "gpt-5.6-sol",
        "reasoning_effort": "max",
        "same_canonical_training_input": True,
    }
    try:
        result["amem"] = _run_amem(
            artifact_root / "amem",
            selected=selected,
            memgym_root=args.memgym_root.resolve(),
            embedding_model_path=args.embedding_model_path.resolve(),
            api_key=api_key,
            base_url=base_url,
        )
        result["mem0"] = _run_mem0(
            artifact_root / "mem0",
            selected=selected,
            mem0_root=args.mem0_root.resolve(),
            embedding_model_path=args.embedding_model_path.resolve(),
            api_key=api_key,
            base_url=base_url,
        )
        result["gate_passed"] = bool(
            result["amem"]["gate_passed"] and result["mem0"]["gate_passed"]
        )
    except Exception as error:
        result["gate_passed"] = False
        result["error_type"] = type(error).__name__
        result["error"] = str(error)[-2000:]

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"gate_passed={str(bool(result.get('gate_passed'))).lower()}")
    print(f"result={args.output.resolve()}")
    if result.get("gate_passed"):
        # Keep the persisted stores for audit, but remove incidental cache homes.
        shutil.rmtree(artifact_root / "mem0" / "mem0_home", ignore_errors=True)
    else:
        print(f"artifacts_preserved={artifact_root}")
    return 0 if result.get("gate_passed") else 4


if __name__ == "__main__":
    raise SystemExit(main())
