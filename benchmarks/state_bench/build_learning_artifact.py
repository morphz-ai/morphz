#!/usr/bin/env python3
"""Build one frozen ME-07 learning artifact without exposing credentials."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys


HERE = Path(__file__).resolve().parent
OVERLAY_ROOT = HERE / "overlay"
if str(OVERLAY_ROOT) not in sys.path:
    sys.path.insert(0, str(OVERLAY_ROOT))

from morphz_state_bench.artifacts import (  # noqa: E402
    AMemArtifactBuilder,
    Mem0ArtifactBuilder,
    MorphzArtifactBuilder,
    build_frozen_artifact,
)
from morphz_state_bench.protocol import DOMAINS, FORMAL_ARMS, load_protocol_lock  # noqa: E402


def _git_commit(root: Path) -> str:
    completed = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
        capture_output=True,
        text=True,
        check=True,
    )
    return completed.stdout.strip()


def _require_commit(root: Path, expected: str, label: str) -> None:
    actual = _git_commit(root)
    if actual != expected:
        raise RuntimeError(f"{label} commit mismatch: expected {expected}, got {actual}")


def _secret(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"required credential environment variable is missing: {name}")
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--arm", choices=FORMAL_ARMS, required=True)
    parser.add_argument("--domain", choices=DOMAINS, required=True)
    parser.add_argument("--state-bench-root", type=Path, required=True)
    parser.add_argument("--artifact-root", type=Path, required=True)
    parser.add_argument("--morphz-binary", type=Path)
    parser.add_argument("--morphz-profile")
    parser.add_argument("--morphz-timeout-seconds", type=int, default=1800)
    parser.add_argument("--memgym-root", type=Path)
    parser.add_argument("--mem0-root", type=Path)
    parser.add_argument("--embedding-model-path", type=Path)
    args = parser.parse_args()

    lock = load_protocol_lock(HERE / "protocol_lock.json")
    state_bench_root = args.state_bench_root.resolve()
    _require_commit(
        state_bench_root,
        lock["upstreams"]["state_bench"]["commit"],
        "STATE-Bench",
    )
    train_root = state_bench_root / "datasets" / "train_task_trajectories"

    if args.arm == "morphz":
        if args.morphz_binary is None or not args.morphz_profile:
            parser.error("morphz arm requires --morphz-binary and --morphz-profile")
        builder = MorphzArtifactBuilder(
            binary=args.morphz_binary,
            profile=args.morphz_profile,
            timeout_seconds=args.morphz_timeout_seconds,
        )
    elif args.arm == "amem":
        if args.memgym_root is None or args.embedding_model_path is None:
            parser.error("amem arm requires --memgym-root and --embedding-model-path")
        _require_commit(
            args.memgym_root,
            lock["upstreams"]["memgym_amem_implementation"]["commit"],
            "MemGym",
        )
        builder = AMemArtifactBuilder(
            memgym_root=args.memgym_root,
            embedding_model_path=args.embedding_model_path,
            api_key=_secret("MORPHZ_STATE_BENCH_AGENT_API_KEY"),
            base_url=_secret("MORPHZ_STATE_BENCH_AGENT_BASE_URL"),
        )
    else:
        if args.mem0_root is None or args.embedding_model_path is None:
            parser.error("mem0 arm requires --mem0-root and --embedding-model-path")
        _require_commit(
            args.mem0_root,
            lock["upstreams"]["mem0"]["commit"],
            "Mem0",
        )
        builder = Mem0ArtifactBuilder(
            mem0_root=args.mem0_root,
            embedding_model_path=args.embedding_model_path,
            api_key=_secret("MORPHZ_STATE_BENCH_AGENT_API_KEY"),
            base_url=_secret("MORPHZ_STATE_BENCH_AGENT_BASE_URL"),
        )

    result = build_frozen_artifact(
        arm=args.arm,
        domain=args.domain,
        train_root=train_root,
        artifact_root=args.artifact_root.resolve(),
        builder=builder,
    )
    manifest = json.loads((result / "artifact_manifest.json").read_text(encoding="utf-8"))
    print(f"artifact={result}")
    print(f"arm={manifest['arm']}")
    print(f"domain={manifest['domain']}")
    print(f"training_trajectory_count={manifest['training_trajectory_count']}")
    print(f"canonical_training_digest={manifest['canonical_training_digest']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
