"""Validate and summarize the frozen ME-07 confirmatory batch."""

from __future__ import annotations

import argparse
import json
import math
import random
from collections import defaultdict
from pathlib import Path
from typing import Any

from benchmarks.state_bench.v2.run_public_systems_formal import ARMS, PROTOCOL_ID

BOOTSTRAP_SEED = 7_007_026
PERMUTATION_SEED = 7_107_026
RESAMPLES = 100_000


def _quantile(values: list[float], probability: float) -> float:
    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] * (1 - fraction) + ordered[upper] * fraction


def _bootstrap_ci(differences: list[float]) -> list[float]:
    randomizer = random.Random(BOOTSTRAP_SEED)
    count = len(differences)
    values = [
        sum(differences[randomizer.randrange(count)] for _ in range(count)) / count
        for _ in range(RESAMPLES)
    ]
    return [_quantile(values, 0.025), _quantile(values, 0.975)]


def _sign_flip_pvalue(differences: list[float]) -> float:
    observed = abs(sum(differences) / len(differences))
    randomizer = random.Random(PERMUTATION_SEED)
    extreme = 0
    for _ in range(RESAMPLES):
        permuted = sum(
            value if randomizer.getrandbits(1) else -value for value in differences
        ) / len(differences)
        if abs(permuted) >= observed - 1e-15:
            extreme += 1
    return (extreme + 1) / (RESAMPLES + 1)


def _holm(pvalues: dict[str, float]) -> dict[str, float]:
    ordered = sorted(pvalues.items(), key=lambda item: item[1])
    adjusted: dict[str, float] = {}
    running = 0.0
    total = len(ordered)
    for index, (name, value) in enumerate(ordered):
        candidate = min(1.0, (total - index) * value)
        running = max(running, candidate)
        adjusted[name] = running
    return adjusted


def _numeric(value: object, default: float = 0.0) -> float:
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    return default


def _morphz_training_baselines(root: Path) -> dict[str, int]:
    """Return cumulative training tokens embedded in each cloned domain DB.

    Morphz evaluation tasks clone a trained SQLite database.  The Runtime turn
    receipt reports cumulative usage from that database, so the first held-out
    turn includes the same 100-episode training total in every clone.  Subtract
    that immutable baseline once per scored clone while preserving the raw
    cumulative value for audit.
    """

    baselines: dict[str, int] = {}
    for path in sorted(root.rglob("*-morphz-training-receipt.json")):
        value = json.loads(path.read_text(encoding="utf-8"))
        domain = str(value.get("domain", ""))
        episodes = value.get("episodes")
        if not domain or not isinstance(episodes, list) or len(episodes) != 100:
            raise RuntimeError(f"invalid Morphz training receipt: {path}")
        total = 0
        for episode in episodes:
            usage = episode.get("usage") if isinstance(episode, dict) else None
            if not isinstance(usage, dict):
                raise TypeError(f"missing episode usage in {path}")
            total += int(usage.get("total_tokens", 0))
        if domain in baselines:
            raise RuntimeError(f"duplicate Morphz training receipt for {domain}")
        baselines[domain] = total
    expected = {"customer_support", "shopping_assistant", "travel"}
    if set(baselines) != expected:
        raise RuntimeError(
            f"expected Morphz training baselines for {sorted(expected)}, got {baselines}"
        )
    return baselines


def _job_score(job: dict[str, Any]) -> dict[str, float]:
    trajectory = job.get("trajectory")
    if job.get("official_score_eligible") is not True or not isinstance(
        trajectory, dict
    ):
        return {
            "completion": 0.0,
            "state": 0.0,
            "task": 0.0,
            "ux": 0.0,
            "tokens": 0.0,
            "raw_tokens": 0.0,
            "elapsed": _numeric(job.get("elapsed_seconds")),
            "scored": 0.0,
        }
    token_usage = trajectory.get("token_usage")
    tokens = (
        _numeric(token_usage.get("total_tokens"))
        if isinstance(token_usage, dict)
        else 0.0
    )
    completion = trajectory.get("task_completion_pass")
    scored = completion in {0, 1}
    raw_tokens = tokens
    adjusted = job.get("_evaluation_total_tokens")
    if isinstance(adjusted, int):
        tokens = float(adjusted)
    return {
        "completion": _numeric(completion) if scored else 0.0,
        "state": _numeric(trajectory.get("state_requirements_met")),
        "task": _numeric(trajectory.get("task_requirements_met")),
        "ux": _numeric(trajectory.get("ux_score")),
        "tokens": tokens,
        "raw_tokens": raw_tokens,
        "elapsed": _numeric(job.get("elapsed_seconds")),
        "scored": float(scored),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-root", type=Path, required=True)
    parser.add_argument(
        "--morphz-training-receipts",
        type=Path,
        help="Frozen training receipts used to correct cloned cumulative usage",
    )
    parser.add_argument("--output-json", type=Path)
    parser.add_argument("--output-markdown", type=Path)
    args = parser.parse_args()

    root = args.run_root.resolve(strict=True)
    morphz_training_baselines = (
        _morphz_training_baselines(
            args.morphz_training_receipts.resolve(strict=True)
        )
        if args.morphz_training_receipts
        else {}
    )
    queue_value = json.loads((root / "queue.json").read_text(encoding="utf-8"))
    if queue_value.get("protocol_id") != PROTOCOL_ID:
        raise RuntimeError("ME-07 queue protocol mismatch")
    num_runs = int(queue_value.get("num_runs", 0))
    if num_runs != 1:
        raise RuntimeError(f"amended ME-07 result requires one run, got {num_runs}")
    cells = queue_value.get("cells")
    expected_cells = 150 * num_runs
    if not isinstance(cells, list) or len(cells) != expected_cells:
        raise RuntimeError(
            f"expected {expected_cells} paired cells, got {len(cells or [])}"
        )

    jobs: dict[tuple[str, str, int, str], dict[str, Any]] = {}
    integrity_errors: list[str] = []
    for cell in cells:
        domain = str(cell["domain"])
        task_id = str(cell["task_id"])
        run_idx = int(cell["run_idx"])
        for arm in ARMS:
            path = root / "jobs" / str(cell["cell_id"]) / f"{arm}.json"
            if not path.is_file():
                integrity_errors.append(f"missing:{cell['cell_id']}:{arm}")
                continue
            value = json.loads(path.read_text(encoding="utf-8"))
            expected = {
                "protocol_id": PROTOCOL_ID,
                "terminal": True,
                "cell_id": cell["cell_id"],
                "arm": arm,
                "domain": domain,
                "task_id": task_id,
                "run_idx": run_idx,
            }
            mismatches = {
                key: (value.get(key), expected_value)
                for key, expected_value in expected.items()
                if value.get(key) != expected_value
            }
            if mismatches:
                integrity_errors.append(
                    f"mismatch:{cell['cell_id']}:{arm}:{mismatches}"
                )
                continue
            if (
                arm == "morphz"
                and morphz_training_baselines
                and value.get("official_score_eligible") is True
            ):
                trajectory = value.get("trajectory")
                if isinstance(trajectory, dict):
                    usage = trajectory.get("token_usage")
                    if isinstance(usage, dict):
                        raw_total = int(usage.get("total_tokens", 0))
                        baseline = morphz_training_baselines[domain]
                        if raw_total < baseline:
                            integrity_errors.append(
                                "morphz_token_baseline_exceeds_raw:"
                                f"{cell['cell_id']}:{raw_total}:{baseline}"
                            )
                            continue
                        value["_evaluation_total_tokens"] = raw_total - baseline
            jobs[(domain, task_id, run_idx, arm)] = value
    if integrity_errors:
        raise RuntimeError(
            "ME-07 formal artifacts failed integrity checks: "
            + "; ".join(integrity_errors[:20])
        )
    expected_jobs = expected_cells * len(ARMS)
    if len(jobs) != expected_jobs:
        raise RuntimeError(f"expected {expected_jobs} terminal jobs, got {len(jobs)}")

    task_scores: dict[tuple[str, str], dict[str, list[float]]] = defaultdict(
        lambda: defaultdict(list)
    )
    arm_trials: dict[str, list[dict[str, float]]] = defaultdict(list)
    for (domain, task_id, _run_idx, arm), job in jobs.items():
        score = _job_score(job)
        arm_trials[arm].append(score)
        task_scores[(domain, task_id)][arm].append(score["completion"])

    arm_summary: dict[str, Any] = {}
    for arm in ARMS:
        trials = arm_trials[arm]
        clusters = [
            values[arm]
            for values in task_scores.values()
            if arm in values and len(values[arm]) == num_runs
        ]
        if len(trials) != expected_cells or len(clusters) != 150:
            raise RuntimeError(
                f"incomplete arm {arm}: {len(trials)} trials, {len(clusters)} tasks"
            )
        arm_summary[arm] = {
            "trials": len(trials),
            "tasks": len(clusters),
            "task_completion_pass@1": sum(score["completion"] for score in trials)
            / len(trials),
            "task_completion_all_runs": sum(
                all(value == 1 for value in cluster) for cluster in clusters
            )
            / len(clusters),
            "state_pass@1": sum(score["state"] for score in trials) / len(trials),
            "task_requirements_pass@1": sum(score["task"] for score in trials)
            / len(trials),
            "ux_mean": sum(score["ux"] for score in trials) / len(trials),
            "scored_trajectories": int(sum(score["scored"] for score in trials)),
            "terminal_failures_counted_as_zero": int(
                sum(1 for score in trials if not score["scored"])
            ),
            "agent_total_tokens": int(sum(score["tokens"] for score in trials)),
            "agent_total_tokens_raw": int(
                sum(score["raw_tokens"] for score in trials)
            ),
            "agent_total_tokens_scope": (
                "heldout_evaluation_after_cloned_training_baseline_subtraction"
                if arm == "morphz" and morphz_training_baselines
                else "heldout_evaluation_provider_reported"
            ),
            "elapsed_seconds": sum(score["elapsed"] for score in trials),
        }

    contrasts: dict[str, Any] = {}
    raw_pvalues: dict[str, float] = {}
    for comparator in ("letta", "mem0"):
        name = f"morphz_minus_{comparator}"
        differences = []
        for values in task_scores.values():
            morphz = values["morphz"]
            other = values[comparator]
            differences.append(
                sum(morphz) / num_runs - sum(other) / num_runs
            )
        estimate = sum(differences) / len(differences)
        pvalue = _sign_flip_pvalue(differences)
        raw_pvalues[name] = pvalue
        contrasts[name] = {
            "estimate": estimate,
            "cluster_bootstrap_95_ci": _bootstrap_ci(differences),
            "paired_sign_flip_pvalue": pvalue,
            "task_clusters": len(differences),
        }
    adjusted = _holm(raw_pvalues)
    for name, value in adjusted.items():
        contrasts[name]["holm_adjusted_pvalue"] = value

    summary = {
        "protocol_id": PROTOCOL_ID,
        "kind": "formal_confirmatory_result",
        "reportable_score": True,
        "primary_metric": "updated_protocol_task_completion_pass@1",
        "num_runs": num_runs,
        "arm_summary": arm_summary,
        "paired_contrasts": contrasts,
        "statistics": {
            "cluster_unit": "heldout_task",
            "bootstrap_resamples": RESAMPLES,
            "bootstrap_seed": BOOTSTRAP_SEED,
            "permutation_resamples": RESAMPLES,
            "permutation_seed": PERMUTATION_SEED,
            "multiple_comparison_correction": "holm",
        },
        "token_accounting": {
            "morphz_training_baseline_total_tokens_by_domain": (
                morphz_training_baselines
            ),
            "morphz_raw_values_are_cumulative_clone_counters": bool(
                morphz_training_baselines
            ),
            "morphz_reported_agent_total_tokens_subtracts_one_domain_training_baseline_per_scored_clone": bool(
                morphz_training_baselines
            ),
            "training_cost_excluded_from_all_three_heldout_arms": True,
        },
        "integrity": {
            "paired_cells": len(cells),
            "terminal_jobs": len(jobs),
            "passed": True,
        },
    }
    output_json = args.output_json or root / "formal_summary.json"
    output_markdown = args.output_markdown or root / "RESULT.md"
    output_json.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    lines = [
        "# ME-07 formal confirmatory result",
        "",
        f"Protocol: `{PROTOCOL_ID}`",
        "",
        "| Arm | pass@1 | all runs pass | state | task req. | UX | terminal failures |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for arm in ARMS:
        value = arm_summary[arm]
        lines.append(
            f"| {arm} | {value['task_completion_pass@1']:.3f} | "
            f"{value['task_completion_all_runs']:.3f} | {value['state_pass@1']:.3f} | "
            f"{value['task_requirements_pass@1']:.3f} | {value['ux_mean']:.3f} | "
            f"{value['terminal_failures_counted_as_zero']} |"
        )
    lines.extend(
        [
            "",
            "| Paired contrast | Difference | 95% clustered bootstrap CI | raw p | Holm p |",
            "| --- | ---: | ---: | ---: | ---: |",
        ]
    )
    for name, value in contrasts.items():
        low, high = value["cluster_bootstrap_95_ci"]
        lines.append(
            f"| {name} | {value['estimate']:+.3f} | [{low:+.3f}, {high:+.3f}] | "
            f"{value['paired_sign_flip_pvalue']:.4g} | "
            f"{value['holm_adjusted_pvalue']:.4g} |"
        )
    lines.extend(
        [
            "",
            "| Arm | Held-out Agent tokens | Raw token counter | Accounting scope |",
            "| --- | ---: | ---: | --- |",
        ]
    )
    for arm in ARMS:
        value = arm_summary[arm]
        lines.append(
            f"| {arm} | {value['agent_total_tokens']:,} | "
            f"{value['agent_total_tokens_raw']:,} | "
            f"{value['agent_total_tokens_scope']} |"
        )
    lines.extend(
        [
            "",
            (
                "All terminal harness/provider failures are retained and scored as "
                "zero. This updated-evaluator result is not an official STATE-Bench "
                "leaderboard score."
            ),
            (
                "Morphz raw token counters include the cumulative 100-episode "
                "training history embedded in every cloned domain database. The "
                "held-out Morphz total deterministically subtracts that frozen "
                "domain baseline once per scored clone; the raw value is retained "
                "for audit. Training cost is excluded from all three arms."
            ),
            "",
        ]
    )
    output_markdown.write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
