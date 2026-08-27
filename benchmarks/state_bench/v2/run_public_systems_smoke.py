"""Run the ME-07 three-arm scored smoke on one identical held-out task."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any

from state_bench.domain import get_domain_config
from state_bench.paths import domain_tasks_dir
from state_bench.protocol import load_default_protocol, load_split_task_ids
from state_bench.scoring import TaskRequirementsJudge, UXQualityJudge
from state_bench.scripts.run_batch import _run_single

from benchmarks.state_bench.v2.public_agent_systems import (
    LettaPublicRuntimeAgent,
    ME07NoopClient,
    Mem0PublicReferenceAgent,
    MorphzPublicRuntimeAgent,
)
from benchmarks.state_bench.v2.updated_evaluator import ME07UpdatedEvaluatorClient

PROTOCOL_ID = "ME-07-STATE-Bench-public-agent-systems-v2"
ARMS = {
    "morphz": MorphzPublicRuntimeAgent,
    "letta": LettaPublicRuntimeAgent,
    "mem0": Mem0PublicReferenceAgent,
}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        digest.update(path.relative_to(root).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def _git_head(root: Path) -> str:
    return subprocess.check_output(
        ["git", "-C", str(root), "rev-parse", "HEAD"], text=True
    ).strip()


def _trajectory_summary(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    metadata = value.get("me07_agent_system") or {}
    return {
        "task_id": value.get("task_id"),
        "state_requirements_met": value.get("state_requirements_met"),
        "task_requirements_met": value.get("task_requirements_met"),
        "task_completion_pass": value.get("task_completion_pass"),
        "ux_score": value.get("ux_score"),
        "turns": value.get("turns"),
        "tool_calls": value.get("tool_calls"),
        "tool_errors": value.get("tool_errors"),
        "token_usage": value.get("token_usage"),
        "agent_metadata_arm": metadata.get("arm"),
        "trajectory_sha256": _sha256(path),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-bench-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--domain", default="travel")
    parser.add_argument("--task-id")
    parser.add_argument("--morphz-binary", type=Path, required=True)
    parser.add_argument("--morphz-home", type=Path, required=True)
    parser.add_argument("--morphz-snapshot", type=Path, required=True)
    parser.add_argument("--letta-snapshot-dir", type=Path, required=True)
    parser.add_argument("--mem0-snapshot-dir", type=Path, required=True)
    parser.add_argument("--letta-base-url", default="http://127.0.0.1:8283")
    args = parser.parse_args()

    if args.domain not in {"travel", "customer_support", "shopping_assistant"}:
        raise ValueError(f"unsupported STATE-Bench domain: {args.domain}")
    state_bench_root = args.state_bench_root.resolve(strict=True)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    morphz_binary = args.morphz_binary.resolve(strict=True)
    morphz_home = args.morphz_home.resolve(strict=True)
    morphz_snapshot = args.morphz_snapshot.resolve(strict=True)
    letta_snapshot_dir = args.letta_snapshot_dir.resolve(strict=True)
    mem0_snapshot_dir = args.mem0_snapshot_dir.resolve(strict=True)

    protocol = load_default_protocol()
    test_ids = load_split_task_ids(args.domain, "test", protocol.split_version)
    task_id = args.task_id or test_ids[0]
    if task_id not in test_ids:
        raise ValueError(f"smoke task is not in the frozen test split: {task_id}")
    task_file = domain_tasks_dir(args.domain) / f"{task_id}.json"
    task_file.resolve(strict=True)

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required from cloud_proxy_exec.py")
    os.environ.update(
        {
            "MORPHZ_HOME": str(morphz_home),
            "MORPHZ_PROVIDER_API_KEY": api_key,
            "MORPHZ_ME07_BINARY": str(morphz_binary),
            "MORPHZ_ME07_PROFILE": "me07-state-bench",
            "MORPHZ_ME07_LEARNING_DATABASE": str(morphz_snapshot),
            "MORPHZ_ME07_TASK_ROOT": str(output / "runtime" / "morphz"),
            "ME07_LETTA_BASE_URL": args.letta_base_url,
            "ME07_LETTA_SNAPSHOT_DIR": str(letta_snapshot_dir),
            "ME07_LETTA_TASK_ROOT": str(output / "runtime" / "letta"),
            "ME07_MEM0_SNAPSHOT_DIR": str(mem0_snapshot_dir),
            "ME07_MEM0_TASK_ROOT": str(output / "runtime" / "mem0"),
        }
    )
    os.environ.pop("MORPHZ_ENV_FILE", None)

    domain = get_domain_config(args.domain)
    simulator_client = ME07UpdatedEvaluatorClient(role="user_simulator")
    judge_client = ME07UpdatedEvaluatorClient(role="judge")
    task_judge = TaskRequirementsJudge(
        client=judge_client,
        prompts_dir=domain.prompts_dir,
        system_prompt=domain.judge_system_prompt,
        reasoning_effort="max",
    )
    ux_judge = UXQualityJudge(
        client=judge_client,
        prompts_dir=domain.prompts_dir,
        system_prompt=domain.judge_system_prompt,
        reasoning_effort="max",
    )
    noop_client = ME07NoopClient()
    started = time.monotonic()
    results: dict[str, Any] = {}
    try:
        for arm, agent_class in ARMS.items():
            run_dir = output / "arms" / arm / "run1"
            run_dir.mkdir(parents=True, exist_ok=False)
            result = _run_single(
                task_file=task_file,
                client=noop_client,
                simulator_client=simulator_client,
                output_dir=run_dir,
                domain=domain,
                max_attempts=1,
                protocol=protocol,
                agent_model={"model_name": "gpt-5.6-sol", "reasoning_level": "max"},
                agent_class=agent_class,
                retrieve_learnings_top_k=3,
                task_requirements_judge=task_judge,
                ux_judge=ux_judge,
                agent_reasoning_effort="max",
            )
            trajectory_path = run_dir / f"{task_id}.json"
            results[arm] = {
                "runner_result": result,
                "trajectory": (
                    _trajectory_summary(trajectory_path)
                    if trajectory_path.is_file()
                    else None
                ),
            }
    finally:
        simulator_client.close()
        judge_client.close()

    evaluator_receipts = {
        "protocol_id": PROTOCOL_ID,
        "user_simulator": simulator_client.receipts,
        "judge": judge_client.receipts,
    }
    (output / "updated_evaluator_receipts.json").write_text(
        json.dumps(evaluator_receipts, ensure_ascii=False, indent=2, sort_keys=True)
        + "\n",
        encoding="utf-8",
    )
    snapshots = {
        "morphz": {"path": str(morphz_snapshot), "sha256": _sha256(morphz_snapshot)},
        "letta": {
            "path": str(letta_snapshot_dir / f"{args.domain}.af"),
            "sha256": _sha256(letta_snapshot_dir / f"{args.domain}.af"),
        },
        "mem0": {
            "path": str(mem0_snapshot_dir / args.domain),
            "sha256": _tree_digest(mem0_snapshot_dir / args.domain),
        },
    }
    checks = {
        "three_arms_present": set(results) == set(ARMS),
        "all_runner_calls_succeeded": all(
            value["runner_result"].get("status") == "OK" for value in results.values()
        ),
        "all_scoring_succeeded": all(
            value["runner_result"].get("scoring_status") == "OK"
            for value in results.values()
        ),
        "all_trajectories_scored": all(
            value["trajectory"] is not None
            and value["trajectory"].get("task_completion_pass") in {0, 1}
            and value["trajectory"].get("ux_score") is not None
            for value in results.values()
        ),
        "all_arm_metadata_exact": all(
            value["trajectory"] is not None
            and value["trajectory"].get("agent_metadata_arm") == arm
            for arm, value in results.items()
        ),
        "updated_evaluator_was_used": bool(simulator_client.receipts)
        and bool(judge_client.receipts),
        "all_evaluator_calls_exact_sol_max": all(
            receipt.get("model") == "gpt-5.6-sol"
            and receipt.get("applied_reasoning_effort") == "max"
            and receipt.get("fallback") is False
            for receipt in [*simulator_client.receipts, *judge_client.receipts]
        ),
    }
    summary = {
        "protocol_id": PROTOCOL_ID,
        "kind": "three_arm_scored_smoke_not_formal_result",
        "reportable_score": False,
        "state_bench": {
            "root": str(state_bench_root),
            "commit": _git_head(state_bench_root),
            "task_id": task_id,
            "task_file_sha256": _sha256(task_file),
            "domain": args.domain,
            "split": "test",
        },
        "model": {
            "route": "gpt-5.6-sol",
            "physical_model": "gpt-5.6-sol",
            "reasoning_effort": "max",
            "provider": "cliproxyapi",
            "api": "responses",
            "fallback": False,
        },
        "snapshots": snapshots,
        "runtime_binary": {
            "path": str(morphz_binary),
            "sha256": _sha256(morphz_binary),
        },
        "results": results,
        "evaluator_call_counts": {
            "user_simulator": len(simulator_client.receipts),
            "judge": len(judge_client.receipts),
        },
        "elapsed_seconds": round(time.monotonic() - started, 3),
        "checks": checks,
        "passed": all(checks.values()),
    }
    (output / "smoke_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "summary": str(output / "smoke_summary.json"),
                "task_id": task_id,
                "results": {arm: value["trajectory"] for arm, value in results.items()},
                "passed": summary["passed"],
            },
            ensure_ascii=False,
        )
    )
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
