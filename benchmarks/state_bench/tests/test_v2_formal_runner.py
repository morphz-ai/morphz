from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from state_bench.agents.base import AgentRuntimeContext

from benchmarks.state_bench.v2 import public_agent_systems
from benchmarks.state_bench.v2.prepare_evaluator_human_validation import (
    ALLOCATION,
    _select,
)
from benchmarks.state_bench.v2.run_public_systems_formal import ARMS, DOMAINS, _queue
from benchmarks.state_bench.v2.summarize_public_systems_formal import (
    _bootstrap_ci,
    _holm,
    _job_score,
    _sign_flip_pvalue,
)


def _context(task_id: str) -> AgentRuntimeContext:
    return AgentRuntimeContext(
        task_id=task_id,
        user_id="user-1",
        domain="travel",
        now="2026-08-26T00:00:00Z",
    )


def test_trial_runtime_binding_is_thread_local(tmp_path: Path) -> None:
    def bind(index: int) -> tuple[str | None, int | None, str | None]:
        context = _context(f"task-{index}")
        output = tmp_path / f"run-{index}"
        output.mkdir()
        with public_agent_systems.bind_trial_runtime(
            output_dir=output,
            run_idx=index,
            trial_id=f"trial-{index}",
        ):
            public_agent_systems._apply_trial_runtime(context)
        return (
            context.output_dir,
            context.run_idx,
            context.config.get("me07_trial_id"),
        )

    with ThreadPoolExecutor(max_workers=3) as executor:
        values = list(executor.map(bind, (1, 2, 3)))

    assert values == [
        (str((tmp_path / "run-1").resolve()), 1, "trial-1"),
        (str((tmp_path / "run-2").resolve()), 2, "trial-2"),
        (str((tmp_path / "run-3").resolve()), 3, "trial-3"),
    ]
    unbound = _context("unbound")
    public_agent_systems._apply_trial_runtime(unbound)
    assert unbound.output_dir is None
    assert unbound.run_idx is None
    assert unbound.config == {}


def test_formal_queue_is_deterministic_and_complete(monkeypatch) -> None:
    task_ids = [f"task-{index:02d}" for index in range(1, 51)]
    monkeypatch.setattr(
        "benchmarks.state_bench.v2.run_public_systems_formal.load_split_task_ids",
        lambda _domain, split, _version: task_ids if split == "test" else [],
    )
    protocol = type("Protocol", (), {"split_version": "frozen"})()

    first = _queue(protocol, 5)
    second = _queue(protocol, 5)

    assert first == second
    assert len(first) == 5 * len(DOMAINS) * 50
    assert [cell["cell_index"] for cell in first] == list(range(1, 751))
    assert all(set(cell["arm_order"]) == set(ARMS) for cell in first)
    assert len({cell["cell_id"] for cell in first}) == len(first)
    for run_idx in range(1, 6):
        for domain in DOMAINS:
            assert (
                sum(
                    cell["run_idx"] == run_idx and cell["domain"] == domain
                    for cell in first
                )
                == 50
            )


def test_formal_statistics_are_paired_and_failures_count_as_zero(monkeypatch) -> None:
    monkeypatch.setattr(
        "benchmarks.state_bench.v2.summarize_public_systems_formal.RESAMPLES", 1000
    )
    scored = _job_score(
        {
            "elapsed_seconds": 12,
            "trajectory": {
                "task_completion_pass": 1,
                "state_requirements_met": 1,
                "task_requirements_met": 1,
                "ux_score": 2.5,
                "token_usage": {"total_tokens": 123},
            },
        }
    )
    failed = _job_score({"elapsed_seconds": 4, "trajectory": None})

    assert scored == {
        "completion": 1.0,
        "state": 1.0,
        "task": 1.0,
        "ux": 2.5,
        "tokens": 123.0,
        "elapsed": 12.0,
        "scored": 1.0,
    }
    assert failed["completion"] == 0
    assert failed["scored"] == 0
    assert _bootstrap_ci([0.2] * 10) == [0.2, 0.2]
    assert 0 < _sign_flip_pvalue([1.0] * 10) < 0.01
    assert _holm({"first": 0.01, "second": 0.04}) == {
        "first": 0.02,
        "second": 0.04,
    }


def test_human_validation_selection_is_balanced_and_task_unique() -> None:
    jobs = [
        {
            "domain": domain,
            "arm": arm,
            "task_id": f"{domain}-task-{task_index:02d}",
            "run_idx": run_idx,
        }
        for domain in ALLOCATION
        for arm in ARMS
        for task_index in range(1, 21)
        for run_idx in range(1, 6)
    ]

    selected = _select(jobs)

    assert len(selected) == 30
    assert len({(job["domain"], job["task_id"]) for job in selected}) == 30
    for domain, arm_counts in ALLOCATION.items():
        for arm, expected in arm_counts.items():
            assert (
                sum(job["domain"] == domain and job["arm"] == arm for job in selected)
                == expected
            )
