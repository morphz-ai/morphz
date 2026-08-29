#!/usr/bin/env python3
"""Post-run infrastructure, trajectory and isolation Gate for public jobs."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
from pathlib import Path
from typing import Any, Callable

if __package__:
    from .benchmark_integrity import POLICY_MARKER, POLICY_VERSION
else:
    from benchmark_integrity import POLICY_MARKER, POLICY_VERSION


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object: {path}")
    return value


def validate_atif(path: Path) -> list[str]:
    """Return official ATIF validation errors without changing the trajectory."""

    from harbor.models.trajectories import Trajectory
    from harbor.utils.trajectory_validator import TrajectoryValidator

    errors: list[str] = []
    try:
        Trajectory.model_validate_json(path.read_text(encoding="utf-8"))
    except Exception as error:  # Pydantic emits several concrete error classes.
        errors.append(f"pydantic:{type(error).__name__}:{error}")
    validator = TrajectoryValidator()
    if not validator.validate(path):
        errors.extend(f"official:{error}" for error in validator.get_errors())
    return errors


def _event_identity(db_path: Path) -> tuple[set[str], set[str]]:
    contexts: set[str] = set()
    sessions: set[str] = set()
    connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = connection.execute(
            "SELECT payload FROM events WHERE topic = 'chat/user_message'"
        ).fetchall()
    finally:
        connection.close()
    for (raw_payload,) in rows:
        try:
            payload = json.loads(raw_payload)
        except (TypeError, json.JSONDecodeError):
            continue
        if isinstance(payload, dict):
            if payload.get("context_id"):
                contexts.add(str(payload["context_id"]))
            if payload.get("session_id"):
                sessions.add(str(payload["session_id"]))
    return contexts, sessions


def _secret_hits(job_dir: Path, secret: str) -> list[str]:
    needle = secret.encode()
    hits: list[str] = []
    for path in sorted(job_dir.rglob("*")):
        if not path.is_file() or "verifier" in path.parts:
            continue
        try:
            if needle in path.read_bytes():
                hits.append(str(path.relative_to(job_dir)))
        except OSError:
            hits.append(str(path.relative_to(job_dir)) + ":unreadable")
    return hits


def _provider_error_counts(job_dir: Path) -> dict[str, int]:
    patterns = {
        "usage_limit_reached": "usage_limit_reached",
        "auth_unavailable": "auth_unavailable",
        "http_402": "HTTP 402",
        "http_429": "HTTP 429",
        "http_503": "HTTP 503",
        "wholesale_rate_limit": "Wholesale rate limit exceeded",
        "provider_request_failed": "Provider request failed",
    }
    counts = {name: 0 for name in patterns}
    candidates = [job_dir / "job.log"]
    candidates.extend(job_dir.glob("*/trial.log"))
    candidates.extend(job_dir.glob("*/agent/morphz.stderr.log"))
    for path in candidates:
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for name, pattern in patterns.items():
            counts[name] += text.count(pattern)
    return counts


def audit_gate(
    job_dir: Path,
    *,
    expected_trials: int,
    credential: str,
    atif_validator: Callable[[Path], list[str]] | None = None,
) -> dict[str, Any]:
    atif_validator = atif_validator or validate_atif
    strict = _json(job_dir / "strict_result.json")
    run_identity = strict.get("run_identity") or {}
    expected_model = str(
        run_identity.get("provider_model")
        or run_identity.get("model")
        or "gpt-5.6-sol"
    )
    expected_harness = run_identity.get("harness") or {}
    trials: list[dict[str, Any]] = []
    context_ids: list[str] = []
    session_ids: list[str] = []
    db_paths: list[str] = []

    for strict_trial in strict.get("trials") or []:
        trial_name = str(strict_trial["trial"])
        trial_dir = job_dir / trial_name
        agent_dir = trial_dir / "agent"
        trajectory_path = agent_dir / "trajectory.json"
        integrity_path = trial_dir / "benchmark_integrity.json"
        db_path = agent_dir / "morphz.db"
        instruction_path = agent_dir / "instruction.md"
        trajectory = _json(trajectory_path)
        integrity = _json(integrity_path)
        instruction = instruction_path.read_text(encoding="utf-8")

        context_id = str(
            trajectory.get("extra", {}).get("context_id")
            or trajectory.get("agent", {}).get("extra", {}).get("context_id")
            or ""
        )
        session_id = str(trajectory.get("session_id") or "")
        event_contexts, event_sessions = _event_identity(db_path)
        model_errors: list[str] = []
        unmatched_observations = 0
        for step in trajectory.get("steps") or []:
            if not isinstance(step, dict):
                continue
            if "unmatched tool observation" in str(step.get("message") or ""):
                unmatched_observations += 1
            if step.get("source") != "agent" or not step.get("llm_call_count"):
                continue
            if step.get("model_name") != expected_model:
                model_errors.append(f"model:{step.get('model_name')}")
            if step.get("reasoning_effort") != "max":
                model_errors.append(f"reasoning:{step.get('reasoning_effort')}")

        errors: list[str] = []
        errors.extend(atif_validator(trajectory_path))
        if instruction.count(POLICY_MARKER) != 1:
            errors.append("integrity_policy_marker_count")
        if integrity.get("policy_version") != POLICY_VERSION:
            errors.append("integrity_policy_version")
        if integrity.get("disqualified") or integrity.get("finding_count"):
            errors.append("integrity_finding")
        if integrity.get("trajectory_sha256") != _sha256(trajectory_path):
            errors.append("trajectory_digest_mismatch")
        if trajectory.get("agent", {}).get("extra", {}).get("permission_mode") != "full_access":
            errors.append("permission_mode")
        if not context_id or event_contexts != {context_id}:
            errors.append("context_identity")
        if not session_id or event_sessions != {session_id}:
            errors.append("session_identity")
        if unmatched_observations:
            errors.append("unmatched_tool_observation")
        errors.extend(model_errors)
        harness = trajectory.get("agent", {}).get("extra", {}).get("harness") or {}
        if expected_harness:
            for actual_key, expected_key in (
                ("id", "id"),
                ("version", "version"),
                ("artifact_hash", "artifact_hash"),
            ):
                if harness.get(actual_key) != expected_harness.get(expected_key):
                    errors.append(f"harness_{actual_key}")
            if harness.get("binding_count", 0) < 1:
                errors.append("harness_binding_missing")
            if harness.get("package_identity_count") != 1:
                errors.append("harness_package_identity_count")
        elif harness:
            errors.append("unexpected_harness_binding")

        context_ids.append(context_id)
        session_ids.append(session_id)
        db_paths.append(str(db_path.resolve()))
        trials.append(
            {
                "trial": trial_name,
                "task_name": strict_trial.get("task_name"),
                "raw_reward": strict_trial.get("raw_reward"),
                "strict_reward": strict_trial.get("strict_reward"),
                "context_id": context_id,
                "session_id": session_id,
                "database_sha256": _sha256(db_path),
                "trajectory_sha256": _sha256(trajectory_path),
                "unmatched_tool_observations": unmatched_observations,
                "harness": harness,
                "errors": errors,
                "passed": not errors,
            }
        )

    provider_errors = _provider_error_counts(job_dir)
    secret_hits = _secret_hits(job_dir, credential) if credential else ["scan-not-run"]
    isolation = {
        "unique_contexts": len(set(context_ids)) == len(context_ids) == expected_trials,
        "unique_sessions": len(set(session_ids)) == len(session_ids) == expected_trials,
        "unique_databases": len(set(db_paths)) == len(db_paths) == expected_trials,
    }
    checks = {
        "strict_integrity_gate": strict.get("integrity_gate_passed") is True,
        "trial_count": len(trials) == expected_trials,
        "all_trial_gates": all(trial["passed"] for trial in trials),
        "isolation": all(isolation.values()),
        "provider_clean": not any(provider_errors.values()),
        "credential_scan_complete": bool(credential),
        "credential_not_persisted": not secret_hits,
    }
    required_checks = [
        "strict_integrity_gate",
        "trial_count",
        "all_trial_gates",
        "isolation",
        "credential_scan_complete",
        "credential_not_persisted",
    ]
    return {
        "gate_version": "terminal-bench-public-run-gate-v2",
        "integrity_policy_version": POLICY_VERSION,
        "job_dir": str(job_dir.resolve()),
        "expected_trials": expected_trials,
        "run_identity": run_identity,
        "checks": checks,
        "required_checks": required_checks,
        "isolation": isolation,
        "provider_errors": provider_errors,
        "credential_hit_paths": secret_hits,
        "trials": trials,
        "gate_passed": all(checks[name] for name in required_checks),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("job_dir", type=Path)
    parser.add_argument("--expected-trials", type=int, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    output = args.output or args.job_dir / "public_run_gate.json"
    audit = audit_gate(
        args.job_dir,
        expected_trials=args.expected_trials,
        credential=os.environ.get("MORPHZ_PROVIDER_API_KEY", ""),
    )
    output.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n")
    print("public_run_gate=" + str(audit["gate_passed"]).lower())
    print("public_run_gate_result=" + str(output.resolve()))
    return 0 if audit["gate_passed"] else 4


if __name__ == "__main__":
    raise SystemExit(main())
