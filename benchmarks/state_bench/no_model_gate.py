#!/usr/bin/env python3
"""Fail-closed, no-model Gate for the frozen ME-07 STATE-Bench overlay."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
from typing import Any


HERE = Path(__file__).resolve().parent
OVERLAY_ROOT = HERE / "overlay"
LOCK_PATH = HERE / "protocol_lock.json"


def _git_commit(root: Path) -> str:
    completed = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
        capture_output=True,
        text=True,
        check=True,
    )
    return completed.stdout.strip()


def _tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(p for p in root.rglob("*") if p.is_file() and "__pycache__" not in p.parts):
        digest.update(path.relative_to(root).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def run_gate(state_bench_root: Path) -> dict[str, Any]:
    state_bench_root = state_bench_root.resolve()
    sys.path.insert(0, str(OVERLAY_ROOT))
    sys.path.insert(0, str(state_bench_root))

    from morphz_state_bench.backends import FixtureBackend
    from morphz_state_bench.client_types import GeneratedToolCall, GeneratedTurn
    from morphz_state_bench.protocol import (
        DOMAINS,
        RETRIEVE_TOP_K,
        canonicalize_trajectory,
        discover_train_trajectories,
        load_protocol_lock,
        sha256_file,
        validate_protocol_lock,
    )
    from state_bench.agents.base import AgentRuntimeContext
    from state_bench.agents.loader import load_root_agent_class, load_root_client_class
    from state_bench.orchestrator import _run_harness_executed_agent_turn

    lock = load_protocol_lock(LOCK_PATH)
    checks: dict[str, bool] = {}
    details: dict[str, Any] = {}

    lock_errors = validate_protocol_lock(lock)
    checks["protocol_lock_valid"] = not lock_errors
    details["protocol_lock_errors"] = lock_errors

    expected_commit = lock["upstreams"]["state_bench"]["commit"]
    actual_commit = _git_commit(state_bench_root)
    checks["state_bench_commit"] = actual_commit == expected_commit
    details["state_bench_commit"] = actual_commit

    train_root = state_bench_root / "datasets" / "train_task_trajectories"
    train_counts: dict[str, int] = {}
    train_digests: dict[str, str] = {}
    for domain in DOMAINS:
        paths = discover_train_trajectories(train_root, domain)
        train_counts[domain] = len(paths)
        digest = hashlib.sha256()
        for path in paths:
            digest.update(canonicalize_trajectory(path, domain).encode("utf-8"))
            digest.update(b"\n")
        train_digests[domain] = digest.hexdigest()
    checks["official_train_split_complete"] = all(count == 100 for count in train_counts.values())
    details["train_counts"] = train_counts
    details["canonical_train_digests"] = train_digests

    agent_class = load_root_agent_class("MorphzStrongMemoryAgent", root=OVERLAY_ROOT)
    client_class = load_root_client_class("CLIProxyResponsesClient", root=OVERLAY_ROOT)
    checks["extension_discovery"] = (
        agent_class.__name__ == "MorphzStrongMemoryAgent"
        and client_class.__name__ == "CLIProxyResponsesClient"
    )

    class FakeClient:
        def __init__(self):
            self.calls = 0

        def generate(self, **_kwargs):
            self.calls += 1
            if self.calls == 1:
                return GeneratedTurn(
                    text="",
                    tool_calls=[
                        GeneratedToolCall(
                            name="retrieve_learnings",
                            arguments={"query": "refund consent procedure", "top_k": 999},
                        )
                    ],
                    response_model="gpt-5.6-sol",
                )
            return GeneratedTurn(text="Finished after consulting prior procedure.", response_model="gpt-5.6-sol")

    backend = FixtureBackend(["one", "two", "three", "four"])
    runtime_context = AgentRuntimeContext(
        task_id="no-model-task",
        user_id="no-model-user",
        domain="travel",
        now="2026-08-26T00:00:00Z",
    )
    agent = agent_class(
        FakeClient(),
        "System prompt",
        [],
        {},
        runtime_context=runtime_context,
        retrieve_learnings_top_k=RETRIEVE_TOP_K,
        agent_reasoning_effort="max",
        backend=backend,
    )
    text, tool_calls = _run_harness_executed_agent_turn(
        agent=agent,
        system_prompt="System prompt",
        conversation_full=[{"role": "user", "content": "Please help with a refund."}],
        domain_tools=[],
        domain_tool_handlers={},
    )
    checks["memory_tool_round_trip"] = (
        text == "Finished after consulting prior procedure."
        and len(tool_calls) == 1
        and tool_calls[0]["name"] == "retrieve_learnings"
    )
    checks["fixed_top_k_enforced"] = backend.calls == [
        {"query": "refund consent procedure", "top_k": RETRIEVE_TOP_K}
    ] and tool_calls[0]["result"] == {"learnings": ["one", "two", "three"]}
    checks["formal_arm_set_excludes_no_memory"] = tuple(lock["formal_arms"]) == (
        "morphz",
        "amem",
        "mem0",
    )

    details["overlay_tree_sha256"] = _tree_digest(OVERLAY_ROOT)
    details["protocol_lock_sha256"] = sha256_file(LOCK_PATH)
    required_checks = sorted(checks)
    return {
        "gate": "ME-07-STATE-Bench-no-model-v1",
        "protocol_id": lock["protocol_id"],
        "checks": checks,
        "required_checks": required_checks,
        "details": details,
        "gate_passed": all(checks[name] for name in required_checks),
        "real_model_calls": 0,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-bench-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = run_gate(args.state_bench_root)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"gate_passed={str(result['gate_passed']).lower()}")
    print(f"result={args.output.resolve()}")
    return 0 if result["gate_passed"] else 4


if __name__ == "__main__":
    raise SystemExit(main())
