#!/usr/bin/env python3
"""Summarize a completed frozen four-arm Terminal-Bench phase."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any


ARMS = (
    "morphz-native",
    "morphz-v0.5",
    "morphz-dialectical-practice",
    "official-codex",
)
PAIRS = (
    ("morphz-v0.5", "morphz-native"),
    ("morphz-dialectical-practice", "morphz-v0.5"),
    ("official-codex", "morphz-native"),
)


def _strict_result(arm_root: Path) -> tuple[Path, dict[str, Any]]:
    candidates = sorted(arm_root.glob("*/strict_result.json"))
    if len(candidates) != 1:
        raise RuntimeError(
            f"expected one strict_result.json below {arm_root}, found {len(candidates)}"
        )
    return candidates[0], json.loads(candidates[0].read_text(encoding="utf-8"))


def _task_rewards(result: dict[str, Any]) -> dict[str, float]:
    rewards: dict[str, float] = {}
    for trial in result["trials"]:
        task = str(trial["task_name"]).removeprefix("terminal-bench/")
        if task in rewards:
            raise RuntimeError(f"duplicate task {task}")
        rewards[task] = float(trial["strict_reward"])
    return rewards


def exact_two_sided_binomial(wins: int, losses: int) -> float | None:
    discordant = wins + losses
    if discordant == 0:
        return None
    tail = min(wins, losses)
    probability = sum(math.comb(discordant, k) for k in range(tail + 1)) / (
        2**discordant
    )
    return min(1.0, 2.0 * probability)


def summarize(phase_root: Path) -> dict[str, Any]:
    launcher_result_path = phase_root / "launcher_result.json"
    launcher = json.loads(launcher_result_path.read_text(encoding="utf-8"))
    if not launcher.get("gate_passed"):
        raise RuntimeError("launcher gate did not pass")

    sources: dict[str, str] = {}
    arm_results: dict[str, Any] = {}
    task_rewards: dict[str, dict[str, float]] = {}
    for arm in ARMS:
        path, result = _strict_result(phase_root / "jobs" / arm)
        sources[arm] = str(path.resolve())
        if not result.get("integrity_gate_passed"):
            raise RuntimeError(f"integrity gate did not pass for {arm}")
        rewards = _task_rewards(result)
        task_rewards[arm] = rewards
        arm_results[arm] = {
            "trial_count": result["trial_count"],
            "raw_mean_reward": result["raw_mean_reward"],
            "strict_mean_reward": result["strict_mean_reward"],
            "strict_pass_count": sum(value == 1.0 for value in rewards.values()),
            "disqualified_trials": result["disqualified_trials"],
            "integrity_gate_passed": True,
        }

    task_sets = {arm: set(rewards) for arm, rewards in task_rewards.items()}
    if len({frozenset(tasks) for tasks in task_sets.values()}) != 1:
        raise RuntimeError(f"arm task sets differ: {task_sets}")

    paired: dict[str, Any] = {}
    for treatment, control in PAIRS:
        treatment_wins = 0
        control_wins = 0
        ties_pass = 0
        ties_fail = 0
        for task in sorted(task_sets[treatment]):
            left = task_rewards[treatment][task]
            right = task_rewards[control][task]
            if left > right:
                treatment_wins += 1
            elif right > left:
                control_wins += 1
            elif left == 1.0:
                ties_pass += 1
            else:
                ties_fail += 1
        paired[f"{treatment}_minus_{control}"] = {
            "treatment": treatment,
            "control": control,
            "treatment_wins": treatment_wins,
            "control_wins": control_wins,
            "ties_both_pass": ties_pass,
            "ties_both_fail": ties_fail,
            "discordant_pairs": treatment_wins + control_wins,
            "exact_two_sided_binomial_p": exact_two_sided_binomial(
                treatment_wins, control_wins
            ),
            "strict_mean_difference": (
                float(arm_results[treatment]["strict_mean_reward"])
                - float(arm_results[control]["strict_mean_reward"])
            ),
        }

    return {
        "protocol": "terminal-bench-four-arm-prior-40-v1",
        "phase": launcher["phase"],
        "launcher_gate_passed": True,
        "strict_result_sources": sources,
        "arms": arm_results,
        "paired_comparisons": paired,
        "task_rewards": task_rewards,
        "interpretation_scope": (
            "previously observed development tasks; not an unseen estimate or "
            "a Terminal-Bench leaderboard score"
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("phase_root", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    summary = summarize(args.phase_root)
    output = args.output or args.phase_root / "four_arm_summary.json"
    output.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(output)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError) as error:
        raise SystemExit(f"four-arm summary failed: {error}") from error
