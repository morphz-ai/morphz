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


def _one_runtime_db(runtime_root: Path, domain: str, task_id: str) -> Path:
    matches = sorted(runtime_root.glob(f"{domain}-{task_id}-1-*/morphz.sqlite"))
    if len(matches) != 1:
        raise RuntimeError(
            f"expected one Morphz Runtime DB for {domain}/{task_id}, got {matches}"
        )
    return matches[0]


def _audit_db(path: Path, domain: str, task_id: str) -> dict[str, Any]:
    training_session = f"me07-{domain}-training-session"
    evaluation_session = f"me07-{task_id}-session"
    with _open_read_only(path) as connection:
        projection = connection.execute(
            "SELECT context_id, revision, state_json FROM mind_projections"
        ).fetchall()
        if len(projection) != 1:
            raise RuntimeError(f"{path}: expected one Mind projection")
        state_json = str(projection[0]["state_json"])
        state = json.loads(state_json)
        revision = int(projection[0]["revision"])

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

    frames = state.get("frames")
    relations = state.get("relations")
    retired = state.get("retired")
    if not isinstance(frames, list) or not isinstance(relations, list):
        raise RuntimeError(f"{path}: malformed structured Context projection")
    if not isinstance(retired, list):
        retired = []
    attributed_frames = sum(
        1
        for frame in frames
        if isinstance(frame, dict)
        and isinstance(frame.get("provenance"), dict)
        and frame["provenance"].get("formed_session_id") == training_session
    )
    return {
        "domain": domain,
        "task_id": task_id,
        "runtime_db": str(path),
        "context_id": str(projection[0]["context_id"]),
        "projection_state_sha256": hashlib.sha256(state_json.encode()).hexdigest(),
        "final_context_revision": revision,
        "training_context_transactions": training_commits,
        "active_mind_frames": len(frames),
        "training_attributed_active_frames": attributed_frames,
        "active_relations": len(relations),
        "retired_objects": len(retired),
        "held_out_dialogue_turns": evaluation_turns,
        "held_out_model_calls": len(snapshots),
        "held_out_snapshot_versions": sorted(set(snapshots)),
        "all_held_out_calls_use_final_context": bool(snapshots)
        and all(snapshot == revision for snapshot in snapshots),
    }


def _range(values: list[int]) -> list[int]:
    return [min(values), max(values)] if values else []


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-root", type=Path, required=True)
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

    runtime_root = root / "runtime" / "morphz"
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
            _one_runtime_db(runtime_root, domain, task_id), domain, task_id
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
    for record in records:
        if record["context_id"] != f"me07-{record['domain']}-context":
            failure_reasons["unexpected_context_id"] += 1
        if record["training_context_transactions"] != 100:
            failure_reasons["training_context_transactions_not_100"] += 1
        if record["final_context_revision"] != 100:
            failure_reasons["final_context_revision_not_100"] += 1
        if record["training_attributed_active_frames"] != record["active_mind_frames"]:
            failure_reasons["active_frame_without_training_attribution"] += 1
        if record["active_mind_frames"] == 0:
            failure_reasons["no_active_mind_frames"] += 1
        if record["active_relations"] == 0:
            failure_reasons["no_active_relations"] += 1
        if not record["all_held_out_calls_use_final_context"]:
            failure_reasons["held_out_call_not_on_final_context"] += 1
    for summary in domain_summary.values():
        if len(summary["context_ids"]) != 1:
            failure_reasons["domain_has_multiple_context_ids"] += 1
        if summary["final_context_revisions"] != [100]:
            failure_reasons["domain_has_nonfinal_context_revision"] += 1
        if len(summary["projection_state_sha256s"]) != 1:
            failure_reasons["held_out_clones_do_not_share_one_frozen_mind"] += 1

    unique_domain_snapshots = {
        domain: {
            "active_mind_frames": rows[0]["active_mind_frames"],
            "active_relations": rows[0]["active_relations"],
            "retired_objects": rows[0]["retired_objects"],
        }
        for domain, rows in sorted(by_domain.items())
    }

    result = {
        "protocol_id": PROTOCOL_ID,
        "audit": "ME-07-Morphz-Mind-Frame-transfer-trace-v1",
        "read_only": True,
        "rescores_tasks": False,
        "held_out_tasks_audited": len(records),
        "all_tasks_pass_trace_gate": not failure_reasons,
        "failure_reasons": dict(failure_reasons),
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
                "attributed structured Mind Frames, and held-out model calls used "
                "the resulting final Context snapshot."
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
            "",
            "| Domain | Tasks | Context revision | Active Frames | Relations | Retired objects |",
            "| --- | ---: | --- | --- | --- | --- |",
        ]
        for domain, summary in domain_summary.items():
            lines.append(
                f"| {domain} | {summary['tasks']} | "
                f"{summary['final_context_revisions']} | "
                f"{summary['active_mind_frames_range']} | "
                f"{summary['active_relations_range']} | "
                f"{summary['retired_objects_range']} |"
            )
        lines.extend(
            [
                "",
                "## Interpretation",
                "",
                result["interpretation_boundary"]["supports"],
                "",
                "This audit does **not** establish that Mind Frames alone caused the "
                "end-to-end score difference; the formal three-arm comparison remains "
                "a system-level comparison.",
                "",
            ]
        )
        args.output_markdown.write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
