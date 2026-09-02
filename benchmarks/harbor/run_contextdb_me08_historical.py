#!/usr/bin/env python3
"""Compare one ContextDB ME-08 run with preserved legacy-storage history.

The legacy cognitive store already has several complete ME-08 runs. Repeating
it would spend model tokens without adding a useful control. This launcher
therefore runs only the ContextDB candidate and compares it with six distinct,
preserved 89-task legacy-storage observations.

Each candidate run keeps ME-08's eight isolated Harbor trials. Every trial has
its own Morphz Agent, Context, Session, SQLite database and task container; this
is not the shared-Context concurrency exercised by ME-09.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from benchmarks.harbor.run_benchmark import LOCK_PATH, REPO_ROOT


PROTOCOL = "contextdb-me08-against-preserved-history-v1"
PILOT_PATH = Path(__file__).with_name("contextdb_me08_pilot_tasks_v1.json")
FIRST_40_PATH = Path(__file__).with_name("first_40_tasks_v1.json")
REMAINING_49_PATH = Path(__file__).with_name("remaining_49_tasks_v1.json")
ARTIFACT_ROOT = (
    REPO_ROOT / "docs" / "research" / "paper_evaluation" / "artifacts"
)
TRIAL_CONCURRENCY = 8

# These are six distinct complete legacy-storage executions, not duplicate
# copies of the same run. The two prefix-cache profiles share one concurrent
# experiment but are independent model executions with isolated state.
HISTORICAL_SOURCES: tuple[dict[str, Any], ...] = (
    {
        "name": "postfix-ad60e",
        "kind": "strict",
        "path": "me08_postfix_all89_ad60e_concurrency8_20260826/strict_result.json",
        "expected_passed": 73,
    },
    {
        "name": "runtime-4bbc3d6",
        "kind": "strict",
        "path": "me08_terminal_bench_postfix_all89_20260827/strict_result.json",
        "expected_passed": 72,
    },
    {
        "name": "runtime-d6e6d80",
        "kind": "strict",
        "path": (
            "me08_current_runtime_d6e6d80_all89_20260828/"
            "job_audit/strict_result.json"
        ),
        "expected_passed": 72,
    },
    {
        "name": "runtime-2b01310",
        "kind": "strict",
        "path": "me08_current_runtime_2b01310_all89_20260828/strict_result.json",
        "expected_passed": 69,
    },
    {
        "name": "prefix-cache-control",
        "kind": "summary-profile",
        "path": (
            "me08_prefix_cache_ab_89adf73_all89_20260830/"
            "all_89_cache_ab_summary.json"
        ),
        "profile": "control",
        "expected_passed": 72,
    },
    {
        "name": "prefix-cache-structured-deltas",
        "kind": "summary-profile",
        "path": (
            "me08_prefix_cache_ab_89adf73_all89_20260830/"
            "all_89_cache_ab_summary.json"
        ),
        "profile": "structured-deltas",
        "field": "structured_deltas",
        "expected_passed": 71,
    },
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git_commit() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def require_clean_source() -> str:
    commit = git_commit()
    status = subprocess.run(
        ["git", "status", "--porcelain", "--untracked-files=no"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    if status:
        raise RuntimeError("ContextDB ME-08 requires a clean tracked worktree")
    return commit


def load_all_tasks() -> list[str]:
    first = json.loads(FIRST_40_PATH.read_text(encoding="utf-8"))
    remaining = json.loads(REMAINING_49_PATH.read_text(encoding="utf-8"))
    cohorts = first.get("cohorts") or {}
    tasks = [
        str(task)
        for cohort in ("prior_first_20", "prior_second_20")
        for task in cohorts.get(cohort, [])
    ] + [str(task) for task in remaining.get("tasks", [])]
    if len(tasks) != 89 or len(set(tasks)) != 89:
        raise RuntimeError("frozen ME-08 manifests must contain 89 unique tasks")
    if remaining.get("prior_task_set_sha256") != sha256_file(FIRST_40_PATH):
        raise RuntimeError("remaining-49 manifest does not bind the first-40 manifest")
    return tasks


def load_pilot_tasks() -> list[str]:
    payload = json.loads(PILOT_PATH.read_text(encoding="utf-8"))
    tasks = [str(task) for task in payload.get("tasks", [])]
    all_tasks = load_all_tasks()
    if len(tasks) != 8 or len(set(tasks)) != 8:
        raise RuntimeError("ContextDB ME-08 pilot must contain eight unique tasks")
    if tasks != all_tasks[:8]:
        raise RuntimeError("ContextDB ME-08 pilot must remain the frozen first eight tasks")
    if payload.get("trial_concurrency") != TRIAL_CONCURRENCY:
        raise RuntimeError("ContextDB ME-08 pilot concurrency drifted from eight")
    return tasks


def _validate_run_identity(payload: dict[str, Any], source_name: str) -> None:
    identity = payload.get("run_identity") or {}
    expected = {
        "model": "gpt-5.6-sol",
        "reasoning_effort": "max",
        "harness_mode": "none",
        "attempts": 1,
        "concurrency": 8,
        "max_retries": 0,
    }
    mismatches = {
        field: {"expected": value, "actual": identity.get(field)}
        for field, value in expected.items()
        if identity.get(field) != value
    }
    if mismatches:
        raise RuntimeError(f"historical source {source_name} drifted: {mismatches}")


def _load_strict_source(source: dict[str, Any]) -> dict[str, int]:
    path = ARTIFACT_ROOT / str(source["path"])
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("audit_complete") is not True:
        raise RuntimeError(f"historical source is not audit-complete: {path}")
    # ME-08's primary metric is the official verifier raw reward. One accepted
    # run has a supplementary local-policy disqualification while retaining 89
    # complete official rewards, so that unrelated local gate must not erase a
    # valid historical observation.
    if payload.get("trial_count_matches") is not True:
        raise RuntimeError(f"historical source trial count drifted: {path}")
    if payload.get("missing_expected_tasks"):
        raise RuntimeError(f"historical source is missing tasks: {path}")
    if payload.get("unexpected_tasks"):
        raise RuntimeError(f"historical source has unexpected tasks: {path}")
    _validate_run_identity(payload, str(source["name"]))
    rewards: dict[str, int] = {}
    for row in payload.get("trials") or []:
        task = str(row["task_name"]).removeprefix("terminal-bench/")
        reward = float(row["raw_reward"])
        if reward not in {0.0, 1.0} or task in rewards:
            raise RuntimeError(f"invalid historical reward for {task}: {path}")
        rewards[task] = int(reward)
    return rewards


def _load_summary_profile(source: dict[str, Any]) -> dict[str, int]:
    path = ARTIFACT_ROOT / str(source["path"])
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("task_count_per_arm") != 89:
        raise RuntimeError(f"historical summary is incomplete: {path}")
    if payload.get("attempts_per_task") != 1:
        raise RuntimeError(f"historical summary attempts drifted: {path}")
    if payload.get("concurrency_per_arm") != 8:
        raise RuntimeError(f"historical summary concurrency drifted: {path}")
    profile = str(source.get("field") or source["profile"])
    rewards: dict[str, int] = {}
    for row in payload.get("per_task") or []:
        task = str(row["task"])
        reward = int(row[profile])
        if reward not in {0, 1} or task in rewards:
            raise RuntimeError(f"invalid historical reward for {task}: {path}")
        rewards[task] = reward
    return rewards


def load_historical_runs() -> dict[str, dict[str, Any]]:
    all_tasks = load_all_tasks()
    task_set = set(all_tasks)
    runs: dict[str, dict[str, Any]] = {}
    for source in HISTORICAL_SOURCES:
        name = str(source["name"])
        if name in runs:
            raise RuntimeError(f"duplicate historical source name: {name}")
        if source["kind"] == "strict":
            rewards = _load_strict_source(source)
        elif source["kind"] == "summary-profile":
            rewards = _load_summary_profile(source)
        else:
            raise RuntimeError(f"unknown historical source kind: {source['kind']}")
        if set(rewards) != task_set:
            raise RuntimeError(f"historical source {name} does not contain exactly 89 tasks")
        passed = sum(rewards.values())
        if passed != int(source["expected_passed"]):
            raise RuntimeError(
                f"historical source {name} score drifted: {passed} != "
                f"{source['expected_passed']}"
            )
        path = ARTIFACT_ROOT / str(source["path"])
        runs[name] = {
            "path": str(path.relative_to(REPO_ROOT)),
            "sha256": sha256_file(path),
            "profile": source.get("profile"),
            "passed_all_89": passed,
            "rewards": rewards,
        }
    return runs


def historical_baseline(tasks: list[str]) -> dict[str, Any]:
    runs = load_historical_runs()
    missing = set(tasks) - set(load_all_tasks())
    if missing:
        raise RuntimeError(f"tasks are absent from ME-08 history: {sorted(missing)}")
    per_task: dict[str, dict[str, Any]] = {}
    for task in tasks:
        observations = {name: run["rewards"][task] for name, run in runs.items()}
        passes = sum(observations.values())
        per_task[task] = {
            "passes": passes,
            "observations": len(observations),
            "pass_rate": passes / len(observations),
            "results": observations,
        }
    subset_passed = {
        name: sum(run["rewards"][task] for task in tasks)
        for name, run in runs.items()
    }
    return {
        "source_count": len(runs),
        "sources": {
            name: {key: value for key, value in run.items() if key != "rewards"}
            for name, run in runs.items()
        },
        "subset_passed_by_source": subset_passed,
        "subset_passed_min": min(subset_passed.values()),
        "subset_passed_max": max(subset_passed.values()),
        "subset_passed_mean": sum(subset_passed.values()) / len(subset_passed),
        "per_task": per_task,
    }


def build_toolchain_lock(
    base: dict[str, Any],
    *,
    commit: str,
    binary: Path,
    watcher: Path,
) -> dict[str, Any]:
    lock = json.loads(json.dumps(base))
    lock["runtime"] = {
        "git_tag": f"contextdb-final-{commit[:12]}",
        "git_commit": commit,
        "build_git_commit": commit,
        "build_profile": "release",
        "build_features": ["context-db"],
        "build_command": (
            "docker buildx build --file benchmarks/harbor/runtime.Dockerfile "
            "--target export --output type=local,dest=./build-output "
            f"--build-arg MORPHZ_BUILD_GIT_COMMIT={commit} "
            "--build-arg MORPHZ_CARGO_FEATURES=context-db ."
        ),
        "target": "x86_64-unknown-linux-gnu",
        "container_platform": "linux/amd64",
        "binary_sha256": sha256_file(binary),
        "watcher_sha256": sha256_file(watcher),
    }
    return lock


def candidate_command(
    *,
    tasks: list[str],
    jobs_dir: Path,
    binary: Path,
    watcher: Path,
    toolchain_lock: Path,
) -> list[str]:
    command = [
        sys.executable,
        "-m",
        "benchmarks.harbor.run_benchmark",
        "full",
        "--binary",
        str(binary),
        "--watcher",
        str(watcher),
        "--toolchain-lock",
        str(toolchain_lock),
        "--jobs-dir",
        str(jobs_dir),
        "--harness-mode",
        "none",
        "--context-store",
        "contextdb",
        "--attempts",
        "1",
        "--concurrency",
        str(TRIAL_CONCURRENCY),
    ]
    for task in tasks:
        command.extend(["--task", task])
    command.extend(["--expect-trials", str(len(tasks))])
    return command


def only_job(jobs_dir: Path) -> Path:
    jobs = sorted(path for path in jobs_dir.iterdir() if path.is_dir())
    if len(jobs) != 1:
        raise RuntimeError(f"expected exactly one Harbor job in {jobs_dir}, got {len(jobs)}")
    return jobs[0]


def load_rewards(job: Path, tasks: list[str]) -> dict[str, int]:
    strict_path = job / "strict_result.json"
    payload = json.loads(strict_path.read_text(encoding="utf-8"))
    rows = payload.get("trials") or []
    if payload.get("audit_complete") is not True or len(rows) != len(tasks):
        raise RuntimeError(f"strict result is incomplete: {strict_path}")
    rewards: dict[str, int] = {}
    for row in rows:
        task = str(row["task_name"]).removeprefix("terminal-bench/")
        reward = float(row["raw_reward"])
        if reward not in {0.0, 1.0} or task in rewards:
            raise RuntimeError(f"invalid or duplicate official reward for {task}")
        rewards[task] = int(reward)
    if set(rewards) != set(tasks):
        raise RuntimeError("officially scored tasks differ from the frozen task set")
    return rewards


def audit_context_store_receipts(job: Path, expected: int) -> dict[str, int]:
    databases = sorted(job.glob("*/agent/morphz.db"))
    if len(databases) != expected:
        raise RuntimeError(
            f"ContextDB run has {len(databases)} trial databases, expected {expected}"
        )

    receipt_count = 0
    durable_fallback_count = 0
    for database_path in databases:
        connection = sqlite3.connect(f"file:{database_path}?mode=ro", uri=True)
        try:
            rows = connection.execute(
                "SELECT context_id FROM experimental_contextdb_contexts"
            ).fetchall()
        except sqlite3.Error as error:
            raise RuntimeError(
                f"ContextDB authority table is unavailable: {database_path}"
            ) from error
        finally:
            connection.close()
        if len(rows) != 1:
            raise RuntimeError(
                "ContextDB trial did not persist exactly one authoritative Context: "
                f"{database_path} ({len(rows)})"
            )
        context_id = str(rows[0][0])

        receipt_path = database_path.with_name("context_store_audit.json")
        if not receipt_path.is_file():
            # Harbor cancels the custom Agent immediately at the task deadline,
            # before its post-run receipt hook can execute.  The trial database
            # remains the primary durable evidence for those timeout samples.
            durable_fallback_count += 1
            continue
        payload = json.loads(receipt_path.read_text(encoding="utf-8"))
        if payload.get("context_store") != "contextdb":
            raise RuntimeError(
                f"Context store receipt selected the wrong store: {receipt_path}"
            )
        if payload.get("context_db_authority_count") != 1:
            raise RuntimeError(
                f"Context store authority receipt failed: {receipt_path}"
            )
        if payload.get("context_id") != context_id:
            raise RuntimeError(
                f"Context store receipt does not match its database: {receipt_path}"
            )
        receipt_count += 1

    return {
        "trial_databases_verified": len(databases),
        "post_run_receipts_verified": receipt_count,
        "timeout_database_fallbacks_verified": durable_fallback_count,
    }


def load_candidate_outcome(
    *,
    jobs_dir: Path,
    tasks: list[str],
    return_code: int,
    logs_dir: Path,
) -> tuple[Path, dict[str, int], dict[str, int]]:
    """Load a complete Harbor outcome even when individual trials errored.

    Harbor returns a nonzero process status when any trial records an Agent
    exception.  That status does not mean the benchmark itself stopped early:
    it can still contain the complete, strictly audited task set and all
    ContextStore receipts.  The durable artifacts are therefore authoritative
    for completeness; the process status remains part of the comparison for
    diagnostics.
    """

    try:
        job = only_job(jobs_dir)
        authority_audit = audit_context_store_receipts(job, expected=len(tasks))
        rewards = load_rewards(job, tasks)
    except (OSError, RuntimeError, ValueError, KeyError) as error:
        if return_code != 0:
            raise RuntimeError(
                "ContextDB ME-08 run failed before a complete strict outcome; "
                f"see {logs_dir}"
            ) from error
        raise
    return job, rewards, authority_audit


def compare_with_history(
    tasks: list[str], candidate: dict[str, int], baseline: dict[str, Any]
) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    for task in tasks:
        history = baseline["per_task"][task]
        rows.append(
            {
                "task": task,
                "historical_passes": history["passes"],
                "historical_observations": history["observations"],
                "historical_pass_rate": history["pass_rate"],
                "contextdb": candidate[task],
            }
        )
    candidate_passed = sum(candidate.values())
    always_passed_failures = [
        row["task"]
        for row in rows
        if row["historical_pass_rate"] == 1.0 and row["contextdb"] == 0
    ]
    strong_history_failures = [
        row["task"]
        for row in rows
        if row["historical_pass_rate"] >= (5 / 6) and row["contextdb"] == 0
    ]
    below_historical_min = candidate_passed < baseline["subset_passed_min"]
    return {
        "candidate_passed": candidate_passed,
        "historical_passed_min": baseline["subset_passed_min"],
        "historical_passed_max": baseline["subset_passed_max"],
        "historical_passed_mean": baseline["subset_passed_mean"],
        "below_historical_min": below_historical_min,
        "historically_always_passed_contextdb_failed": always_passed_failures,
        "historically_at_least_five_of_six_passed_contextdb_failed": (
            strong_history_failures
        ),
        "requires_regression_audit": bool(
            below_historical_min or always_passed_failures
        ),
        "per_task": rows,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("validate", "pilot", "full"))
    parser.add_argument("--contextdb-binary", type=Path, required=True)
    parser.add_argument("--contextdb-watcher", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    binary = args.contextdb_binary.resolve()
    watcher = args.contextdb_watcher.resolve()
    for artifact in (binary, watcher):
        if not artifact.is_file():
            raise FileNotFoundError(f"ContextDB build artifact is missing: {artifact}")
    commit = require_clean_source()
    tasks = load_all_tasks() if args.mode == "full" else load_pilot_tasks()
    baseline = historical_baseline(tasks)
    base_lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    lock = build_toolchain_lock(
        base_lock,
        commit=commit,
        binary=binary,
        watcher=watcher,
    )
    output_root = args.output_root.resolve()
    lock_path = output_root / "toolchain-contextdb.lock.json"
    jobs_dir = output_root / "jobs" / "contextdb"
    command = candidate_command(
        tasks=tasks,
        jobs_dir=jobs_dir,
        binary=binary,
        watcher=watcher,
        toolchain_lock=lock_path,
    )
    manifest = {
        "protocol": PROTOCOL,
        "mode": args.mode,
        "source_commit": commit,
        "tasks": tasks,
        "attempts_per_task": 1,
        "trial_concurrency": TRIAL_CONCURRENCY,
        "morphz_shared_context_concurrency": False,
        "historical_baseline": baseline,
        "candidate": {
            "context_store": "contextdb",
            "binary_sha256": lock["runtime"]["binary_sha256"],
            "watcher_sha256": lock["runtime"]["watcher_sha256"],
            "build_features": lock["runtime"]["build_features"],
            "command": command,
        },
    }
    if args.mode == "validate":
        print(json.dumps(manifest, ensure_ascii=False, indent=2))
        return 0
    output_root.mkdir(parents=True, exist_ok=False)
    lock_path.write_text(
        json.dumps(lock, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (output_root / "launcher_manifest.json").write_text(
        json.dumps(
            {**manifest, "started_at": datetime.now(UTC).isoformat()},
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    logs_dir = output_root / "launcher-logs"
    logs_dir.mkdir()
    jobs_dir.mkdir(parents=True)
    with (logs_dir / "contextdb.stdout.log").open("wb") as stdout, (
        logs_dir / "contextdb.stderr.log"
    ).open("wb") as stderr:
        completed = subprocess.run(
            command,
            cwd=REPO_ROOT,
            env=os.environ.copy(),
            stdin=subprocess.DEVNULL,
            stdout=stdout,
            stderr=stderr,
            check=False,
        )
    job, rewards, authority_audit = load_candidate_outcome(
        jobs_dir=jobs_dir,
        tasks=tasks,
        return_code=completed.returncode,
        logs_dir=logs_dir,
    )
    comparison = {
        "protocol": PROTOCOL,
        "completed_at": datetime.now(UTC).isoformat(),
        "source_commit": commit,
        "task_count": len(tasks),
        "trial_concurrency": TRIAL_CONCURRENCY,
        "morphz_shared_context_concurrency": False,
        "candidate_return_code": completed.returncode,
        "context_store_authority_audit": authority_audit,
        "historical_sources": baseline["sources"],
        **compare_with_history(tasks, rewards, baseline),
    }
    (output_root / "comparison.json").write_text(
        json.dumps(comparison, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(comparison, ensure_ascii=False, indent=2))
    return 2 if comparison["requires_regression_audit"] else 0


if __name__ == "__main__":
    sys.exit(main())
