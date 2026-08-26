#!/usr/bin/env python3
"""Launch ME-09: one Morphz Agent/Context, eight Sessions and Targets.

Each lane invokes one official Terminal-Bench task at a time.  The eight lanes
run concurrently, while each lane's exact task order is frozen by the manifest.
Every official verifier result remains primary; the launcher only adds routing,
identity and completeness evidence around those unmodified verifiers.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

if __package__:
    from .run_benchmark import runtime_provider_config, selected_harness
    from .shared_context_agent import _request_json
else:
    from run_benchmark import runtime_provider_config, selected_harness
    from shared_context_agent import _request_json


REPO_ROOT = Path(__file__).resolve().parents[2]
LOCK_PATH = Path(__file__).with_name("toolchain.lock.json")
DEFAULT_MANIFEST = Path(__file__).with_name("me09_task_manifest_v1.json")
DEFAULT_HARNESS = (
    REPO_ROOT / "morphz-evals" / "harnesses" / "terminal-task.hns"
)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _git(*args: str) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=REPO_ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    ).stdout.strip()


def load_and_validate_manifest(path: Path) -> dict[str, Any]:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    lanes = manifest.get("lanes")
    if not isinstance(lanes, list) or len(lanes) != 8:
        raise ValueError("ME-09 manifest must contain exactly eight lanes")
    lane_ids = [int(lane["lane_id"]) for lane in lanes]
    if lane_ids != list(range(8)):
        raise ValueError(f"ME-09 lane IDs must be 0..7 in order, got {lane_ids}")
    sessions = [str(lane["session_id"]) for lane in lanes]
    targets = [str(lane["target_id"]) for lane in lanes]
    if len(set(sessions)) != 8 or len(set(targets)) != 8:
        raise ValueError("ME-09 Session and Target IDs must be unique")
    tasks = [str(task) for lane in lanes for task in lane["tasks"]]
    if len(tasks) != int(manifest.get("task_count", -1)) or len(tasks) != 89:
        raise ValueError(f"ME-09 manifest must contain 89 tasks, got {len(tasks)}")
    if len(set(tasks)) != len(tasks):
        raise ValueError("ME-09 manifest contains duplicate tasks")
    sizes = sorted(len(lane["tasks"]) for lane in lanes)
    if sizes != [11, 11, 11, 11, 11, 11, 11, 12]:
        raise ValueError(f"ME-09 lane sizes must be seven 11s and one 12, got {sizes}")
    interleaved = [
        str(lane["tasks"][ordinal])
        for ordinal in range(max(len(lane["tasks"]) for lane in lanes))
        for lane in lanes
        if ordinal < len(lane["tasks"])
    ]
    order_digest = hashlib.sha256(
        ("\n".join(interleaved) + "\n").encode("utf-8")
    ).hexdigest()
    if order_digest != manifest.get("frozen_task_order_sha256"):
        raise ValueError(
            "ME-09 frozen task order digest mismatch: "
            f"expected {manifest.get('frozen_task_order_sha256')}, got {order_digest}"
        )
    return manifest


def _provider_preflight(base_url: str, credential: str) -> None:
    request = urllib.request.Request(base_url.rstrip("/") + "/models")
    if credential:
        request.add_header("Authorization", f"Bearer {credential}")
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            body = json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read(1024).decode("utf-8", errors="replace")
        raise RuntimeError(
            f"ME-09 Provider preflight failed with HTTP {error.code}: {detail}"
        ) from error
    models = body.get("data") if isinstance(body, dict) else None
    model_ids = {
        str(item.get("id"))
        for item in models or []
        if isinstance(item, dict) and item.get("id")
    }
    if "gpt-5.6-sol" not in model_ids:
        raise RuntimeError("Provider does not advertise exact model gpt-5.6-sol")


def _write_runtime_config(
    path: Path,
    *,
    protocol: str,
    base_url: str,
) -> None:
    path.write_text(
        "\n".join(
            [
                "[llm]",
                'provider = "me09"',
                'model = "gpt-5.6-sol"',
                'reasoning_effort = "max"',
                "",
                "[providers.me09]",
                f"protocol = {json.dumps(protocol)}",
                f"base_url = {json.dumps(base_url)}",
                'credential = "me09"',
                "",
                "[credentials.me09]",
                'source = "env"',
                'name = "MORPHZ_PROVIDER_API_KEY"',
                "",
                "[orchestrator]",
                "model_provider_max_in_flight = 8",
                "context_soft_token_limit = 196608",
                "context_hard_token_limit = 262144",
                "context_maintenance_reserve_tokens = 32768",
                "",
                "[orchestrator.activation_admission]",
                "max_in_flight = 16",
                "",
                "[permissions]",
                'mode = "full_access"',
                'shell_environment_policy = "remove_sensitive"',
                "",
                "[storage]",
                'backend = "sqlite"',
                "",
                "[edge_execution]",
                "max_in_flight_per_node = 8",
                "",
            ]
        ),
        encoding="utf-8",
    )


def _wait_health(base_url: str, process: subprocess.Popen[bytes]) -> None:
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(
                f"central Morphz Runtime exited during startup with {process.returncode}"
            )
        try:
            with urllib.request.urlopen(base_url.rstrip("/") + "/health", timeout=2) as response:
                if 200 <= response.status < 300:
                    return
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(0.25)
    raise TimeoutError("central Morphz Runtime did not become healthy in 90 seconds")


def _ensure_sessions(
    manifest: dict[str, Any],
    *,
    base_url: str,
    token: str,
) -> None:
    for lane in manifest["lanes"]:
        session_id = str(lane["session_id"])
        try:
            existing = _request_json(
                base_url, token, "GET", f"/api/sessions/{session_id}"
            )
        except RuntimeError as error:
            if "HTTP 404" not in str(error):
                raise
            existing = {}
        if existing:
            if existing.get("context_id") != "me09-shared-context":
                raise RuntimeError(
                    f"ME-09 Session {session_id} is mounted to the wrong Context"
                )
            continue
        _request_json(
            base_url,
            token,
            "POST",
            "/api/sessions",
            {
                "id": session_id,
                "title": f"ME-09 Terminal-Bench lane {int(lane['lane_id']):02d}",
                "mount": {
                    "type": "existing_context",
                    "context_id": "me09-shared-context",
                },
            },
        )


def _harbor_command(
    *,
    jobs_dir: Path,
    task: str,
    dataset: str,
    dataset_ref: str,
) -> list[str]:
    return [
        "harbor",
        "run",
        "--agent",
        "benchmarks.harbor.shared_context_agent:SharedContextMorphzAgent",
        "--model",
        "custom/gpt-5.6-sol",
        "--env",
        "docker",
        "--jobs-dir",
        str(jobs_dir),
        "--n-attempts",
        "1",
        "--n-concurrent",
        "1",
        "--max-retries",
        "0",
        "--dataset",
        f"{dataset}@{dataset_ref}",
        "--include-task-name",
        f"terminal-bench/{task}",
        "--yes",
    ]


def _run_lane(
    lane: dict[str, Any],
    *,
    tasks: list[str],
    run_root: Path,
    base_environment: dict[str, str],
    dataset: str,
    dataset_ref: str,
) -> dict[str, Any]:
    lane_id = int(lane["lane_id"])
    lane_root = run_root / "jobs" / f"lane-{lane_id:02d}"
    lane_root.mkdir(parents=True, exist_ok=True)
    task_results: list[dict[str, Any]] = []
    environment = dict(base_environment)
    environment["MORPHZ_ME09_LANE_ID"] = str(lane_id)
    for ordinal, task in enumerate(tasks):
        task_root = lane_root / f"{ordinal:02d}-{task}"
        task_root.mkdir(parents=True, exist_ok=False)
        jobs_dir = task_root / "jobs"
        jobs_dir.mkdir()
        stdout_path = task_root / "harbor.stdout.log"
        stderr_path = task_root / "harbor.stderr.log"
        started_at = datetime.now(UTC).isoformat()
        before = set(jobs_dir.iterdir())
        with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
            completed = subprocess.run(
                _harbor_command(
                    jobs_dir=jobs_dir,
                    task=task,
                    dataset=dataset,
                    dataset_ref=dataset_ref,
                ),
                cwd=REPO_ROOT,
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=stdout,
                stderr=stderr,
                check=False,
            )
        after = set(jobs_dir.iterdir())
        created = sorted(path for path in after - before if path.is_dir())
        task_results.append(
            {
                "ordinal": ordinal,
                "task": task,
                "started_at": started_at,
                "finished_at": datetime.now(UTC).isoformat(),
                "return_code": completed.returncode,
                "job_dirs": [str(path) for path in created],
            }
        )
        (task_root / "launcher_result.json").write_text(
            json.dumps(task_results[-1], indent=2) + "\n", encoding="utf-8"
        )
    return {
        "lane_id": lane_id,
        "session_id": lane["session_id"],
        "target_id": lane["target_id"],
        "tasks": task_results,
    }


def _stop_runtime(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    process.send_signal(signal.SIGINT)
    try:
        process.wait(timeout=30)
    except subprocess.TimeoutExpired:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("preflight", "smoke", "full"))
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--runtime-commit", required=True)
    parser.add_argument("--expected-binary-sha256", required=True)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--harness", type=Path, default=DEFAULT_HARNESS)
    parser.add_argument("--run-root", type=Path, required=True)
    parser.add_argument("--bind", default="0.0.0.0:8429")
    parser.add_argument("--host-url", default="http://127.0.0.1:8429")
    parser.add_argument("--edge-url", default="http://172.17.0.1:8429")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    binary = args.binary.expanduser().resolve()
    manifest_path = args.manifest.expanduser().resolve()
    harness = args.harness.expanduser().resolve()
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise FileNotFoundError(f"ME-09 executable is missing: {binary}")
    runtime_commit = args.runtime_commit.strip()
    if len(runtime_commit) != 40 or any(
        character not in "0123456789abcdef" for character in runtime_commit
    ):
        raise ValueError("ME-09 runtime commit must be a full lowercase Git SHA")
    binary_sha256 = _sha256(binary)
    expected_binary_sha256 = args.expected_binary_sha256.strip().lower()
    if binary_sha256 != expected_binary_sha256:
        raise RuntimeError(
            "ME-09 Runtime binary differs from the frozen ME-08 binary: "
            f"expected {expected_binary_sha256}, got {binary_sha256}"
        )
    if not harness.is_file():
        raise FileNotFoundError(f"ME-09 Harness is missing: {harness}")
    manifest = load_and_validate_manifest(manifest_path)
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    harness_lock = selected_harness(lock, "minimal-v0.5")
    if _sha256(harness) != str(harness_lock["source_sha256"]):
        raise RuntimeError("ME-09 Harness source digest differs from minimal-v0.5 lock")
    base_url, protocol, credential = runtime_provider_config()
    if protocol != "openai-responses":
        raise RuntimeError(f"ME-09 requires openai-responses, got {protocol}")
    _provider_preflight(base_url, credential)
    if shutil.which("harbor") is None:
        raise RuntimeError("Harbor executable is not installed")
    infrastructure_commit = _git("rev-parse", "HEAD")
    tracked_status = _git("status", "--porcelain", "--untracked-files=no")
    if args.mode == "full" and tracked_status:
        raise RuntimeError("formal ME-09 requires a clean tracked worktree")
    print("preflight=passed")
    print("protocol_id=" + str(manifest["protocol_id"]))
    print("runtime_commit=" + runtime_commit)
    print("runtime_sha256=" + binary_sha256)
    print("infrastructure_commit=" + infrastructure_commit)
    print("model=gpt-5.6-sol")
    print("reasoning_effort=max")
    print("permission_mode=full_access")
    print("lane_count=8")
    print("shared_context=me09-shared-context")
    if args.mode == "preflight":
        return 0

    run_root = args.run_root.expanduser().resolve()
    if run_root.exists():
        raise FileExistsError(f"ME-09 run root already exists: {run_root}")
    run_root.mkdir(parents=True)
    runtime_root = run_root / "runtime"
    runtime_root.mkdir()
    config_path = runtime_root / "morphz.toml"
    _write_runtime_config(config_path, protocol=protocol, base_url=base_url)
    database_path = runtime_root / "morphz.db"
    artifact_dir = runtime_root / "artifacts"
    artifact_dir.mkdir()
    dashboard_token = hashlib.sha256(os.urandom(64)).hexdigest()
    runtime_environment = os.environ.copy()
    runtime_environment.update(
        {
            "MORPHZ_PROVIDER_API_KEY": credential,
            "MORPHZ_DASHBOARD_TOKEN": dashboard_token,
            "MORPHZ_AGENT_ID": "me09-agent",
            "MORPHZ_CONTEXT_ID": "me09-shared-context",
            "MORPHZ_SESSION_ID": "me09-session-00",
            "MORPHZ_STORAGE_SQLITE_PATH": str(database_path),
            "MORPHZ_ARTIFACT_DIR": str(artifact_dir),
            "MORPHZ_CODING_EVAL_MODE": "true",
            "MORPHZ_PERMISSION_MODE": "full_access",
            "MORPHZ_CONTEXT_SOFT_TOKEN_LIMIT": "196608",
            "MORPHZ_CONTEXT_HARD_TOKEN_LIMIT": "262144",
            "MORPHZ_CONTEXT_MAINTENANCE_RESERVE_TOKENS": "32768",
        }
    )
    install = subprocess.run(
        [
            str(binary),
            "--config-file",
            str(config_path),
            "harness",
            "install",
            str(harness),
        ],
        cwd=run_root,
        env=runtime_environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if install.returncode != 0:
        raise RuntimeError(
            "ME-09 Harness installation failed: "
            + install.stderr.decode("utf-8", errors="replace")[-4000:]
        )
    runtime_stdout = (runtime_root / "stdout.log").open("wb")
    runtime_stderr = (runtime_root / "stderr.log").open("wb")
    runtime_process = subprocess.Popen(
        [
            str(binary),
            "--config-file",
            str(config_path),
            "serve",
            f"--bind={args.bind}",
        ],
        cwd=run_root,
        env=runtime_environment,
        stdin=subprocess.DEVNULL,
        stdout=runtime_stdout,
        stderr=runtime_stderr,
    )
    started_at = datetime.now(UTC).isoformat()
    lane_results: list[dict[str, Any]] = []
    try:
        _wait_health(args.host_url, runtime_process)
        _ensure_sessions(
            manifest,
            base_url=args.host_url,
            token=dashboard_token,
        )
        lane_environment = os.environ.copy()
        # The Provider credential belongs only to the central Runtime.  It is
        # deliberately absent from all Harbor/Edge task processes.
        lane_environment.pop("MORPHZ_PROVIDER_API_KEY", None)
        lane_environment.update(
            {
                "PYTHONPATH": str(REPO_ROOT),
                "MORPHZ_ME09_BINARY": str(binary),
                "MORPHZ_ME09_MANIFEST": str(manifest_path),
                "MORPHZ_ME09_HOST_URL": args.host_url,
                "MORPHZ_ME09_EDGE_URL": args.edge_url,
                "MORPHZ_ME09_DASHBOARD_TOKEN": dashboard_token,
                "MORPHZ_ME09_DB_PATH": str(database_path),
                "MORPHZ_ME09_RUNTIME_VERSION": f"{runtime_commit}@{binary_sha256}",
                "DOCKER_DEFAULT_PLATFORM": "linux/amd64",
            }
        )
        lanes = manifest["lanes"]
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
            futures = {
                executor.submit(
                    _run_lane,
                    lane,
                    tasks=(list(lane["tasks"]) if args.mode == "full" else [lane["tasks"][0]]),
                    run_root=run_root,
                    base_environment=lane_environment,
                    dataset=str(manifest["dataset"]),
                    dataset_ref=str(manifest["dataset_registry_ref"]),
                ): int(lane["lane_id"])
                for lane in lanes
            }
            pending = set(futures)
            while pending:
                if runtime_process.poll() is not None:
                    raise RuntimeError(
                        "central Morphz Runtime exited while ME-09 lanes were active"
                    )
                done, pending = concurrent.futures.wait(
                    pending,
                    timeout=2,
                    return_when=concurrent.futures.FIRST_COMPLETED,
                )
                for future in done:
                    lane_results.append(future.result())
        lane_results.sort(key=lambda item: int(item["lane_id"]))
    finally:
        _stop_runtime(runtime_process)
        runtime_stdout.close()
        runtime_stderr.close()

    expected_tasks = 89 if args.mode == "full" else 8
    task_results = [task for lane in lane_results for task in lane["tasks"]]
    launcher_result = {
        "protocol_id": manifest["protocol_id"],
        "mode": args.mode,
        "started_at": started_at,
        "finished_at": datetime.now(UTC).isoformat(),
        "runtime_commit": runtime_commit,
        "runtime_binary_sha256": binary_sha256,
        "infrastructure_commit": infrastructure_commit,
        "infrastructure_tracked_clean": not bool(tracked_status),
        "model": "gpt-5.6-sol",
        "reasoning_effort": "max",
        "permission_mode": "full_access",
        "shared_context_id": "me09-shared-context",
        "lane_count": 8,
        "expected_task_count": expected_tasks,
        "observed_task_count": len(task_results),
        "harbor_process_failures": sum(
            int(task["return_code"] != 0) for task in task_results
        ),
        "lanes": lane_results,
    }
    (run_root / "launcher_result.json").write_text(
        json.dumps(launcher_result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    if len(task_results) != expected_tasks:
        raise RuntimeError(
            f"ME-09 launcher closed {len(task_results)} tasks, expected {expected_tasks}"
        )
    return 0 if launcher_result["harbor_process_failures"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
