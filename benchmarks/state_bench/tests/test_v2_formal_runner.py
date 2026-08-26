from __future__ import annotations

import hashlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier, Lock
from time import sleep

from state_bench.agents.base import AgentRuntimeContext
from state_bench.protocol import load_default_protocol, load_split_task_ids

from benchmarks.state_bench.v2 import public_agent_systems, run_public_systems_formal
from benchmarks.state_bench.v2.letta_train_snapshots import (
    _read_checkpoint,
    _write_checkpoint,
)
from benchmarks.state_bench.v2.prepare_evaluator_human_validation import (
    ALLOCATION,
    _select,
)
from benchmarks.state_bench.v2.run_public_systems_formal import (
    ARMS,
    DOMAINS,
    EXPECTED_MORPHZ_BINARY_SHA256_BY_PLATFORM,
    _queue,
    _run_job,
)
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

    first = _queue(protocol, 1)
    second = _queue(protocol, 1)

    assert first == second
    assert len(first) == len(DOMAINS) * 50
    assert [cell["cell_index"] for cell in first] == list(range(1, 151))
    assert all(set(cell["arm_order"]) == set(ARMS) for cell in first)
    assert len({cell["cell_id"] for cell in first}) == len(first)
    for domain in DOMAINS:
        assert (
            sum(cell["run_idx"] == 1 and cell["domain"] == domain for cell in first)
            == 50
        )


def test_formal_batch_runs_four_isolated_cells_concurrently(
    monkeypatch, tmp_path: Path
) -> None:
    barrier = Barrier(4)
    lock = Lock()
    active = 0
    peak = 0

    def fake_run_cell(**kwargs):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
        barrier.wait(timeout=5)
        sleep(0.01)
        with lock:
            active -= 1
        return [("morphz", {"runner_result": {"status": "OK"}})]

    monkeypatch.setattr(run_public_systems_formal, "_run_cell", fake_run_cell)
    cells = [
        {"cell_id": f"cell-{index:04d}", "cell_index": index} for index in range(1, 5)
    ]

    results = run_public_systems_formal._run_cell_batch(
        output=tmp_path,
        cells=cells,
        protocol=object(),
        cell_workers=4,
        paired_workers=3,
    )

    assert len(results) == 4
    assert peak == 4


def test_formal_runtime_hashes_are_frozen_per_execution_platform() -> None:
    assert EXPECTED_MORPHZ_BINARY_SHA256_BY_PLATFORM == {
        ("Darwin", "arm64"): (
            "0666fd3c0e49b2365d923d9589229ed6e37d6d47bbabc6bfcf0e0a45d53fa31a"
        ),
        ("Linux", "x86_64"): (
            "98a7ed2458d7dd3d086b9f5ddfbe682902f96dcb879c5719054afb70f57c2691"
        ),
    }


def test_formal_statistics_are_paired_and_failures_count_as_zero(monkeypatch) -> None:
    monkeypatch.setattr(
        "benchmarks.state_bench.v2.summarize_public_systems_formal.RESAMPLES", 1000
    )
    scored = _job_score(
        {
            "elapsed_seconds": 12,
            "official_score_eligible": True,
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
        for run_idx in (1,)
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


def test_letta_checkpoint_is_single_file_and_digest_guarded(tmp_path: Path) -> None:
    exported = '{"agent":"state"}'
    progress = {
        "protocol_id": "ME-07-STATE-Bench-public-agent-systems-v2",
        "domain": "travel",
        "snapshot_sha256": hashlib.sha256(exported.encode()).hexdigest(),
        "episodes": [],
    }
    checkpoint = tmp_path / "travel.zip"

    _write_checkpoint(checkpoint, exported, progress)

    restored_export, restored_progress = _read_checkpoint(checkpoint)
    assert restored_export == exported
    assert restored_progress == progress


def test_orphaned_trajectory_is_preserved_as_zero_without_rerun(
    tmp_path: Path,
) -> None:
    protocol = load_default_protocol()
    task_id = load_split_task_ids("travel", "test", protocol.split_version)[0]
    cell = {
        "cell_id": f"cell-0001-r1-travel-{task_id}",
        "cell_index": 1,
        "domain": "travel",
        "task_id": task_id,
        "run_idx": 1,
    }
    trajectory_path = (
        tmp_path / "trajectories" / "morphz" / "travel" / "run1" / f"{task_id}.json"
    )
    trajectory_path.parent.mkdir(parents=True)
    trajectory_path.write_text(
        '{"task_id":"' + task_id + '","task_completion_pass":1,"ux_score":5,'
        '"me07_agent_system":{"arm":"morphz"}}\n',
        encoding="utf-8",
    )

    result = _run_job(
        output=tmp_path,
        cell=cell,
        arm="morphz",
        protocol=protocol,
    )

    assert result["official_score_eligible"] is False
    assert result["runner_result"]["status"] == "ERR"
    assert result["trajectory"]["task_completion_pass"] == 1
    assert (tmp_path / "jobs" / cell["cell_id"] / "morphz.json").is_file()
