from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

import pytest

from benchmarks.state_bench.v2.morphz_state_bench_adapter_no_model_gate import (
    _contextdb_advanced,
)
from benchmarks.state_bench.v2.public_agent_systems import (
    MorphzPublicRuntimeAgent,
)
from benchmarks.state_bench.v2.run_contextdb_me07_historical import (
    _classify_timeout,
    _is_timeout_like,
    _runtime_state,
)


def test_no_model_gate_requires_contextdb_not_legacy_projection_progress() -> None:
    before = {
        "contextdb": [["context-1", 2, "old-root"]],
        "legacy": [["context-1", 100, "legacy-root"]],
    }
    assert _contextdb_advanced(
        before,
        {
            "contextdb": [["context-1", 3, "new-root"]],
            "legacy": before["legacy"],
        },
    )
    assert not _contextdb_advanced(
        before,
        {
            "contextdb": before["contextdb"],
            "legacy": [["context-1", 101, "changed-legacy"]],
        },
    )


def _state(**values):
    return {
        "available": True,
        "replies": 0,
        "thread_terminal_events": 0,
        "active_activations": [],
        "active_objectives": [],
        "pending_required_dependencies": [],
        **values,
    }


def test_timeout_detection_reads_wrapped_runtime_errors() -> None:
    assert _is_timeout_like(
        {"runner_result": {"error": "RuntimeError: Agent timed out after 1800s"}}
    )
    assert not _is_timeout_like(
        {"runner_result": {"error": "HTTP 502 from model provider"}}
    )


def test_public_runtime_adapter_has_an_external_receipt_timeout() -> None:
    read_fd, write_fd = os.pipe()
    stream = os.fdopen(read_fd, "r", encoding="utf-8")

    class WaitingProcess:
        stdout = stream

        @staticmethod
        def poll() -> None:
            return None

    agent = object.__new__(MorphzPublicRuntimeAgent)
    agent._process = WaitingProcess()
    try:
        with pytest.raises(
            TimeoutError,
            match=r"timed out after 0\.05s before turn receipt; exit=None",
        ):
            agent._read_receipt("turn receipt", timeout_seconds=0.05)
    finally:
        os.close(write_fd)
        stream.close()


def test_timeout_classification_prioritizes_durable_terminal_and_dependencies() -> None:
    assert _classify_timeout(_state(replies=1)) == "durable_terminal_present"
    assert (
        _classify_timeout(
            _state(pending_required_dependencies=[{"kind": "model_attempt"}])
        )
        == "pending_scheduler_dependency"
    )


def test_timeout_classification_distinguishes_live_expired_and_idle_scheduler() -> None:
    assert (
        _classify_timeout(
            _state(active_activations=[{"id": "a", "lease_expired": False}])
        )
        == "active_activation_at_timeout"
    )
    assert (
        _classify_timeout(
            _state(active_activations=[{"id": "a", "lease_expired": True}])
        )
        == "expired_active_activation"
    )
    assert _classify_timeout(_state()) == "suspected_scheduler_convergence_gap"


def test_runtime_state_is_scoped_to_the_current_task_session(tmp_path: Path) -> None:
    runtime = tmp_path / "runtime" / "morphz" / "trial"
    runtime.mkdir(parents=True)
    (runtime / "tool-manifest.json").write_text(
        json.dumps({"domain": "travel", "task_id": "task-1"}), encoding="utf-8"
    )
    database = runtime / "morphz.sqlite"
    with sqlite3.connect(database) as connection:
        connection.executescript(
            """
            CREATE TABLE sessions (
                id TEXT, title TEXT, created_at TEXT
            );
            CREATE TABLE events (
                id TEXT, timestamp TEXT, topic TEXT, session_id TEXT,
                root_turn_id TEXT, payload TEXT
            );
            CREATE TABLE thread_activations (
                id TEXT, status TEXT, lease_expires_at TEXT, updated_at TEXT,
                root_turn_id TEXT, session_id TEXT
            );
            CREATE TABLE objectives (
                id TEXT, status TEXT, active_evaluation_id TEXT, updated_at TEXT,
                coordinator_session_id TEXT, delivery_session_id TEXT
            );
            CREATE TABLE scheduler_dependencies (
                owner_kind TEXT, owner_id TEXT, dependency_kind TEXT,
                dependency_id TEXT, status TEXT, required INTEGER,
                metadata_json TEXT
            );
            CREATE TABLE experimental_contextdb_contexts (context_id TEXT);
            INSERT INTO sessions VALUES ('current-session', 'STATE-Bench task-1', '2026-01-01T00:00:00Z');
            INSERT INTO sessions VALUES ('old-session', 'old', '2025-01-01T00:00:00Z');
            INSERT INTO events VALUES (
                'old-turn', '2025-12-31T23:59:58Z', 'chat/user_message',
                'current-session', NULL, '{}'
            );
            INSERT INTO events VALUES (
                'old-reply', '2025-12-31T23:59:59Z', 'chat/reply',
                'current-session', 'old-turn', '{}'
            );
            INSERT INTO events VALUES (
                'turn-1', '2026-01-01T00:00:00Z', 'chat/user_message',
                'current-session', NULL, '{}'
            );
            INSERT INTO events VALUES (
                'other-reply', '2025-01-01T00:00:00Z', 'chat/reply',
                'old-session', 'other-turn', '{}'
            );
            INSERT INTO thread_activations VALUES (
                'activation-1', 'running', '2000-01-01T00:00:00Z',
                '2000-01-01T00:00:00Z', 'turn-1', 'current-session'
            );
            INSERT INTO scheduler_dependencies VALUES (
                'activation', 'activation-1', 'model_attempt', 'attempt-1',
                'pending', 1, '{}'
            );
            INSERT INTO scheduler_dependencies VALUES (
                'thread', 'thread-1', 'resource', 'model-route:gpt-5.6-sol',
                'pending', 1,
                '{"session_id":"current-session","source":"provider_wait","runtime_failure_kind":"transient_network","runtime_failure_stage":"llm_completion"}'
            );
            INSERT INTO experimental_contextdb_contexts VALUES ('context-1');
            """
        )

    state = _runtime_state(
        tmp_path,
        {"domain": "travel", "task_id": "task-1"},
    )

    assert state["available"] is True
    assert state["session_id"] == "current-session"
    assert state["root_turn_id"] == "turn-1"
    assert state["replies"] == 0
    assert state["active_activations"][0]["lease_expired"] is True
    assert state["pending_required_dependencies"] == [
        {
            "owner_kind": "activation",
            "owner_id": "activation-1",
            "kind": "model_attempt",
            "id": "attempt-1",
            "source": None,
            "runtime_failure_kind": None,
            "runtime_failure_stage": None,
        },
        {
            "owner_kind": "thread",
            "owner_id": "thread-1",
            "kind": "resource",
            "id": "model-route:gpt-5.6-sol",
            "source": "provider_wait",
            "runtime_failure_kind": "transient_network",
            "runtime_failure_stage": "llm_completion",
        },
    ]
    assert state["contextdb_authority_rows"] == 1
