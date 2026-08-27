from __future__ import annotations

import json
from pathlib import Path

import pytest

from benchmarks.harbor.summarize_me08_full89_pair import summarize


def write_arm(root: Path, name: str, rewards: dict[str, int], *, disqualify: str | None = None) -> Path:
    job = root / name
    job.mkdir()
    trials = []
    for task, reward in rewards.items():
        disqualified = task == disqualify
        trials.append(
            {
                "task_name": f"terminal-bench/{task}",
                "raw_reward": float(reward),
                "strict_reward": 0.0 if disqualified else float(reward),
                "disqualified": disqualified,
            }
        )
    (job / "strict_result.json").write_text(
        json.dumps(
            {
                "audit_complete": True,
                "trial_count": 89,
                "integrity_gate_passed": disqualify is None,
                "trials": trials,
            }
        ),
        encoding="utf-8",
    )
    (job / "result.json").write_text(
        json.dumps(
            {
                "n_total_trials": 89,
                "started_at": "2026-08-27T00:00:00+08:00",
                "finished_at": "2026-08-27T01:00:00+08:00",
                "stats": {
                    "n_running_trials": 0,
                    "n_pending_trials": 0,
                    "n_errored_trials": 0,
                    "n_retries": 0,
                    "n_input_tokens": 100,
                    "n_cache_tokens": 80,
                    "n_output_tokens": 20,
                    "cost_usd": 1.0,
                    "evals": {},
                },
            }
        ),
        encoding="utf-8",
    )
    return job


def test_official_raw_reward_remains_primary(tmp_path: Path) -> None:
    tasks = {f"task-{index:02d}": 1 for index in range(89)}
    morphz = write_arm(tmp_path, "morphz", tasks, disqualify="task-00")
    codex = write_arm(tmp_path, "codex", tasks)

    result = summarize(morphz, codex)

    assert result["arms"]["morphz"]["passed"] == 89
    assert result["arms"]["morphz"]["official_score"] == 1.0
    audit = result["arms"]["morphz"]["secondary_local_integrity_audit"]
    assert audit["disqualified_trial_count"] == 1
    assert audit["does_not_override_official_raw_reward"] is True
    assert result["paired"]["difference"] == 0.0


def test_task_set_mismatch_is_rejected(tmp_path: Path) -> None:
    morphz_tasks = {f"task-{index:02d}": 1 for index in range(89)}
    codex_tasks = {f"task-{index:02d}": 1 for index in range(88)}
    codex_tasks["different-task"] = 1
    morphz = write_arm(tmp_path, "morphz", morphz_tasks)
    codex = write_arm(tmp_path, "codex", codex_tasks)

    with pytest.raises(RuntimeError, match="task sets differ"):
        summarize(morphz, codex)
