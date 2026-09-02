"""Run only the ContextDB ME-07 candidate against preserved Morphz history.

The legacy cognitive store already has one complete 150-task formal run.  This
runner does not spend tokens repeating it.  It preserves the frozen queue and
scoring protocol, runs only the new Morphz binary, and compares every outcome
with the historical Morphz job receipt.

Timeouts are correctness evidence, not a generic failure bucket.  Every
timeout-like result is joined to the task's durable Runtime database,
classified, and halts the run after the current batch.  A human must audit the
durable state before an explicit resume so a scheduler or provider defect
cannot consume the rest of the budget.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from state_bench.protocol import load_default_protocol

from benchmarks.state_bench.v2.run_public_systems_formal import (
    EXPECTED_STATE_BENCH_COMMIT,
    PROTOCOL_ID,
    _atomic_json,
    _git_head,
    _queue,
    _run_job,
    _sha256,
    _valid_terminal_job,
)

CANDIDATE_PROTOCOL_ID = "ME-07-ContextDB-against-preserved-Morphz-history-v1"


def _parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _is_timeout_like(job: dict[str, Any]) -> bool:
    result = job.get("runner_result")
    if not isinstance(result, dict):
        result = {}
    values = (
        job.get("unhandled_error_type"),
        result.get("error"),
        result.get("traceback"),
    )
    text = "\n".join(str(value) for value in values if value).lower()
    return any(marker in text for marker in ("timeout", "timed out", "deadline"))


def _classify_timeout(state: dict[str, Any]) -> str:
    if not state.get("available"):
        return "runtime_state_unavailable"
    if (
        int(state.get("replies", 0)) > 0
        or int(state.get("terminal_threads", 0)) > 0
        or int(state.get("thread_terminal_events", 0)) > 0
    ):
        return "durable_terminal_present"
    dependencies = state.get("pending_required_dependencies") or []
    if dependencies and all(
        dependency.get("source") == "provider_wait" for dependency in dependencies
    ):
        return "provider_wait_at_timeout"
    if dependencies:
        return "pending_scheduler_dependency"
    active = state.get("active_activations") or []
    if active:
        if all(item.get("lease_expired") is True for item in active):
            return "expired_active_activation"
        return "active_activation_at_timeout"
    if state.get("active_objectives"):
        return "active_objective_at_timeout"
    return "suspected_scheduler_convergence_gap"


def _timeout_halt_classifications(classifications: set[Any]) -> list[str]:
    """Require explicit audit before resuming after any timeout-like result."""

    return sorted(str(value) for value in classifications if value is not None)


def _result_audit_classification(job: dict[str, Any]) -> str | None:
    """Identify invalid formal results that must not be silently consumed."""

    result = job.get("runner_result")
    if not isinstance(result, dict):
        return "runner_result_missing"
    if result.get("status") != "OK":
        return "runner_error"
    if result.get("scoring_status") != "OK":
        return "evaluator_scoring_failure"
    if job.get("official_score_eligible") is not True:
        return "ineligible_formal_result"
    return None


def _runtime_directory(output: Path, cell: dict[str, Any]) -> Path | None:
    root = output / "runtime" / "morphz"
    if not root.is_dir():
        return None
    matches: list[Path] = []
    for manifest in root.glob("*/tool-manifest.json"):
        try:
            value = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if (
            value.get("domain") == cell["domain"]
            and value.get("task_id") == cell["task_id"]
        ):
            matches.append(manifest.parent)
    if len(matches) != 1:
        return None
    return matches[0]


def _runtime_state(output: Path, cell: dict[str, Any]) -> dict[str, Any]:
    runtime_dir = _runtime_directory(output, cell)
    unavailable = {
        "available": False,
        "reason": "runtime_directory_not_unique",
        "runtime_directory": str(runtime_dir) if runtime_dir else None,
    }
    if runtime_dir is None:
        return unavailable
    database = runtime_dir / "morphz.sqlite"
    if not database.is_file():
        return {**unavailable, "reason": "runtime_database_missing"}

    connection: sqlite3.Connection | None = None
    try:
        connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
        tables = {
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        required = {"events", "thread_activations", "sessions"}
        if not required.issubset(tables):
            return {**unavailable, "reason": "runtime_schema_unavailable"}

        sessions = connection.execute(
            "SELECT id FROM sessions WHERE title = ? ORDER BY created_at DESC",
            (f"STATE-Bench {cell['task_id']}",),
        ).fetchall()
        if len(sessions) != 1:
            return {
                **unavailable,
                "reason": "task_session_not_unique",
                "session_count": len(sessions),
            }
        session_id = str(sessions[0][0])
        # A chat/user_message event is the durable root of its own turn; child
        # events and Activations point back to its event id via root_turn_id.
        # Do not infer the current root from the newest child event.  If the
        # scheduler has not admitted the latest user message yet, that query
        # falls back to the previous turn and can falsely report the previous
        # reply as a durable terminal for the timed-out request.
        root_row = connection.execute(
            "SELECT id FROM events "
            "WHERE session_id = ? AND topic = 'chat/user_message' "
            "ORDER BY timestamp DESC, id DESC LIMIT 1",
            (session_id,),
        ).fetchone()
        if root_row is None:
            return {
                **unavailable,
                "reason": "task_user_message_missing",
                "session_id": session_id,
            }
        root_turn_id = str(root_row[0])

        scope = "session_id = ? AND root_turn_id = ?"
        scope_values: tuple[Any, ...] = (session_id, root_turn_id)
        replies = int(
            connection.execute(
                f"SELECT COUNT(*) FROM events WHERE {scope} AND topic = ?",
                (*scope_values, "chat/reply"),
            ).fetchone()[0]
        )
        terminal_threads = 0
        terminal_events = 0
        if "threads" in tables:
            terminal_threads = int(
                connection.execute(
                    "SELECT COUNT(*) FROM threads WHERE session_id = ? "
                    "AND root_turn_id = ? "
                    "AND status IN ('completed', 'failed', 'cancelled')",
                    (session_id, root_turn_id),
                ).fetchone()[0]
            )
            # runtime/thread_terminal is a supervisor event: its own
            # root_turn_id is intentionally NULL.  Resolve it through the
            # durable Thread named in the event payload instead of filtering
            # the event column directly.
            terminal_events = int(
                connection.execute(
                    "SELECT COUNT(*) FROM events AS event "
                    "JOIN threads AS thread "
                    "ON thread.id = json_extract(event.payload, '$.thread_id') "
                    "WHERE event.session_id = ? "
                    "AND event.topic = 'runtime/thread_terminal' "
                    "AND thread.session_id = ? AND thread.root_turn_id = ?",
                    (session_id, session_id, root_turn_id),
                ).fetchone()[0]
            )

        activation_query = (
            "SELECT id, status, lease_expires_at, updated_at, root_turn_id "
            "FROM thread_activations WHERE session_id = ? "
            "AND status IN ('queued', 'running')"
        )
        activation_values: tuple[Any, ...] = (session_id,)
        activation_query += " AND root_turn_id = ?"
        activation_values += (root_turn_id,)
        now = datetime.now(UTC)
        active_activations: list[dict[str, Any]] = []
        for (
            activation_id,
            status,
            lease,
            updated,
            activation_root,
        ) in connection.execute(activation_query, activation_values):
            lease_time = _parse_timestamp(lease)
            updated_time = _parse_timestamp(updated)
            active_activations.append(
                {
                    "id": str(activation_id),
                    "status": str(status),
                    "root_turn_id": activation_root,
                    "lease_expires_at": lease,
                    "lease_expired": lease_time is not None and lease_time <= now,
                    "updated_age_seconds": (
                        max(0.0, (now - updated_time).total_seconds())
                        if updated_time is not None
                        else None
                    ),
                }
            )

        active_objectives: list[dict[str, Any]] = []
        if "objectives" in tables:
            active_objectives = [
                {
                    "id": str(objective_id),
                    "status": str(status),
                    "active_evaluation_id": evaluation_id,
                    "updated_at": updated_at,
                }
                for objective_id, status, evaluation_id, updated_at in connection.execute(
                    "SELECT id, status, active_evaluation_id, updated_at FROM objectives "
                    "WHERE (coordinator_session_id = ? OR delivery_session_id = ?) "
                    "AND (status IN ('active', 'paused', 'blocked') "
                    "OR active_evaluation_id IS NOT NULL)",
                    (session_id, session_id),
                )
            ]

        owner_ids = {item["id"] for item in active_activations} | {
            item["id"] for item in active_objectives
        }
        pending_dependencies: list[dict[str, Any]] = []
        if "scheduler_dependencies" in tables:
            for (
                owner_kind,
                owner_id,
                kind,
                dependency_id,
                metadata_json,
            ) in connection.execute(
                "SELECT owner_kind, owner_id, dependency_kind, dependency_id, "
                "metadata_json "
                "FROM scheduler_dependencies WHERE status = 'pending' AND required = 1"
            ):
                try:
                    metadata = json.loads(metadata_json) if metadata_json else {}
                except (TypeError, json.JSONDecodeError):
                    metadata = {}
                belongs_to_session = metadata.get("session_id") == session_id
                if str(owner_id) in owner_ids or belongs_to_session:
                    pending_dependencies.append(
                        {
                            "owner_kind": str(owner_kind),
                            "owner_id": str(owner_id),
                            "kind": str(kind),
                            "id": str(dependency_id),
                            "source": metadata.get("source"),
                            "runtime_failure_kind": metadata.get(
                                "runtime_failure_kind"
                            ),
                            "runtime_failure_stage": metadata.get(
                                "runtime_failure_stage"
                            ),
                        }
                    )

        event_row = connection.execute(
            "SELECT topic, timestamp FROM events WHERE session_id = ? "
            "ORDER BY timestamp DESC LIMIT 1",
            (session_id,),
        ).fetchone()
        attempt_row = connection.execute(
            "SELECT timestamp, payload FROM events WHERE session_id = ? "
            "AND topic = 'runtime/model_attempt_state' "
            "ORDER BY timestamp DESC LIMIT 1",
            (session_id,),
        ).fetchone()
        attempt = None
        if attempt_row is not None:
            try:
                payload = json.loads(attempt_row[1])
            except (TypeError, json.JSONDecodeError):
                payload = {}
            attempt = {
                "timestamp": str(attempt_row[0]),
                "attempt_id": payload.get("attempt_id"),
                "state": payload.get("state"),
                "terminal": payload.get("terminal"),
                "detail": payload.get("detail"),
            }

        contextdb_rows = None
        if "experimental_contextdb_contexts" in tables:
            contextdb_rows = int(
                connection.execute(
                    "SELECT COUNT(*) FROM experimental_contextdb_contexts"
                ).fetchone()[0]
            )
        return {
            "available": True,
            "reason": None,
            "runtime_directory": str(runtime_dir),
            "database": str(database),
            "database_sha256": _sha256(database),
            "session_id": session_id,
            "root_turn_id": root_turn_id,
            "replies": replies,
            "terminal_threads": terminal_threads,
            "thread_terminal_events": terminal_events,
            "active_activations": active_activations,
            "active_objectives": active_objectives,
            "pending_required_dependencies": pending_dependencies,
            "last_event": (
                {"topic": str(event_row[0]), "timestamp": str(event_row[1])}
                if event_row is not None
                else None
            ),
            "last_model_attempt_state": attempt,
            "contextdb_authority_rows": contextdb_rows,
        }
    except sqlite3.Error as error:
        return {
            **unavailable,
            "reason": "runtime_state_read_failed",
            "error": str(error),
        }
    finally:
        if connection is not None:
            connection.close()


def _enrich_job(output: Path, cell: dict[str, Any]) -> dict[str, Any]:
    path = output / "jobs" / str(cell["cell_id"]) / "morphz.json"
    job = json.loads(path.read_text(encoding="utf-8"))
    state = _runtime_state(output, cell)
    timeout_like = _is_timeout_like(job)
    classification = _classify_timeout(state) if timeout_like else None
    result_audit_classification = _result_audit_classification(job)
    job["contextdb_candidate_diagnostics"] = {
        "timeout_like": timeout_like,
        "timeout_classification": classification,
        "result_audit_classification": result_audit_classification,
        "runtime_state": state,
    }
    _atomic_json(path, job)
    return job


def _load_baseline(output: Path, queue: list[dict[str, Any]]) -> dict[str, Any]:
    output = output.resolve(strict=True)
    baseline_queue = json.loads((output / "queue.json").read_text(encoding="utf-8"))
    if baseline_queue.get("cells") != queue:
        raise RuntimeError(
            "historical ME-07 queue differs from the frozen candidate queue"
        )
    jobs: dict[str, dict[str, Any]] = {}
    for cell in queue:
        path = output / "jobs" / str(cell["cell_id"]) / "morphz.json"
        if not _valid_terminal_job(path, cell, "morphz"):
            raise RuntimeError(f"historical Morphz job is incomplete: {path}")
        jobs[str(cell["cell_id"])] = json.loads(path.read_text(encoding="utf-8"))
    return {
        "output": str(output),
        "manifest_sha256": _sha256(output / "run_manifest.json"),
        "queue_sha256": _sha256(output / "queue.json"),
        "jobs": jobs,
    }


def _score(job: dict[str, Any]) -> dict[str, float]:
    trajectory = job.get("trajectory")
    if (
        not isinstance(trajectory, dict)
        or job.get("official_score_eligible") is not True
    ):
        return {"completion": 0.0, "state": 0.0, "task": 0.0, "ux": 0.0}
    return {
        "completion": float(trajectory.get("task_completion_pass") or 0),
        "state": float(trajectory.get("state_requirements_met") or 0),
        "task": float(trajectory.get("task_requirements_met") or 0),
        "ux": float(trajectory.get("ux_score") or 0),
    }


def _aggregate(jobs: list[dict[str, Any]], expected: int) -> dict[str, Any]:
    scores = [_score(job) for job in jobs]
    errors = Counter(
        str(job.get("runner_result", {}).get("error", "unknown")).split(":", 1)[0]
        for job in jobs
        if job.get("runner_result", {}).get("status") != "OK"
    )
    timeouts = Counter(
        str(
            job.get("contextdb_candidate_diagnostics", {}).get("timeout_classification")
        )
        for job in jobs
        if job.get("contextdb_candidate_diagnostics", {}).get("timeout_classification")
    )
    result_audit_failures = Counter(
        str(
            job.get("contextdb_candidate_diagnostics", {}).get(
                "result_audit_classification"
            )
        )
        for job in jobs
        if job.get("contextdb_candidate_diagnostics", {}).get(
            "result_audit_classification"
        )
    )
    denominator = expected or 1
    return {
        "terminal": len(jobs),
        "expected": expected,
        "runner_ok": sum(
            job.get("runner_result", {}).get("status") == "OK" for job in jobs
        ),
        "officially_scored": sum(
            job.get("official_score_eligible") is True for job in jobs
        ),
        "passed": int(sum(score["completion"] for score in scores)),
        "completion_rate": sum(score["completion"] for score in scores) / denominator,
        "state_rate": sum(score["state"] for score in scores) / denominator,
        "task_rate": sum(score["task"] for score in scores) / denominator,
        "ux_mean_all_tasks": sum(score["ux"] for score in scores) / denominator,
        "error_counts": dict(sorted(errors.items())),
        "timeout_classifications": dict(sorted(timeouts.items())),
        "result_audit_classifications": dict(sorted(result_audit_failures.items())),
    }


def _candidate_jobs(output: Path, queue: list[dict[str, Any]]) -> list[dict[str, Any]]:
    jobs: list[dict[str, Any]] = []
    for cell in queue:
        path = output / "jobs" / str(cell["cell_id"]) / "morphz.json"
        if _valid_terminal_job(path, cell, "morphz"):
            jobs.append(json.loads(path.read_text(encoding="utf-8")))
    return jobs


def _progress(
    output: Path,
    queue: list[dict[str, Any]],
    baseline: dict[str, Any],
) -> dict[str, Any]:
    candidate = _candidate_jobs(output, queue)
    terminal_ids = {str(job["cell_id"]) for job in candidate}
    historical = [baseline["jobs"][cell_id] for cell_id in terminal_ids]
    candidate_summary = _aggregate(candidate, len(queue))
    historical_same_tasks = _aggregate(historical, len(queue))
    return {
        "protocol_id": CANDIDATE_PROTOCOL_ID,
        "candidate": candidate_summary,
        "historical_same_tasks": historical_same_tasks,
        "remaining": len(queue) - len(candidate),
        "complete": len(candidate) == len(queue),
    }


def _comparison(
    output: Path,
    queue: list[dict[str, Any]],
    baseline: dict[str, Any],
) -> dict[str, Any]:
    candidate_by_id = {
        str(job["cell_id"]): job for job in _candidate_jobs(output, queue)
    }
    if len(candidate_by_id) != len(queue):
        raise RuntimeError("cannot compare an incomplete ContextDB ME-07 run")
    rows: list[dict[str, Any]] = []
    for cell in queue:
        cell_id = str(cell["cell_id"])
        candidate = candidate_by_id[cell_id]
        historical = baseline["jobs"][cell_id]
        rows.append(
            {
                "cell_id": cell_id,
                "domain": cell["domain"],
                "task_id": cell["task_id"],
                "historical": _score(historical),
                "contextdb": _score(candidate),
                "timeout_classification": candidate.get(
                    "contextdb_candidate_diagnostics", {}
                ).get("timeout_classification"),
                "result_audit_classification": candidate.get(
                    "contextdb_candidate_diagnostics", {}
                ).get("result_audit_classification"),
            }
        )
    candidate_jobs = list(candidate_by_id.values())
    historical_jobs = [baseline["jobs"][str(cell["cell_id"])] for cell in queue]
    candidate_summary = _aggregate(candidate_jobs, len(queue))
    historical_summary = _aggregate(historical_jobs, len(queue))
    return {
        "protocol_id": CANDIDATE_PROTOCOL_ID,
        "historical": historical_summary,
        "contextdb": candidate_summary,
        "completion_rate_delta": (
            candidate_summary["completion_rate"] - historical_summary["completion_rate"]
        ),
        "regression_gate_passed": (
            candidate_summary["passed"] >= historical_summary["passed"]
            and not candidate_summary["timeout_classifications"].get(
                "suspected_scheduler_convergence_gap"
            )
            and not candidate_summary["timeout_classifications"].get(
                "expired_active_activation"
            )
            and not candidate_summary["timeout_classifications"].get(
                "durable_terminal_present"
            )
            and not candidate_summary["result_audit_classifications"]
        ),
        "per_task": rows,
    }


def _run_batch(
    *,
    output: Path,
    cells: list[dict[str, Any]],
    protocol: Any,
    workers: int,
) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(
                _run_job,
                output=output,
                cell=cell,
                arm="morphz",
                protocol=protocol,
            ): cell
            for cell in cells
        }
        results = []
        for future in as_completed(futures):
            cell = futures[future]
            future.result()
            results.append((cell, _enrich_job(output, cell)))
        return results


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-bench-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--morphz-binary", type=Path, required=True)
    parser.add_argument("--morphz-home", type=Path, required=True)
    parser.add_argument("--morphz-snapshot-dir", type=Path, required=True)
    parser.add_argument("--historical-output", type=Path, required=True)
    parser.add_argument("--runtime-source-commit", required=True)
    parser.add_argument("--workers", type=int, choices=(1, 2, 4, 8), default=8)
    parser.add_argument("--reply-timeout-seconds", type=int, default=1800)
    parser.add_argument("--max-cells", type=int)
    parser.add_argument("--resume", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    if args.max_cells is not None and args.max_cells < 1:
        raise ValueError("--max-cells must be positive")
    if args.reply_timeout_seconds < 1:
        raise ValueError("--reply-timeout-seconds must be positive")

    state_bench_root = args.state_bench_root.resolve(strict=True)
    if _git_head(state_bench_root) != EXPECTED_STATE_BENCH_COMMIT:
        raise RuntimeError("STATE-Bench commit differs from the frozen ME-07 commit")
    binary = args.morphz_binary.resolve(strict=True)
    morphz_home = args.morphz_home.resolve(strict=True)
    snapshots = args.morphz_snapshot_dir.resolve(strict=True)
    for domain in ("travel", "customer_support", "shopping_assistant"):
        (snapshots / f"{domain}.sqlite").resolve(strict=True)
    if not os.environ.get("OPENAI_API_KEY"):
        raise RuntimeError(
            "OPENAI_API_KEY is required from the benchmark proxy wrapper"
        )

    protocol = load_default_protocol()
    queue = _queue(protocol, 1)
    baseline = _load_baseline(args.historical_output, queue)
    output = args.output.resolve()
    if args.resume:
        output.resolve(strict=True)
    else:
        output.mkdir(parents=True, exist_ok=False)

    queue_path = output / "queue.json"
    queue_value = {
        "protocol_id": CANDIDATE_PROTOCOL_ID,
        "source_protocol_id": PROTOCOL_ID,
        "workers": args.workers,
        "cells": queue,
    }
    if args.resume:
        if json.loads(queue_path.read_text(encoding="utf-8")) != queue_value:
            raise RuntimeError(
                "resume queue or worker count differs from the candidate run"
            )
        manifest = json.loads(
            (output / "run_manifest.json").read_text(encoding="utf-8")
        )
        if manifest["runtime"]["binary_sha256"] != _sha256(binary):
            raise RuntimeError(
                "resume binary differs from the initialized candidate run"
            )
    else:
        _atomic_json(queue_path, queue_value)
        _atomic_json(
            output / "run_manifest.json",
            {
                "protocol_id": CANDIDATE_PROTOCOL_ID,
                "source_protocol_id": PROTOCOL_ID,
                "runtime": {
                    "source_commit": args.runtime_source_commit,
                    "binary": str(binary),
                    "binary_sha256": _sha256(binary),
                    "compiled_features": ["experimental-context-db"],
                    "enabled_experiments": ["context-db"],
                },
                "runner": {
                    "source_commit": _git_head(Path(__file__).resolve().parents[3]),
                    "path": str(Path(__file__).resolve()),
                    "workers": args.workers,
                    "max_attempts": 1,
                    "reply_timeout_seconds": args.reply_timeout_seconds,
                    "automatic_restart": False,
                    "explicit_resume_only": True,
                    "transient_transport_retry": {
                        "http_statuses": [408, 429, 500, 502, 503, 504],
                        "transport_errors": True,
                        "max_attempts": 4,
                        "base_delay_seconds": 1.0,
                        "max_delay_seconds": 30.0,
                        "receipt_fields": [
                            "transport_attempts",
                            "transient_transport_failures",
                        ],
                    },
                },
                "state_bench": {
                    "root": str(state_bench_root),
                    "commit": EXPECTED_STATE_BENCH_COMMIT,
                },
                "model": {
                    "route": "gpt-5.6-sol",
                    "physical_model": "gpt-5.6-sol",
                    "reasoning_effort": "max",
                    "fallback": False,
                },
                "snapshots": {
                    domain: _sha256(snapshots / f"{domain}.sqlite")
                    for domain in (
                        "travel",
                        "customer_support",
                        "shopping_assistant",
                    )
                },
                "historical": {
                    key: value for key, value in baseline.items() if key != "jobs"
                },
                "queue_sha256": _sha256(queue_path),
            },
        )

    os.environ.update(
        {
            "MORPHZ_HOME": str(morphz_home),
            "MORPHZ_PROVIDER_API_KEY": os.environ["OPENAI_API_KEY"],
            "MORPHZ_ME07_BINARY": str(binary),
            "MORPHZ_ME07_PROFILE": "me07-state-bench",
            "MORPHZ_ME07_SNAPSHOT_DIR": str(snapshots),
            "MORPHZ_ME07_TASK_ROOT": str(output / "runtime" / "morphz"),
            "MORPHZ_ME07_REPLY_TIMEOUT_SECONDS": str(args.reply_timeout_seconds),
            "MORPHZ_EXPERIMENTAL_FEATURES": "context-db",
        }
    )
    os.environ.pop("MORPHZ_ENV_FILE", None)

    pending = [
        cell
        for cell in queue
        if not _valid_terminal_job(
            output / "jobs" / str(cell["cell_id"]) / "morphz.json",
            cell,
            "morphz",
        )
    ]
    if args.max_cells is not None:
        pending = pending[: args.max_cells]
    protocol = load_default_protocol()
    halted = False
    for offset in range(0, len(pending), args.workers):
        batch = pending[offset : offset + args.workers]
        results = _run_batch(
            output=output,
            cells=batch,
            protocol=protocol,
            workers=args.workers,
        )
        for cell, job in results:
            diagnostics = job["contextdb_candidate_diagnostics"]
            print(
                json.dumps(
                    {
                        "cell": cell["cell_index"],
                        "domain": cell["domain"],
                        "task": cell["task_id"],
                        "status": job.get("runner_result", {}).get("status"),
                        "pass": (job.get("trajectory") or {}).get(
                            "task_completion_pass"
                        ),
                        "timeout": diagnostics.get("timeout_classification"),
                        "audit": diagnostics.get("result_audit_classification"),
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        progress = _progress(output, queue, baseline)
        _atomic_json(output / "progress.json", progress)
        classifications = {
            job["contextdb_candidate_diagnostics"].get("timeout_classification")
            for _, job in results
        }
        timeout_classifications = _timeout_halt_classifications(classifications)
        result_audit_classifications = _timeout_halt_classifications(
            {
                job["contextdb_candidate_diagnostics"].get(
                    "result_audit_classification"
                )
                for _, job in results
            }
        )
        if timeout_classifications or result_audit_classifications:
            _atomic_json(
                output / "manual_audit_halt.json",
                {
                    "protocol_id": CANDIDATE_PROTOCOL_ID,
                    "halt_reason": "result_requires_manual_audit",
                    "timeout_classifications": timeout_classifications,
                    "result_audit_classifications": result_audit_classifications,
                    "progress": progress,
                },
            )
            halted = True
            break

    progress = _progress(output, queue, baseline)
    _atomic_json(output / "progress.json", progress)
    if progress["complete"]:
        comparison = _comparison(output, queue, baseline)
        _atomic_json(output / "comparison.json", comparison)
        _atomic_json(output / "run_complete.json", progress)
    print(json.dumps(progress, ensure_ascii=False), flush=True)
    if halted:
        return 3
    return 0 if progress["complete"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
