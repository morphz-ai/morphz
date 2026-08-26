#!/usr/bin/env python3
"""Summarize paired Harbor trial results without changing official rewards.

This module is deliberately diagnostic.  It reads one ``result.json`` per
trial, preserves the official verifier reward, and reports execution-time,
token, and exception distributions.  It never reclassifies or excludes a
trial from the primary score.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, dict), f"expected JSON object: {path}")
    return value


def parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def interval_seconds(value: Any) -> float | None:
    if not isinstance(value, dict):
        return None
    started = parse_time(value.get("started_at"))
    finished = parse_time(value.get("finished_at"))
    if started is None or finished is None:
        return None
    return max(0.0, (finished - started).total_seconds())


def number(value: Any, default: int = 0) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return int(value)
    return default


def text_sha256(value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def reward(payload: dict[str, Any]) -> int:
    verifier = payload.get("verifier_result")
    require(isinstance(verifier, dict), "missing verifier_result")
    rewards = verifier.get("rewards")
    require(isinstance(rewards, dict), "missing verifier rewards")
    raw = float(rewards.get("reward"))
    require(raw in {0.0, 1.0}, f"expected binary reward, got {raw}")
    return int(raw)


def trajectory_metrics(trial_dir: Path) -> dict[str, Any]:
    path = trial_dir / "agent" / "trajectory.json"
    if not path.is_file():
        return {
            "available": False,
            "steps": None,
            "model_attempts": None,
            "last_source": None,
            "last_tool_names": [],
        }
    payload = load_json(path)
    steps = payload.get("steps")
    if not isinstance(steps, list):
        steps = []
    final_metrics = payload.get("final_metrics")
    if not isinstance(final_metrics, dict):
        final_metrics = {}
    extra = final_metrics.get("extra")
    if not isinstance(extra, dict):
        extra = {}
    last = steps[-1] if steps and isinstance(steps[-1], dict) else {}
    tool_calls = last.get("tool_calls") if isinstance(last, dict) else []
    if not isinstance(tool_calls, list):
        tool_calls = []
    return {
        "available": True,
        "steps": number(final_metrics.get("total_steps"), len(steps)),
        "model_attempts": number(extra.get("unique_model_attempts_with_usage")),
        "last_source": last.get("source") if isinstance(last, dict) else None,
        "last_tool_names": [
            item.get("function_name")
            for item in tool_calls
            if isinstance(item, dict) and isinstance(item.get("function_name"), str)
        ],
    }


def load_trial(path: Path) -> dict[str, Any]:
    payload = load_json(path)
    task = payload.get("task_name")
    require(isinstance(task, str) and task, f"invalid task_name: {path}")
    task = task.removeprefix("terminal-bench/")
    agent_result = payload.get("agent_result")
    if not isinstance(agent_result, dict):
        agent_result = {}
    exception = payload.get("exception_info")
    if not isinstance(exception, dict):
        exception = {}
    started = parse_time(payload.get("started_at"))
    finished = parse_time(payload.get("finished_at"))
    total_seconds = None
    if started is not None and finished is not None:
        total_seconds = max(0.0, (finished - started).total_seconds())
    trial_dir = path.parent
    return {
        "task": task,
        "reward": reward(payload),
        "exception_type": exception.get("exception_type"),
        "exception_message_sha256": text_sha256(exception.get("exception_message")),
        "agent_execution_seconds": interval_seconds(payload.get("agent_execution")),
        "total_trial_seconds": total_seconds,
        "input_tokens": number(agent_result.get("n_input_tokens")),
        "cached_input_tokens": number(agent_result.get("n_cache_tokens")),
        "output_tokens": number(agent_result.get("n_output_tokens")),
        "cost_usd": agent_result.get("cost_usd"),
        "trajectory": trajectory_metrics(trial_dir),
    }


def load_job(path: Path, expected_trials: int | None = None) -> dict[str, dict[str, Any]]:
    require(path.is_dir(), f"job directory does not exist: {path}")
    results: dict[str, dict[str, Any]] = {}
    for result_path in sorted(path.glob("*/result.json")):
        trial = load_trial(result_path)
        task = trial["task"]
        require(task not in results, f"duplicate task {task} in {path}")
        results[task] = trial
    require(results, f"no trial results below {path}")
    if expected_trials is not None:
        require(
            len(results) == expected_trials,
            f"expected {expected_trials} trials below {path}, got {len(results)}",
        )
    return results


def percentile(values: list[float], fraction: float) -> float:
    require(values, "percentile requires values")
    ordered = sorted(values)
    position = fraction * (len(ordered) - 1)
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def distribution(values: list[float]) -> dict[str, float | int] | None:
    if not values:
        return None
    return {
        "count": len(values),
        "mean": statistics.fmean(values),
        "median": statistics.median(values),
        "p95": percentile(values, 0.95),
        "max": max(values),
    }


def arm_summary(trials: dict[str, dict[str, Any]]) -> dict[str, Any]:
    exceptions = Counter(
        str(trial["exception_type"])
        for trial in trials.values()
        if trial["exception_type"] is not None
    )
    execution = [
        float(trial["agent_execution_seconds"])
        for trial in trials.values()
        if trial["agent_execution_seconds"] is not None
    ]
    total = [
        float(trial["total_trial_seconds"])
        for trial in trials.values()
        if trial["total_trial_seconds"] is not None
    ]
    model_attempts = [
        float(trial["trajectory"]["model_attempts"])
        for trial in trials.values()
        if trial["trajectory"]["available"]
    ]
    steps = [
        float(trial["trajectory"]["steps"])
        for trial in trials.values()
        if trial["trajectory"]["available"]
    ]
    costs = [
        float(trial["cost_usd"])
        for trial in trials.values()
        if isinstance(trial["cost_usd"], (int, float))
    ]
    return {
        "trials": len(trials),
        "passed": sum(int(trial["reward"]) for trial in trials.values()),
        "exception_counts": dict(sorted(exceptions.items())),
        "tokens": {
            "input": sum(int(trial["input_tokens"]) for trial in trials.values()),
            "cached_input": sum(
                int(trial["cached_input_tokens"]) for trial in trials.values()
            ),
            "output": sum(int(trial["output_tokens"]) for trial in trials.values()),
        },
        "cost_usd_reported_sum": sum(costs) if costs else None,
        "agent_execution_seconds": distribution(execution),
        "total_trial_seconds": distribution(total),
        "trajectory_steps": distribution(steps),
        "model_attempts": distribution(model_attempts),
    }


def summarize(
    morphz: dict[str, dict[str, Any]], codex: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    require(set(morphz) == set(codex), "paired job task sets differ")
    tasks = sorted(morphz)
    paired_durations: list[float] = []
    morphz_faster = 0
    codex_faster = 0
    equal_duration = 0
    rows: list[dict[str, Any]] = []
    for task in tasks:
        morphz_trial = morphz[task]
        codex_trial = codex[task]
        morphz_seconds = morphz_trial["agent_execution_seconds"]
        codex_seconds = codex_trial["agent_execution_seconds"]
        ratio = None
        if (
            isinstance(morphz_seconds, (int, float))
            and isinstance(codex_seconds, (int, float))
            and codex_seconds > 0
        ):
            ratio = float(morphz_seconds) / float(codex_seconds)
            paired_durations.append(ratio)
            if morphz_seconds < codex_seconds:
                morphz_faster += 1
            elif codex_seconds < morphz_seconds:
                codex_faster += 1
            else:
                equal_duration += 1
        rows.append({
            "task": task,
            "morphz": morphz_trial,
            "codex": codex_trial,
            "morphz_to_codex_execution_ratio": ratio,
        })
    return {
        "official_reward_unchanged": True,
        "diagnostic_only": True,
        "task_count": len(tasks),
        "arms": {
            "morphz-native": arm_summary(morphz),
            "official-codex": arm_summary(codex),
        },
        "paired_execution": {
            "ratio_distribution": distribution(paired_durations),
            "morphz_faster": morphz_faster,
            "codex_faster": codex_faster,
            "equal": equal_duration,
        },
        "per_task": rows,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--morphz-job", type=Path, required=True)
    parser.add_argument("--codex-job", type=Path, required=True)
    parser.add_argument("--expected-trials", type=int)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = summarize(
        load_job(args.morphz_job, args.expected_trials),
        load_job(args.codex_job, args.expected_trials),
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, indent=2, ensure_ascii=True) + "\n",
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
