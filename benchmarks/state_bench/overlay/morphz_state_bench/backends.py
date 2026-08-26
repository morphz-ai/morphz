"""Read-only strong-memory backends exposed through one STATE-Bench tool."""

from __future__ import annotations

from abc import ABC, abstractmethod
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from typing import Any

from .protocol import FORMAL_ARMS, find_secret_paths, sha256_file


class StrongMemoryBackend(ABC):
    arm: str

    @abstractmethod
    def retrieve(self, query: str, top_k: int) -> list[str]:
        """Return at most top_k read-only procedural learnings."""

    def audit_metadata(self) -> dict[str, Any]:
        return {"arm": self.arm}


class FixtureBackend(StrongMemoryBackend):
    """Deterministic backend used only by no-model contract tests."""

    arm = "fixture"

    def __init__(self, learnings: list[str]):
        self.learnings = list(learnings)
        self.calls: list[dict[str, Any]] = []

    def retrieve(self, query: str, top_k: int) -> list[str]:
        self.calls.append({"query": query, "top_k": top_k})
        return self.learnings[:top_k]


def parse_morphz_recall_page(value: dict[str, Any], top_k: int) -> list[str]:
    matches = value.get("matches")
    if not isinstance(matches, list):
        raise ValueError("Morphz Recall response missing matches list")
    learnings: list[str] = []
    for hit in matches:
        if not isinstance(hit, dict):
            continue
        kind = hit.get("document_kind", hit.get("kind"))
        if kind != "frame" or bool(hit.get("retired")):
            continue
        preview = hit.get("preview")
        if isinstance(preview, str) and preview.strip():
            learnings.append(preview.strip())
        if len(learnings) >= top_k:
            break
    return learnings


class MorphzRecallBackend(StrongMemoryBackend):
    arm = "morphz"

    def __init__(self, artifact_dir: Path, *, task_id: str, output_dir: str | None):
        config_path = artifact_dir / "backend.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        secret_paths = find_secret_paths(config)
        if secret_paths:
            raise ValueError(f"Morphz backend config contains secret fields: {secret_paths}")
        self.binary = Path(config["binary"]).resolve()
        self.binary_sha256 = str(config["binary_sha256"])
        self.config_file = Path(config["config_file"]).resolve() if config.get("config_file") else None
        self.snapshot = (artifact_dir / config.get("snapshot", "learned_context.sqlite")).resolve()
        self.snapshot_sha256 = str(config["snapshot_sha256"])
        self.context_id = str(config["context_id"])
        if sha256_file(self.binary) != self.binary_sha256:
            raise ValueError("Morphz binary digest mismatch")
        if sha256_file(self.snapshot) != self.snapshot_sha256:
            raise ValueError("Morphz learning snapshot digest mismatch")
        for suffix in ("-wal", "-shm"):
            if Path(str(self.snapshot) + suffix).exists():
                raise ValueError("Morphz learning snapshot must be checkpointed before freezing")
        work_root = Path(output_dir) if output_dir else Path(tempfile.mkdtemp(prefix="me07-morphz-recall-"))
        work_root.mkdir(parents=True, exist_ok=True)
        safe_task = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in task_id)
        self.working_db = work_root / f"{safe_task}-learning-clone.sqlite"
        if self.working_db.exists():
            raise FileExistsError(f"refusing to reuse task-local learning clone: {self.working_db}")
        shutil.copy2(self.snapshot, self.working_db)

    def retrieve(self, query: str, top_k: int) -> list[str]:
        if not query.strip():
            raise ValueError("retrieval query must be non-empty")
        before = sha256_file(self.snapshot)
        command = [str(self.binary)]
        if self.config_file is not None:
            command.extend(["--config-file", str(self.config_file)])
        command.extend(
            [
                "--context",
                self.context_id,
                "context",
                "recall",
                "search",
                query,
                "--limit",
                str(min(100, max(top_k * 4, top_k))),
                "--format=json",
            ]
        )
        environment = dict(os.environ)
        environment["MORPHZ_STORAGE_SQLITE_PATH"] = str(self.working_db)
        environment["MORPHZ_CONTEXT_ID"] = self.context_id
        completed = subprocess.run(
            command,
            env=environment,
            capture_output=True,
            text=True,
            check=False,
            timeout=120,
        )
        if completed.returncode != 0:
            raise RuntimeError(f"Morphz Recall failed with exit {completed.returncode}: {completed.stderr[-1000:]}")
        value = json.loads(completed.stdout)
        if before != sha256_file(self.snapshot):
            raise RuntimeError("frozen Morphz learning snapshot changed during retrieval")
        return parse_morphz_recall_page(value, top_k)

    def audit_metadata(self) -> dict[str, Any]:
        return {
            "arm": self.arm,
            "binary_sha256": self.binary_sha256,
            "snapshot_sha256": self.snapshot_sha256,
            "context_id": self.context_id,
            "source_snapshot_immutable": True,
        }


class AMemBackend(StrongMemoryBackend):
    arm = "amem"

    def __init__(self, artifact_dir: Path):
        state_path = artifact_dir / "amem_state.json"
        raw_state = json.loads(state_path.read_text(encoding="utf-8"))
        state = _resolve_env_placeholders(raw_state, artifact_dir=artifact_dir)
        memgym_root = os.environ.get("MORPHZ_STATE_BENCH_MEMGYM_ROOT", "").strip()
        if not memgym_root:
            raise RuntimeError("MORPHZ_STATE_BENCH_MEMGYM_ROOT is required for the A-MEM arm")
        source_root = str((Path(memgym_root) / "src").resolve())
        if source_root not in sys.path:
            sys.path.insert(0, source_root)
        from memgym.memory.external.amem.system import AgenticMemorySystem

        self.system = AgenticMemorySystem.from_dict(state)
        self.state_sha256 = sha256_file(state_path)

    def retrieve(self, query: str, top_k: int) -> list[str]:
        indices = self.system.retriever.search(query, top_k)
        memories = list(self.system.memories.values())
        learnings: list[str] = []
        for index in indices:
            if not isinstance(index, int) or not 0 <= index < len(memories):
                continue
            memory = memories[index]
            learnings.append(
                "\n".join(
                    [
                        f"content: {memory.content}",
                        f"context: {memory.context}",
                        f"keywords: {', '.join(memory.keywords)}",
                        f"tags: {', '.join(memory.tags)}",
                    ]
                )
            )
        return learnings[:top_k]

    def audit_metadata(self) -> dict[str, Any]:
        return {"arm": self.arm, "state_sha256": self.state_sha256}


def _resolve_env_placeholders(value: Any, *, artifact_dir: Path | None = None) -> Any:
    if isinstance(value, dict):
        return {
            key: _resolve_env_placeholders(child, artifact_dir=artifact_dir)
            for key, child in value.items()
        }
    if isinstance(value, list):
        return [_resolve_env_placeholders(child, artifact_dir=artifact_dir) for child in value]
    if isinstance(value, str) and value.startswith("${") and value.endswith("}"):
        name = value[2:-1]
        if name == "ARTIFACT_DIR":
            if artifact_dir is None:
                raise RuntimeError("ARTIFACT_DIR placeholder requires an artifact directory")
            return str(artifact_dir.resolve())
        resolved = os.environ.get(name)
        if resolved is None:
            raise RuntimeError(f"required environment variable is missing: {name}")
        return resolved
    if isinstance(value, str) and "${ARTIFACT_DIR}" in value:
        if artifact_dir is None:
            raise RuntimeError("ARTIFACT_DIR placeholder requires an artifact directory")
        return value.replace("${ARTIFACT_DIR}", str(artifact_dir.resolve()))
    return value


class Mem0Backend(StrongMemoryBackend):
    arm = "mem0"

    def __init__(self, artifact_dir: Path, *, domain: str):
        config_path = artifact_dir / "mem0_config.json"
        raw_config = json.loads(config_path.read_text(encoding="utf-8"))
        self.config_sha256 = sha256_file(config_path)
        config = _resolve_env_placeholders(raw_config, artifact_dir=artifact_dir)
        from mem0 import Memory

        self.memory = Memory.from_config(config)
        # Procedural memories are written through Mem0's agent-scoped API.
        # Reading them back through user_id silently yields an empty result.
        self.agent_id = f"state-bench-{domain}"

    def retrieve(self, query: str, top_k: int) -> list[str]:
        response = self.memory.search(query, top_k=top_k, filters={"agent_id": self.agent_id})
        rows = response.get("results", []) if isinstance(response, dict) else []
        learnings = [
            str(row.get("memory")).strip()
            for row in rows
            if isinstance(row, dict) and str(row.get("memory") or "").strip()
        ]
        return learnings[:top_k]

    def audit_metadata(self) -> dict[str, Any]:
        return {"arm": self.arm, "config_sha256": self.config_sha256}


def create_backend(
    arm: str,
    artifact_root: Path,
    *,
    domain: str,
    task_id: str,
    output_dir: str | None = None,
) -> StrongMemoryBackend:
    if arm not in FORMAL_ARMS:
        raise ValueError(f"formal ME-07 arm must be one of {FORMAL_ARMS}, got {arm!r}")
    artifact_dir = artifact_root / arm / domain
    if not artifact_dir.is_dir():
        raise FileNotFoundError(f"missing ME-07 memory artifact: {artifact_dir}")
    from .artifacts import verify_artifact_manifest

    verify_artifact_manifest(artifact_dir, arm=arm, domain=domain)
    if arm == "morphz":
        return MorphzRecallBackend(artifact_dir, task_id=task_id, output_dir=output_dir)
    if arm == "amem":
        return AMemBackend(artifact_dir)
    return Mem0Backend(artifact_dir, domain=domain)
