#!/usr/bin/env python3
"""Exercise A-MEM and Mem0 persistence/reload paths without model calls."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time


HERE = Path(__file__).resolve().parent
OVERLAY_ROOT = HERE / "overlay"
if str(OVERLAY_ROOT) not in sys.path:
    sys.path.insert(0, str(OVERLAY_ROOT))

from morphz_state_bench.artifacts import (  # noqa: E402
    AGENT_BASE_URL_PLACEHOLDER,
    AGENT_KEY_PLACEHOLDER,
    EMBEDDING_PLACEHOLDER,
    CanonicalTrainingInput,
    write_artifact_manifest,
)
from morphz_state_bench.backends import AMemBackend, Mem0Backend  # noqa: E402


def _inputs(domain: str) -> list[CanonicalTrainingInput]:
    return [
        CanonicalTrainingInput(
            domain=domain,
            trajectory_id=f"fixture-{index:03d}",
            canonical=json.dumps(
                {
                    "domain": domain,
                    "trajectory_id": f"fixture-{index:03d}",
                    "procedure": f"Verify policy and obtain confirmation before action {index}.",
                },
                sort_keys=True,
            ),
            sha256=f"{index:064x}",
        )
        for index in range(100)
    ]


def _build_amem(
    root: Path,
    *,
    memgym_root: Path,
    embedding_model_path: Path,
) -> dict[str, object]:
    source_root = str((memgym_root / "src").resolve())
    if source_root not in sys.path:
        sys.path.insert(0, source_root)
    from memgym.memory.external.amem.system import AgenticMemorySystem

    started = time.monotonic()
    system = AgenticMemorySystem(
        model_name=str(embedding_model_path),
        llm_model="gpt-5.6-sol",
        enable_evolution=False,
        verbose=False,
    )
    inputs = _inputs("travel")
    for index, item in enumerate(inputs):
        system.add_note(
            item.canonical,
            time=f"train-{index:03d}",
            auto_generate_metadata=False,
            keywords=["policy", "confirmation", "procedure"],
            context="Reusable policy-confirmation procedure",
            tags=["state-bench", "travel"],
        )
    state = system.to_dict()
    state["config"]["model_name"] = EMBEDDING_PLACEHOLDER
    (root / "amem_state.json").write_text(
        json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    write_artifact_manifest(
        root,
        arm="amem",
        domain="travel",
        inputs=inputs,
        payload_paths=["amem_state.json"],
        method={"implementation": "no-model-reload-gate"},
        build_receipts=[{"status": "stored", "count": 100}],
    )
    os.environ["MORPHZ_STATE_BENCH_MEMGYM_ROOT"] = str(memgym_root)
    os.environ["MORPHZ_STATE_BENCH_EMBEDDING_MODEL_PATH"] = str(embedding_model_path)
    backend = AMemBackend(root)
    results = backend.retrieve("policy confirmation before action", 3)
    if not results or len(results) > 3:
        raise RuntimeError("A-MEM no-model reload retrieval failed")
    return {
        "stored": len(system.memories),
        "retrieved": len(results),
        "wall_time_seconds": round(time.monotonic() - started, 6),
    }


def _build_mem0(
    root: Path,
    *,
    mem0_root: Path,
    embedding_model_path: Path,
) -> dict[str, object]:
    os.environ["MEM0_DIR"] = str(root / "mem0_home")
    os.environ["MEM0_TELEMETRY"] = "false"
    if str(mem0_root) not in sys.path:
        sys.path.insert(0, str(mem0_root))
    from mem0 import Memory

    started = time.monotonic()
    qdrant_path = root / "qdrant"
    history_path = root / "history.db"
    live_config = {
        "vector_store": {
            "provider": "qdrant",
            "config": {
                "collection_name": "me07_travel",
                "embedding_model_dims": 384,
                "path": str(qdrant_path),
                "on_disk": True,
            },
        },
        "llm": {
            "provider": "openai",
            "config": {
                "model": "gpt-5.6-sol",
                "api_key": "no-model-gate",
                "openai_base_url": "http://127.0.0.1:1/v1",
                "reasoning_effort": "max",
                "is_reasoning_model": True,
                "store": False,
            },
        },
        "embedder": {
            "provider": "huggingface",
            "config": {"model": str(embedding_model_path)},
        },
        "history_db_path": str(history_path),
    }
    memory = Memory.from_config(live_config)
    inputs = _inputs("travel")
    for item in inputs:
        memory.add(
            item.canonical,
            agent_id="state-bench-travel",
            infer=False,
            metadata={"trajectory_id": item.trajectory_id, "gate": "no-model"},
        )
    client = getattr(getattr(memory, "vector_store", None), "client", None)
    close = getattr(client, "close", None)
    if callable(close):
        close()
    frozen_config = {
        "vector_store": {
            "provider": "qdrant",
            "config": {
                "collection_name": "me07_travel",
                "embedding_model_dims": 384,
                "path": "${ARTIFACT_DIR}/qdrant",
                "on_disk": True,
            },
        },
        "llm": {
            "provider": "openai",
            "config": {
                "model": "gpt-5.6-sol",
                "api_key": AGENT_KEY_PLACEHOLDER,
                "openai_base_url": AGENT_BASE_URL_PLACEHOLDER,
                "reasoning_effort": "max",
                "is_reasoning_model": True,
                "store": False,
            },
        },
        "embedder": {
            "provider": "huggingface",
            "config": {"model": EMBEDDING_PLACEHOLDER},
        },
        "history_db_path": "${ARTIFACT_DIR}/history.db",
    }
    (root / "mem0_config.json").write_text(
        json.dumps(frozen_config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    payloads = ["mem0_config.json", "history.db"]
    payloads.extend(
        path.relative_to(root).as_posix()
        for path in qdrant_path.rglob("*")
        if path.is_file()
    )
    write_artifact_manifest(
        root,
        arm="mem0",
        domain="travel",
        inputs=inputs,
        payload_paths=payloads,
        method={"implementation": "no-model-reload-gate"},
        build_receipts=[{"status": "stored", "count": 100}],
    )
    os.environ["MORPHZ_STATE_BENCH_AGENT_API_KEY"] = "no-model-gate"
    os.environ["MORPHZ_STATE_BENCH_AGENT_BASE_URL"] = "http://127.0.0.1:1/v1"
    os.environ["MORPHZ_STATE_BENCH_EMBEDDING_MODEL_PATH"] = str(embedding_model_path)
    backend = Mem0Backend(root, domain="travel")
    results = backend.retrieve("policy confirmation before action", 3)
    backend_client = getattr(getattr(backend.memory, "vector_store", None), "client", None)
    backend_close = getattr(backend_client, "close", None)
    if callable(backend_close):
        backend_close()
    if not results or len(results) > 3:
        raise RuntimeError("Mem0 no-model reload retrieval failed")
    return {
        "stored": 100,
        "retrieved": len(results),
        "scope": "agent_id",
        "wall_time_seconds": round(time.monotonic() - started, 6),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--memgym-root", type=Path, required=True)
    parser.add_argument("--mem0-root", type=Path, required=True)
    parser.add_argument("--embedding-model-path", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    temp = Path(tempfile.mkdtemp(prefix="me07-artifact-reload-gate-"))
    result: dict[str, object] = {
        "gate": "ME-07-strong-memory-artifact-reload-no-model-v1",
        "real_model_calls": 0,
        "morphz": {
            "status": "builder-orchestration-unit-tested",
            "production_snapshot_reload": "requires real context_tx smoke",
        },
    }
    try:
        amem_root = temp / "amem" / "travel"
        mem0_root = temp / "mem0" / "travel"
        amem_root.mkdir(parents=True)
        mem0_root.mkdir(parents=True)
        result["amem"] = _build_amem(
            amem_root,
            memgym_root=args.memgym_root.resolve(),
            embedding_model_path=args.embedding_model_path.resolve(),
        )
        result["mem0"] = _build_mem0(
            mem0_root,
            mem0_root=args.mem0_root.resolve(),
            embedding_model_path=args.embedding_model_path.resolve(),
        )
        result["gate_passed"] = True
    except Exception as error:
        result["gate_passed"] = False
        result["error_type"] = type(error).__name__
        result["error"] = str(error)[-2000:]
    finally:
        shutil.rmtree(temp, ignore_errors=True)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"gate_passed={str(bool(result.get('gate_passed'))).lower()}")
    print(f"result={args.output.resolve()}")
    return 0 if result.get("gate_passed") else 4


if __name__ == "__main__":
    raise SystemExit(main())
