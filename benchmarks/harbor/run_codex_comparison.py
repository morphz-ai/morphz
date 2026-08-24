#!/usr/bin/env python3
"""Run the fixed official-Codex arm of the raman-fitting attribution trial."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

from benchmarks.harbor.benchmark_integrity import POLICY_VERSION, audit_job
from benchmarks.harbor.run_benchmark import (
    LOCK_PATH,
    REPO_ROOT,
    infrastructure_identity,
    provider_ipv4_base_url,
    runtime_provider_config,
)


CODEX_CLI_VERSION = "0.149.1"
TASK = "raman-fitting"


def command(jobs_dir: Path, *, install_only: bool) -> list[str]:
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    result = [
        "harbor",
        "run",
        "--agent",
        "benchmarks.harbor.codex_comparison_agent:IntegrityCodex",
        "--model",
        "openai/gpt-5.6-sol",
        "--agent-kwarg",
        f"version={CODEX_CLI_VERSION}",
        "--agent-kwarg",
        "reasoning_effort=max",
        "--env",
        "docker",
        "--jobs-dir",
        str(jobs_dir),
        "--dataset",
        f"{lock['terminal_bench']['dataset']}@{lock['terminal_bench']['registry_ref']}",
        "--include-task-name",
        f"terminal-bench/{TASK}",
        "--n-attempts",
        "1",
        "--n-concurrent",
        "1",
        "--max-retries",
        "0",
        "--yes",
    ]
    if install_only:
        result.append("--install-only")
    return result


def _job_dirs(root: Path) -> set[Path]:
    if not root.is_dir():
        return set()
    return {path.resolve() for path in root.iterdir() if path.is_dir()}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("install-only", "full"))
    parser.add_argument(
        "--jobs-dir", type=Path, default=REPO_ROOT / "jobs-codex-comparison"
    )
    args = parser.parse_args()

    base_url, protocol, credential = runtime_provider_config()
    if protocol != "openai-responses":
        raise RuntimeError(f"Expected openai-responses, got {protocol}")
    effective_base_url, provider_host, provider_address = provider_ipv4_base_url(
        base_url
    )
    environment = os.environ.copy()
    environment.update(
        {
            "PYTHONPATH": str(REPO_ROOT),
            "OPENAI_BASE_URL": effective_base_url,
            "OPENAI_API_KEY": credential,
            "DOCKER_DEFAULT_PLATFORM": "linux/amd64",
        }
    )
    before = _job_dirs(args.jobs_dir)
    return_code = subprocess.run(
        command(args.jobs_dir, install_only=args.mode == "install-only"),
        cwd=REPO_ROOT,
        env=environment,
        check=False,
    ).returncode
    if args.mode == "install-only":
        return return_code

    new_jobs = sorted(_job_dirs(args.jobs_dir) - before)
    if len(new_jobs) != 1:
        raise RuntimeError(f"Expected exactly one new Codex job, got {len(new_jobs)}")
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    run_identity = infrastructure_identity()
    run_identity.update(
        {
            "comparison_protocol": "raman-agent-attribution-v1",
            "agent": "official-codex-cli",
            "codex_cli_version": CODEX_CLI_VERSION,
            "model": "gpt-5.6-sol",
            "reasoning_effort": "max",
            "provider_protocol": protocol,
            "provider_host": provider_host,
            "provider_ipv4": provider_address,
            "fallback": False,
            "permission_mode": "dangerously-bypass-approvals-and-sandbox",
            "dataset": lock["terminal_bench"]["dataset"],
            "dataset_registry_ref": lock["terminal_bench"]["registry_ref"],
            "task_filters": [TASK],
            "attempts": 1,
            "concurrency": 1,
            "max_retries": 0,
            "integrity_policy": POLICY_VERSION,
        }
    )
    audit = audit_job(
        new_jobs[0],
        expected_trial_count=1,
        expected_tasks={TASK},
        attempts_per_task=1,
        run_identity=run_identity,
    )
    print("codex_cli_version=" + CODEX_CLI_VERSION)
    print("raw_mean_reward=" + str(audit["raw_mean_reward"]))
    print("strict_mean_reward=" + str(audit["strict_mean_reward"]))
    print("integrity_gate_passed=" + str(audit["integrity_gate_passed"]).lower())
    print("strict_result=" + str(new_jobs[0] / "strict_result.json"))
    if return_code != 0:
        return return_code
    return 0 if audit["integrity_gate_passed"] else 3


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"Codex comparison launcher failed: {error}", file=sys.stderr)
        raise SystemExit(2) from error
