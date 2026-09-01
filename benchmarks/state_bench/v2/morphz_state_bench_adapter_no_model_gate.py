#!/usr/bin/env python3
"""Exercise the STATE-Bench -> production Morphz adapter without a model."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

from state_bench.agents.base import AgentRuntimeContext

from benchmarks.state_bench.v2.public_agent_systems import (
    ME07NoopClient,
    MorphzPublicRuntimeAgent,
)


@contextmanager
def _environment(values: dict[str, str]) -> Iterator[None]:
    previous = {name: os.environ.get(name) for name in values}
    os.environ.update(values)
    try:
        yield
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def _execution_jobs(database: Path) -> list[dict[str, object]]:
    with sqlite3.connect(database) as connection:
        rows = connection.execute(
            "SELECT tool_name, status, error FROM execution_jobs ORDER BY created_at, id"
        ).fetchall()
    return [
        {"tool_name": name, "status": status, "error": error}
        for name, status, error in rows
    ]


def run(
    binary: Path,
    output: Path,
    *,
    learning_database: Path | None = None,
    domain: str = "travel",
) -> dict[str, object]:
    output.mkdir(parents=True, exist_ok=False)
    learning = output / "learning.sqlite"
    if learning_database is None:
        learning.touch()
    else:
        shutil.copy2(learning_database.resolve(strict=True), learning)
    task_root = output / "tasks"
    calls: list[dict[str, object]] = []

    def gate_probe(arguments: dict[str, object]) -> dict[str, object]:
        calls.append(arguments)
        return {"status": "gate-ok"}

    runtime_context = AgentRuntimeContext(
        task_id="deterministic-adapter-gate",
        user_id="gate-user",
        domain=domain,
        now="2026-08-26T00:00:00Z",
        run_idx=1,
    )
    values = {
        "MORPHZ_ME07_BINARY": str(binary.resolve(strict=True)),
        "MORPHZ_ME07_TASK_ROOT": str(task_root),
        "MORPHZ_ME07_LEARNING_DATABASE": str(learning),
        "MORPHZ_ME07_PROFILE": "deterministic-gate",
        "MORPHZ_ME07_DETERMINISTIC_GATE": "1",
        "MORPHZ_ME07_REPLY_TIMEOUT_SECONDS": "60",
    }
    with _environment(values):
        agent = MorphzPublicRuntimeAgent(
            ME07NoopClient(),
            "Use gate_probe once.",
            [
                {
                    "type": "function",
                    "name": "gate_probe",
                    "description": "deterministic probe",
                    "parameters": {
                        "type": "object",
                        "properties": {},
                        "additionalProperties": False,
                    },
                }
            ],
            {"gate_probe": gate_probe},
            runtime_context=runtime_context,
        )
        text, tool_calls, raw_items = agent.act(
            [{"role": "user", "content": "Run the gate."}]
        )
        trajectory = SimpleNamespace(metadata={})
        agent.ingest_trajectory(trajectory)
        agent_output = Path(trajectory.metadata["me07_agent_system"]["runtime_output"])

    jobs = _execution_jobs(agent_output / "morphz.sqlite")
    initial_context_tx_commits = int(agent._ready["initial_context_tx_commits"])
    final_context_tx_commits = int(agent._last_turn["context_tx_commits"])
    checks = {
        "reply_completed": text == "me07-deterministic-gate-complete",
        "state_bench_handler_called_once": calls == [{}],
        "canonical_tool_call_returned": tool_calls
        == [{"name": "gate_probe", "arguments": {}, "result": {"status": "gate-ok"}}],
        "raw_assistant_message_returned": raw_items
        == [{"role": "assistant", "content": "me07-deterministic-gate-complete"}],
        "durable_execution_succeeded": any(
            job["tool_name"] == "gate_probe" and job["status"] == "succeeded"
            for job in jobs
        ),
        "context_tx_committed_once": final_context_tx_commits
        == initial_context_tx_commits + 1,
        "runtime_closed": agent._process.poll() == 0,  # gate-only lifecycle assertion
        "token_file_removed": not (agent_output / "bridge.token").exists(),
        "non_reportable_marked": trajectory.metadata["me07_agent_system"]["ready"].get(
            "deterministic_fake_not_reportable"
        )
        is True,
    }
    report = {
        "protocol_id": "ME-07-STATE-Bench-public-agent-systems-v2",
        "kind": "deterministic_fake_not_reportable",
        "passed": all(checks.values()),
        "checks": checks,
        "execution_jobs": jobs,
        "context_tx_commits": {
            "initial": initial_context_tx_commits,
            "final": final_context_tx_commits,
        },
        "domain": domain,
        "learning_database_source": (
            str(learning_database.resolve()) if learning_database is not None else None
        ),
        "runtime_output": str(agent_output),
    }
    (output / "state_bench_adapter_no_model_gate.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    if not report["passed"]:
        raise RuntimeError("ME-07 STATE-Bench Morphz adapter Gate failed")
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--learning-database", type=Path)
    parser.add_argument(
        "--domain",
        choices=("travel", "customer_support", "shopping_assistant"),
        default="travel",
    )
    args = parser.parse_args()
    print(
        json.dumps(
            run(
                args.binary,
                args.output,
                learning_database=args.learning_database,
                domain=args.domain,
            ),
            ensure_ascii=False,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
