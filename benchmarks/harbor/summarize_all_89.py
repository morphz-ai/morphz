#!/usr/bin/env python3
"""Merge the frozen first-40 and remaining-49 Terminal-Bench paired results."""

from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import json
import math
import random
import statistics
from pathlib import Path
from typing import Any


BOOTSTRAP_SEED = 20260826
BOOTSTRAP_REPETITIONS = 10_000


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(payload, dict), f"expected JSON object: {path}")
    return payload


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_task_name(value: Any) -> str:
    require(isinstance(value, str) and value, "invalid task name")
    return value.removeprefix("terminal-bench/")


def binary_reward(value: Any, *, label: str) -> int:
    reward = float(value)
    require(reward in {0.0, 1.0}, f"non-binary reward for {label}: {reward}")
    return int(reward)


def load_prior_strict(path: Path) -> dict[str, int]:
    payload = load_json(path)
    require(payload.get("audit_complete") is True, f"prior audit incomplete: {path}")
    require(payload.get("trial_count") == 40, f"prior trial count is not 40: {path}")
    trials = payload.get("trials")
    require(isinstance(trials, list) and len(trials) == 40, f"invalid prior trials: {path}")
    rewards: dict[str, int] = {}
    for trial in trials:
        require(isinstance(trial, dict), f"invalid trial row: {path}")
        task = normalize_task_name(trial.get("task_name"))
        require(task not in rewards, f"duplicate prior task: {task}")
        rewards[task] = binary_reward(trial.get("raw_reward"), label=task)
    return rewards


def load_remaining(path: Path) -> tuple[dict[str, int], dict[str, int]]:
    payload = load_json(path)
    require(payload.get("official_scoring_is_primary") is True, "remaining summary does not use official scoring")
    require(payload.get("task_count") == 49, "remaining task count is not 49")
    rows = payload.get("per_task")
    require(isinstance(rows, list) and len(rows) == 49, "invalid remaining per_task rows")
    morphz: dict[str, int] = {}
    codex: dict[str, int] = {}
    for row in rows:
        require(isinstance(row, dict), "invalid remaining task row")
        task = normalize_task_name(row.get("task"))
        require(task not in morphz, f"duplicate remaining task: {task}")
        morphz[task] = binary_reward(row.get("morphz"), label=f"morphz:{task}")
        codex[task] = binary_reward(row.get("codex"), label=f"codex:{task}")
    return morphz, codex


def exact_two_sided(first: int, second: int) -> float:
    discordant = first + second
    if discordant == 0:
        return 1.0
    tail = sum(math.comb(discordant, k) for k in range(min(first, second) + 1))
    return min(1.0, 2.0 * tail / (2**discordant))


def wilson_95(successes: int, total: int) -> list[float]:
    require(total > 0, "Wilson interval requires a positive denominator")
    z = 1.959963984540054
    proportion = successes / total
    denominator = 1.0 + z * z / total
    center = (proportion + z * z / (2.0 * total)) / denominator
    half = z * math.sqrt(
        proportion * (1.0 - proportion) / total + z * z / (4.0 * total * total)
    ) / denominator
    return [max(0.0, center - half), min(1.0, center + half)]


def paired_bootstrap_95(differences: list[int]) -> list[float]:
    require(differences, "paired bootstrap requires observations")
    rng = random.Random(BOOTSTRAP_SEED)
    count = len(differences)
    samples = sorted(
        sum(differences[rng.randrange(count)] for _ in range(count)) / count
        for _ in range(BOOTSTRAP_REPETITIONS)
    )
    return [
        samples[int(0.025 * BOOTSTRAP_REPETITIONS)],
        samples[int(0.975 * BOOTSTRAP_REPETITIONS)],
    ]


def percentile(values: list[float], fraction: float) -> float:
    require(values, "percentile requires observations")
    ordered = sorted(values)
    position = fraction * (len(ordered) - 1)
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def load_resource_samples(path: Path) -> dict[str, Any]:
    rows = [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    require(rows, "resource sample file is empty")
    require(all(isinstance(row, dict) for row in rows), "invalid resource sample row")
    cpu_counts = {int(row["cpu_count"]) for row in rows}
    memory_totals = {int(row["memory_total_kib"]) for row in rows}
    require(len(cpu_counts) == 1, "cpu_count changed during resource sampling")
    require(len(memory_totals) == 1, "memory_total_kib changed during resource sampling")
    load_1m = [float(row["load_1m"]) for row in rows]
    load_5m = [float(row["load_5m"]) for row in rows]
    memory_used = [
        int(row["memory_total_kib"]) - int(row["memory_available_kib"])
        for row in rows
    ]
    containers = [int(row["docker_running_containers"]) for row in rows]
    return {
        "sample_count": len(rows),
        "first_captured_at": rows[0]["captured_at"],
        "last_captured_at": rows[-1]["captured_at"],
        "cpu_count": next(iter(cpu_counts)),
        "memory_total_kib": next(iter(memory_totals)),
        "load_1m": {
            "mean": statistics.fmean(load_1m),
            "p95": percentile(load_1m, 0.95),
            "max": max(load_1m),
        },
        "load_5m": {
            "mean": statistics.fmean(load_5m),
            "p95": percentile(load_5m, 0.95),
            "max": max(load_5m),
        },
        "memory_used_kib": {
            "mean": statistics.fmean(memory_used),
            "p95": percentile([float(value) for value in memory_used], 0.95),
            "max": max(memory_used),
        },
        "docker_running_containers": {
            "mean": statistics.fmean(containers),
            "max": max(containers),
        },
    }


def load_job_usage(path: Path, *, expected_trials: int) -> dict[str, Any]:
    payload = load_json(path)
    require(payload.get("n_total_trials") == expected_trials, f"unexpected job trial count: {path}")
    stats = payload.get("stats")
    require(isinstance(stats, dict), f"job result has no stats: {path}")
    started_at = datetime.fromisoformat(str(payload["started_at"]))
    finished_at = datetime.fromisoformat(str(payload["finished_at"]))
    require(finished_at >= started_at, f"job finish precedes start: {path}")
    return {
        "started_at": payload["started_at"],
        "finished_at": payload["finished_at"],
        "wall_time_seconds": (finished_at - started_at).total_seconds(),
        "trial_count": expected_trials,
        "errored_trials": int(stats.get("n_errored_trials") or 0),
        "provider_reported_input_tokens": int(stats.get("n_input_tokens") or 0),
        "provider_reported_cache_tokens": int(stats.get("n_cache_tokens") or 0),
        "provider_reported_output_tokens": int(stats.get("n_output_tokens") or 0),
        "harbor_estimated_cost_usd": stats.get("cost_usd"),
    }


def combine_job_usage(first_40: dict[str, Any], remaining_49: dict[str, Any]) -> dict[str, Any]:
    cost_values = [
        float(value)
        for value in (
            first_40["harbor_estimated_cost_usd"],
            remaining_49["harbor_estimated_cost_usd"],
        )
        if value is not None
    ]
    return {
        "provider_reported_input_tokens": (
            first_40["provider_reported_input_tokens"]
            + remaining_49["provider_reported_input_tokens"]
        ),
        "provider_reported_cache_tokens": (
            first_40["provider_reported_cache_tokens"]
            + remaining_49["provider_reported_cache_tokens"]
        ),
        "provider_reported_output_tokens": (
            first_40["provider_reported_output_tokens"]
            + remaining_49["provider_reported_output_tokens"]
        ),
        "wall_time_seconds_across_two_subsets": (
            first_40["wall_time_seconds"] + remaining_49["wall_time_seconds"]
        ),
        "errored_trials": first_40["errored_trials"] + remaining_49["errored_trials"],
        "harbor_estimated_cost_usd": sum(cost_values) if len(cost_values) == 2 else None,
        "subsets": {
            "first_40": first_40,
            "remaining_49": remaining_49,
        },
    }


def summarize(
    prior_morphz_path: Path,
    prior_codex_path: Path,
    remaining_path: Path,
    resource_samples_path: Path | None = None,
    prior_morphz_job_path: Path | None = None,
    prior_codex_job_path: Path | None = None,
    remaining_morphz_job_path: Path | None = None,
    remaining_codex_job_path: Path | None = None,
) -> dict[str, Any]:
    prior_morphz = load_prior_strict(prior_morphz_path)
    prior_codex = load_prior_strict(prior_codex_path)
    require(set(prior_morphz) == set(prior_codex), "first-40 arm task sets differ")
    remaining_morphz, remaining_codex = load_remaining(remaining_path)
    require(set(remaining_morphz) == set(remaining_codex), "remaining arm task sets differ")
    require(not (set(prior_morphz) & set(remaining_morphz)), "first-40 and remaining-49 overlap")

    morphz = {**prior_morphz, **remaining_morphz}
    codex = {**prior_codex, **remaining_codex}
    require(len(morphz) == 89 and set(morphz) == set(codex), "combined set is not 89 paired tasks")

    tasks = sorted(morphz)
    morphz_wins = sum(morphz[task] > codex[task] for task in tasks)
    codex_wins = sum(codex[task] > morphz[task] for task in tasks)
    both_pass = sum(morphz[task] == codex[task] == 1 for task in tasks)
    both_fail = sum(morphz[task] == codex[task] == 0 for task in tasks)
    morphz_passed = sum(morphz.values())
    codex_passed = sum(codex.values())
    differences = [morphz[task] - codex[task] for task in tasks]

    summary = {
        "protocol": "ME-08-terminal-bench-2.1-all-89-paired-v1",
        "official_verifier_raw_reward_is_primary": True,
        "task_count": 89,
        "arms": {
            "morphz-native": {
                "passed": morphz_passed,
                "score": morphz_passed / 89,
                "wilson_95_ci": wilson_95(morphz_passed, 89),
            },
            "official-codex": {
                "passed": codex_passed,
                "score": codex_passed / 89,
                "wilson_95_ci": wilson_95(codex_passed, 89),
            },
        },
        "paired": {
            "difference": (morphz_passed - codex_passed) / 89,
            "paired_bootstrap_95_ci": paired_bootstrap_95(differences),
            "morphz_wins": morphz_wins,
            "codex_wins": codex_wins,
            "both_pass": both_pass,
            "both_fail": both_fail,
            "exact_two_sided_p": exact_two_sided(morphz_wins, codex_wins),
        },
        "subsets": {
            "first_40": {
                "morphz_passed": sum(prior_morphz.values()),
                "codex_passed": sum(prior_codex.values()),
            },
            "remaining_49": {
                "morphz_passed": sum(remaining_morphz.values()),
                "codex_passed": sum(remaining_codex.values()),
            },
        },
        "per_task": [
            {"task": task, "morphz": morphz[task], "codex": codex[task]}
            for task in tasks
        ],
        "input_sha256": {
            "first_40_morphz_strict_result": sha256(prior_morphz_path),
            "first_40_codex_strict_result": sha256(prior_codex_path),
            "remaining_49_two_arm_summary": sha256(remaining_path),
        },
        "bootstrap": {
            "seed": BOOTSTRAP_SEED,
            "repetitions": BOOTSTRAP_REPETITIONS,
        },
    }
    if resource_samples_path is not None:
        summary["host_resources"] = load_resource_samples(resource_samples_path)
        summary["input_sha256"]["remaining_49_resource_samples"] = sha256(
            resource_samples_path
        )
    job_paths = {
        "first_40_morphz_job_result": prior_morphz_job_path,
        "first_40_codex_job_result": prior_codex_job_path,
        "remaining_49_morphz_job_result": remaining_morphz_job_path,
        "remaining_49_codex_job_result": remaining_codex_job_path,
    }
    if any(path is not None for path in job_paths.values()):
        require(
            all(path is not None for path in job_paths.values()),
            "all four job results are required together",
        )
        prior_morphz_usage = load_job_usage(prior_morphz_job_path, expected_trials=40)
        prior_codex_usage = load_job_usage(prior_codex_job_path, expected_trials=40)
        remaining_morphz_usage = load_job_usage(remaining_morphz_job_path, expected_trials=49)
        remaining_codex_usage = load_job_usage(remaining_codex_job_path, expected_trials=49)
        summary["execution"] = {
            "morphz-native": combine_job_usage(prior_morphz_usage, remaining_morphz_usage),
            "official-codex": combine_job_usage(prior_codex_usage, remaining_codex_usage),
            "cost_note": (
                "Harbor cost fields are nominal estimates; the experiment used subscription/OAuth "
                "routes rather than developer API billing."
            ),
        }
        for label, path in job_paths.items():
            summary["input_sha256"][label] = sha256(path)
    return summary


def result_markdown(summary: dict[str, Any]) -> str:
    morphz = summary["arms"]["morphz-native"]
    codex = summary["arms"]["official-codex"]
    paired = summary["paired"]
    execution_lines = ""
    if "execution" in summary:
        morphz_execution = summary["execution"]["morphz-native"]
        codex_execution = summary["execution"]["official-codex"]
        execution_lines = (
            "- Provider-reported input tokens: "
            f"Morphz {morphz_execution['provider_reported_input_tokens']:,}; "
            f"Codex {codex_execution['provider_reported_input_tokens']:,}\n"
            "- Provider-reported output tokens: "
            f"Morphz {morphz_execution['provider_reported_output_tokens']:,}; "
            f"Codex {codex_execution['provider_reported_output_tokens']:,}\n"
        )
    return f"""# ME-08 Terminal-Bench 2.1 all-89 paired result

- Tasks: 89
- Primary metric: official verifier raw reward
- Morphz: {morphz['passed']}/89 = {morphz['score']:.2%}
- Official Codex: {codex['passed']}/89 = {codex['score']:.2%}
- Paired difference: {paired['difference']:+.2%}
- Morphz-only / Codex-only passes: {paired['morphz_wins']} / {paired['codex_wins']}
- Both pass / both fail: {paired['both_pass']} / {paired['both_fail']}
- Exact two-sided paired p: {paired['exact_two_sided_p']:.6g}
- Paired bootstrap 95% CI: [{paired['paired_bootstrap_95_ci'][0]:+.2%}, {paired['paired_bootstrap_95_ci'][1]:+.2%}]
{execution_lines}

This is a same-environment one-attempt-per-task comparison, not an official
leaderboard submission and not an estimate of within-task sampling variance.
"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prior-morphz", type=Path, required=True)
    parser.add_argument("--prior-codex", type=Path, required=True)
    parser.add_argument("--remaining-summary", type=Path, required=True)
    parser.add_argument("--resource-samples", type=Path)
    parser.add_argument("--prior-morphz-job", type=Path)
    parser.add_argument("--prior-codex-job", type=Path)
    parser.add_argument("--remaining-morphz-job", type=Path)
    parser.add_argument("--remaining-codex-job", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=False)
    summary = summarize(
        args.prior_morphz,
        args.prior_codex,
        args.remaining_summary,
        args.resource_samples,
        args.prior_morphz_job,
        args.prior_codex_job,
        args.remaining_morphz_job,
        args.remaining_codex_job,
    )
    (args.output_dir / "all_89_summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=True) + "\n",
        encoding="utf-8",
    )
    (args.output_dir / "RESULT.md").write_text(result_markdown(summary), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
