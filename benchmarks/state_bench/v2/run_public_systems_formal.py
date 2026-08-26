"""Run the frozen ME-07 public-Agent-system confirmatory batch.

The queue is paired by ``(domain, task_id, run_idx)``.  The three arms may run
in parallel inside a cell, but every arm has at most one active trial.  Each
terminal outcome is written atomically before the next cell starts, so a
process restart can resume missing jobs without silently retrying scored
failures.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import random
import subprocess
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
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
    bind_trial_runtime,
)
from benchmarks.state_bench.v2.updated_evaluator import ME07UpdatedEvaluatorClient

PROTOCOL_ID = "ME-07-STATE-Bench-public-agent-systems-v2"
DOMAINS = ("travel", "customer_support", "shopping_assistant")
ARMS = {
    "morphz": MorphzPublicRuntimeAgent,
    "letta": LettaPublicRuntimeAgent,
    "mem0": Mem0PublicReferenceAgent,
}
QUEUE_SEED = 20_260_826
EXPECTED_STATE_BENCH_COMMIT = "5644b1838d96bc4483da29642d058ecaa6f80f7f"
EXPECTED_MORPHZ_BINARY_SHA256_BY_PLATFORM = {
    ("Darwin", "arm64"): (
        "0666fd3c0e49b2365d923d9589229ed6e37d6d47bbabc6bfcf0e0a45d53fa31a"
    ),
    ("Linux", "x86_64"): (
        "7b0c63cd685f4b4420f362bea1f986fa4546ad27482802aec5af3c9cbdbb356e"
    ),
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


def _atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def _queue(protocol: Any, num_runs: int) -> list[dict[str, Any]]:
    queue: list[dict[str, Any]] = []
    cell_index = 0
    for run_idx in range(1, num_runs + 1):
        run_cells: list[dict[str, Any]] = []
        for domain in DOMAINS:
            task_ids = load_split_task_ids(domain, "test", protocol.split_version)
            if len(task_ids) != 50:
                raise RuntimeError(
                    f"expected 50 frozen held-out tasks for {domain}, got {len(task_ids)}"
                )
            for task_id in task_ids:
                run_cells.append(
                    {
                        "domain": domain,
                        "task_id": task_id,
                        "run_idx": run_idx,
                    }
                )
        random.Random(f"{QUEUE_SEED}:{run_idx}").shuffle(run_cells)
        for value in run_cells:
            cell_index += 1
            value["cell_index"] = cell_index
            value["cell_id"] = (
                f"cell-{cell_index:04d}-r{run_idx}-{value['domain']}-{value['task_id']}"
            )
            arm_order = list(ARMS)
            random.Random(f"{QUEUE_SEED}:{value['cell_id']}").shuffle(arm_order)
            value["arm_order"] = arm_order
            queue.append(value)
    return queue


def _trajectory_summary(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
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


def _run_job(
    *,
    output: Path,
    cell: dict[str, Any],
    arm: str,
    protocol: Any,
) -> dict[str, Any]:
    domain_name = str(cell["domain"])
    task_id = str(cell["task_id"])
    run_idx = int(cell["run_idx"])
    cell_id = str(cell["cell_id"])
    task_file = domain_tasks_dir(domain_name) / f"{task_id}.json"
    task_file.resolve(strict=True)
    trajectory_dir = output / "trajectories" / arm / domain_name / f"run{run_idx}"
    trajectory_dir.mkdir(parents=True, exist_ok=True)
    trajectory_path = trajectory_dir / f"{task_id}.json"
    job_path = output / "jobs" / cell_id / f"{arm}.json"
    if job_path.exists():
        raise FileExistsError(
            f"refusing to overwrite non-resumed ME-07 job artifacts: {job_path}"
        )
    if trajectory_path.exists():
        # The upstream harness writes the trajectory before this runner can
        # atomically write its evaluator/model-binding receipt.  A process
        # interruption in that narrow window leaves an orphan whose full
        # integrity cannot be proven.  Preserve it, count it as a terminal
        # failure, and never silently rerun the scored task.
        orphan = {
            "protocol_id": PROTOCOL_ID,
            "terminal": True,
            "reportable_score": True,
            "cell_id": cell_id,
            "cell_index": int(cell["cell_index"]),
            "arm": arm,
            "domain": domain_name,
            "task_id": task_id,
            "run_idx": run_idx,
            "task_file_sha256": _sha256(task_file),
            "runner_result": {
                "task_id": task_id,
                "status": "ERR",
                "attempts": 1,
                "error": "orphaned trajectory after interrupted formal runner",
            },
            "trajectory": _trajectory_summary(trajectory_path),
            "updated_evaluator_receipts": {
                "user_simulator": [],
                "judge": [],
            },
            "integrity": {
                "checks": {"atomic_job_receipt_present": False},
                "passed": False,
                "successful_scoring_required": True,
            },
            "official_score_eligible": False,
            "unhandled_error_type": "InterruptedBeforeAtomicJobReceipt",
            "elapsed_seconds": 0.0,
        }
        _atomic_json(job_path, orphan)
        return orphan

    domain = get_domain_config(domain_name)
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
    started = time.monotonic()
    try:
        with bind_trial_runtime(
            output_dir=trajectory_dir,
            run_idx=run_idx,
            trial_id=f"{cell_id}-{arm}",
        ):
            runner_result = _run_single(
                task_file=task_file,
                client=ME07NoopClient(),
                simulator_client=simulator_client,
                output_dir=trajectory_dir,
                domain=domain,
                max_attempts=1,
                protocol=protocol,
                agent_model={"model_name": "gpt-5.6-sol", "reasoning_level": "max"},
                agent_class=ARMS[arm],
                retrieve_learnings_top_k=3,
                task_requirements_judge=task_judge,
                ux_judge=ux_judge,
                agent_reasoning_effort="max",
            )
        unhandled_error = None
    except Exception as error:  # noqa: BLE001 - preserve every terminal harness failure
        runner_result = {
            "task_id": task_id,
            "status": "ERR",
            "attempts": 1,
            "error": f"{type(error).__name__}: {error}"[:1000],
            "traceback": "".join(
                traceback.format_exception(type(error), error, error.__traceback__)
            )[-8000:],
        }
        unhandled_error = type(error).__name__
    finally:
        simulator_client.close()
        judge_client.close()

    trajectory = _trajectory_summary(trajectory_path)
    evaluator_receipts = [*simulator_client.receipts, *judge_client.receipts]
    successful_scoring = (
        runner_result.get("status") == "OK"
        and runner_result.get("scoring_status") == "OK"
    )
    integrity_checks = {
        "trajectory_present": trajectory is not None,
        "trajectory_task_matches": trajectory is not None
        and trajectory.get("task_id") == task_id,
        "trajectory_arm_matches": trajectory is not None
        and trajectory.get("agent_metadata_arm") == arm,
        "score_present": trajectory is not None
        and trajectory.get("task_completion_pass") in {0, 1}
        and trajectory.get("ux_score") is not None,
        "updated_evaluator_receipts_present": bool(simulator_client.receipts)
        and bool(judge_client.receipts),
        "all_evaluator_calls_exact_sol_max": bool(evaluator_receipts)
        and all(
            receipt.get("model") == "gpt-5.6-sol"
            and receipt.get("applied_reasoning_effort") == "max"
            and receipt.get("fallback") is False
            for receipt in evaluator_receipts
        ),
    }
    integrity_passed = all(integrity_checks.values()) if successful_scoring else False
    result = {
        "protocol_id": PROTOCOL_ID,
        "terminal": True,
        "reportable_score": True,
        "cell_id": cell_id,
        "cell_index": int(cell["cell_index"]),
        "arm": arm,
        "domain": domain_name,
        "task_id": task_id,
        "run_idx": run_idx,
        "task_file_sha256": _sha256(task_file),
        "runner_result": runner_result,
        "trajectory": trajectory,
        "updated_evaluator_receipts": {
            "user_simulator": simulator_client.receipts,
            "judge": judge_client.receipts,
        },
        "integrity": {
            "checks": integrity_checks,
            "passed": integrity_passed,
            "successful_scoring_required": True,
        },
        "official_score_eligible": successful_scoring and integrity_passed,
        "unhandled_error_type": unhandled_error,
        "elapsed_seconds": round(time.monotonic() - started, 3),
    }
    _atomic_json(job_path, result)
    return result


def _valid_terminal_job(path: Path, cell: dict[str, Any], arm: str) -> bool:
    if not path.is_file():
        return False
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return (
        value.get("protocol_id") == PROTOCOL_ID
        and value.get("terminal") is True
        and value.get("cell_id") == cell["cell_id"]
        and value.get("arm") == arm
    )


def _progress(output: Path, queue: list[dict[str, Any]]) -> dict[str, Any]:
    terminal = 0
    succeeded = 0
    scored = 0
    by_arm = {arm: {"terminal": 0, "succeeded": 0, "scored": 0} for arm in ARMS}
    for cell in queue:
        for arm in ARMS:
            path = output / "jobs" / str(cell["cell_id"]) / f"{arm}.json"
            if not _valid_terminal_job(path, cell, arm):
                continue
            terminal += 1
            by_arm[arm]["terminal"] += 1
            value = json.loads(path.read_text(encoding="utf-8"))
            if value.get("runner_result", {}).get("status") == "OK":
                succeeded += 1
                by_arm[arm]["succeeded"] += 1
            trajectory = value.get("trajectory")
            if (
                value.get("official_score_eligible") is True
                and isinstance(trajectory, dict)
                and trajectory.get("task_completion_pass") in {0, 1}
            ):
                scored += 1
                by_arm[arm]["scored"] += 1
    expected = len(queue) * len(ARMS)
    return {
        "protocol_id": PROTOCOL_ID,
        "expected_jobs": expected,
        "terminal_jobs": terminal,
        "successful_runner_jobs": succeeded,
        "scored_jobs": scored,
        "remaining_jobs": expected - terminal,
        "by_arm": by_arm,
        "complete": terminal == expected,
    }


def _missing_arms(output: Path, cell: dict[str, Any]) -> list[str]:
    return [
        arm
        for arm in cell["arm_order"]
        if not _valid_terminal_job(
            output / "jobs" / str(cell["cell_id"]) / f"{arm}.json",
            cell,
            arm,
        )
    ]


def _run_cell(
    *,
    output: Path,
    cell: dict[str, Any],
    protocol: Any,
    paired_workers: int,
) -> list[tuple[str, dict[str, Any]]]:
    missing = _missing_arms(output, cell)
    if not missing:
        return []
    with ThreadPoolExecutor(max_workers=paired_workers) as executor:
        futures = {
            executor.submit(
                _run_job,
                output=output,
                cell=cell,
                arm=arm,
                protocol=protocol,
            ): arm
            for arm in missing
        }
        return [(futures[future], future.result()) for future in as_completed(futures)]


def _run_cell_batch(
    *,
    output: Path,
    cells: list[dict[str, Any]],
    protocol: Any,
    cell_workers: int,
    paired_workers: int,
) -> list[tuple[dict[str, Any], list[tuple[str, dict[str, Any]]]]]:
    with ThreadPoolExecutor(max_workers=cell_workers) as executor:
        futures = {
            executor.submit(
                _run_cell,
                output=output,
                cell=cell,
                protocol=protocol,
                paired_workers=paired_workers,
            ): cell
            for cell in cells
        }
        return [(futures[future], future.result()) for future in as_completed(futures)]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-bench-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--morphz-binary", type=Path, required=True)
    parser.add_argument("--morphz-home", type=Path, required=True)
    parser.add_argument("--morphz-snapshot-dir", type=Path, required=True)
    parser.add_argument("--letta-snapshot-dir", type=Path, required=True)
    parser.add_argument("--mem0-snapshot-dir", type=Path, required=True)
    parser.add_argument("--letta-base-url", default="http://127.0.0.1:8283")
    parser.add_argument("--num-runs", type=int, default=1)
    parser.add_argument("--paired-workers", type=int, choices=(1, 3), default=3)
    parser.add_argument("--cell-workers", type=int, choices=(1, 2, 4), default=4)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--max-cells", type=int)
    args = parser.parse_args()

    if args.num_runs != 1:
        raise ValueError("amended ME-07 formal protocol requires exactly 1 run")
    if args.max_cells is not None and args.max_cells < 1:
        raise ValueError("--max-cells must be positive")
    state_bench_root = args.state_bench_root.resolve(strict=True)
    output = args.output.resolve()
    if args.resume:
        if not output.is_dir():
            raise FileNotFoundError(f"cannot resume missing ME-07 output: {output}")
    else:
        output.mkdir(parents=True, exist_ok=False)

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required from cloud_proxy_exec.py")
    state_bench_commit = _git_head(state_bench_root)
    if state_bench_commit != EXPECTED_STATE_BENCH_COMMIT:
        raise RuntimeError(
            "STATE-Bench commit mismatch: "
            f"{state_bench_commit} != {EXPECTED_STATE_BENCH_COMMIT}"
        )
    morphz_binary = args.morphz_binary.resolve(strict=True)
    morphz_binary_sha256 = _sha256(morphz_binary)
    platform_key = (platform.system(), platform.machine())
    expected_morphz_binary_sha256 = EXPECTED_MORPHZ_BINARY_SHA256_BY_PLATFORM.get(
        platform_key
    )
    if expected_morphz_binary_sha256 is None:
        raise RuntimeError(f"unsupported ME-07 formal platform: {platform_key!r}")
    if morphz_binary_sha256 != expected_morphz_binary_sha256:
        raise RuntimeError(
            "Morphz formal binary mismatch: "
            f"{morphz_binary_sha256} != {expected_morphz_binary_sha256} "
            f"for {platform_key!r}"
        )
    morphz_home = args.morphz_home.resolve(strict=True)
    morphz_snapshots = args.morphz_snapshot_dir.resolve(strict=True)
    letta_snapshots = args.letta_snapshot_dir.resolve(strict=True)
    mem0_snapshots = args.mem0_snapshot_dir.resolve(strict=True)
    for domain in DOMAINS:
        (morphz_snapshots / f"{domain}.sqlite").resolve(strict=True)
        (letta_snapshots / f"{domain}.af").resolve(strict=True)
        (mem0_snapshots / domain).resolve(strict=True)

    os.environ.update(
        {
            "MORPHZ_HOME": str(morphz_home),
            "MORPHZ_PROVIDER_API_KEY": api_key,
            "MORPHZ_ME07_BINARY": str(morphz_binary),
            "MORPHZ_ME07_PROFILE": "me07-state-bench",
            "MORPHZ_ME07_SNAPSHOT_DIR": str(morphz_snapshots),
            "MORPHZ_ME07_TASK_ROOT": str(output / "runtime" / "morphz"),
            "ME07_LETTA_BASE_URL": args.letta_base_url,
            "ME07_LETTA_SNAPSHOT_DIR": str(letta_snapshots),
            "ME07_LETTA_TASK_ROOT": str(output / "runtime" / "letta"),
            "ME07_MEM0_SNAPSHOT_DIR": str(mem0_snapshots),
            "ME07_MEM0_TASK_ROOT": str(output / "runtime" / "mem0"),
        }
    )
    os.environ.pop("MORPHZ_ENV_FILE", None)

    protocol = load_default_protocol()
    queue = _queue(protocol, args.num_runs)
    queue_path = output / "queue.json"
    queue_value = {
        "protocol_id": PROTOCOL_ID,
        "queue_seed": QUEUE_SEED,
        "num_runs": args.num_runs,
        "paired_workers": args.paired_workers,
        "cell_workers": args.cell_workers,
        "cells": queue,
    }
    if args.resume:
        existing_queue = json.loads(queue_path.read_text(encoding="utf-8"))
        if existing_queue != queue_value:
            raise RuntimeError("resume queue differs from frozen ME-07 queue")
    else:
        _atomic_json(queue_path, queue_value)
        manifest = {
            "protocol_id": PROTOCOL_ID,
            "kind": "formal_confirmatory_run",
            "reportable_score": True,
            "state_bench": {
                "root": str(state_bench_root),
                "commit": state_bench_commit,
            },
            "model": {
                "route": "gpt-5.6-sol",
                "physical_model": "gpt-5.6-sol",
                "reasoning_effort": "max",
                "provider": "cliproxyapi",
                "api": "responses",
                "fallback": False,
            },
            "runtime_binary": {
                "path": str(morphz_binary),
                "sha256": morphz_binary_sha256,
                "platform": {
                    "system": platform_key[0],
                    "machine": platform_key[1],
                },
            },
            "snapshots": {
                domain: {
                    "morphz": _sha256(morphz_snapshots / f"{domain}.sqlite"),
                    "letta": _sha256(letta_snapshots / f"{domain}.af"),
                    "mem0": _tree_digest(mem0_snapshots / domain),
                }
                for domain in DOMAINS
            },
            "num_runs": args.num_runs,
            "paired_workers": args.paired_workers,
            "cell_workers": args.cell_workers,
            "max_attempts": 1,
            "queue_sha256": _sha256(queue_path),
        }
        _atomic_json(output / "run_manifest.json", manifest)

    pending_cells = [cell for cell in queue if _missing_arms(output, cell)]
    if args.max_cells is not None:
        pending_cells = pending_cells[: args.max_cells]
    for offset in range(0, len(pending_cells), args.cell_workers):
        batch = pending_cells[offset : offset + args.cell_workers]
        for cell, results in _run_cell_batch(
            output=output,
            cells=batch,
            protocol=protocol,
            cell_workers=args.cell_workers,
            paired_workers=args.paired_workers,
        ):
            for arm, value in results:
                print(
                    json.dumps(
                        {
                            "cell": cell["cell_index"],
                            "arm": arm,
                            "status": value["runner_result"].get("status"),
                            "scoring_status": value["runner_result"].get(
                                "scoring_status"
                            ),
                        }
                    ),
                    flush=True,
                )
        _atomic_json(output / "progress.json", _progress(output, queue))

    progress = _progress(output, queue)
    _atomic_json(output / "progress.json", progress)
    if progress["complete"]:
        _atomic_json(output / "formal_run_complete.json", progress)
    print(json.dumps(progress, ensure_ascii=False), flush=True)
    return 0 if progress["complete"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
