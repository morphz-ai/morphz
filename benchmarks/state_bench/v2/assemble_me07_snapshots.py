#!/opt/morphz-me07-20260826/venv/bin/python
"""Assemble verified local and cloud ME-07 training outputs for formal use."""

from __future__ import annotations

import hashlib
import json
import platform
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path("/opt/morphz-me07-20260826")
UPLOAD = ROOT / "uploads/local-v1"
MORPHZ_REMAINING = ROOT / "training/morphz-remaining-v1"
MEM0_REMAINING = ROOT / "training/mem0-remaining-v1"
DESTINATION = ROOT / "snapshots/formal-v1"
DOMAINS = ("travel", "customer_support", "shopping_assistant")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _tree_sha256(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        digest.update(path.relative_to(root).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def _receipt(path: Path) -> dict[str, object]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("passed") is not True or value.get("episode_count") != 100:
        raise RuntimeError(f"training receipt did not pass: {path}")
    return value


def _output(command: list[str]) -> str:
    return subprocess.check_output(command, text=True).strip()


def main() -> None:
    if DESTINATION.exists():
        raise FileExistsError(f"refusing to overwrite {DESTINATION}")

    local_receipts = {
        "morphz_travel": _receipt(
            UPLOAD / "receipts/morphz/travel-morphz-training-receipt.json"
        ),
        "mem0_travel": _receipt(
            UPLOAD / "receipts/mem0/travel-mem0-training-receipt.json"
        ),
    }
    for domain in DOMAINS:
        local_receipts[f"letta_{domain}"] = _receipt(
            UPLOAD
            / "receipts/letta"
            / f"{domain}-letta-training-receipt.json"
        )

    sequence_receipts = {}
    for arm, source in (
        ("morphz", MORPHZ_REMAINING),
        ("mem0", MEM0_REMAINING),
    ):
        sequence = json.loads(
            (source / "sequence_receipt.json").read_text(encoding="utf-8")
        )
        if sequence.get("completed") is not True:
            raise RuntimeError(f"{arm} cloud training sequence is incomplete")
        sequence_receipts[arm] = sequence
        for domain in ("customer_support", "shopping_assistant"):
            _receipt(
                source
                / "artifacts"
                / domain
                / f"{domain}-{arm}-training-receipt.json"
            )

    (DESTINATION / "morphz").mkdir(parents=True)
    (DESTINATION / "letta").mkdir()
    (DESTINATION / "mem0").mkdir()
    shutil.copytree(UPLOAD / "morphz-home", DESTINATION / "morphz-home")
    shutil.copy2(
        UPLOAD / "morphz/travel.sqlite",
        DESTINATION / "morphz/travel.sqlite",
    )
    for domain in ("customer_support", "shopping_assistant"):
        shutil.copy2(
            MORPHZ_REMAINING / "snapshots" / f"{domain}.sqlite",
            DESTINATION / "morphz" / f"{domain}.sqlite",
        )
    for domain in DOMAINS:
        shutil.copy2(
            UPLOAD / "letta" / f"{domain}.af",
            DESTINATION / "letta" / f"{domain}.af",
        )
    shutil.copytree(UPLOAD / "mem0/travel", DESTINATION / "mem0/travel")
    for domain in ("customer_support", "shopping_assistant"):
        shutil.copytree(
            MEM0_REMAINING / "snapshots" / domain,
            DESTINATION / "mem0" / domain,
        )

    audit = DESTINATION / "training-receipts"
    shutil.copytree(UPLOAD / "receipts", audit / "local")
    for arm, source in (
        ("morphz", MORPHZ_REMAINING),
        ("mem0", MEM0_REMAINING),
    ):
        shutil.copytree(source / "artifacts", audit / f"cloud-{arm}")
        shutil.copy2(
            source / "sequence_receipt.json",
            audit / f"cloud-{arm}-sequence-receipt.json",
        )

    manifest = {
        "kind": "ME-07 formal snapshot assembly",
        "local_receipts": sorted(local_receipts),
        "cloud_sequences": sequence_receipts,
        "producer_environments": {
            "morphz": {
                "travel": {
                    "platform": "Darwin-arm64",
                    "runtime_commit": "2e502056f52fc355e29f01df69d3b434607c257e",
                    "binary_sha256": (
                        "0666fd3c0e49b2365d923d9589229ed6e37d6d47bbabc6bfcf0e0a45d53fa31a"
                    ),
                },
                "customer_support": {
                    "platform": "Linux-x86_64",
                    "runtime_commit": "2e502056f52fc355e29f01df69d3b434607c257e",
                    "binary_sha256": (
                        "98a7ed2458d7dd3d086b9f5ddfbe682902f96dcb879c5719054afb70f57c2691"
                    ),
                },
                "shopping_assistant": {
                    "platform": "Linux-x86_64",
                    "runtime_commit": "2e502056f52fc355e29f01df69d3b434607c257e",
                    "binary_sha256": (
                        "98a7ed2458d7dd3d086b9f5ddfbe682902f96dcb879c5719054afb70f57c2691"
                    ),
                },
            },
            "letta": {domain: "Darwin-arm64" for domain in DOMAINS},
            "mem0": {
                "travel": "Darwin-arm64",
                "customer_support": "Linux-x86_64",
                "shopping_assistant": "Linux-x86_64",
            },
        },
        "snapshots": {
            domain: {
                "morphz_sha256": _sha256(
                    DESTINATION / "morphz" / f"{domain}.sqlite"
                ),
                "letta_sha256": _sha256(
                    DESTINATION / "letta" / f"{domain}.af"
                ),
                "mem0_tree_sha256": _tree_sha256(
                    DESTINATION / "mem0" / domain
                ),
            }
            for domain in DOMAINS
        },
    }
    (DESTINATION / "assembly_manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    environment = DESTINATION / "environment"
    environment.mkdir()
    # The frozen experiment venv is intentionally provisioned by uv without
    # installing pip into that environment.  Query the exact interpreter with
    # uv instead of mutating the venv merely to produce an environment lock.
    freeze = _output(
        [
            "/usr/local/bin/uv",
            "pip",
            "freeze",
            "--python",
            str(ROOT / "venv/bin/python"),
        ]
    )
    freeze_path = environment / "python-freeze.txt"
    freeze_path.write_text(freeze + "\n", encoding="utf-8")
    scripts = {
        "assemble_me07_snapshots.py": ROOT / "bin/assemble_me07_snapshots.py",
        "run_smoke_then_formal.py": ROOT / "bin/run_smoke_then_formal.py",
        "run_training_sequence.py": ROOT / "bin/run_training_sequence.py",
        "run_linux_no_model_gate_v3.py": ROOT
        / "bin/run_linux_no_model_gate_v3.py",
        "wait_and_start_formal.py": ROOT / "bin/wait_and_start_formal.py",
        "morphz_train_snapshots.py": ROOT
        / "paper-evals/benchmarks/state_bench/v2/morphz_train_snapshots.py",
        "letta_train_snapshots.py": ROOT
        / "paper-evals/benchmarks/state_bench/v2/letta_train_snapshots.py",
        "mem0_train_snapshots.py": ROOT
        / "paper-evals/benchmarks/state_bench/v2/mem0_train_snapshots.py",
        "run_public_systems_smoke.py": ROOT
        / "paper-evals/benchmarks/state_bench/v2/run_public_systems_smoke.py",
        "run_public_systems_formal.py": ROOT
        / "paper-evals/benchmarks/state_bench/v2/run_public_systems_formal.py",
        "summarize_public_systems_formal.py": ROOT
        / "paper-evals/benchmarks/state_bench/v2/summarize_public_systems_formal.py",
        "prepare_evaluator_human_validation.py": ROOT
        / (
            "paper-evals/benchmarks/state_bench/v2/"
            "prepare_evaluator_human_validation.py"
        ),
        "morphz-me07-finalize-and-start-20260826.service": Path(
            "/etc/systemd/system/morphz-me07-finalize-and-start-20260826.service"
        ),
        "morphz-me07-formal-20260826.service": Path(
            "/etc/systemd/system/morphz-me07-formal-20260826.service"
        ),
    }
    lock = {
        "protocol_id": "ME-07-STATE-Bench-public-agent-systems-v2",
        "protocol_revision": "runtime-release-r3",
        "formal_execution_platform": {
            "system": platform.system(),
            "machine": platform.machine(),
            "release": platform.release(),
            "python": sys.version,
            "cpu_count": _output(["nproc"]),
            "memory_kib": _output(
                ["awk", "/MemTotal/ {print $2}", "/proc/meminfo"]
            ),
        },
        "source": {
            "paper_eval_code_commit": (
                "773ed342672a3f9f20c08a744cd0ea707357bf23"
            ),
            "paper_eval_protocol_commit": (
                "38454e2aebd7869ad8bf668d3f8ced4bee7fbe60"
            ),
            "paper_eval_handoff_commit": (
                "f0e4bdf430bd536eaddc18109ec00a096e1d1527"
            ),
            "state_bench_commit": _output(
                ["git", "-C", str(ROOT / "state-bench-git"), "rev-parse", "HEAD"]
            ),
            "runtime_commit": "2249878536ce5f7a8d7449add2f5c8743395b69b",
            "runtime_adapter_commit": (
                "2e502056f52fc355e29f01df69d3b434607c257e"
            ),
            "training_runtime_commit": (
                "2e502056f52fc355e29f01df69d3b434607c257e"
            ),
            "letta_commit": "1131535716e8a31c9a437f8695e25ac98f203a24",
            "mem0_commit": "dc82354e143c2581d505d581a00286d6ef8c3605",
        },
        "versions": {
            "runtime_rust": "1.97.1",
            "letta": "0.16.8",
            "mem0": "2.0.19",
            "postgres": _output(
                ["docker", "exec", "morphz-me07-postgres", "postgres", "--version"]
            ),
            "ollama_model": "nomic-embed-text:latest@0a109f422b47",
        },
        "container_images": {
            "ollama/ollama:0.5.4": _output(
                [
                    "docker",
                    "image",
                    "inspect",
                    "ollama/ollama:0.5.4",
                    "--format",
                    "{{.Id}}",
                ]
            ),
            "pgvector/pgvector:0.8.1-pg15-bookworm": _output(
                [
                    "docker",
                    "image",
                    "inspect",
                    "pgvector/pgvector:0.8.1-pg15-bookworm",
                    "--format",
                    "{{.Id}}",
                ]
            ),
        },
        "model_binding": {
            "route": "gpt-5.6-sol",
            "physical_model": "gpt-5.6-sol",
            "reasoning_effort": "max",
            "provider": "cliproxyapi",
            "api": "responses",
            "fallback": False,
        },
        "runtime_binary_sha256": (
            "7b0c63cd685f4b4420f362bea1f986fa4546ad27482802aec5af3c9cbdbb356e"
        ),
        "formal_runtime_release_receipt_sha256": _sha256(
            ROOT / "runtime/formal-runtime-release.json"
        ),
        "python_freeze_sha256": _sha256(freeze_path),
        "pipeline_script_sha256": {
            name: _sha256(path) for name, path in scripts.items()
        },
        "snapshot_assembly_manifest_sha256": _sha256(
            DESTINATION / "assembly_manifest.json"
        ),
    }
    (environment / "environment_lock.json").write_text(
        json.dumps(lock, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
