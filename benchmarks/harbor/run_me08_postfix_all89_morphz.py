#!/usr/bin/env python3
"""Run the frozen final-fix ME-08 all-89 Morphz official-score refresh."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import statistics
import subprocess
import sys
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from benchmarks.harbor.run_benchmark import LOCK_PATH, REPO_ROOT


PROTOCOL = "me08-terminal-bench-finalfix-all89-morphz-v3"
FIRST_40_PATH = Path(__file__).with_name("first_40_tasks_v1.json")
REMAINING_49_PATH = Path(__file__).with_name("remaining_49_tasks_v1.json")
EXPECTED_RUNTIME_COMMIT = "4bbc3d63f4bda09947dc79dc5656edc71f8c02fa"
EXPECTED_RUNTIME_BINARY_SHA256 = (
    "31f6cdd3de8ddf4a76e190eb4c0863ff9de7c9159c7acbf7ac2765b474ec0575"
)
CONCURRENCY_PER_ARM = 8
RUN_ARMS = ("morphz-native",)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_tasks() -> tuple[list[str], dict[str, Any], dict[str, Any]]:
    first = json.loads(FIRST_40_PATH.read_text(encoding="utf-8"))
    remaining = json.loads(REMAINING_49_PATH.read_text(encoding="utf-8"))
    cohorts = first.get("cohorts") or {}
    first_tasks = [
        str(task)
        for cohort in ("prior_first_20", "prior_second_20")
        for task in cohorts.get(cohort, [])
    ]
    remaining_tasks = [str(task) for task in remaining.get("tasks", [])]
    if len(first_tasks) != 40 or len(set(first_tasks)) != 40:
        raise RuntimeError("first task manifest must contain 40 unique tasks")
    if len(remaining_tasks) != 49 or len(set(remaining_tasks)) != 49:
        raise RuntimeError("remaining task manifest must contain 49 unique tasks")
    if set(first_tasks) & set(remaining_tasks):
        raise RuntimeError("first-40 and remaining-49 task manifests overlap")
    tasks = first_tasks + remaining_tasks
    if len(tasks) != 89 or len(set(tasks)) != 89:
        raise RuntimeError("combined task set must contain 89 unique tasks")
    if remaining.get("prior_task_set_sha256") != sha256_file(FIRST_40_PATH):
        raise RuntimeError("remaining task manifest does not bind the first-40 hash")

    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    dataset = lock["terminal_bench"]
    for manifest in (first, remaining):
        if manifest.get("dataset") != dataset["dataset"]:
            raise RuntimeError("task manifest dataset differs from toolchain lock")
        if manifest.get("registry_ref") != dataset["registry_ref"]:
            raise RuntimeError("task manifest registry ref differs from toolchain lock")
    if remaining.get("source_commit") != dataset["source_commit"]:
        raise RuntimeError("task manifest source commit differs from toolchain lock")
    runtime = lock["runtime"]
    if runtime.get("git_commit") != EXPECTED_RUNTIME_COMMIT:
        raise RuntimeError("toolchain lock is not pinned to the final-fix Runtime")
    if runtime.get("binary_sha256") != EXPECTED_RUNTIME_BINARY_SHA256:
        raise RuntimeError("toolchain lock has an unexpected Runtime binary")
    model = lock["model"]
    if model.get("physical_model") != "gpt-5.6-sol":
        raise RuntimeError("physical model is not gpt-5.6-sol")
    if model.get("reasoning_effort") != "max" or model.get("fallback") is not False:
        raise RuntimeError("model effort/fallback differs from the frozen protocol")
    return tasks, first, remaining


def task_args(tasks: list[str]) -> list[str]:
    result: list[str] = []
    for task in tasks:
        result.extend(["--task", task])
    result.extend(["--expect-trials", str(len(tasks))])
    return result


def arm_command(arm: str, tasks: list[str], jobs_root: Path) -> list[str]:
    common = task_args(tasks)
    if arm == "morphz-native":
        return [
            sys.executable,
            "-m",
            "benchmarks.harbor.run_benchmark",
            "full",
            "--jobs-dir",
            str(jobs_root / arm),
            "--harness-mode",
            "none",
            "--attempts",
            "1",
            "--concurrency",
            str(CONCURRENCY_PER_ARM),
            *common,
        ]
    raise RuntimeError(f"unknown ME-08 arm: {arm}")


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
        "captured_at": datetime.now(UTC).isoformat(),
        "active_arm": os.environ.get("ME08_ACTIVE_ARM"),
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


def latest_job(root: Path) -> Path:
    jobs = sorted(path for path in root.iterdir() if path.is_dir())
    if len(jobs) != 1:
        raise RuntimeError(f"expected one Harbor job in {root}, got {len(jobs)}")
    return jobs[0]


def load_rewards(job: Path, tasks: list[str]) -> tuple[dict[str, int], dict[str, Any]]:
    path = job / "strict_result.json"
    if not path.is_file():
        raise RuntimeError(f"missing {path}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    rows = payload.get("trials") or []
    if payload.get("audit_complete") is not True or len(rows) != len(tasks):
        raise RuntimeError(f"strict result is incomplete: {path}")
    rewards: dict[str, int] = {}
    for row in rows:
        task = str(row["task_name"]).removeprefix("terminal-bench/")
        reward = float(row["raw_reward"])
        if reward not in {0.0, 1.0} or task in rewards:
            raise RuntimeError(f"invalid or duplicate official reward for {task}")
        rewards[task] = int(reward)
    if set(rewards) != set(tasks):
        raise RuntimeError("officially scored tasks differ from the frozen 89 tasks")
    return rewards, payload


def wilson_95(successes: int, total: int) -> list[float]:
    z = 1.959963984540054
    proportion = successes / total
    denominator = 1.0 + z * z / total
    center = (proportion + z * z / (2.0 * total)) / denominator
    half = z * math.sqrt(
        proportion * (1.0 - proportion) / total + z * z / (4.0 * total * total)
    ) / denominator
    return [max(0.0, center - half), min(1.0, center + half)]


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    position = fraction * (len(ordered) - 1)
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def resource_summary(path: Path) -> dict[str, Any]:
    rows = [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip() and "sample_error" not in line
    ]
    if not rows:
        raise RuntimeError("resource sampler produced no valid rows")
    memory_used = [
        int(row["memory_total_kib"]) - int(row["memory_available_kib"])
        for row in rows
    ]
    loads = [float(row["load_1m"]) for row in rows]
    containers = [int(row["docker_running_containers"]) for row in rows]
    return {
        "sample_count": len(rows),
        "cpu_count": int(rows[0]["cpu_count"]),
        "memory_total_kib": int(rows[0]["memory_total_kib"]),
        "memory_used_kib": {
            "mean": statistics.fmean(memory_used),
            "p95": percentile([float(value) for value in memory_used], 0.95),
            "max": max(memory_used),
        },
        "load_1m": {
            "mean": statistics.fmean(loads),
            "p95": percentile(loads, 0.95),
            "max": max(loads),
        },
        "docker_running_containers": {
            "mean": statistics.fmean(containers),
            "max": max(containers),
        },
    }


def summarize(
    output_root: Path,
    tasks: list[str],
    return_codes: dict[str, int],
) -> dict[str, Any]:
    job = latest_job(output_root / "jobs" / "morphz-native")
    morphz, strict = load_rewards(job, tasks)
    morphz_passed = sum(morphz.values())
    return {
        "protocol": PROTOCOL,
        "completed_at": datetime.now(UTC).isoformat(),
        "official_verifier_raw_reward_is_primary": True,
        "old_concurrency_1_results_are_not_spliced": True,
        "task_count": len(tasks),
        "attempts_per_task": 1,
        "concurrency_per_arm": CONCURRENCY_PER_ARM,
        "maximum_simultaneous_trials": CONCURRENCY_PER_ARM,
        "run_arms": list(RUN_ARMS),
        "codex_rerun_performed": False,
        "external_codex_pair_required": True,
        "return_codes": return_codes,
        "arms": {
            "morphz-native": {
                "passed": morphz_passed,
                "score": morphz_passed / len(tasks),
                "wilson_95_ci": wilson_95(morphz_passed, len(tasks)),
                "local_integrity_gate_passed": strict.get("integrity_gate_passed"),
            },
        },
        "host_resources": resource_summary(output_root / "resource_samples.jsonl"),
        "per_task": [{"task": task, "morphz": morphz[task]} for task in tasks],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("validate", "full"))
    parser.add_argument("--output-root", type=Path)
    args = parser.parse_args()
    tasks, first_manifest, remaining_manifest = load_tasks()
    commands = {
        arm: arm_command(arm, tasks, Path("JOBS_ROOT")) for arm in RUN_ARMS
    }
    if args.mode == "validate":
        print(
            json.dumps(
                {
                    "protocol": PROTOCOL,
                    "validated": True,
                    "task_count": len(tasks),
                    "concurrency_per_arm": CONCURRENCY_PER_ARM,
                    "maximum_simultaneous_trials": CONCURRENCY_PER_ARM,
                    "run_arms": list(RUN_ARMS),
                    "codex_rerun_performed": False,
                    "external_codex_pair_required": True,
                    "runtime_commit": EXPECTED_RUNTIME_COMMIT,
                    "runtime_binary_sha256": EXPECTED_RUNTIME_BINARY_SHA256,
                    "commands": commands,
                },
                indent=2,
            )
        )
        return 0
    if args.output_root is None:
        parser.error("full mode requires --output-root")
    output_root = args.output_root.resolve()
    output_root.mkdir(parents=True, exist_ok=False)
    jobs_root = output_root / "jobs"
    logs_root = output_root / "launcher-logs"
    logs_root.mkdir()
    arm_commands: dict[str, list[str]] = {}
    for arm in RUN_ARMS:
        (jobs_root / arm).mkdir(parents=True)
        arm_commands[arm] = arm_command(arm, tasks, jobs_root)
    manifest = {
        "protocol": PROTOCOL,
        "started_at": datetime.now(UTC).isoformat(),
        "infrastructure_git_commit": git_commit(),
        "launcher_sha256": sha256_file(Path(__file__)),
        "toolchain_lock_sha256": sha256_file(LOCK_PATH),
        "first_40_manifest": first_manifest,
        "first_40_manifest_sha256": sha256_file(FIRST_40_PATH),
        "remaining_49_manifest": remaining_manifest,
        "remaining_49_manifest_sha256": sha256_file(REMAINING_49_PATH),
        "tasks": tasks,
        "attempts_per_task": 1,
        "concurrency_per_arm": CONCURRENCY_PER_ARM,
        "maximum_simultaneous_trials": CONCURRENCY_PER_ARM,
        "run_arms": list(RUN_ARMS),
        "codex_rerun_performed": False,
        "external_codex_pair_required": True,
        "runtime_commit": EXPECTED_RUNTIME_COMMIT,
        "runtime_binary_sha256": EXPECTED_RUNTIME_BINARY_SHA256,
        "model": "gpt-5.6-sol",
        "reasoning_effort": "max",
        "fallback": False,
        "harness_mode": "none",
        "commands": arm_commands,
    }
    (output_root / "launcher_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    stop = threading.Event()
    sampler = threading.Thread(
        target=sample_resources,
        args=(output_root / "resource_samples.jsonl", stop),
        daemon=True,
    )
    sampler.start()
    return_codes: dict[str, int] = {}
    arm_runs: dict[str, Any] = {}
    try:
        for arm in RUN_ARMS:
            os.environ["ME08_ACTIVE_ARM"] = arm
            started_at = datetime.now(UTC).isoformat()
            with (logs_root / f"{arm}.stdout.log").open(
                "w", encoding="utf-8"
            ) as stdout, (logs_root / f"{arm}.stderr.log").open(
                "w", encoding="utf-8"
            ) as stderr:
                result = subprocess.run(
                    arm_commands[arm],
                    cwd=REPO_ROOT,
                    env=os.environ.copy(),
                    stdout=stdout,
                    stderr=stderr,
                    text=True,
                    check=False,
                )
            return_codes[arm] = result.returncode
            arm_runs[arm] = {
                "started_at": started_at,
                "completed_at": datetime.now(UTC).isoformat(),
                "return_code": result.returncode,
            }
            (output_root / "arm_progress.json").write_text(
                json.dumps(arm_runs, indent=2) + "\n", encoding="utf-8"
            )
    finally:
        os.environ.pop("ME08_ACTIVE_ARM", None)
        stop.set()
        sampler.join(timeout=35.0)

    launcher_result: dict[str, Any] = {
        "protocol": PROTOCOL,
        "completed_at": datetime.now(UTC).isoformat(),
        "return_codes": return_codes,
        "arm_runs": arm_runs,
    }
    try:
        summary = summarize(output_root, tasks, return_codes)
        summary_path = output_root / "all_89_morphz_summary.json"
        summary_path.write_text(
            json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        launcher_result["complete_official_results"] = True
        launcher_result["summary"] = str(summary_path)
    except (KeyError, OSError, RuntimeError, TypeError, ValueError) as error:
        launcher_result["complete_official_results"] = False
        launcher_result["summary_error"] = f"{type(error).__name__}: {error}"
    (output_root / "launcher_result.json").write_text(
        json.dumps(launcher_result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(launcher_result, ensure_ascii=False, indent=2))
    return 0 if launcher_result["complete_official_results"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
