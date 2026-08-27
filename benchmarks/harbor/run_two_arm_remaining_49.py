#!/usr/bin/env python3
"""Run the frozen Terminal-Bench 2.1 remaining-49 Morphz/Codex comparison."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import subprocess
import sys
import threading
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from benchmarks.harbor.run_benchmark import LOCK_PATH, REPO_ROOT


PROTOCOL = "terminal-bench-two-arm-remaining-49-v1"
TASK_SET = Path(__file__).with_name("remaining_49_tasks_v1.json")
PRIOR_TASK_SET = Path(__file__).with_name("first_40_tasks_v1.json")
EXPECTED_RUNTIME_COMMIT = "5e4b0ffcd89245f19d84ec3569605ae27a44e02b"
EXPECTED_RUNTIME_BINARY_SHA256 = (
    "f98c17bcc3204216aa39b3833994ad01da45c3015e02216eeb12a9290dd99e67"
)
EXPECTED_CODEX_VERSION = "0.149.1"
CONCURRENCY_PER_ARM = 1


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_tasks() -> tuple[dict[str, Any], list[str], list[str]]:
    manifest = json.loads(TASK_SET.read_text(encoding="utf-8"))
    prior_manifest = json.loads(PRIOR_TASK_SET.read_text(encoding="utf-8"))
    tasks = [str(value) for value in manifest.get("tasks", [])]
    cohorts = prior_manifest.get("cohorts", {})
    prior = [
        str(value)
        for cohort in ("prior_first_20", "prior_second_20")
        for value in cohorts.get(cohort, [])
    ]
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    if len(tasks) != 49 or len(set(tasks)) != 49:
        raise RuntimeError("remaining task set must contain 49 unique tasks")
    if len(prior) != 40 or len(set(prior)) != 40:
        raise RuntimeError("prior task set must contain 40 unique tasks")
    if set(tasks) & set(prior):
        raise RuntimeError("remaining and prior task sets overlap")
    if len(set(tasks) | set(prior)) != 89:
        raise RuntimeError("prior plus remaining task sets must cover 89 tasks")
    if sha256_file(PRIOR_TASK_SET) != manifest["prior_task_set_sha256"]:
        raise RuntimeError("prior task set hash does not match the frozen manifest")
    dataset = lock["terminal_bench"]
    for key in ("dataset", "registry_ref", "source_commit"):
        if manifest[key] != dataset[key]:
            raise RuntimeError(f"task set {key} does not match toolchain lock")
    runtime = lock["runtime"]
    locked_baseline_commit = runtime.get(
        "prior_me08_git_commit", runtime["git_commit"]
    )
    locked_baseline_binary = runtime.get(
        "prior_me08_binary_sha256", runtime["binary_sha256"]
    )
    if locked_baseline_commit != EXPECTED_RUNTIME_COMMIT:
        raise RuntimeError("runtime commit differs from first-40 baseline")
    if locked_baseline_binary != EXPECTED_RUNTIME_BINARY_SHA256:
        raise RuntimeError("runtime binary differs from first-40 baseline")
    return manifest, tasks, prior


def task_args(tasks: list[str]) -> list[str]:
    result: list[str] = []
    for task in tasks:
        result.extend(["--task", task])
    result.extend(["--expect-trials", str(len(tasks))])
    return result


def commands(tasks: list[str], jobs_root: Path) -> dict[str, list[str]]:
    common = task_args(tasks)
    return {
        "morphz-native": [
            sys.executable,
            "-m",
            "benchmarks.harbor.run_benchmark",
            "full",
            "--jobs-dir",
            str(jobs_root / "morphz-native"),
            "--harness-mode",
            "none",
            "--attempts",
            "1",
            "--concurrency",
            str(CONCURRENCY_PER_ARM),
            *common,
        ],
        "official-codex": [
            sys.executable,
            "-m",
            "benchmarks.harbor.run_codex_comparison",
            "full",
            "--jobs-dir",
            str(jobs_root / "official-codex"),
            "--concurrency",
            str(CONCURRENCY_PER_ARM),
            *common,
        ],
    }


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
    docker_count: int | None = None
    result = subprocess.run(
        ["docker", "ps", "-q"], capture_output=True, text=True, check=False
    )
    if result.returncode == 0:
        docker_count = len([line for line in result.stdout.splitlines() if line])
    return {
        "captured_at": datetime.now(UTC).isoformat(),
        "load_1m": load1,
        "load_5m": load5,
        "load_15m": load15,
        "cpu_count": os.cpu_count(),
        "memory_total_kib": meminfo.get("MemTotal"),
        "memory_available_kib": meminfo.get("MemAvailable"),
        "docker_running_containers": docker_count,
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
        raise RuntimeError(f"expected one job in {root}, got {len(jobs)}")
    return jobs[0]


def load_official_results(job: Path) -> tuple[dict[str, float], dict[str, Any]]:
    strict_path = job / "strict_result.json"
    if not strict_path.is_file():
        raise RuntimeError(f"missing {strict_path}")
    payload = json.loads(strict_path.read_text(encoding="utf-8"))
    if payload.get("audit_complete") is not True:
        raise RuntimeError(f"strict audit is incomplete: {strict_path}")
    if payload.get("trial_count") != 49:
        raise RuntimeError(f"strict trial_count is not 49: {strict_path}")
    trials = payload.get("trials", [])
    if len(trials) != 49:
        raise RuntimeError(f"expected 49 trials in {strict_path}, got {len(trials)}")
    rewards = {str(row["task_name"]).split("/", 1)[-1]: float(row["raw_reward"]) for row in trials}
    if len(rewards) != 49:
        raise RuntimeError(f"expected 49 unique rewards in {strict_path}")
    return rewards, payload


def exact_binomial_two_sided(first: int, second: int) -> float:
    discordant = first + second
    if discordant == 0:
        return 1.0
    tail = sum(math.comb(discordant, k) for k in range(0, min(first, second) + 1))
    return min(1.0, 2.0 * tail / (2**discordant))


def summarize(output_root: Path, tasks: list[str], return_codes: dict[str, int]) -> dict[str, Any]:
    morphz_job = latest_job(output_root / "jobs" / "morphz-native")
    codex_job = latest_job(output_root / "jobs" / "official-codex")
    morphz, morphz_payload = load_official_results(morphz_job)
    codex, codex_payload = load_official_results(codex_job)
    if set(morphz) != set(tasks) or set(codex) != set(tasks):
        raise RuntimeError("scored task IDs do not match the frozen remaining-49 set")
    morphz_wins = sum(morphz[t] > codex[t] for t in tasks)
    codex_wins = sum(codex[t] > morphz[t] for t in tasks)
    both_pass = sum(morphz[t] == 1.0 and codex[t] == 1.0 for t in tasks)
    both_fail = sum(morphz[t] == 0.0 and codex[t] == 0.0 for t in tasks)
    return {
        "protocol": PROTOCOL,
        "completed_at": datetime.now(UTC).isoformat(),
        "task_count": len(tasks),
        "official_scoring_is_primary": True,
        "return_codes": return_codes,
        "arms": {
            "morphz-native": {
                "passed": int(sum(morphz.values())),
                "score": sum(morphz.values()) / len(tasks),
                "strict_result": str(morphz_job / "strict_result.json"),
                "local_integrity_gate_passed": morphz_payload.get("integrity_gate_passed"),
            },
            "official-codex": {
                "passed": int(sum(codex.values())),
                "score": sum(codex.values()) / len(tasks),
                "strict_result": str(codex_job / "strict_result.json"),
                "local_integrity_gate_passed": codex_payload.get("integrity_gate_passed"),
            },
        },
        "paired": {
            "morphz_wins": morphz_wins,
            "codex_wins": codex_wins,
            "both_pass": both_pass,
            "both_fail": both_fail,
            "exact_binomial_two_sided_p": exact_binomial_two_sided(morphz_wins, codex_wins),
        },
        "per_task": [
            {"task": task, "morphz": morphz[task], "codex": codex[task]}
            for task in tasks
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("validate", "full"))
    parser.add_argument("--output-root", type=Path)
    args = parser.parse_args()
    task_manifest, tasks, prior = load_tasks()
    if args.mode == "validate":
        print(json.dumps({
            "protocol": PROTOCOL,
            "task_count": len(tasks),
            "prior_count": len(prior),
            "union_count": len(set(tasks) | set(prior)),
            "task_set_sha256": sha256_file(TASK_SET),
            "runtime_commit": EXPECTED_RUNTIME_COMMIT,
            "runtime_binary_sha256": EXPECTED_RUNTIME_BINARY_SHA256,
            "codex_cli_version": EXPECTED_CODEX_VERSION,
            "validated": True,
        }, indent=2))
        return 0
    if args.output_root is None:
        parser.error("full mode requires --output-root")
    output_root = args.output_root.resolve()
    output_root.mkdir(parents=True, exist_ok=False)
    arm_commands = commands(tasks, output_root / "jobs")
    manifest = {
        "protocol": PROTOCOL,
        "started_at": datetime.now(UTC).isoformat(),
        "infrastructure_git_commit": git_commit(),
        "launcher_sha256": sha256_file(Path(__file__)),
        "task_manifest": task_manifest,
        "task_set_sha256": sha256_file(TASK_SET),
        "tasks": tasks,
        "attempts_per_task": 1,
        "concurrency_per_arm": CONCURRENCY_PER_ARM,
        "maximum_simultaneous_trials": CONCURRENCY_PER_ARM * 2,
        "runtime_commit": EXPECTED_RUNTIME_COMMIT,
        "runtime_binary_sha256": EXPECTED_RUNTIME_BINARY_SHA256,
        "codex_cli_version": EXPECTED_CODEX_VERSION,
        "commands": arm_commands,
    }
    (output_root / "launcher_manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    logs = output_root / "launcher-logs"
    logs.mkdir()
    processes: dict[str, tuple[subprocess.Popen[str], Any, Any]] = {}
    stop = threading.Event()
    sampler = threading.Thread(
        target=sample_resources,
        args=(output_root / "resource_samples.jsonl", stop),
        daemon=True,
    )
    sampler.start()
    for arm, command in arm_commands.items():
        stdout = (logs / f"{arm}.stdout.log").open("w", encoding="utf-8")
        stderr = (logs / f"{arm}.stderr.log").open("w", encoding="utf-8")
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
    try:
        for arm, (process, stdout, stderr) in processes.items():
            return_codes[arm] = process.wait()
            stdout.close()
            stderr.close()
    finally:
        stop.set()
        sampler.join(timeout=35.0)
    launcher_result: dict[str, Any] = {
        "protocol": PROTOCOL,
        "completed_at": datetime.now(UTC).isoformat(),
        "return_codes": return_codes,
    }
    try:
        summary = summarize(output_root, tasks, return_codes)
        (output_root / "two_arm_summary.json").write_text(
            json.dumps(summary, indent=2) + "\n", encoding="utf-8"
        )
        launcher_result["complete_official_results"] = True
        launcher_result["summary"] = str(output_root / "two_arm_summary.json")
    except (KeyError, OSError, RuntimeError, TypeError, ValueError) as error:
        launcher_result["complete_official_results"] = False
        launcher_result["summary_error"] = f"{type(error).__name__}: {error}"
    (output_root / "launcher_result.json").write_text(
        json.dumps(launcher_result, indent=2) + "\n", encoding="utf-8"
    )
    return 0 if launcher_result["complete_official_results"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
