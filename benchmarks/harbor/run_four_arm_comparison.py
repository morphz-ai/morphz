#!/usr/bin/env python3
"""Run the frozen four-arm, previously observed Terminal-Bench comparison."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from benchmarks.harbor.run_benchmark import LOCK_PATH, REPO_ROOT
from benchmarks.harbor.summarize_four_arm_comparison import summarize


DEFAULT_TASK_SET = Path(__file__).with_name("first_40_tasks_v1.json")
DEFAULT_SMOKE_TASK = "caffe-cifar-10"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_task_set(path: Path) -> tuple[dict[str, Any], list[str]]:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    cohorts = manifest.get("cohorts")
    if not isinstance(cohorts, dict):
        raise RuntimeError("task set has no cohorts")
    tasks: list[str] = []
    for name in ("prior_first_20", "prior_second_20"):
        cohort = cohorts.get(name)
        if not isinstance(cohort, list) or len(cohort) != 20:
            raise RuntimeError(f"task set cohort {name} must contain 20 tasks")
        tasks.extend(str(task) for task in cohort)
    if len(tasks) != 40 or len(set(tasks)) != 40:
        raise RuntimeError("task set must contain exactly 40 unique tasks")
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    if manifest.get("registry_ref") != lock["terminal_bench"]["registry_ref"]:
        raise RuntimeError("task set registry_ref does not match toolchain lock")
    return manifest, tasks


def require_harness_gates() -> dict[str, Any]:
    raise RuntimeError(
        "terminal-task@0.5.0 was retired and deleted; the historical "
        "four-arm launcher is intentionally disabled"
    )


def _common_task_args(tasks: list[str], concurrency: int) -> list[str]:
    args = ["--attempts", "1", "--concurrency", str(concurrency)]
    for task in tasks:
        args.extend(["--task", task])
    args.extend(["--expect-trials", str(len(tasks))])
    return args


def arm_commands(
    *,
    tasks: list[str],
    jobs_root: Path,
    concurrency: int,
) -> dict[str, list[str]]:
    del tasks, jobs_root, concurrency
    raise RuntimeError(
        "terminal-task@0.5.0 was retired and deleted; the historical "
        "four-arm launcher is intentionally disabled"
    )


def _git_commit() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def run_phase(
    *,
    phase: str,
    tasks: list[str],
    output_root: Path,
    task_set_path: Path,
    concurrency: int,
    harness_gates: dict[str, Any],
) -> dict[str, Any]:
    phase_root = output_root / phase
    phase_root.mkdir(parents=True, exist_ok=False)
    commands = arm_commands(
        tasks=tasks,
        jobs_root=phase_root / "jobs",
        concurrency=concurrency,
    )
    started_at = datetime.now(UTC).isoformat()
    manifest = {
        "protocol": "terminal-bench-four-arm-prior-40-v1",
        "phase": phase,
        "started_at": started_at,
        "infrastructure_git_commit": _git_commit(),
        "task_set": str(task_set_path.resolve()),
        "task_set_sha256": sha256_file(task_set_path),
        "tasks": tasks,
        "attempts_per_task": 1,
        "concurrency_per_arm": concurrency,
        "maximum_simultaneous_trials": concurrency * len(commands),
        "harness_gates": harness_gates,
        "commands": commands,
    }
    (phase_root / "launcher_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    processes: dict[str, tuple[subprocess.Popen[str], Any, Any]] = {}
    for arm, command in commands.items():
        arm_log_dir = phase_root / "launcher-logs"
        arm_log_dir.mkdir(exist_ok=True)
        stdout = (arm_log_dir / f"{arm}.stdout.log").open("w", encoding="utf-8")
        stderr = (arm_log_dir / f"{arm}.stderr.log").open("w", encoding="utf-8")
        process = subprocess.Popen(
            command,
            cwd=REPO_ROOT,
            env=os.environ.copy(),
            text=True,
            stdout=stdout,
            stderr=stderr,
        )
        processes[arm] = (process, stdout, stderr)

    return_codes: dict[str, int] = {}
    for arm, (process, stdout, stderr) in processes.items():
        return_codes[arm] = process.wait()
        stdout.close()
        stderr.close()

    result = {
        "protocol": manifest["protocol"],
        "phase": phase,
        "started_at": started_at,
        "completed_at": datetime.now(UTC).isoformat(),
        "return_codes": return_codes,
        "gate_passed": all(code == 0 for code in return_codes.values()),
    }
    (phase_root / "launcher_result.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    if result["gate_passed"]:
        summary = summarize(phase_root)
        (phase_root / "four_arm_summary.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("plan", "smoke", "full", "overnight"))
    parser.add_argument("--task-set", type=Path, default=DEFAULT_TASK_SET)
    parser.add_argument(
        "--output-root",
        type=Path,
        default=REPO_ROOT / "four-arm-comparison-runs",
    )
    parser.add_argument("--concurrency-per-arm", type=int, default=1)
    parser.add_argument("--smoke-task", default=DEFAULT_SMOKE_TASK)
    args = parser.parse_args()
    if args.concurrency_per_arm <= 0:
        parser.error("--concurrency-per-arm must be positive")
    if args.concurrency_per_arm * 4 > 5:
        parser.error("total concurrency may not exceed the proven five-container node limit")

    task_set, tasks = load_task_set(args.task_set)
    if args.smoke_task not in tasks:
        parser.error("--smoke-task must be part of the frozen 40-task set")
    harness_gates = require_harness_gates()
    if args.mode == "plan":
        print(
            json.dumps(
                {
                    "task_set": task_set,
                    "harness_gates": harness_gates,
                    "commands": arm_commands(
                        tasks=tasks,
                        jobs_root=args.output_root / "full" / "jobs",
                        concurrency=args.concurrency_per_arm,
                    ),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    args.output_root.mkdir(parents=True, exist_ok=False)
    if args.mode in {"smoke", "overnight"}:
        smoke = run_phase(
            phase="smoke",
            tasks=[args.smoke_task],
            output_root=args.output_root,
            task_set_path=args.task_set,
            concurrency=1,
            harness_gates=harness_gates,
        )
        if not smoke["gate_passed"]:
            return 3
        if args.mode == "smoke":
            return 0
    if args.mode in {"full", "overnight"}:
        full = run_phase(
            phase="full",
            tasks=tasks,
            output_root=args.output_root,
            task_set_path=args.task_set,
            concurrency=args.concurrency_per_arm,
            harness_gates=harness_gates,
        )
        return 0 if full["gate_passed"] else 3
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"four-arm comparison launcher failed: {error}", file=sys.stderr)
        raise SystemExit(2) from error
