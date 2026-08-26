#!/usr/bin/env python3
"""Summarize two completed, contemporaneous full-89 ME-08 jobs.

The official Terminal-Bench verifier ``raw_reward`` is the primary score.  The
repository's trajectory-integrity audit is retained as secondary evidence and
must never overwrite the official reward in this report.
"""

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


EXPECTED_TASKS = 89
BOOTSTRAP_SEED = 20260827
BOOTSTRAP_REPETITIONS = 10_000


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, dict), f"expected JSON object: {path}")
    return value


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def normalize_task(value: Any) -> str:
    require(isinstance(value, str) and value, f"invalid task name: {value!r}")
    return value.removeprefix("terminal-bench/")


def binary_reward(value: Any, *, label: str) -> int:
    reward = float(value)
    require(reward in {0.0, 1.0}, f"non-binary reward for {label}: {reward}")
    return int(reward)


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


def wilson_95(successes: int, total: int) -> list[float]:
    require(total > 0, "Wilson interval requires a positive denominator")
    z = 1.959963984540054
    proportion = successes / total
    denominator = 1.0 + z * z / total
    center = (proportion + z * z / (2.0 * total)) / denominator
    half = z * math.sqrt(
        proportion * (1.0 - proportion) / total
        + z * z / (4.0 * total * total)
    ) / denominator
    return [max(0.0, center - half), min(1.0, center + half)]


def exact_two_sided(first: int, second: int) -> float:
    discordant = first + second
    if discordant == 0:
        return 1.0
    tail = sum(math.comb(discordant, k) for k in range(min(first, second) + 1))
    return min(1.0, 2.0 * tail / (2**discordant))


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


def exception_counts(stats: dict[str, Any]) -> dict[str, int]:
    totals: dict[str, int] = {}
    evals = stats.get("evals") or {}
    require(isinstance(evals, dict), "job stats.evals is not an object")
    for evaluation in evals.values():
        require(isinstance(evaluation, dict), "invalid evaluation stats")
        exceptions = evaluation.get("exception_stats") or {}
        require(isinstance(exceptions, dict), "invalid exception stats")
        for name, trials in exceptions.items():
            require(isinstance(trials, list), f"invalid exception trial list: {name}")
            totals[str(name)] = totals.get(str(name), 0) + len(trials)
    return dict(sorted(totals.items()))


def load_arm(job_dir: Path, *, label: str) -> dict[str, Any]:
    strict_path = job_dir / "strict_result.json"
    result_path = job_dir / "result.json"
    strict = load_json(strict_path)
    result = load_json(result_path)
    require(strict.get("audit_complete") is True, f"audit incomplete: {label}")
    require(strict.get("trial_count") == EXPECTED_TASKS, f"strict count != 89: {label}")
    trials = strict.get("trials")
    require(isinstance(trials, list) and len(trials) == EXPECTED_TASKS, f"invalid trials: {label}")
    require(result.get("n_total_trials") == EXPECTED_TASKS, f"job count != 89: {label}")
    require(result.get("finished_at") is not None, f"job is not finished: {label}")

    rewards: dict[str, int] = {}
    disqualified: list[str] = []
    for row in trials:
        require(isinstance(row, dict), f"invalid strict row: {label}")
        task = normalize_task(row.get("task_name"))
        require(task not in rewards, f"duplicate task in {label}: {task}")
        # Deliberately use raw_reward. A local integrity finding remains an
        # audit annotation and cannot replace the official verifier score.
        rewards[task] = binary_reward(row.get("raw_reward"), label=f"{label}:{task}")
        if row.get("disqualified") is True:
            disqualified.append(task)

    stats = result.get("stats")
    require(isinstance(stats, dict), f"missing job stats: {label}")
    require(int(stats.get("n_running_trials") or 0) == 0, f"running trials remain: {label}")
    require(int(stats.get("n_pending_trials") or 0) == 0, f"pending trials remain: {label}")
    started_at = datetime.fromisoformat(str(result["started_at"]))
    finished_at = datetime.fromisoformat(str(result["finished_at"]))
    require(finished_at >= started_at, f"negative wall time: {label}")

    return {
        "rewards": rewards,
        "passed": sum(rewards.values()),
        "official_score": sum(rewards.values()) / EXPECTED_TASKS,
        "wilson_95_ci": wilson_95(sum(rewards.values()), EXPECTED_TASKS),
        "execution": {
            "started_at": result["started_at"],
            "finished_at": result["finished_at"],
            "wall_time_seconds": (finished_at - started_at).total_seconds(),
            "errored_trials": int(stats.get("n_errored_trials") or 0),
            "retries": int(stats.get("n_retries") or 0),
            "provider_reported_input_tokens": int(stats.get("n_input_tokens") or 0),
            "provider_reported_cache_tokens": int(stats.get("n_cache_tokens") or 0),
            "provider_reported_output_tokens": int(stats.get("n_output_tokens") or 0),
            "harbor_estimated_cost_usd": stats.get("cost_usd"),
            "exception_counts": exception_counts(stats),
        },
        "secondary_local_integrity_audit": {
            "integrity_gate_passed": strict.get("integrity_gate_passed"),
            "disqualified_trial_count": len(disqualified),
            "disqualified_tasks": sorted(disqualified),
            "does_not_override_official_raw_reward": True,
        },
        "sources": {
            "job_result": str(result_path),
            "job_result_sha256": sha256(result_path),
            "strict_result": str(strict_path),
            "strict_result_sha256": sha256(strict_path),
        },
    }


def load_resource_samples(path: Path) -> dict[str, Any]:
    rows = [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    require(rows and all(isinstance(row, dict) for row in rows), f"invalid samples: {path}")
    valid = [row for row in rows if "memory_total_kib" in row and "load_1m" in row]
    require(valid, f"no valid samples: {path}")
    cpu_counts = {int(row["cpu_count"]) for row in valid}
    memory_totals = {int(row["memory_total_kib"]) for row in valid}
    require(len(cpu_counts) == 1 and len(memory_totals) == 1, "host shape changed")
    load_1m = [float(row["load_1m"]) for row in valid]
    memory_used = [
        int(row["memory_total_kib"]) - int(row["memory_available_kib"])
        for row in valid
    ]
    containers = [int(row["docker_running_containers"]) for row in valid]
    return {
        "source": str(path),
        "source_sha256": sha256(path),
        "sample_count": len(valid),
        "first_captured_at": valid[0]["captured_at"],
        "last_captured_at": valid[-1]["captured_at"],
        "cpu_count": next(iter(cpu_counts)),
        "memory_total_kib": next(iter(memory_totals)),
        "load_1m": {
            "mean": statistics.fmean(load_1m),
            "p95": percentile(load_1m, 0.95),
            "max": max(load_1m),
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


def summarize(
    morphz_job: Path,
    codex_job: Path,
    *,
    morphz_resources: Path | None = None,
    codex_resources: Path | None = None,
) -> dict[str, Any]:
    morphz = load_arm(morphz_job, label="morphz")
    codex = load_arm(codex_job, label="codex")
    morphz_rewards = morphz.pop("rewards")
    codex_rewards = codex.pop("rewards")
    require(set(morphz_rewards) == set(codex_rewards), "arm task sets differ")
    require(len(morphz_rewards) == EXPECTED_TASKS, "paired task set is not 89")

    tasks = sorted(morphz_rewards)
    differences = [morphz_rewards[task] - codex_rewards[task] for task in tasks]
    morphz_wins = sum(value > 0 for value in differences)
    codex_wins = sum(value < 0 for value in differences)
    both_pass = sum(morphz_rewards[t] == codex_rewards[t] == 1 for t in tasks)
    both_fail = sum(morphz_rewards[t] == codex_rewards[t] == 0 for t in tasks)
    output: dict[str, Any] = {
        "protocol": "ME-08-terminal-bench-2.1-full-89-contemporaneous-pair-v2",
        "official_verifier_raw_reward_is_primary": True,
        "task_count": EXPECTED_TASKS,
        "attempts_per_task_per_arm": 1,
        "arms": {"morphz": morphz, "official_codex": codex},
        "paired": {
            "difference": (morphz["passed"] - codex["passed"]) / EXPECTED_TASKS,
            "paired_bootstrap_95_ci": paired_bootstrap_95(differences),
            "morphz_wins": morphz_wins,
            "codex_wins": codex_wins,
            "both_pass": both_pass,
            "both_fail": both_fail,
            "discordant_pairs": morphz_wins + codex_wins,
            "exact_two_sided_p": exact_two_sided(morphz_wins, codex_wins),
        },
        "per_task": [
            {"task": task, "morphz": morphz_rewards[task], "codex": codex_rewards[task]}
            for task in tasks
        ],
        "bootstrap": {
            "seed": BOOTSTRAP_SEED,
            "repetitions": BOOTSTRAP_REPETITIONS,
        },
    }
    resources: dict[str, Any] = {}
    if morphz_resources is not None:
        resources["morphz_window"] = load_resource_samples(morphz_resources)
    if codex_resources is not None:
        resources["codex_window"] = load_resource_samples(codex_resources)
    if resources:
        output["host_resources"] = resources
    return output


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--morphz-job", type=Path, required=True)
    parser.add_argument("--codex-job", type=Path, required=True)
    parser.add_argument("--morphz-resources", type=Path)
    parser.add_argument("--codex-resources", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = summarize(
        args.morphz_job,
        args.codex_job,
        morphz_resources=args.morphz_resources,
        codex_resources=args.codex_resources,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(result, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
