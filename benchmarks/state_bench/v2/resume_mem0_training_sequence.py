"""Recover one interrupted, unscored ME-07 Mem0 training domain.

The scored formal queue is never touched here.  This utility verifies the
durable-prefix training receipt produced by ``mem0_train_snapshots.py`` and
atomically closes the cloud sequence receipt only after all expected episodes
have been ingested.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any

import yaml


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _atomic_json(path: Path, value: object) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def _access_key(config_path: Path) -> str:
    config = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    keys = config.get("api-keys") if isinstance(config, dict) else None
    if (
        not isinstance(keys, list)
        or len(keys) != 1
        or not isinstance(keys[0], str)
        or not keys[0]
    ):
        raise RuntimeError("expected exactly one configured CLIProxyAPI access key")
    return keys[0]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--domain", required=True)
    parser.add_argument("--input-root", type=Path, required=True)
    parser.add_argument("--snapshot-dir", type=Path, required=True)
    parser.add_argument("--artifact-dir", type=Path, required=True)
    parser.add_argument("--sequence-receipt", type=Path, required=True)
    parser.add_argument("--resume-prefix-count", type=int, required=True)
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--paper-evals-root", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--base-url", default="http://127.0.0.1:18317/v1")
    args = parser.parse_args()

    prior_sequence_bytes = args.sequence_receipt.read_bytes()
    sequence = json.loads(prior_sequence_bytes)
    if not isinstance(sequence, dict) or sequence.get("completed") is True:
        raise RuntimeError("sequence receipt is missing or already complete")
    prior_domains = sequence.get("domains")
    if not isinstance(prior_domains, list):
        raise TypeError("sequence receipt domains are not a list")
    if any(item.get("domain") == args.domain for item in prior_domains):
        raise RuntimeError(f"sequence receipt already contains domain {args.domain}")

    environment = os.environ.copy()
    environment.update(
        {
            "OPENAI_API_KEY": _access_key(args.config),
            "OPENAI_BASE_URL": args.base_url,
            "PYTHONPATH": str(args.paper_evals_root),
        }
    )
    started = time.time()
    command = [
        str(args.python),
        str(
            args.paper_evals_root
            / "benchmarks/state_bench/v2/mem0_train_snapshots.py"
        ),
        "--domain",
        args.domain,
        "--input-root",
        str(args.input_root),
        "--snapshot-dir",
        str(args.snapshot_dir),
        "--artifact-dir",
        str(args.artifact_dir),
        "--resume-prefix-count",
        str(args.resume_prefix_count),
        "--require-add",
    ]
    subprocess.run(
        command,
        cwd=args.paper_evals_root,
        env=environment,
        check=True,
    )

    receipt_path = args.artifact_dir / f"{args.domain}-mem0-training-receipt.json"
    training = json.loads(receipt_path.read_text(encoding="utf-8"))
    if (
        training.get("passed") is not True
        or training.get("episode_count") != 100
        or training.get("resume", {}).get("durable_prefix_count")
        != args.resume_prefix_count
    ):
        raise RuntimeError("recovered Mem0 training receipt failed its closure gate")
    episodes = training.get("episodes")
    if not isinstance(episodes, list) or len(episodes) != 100:
        raise RuntimeError("recovered Mem0 training receipt does not contain 100 episodes")

    recovered_elapsed = round(time.time() - started, 3)
    updated: dict[str, Any] = dict(sequence)
    updated["domains"] = [
        *prior_domains,
        {
            "domain": args.domain,
            "completed": True,
            "elapsed_seconds": recovered_elapsed,
            "recovered_from_durable_prefix": args.resume_prefix_count,
            "training_receipt": str(receipt_path),
            "training_receipt_sha256": _sha256(receipt_path),
        },
    ]
    updated["completed"] = True
    updated["recovery"] = {
        "kind": "provider_stream_408_after_durable_prefix",
        "prior_sequence_receipt_sha256": hashlib.sha256(
            prior_sequence_bytes
        ).hexdigest(),
        "durable_prefix_count": args.resume_prefix_count,
        "remaining_episode_count": 100 - args.resume_prefix_count,
        "formal_scores_affected": False,
    }
    updated["elapsed_seconds_including_recovery"] = round(
        float(sequence.get("elapsed_seconds", 0.0)) + recovered_elapsed,
        3,
    )
    _atomic_json(args.sequence_receipt, updated)
    print(
        json.dumps(
            {
                "sequence_receipt": str(args.sequence_receipt),
                "training_receipt": str(receipt_path),
                "episodes": 100,
                "resume_prefix_count": args.resume_prefix_count,
                "completed": True,
            },
            sort_keys=True,
        ),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
