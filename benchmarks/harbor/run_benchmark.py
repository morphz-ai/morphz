#!/usr/bin/env python3
"""Run the pinned Harbor/TB2.1 configuration without exposing credentials.

The launcher accepts an explicitly injected provider endpoint and credential
on an isolated experiment node. For backward compatibility it can also resolve
the existing host Morphz `custom` provider. In either mode, the credential is
kept out of argv, profiles and job manifests.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import tomllib
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse, urlunparse

if __package__:
    from .benchmark_gate import audit_gate
    from .benchmark_integrity import audit_job
else:
    from benchmark_gate import audit_gate
    from benchmark_integrity import audit_job


REPO_ROOT = Path(__file__).resolve().parents[2]
LOCK_PATH = Path(__file__).with_name("toolchain.lock.json")
DEFAULT_BINARY = REPO_ROOT / ".codex-work" / "harbor-runtime" / "morphz"
DEFAULT_WATCHER = REPO_ROOT / ".codex-work" / "harbor-runtime" / "morphz-harbor-wait"


def morphz_home() -> Path:
    raw = os.environ.get("MORPHZ_HOME")
    return Path(raw).expanduser() if raw else Path.home() / ".morphz"


def load_host_config() -> dict[str, object]:
    path = morphz_home() / "morphz.toml"
    if not path.is_file():
        raise RuntimeError(f"Morphz host configuration not found: {path}")
    with path.open("rb") as source:
        return tomllib.load(source)


def provider_config(config: dict[str, object]) -> tuple[str, str, str | None]:
    providers = config.get("provider_instances") or config.get("providers") or {}
    provider = providers.get("custom") if isinstance(providers, dict) else None
    provider = provider if isinstance(provider, dict) else {}
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    model_lock = lock["model"]
    base_url = str(
        provider.get("base_url") or model_lock["provider_base_url"]
    ).strip()
    protocol = str(
        provider.get("protocol") or model_lock["provider_protocol"]
    ).strip()
    credential_ref = provider.get("credential") or "custom"
    return base_url, protocol, str(credential_ref) if credential_ref else None


def runtime_provider_config() -> tuple[str, str, str]:
    """Resolve one explicit cloud route or the legacy host-configured route."""
    direct_base_url = os.environ.get("MORPHZ_PROVIDER_BASE_URL", "").strip()
    if direct_base_url:
        lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
        protocol = os.environ.get(
            "MORPHZ_PROVIDER_PROTOCOL",
            str(lock["model"]["provider_protocol"]),
        ).strip()
        credential = os.environ.get("MORPHZ_PROVIDER_API_KEY")
        if credential is None:
            raise RuntimeError(
                "MORPHZ_PROVIDER_API_KEY must be exported when "
                "MORPHZ_PROVIDER_BASE_URL is supplied"
            )
        return direct_base_url, protocol, credential

    config = load_host_config()
    base_url, protocol, credential_ref = provider_config(config)
    provider_host = urlparse(base_url).hostname or ""
    credential = resolve_credential(config, credential_ref, provider_host)
    return base_url, protocol, credential


def runtime_version(lock: dict[str, object]) -> str:
    runtime = lock["runtime"]
    return f'{runtime["git_tag"]}@{runtime["git_commit"]}'


def selected_harness(lock: dict[str, object], profile: str) -> dict[str, object]:
    profiles = lock.get("harness_profiles")
    if isinstance(profiles, dict) and profile in profiles:
        harness = profiles[profile]
    else:
        raise RuntimeError(f"Unknown frozen Harness profile: {profile}")
    if not isinstance(harness, dict):
        raise RuntimeError(f"Invalid frozen Harness profile: {profile}")
    return harness


def resolve_minim4_proxy_credential(host: str) -> str:
    if host != "mini-m4.local":
        raise RuntimeError(f"No benchmark credential helper is defined for provider host `{host}`")
    ruby = (
        "/usr/bin/ruby -ryaml -e "
        "'c=YAML.load_file(\"/opt/homebrew/etc/cliproxyapi.conf\"); "
        "k=Array(c[\"api-keys\"]).first; abort(\"no api key\") unless k; print k'"
    )
    result = subprocess.run(
        [
            "ssh",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=5",
            host,
            ruby,
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        timeout=10,
        check=True,
    )
    value = result.stdout.strip()
    if not value:
        raise RuntimeError("CLIProxyAPI credential helper returned no value")
    return value


def resolve_credential(
    config: dict[str, object], credential_ref: str | None, provider_host: str
) -> str:
    credentials = config.get("credentials") or {}
    if not isinstance(credentials, dict):
        credentials = {}
    credential_id = credential_ref or "custom"
    credential = credentials.get(credential_id)
    if not isinstance(credential, dict):
        direct = os.environ.get("MORPHZ_PROVIDER_API_KEY")
        if direct:
            return direct
        raise RuntimeError(f"Morphz credential `{credential_id}` is not configured")

    source = str(credential.get("source") or "env")
    if source == "env":
        name = str(credential.get("name") or "MORPHZ_PROVIDER_API_KEY")
        value = os.environ.get(name)
        if not value:
            return resolve_minim4_proxy_credential(provider_host)
        return value
    if source == "command":
        command = credential.get("command")
        if not isinstance(command, list) or not command:
            raise RuntimeError(f"Credential `{credential_id}` has an empty helper command")
        result = subprocess.run(
            [str(item) for item in command],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
            check=True,
        )
        value = result.stdout.strip()
        if not value:
            raise RuntimeError(f"Credential helper for `{credential_id}` returned no value")
        return value
    if source == "keychain":
        if platform.system() != "Darwin":
            raise RuntimeError("Keychain credential resolution is only available on macOS")
        account = str(credential.get("name") or credential_id)
        service = str(credential.get("service") or "morphz")
        result = subprocess.run(
            [
                "security",
                "find-generic-password",
                "-s",
                service,
                "-a",
                account,
                "-w",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
            check=True,
        )
        value = result.stdout.strip()
        if not value:
            raise RuntimeError(f"Keychain credential `{credential_id}` is empty")
        return value
    if source == "none":
        return ""
    raise RuntimeError(f"Unsupported credential source: {source}")


def require_tool(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise RuntimeError(f"Required executable is missing: {name}")
    return path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def provider_ipv4_base_url(base_url: str) -> tuple[str, str, str]:
    parsed = urlparse(base_url)
    host = parsed.hostname or ""
    if not host:
        raise RuntimeError(f"Provider base URL has no host: {base_url}")
    addresses = {
        item[4][0]
        for item in socket.getaddrinfo(
            host,
            parsed.port or (443 if parsed.scheme == "https" else 80),
            family=socket.AF_INET,
            type=socket.SOCK_STREAM,
        )
    }
    if not addresses:
        raise RuntimeError(f"Provider host has no IPv4 address: {host}")
    address = sorted(addresses)[0]
    port = f":{parsed.port}" if parsed.port else ""
    effective = urlunparse(parsed._replace(netloc=f"{address}{port}"))
    return effective, host, address


def advertised_model_ids(body: object) -> set[str]:
    models = body.get("data") if isinstance(body, dict) else None
    return {
        str(item.get("id"))
        for item in models or []
        if isinstance(item, dict) and item.get("id")
    }


def preflight(
    binary: Path,
    watcher: Path,
    base_url: str,
    credential: str,
    logical_host: str,
    provider_address: str,
) -> None:
    require_tool("docker")
    require_tool("harbor")
    harbor_version = subprocess.run(
        ["harbor", "--version"], capture_output=True, text=True, check=True
    ).stdout.strip()
    if harbor_version != "0.21.0":
        raise RuntimeError(f"Harbor 0.21.0 required, got {harbor_version}")
    subprocess.run(
        ["docker", "info", "--format", "{{.ServerVersion}}"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=True,
    )
    if not binary.is_file():
        raise RuntimeError(f"Pinned Linux Morphz binary is missing: {binary}")
    file_result = subprocess.run(
        ["file", str(binary)], capture_output=True, text=True, check=True
    ).stdout
    if "ELF" not in file_result or "x86-64" not in file_result:
        raise RuntimeError(f"Expected an x86-64 Linux ELF binary, got: {file_result.strip()}")
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    expected_sha = str(lock["runtime"]["binary_sha256"])
    actual_sha = sha256_file(binary)
    if actual_sha != expected_sha:
        raise RuntimeError(
            f"Pinned Morphz binary SHA-256 mismatch: expected {expected_sha}, got {actual_sha}"
        )
    if not watcher.is_file():
        raise RuntimeError(f"Pinned Harbor watcher is missing: {watcher}")
    watcher_expected = str(lock["runtime"]["watcher_sha256"])
    watcher_actual = sha256_file(watcher)
    if watcher_actual != watcher_expected:
        raise RuntimeError(
            "Pinned Harbor watcher SHA-256 mismatch: "
            f"expected {watcher_expected}, got {watcher_actual}"
        )

    request = urllib.request.Request(base_url.rstrip("/") + "/models")
    if credential:
        request.add_header("Authorization", f"Bearer {credential}")
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            body = json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read(512).decode("utf-8", errors="replace").strip()
        suffix = f": {detail}" if detail else ""
        raise RuntimeError(
            f"CLIProxyAPI model preflight failed with HTTP {error.code}{suffix}"
        ) from error
    model_ids = advertised_model_ids(body)
    if "gpt-5.6-sol" not in model_ids:
        raise RuntimeError("CLIProxyAPI does not advertise exact model `gpt-5.6-sol`")
    print("preflight=passed")
    print("harbor=0.21.0")
    print("model=gpt-5.6-sol")
    print("reasoning_effort=max")
    print("provider_node=" + logical_host)
    print("provider_ipv4=" + provider_address)
    print("permission_mode=full_access")
    print("container_platform=linux/amd64")
    print("runtime_sha256=" + actual_sha)
    print("watcher_sha256=" + watcher_actual)


def harbor_command(args: argparse.Namespace, lock: dict[str, object]) -> list[str]:
    command = [
        "harbor",
        "run",
        "--agent",
        "benchmarks.harbor.morphz_agent:MorphzAgent",
        "--model",
        "custom/gpt-5.6-sol",
        "--agent-kwarg",
        "reasoning_effort=max",
        "--env",
        "docker",
        "--jobs-dir",
        str(args.jobs_dir),
        "--n-attempts",
        str(args.attempts),
        "--n-concurrent",
        str(args.concurrency),
        "--max-retries",
        "0",
        "--yes",
    ]
    if args.dataset_path is not None:
        command.extend(["--path", str(args.dataset_path)])
    else:
        dataset = str(lock["terminal_bench"]["dataset"])
        registry_ref = str(lock["terminal_bench"]["registry_ref"])
        command.extend(["--dataset", f"{dataset}@{registry_ref}"])
    if args.limit is not None:
        command.extend(["--n-tasks", str(args.limit)])
    for task in args.task or []:
        task_pattern = task if "/" in task else f"terminal-bench/{task}"
        command.extend(["--include-task-name", task_pattern])
    if args.upload:
        command.append("--upload")
        command.append("--public" if args.public else "--private")
    return command


def expected_job_shape(
    args: argparse.Namespace, lock: dict[str, object]
) -> tuple[int, set[str] | None]:
    """Return the reportable trial count and exact task set when available."""

    exact_tasks: set[str] | None = None
    if args.task:
        if any(any(marker in task for marker in "*?[") for task in args.task):
            raise RuntimeError(
                "Reportable benchmark task filters must be exact names, not globs"
            )
        exact_tasks = {task.rsplit("/", maxsplit=1)[-1] for task in args.task}
        task_count = len(exact_tasks)
    elif args.limit is not None:
        task_count = args.limit
    else:
        task_count = int(lock["terminal_bench"]["task_count"])
    return task_count * args.attempts, exact_tasks


def infrastructure_identity() -> dict[str, object]:
    """Require a frozen tracked worktree and return its immutable Git identity."""

    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    tracked_status = subprocess.run(
        ["git", "status", "--porcelain", "--untracked-files=no"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    if tracked_status:
        raise RuntimeError(
            "Reportable benchmark runs require a clean tracked worktree; "
            "commit the benchmark infrastructure before starting"
        )
    raw_tags = subprocess.run(
        ["git", "tag", "--points-at", commit],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return {
        "infrastructure_git_commit": commit,
        "infrastructure_git_tags": sorted(raw_tags.splitlines()),
        "infrastructure_tracked_clean": True,
    }


def frozen_run_identity(
    args: argparse.Namespace, lock: dict[str, object]
) -> dict[str, object]:
    identity = infrastructure_identity()
    runtime = lock["runtime"]
    dataset = lock["terminal_bench"]
    model = lock["model"]
    permissions = lock["permissions"]
    harness_profile = getattr(args, "harness_profile", None)
    harness_mode = getattr(args, "harness_mode", "none")
    harness: dict[str, object] | None = None
    if harness_mode == "bound":
        if not isinstance(harness_profile, str) or not harness_profile:
            raise RuntimeError("bound Harness mode requires --harness-profile")
        harness = selected_harness(lock, harness_profile)
    identity.update(
        {
            "runtime_tag": runtime["git_tag"],
            "runtime_git_commit": runtime["git_commit"],
            "runtime_binary_sha256": runtime["binary_sha256"],
            "runtime_watcher_sha256": runtime["watcher_sha256"],
            "dataset": dataset["dataset"],
            "dataset_registry_ref": dataset["registry_ref"],
            "dataset_source_commit": dataset["source_commit"],
            "model": model["physical_model"],
            "reasoning_effort": model["reasoning_effort"],
            "fallback": model["fallback"],
            "permission_mode": permissions["mode"],
            "harness_mode": harness_mode,
            "harness_profile": harness_profile if harness is not None else None,
            "harness": (
                {
                    "id": harness["id"],
                    "version": harness["version"],
                    "artifact_hash": harness["artifact_hash"],
                    "source_sha256": harness["source_sha256"],
                }
                if harness is not None
                else None
            ),
            "attempts": args.attempts,
            "concurrency": args.concurrency,
            "max_retries": 0,
            "task_filters": sorted(args.task or []),
        }
    )
    return identity


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "mode",
        choices=("preflight", "install-only", "smoke", "full", "print-command"),
    )
    parser.add_argument("--binary", type=Path, default=DEFAULT_BINARY)
    parser.add_argument("--watcher", type=Path, default=DEFAULT_WATCHER)
    parser.add_argument(
        "--dataset-path",
        type=Path,
        help=(
            "Use a local task directory for development only. Reportable runs "
            "default to the exact Harbor registry dataset pinned in toolchain.lock.json."
        ),
    )
    parser.add_argument("--jobs-dir", type=Path, default=REPO_ROOT / "jobs")
    parser.add_argument(
        "--task",
        action="append",
        help="Include an exact task name or glob; repeat to select a fixed pilot set.",
    )
    parser.add_argument("--limit", type=int)
    parser.add_argument("--attempts", type=int)
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument(
        "--harness-mode",
        choices=("bound", "none"),
        default="none",
        help="Run native Morphz by default; bind only an explicitly selected Harness.",
    )
    parser.add_argument(
        "--harness-profile",
        choices=("dialectical-practice-v0.1",),
        help="Required with --harness-mode bound; selects a digest-locked profile.",
    )
    parser.add_argument(
        "--expect-trials",
        type=int,
        help=(
            "Required for model-running smoke/full modes; the launcher refuses "
            "to start unless the frozen task selection resolves to this count."
        ),
    )
    parser.add_argument("--upload", action="store_true")
    parser.add_argument("--public", action="store_true")
    parser.add_argument(
        "--confirm-89x5-formal",
        action="store_true",
        help=(
            "Required acknowledgement before a full 89-task, five-attempt "
            "formal run. This guard prevents an accidental 445-trial launch."
        ),
    )
    args = parser.parse_args()
    if args.mode in {"install-only", "smoke"}:
        args.limit = args.limit or 1
        args.attempts = args.attempts or 1
    elif args.mode in {"full", "print-command"}:
        # A complete one-attempt diagnostic pass is the safe default.  The
        # expensive 89x5 confirmatory run must be selected and acknowledged
        # explicitly after the diagnostic/optimization gate.
        args.attempts = args.attempts or 1
    else:
        args.attempts = args.attempts or 1
    if args.public and not args.upload:
        parser.error("--public requires --upload")
    intent_error = formal_run_intent_error(args)
    if intent_error is not None:
        parser.error(intent_error)
    return args


def formal_run_intent_error(args: argparse.Namespace) -> str | None:
    """Reject accidental multi-attempt model runs before Provider preflight.

    The only supported multi-attempt full-dataset shape is the frozen official
    89x5 protocol, and it requires a dedicated acknowledgement.  Diagnostics
    remain 89x1 by default; filtered pilots and smoke runs remain one attempt.
    """

    confirmed = bool(getattr(args, "confirm_89x5_formal", False))
    attempts = int(args.attempts)
    if attempts <= 0:
        return "--attempts must be a positive integer"
    if confirmed:
        if args.mode not in {"full", "print-command"}:
            return "--confirm-89x5-formal is valid only with full or print-command"
        if attempts != 5 or args.task or args.limit is not None:
            return (
                "--confirm-89x5-formal requires the complete unfiltered "
                "89-task dataset with --attempts 5"
            )
        return None
    if args.mode in {"smoke", "full"} and attempts > 1:
        return (
            "multi-attempt model runs are blocked by default; the complete "
            "89x5 formal run requires --attempts 5 --confirm-89x5-formal"
        )
    return None


def expected_trial_count_error(
    args: argparse.Namespace, resolved_trial_count: int
) -> str | None:
    requested = getattr(args, "expect_trials", None)
    if args.mode in {"smoke", "full"} and requested is None:
        return (
            "model-running smoke/full modes require --expect-trials so the "
            "resolved trial count is acknowledged before launch"
        )
    if requested is not None and requested <= 0:
        return "--expect-trials must be a positive integer"
    if requested is not None and requested != resolved_trial_count:
        return (
            "Resolved trial count does not match --expect-trials: "
            f"expected {requested}, resolved {resolved_trial_count}"
        )
    return None


def main() -> int:
    args = parse_args()
    base_url, protocol, credential = runtime_provider_config()
    if protocol != "openai-responses":
        raise RuntimeError(f"Expected openai-responses, got {protocol}")
    effective_base_url, provider_host, provider_address = provider_ipv4_base_url(base_url)
    preflight(
        args.binary,
        args.watcher,
        effective_base_url,
        credential,
        provider_host,
        provider_address,
    )
    if args.mode == "preflight":
        return 0
    if args.dataset_path is not None and not args.dataset_path.is_dir():
        raise RuntimeError(f"Local Terminal-Bench task directory is missing: {args.dataset_path}")
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    harness: dict[str, object] | None = None
    if args.harness_mode == "bound":
        if args.harness_profile is None:
            raise RuntimeError("--harness-mode bound requires --harness-profile")
        harness = selected_harness(lock, args.harness_profile)
    command = harbor_command(args, lock)
    expected_trial_count, expected_tasks = expected_job_shape(args, lock)
    count_error = expected_trial_count_error(args, expected_trial_count)
    if count_error is not None:
        raise RuntimeError(count_error)
    print("expected_trial_count=" + str(expected_trial_count))
    if args.mode == "install-only":
        command.append("--install-only")
    if args.mode == "print-command":
        print(" ".join(command))
        return 0

    if args.upload:
        raise RuntimeError(
            "Upload is a separate post-audit action; run without --upload, verify "
            "strict_result.json, then upload the audited job explicitly."
        )

    run_identity = frozen_run_identity(args, lock)

    environment = os.environ.copy()
    runtime_identity = runtime_version(lock)
    environment.update(
        {
            "PYTHONPATH": str(REPO_ROOT),
            "MORPHZ_HARBOR_BINARY": str(args.binary.resolve()),
            "MORPHZ_HARBOR_WATCHER": str(args.watcher.resolve()),
            "MORPHZ_HARBOR_VERSION": runtime_identity,
            "MORPHZ_PROVIDER_PROTOCOL": protocol,
            "MORPHZ_PROVIDER_BASE_URL": effective_base_url,
            "MORPHZ_PROVIDER_MODEL": "gpt-5.6-sol",
            "MORPHZ_PROVIDER_API_KEY": credential,
            "MORPHZ_REASONING_EFFORT": "max",
            "MORPHZ_HARNESS_MODE": args.harness_mode,
            "DOCKER_DEFAULT_PLATFORM": "linux/amd64",
        }
    )
    if harness is not None:
        environment.update(
            {
                "MORPHZ_HARBOR_HARNESS": str(
                    (REPO_ROOT / str(harness["path"])).resolve()
                ),
                "MORPHZ_HARNESS_REF": f"{harness['id']}@{harness['version']}",
                "MORPHZ_HARNESS_SOURCE_SHA256": str(harness["source_sha256"]),
            }
        )
    before = {
        path.resolve()
        for path in args.jobs_dir.iterdir()
        if path.is_dir()
    } if args.jobs_dir.is_dir() else set()
    return_code = subprocess.run(
        command, cwd=REPO_ROOT, env=environment, check=False
    ).returncode
    if args.mode not in {"smoke", "full"}:
        return return_code

    after = {
        path.resolve()
        for path in args.jobs_dir.iterdir()
        if path.is_dir()
    } if args.jobs_dir.is_dir() else set()
    new_jobs = sorted(after - before)
    if len(new_jobs) != 1:
        raise RuntimeError(
            "Expected exactly one new Harbor job for integrity audit, got "
            f"{len(new_jobs)}"
        )
    integrity = audit_job(
        new_jobs[0],
        expected_trial_count=expected_trial_count,
        expected_tasks=expected_tasks,
        attempts_per_task=args.attempts,
        run_identity=run_identity,
    )
    public_gate_path = new_jobs[0] / "public_run_gate.json"
    try:
        public_gate = audit_gate(
            new_jobs[0],
            expected_trials=expected_trial_count,
            credential=credential,
        )
    except Exception as error:
        public_gate = {
            "gate_version": "terminal-bench-public-run-gate-v2",
            "job_dir": str(new_jobs[0].resolve()),
            "expected_trials": expected_trial_count,
            "gate_passed": False,
            "audit_error": f"{type(error).__name__}: {error}",
        }
    public_gate_path.write_text(
        json.dumps(public_gate, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print("integrity_policy=" + str(integrity["policy_version"]))
    print("integrity_gate_passed=" + str(integrity["integrity_gate_passed"]).lower())
    print("raw_mean_reward=" + str(integrity["raw_mean_reward"]))
    print("strict_mean_reward=" + str(integrity["strict_mean_reward"]))
    print("strict_result=" + str(new_jobs[0] / "strict_result.json"))
    print("public_run_gate=" + str(public_gate["gate_passed"]).lower())
    print("public_run_gate_result=" + str(public_gate_path))
    if return_code != 0:
        return return_code
    return (
        0
        if integrity["integrity_gate_passed"] and public_gate["gate_passed"]
        else 3
    )


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"benchmark launcher failed: {error}", file=sys.stderr)
        raise SystemExit(2) from error
