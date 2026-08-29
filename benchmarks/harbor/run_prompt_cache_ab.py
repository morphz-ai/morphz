#!/usr/bin/env python3
"""Run one direct-Platform implicit/explicit Prompt Cache pair."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
LAUNCHER = Path(__file__).with_name("run_benchmark.py")
PLATFORM_BASE_URL = "https://api.openai.com/v1"
STRATEGIES = ("implicit-prefix", "explicit-content-boundaries")
ACCEPTANCE_RATIO = 0.85


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, dict), f"expected JSON object: {path}")
    return value


def direct_platform_environment(environment: dict[str, str]) -> dict[str, str]:
    base_url = environment.get("MORPHZ_PROVIDER_BASE_URL", "").rstrip("/")
    require(
        base_url == PLATFORM_BASE_URL,
        "Prompt Cache A/B requires MORPHZ_PROVIDER_BASE_URL=https://api.openai.com/v1",
    )
    require(
        environment.get("MORPHZ_PROVIDER_PROTOCOL", "openai-responses")
        == "openai-responses",
        "Prompt Cache A/B requires MORPHZ_PROVIDER_PROTOCOL=openai-responses",
    )
    require(
        bool(environment.get("MORPHZ_PROVIDER_API_KEY", "").strip()),
        "Prompt Cache A/B requires MORPHZ_PROVIDER_API_KEY",
    )
    prepared = environment.copy()
    prepared["MORPHZ_PROVIDER_PROTOCOL"] = "openai-responses"
    return prepared


def arm_command(
    *,
    binary: Path,
    watcher: Path,
    jobs_dir: Path,
    task: str,
) -> list[str]:
    return [
        sys.executable,
        str(LAUNCHER),
        "smoke",
        "--binary",
        str(binary),
        "--watcher",
        str(watcher),
        "--jobs-dir",
        str(jobs_dir),
        "--task",
        task,
        "--attempts",
        "1",
        "--concurrency",
        "1",
        "--expect-trials",
        "1",
        "--harness-mode",
        "none",
    ]


def child_directories(path: Path) -> set[Path]:
    if not path.is_dir():
        return set()
    return {entry.resolve() for entry in path.iterdir() if entry.is_dir()}


def run_arm(
    *,
    strategy: str,
    binary: Path,
    watcher: Path,
    jobs_dir: Path,
    task: str,
    environment: dict[str, str],
) -> Path:
    require(strategy in STRATEGIES, f"unsupported Prompt Cache strategy: {strategy}")
    before = child_directories(jobs_dir)
    arm_environment = environment.copy()
    arm_environment["MORPHZ_PROMPT_CACHE_STRATEGY"] = strategy
    result = subprocess.run(
        arm_command(binary=binary, watcher=watcher, jobs_dir=jobs_dir, task=task),
        cwd=REPO_ROOT,
        env=arm_environment,
        check=False,
    )
    require(result.returncode == 0, f"{strategy} arm failed with exit {result.returncode}")
    created = sorted(child_directories(jobs_dir) - before)
    require(len(created) == 1, f"{strategy} arm created {len(created)} Harbor jobs")
    return created[0]


def integer(value: Any) -> int:
    require(isinstance(value, int) and not isinstance(value, bool), "expected integer usage")
    return value


def trajectory_usage(trial_dir: Path) -> dict[str, Any]:
    trajectory = load_json(trial_dir / "agent" / "trajectory.json")
    steps = trajectory.get("steps")
    require(isinstance(steps, list), f"missing trajectory steps: {trial_dir}")
    records = []
    for step in steps:
        if not isinstance(step, dict) or not isinstance(step.get("metrics"), dict):
            continue
        metrics = step["metrics"]
        prompt_tokens = integer(metrics.get("prompt_tokens"))
        cached_tokens = integer(metrics.get("cached_tokens"))
        require(
            0 <= cached_tokens <= prompt_tokens,
            f"invalid trajectory cache usage: {trial_dir}",
        )
        records.append(
            {"input_tokens": prompt_tokens, "cached_input_tokens": cached_tokens}
        )
    require(records, f"trajectory has no Provider usage records: {trial_dir}")
    final_metrics = trajectory.get("final_metrics")
    require(isinstance(final_metrics, dict), f"missing final trajectory metrics: {trial_dir}")
    extra = final_metrics.get("extra")
    require(isinstance(extra, dict), f"missing final trajectory extras: {trial_dir}")
    model_attempts = integer(extra.get("unique_model_attempts_with_usage"))
    require(
        model_attempts == len(records),
        f"model attempt and usage-record counts differ: {trial_dir}",
    )
    first = records[0]
    total_input = sum(record["input_tokens"] for record in records)
    total_cached = sum(record["cached_input_tokens"] for record in records)
    post_first_input = total_input - first["input_tokens"]
    post_first_cached = total_cached - first["cached_input_tokens"]
    theoretical_max_cached = first["cached_input_tokens"] + post_first_input
    return {
        "model_attempts": model_attempts,
        "usage_records": records,
        "total_input_tokens": total_input,
        "total_cached_input_tokens": total_cached,
        "first_request_input_tokens": first["input_tokens"],
        "first_request_cached_input_tokens": first["cached_input_tokens"],
        "post_first_input_tokens": post_first_input,
        "post_first_cached_input_tokens": post_first_cached,
        "post_first_cache_hit_ratio": (
            post_first_cached / post_first_input if post_first_input else None
        ),
        "cold_start_theoretical_max_cache_hit_ratio": theoretical_max_cached
        / total_input,
    }


def summarize_arm(strategy: str, job_dir: Path) -> dict[str, Any]:
    strict = load_json(job_dir / "strict_result.json")
    identity = strict.get("run_identity")
    require(isinstance(identity, dict), f"missing run identity: {job_dir}")
    require(
        identity.get("prompt_cache_strategy") == strategy,
        f"run identity does not bind {strategy}: {job_dir}",
    )
    trials = strict.get("trials")
    require(isinstance(trials, list) and len(trials) == 1, f"expected one trial: {job_dir}")
    strict_trial = trials[0]
    require(isinstance(strict_trial, dict), f"invalid strict trial: {job_dir}")
    trial_name = strict_trial.get("trial")
    require(isinstance(trial_name, str) and trial_name, f"missing trial name: {job_dir}")
    trial_dir = job_dir / trial_name
    result = load_json(trial_dir / "result.json")
    agent_result = result.get("agent_result")
    require(isinstance(agent_result, dict), f"missing agent result: {job_dir}")
    input_tokens = integer(agent_result.get("n_input_tokens"))
    cached_input_tokens = integer(agent_result.get("n_cache_tokens"))
    output_tokens = integer(agent_result.get("n_output_tokens"))
    require(input_tokens > 0, f"zero input tokens: {job_dir}")
    require(
        0 <= cached_input_tokens <= input_tokens,
        f"invalid cached/input usage: {job_dir}",
    )
    trajectory = trajectory_usage(trial_dir)
    require(
        trajectory["total_input_tokens"] == input_tokens,
        f"trajectory and result input usage differ: {job_dir}",
    )
    require(
        trajectory["total_cached_input_tokens"] == cached_input_tokens,
        f"trajectory and result cached usage differ: {job_dir}",
    )
    cache_hit_ratio = cached_input_tokens / input_tokens
    return {
        "strategy": strategy,
        "job_dir": str(job_dir.resolve()),
        "task_name": strict_trial.get("task_name"),
        "strict_reward": strict_trial.get("strict_reward"),
        "integrity_gate_passed": strict.get("integrity_gate_passed"),
        "runtime_git_commit": identity.get("runtime_git_commit"),
        "runtime_binary_sha256": identity.get("runtime_binary_sha256"),
        "infrastructure_git_commit": identity.get("infrastructure_git_commit"),
        "input_tokens": input_tokens,
        "cached_input_tokens": cached_input_tokens,
        "output_tokens": output_tokens,
        "cache_hit_ratio": cache_hit_ratio,
        "meets_85_percent": cache_hit_ratio >= ACCEPTANCE_RATIO,
        "model_attempts": trajectory["model_attempts"],
        "first_request_input_tokens": trajectory["first_request_input_tokens"],
        "first_request_cached_input_tokens": trajectory[
            "first_request_cached_input_tokens"
        ],
        "post_first_input_tokens": trajectory["post_first_input_tokens"],
        "post_first_cached_input_tokens": trajectory["post_first_cached_input_tokens"],
        "post_first_cache_hit_ratio": trajectory["post_first_cache_hit_ratio"],
        "cold_start_theoretical_max_cache_hit_ratio": trajectory[
            "cold_start_theoretical_max_cache_hit_ratio"
        ],
        "cold_start_can_reach_85_percent": trajectory[
            "cold_start_theoretical_max_cache_hit_ratio"
        ]
        >= ACCEPTANCE_RATIO,
    }


def build_report(task: str, arms: dict[str, dict[str, Any]]) -> dict[str, Any]:
    require(set(arms) == set(STRATEGIES), "A/B report requires both cache strategies")
    implicit = arms["implicit-prefix"]
    explicit = arms["explicit-content-boundaries"]
    for field in ("task_name", "runtime_git_commit", "runtime_binary_sha256"):
        require(implicit[field] == explicit[field], f"paired arms differ on {field}")
    return {
        "schema_version": "morphz-gpt56-prompt-cache-ab-v1",
        "task": task,
        "provider": PLATFORM_BASE_URL,
        "physical_model": "gpt-5.6-sol",
        "reasoning_effort": "max",
        "acceptance_cache_hit_ratio": ACCEPTANCE_RATIO,
        "cache_cohort_isolation": (
            "wire mode is hashed into morphz-v3 prompt_cache_key; "
            "model-visible Context bytes are unchanged"
        ),
        "arms": arms,
        "explicit_minus_implicit_cache_hit_ratio": (
            explicit["cache_hit_ratio"] - implicit["cache_hit_ratio"]
        ),
        "strict_reward_equal": explicit["strict_reward"] == implicit["strict_reward"],
        "explicit_meets_85_percent": explicit["meets_85_percent"],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", required=True)
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--watcher", required=True, type=Path)
    parser.add_argument("--jobs-root", required=True, type=Path)
    parser.add_argument(
        "--order",
        choices=("implicit-first", "explicit-first"),
        default="implicit-first",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    require(not any(marker in args.task for marker in "*?["), "task must be an exact name")
    environment = direct_platform_environment(dict(os.environ))
    order = STRATEGIES if args.order == "implicit-first" else tuple(reversed(STRATEGIES))
    args.jobs_root.mkdir(parents=True, exist_ok=True)
    arms: dict[str, dict[str, Any]] = {}
    for strategy in order:
        job_dir = run_arm(
            strategy=strategy,
            binary=args.binary,
            watcher=args.watcher,
            jobs_dir=args.jobs_root / strategy,
            task=args.task,
            environment=environment,
        )
        arms[strategy] = summarize_arm(strategy, job_dir)
    report = build_report(args.task, arms)
    report_path = args.jobs_root / "prompt_cache_ab.json"
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print("prompt_cache_ab=" + str(report_path.resolve()))
    print(
        "explicit_cache_hit_ratio="
        + str(report["arms"]["explicit-content-boundaries"]["cache_hit_ratio"])
    )
    print("explicit_meets_85_percent=" + str(report["explicit_meets_85_percent"]).lower())
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"Prompt Cache A/B failed: {error}", file=sys.stderr)
        raise SystemExit(2) from error
