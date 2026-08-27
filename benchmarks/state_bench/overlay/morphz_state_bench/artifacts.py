"""Build and verify frozen learning artifacts for ME-07.

All arms receive the same canonical STATE-Bench training trajectories. Each
method then applies its native learning/update mechanism. Held-out task paths
are intentionally absent from this module's interface.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time
from typing import Any, Callable, Iterable

from .protocol import (
    DOMAINS,
    FORMAL_ARMS,
    TRAIN_TRAJECTORIES_PER_DOMAIN,
    canonicalize_trajectory,
    discover_train_trajectories,
    sha256_file,
)


PROTOCOL_ID = "ME-07-STATE-Bench-strong-memory-v1"
EMBEDDING_PLACEHOLDER = "${MORPHZ_STATE_BENCH_EMBEDDING_MODEL_PATH}"
AGENT_KEY_PLACEHOLDER = "${MORPHZ_STATE_BENCH_AGENT_API_KEY}"
AGENT_BASE_URL_PLACEHOLDER = "${MORPHZ_STATE_BENCH_AGENT_BASE_URL}"


@dataclass(frozen=True)
class CanonicalTrainingInput:
    domain: str
    trajectory_id: str
    canonical: str
    sha256: str


def collect_training_inputs(train_root: Path, domain: str) -> list[CanonicalTrainingInput]:
    inputs: list[CanonicalTrainingInput] = []
    for path in discover_train_trajectories(train_root, domain):
        canonical = canonicalize_trajectory(path, domain)
        inputs.append(
            CanonicalTrainingInput(
                domain=domain,
                trajectory_id=path.stem,
                canonical=canonical,
                sha256=hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
            )
        )
    return inputs


def canonical_training_digest(inputs: Iterable[CanonicalTrainingInput]) -> str:
    digest = hashlib.sha256()
    for item in inputs:
        digest.update(item.canonical.encode("utf-8"))
        digest.update(b"\n")
    return digest.hexdigest()


def write_canonical_inputs(path: Path, inputs: Iterable[CanonicalTrainingInput]) -> None:
    with path.open("w", encoding="utf-8") as target:
        for item in inputs:
            target.write(item.canonical)
            target.write("\n")


def _payload_hashes(root: Path, relative_paths: Iterable[str]) -> dict[str, str]:
    hashes: dict[str, str] = {}
    for relative in sorted(set(relative_paths)):
        path = root / relative
        if not path.is_file():
            raise FileNotFoundError(f"artifact payload missing: {path}")
        hashes[relative] = sha256_file(path)
    return hashes


def write_artifact_manifest(
    root: Path,
    *,
    arm: str,
    domain: str,
    inputs: list[CanonicalTrainingInput],
    payload_paths: Iterable[str],
    method: dict[str, Any],
    build_receipts: list[dict[str, Any]],
) -> Path:
    if arm not in FORMAL_ARMS or domain not in DOMAINS:
        raise ValueError("invalid formal arm or domain")
    manifest = {
        "schema": "me07-learning-artifact-manifest-v1",
        "protocol_id": PROTOCOL_ID,
        "arm": arm,
        "domain": domain,
        "training_trajectory_count": len(inputs),
        "canonical_training_digest": canonical_training_digest(inputs),
        "trajectory_sha256": {item.trajectory_id: item.sha256 for item in inputs},
        "method": method,
        "build_receipts": build_receipts,
        "payload_sha256": _payload_hashes(root, payload_paths),
        "heldout_oracle_access": False,
    }
    path = root / "artifact_manifest.json"
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def verify_artifact_manifest(root: Path, *, arm: str, domain: str) -> dict[str, Any]:
    path = root / "artifact_manifest.json"
    manifest = json.loads(path.read_text(encoding="utf-8"))
    expected = {
        "schema": "me07-learning-artifact-manifest-v1",
        "protocol_id": PROTOCOL_ID,
        "arm": arm,
        "domain": domain,
        "heldout_oracle_access": False,
    }
    for key, value in expected.items():
        if manifest.get(key) != value:
            raise ValueError(f"artifact manifest mismatch: {key}")
    if manifest.get("training_trajectory_count") != TRAIN_TRAJECTORIES_PER_DOMAIN:
        raise ValueError("artifact manifest does not contain the full official training split")
    trajectory_hashes = manifest.get("trajectory_sha256")
    if not isinstance(trajectory_hashes, dict) or len(trajectory_hashes) != TRAIN_TRAJECTORIES_PER_DOMAIN:
        raise ValueError("artifact manifest trajectory hash set is incomplete")
    payloads = manifest.get("payload_sha256")
    if not isinstance(payloads, dict) or not payloads:
        raise ValueError("artifact manifest has no payload hashes")
    for relative, expected_hash in payloads.items():
        candidate = (root / str(relative)).resolve()
        try:
            candidate.relative_to(root.resolve())
        except ValueError as error:
            raise ValueError(f"artifact payload escapes root: {relative}") from error
        if sha256_file(candidate) != expected_hash:
            raise ValueError(f"artifact payload digest mismatch: {relative}")
    return manifest


def _redact_error(value: str) -> str:
    value = re.sub(r"(?i)bearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [REDACTED]", value)
    value = re.sub(r"\bsk-[A-Za-z0-9_-]{8,}\b", "sk-[REDACTED]", value)
    return value[-4000:]


def _run_checked(
    command: list[str],
    *,
    environment: dict[str, str],
    timeout_seconds: int,
    stdout_path: Path,
    stderr_path: Path,
) -> tuple[float, str]:
    started = time.monotonic()
    completed = subprocess.run(
        command,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
        timeout=timeout_seconds,
    )
    stdout_path.write_text(completed.stdout, encoding="utf-8")
    stderr_path.write_text(_redact_error(completed.stderr), encoding="utf-8")
    if completed.returncode != 0:
        raise RuntimeError(
            f"command failed with exit {completed.returncode}: {_redact_error(completed.stderr)}"
        )
    return time.monotonic() - started, completed.stdout


def _morphz_learning_prompt(item: CanonicalTrainingInput) -> str:
    return f"""You are performing offline procedural learning for the STATE-Bench Agent Learning Track.

Analyze the completed successful training trajectory below. Derive only reusable domain procedures,
decision rules, tool-order constraints, consent or confirmation requirements, and failure-avoidance
lessons. Do not execute external tools and do not answer the historical user. Do not preserve volatile
customer, booking, order, product, or task identifiers as general facts. Use the production `context_tx`
tool to create, revise, relate, supersede, or retire Mind Frames in the current Context. Preserve this
source reference on every affected Frame: state-bench/train/{item.domain}/{item.trajectory_id}. Resolve
conflicts with existing Frames instead of blindly appending duplicates. End only after the Context
transaction has committed, with a short acknowledgement.

<canonical-training-trajectory domain=\"{item.domain}\" id=\"{item.trajectory_id}\">
{item.canonical}
</canonical-training-trajectory>
"""


def morphz_database_audit(database: Path) -> dict[str, Any]:
    usage_rows: list[dict[str, Any]] = []
    context_transactions = 0
    # A normal read connection to a WAL-mode database may create -wal/-shm
    # sidecars, invalidating the just-frozen source snapshot. Immutable URI
    # mode keeps this audit strictly read-only and side-effect free.
    immutable_uri = f"{database.resolve().as_uri()}?mode=ro&immutable=1"
    with sqlite3.connect(immutable_uri, uri=True) as connection:
        rows = connection.execute(
            "SELECT topic, payload FROM events WHERE topic IN "
            "('runtime/model_usage', 'chat/context_tx_committed') ORDER BY rowid"
        ).fetchall()
    for topic, payload_text in rows:
        if topic == "chat/context_tx_committed":
            context_transactions += 1
            continue
        payload = json.loads(payload_text)
        usage = payload.get("usage") or {}
        binding = payload.get("model_binding") or {}
        usage_rows.append(
            {
                "requested_model": payload.get("requested_model"),
                "effective_reasoning_effort": payload.get("effective_reasoning_effort"),
                "provider_instance_id": binding.get("provider_instance_id"),
                "physical_model": binding.get("physical_model"),
                "protocol": binding.get("protocol"),
                "route_id": binding.get("route_id"),
                "input_tokens": usage.get("input_tokens", 0),
                "output_tokens": usage.get("output_tokens", 0),
                "reasoning_tokens": usage.get("reasoning_tokens", 0),
                "total_tokens": usage.get("total_tokens", 0),
            }
        )
    exact_binding = bool(usage_rows) and all(
        row["requested_model"] == "gpt-5.6-sol"
        and row["physical_model"] == "gpt-5.6-sol"
        and row["effective_reasoning_effort"] == "max"
        and row["provider_instance_id"] == "custom"
        and row["protocol"] == "openai-responses"
        for row in usage_rows
    )
    return {
        "model_call_count": len(usage_rows),
        "context_tx_commit_count": context_transactions,
        "exact_sol_max_binding": exact_binding,
        "input_tokens": sum(int(row["input_tokens"] or 0) for row in usage_rows),
        "output_tokens": sum(int(row["output_tokens"] or 0) for row in usage_rows),
        "reasoning_tokens": sum(int(row["reasoning_tokens"] or 0) for row in usage_rows),
        "total_tokens": sum(int(row["total_tokens"] or 0) for row in usage_rows),
        "calls": usage_rows,
    }


class MorphzArtifactBuilder:
    def __init__(self, *, binary: Path, profile: str, timeout_seconds: int = 1800):
        self.binary = binary.resolve()
        self.profile = profile
        self.timeout_seconds = timeout_seconds

    def build(
        self,
        *,
        domain: str,
        inputs: list[CanonicalTrainingInput],
        root: Path,
    ) -> tuple[list[str], dict[str, Any], list[dict[str, Any]]]:
        root.mkdir(parents=True, exist_ok=False)
        logs = root / "build_logs"
        workspace = root / "workspace"
        runtime_artifacts = root / "runtime_artifacts"
        logs.mkdir()
        workspace.mkdir()
        runtime_artifacts.mkdir()
        database = root / "learned_context.sqlite"
        context_id = f"me07-{domain}-learning-v1"
        session_id = f"me07-{domain}-learning-session-v1"
        environment = dict(os.environ)
        environment.update(
            {
                "MORPHZ_STORAGE_SQLITE_PATH": str(database),
                "MORPHZ_CONTEXT_ID": context_id,
                "MORPHZ_SESSION_ID": session_id,
                "MORPHZ_WORKSPACE_ROOT": str(workspace),
                "MORPHZ_ARTIFACT_DIR": str(runtime_artifacts),
            }
        )
        receipts: list[dict[str, Any]] = []
        for index, item in enumerate(inputs, start=1):
            command = [
                str(self.binary),
                "--profile",
                self.profile,
                "--model",
                "gpt-5.6-sol",
                "--reasoning-effort",
                "max",
                "--sandbox",
                "full-access",
                "--approval",
                "never",
                "--network=false",
                "--plain",
                "exec",
                "--",
                _morphz_learning_prompt(item),
            ]
            elapsed, _ = _run_checked(
                command,
                environment=environment,
                timeout_seconds=self.timeout_seconds,
                stdout_path=logs / f"{index:03d}-{item.trajectory_id}.stdout.log",
                stderr_path=logs / f"{index:03d}-{item.trajectory_id}.stderr.log",
            )
            receipts.append(
                {
                    "trajectory_id": item.trajectory_id,
                    "status": "committed",
                    "wall_time_seconds": round(elapsed, 6),
                }
            )

        admin_prefix = [str(self.binary), "--context", context_id, "--format=json"]
        for label, suffix in (
            ("context_audit", ["context", "audit", context_id]),
            ("recall_rebuild", ["context", "recall-index", "rebuild", context_id]),
            ("recall_inspect", ["context", "recall-index", "inspect", context_id]),
        ):
            _run_checked(
                admin_prefix + suffix,
                environment=environment,
                timeout_seconds=300,
                stdout_path=root / f"{label}.json",
                stderr_path=logs / f"{label}.stderr.log",
            )

        with sqlite3.connect(database) as connection:
            connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchall()
        for suffix in ("-wal", "-shm"):
            candidate = Path(str(database) + suffix)
            if candidate.exists():
                candidate.unlink()
        binary_sha256 = sha256_file(self.binary)
        backend = {
            "binary": str(self.binary),
            "binary_sha256": binary_sha256,
            "config_file": None,
            "snapshot": database.name,
            "snapshot_sha256": sha256_file(database),
            "context_id": context_id,
        }
        (root / "backend.json").write_text(
            json.dumps(backend, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        payloads = [
            "backend.json",
            database.name,
            "context_audit.json",
            "recall_rebuild.json",
            "recall_inspect.json",
        ]
        method = {
            "implementation": "production-morphz-context-tx",
            "model": "gpt-5.6-sol",
            "reasoning_effort": "max",
            "profile": self.profile,
            "binary_sha256": binary_sha256,
            "one_context_per_domain": True,
            "full_access": True,
            "runtime_usage": morphz_database_audit(database),
        }
        return payloads, method, receipts


def _responses_text_format(response_format: dict[str, Any] | None) -> dict[str, Any] | None:
    if not response_format:
        return None
    if response_format.get("type") == "json_schema":
        source = response_format.get("json_schema") or {}
        return {
            "type": "json_schema",
            "name": source.get("name", "response"),
            "schema": source.get("schema") or {},
            "strict": bool(source.get("strict", True)),
        }
    if response_format.get("type") == "json_object":
        return {"type": "json_object"}
    raise ValueError(f"unsupported structured response format: {response_format}")


class ResponsesJsonController:
    """A-MEM LLMController-compatible GPT-5.6 Sol/max Responses adapter."""

    def __init__(self, *, api_key: str, base_url: str, client_factory: Callable[..., Any] | None = None):
        if client_factory is None:
            from openai import OpenAI

            client_factory = OpenAI
        self.client = client_factory(api_key=api_key, base_url=base_url.rstrip("/"))
        self.receipts: list[dict[str, Any]] = []

    def get_completion(
        self,
        prompt: str,
        response_format: dict[str, Any] | None = None,
        temperature: float | None = None,
    ) -> str:
        del temperature
        parameters: dict[str, Any] = {
            "model": "gpt-5.6-sol",
            "instructions": "Return the requested JSON object and no prose outside it.",
            "input": prompt,
            "reasoning": {"effort": "max"},
            "store": False,
        }
        text_format = _responses_text_format(response_format)
        if text_format is not None:
            parameters["text"] = {"format": text_format}
        started = time.monotonic()
        response = self.client.responses.create(**parameters)
        elapsed = time.monotonic() - started
        usage = getattr(response, "usage", None)
        self.receipts.append(
            {
                "response_id": getattr(response, "id", None),
                "response_model": getattr(response, "model", None),
                "wall_time_seconds": round(elapsed, 6),
                "input_tokens": getattr(usage, "input_tokens", None),
                "output_tokens": getattr(usage, "output_tokens", None),
                "total_tokens": getattr(usage, "total_tokens", None),
            }
        )
        output = getattr(response, "output_text", None)
        if not isinstance(output, str) or not output.strip():
            raise RuntimeError("A-MEM Responses adapter returned no text")
        return output


def _tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(candidate for candidate in root.rglob("*") if candidate.is_file()):
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        digest.update(b"\0")
    return digest.hexdigest()


class AMemArtifactBuilder:
    def __init__(self, *, memgym_root: Path, embedding_model_path: Path, api_key: str, base_url: str):
        self.memgym_root = memgym_root.resolve()
        self.embedding_model_path = embedding_model_path.resolve()
        self.api_key = api_key
        self.base_url = base_url

    def build(
        self,
        *,
        domain: str,
        inputs: list[CanonicalTrainingInput],
        root: Path,
    ) -> tuple[list[str], dict[str, Any], list[dict[str, Any]]]:
        root.mkdir(parents=True, exist_ok=False)
        source_root = str((self.memgym_root / "src").resolve())
        if source_root not in sys.path:
            sys.path.insert(0, source_root)
        from memgym.memory.external.amem.system import AgenticMemorySystem

        system = AgenticMemorySystem(
            model_name=str(self.embedding_model_path),
            llm_model="gpt-5.6-sol",
            enable_evolution=True,
            retrieve_k=5,
            verbose=False,
        )
        controller = ResponsesJsonController(api_key=self.api_key, base_url=self.base_url)
        system.llm_controller = controller
        receipts: list[dict[str, Any]] = []
        for index, item in enumerate(inputs, start=1):
            started = time.monotonic()
            note_id = system.add_note(item.canonical, time=f"train-{index:03d}")
            receipts.append(
                {
                    "trajectory_id": item.trajectory_id,
                    "note_id": note_id,
                    "status": "stored",
                    "wall_time_seconds": round(time.monotonic() - started, 6),
                }
            )
        state = system.to_dict()
        state["config"]["model_name"] = EMBEDDING_PLACEHOLDER
        (root / "amem_state.json").write_text(
            json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        (root / "model_calls.json").write_text(
            json.dumps(controller.receipts, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        method = {
            "implementation": "memgym-amem-compatible",
            "model": "gpt-5.6-sol",
            "reasoning_effort": "max",
            "embedding_model_path_sha256": _tree_digest(self.embedding_model_path),
            "enable_evolution": True,
            "retrieve_k": 5,
        }
        return ["amem_state.json", "model_calls.json"], method, receipts


class Mem0ArtifactBuilder:
    def __init__(self, *, mem0_root: Path, embedding_model_path: Path, api_key: str, base_url: str):
        self.mem0_root = mem0_root.resolve()
        self.embedding_model_path = embedding_model_path.resolve()
        self.api_key = api_key
        self.base_url = base_url

    def build(
        self,
        *,
        domain: str,
        inputs: list[CanonicalTrainingInput],
        root: Path,
    ) -> tuple[list[str], dict[str, Any], list[dict[str, Any]]]:
        root.mkdir(parents=True, exist_ok=False)
        os.environ["MEM0_DIR"] = str(root / "mem0_home")
        os.environ["MEM0_TELEMETRY"] = "false"
        source_root = str(self.mem0_root)
        if source_root not in sys.path:
            sys.path.insert(0, source_root)
        from mem0 import Memory

        qdrant_path = root / "qdrant"
        history_path = root / "history.db"
        model_calls: list[dict[str, Any]] = []

        def record_response(_llm: Any, response: Any, _parameters: dict[str, Any]) -> None:
            usage = getattr(response, "usage", None)
            model_calls.append(
                {
                    "response_id": getattr(response, "id", None),
                    "response_model": getattr(response, "model", None),
                    "input_tokens": getattr(usage, "prompt_tokens", None),
                    "output_tokens": getattr(usage, "completion_tokens", None),
                    "total_tokens": getattr(usage, "total_tokens", None),
                }
            )

        live_config = {
            "vector_store": {
                "provider": "qdrant",
                "config": {
                    "collection_name": f"me07_{domain}",
                    "embedding_model_dims": 384,
                    "path": str(qdrant_path),
                    "on_disk": True,
                },
            },
            "llm": {
                "provider": "openai",
                "config": {
                    "model": "gpt-5.6-sol",
                    "api_key": self.api_key,
                    "openai_base_url": self.base_url,
                    "reasoning_effort": "max",
                    "is_reasoning_model": True,
                    "store": False,
                    "response_callback": record_response,
                },
            },
            "embedder": {
                "provider": "huggingface",
                "config": {"model": str(self.embedding_model_path)},
            },
            "history_db_path": str(history_path),
        }
        memory = Memory.from_config(live_config)
        agent_id = f"state-bench-{domain}"
        receipts: list[dict[str, Any]] = []
        for item in inputs:
            started = time.monotonic()
            result = memory.add(
                [{"role": "user", "content": item.canonical}],
                agent_id=agent_id,
                memory_type="procedural_memory",
                metadata={
                    "domain": domain,
                    "trajectory_id": item.trajectory_id,
                    "source": f"state-bench/train/{domain}/{item.trajectory_id}",
                },
            )
            rows = result.get("results") if isinstance(result, dict) else None
            if not isinstance(rows, list) or not rows:
                raise RuntimeError(f"Mem0 produced no procedural memory for {item.trajectory_id}")
            receipts.append(
                {
                    "trajectory_id": item.trajectory_id,
                    "memory_ids": [row.get("id") for row in rows if isinstance(row, dict)],
                    "status": "stored",
                    "wall_time_seconds": round(time.monotonic() - started, 6),
                }
            )
        client = getattr(getattr(memory, "vector_store", None), "client", None)
        close = getattr(client, "close", None)
        if callable(close):
            close()
        frozen_config = {
            "vector_store": {
                "provider": "qdrant",
                "config": {
                    "collection_name": f"me07_{domain}",
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
        (root / "model_calls.json").write_text(
            json.dumps(model_calls, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        qdrant_payloads = [
            path.relative_to(root).as_posix()
            for path in qdrant_path.rglob("*")
            if path.is_file()
        ]
        payloads = ["mem0_config.json", "model_calls.json", "history.db", *qdrant_payloads]
        method = {
            "implementation": "mem0-oss-procedural-memory",
            "model": "gpt-5.6-sol",
            "reasoning_effort": "max",
            "embedding_model_path_sha256": _tree_digest(self.embedding_model_path),
            "scope": "agent_id",
            "agent_id": agent_id,
        }
        return payloads, method, receipts


def build_frozen_artifact(
    *,
    arm: str,
    domain: str,
    train_root: Path,
    artifact_root: Path,
    builder: Any,
) -> Path:
    if arm not in FORMAL_ARMS or domain not in DOMAINS:
        raise ValueError("invalid arm or domain")
    inputs = collect_training_inputs(train_root, domain)
    target = artifact_root / arm / domain
    if target.exists():
        raise FileExistsError(f"refusing to overwrite frozen artifact: {target}")
    stage = target.parent / f".{target.name}.building"
    if stage.exists():
        raise FileExistsError(f"unfinished build already exists: {stage}")
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        payloads, method, receipts = builder.build(domain=domain, inputs=inputs, root=stage)
        write_canonical_inputs(stage / "canonical_training_inputs.jsonl", inputs)
        payloads = [*payloads, "canonical_training_inputs.jsonl"]
        write_artifact_manifest(
            stage,
            arm=arm,
            domain=domain,
            inputs=inputs,
            payload_paths=payloads,
            method=method,
            build_receipts=receipts,
        )
        verify_artifact_manifest(stage, arm=arm, domain=domain)
        stage.replace(target)
        return target
    except Exception as error:
        if stage.exists():
            (stage / "BUILD_FAILURE.json").write_text(
                json.dumps(
                    {"error_type": type(error).__name__, "error": _redact_error(str(error))},
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
        raise
