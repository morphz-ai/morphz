#!/usr/bin/env python3
"""Run a traceable legacy-vs-ContextDB ME-08 comparison.

The two arms run sequentially so they never contend for one Provider or host,
while each arm preserves ME-08's eight isolated Harbor trials. Every trial has
its own Morphz Agent, Context, Session, SQLite database and task container.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from benchmarks.harbor.run_benchmark import LOCK_PATH, REPO_ROOT


PROTOCOL = "contextdb-me08-isolated-context-ab-v1"
PILOT_PATH = Path(__file__).with_name("contextdb_me08_pilot_tasks_v1.json")
FIRST_40_PATH = Path(__file__).with_name("first_40_tasks_v1.json")
REMAINING_49_PATH = Path(__file__).with_name("remaining_49_tasks_v1.json")
CONCURRENCY_PER_ARM = 8
ARMS = ("legacy", "contextdb")


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
        raise RuntimeError("ContextDB ME-08 A/B requires a clean tracked worktree")
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
    if payload.get("trial_concurrency_per_arm") != CONCURRENCY_PER_ARM:
        raise RuntimeError("ContextDB ME-08 pilot concurrency drifted from eight")
    return tasks


def build_toolchain_lock(
    base: dict[str, Any],
    *,
    arm: str,
    commit: str,
    binary: Path,
    watcher: Path,
) -> dict[str, Any]:
    if arm not in ARMS:
        raise ValueError(f"unknown Context store arm: {arm}")
    lock = json.loads(json.dumps(base))
    features = ["experimental-context-db"] if arm == "contextdb" else []
    lock["runtime"] = {
        "git_tag": f"contextdb-final-ab-{commit[:12]}-{arm}",
        "git_commit": commit,
        "build_git_commit": commit,
        "build_profile": "release",
        "build_features": features,
        "build_command": (
            "cargo build --release -p morphz --bin morphz --bin morphz-harbor-wait"
            + (" --features experimental-context-db" if features else "")
        ),
        "target": "x86_64-unknown-linux-gnu",
        "container_platform": "linux/amd64",
        "binary_sha256": sha256_file(binary),
        "watcher_sha256": sha256_file(watcher),
    }
    return lock


def arm_command(
    *,
    arm: str,
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
        arm,
        "--attempts",
        "1",
        "--concurrency",
        str(CONCURRENCY_PER_ARM),
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


def audit_context_store_receipts(job: Path, *, arm: str, expected: int) -> None:
    receipts = sorted(job.rglob("context_store_audit.json"))
    if len(receipts) != expected:
        raise RuntimeError(
            f"{arm} arm has {len(receipts)} Context store receipts, expected {expected}"
        )
    for path in receipts:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if payload.get("context_store") != arm:
            raise RuntimeError(f"Context store receipt selected the wrong arm: {path}")
        expected_authority = 1 if arm == "contextdb" else 0
        if payload.get("context_db_authority_count") != expected_authority:
            raise RuntimeError(f"Context store authority receipt failed: {path}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("validate", "pilot", "full"))
    parser.add_argument("--legacy-binary", type=Path, required=True)
    parser.add_argument("--legacy-watcher", type=Path, required=True)
    parser.add_argument("--contextdb-binary", type=Path, required=True)
    parser.add_argument("--contextdb-watcher", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    paths = {
        "legacy": (args.legacy_binary.resolve(), args.legacy_watcher.resolve()),
        "contextdb": (
            args.contextdb_binary.resolve(),
            args.contextdb_watcher.resolve(),
        ),
    }
    for arm, artifacts in paths.items():
        for artifact in artifacts:
            if not artifact.is_file():
                raise FileNotFoundError(f"{arm} build artifact is missing: {artifact}")
    commit = require_clean_source()
    tasks = load_all_tasks() if args.mode == "full" else load_pilot_tasks()
    base_lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    output_root = args.output_root.resolve()
    if args.mode != "validate":
        output_root.mkdir(parents=True, exist_ok=False)
    locks: dict[str, dict[str, Any]] = {}
    lock_paths: dict[str, Path] = {}
    commands: dict[str, list[str]] = {}
    for arm in ARMS:
        binary, watcher = paths[arm]
        locks[arm] = build_toolchain_lock(
            base_lock,
            arm=arm,
            commit=commit,
            binary=binary,
            watcher=watcher,
        )
        lock_paths[arm] = output_root / f"toolchain-{arm}.lock.json"
        jobs_dir = output_root / "jobs" / arm
        commands[arm] = arm_command(
            arm=arm,
            tasks=tasks,
            jobs_dir=jobs_dir,
            binary=binary,
            watcher=watcher,
            toolchain_lock=lock_paths[arm],
        )
    manifest = {
        "protocol": PROTOCOL,
        "mode": args.mode,
        "source_commit": commit,
        "tasks": tasks,
        "attempts_per_task": 1,
        "trial_concurrency_per_arm": CONCURRENCY_PER_ARM,
        "morphz_shared_context_concurrency": False,
        "arm_execution": "sequential",
        "arms": {
            arm: {
                "context_store": arm,
                "binary_sha256": locks[arm]["runtime"]["binary_sha256"],
                "watcher_sha256": locks[arm]["runtime"]["watcher_sha256"],
                "build_features": locks[arm]["runtime"]["build_features"],
                "command": commands[arm],
            }
            for arm in ARMS
        },
    }
    if args.mode == "validate":
        print(json.dumps(manifest, ensure_ascii=False, indent=2))
        return 0
    for arm in ARMS:
        lock_paths[arm].write_text(
            json.dumps(locks[arm], ensure_ascii=False, indent=2) + "\n",
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
    return_codes: dict[str, int] = {}
    for arm in ARMS:
        jobs_dir = output_root / "jobs" / arm
        jobs_dir.mkdir(parents=True)
        with (logs_dir / f"{arm}.stdout.log").open("wb") as stdout, (
            logs_dir / f"{arm}.stderr.log"
        ).open("wb") as stderr:
            completed = subprocess.run(
                commands[arm],
                cwd=REPO_ROOT,
                env=os.environ.copy(),
                stdin=subprocess.DEVNULL,
                stdout=stdout,
                stderr=stderr,
                check=False,
            )
        return_codes[arm] = completed.returncode
        if completed.returncode != 0:
            raise RuntimeError(
                f"{arm} ME-08 arm failed before a complete comparison; "
                f"see {logs_dir}"
            )
    rewards: dict[str, dict[str, int]] = {}
    jobs: dict[str, Path] = {}
    for arm in ARMS:
        jobs[arm] = only_job(output_root / "jobs" / arm)
        audit_context_store_receipts(jobs[arm], arm=arm, expected=len(tasks))
        rewards[arm] = load_rewards(jobs[arm], tasks)
    rows = [
        {
            "task": task,
            "legacy": rewards["legacy"][task],
            "contextdb": rewards["contextdb"][task],
        }
        for task in tasks
    ]
    legacy_only = [row["task"] for row in rows if row["legacy"] > row["contextdb"]]
    contextdb_only = [row["task"] for row in rows if row["contextdb"] > row["legacy"]]
    comparison = {
        "protocol": PROTOCOL,
        "completed_at": datetime.now(UTC).isoformat(),
        "source_commit": commit,
        "task_count": len(tasks),
        "trial_concurrency_per_arm": CONCURRENCY_PER_ARM,
        "morphz_shared_context_concurrency": False,
        "return_codes": return_codes,
        "passed": {
            arm: sum(rewards[arm].values()) for arm in ARMS
        },
        "legacy_pass_contextdb_fail": legacy_only,
        "contextdb_pass_legacy_fail": contextdb_only,
        "requires_regression_audit": bool(legacy_only),
        "per_task": rows,
    }
    (output_root / "comparison.json").write_text(
        json.dumps(comparison, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(comparison, ensure_ascii=False, indent=2))
    return 2 if legacy_only else 0


if __name__ == "__main__":
    sys.exit(main())
