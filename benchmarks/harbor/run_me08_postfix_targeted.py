#!/usr/bin/env python3
"""Run the frozen ME-08 post-fix Morphz-only targeted verification."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PROTOCOL = "me08-terminal-bench-postfix-targeted-v1"
MANIFEST_PATH = Path(__file__).with_name("me08_postfix_targeted_tasks_v1.json")
LOCK_PATH = Path(__file__).with_name("toolchain.lock.json")
REPO_ROOT = Path(__file__).resolve().parents[2]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def unique(values: list[str]) -> list[str]:
    return list(dict.fromkeys(values))


def load_selection(mode: str) -> tuple[dict[str, Any], list[str]]:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    if manifest.get("protocol") != PROTOCOL:
        raise RuntimeError("post-fix manifest protocol mismatch")
    failures = unique(
        [
            str(task)
            for cohort in manifest["prior_failures"].values()
            for task in cohort
        ]
    )
    sentinels = unique([str(task) for task in manifest["regression_sentinels"]])
    smoke = unique([str(task) for task in manifest["smoke_tasks"]])
    if len(failures) != 19:
        raise RuntimeError(f"expected 19 unique prior failures, got {len(failures)}")
    if len(sentinels) != 5 or set(failures) & set(sentinels):
        raise RuntimeError("regression sentinels must be five unique prior-pass tasks")
    if len(smoke) != 2 or not set(smoke) <= set(failures):
        raise RuntimeError("smoke must contain the two confirmed repaired failures")
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    runtime = lock["runtime"]
    if runtime["git_commit"] != manifest["postfix_runtime_commit"]:
        raise RuntimeError("toolchain lock is not pinned to the post-fix Runtime")
    if lock["terminal_bench"]["dataset"] != manifest["dataset"]:
        raise RuntimeError("Terminal-Bench dataset lock mismatch")
    if lock["model"]["physical_model"] != manifest["model"]:
        raise RuntimeError("model lock mismatch")
    return manifest, smoke if mode == "smoke" else failures + sentinels


def git_commit() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def host_sample() -> dict[str, Any]:
    meminfo: dict[str, int] = {}
    for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
        key, value = line.split(":", 1)
        meminfo[key] = int(value.strip().split()[0])
    load1, load5, load15 = os.getloadavg()
    docker = subprocess.run(
        ["docker", "ps", "-q"], capture_output=True, text=True, check=False
    )
    return {
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "load_1m": load1,
        "load_5m": load5,
        "load_15m": load15,
        "cpu_count": os.cpu_count(),
        "memory_total_kib": meminfo.get("MemTotal"),
        "memory_available_kib": meminfo.get("MemAvailable"),
        "docker_running_containers": (
            len([line for line in docker.stdout.splitlines() if line])
            if docker.returncode == 0
            else None
        ),
    }


def sample_resources(path: Path, stop: threading.Event) -> None:
    with path.open("a", encoding="utf-8") as target:
        while not stop.is_set():
            try:
                target.write(json.dumps(host_sample(), sort_keys=True) + "\n")
                target.flush()
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                target.write(json.dumps({"sample_error": str(error)}) + "\n")
                target.flush()
            stop.wait(30.0)


def latest_job(jobs_root: Path) -> Path:
    jobs = sorted(path for path in jobs_root.iterdir() if path.is_dir())
    if len(jobs) != 1:
        raise RuntimeError(f"expected one Harbor job in {jobs_root}, got {len(jobs)}")
    return jobs[0]


def load_results(job: Path, expected_tasks: list[str]) -> tuple[dict[str, float], dict[str, Any]]:
    strict_path = job / "strict_result.json"
    if not strict_path.is_file():
        raise RuntimeError(f"missing {strict_path}")
    payload = json.loads(strict_path.read_text(encoding="utf-8"))
    trials = payload.get("trials") or []
    if payload.get("audit_complete") is not True or len(trials) != len(expected_tasks):
        raise RuntimeError("strict result is incomplete")
    rewards = {
        str(row["task_name"]).split("/", 1)[-1]: float(row["raw_reward"])
        for row in trials
    }
    if set(rewards) != set(expected_tasks):
        raise RuntimeError("scored task IDs do not match the frozen selection")
    return rewards, payload


def benchmark_command(tasks: list[str], output_root: Path) -> list[str]:
    command = [
        sys.executable,
        "-m",
        "benchmarks.harbor.run_benchmark",
        "full",
        "--jobs-dir",
        str(output_root / "jobs"),
        "--harness-mode",
        "none",
        "--attempts",
        "1",
        "--concurrency",
        "1",
    ]
    for task in tasks:
        command.extend(["--task", task])
    command.extend(["--expect-trials", str(len(tasks))])
    return command


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("validate", "smoke", "targeted"))
    parser.add_argument("--output-root", type=Path)
    args = parser.parse_args()
    selection_mode = "smoke" if args.mode == "smoke" else "targeted"
    manifest, tasks = load_selection(selection_mode)
    if args.mode == "validate":
        print(
            json.dumps(
                {
                    "protocol": PROTOCOL,
                    "validated": True,
                    "postfix_runtime_commit": manifest["postfix_runtime_commit"],
                    "prior_failure_count": 19,
                    "regression_sentinel_count": 5,
                    "smoke_count": 2,
                    "manifest_sha256": sha256_file(MANIFEST_PATH),
                },
                indent=2,
            )
        )
        return 0
    if args.output_root is None:
        parser.error("smoke and targeted modes require --output-root")
    output_root = args.output_root.resolve()
    output_root.mkdir(parents=True, exist_ok=False)
    # Harbor accepts a jobs directory path but does not create its parent when
    # launcher discovery fails before the first job starts.  Materialize the
    # frozen artifact boundary here so both the runner and the post-run audit
    # can distinguish a pre-model launcher failure from an empty benchmark.
    (output_root / "jobs").mkdir()
    command = benchmark_command(tasks, output_root)
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    run_manifest = {
        "protocol": PROTOCOL,
        "phase": args.mode,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "infrastructure_git_commit": git_commit(),
        "runtime_git_commit": manifest["postfix_runtime_commit"],
        "runtime_binary_sha256": lock["runtime"]["binary_sha256"],
        "watcher_sha256": lock["runtime"]["watcher_sha256"],
        "task_manifest_sha256": sha256_file(MANIFEST_PATH),
        "tasks": tasks,
        "attempts_per_task": 1,
        "concurrency": 1,
        "model": manifest["model"],
        "reasoning_effort": manifest["reasoning_effort"],
        "harness_mode": manifest["harness_mode"],
        "primary_score": manifest["primary_score"],
        "command": command,
    }
    (output_root / "launcher_manifest.json").write_text(
        json.dumps(run_manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    stop = threading.Event()
    sampler = threading.Thread(
        target=sample_resources,
        args=(output_root / "resource_samples.jsonl", stop),
        daemon=True,
    )
    sampler.start()
    with (output_root / "launcher.stdout.log").open("w", encoding="utf-8") as stdout, (
        output_root / "launcher.stderr.log"
    ).open("w", encoding="utf-8") as stderr:
        result = subprocess.run(
            command,
            cwd=REPO_ROOT,
            env=os.environ.copy(),
            stdout=stdout,
            stderr=stderr,
            check=False,
        )
    stop.set()
    sampler.join(timeout=35)
    complete = False
    summary_path = output_root / "postfix_summary.json"
    error: str | None = None
    try:
        job = latest_job(output_root / "jobs")
        rewards, strict = load_results(job, tasks)
        failures = set(
            task
            for cohort in manifest["prior_failures"].values()
            for task in cohort
        )
        rows = [
            {
                "task": task,
                "prior_raw_reward": 0.0 if task in failures else 1.0,
                "postfix_raw_reward": rewards[task],
                "changed": rewards[task] != (0.0 if task in failures else 1.0),
            }
            for task in tasks
        ]
        summary = {
            "protocol": PROTOCOL,
            "phase": args.mode,
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "official_verifier_raw_reward_is_primary": True,
            "targeted_result_is_not_an_all_89_score": True,
            "runtime_git_commit": manifest["postfix_runtime_commit"],
            "task_count": len(tasks),
            "postfix_passed": int(sum(rewards.values())),
            "postfix_score": sum(rewards.values()) / len(tasks),
            "prior_failures_recovered": sum(
                rewards[task] == 1.0 for task in tasks if task in failures
            ),
            "regression_sentinels_failed": sum(
                rewards[task] == 0.0 for task in tasks if task not in failures
            ),
            "runner_return_code": result.returncode,
            "strict_result": str(job / "strict_result.json"),
            "integrity_gate_passed": strict.get("integrity_gate_passed"),
            "per_task": rows,
        }
        summary_path.write_text(
            json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        complete = True
    except (OSError, RuntimeError, ValueError, KeyError) as exc:
        error = f"{type(exc).__name__}: {exc}"
    launcher_result = {
        "protocol": PROTOCOL,
        "phase": args.mode,
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "runner_return_code": result.returncode,
        "complete_official_results": complete,
        "summary": str(summary_path) if complete else None,
        "error": error,
    }
    (output_root / "launcher_result.json").write_text(
        json.dumps(launcher_result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(launcher_result, ensure_ascii=False, indent=2))
    return 0 if complete else 2


if __name__ == "__main__":
    raise SystemExit(main())
