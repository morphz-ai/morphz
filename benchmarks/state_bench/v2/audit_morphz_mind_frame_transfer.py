"""Audit Mind Frame transfer evidence in a completed ME-07 Morphz arm.

The audit is intentionally read-only and does not rescore trajectories.  It
checks whether each held-out task ran against the final structured Context
created by the corresponding domain-training session.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from benchmarks.state_bench.v2.run_public_systems_formal import PROTOCOL_ID


def _open_read_only(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def _one_runtime_db(runtime_roots: list[Path], domain: str, task_id: str) -> Path:
    """Find the DB from the current batch or its preserved one-run prefix.

    The amended one-run protocol retained the first 31 completed cells from the
    original five-run queue instead of rerunning them.  Their immutable Runtime
    DBs therefore remain under the original run root, while the remaining cells
    live under the amended root.  Prefer the current root and consult the
    explicitly supplied fallback roots only when the current root has no match.
    """

    for runtime_root in runtime_roots:
        matches = sorted(runtime_root.glob(f"{domain}-{task_id}-1-*/morphz.sqlite"))
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise RuntimeError(
                "expected at most one Morphz Runtime DB in "
                f"{runtime_root} for {domain}/{task_id}, got {matches}"
            )
    raise RuntimeError(
        f"missing Morphz Runtime DB for {domain}/{task_id} in {runtime_roots}"
    )


def _state_counts(state_json: str, *, source: Path) -> dict[str, int]:
    state = json.loads(state_json)
    frames = state.get("frames")
    relations = state.get("relations")
    retired = state.get("retired")
    if not isinstance(frames, list) or not isinstance(relations, list):
        raise TypeError(f"{source}: malformed structured Context projection")
    if not isinstance(retired, list):
        retired = []
    return {
        "active_mind_frames": len(frames),
        "active_relations": len(relations),
        "retired_objects": len(retired),
    }


def _domain_baseline(snapshot_root: Path, domain: str) -> dict[str, Any]:
    path = snapshot_root / f"{domain}.sqlite"
    path.resolve(strict=True)
    training_session = f"me07-{domain}-training-session"
    with _open_read_only(path) as connection:
        projection = connection.execute(
            "SELECT context_id, revision, state_json, state_hash FROM mind_projections"
        ).fetchall()
        if len(projection) != 1:
            raise RuntimeError(f"{path}: expected one Mind projection")
        training_commits = connection.execute(
            """
            SELECT payload
            FROM events
            WHERE session_id = ? AND topic = 'chat/context_tx_committed'
            ORDER BY timestamp
            """,
            (training_session,),
        ).fetchall()
    payloads = [json.loads(str(row[0])) for row in training_commits]
    if not payloads:
        raise RuntimeError(f"{path}: no training Context transactions")
    final_payload = payloads[-1]
    baseline = {
        "domain": domain,
        "snapshot_artifact": path.name,
        "context_id": str(projection[0]["context_id"]),
        "revision": int(projection[0]["revision"]),
        "state_hash": str(projection[0]["state_hash"]),
        "projection_state_sha256": hashlib.sha256(
            str(projection[0]["state_json"]).encode()
        ).hexdigest(),
        "training_context_transactions": len(payloads),
        **_state_counts(str(projection[0]["state_json"]), source=path),
    }
    baseline["training_head_matches_projection"] = (
        int(final_payload.get("after_version", -1)) == baseline["revision"]
        and str(final_payload.get("after_hash", "")) == baseline["state_hash"]
    )
    return baseline


def _audit_db(
    path: Path, domain: str, task_id: str, baseline: dict[str, Any]
) -> dict[str, Any]:
    training_session = f"me07-{domain}-training-session"
    evaluation_session = f"me07-{task_id}-session"
    with _open_read_only(path) as connection:
        projection = connection.execute(
            "SELECT context_id, revision, state_json, state_hash FROM mind_projections"
        ).fetchall()
        if len(projection) != 1:
            raise RuntimeError(f"{path}: expected one Mind projection")
        state_json = str(projection[0]["state_json"])
        revision = int(projection[0]["revision"])
        state_hash = str(projection[0]["state_hash"])

        training_commits = int(
            connection.execute(
                """
                SELECT COUNT(*)
                FROM events
                WHERE session_id = ? AND topic = 'chat/context_tx_committed'
                """,
                (training_session,),
            ).fetchone()[0]
        )
        evaluation_calls = connection.execute(
            """
            SELECT CAST(json_extract(payload, '$.context_snapshot_version') AS INTEGER)
            FROM events
            WHERE session_id = ? AND topic = 'chat/assistant_call'
            ORDER BY timestamp
            """,
            (evaluation_session,),
        ).fetchall()
        snapshots = [int(row[0]) for row in evaluation_calls if row[0] is not None]
        evaluation_commits = connection.execute(
            """
            SELECT payload
            FROM events
            WHERE session_id = ? AND topic = 'chat/context_tx_committed'
            ORDER BY timestamp
            """,
            (evaluation_session,),
        ).fetchall()
        evaluation_turns = int(
            connection.execute(
                """
                SELECT COUNT(*)
                FROM events
                WHERE session_id = ? AND topic = 'chat/user_message'
                """,
                (evaluation_session,),
            ).fetchone()[0]
        )

    commit_payloads = [json.loads(str(row[0])) for row in evaluation_commits]
    expected_version = int(baseline["revision"])
    expected_hash = str(baseline["state_hash"])
    commit_chain_valid = True
    for payload in commit_payloads:
        if (
            int(payload.get("before_version", -1)) != expected_version
            or str(payload.get("before_hash", "")) != expected_hash
        ):
            commit_chain_valid = False
        expected_version = int(payload.get("after_version", -1))
        expected_hash = str(payload.get("after_hash", ""))
    commit_chain_valid = (
        commit_chain_valid
        and revision == expected_version
        and state_hash == expected_hash
    )
    snapshot_versions_nondecreasing = snapshots == sorted(snapshots)
    starts_from_training_context = bool(snapshots) and snapshots[0] == int(
        baseline["revision"]
    )
    counts = _state_counts(state_json, source=path)
    return {
        "domain": domain,
        "task_id": task_id,
        "runtime_cell": path.parent.name,
        "context_id": str(projection[0]["context_id"]),
        "projection_state_sha256": hashlib.sha256(state_json.encode()).hexdigest(),
        "projection_state_hash": state_hash,
        "training_baseline_revision": int(baseline["revision"]),
        "training_baseline_state_hash": str(baseline["state_hash"]),
        "final_context_revision": revision,
        "training_context_transactions": training_commits,
        **counts,
        "held_out_dialogue_turns": evaluation_turns,
        "held_out_model_calls": len(snapshots),
        "held_out_snapshot_versions": sorted(set(snapshots)),
        "held_out_starts_from_training_context": starts_from_training_context,
        "held_out_snapshot_versions_nondecreasing": snapshot_versions_nondecreasing,
        "evaluation_context_transactions": len(commit_payloads),
        "evaluation_context_commit_chain_valid": commit_chain_valid,
        "context_advanced_during_task": bool(commit_payloads),
    }


def _range(values: list[int]) -> list[int]:
    return [min(values), max(values)] if values else []


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-root", type=Path, required=True)
    parser.add_argument(
        "--fallback-runtime-root",
        type=Path,
        action="append",
        default=[],
        help=(
            "Additional read-only Runtime root containing immutable cells "
            "preserved from an earlier queue prefix"
        ),
    )
    parser.add_argument(
        "--snapshot-root",
        type=Path,
        required=True,
        help="Frozen Morphz domain snapshots used to clone every held-out task",
    )
    parser.add_argument("--output-json", type=Path)
    parser.add_argument("--output-markdown", type=Path)
    args = parser.parse_args()

    root = args.run_root.resolve(strict=True)
    queue = json.loads((root / "queue.json").read_text(encoding="utf-8"))
    if queue.get("protocol_id") != PROTOCOL_ID or queue.get("num_runs") != 1:
        raise RuntimeError("ME-07 queue identity mismatch")
    cells = queue.get("cells")
    if not isinstance(cells, list) or len(cells) != 150:
        raise RuntimeError(f"expected 150 held-out cells, got {len(cells or [])}")

    runtime_roots = [root / "runtime" / "morphz"] + [
        path.resolve(strict=True) for path in args.fallback_runtime_root
    ]
    snapshot_root = args.snapshot_root.resolve(strict=True)
    baselines = {
        domain: _domain_baseline(snapshot_root, domain)
        for domain in ("customer_support", "shopping_assistant", "travel")
    }
    records: list[dict[str, Any]] = []
    for cell in cells:
        domain = str(cell["domain"])
        task_id = str(cell["task_id"])
        job_path = root / "jobs" / str(cell["cell_id"]) / "morphz.json"
        if not job_path.is_file():
            raise RuntimeError(f"missing terminal Morphz job: {job_path}")
        job = json.loads(job_path.read_text(encoding="utf-8"))
        if job.get("terminal") is not True:
            raise RuntimeError(f"non-terminal Morphz job: {job_path}")
        record = _audit_db(
            _one_runtime_db(runtime_roots, domain, task_id),
            domain,
            task_id,
            baselines[domain],
        )
        trajectory = job.get("trajectory")
        record["task_completion_pass"] = (
            trajectory.get("task_completion_pass")
            if isinstance(trajectory, dict)
            else None
        )
        records.append(record)

    by_domain: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        by_domain[str(record["domain"])].append(record)
    domain_summary: dict[str, Any] = {}
    for domain, domain_records in sorted(by_domain.items()):
        domain_summary[domain] = {
            "tasks": len(domain_records),
            "context_ids": sorted({row["context_id"] for row in domain_records}),
            "final_context_revisions": sorted(
                {row["final_context_revision"] for row in domain_records}
            ),
            "training_baseline_revision": baselines[domain]["revision"],
            "training_baseline_state_hash": baselines[domain]["state_hash"],
            "tasks_that_advanced_context": sum(
                bool(row["context_advanced_during_task"])
                for row in domain_records
            ),
            "evaluation_context_transactions": sum(
                int(row["evaluation_context_transactions"])
                for row in domain_records
            ),
            "projection_state_sha256s": sorted(
                {row["projection_state_sha256"] for row in domain_records}
            ),
            "active_mind_frames_range": _range(
                [row["active_mind_frames"] for row in domain_records]
            ),
            "active_relations_range": _range(
                [row["active_relations"] for row in domain_records]
            ),
            "retired_objects_range": _range(
                [row["retired_objects"] for row in domain_records]
            ),
        }

    failure_reasons = Counter()
    for baseline in baselines.values():
        if baseline["revision"] != 100:
            failure_reasons["training_baseline_revision_not_100"] += 1
        if baseline["training_context_transactions"] != 100:
            failure_reasons["training_context_transactions_not_100"] += 1
        if not baseline["training_head_matches_projection"]:
            failure_reasons["training_head_does_not_match_projection"] += 1
        if baseline["active_mind_frames"] == 0:
            failure_reasons["training_baseline_has_no_active_mind_frames"] += 1
        if baseline["active_relations"] == 0:
            failure_reasons["training_baseline_has_no_relations"] += 1
    for record in records:
        if record["context_id"] != f"me07-{record['domain']}-context":
            failure_reasons["unexpected_context_id"] += 1
        if record["training_context_transactions"] != 100:
            failure_reasons["training_context_transactions_not_100"] += 1
        if not record["held_out_starts_from_training_context"]:
            failure_reasons["held_out_did_not_start_from_training_context"] += 1
        if not record["held_out_snapshot_versions_nondecreasing"]:
            failure_reasons["held_out_snapshot_versions_not_nondecreasing"] += 1
        if not record["evaluation_context_commit_chain_valid"]:
            failure_reasons["evaluation_context_commit_chain_invalid"] += 1
        if record["active_mind_frames"] == 0:
            failure_reasons["no_active_mind_frames"] += 1
        if record["active_relations"] == 0:
            failure_reasons["no_active_relations"] += 1
    for summary in domain_summary.values():
        if len(summary["context_ids"]) != 1:
            failure_reasons["domain_has_multiple_context_ids"] += 1

    unique_domain_snapshots = {
        domain: {
            "active_mind_frames": baselines[domain]["active_mind_frames"],
            "active_relations": baselines[domain]["active_relations"],
            "retired_objects": baselines[domain]["retired_objects"],
        }
        for domain in sorted(by_domain)
    }

    result = {
        "protocol_id": PROTOCOL_ID,
        "audit": "ME-07-Morphz-Mind-Frame-transfer-trace-v1",
        "read_only": True,
        "rescores_tasks": False,
        "held_out_tasks_audited": len(records),
        "all_tasks_pass_trace_gate": not failure_reasons,
        "failure_reasons": dict(failure_reasons),
        "training_baselines": baselines,
        "held_out_context_updates": {
            "tasks_that_advanced_context": sum(
                bool(record["context_advanced_during_task"])
                for record in records
            ),
            "context_transactions": sum(
                int(record["evaluation_context_transactions"])
                for record in records
            ),
        },
        "domain_summary": domain_summary,
        "unique_domain_snapshot_counts": unique_domain_snapshots,
        "unique_domain_snapshot_totals": {
            key: sum(snapshot[key] for snapshot in unique_domain_snapshots.values())
            for key in ("active_mind_frames", "active_relations", "retired_objects")
        },
        "records": records,
        "interpretation_boundary": {
            "supports": (
                "Training trajectories were transactionally consolidated into "
                "structured Mind Frames; every held-out task began from the exact "
                "frozen revision-100 training Context, and any subsequent Context "
                "updates formed a contiguous, auditable transaction chain."
            ),
            "does_not_support": (
                "The end-to-end score difference is caused exclusively by Mind "
                "Frames; system-level prompts, scheduling, and tool-loop behavior "
                "also differ across arms."
            ),
        },
    }

    if args.output_json:
        args.output_json.parent.mkdir(parents=True, exist_ok=True)
        args.output_json.write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    if args.output_markdown:
        args.output_markdown.parent.mkdir(parents=True, exist_ok=True)
        lines = [
            "# ME-07 Morphz Mind Frame transfer trace audit",
            "",
            f"- Held-out tasks audited: **{len(records)}**",
            f"- All tasks passed the trace gate: **{not failure_reasons}**",
            "- Audit mode: read-only; no model calls and no rescoring",
            (
                "- Unique frozen domain snapshots: "
                f"**{len(unique_domain_snapshots)}**; active Mind Frames: "
                f"**{result['unique_domain_snapshot_totals']['active_mind_frames']}**; "
                "Relations: "
                f"**{result['unique_domain_snapshot_totals']['active_relations']}**"
            ),
            (
                "- Held-out active learning: **"
                f"{result['held_out_context_updates']['tasks_that_advanced_context']}"
                "** tasks advanced Context through **"
                f"{result['held_out_context_updates']['context_transactions']}"
                "** additional transactions"
            ),
            "",
            "| Domain | Tasks | Baseline rev. | Final revs. | Tasks updating Context | Active Frames | Relations |",
            "| --- | ---: | ---: | --- | ---: | --- | --- |",
        ]
        for domain, summary in domain_summary.items():
            lines.append(
                f"| {domain} | {summary['tasks']} | "
                f"{summary['training_baseline_revision']} | "
                f"{summary['final_context_revisions']} | "
                f"{summary['tasks_that_advanced_context']} | "
                f"{summary['active_mind_frames_range']} | "
                f"{summary['active_relations_range']} |"
            )
        lines.extend(
            [
                "",
                "## Interpretation",
                "",
                result["interpretation_boundary"]["supports"],
                "",
                (
                    "This audit does **not** establish that Mind Frames alone caused "
                    "the end-to-end score difference; the formal three-arm comparison "
                    "remains a system-level comparison."
                ),
                "",
            ]
        )
        args.output_markdown.write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
