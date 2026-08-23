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

from benchmarks.harbor.benchmark_integrity import audit_job


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
    parser.add_argument("--upload", action="store_true")
    parser.add_argument("--public", action="store_true")
    args = parser.parse_args()
    if args.mode in {"install-only", "smoke"}:
        args.limit = args.limit or 1
        args.attempts = args.attempts or 1
    elif args.mode in {"full", "print-command"}:
        args.attempts = args.attempts or 5
    else:
        args.attempts = args.attempts or 1
    if args.public and not args.upload:
        parser.error("--public requires --upload")
    return args


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
    command = harbor_command(args, lock)
    expected_trial_count, expected_tasks = expected_job_shape(args, lock)
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
            "DOCKER_DEFAULT_PLATFORM": "linux/amd64",
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
    )
    print("integrity_policy=" + str(integrity["policy_version"]))
    print("integrity_gate_passed=" + str(integrity["integrity_gate_passed"]).lower())
    print("raw_mean_reward=" + str(integrity["raw_mean_reward"]))
    print("strict_mean_reward=" + str(integrity["strict_mean_reward"]))
    print("strict_result=" + str(new_jobs[0] / "strict_result.json"))
    if return_code != 0:
        return return_code
    return 0 if integrity["integrity_gate_passed"] else 3


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"benchmark launcher failed: {error}", file=sys.stderr)
        raise SystemExit(2) from error
