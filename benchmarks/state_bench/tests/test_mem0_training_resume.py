from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from benchmarks.state_bench.v2 import mem0_train_snapshots


def _episode(path: Path, _domain: str) -> tuple[dict[str, str], str]:
    return (
        {
            "task_id": path.stem,
            "source_sha256": f"sha-{path.stem}",
        },
        "serialized",
    )


def _memory(task_id: str, *, digest: str | None = None) -> dict[str, object]:
    return {
        "id": f"memory-{task_id}",
        "metadata": {
            "protocol_id": mem0_train_snapshots.PROTOCOL_ID,
            "source_partition": "train_task_trajectories",
            "source_task_id": task_id,
            "source_sha256": digest or f"sha-{task_id}",
        },
    }


@patch.object(mem0_train_snapshots, "load_canonical_episode", side_effect=_episode)
def test_resume_prefix_requires_exact_contiguous_durable_witnesses(_load) -> None:
    files = [Path("one.json"), Path("two.json"), Path("three.json")]

    recovered = mem0_train_snapshots._resume_prefix(
        files=files,
        domain="travel",
        memories=[_memory("one"), _memory("two")],
        expected_count=2,
    )

    assert [episode["task_id"] for episode in recovered] == ["one", "two"]
    assert all(episode["recovered_from_durable_snapshot"] for episode in recovered)


@patch.object(mem0_train_snapshots, "load_canonical_episode", side_effect=_episode)
def test_resume_prefix_rejects_missing_or_wrong_digest(_load) -> None:
    files = [Path("one.json"), Path("two.json"), Path("three.json")]

    with pytest.raises(RuntimeError, match="lacks an exact durable witness"):
        mem0_train_snapshots._resume_prefix(
            files=files,
            domain="travel",
            memories=[_memory("one"), _memory("two", digest="wrong")],
            expected_count=2,
        )


@patch.object(mem0_train_snapshots, "load_canonical_episode", side_effect=_episode)
def test_resume_prefix_rejects_sources_after_declared_boundary(_load) -> None:
    files = [Path("one.json"), Path("two.json"), Path("three.json")]

    with pytest.raises(RuntimeError, match="after/outside"):
        mem0_train_snapshots._resume_prefix(
            files=files,
            domain="travel",
            memories=[_memory("one"), _memory("two"), _memory("three")],
            expected_count=2,
        )
