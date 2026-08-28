#!/usr/bin/env python3
"""Audit ME-09 shared-Context Terminal-Bench results.

The official Terminal-Bench verifier reward is the primary outcome.  Context
transactions and cross-Session frame references are reported separately so a
score change is never used as a substitute for mechanism evidence.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import re
import sqlite3
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any


BOOTSTRAP_SEED = 20260827
BOOTSTRAP_REPETITIONS = 10_000
EXPECTED_PROTOCOL = "ME-09-TB2.1-shared-context-8-session-v1"
EXPECTED_CONTEXT = "me09-shared-context"
FRAME_CREATE_OPERATIONS = {"derive", "place"}
FRAME_LIFECYCLE_OPERATIONS = {"protect", "retire", "revise", "unprotect"}


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


def normalize_task(value: Any) -> str:
    require(isinstance(value, str) and value, f"invalid task name: {value!r}")
    return value.removeprefix("terminal-bench/")


def binary_reward(value: Any, *, task: str) -> int:
    reward = float(value)
    require(reward in {0.0, 1.0}, f"non-binary official reward for {task}: {reward}")
    return int(reward)


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


def load_control(path: Path) -> dict[str, int]:
    payload = load_json(path)
    require(payload.get("official_verifier_raw_reward_is_primary") is True, "ME-08 official-score flag is absent")
    require(payload.get("task_count") == 89, "ME-08 control does not contain 89 tasks")
    rows = payload.get("per_task")
    require(isinstance(rows, list) and len(rows) == 89, "invalid ME-08 per-task control")
    output: dict[str, int] = {}
    for row in rows:
        require(isinstance(row, dict), "invalid ME-08 per-task row")
        task = normalize_task(row.get("task"))
        require(task not in output, f"duplicate ME-08 task: {task}")
        output[task] = binary_reward(row.get("morphz"), task=f"ME-08:{task}")
    return output


def load_manifest(path: Path) -> tuple[dict[str, int], dict[int, dict[str, Any]], dict[str, Any]]:
    payload = load_json(path)
    require(payload.get("protocol_id") == EXPECTED_PROTOCOL, "ME-09 manifest protocol mismatch")
    lanes = payload.get("lanes")
    require(isinstance(lanes, list) and len(lanes) == 8, "ME-09 manifest must have eight lanes")
    task_lane: dict[str, int] = {}
    lane_map: dict[int, dict[str, Any]] = {}
    for lane in lanes:
        require(isinstance(lane, dict), "invalid ME-09 lane")
        lane_id = int(lane["lane_id"])
        require(lane_id not in lane_map, f"duplicate lane {lane_id}")
        lane_map[lane_id] = lane
        for task_value in lane.get("tasks", []):
            task = normalize_task(task_value)
            require(task not in task_lane, f"duplicate manifest task: {task}")
            task_lane[task] = lane_id
    require(set(lane_map) == set(range(8)), "ME-09 lanes are not 0..7")
    require(len(task_lane) == 89, f"ME-09 manifest has {len(task_lane)} tasks, expected 89")
    return task_lane, lane_map, payload


def nested_trial_paths(run_root: Path) -> list[Path]:
    return sorted(run_root.glob("jobs/lane-*/[0-9][0-9]-*/jobs/*/*/result.json"))


def load_trials(
    run_root: Path,
    *,
    task_lane: dict[str, int],
    allow_incomplete: bool,
) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
    trials: dict[str, dict[str, Any]] = {}
    root_turn_to_task: dict[str, str] = {}
    for path in nested_trial_paths(run_root):
        payload = load_json(path)
        task = normalize_task(payload.get("task_name"))
        require(task in task_lane, f"trial task is absent from the manifest: {task}")
        require(task not in trials, f"duplicate ME-09 trial: {task}")
        verifier = payload.get("verifier_result")
        require(isinstance(verifier, dict), f"trial has no verifier result: {task}")
        rewards = verifier.get("rewards")
        require(isinstance(rewards, dict) and "reward" in rewards, f"trial has no official reward: {task}")
        reward = binary_reward(rewards["reward"], task=task)

        trial_root = path.parent
        runtime_path = trial_root / "agent" / "me09_runtime_result.json"
        trajectory_path = trial_root / "agent" / "trajectory.json"
        integrity_path = trial_root / "agent" / "benchmark_integrity.json"
        require(runtime_path.is_file(), f"runtime receipt missing: {task}")
        if not allow_incomplete:
            require(trajectory_path.is_file(), f"trajectory missing: {task}")
        require(integrity_path.is_file(), f"diagnostic integrity record missing: {task}")
        runtime = load_json(runtime_path)
        integrity = load_json(integrity_path)
        require(runtime.get("protocol_id") == EXPECTED_PROTOCOL, f"runtime protocol mismatch: {task}")
        require(normalize_task(runtime.get("task_name")) == task, f"runtime task mismatch: {task}")
        lane_id = int(runtime["lane_id"])
        require(lane_id == task_lane[task], f"wrong lane for {task}: {lane_id}")
        root_turn_id = str(runtime.get("root_turn_id") or "")
        require(root_turn_id, f"runtime root turn missing: {task}")
        require(root_turn_id not in root_turn_to_task, f"root turn reused across trials: {root_turn_id}")
        root_turn_to_task[root_turn_id] = task
        agent_result = payload.get("agent_result") or {}
        agent_info = payload.get("agent_info") or {}
        trials[task] = {
            "task": task,
            "lane_id": lane_id,
            "session_id": runtime.get("session_id"),
            "target_id": runtime.get("target_id"),
            "node_id": runtime.get("node_id"),
            "root_turn_id": root_turn_id,
            "thread_status": (runtime.get("thread") or {}).get("status"),
            "delivery_status": (runtime.get("thread") or {}).get("delivery_status"),
            "runtime_outcome": runtime.get("outcome"),
            "official_reward": reward,
            "exception": payload.get("exception_info"),
            "started_at": payload.get("started_at"),
            "finished_at": payload.get("finished_at"),
            "input_tokens": int(agent_result.get("n_input_tokens") or 0),
            "cache_tokens": int(agent_result.get("n_cache_tokens") or 0),
            "output_tokens": int(agent_result.get("n_output_tokens") or 0),
            "agent_version": agent_info.get("version"),
            "diagnostic_integrity_disqualified": bool(integrity.get("disqualified")),
            "result_sha256": sha256(path),
            "runtime_receipt_sha256": sha256(runtime_path),
            "trajectory_sha256": sha256(trajectory_path) if trajectory_path.is_file() else None,
        }
    require(trials or allow_incomplete, "no ME-09 official trial results found")
    if not allow_incomplete:
        require(len(trials) == 89, f"ME-09 has {len(trials)} completed official trials, expected 89")
        require(set(trials) == set(task_lane), "ME-09 completed task set differs from manifest")
    return trials, root_turn_to_task


def parse_payload(raw: Any, *, event_id: str) -> dict[str, Any]:
    try:
        payload = json.loads(str(raw))
    except json.JSONDecodeError as error:
        raise RuntimeError(f"invalid event payload JSON: {event_id}") from error
    require(isinstance(payload, dict), f"event payload is not an object: {event_id}")
    return payload


def identifier_present(text: str, identifier: str) -> bool:
    return re.search(rf"(?<![A-Za-z0-9_-]){re.escape(identifier)}(?![A-Za-z0-9_-])", text) is not None


def event_root_turn_id(row: dict[str, Any]) -> str:
    """Return the canonical root turn for a persisted event.

    A root ``chat/user_message`` is itself the root event, so the Event Store
    intentionally leaves ``root_turn_id`` null and uses the event ``id`` as
    the root-turn identifier. Descendant events persist that identifier in
    ``root_turn_id``.
    """

    root_turn_id = row.get("root_turn_id")
    if root_turn_id:
        return str(root_turn_id)
    if row.get("topic") == "chat/user_message":
        return str(row.get("id") or "")
    return ""


def audit_database(
    db_path: Path,
    *,
    lane_map: dict[int, dict[str, Any]],
    root_turn_to_task: dict[str, str],
) -> dict[str, Any]:
    connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        sessions = [dict(row) for row in connection.execute(
            "SELECT id, agent_id, context_id, status FROM sessions WHERE id LIKE 'me09-session-%' ORDER BY id"
        )]
        threads = [dict(row) for row in connection.execute(
            "SELECT session_id, root_turn_id, target_id, status, delivery_status FROM threads "
            "WHERE context_id = ? ORDER BY created_at",
            (EXPECTED_CONTEXT,),
        )]
        events = [dict(row) for row in connection.execute(
            "SELECT rowid, id, timestamp, session_id, root_turn_id, topic, payload FROM events "
            "WHERE context_id = ? AND topic IN ('chat/context_tx_committed','chat/assistant_call','chat/user_message') "
            "ORDER BY rowid",
            (EXPECTED_CONTEXT,),
        )]
        projection_row = connection.execute(
            "SELECT revision, state_json, state_hash, updated_at FROM mind_projections WHERE context_id = ?",
            (EXPECTED_CONTEXT,),
        ).fetchone()
        harness_binding_count = int(
            connection.execute(
                "SELECT count(*) FROM events "
                "WHERE topic = 'runtime/evaluation_harness_binding'"
            ).fetchone()[0]
        )
    finally:
        connection.close()

    require(
        harness_binding_count == 0,
        f"ME-09 native protocol has {harness_binding_count} unexpected Harness bindings",
    )
    require(
        len(sessions) == 8,
        f"database has {len(sessions)} ME-09 sessions, expected eight",
    )
    expected_sessions = {str(lane_map[index]["session_id"]) for index in range(8)}
    expected_targets = {str(lane_map[index]["target_id"]) for index in range(8)}
    require({row["id"] for row in sessions} == expected_sessions, "database Session set differs from manifest")
    require({row["context_id"] for row in sessions} == {EXPECTED_CONTEXT}, "ME-09 Sessions do not share one Context")
    require(len({row["agent_id"] for row in sessions}) == 1, "ME-09 Sessions do not share one Agent")

    relevant_threads = [row for row in threads if row["root_turn_id"] in root_turn_to_task]
    require(len(relevant_threads) == len(root_turn_to_task), "not every completed trial has one dialogue Thread")
    require({row["target_id"] for row in relevant_threads}.issubset(expected_targets), "unexpected ME-09 Target in Threads")

    tx_events: list[dict[str, Any]] = []
    call_events: list[dict[str, Any]] = []
    user_events = 0
    for row in events:
        if row["topic"] == "chat/user_message":
            if event_root_turn_id(row) in root_turn_to_task:
                user_events += 1
            continue
        payload = parse_payload(row["payload"], event_id=str(row["id"]))
        item = {**row, "payload": payload}
        if row["topic"] == "chat/context_tx_committed":
            tx_events.append(item)
        elif row["topic"] == "chat/assistant_call":
            call_events.append(item)

    require(projection_row is not None, "shared Context has no Mind projection")
    projection = json.loads(str(projection_row["state_json"]))
    require(isinstance(projection, dict), "Mind projection is not an object")
    final_revision = int(projection_row["revision"])
    after_versions = sorted(int(item["payload"]["after_version"]) for item in tx_events)
    require(after_versions == list(range(1, final_revision + 1)), "Context transaction after-version chain is not contiguous")

    frame_history: dict[str, dict[str, Any]] = {}
    retirement_version: dict[str, int] = {}
    for event in tx_events:
        payload = event["payload"]
        session_id = str(payload.get("session_id") or event["session_id"] or "")
        version = int(payload["after_version"])
        for change in payload.get("changes") or []:
            if not isinstance(change, dict):
                continue
            operation = str(change.get("operation") or "")
            target = str(change.get("target") or "")
            if not target:
                continue
            if operation in FRAME_CREATE_OPERATIONS and target not in frame_history:
                frame_history[target] = {
                    "frame_id": target,
                    "formed_session_id": session_id,
                    "created_version": version,
                    "created_root_turn_id": payload.get("root_turn_id") or event["root_turn_id"],
                    "create_operation": operation,
                }
            if operation == "retire" and target in frame_history:
                retirement_version.setdefault(target, version)

    e1_exposures: list[dict[str, Any]] = []
    for call in call_events:
        payload = call["payload"]
        session_id = str(payload.get("session_id") or call["session_id"] or "")
        snapshot_version = int(payload.get("context_snapshot_version") or 0)
        task = root_turn_to_task.get(str(payload.get("root_turn_id") or call["root_turn_id"] or ""))
        if task is None:
            continue
        for frame in frame_history.values():
            if frame["formed_session_id"] == session_id:
                continue
            retired_at = retirement_version.get(frame["frame_id"])
            if snapshot_version < int(frame["created_version"]):
                continue
            if retired_at is not None and snapshot_version >= retired_at:
                continue
            e1_exposures.append({
                "frame_id": frame["frame_id"],
                "formed_session_id": frame["formed_session_id"],
                "consumer_session_id": session_id,
                "consumer_task": task,
                "context_snapshot_version": snapshot_version,
            })

    e2_references: list[dict[str, Any]] = []
    for event in tx_events:
        payload = event["payload"]
        consumer_session = str(payload.get("session_id") or event["session_id"] or "")
        consumer_turn = str(payload.get("root_turn_id") or event["root_turn_id"] or "")
        consumer_task = root_turn_to_task.get(consumer_turn)
        version = int(payload["after_version"])
        transaction = str(payload.get("transaction") or "")
        changes = [change for change in (payload.get("changes") or []) if isinstance(change, dict)]
        for frame in frame_history.values():
            if frame["formed_session_id"] == consumer_session or version <= int(frame["created_version"]):
                continue
            direct_changes = [
                str(change.get("operation") or "")
                for change in changes
                if str(change.get("target") or "") == frame["frame_id"]
            ]
            mentioned = identifier_present(transaction, frame["frame_id"])
            if not direct_changes and not mentioned:
                continue
            e2_references.append({
                "frame_id": frame["frame_id"],
                "formed_session_id": frame["formed_session_id"],
                "consumer_session_id": consumer_session,
                "consumer_task": consumer_task,
                "consumer_root_turn_id": consumer_turn,
                "after_version": version,
                "operations": sorted(set(direct_changes)),
                "transaction_mentions_frame": mentioned,
                "lifecycle_only": bool(direct_changes) and set(direct_changes).issubset({"protect", "retire", "unprotect"}),
            })

    active_frames = projection.get("frames") or []
    relations = projection.get("relations") or []
    retired = projection.get("retired") or []
    require(isinstance(active_frames, list), "Mind projection frames are invalid")
    require(isinstance(relations, list), "Mind projection relations are invalid")
    require(isinstance(retired, list), "Mind projection retired set is invalid")

    unique_e1 = {
        (row["frame_id"], row["consumer_session_id"], row["consumer_task"])
        for row in e1_exposures
    }
    unique_e2 = {
        (row["frame_id"], row["consumer_session_id"], row["consumer_task"], row["after_version"])
        for row in e2_references
    }
    cross_session_provenance_frames = []
    for frame in active_frames:
        if not isinstance(frame, dict):
            continue
        provenance = frame.get("provenance") or {}
        source_sessions = sorted(set(provenance.get("source_session_ids") or []))
        if len(source_sessions) > 1:
            cross_session_provenance_frames.append({
                "frame_id": frame.get("id"),
                "formed_session_id": provenance.get("formed_session_id"),
                "source_session_ids": source_sessions,
                "revision": frame.get("revision"),
            })

    return {
        "e0_topology": {
            "passed": True,
            "harness_mode": "none",
            "harness_binding_count": harness_binding_count,
            "agent_count": 1,
            "context_count": 1,
            "session_count": len(sessions),
            "expected_target_count": len(expected_targets),
            "official_trial_thread_count": len(relevant_threads),
            "official_trial_user_message_count": user_events,
        },
        "context_transactions": {
            "count": len(tx_events),
            "final_revision": final_revision,
            "auto_rebased_count": sum(bool(item["payload"].get("auto_rebased")) for item in tx_events),
            "operation_counts": dict(sorted(Counter(
                str(change.get("operation") or "")
                for item in tx_events
                for change in (item["payload"].get("changes") or [])
                if isinstance(change, dict)
            ).items())),
            "by_session": dict(sorted(Counter(
                str(item["payload"].get("session_id") or item["session_id"] or "")
                for item in tx_events
            ).items())),
        },
        "mind_projection": {
            "revision": final_revision,
            "state_hash": projection_row["state_hash"],
            "updated_at": projection_row["updated_at"],
            "active_frames": len(active_frames),
            "active_relations": len(relations),
            "retired_objects": len(retired),
            "formed_frame_count_reconstructed": len(frame_history),
            "cross_session_provenance_frames": cross_session_provenance_frames,
        },
        "e1_visible_exposure": {
            "definition": "A later model call in another Session used a Context snapshot version in which the earlier Frame was active; this proves availability, not semantic use.",
            "event_count": len(e1_exposures),
            "unique_frame_session_task_count": len(unique_e1),
            "examples": e1_exposures[:100],
        },
        "e2_explicit_reference": {
            "definition": "A later Context transaction from another Session directly targeted or textually named the stable Frame identifier; lifecycle-only references are separated from substantive reuse.",
            "event_count": len(e2_references),
            "unique_frame_session_task_version_count": len(unique_e2),
            "substantive_count": sum(not row["lifecycle_only"] for row in e2_references),
            "lifecycle_only_count": sum(row["lifecycle_only"] for row in e2_references),
            "events": e2_references,
        },
        "db_sha256": sha256(db_path),
    }


def summarize(
    *,
    run_root: Path,
    manifest_path: Path,
    control_path: Path,
    db_path: Path,
    allow_incomplete: bool,
) -> dict[str, Any]:
    task_lane, lane_map, manifest = load_manifest(manifest_path)
    control = load_control(control_path)
    require(set(control) == set(task_lane), "ME-08 and ME-09 task sets differ")
    trials, root_turn_to_task = load_trials(
        run_root,
        task_lane=task_lane,
        allow_incomplete=allow_incomplete,
    )
    completed = sorted(trials)
    passed = sum(trials[task]["official_reward"] for task in completed)
    formal_complete = len(completed) == 89 and set(completed) == set(task_lane)

    launcher_path = run_root / "launcher_result.json"
    launcher: dict[str, Any] | None = None
    if launcher_path.is_file():
        launcher = load_json(launcher_path)
        require(launcher.get("protocol_id") == EXPECTED_PROTOCOL, "launcher protocol mismatch")
        require(launcher.get("mode") == "full", "launcher was not a full run")
        require(launcher.get("observed_task_count") == 89, "launcher did not observe 89 tasks")
        require(launcher.get("expected_task_count") == 89, "launcher expected task count is not 89")
    elif not allow_incomplete:
        raise RuntimeError("formal ME-09 launcher_result.json is missing")

    database = audit_database(
        db_path,
        lane_map=lane_map,
        root_turn_to_task=root_turn_to_task,
    )

    observed_versions = {str(trials[task]["agent_version"] or "") for task in completed}
    require(len(observed_versions) <= 1, f"ME-09 trials used multiple Runtime versions: {sorted(observed_versions)}")
    if launcher is not None:
        expected_version = (
            f"{launcher.get('runtime_commit')}@{launcher.get('runtime_binary_sha256')}"
        )
        require(observed_versions == {expected_version}, "trial Runtime version differs from launcher binding")

    paired_tasks = completed
    me09_only = sum(trials[task]["official_reward"] > control[task] for task in paired_tasks)
    me08_only = sum(trials[task]["official_reward"] < control[task] for task in paired_tasks)
    both_pass = sum(trials[task]["official_reward"] == control[task] == 1 for task in paired_tasks)
    both_fail = sum(trials[task]["official_reward"] == control[task] == 0 for task in paired_tasks)
    differences = [trials[task]["official_reward"] - control[task] for task in paired_tasks]

    e2_tasks = {
        row["consumer_task"]
        for row in database["e2_explicit_reference"]["events"]
        if row["consumer_task"] is not None and not row["lifecycle_only"]
    }
    e3_tasks = sorted(
        task for task in e2_tasks
        if task in trials and trials[task]["official_reward"] == 1 and control[task] == 0
    )

    by_lane: dict[str, Any] = {}
    for lane_id in range(8):
        lane_tasks = sorted(task for task in completed if task_lane[task] == lane_id)
        lane_passed = sum(trials[task]["official_reward"] for task in lane_tasks)
        by_lane[str(lane_id)] = {
            "completed": len(lane_tasks),
            "passed": lane_passed,
            "score": lane_passed / len(lane_tasks) if lane_tasks else None,
        }

    summary: dict[str, Any] = {
        "protocol_id": EXPECTED_PROTOCOL,
        "formal_complete": formal_complete,
        "official_verifier_raw_reward_is_primary": True,
        "diagnostic_integrity_never_overrides_official_reward": True,
        "completed_task_count": len(completed),
        "expected_task_count": 89,
        "me09_shared_context": {
            "passed": passed,
            "score": passed / len(completed) if completed else None,
            "wilson_95_ci": wilson_95(passed, len(completed)) if completed else None,
            "provider_reported_input_tokens": sum(trials[task]["input_tokens"] for task in completed),
            "provider_reported_cache_tokens": sum(trials[task]["cache_tokens"] for task in completed),
            "provider_reported_output_tokens": sum(trials[task]["output_tokens"] for task in completed),
            "diagnostic_integrity_disqualified_count": sum(
                trials[task]["diagnostic_integrity_disqualified"] for task in completed
            ),
            "by_lane": by_lane,
        },
        "paired_with_me08_isolated_context": {
            "paired_task_count": len(paired_tasks),
            "me08_passed_on_same_completed_tasks": sum(control[task] for task in paired_tasks),
            "difference": sum(differences) / len(differences) if differences else None,
            "paired_bootstrap_95_ci": paired_bootstrap_95(differences) if differences else None,
            "me09_only": me09_only,
            "me08_only": me08_only,
            "both_pass": both_pass,
            "both_fail": both_fail,
            "exact_two_sided_p": exact_two_sided(me09_only, me08_only) if differences else None,
        },
        "mechanism_evidence": database,
        "e3_result_related_cases": {
            "definition": "A task has substantive E2 evidence, passed in ME-09, and failed in the frozen ME-08 control. A case is explanatory, not a standalone causal estimate.",
            "tasks": e3_tasks,
            "count": len(e3_tasks),
        },
        "per_task": [
            {
                **trials[task],
                "me08_isolated_context_reward": control[task],
                "paired_difference": trials[task]["official_reward"] - control[task],
                "has_substantive_e2_reference": task in e2_tasks,
                "is_e3_case": task in e3_tasks,
            }
            for task in sorted(completed, key=lambda task: (task_lane[task], manifest["lanes"][task_lane[task]]["tasks"].index(task)))
        ],
        "input_sha256": {
            "manifest": sha256(manifest_path),
            "me08_control": sha256(control_path),
            **({"launcher_result": sha256(launcher_path)} if launcher_path.is_file() else {}),
        },
        "bootstrap": {
            "seed": BOOTSTRAP_SEED,
            "repetitions": BOOTSTRAP_REPETITIONS,
        },
        "generated_at": datetime.now().astimezone().isoformat(),
    }
    if not allow_incomplete:
        require(formal_complete, "formal ME-09 summary is incomplete")
        require(database["e0_topology"]["official_trial_thread_count"] == 89, "formal ME-09 Thread count is not 89")
        require(database["e0_topology"]["official_trial_user_message_count"] == 89, "formal ME-09 user-message count is not 89")
    return summary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-root", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--me08-control", type=Path, required=True)
    parser.add_argument("--database", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--allow-incomplete", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    run_root = args.run_root.expanduser().resolve()
    database = (
        args.database.expanduser().resolve()
        if args.database is not None
        else run_root / "runtime" / "morphz.db"
    )
    summary = summarize(
        run_root=run_root,
        manifest_path=args.manifest.expanduser().resolve(),
        control_path=args.me08_control.expanduser().resolve(),
        db_path=database,
        allow_incomplete=args.allow_incomplete,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"formal_complete={str(summary['formal_complete']).lower()}")
    print(f"completed={summary['completed_task_count']}/89")
    print(f"passed={summary['me09_shared_context']['passed']}")
    print(f"e2_substantive={summary['mechanism_evidence']['e2_explicit_reference']['substantive_count']}")
    print(f"e3_cases={summary['e3_result_related_cases']['count']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
