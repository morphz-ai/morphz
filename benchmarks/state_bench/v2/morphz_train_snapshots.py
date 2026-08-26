"""Build frozen Morphz Context snapshots from canonical STATE-Bench episodes.

The trainer starts the production ME-07 Morphz adapter against an isolated
SQLite database and a host-owned, run-local model configuration.  Every input
is serialized by the same canonical serializer used by the Letta and Mem0
arms.  A second Runtime process then loads a SQLite backup and reports the
persisted Mind version without issuing a model request.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import select
import sqlite3
import subprocess
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, TextIO
from urllib.parse import urlparse

from benchmarks.state_bench.v2.canonical_episode import (
    PROTOCOL_ID,
    load_canonical_episode,
)

DOMAINS = {"travel", "customer_support", "shopping_assistant"}
MODEL = "gpt-5.6-sol"
PROFILE = "me07-state-bench"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _validate_proxy_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in {
        "127.0.0.1",
        "localhost",
        "::1",
    }:
        raise ValueError("ME-07 Morphz training requires a loopback proxy tunnel")
    return value.rstrip("/")


def _write_isolated_config(root: Path, proxy_url: str) -> None:
    (root / "profiles").mkdir(parents=True, exist_ok=False)
    (root / "morphz.toml").write_text(
        "[orchestrator]\ncontext_transactions_enabled = true\n",
        encoding="utf-8",
    )
    (root / "models.toml").write_text(
        "\n".join(
            [
                "[accounts.custom-default]",
                'auth_adapter = "credential"',
                'credential_ref = "custom"',
                'provider = "custom"',
                "",
                "[credentials.custom]",
                'name = "MORPHZ_PROVIDER_API_KEY"',
                'source = "env"',
                "",
                "[llm]",
                f'model = "{MODEL}"',
                "",
                f'[models."{MODEL}"]',
                'account = "custom-default"',
                f'physical_model = "{MODEL}"',
                'service = "custom"',
                "",
                "[services.custom]",
                'accounts = ["custom-default"]',
                'adapter = "protocol-compatible"',
                f"base_url = {json.dumps(proxy_url)}",
                'protocol = "openai-responses"',
                "",
            ]
        ),
        encoding="utf-8",
    )
    (root / "profiles" / f"{PROFILE}.toml").write_text(
        "\n".join(
            [
                "[llm]",
                f'model = "{MODEL}"',
                'reasoning_effort = "max"',
                "",
                f'[models."{MODEL}"]',
                'service = "custom"',
                'account = "custom-default"',
                f'physical_model = "{MODEL}"',
                "",
            ]
        ),
        encoding="utf-8",
    )


def _write_manifest(path: Path, domain: str) -> None:
    value = {
        "protocol_id": PROTOCOL_ID,
        "domain": domain,
        "task_id": f"{domain}-offline-learning",
        "system_prompt": (
            "Learn only from the supplied canonical completed training trajectories "
            f"in the {domain} domain. Preserve reusable procedural knowledge, "
            "constraints, verification habits, provenance, and failure-avoidance "
            "lessons in durable Mind Frames. Do not treat episode-specific IDs, "
            "dates, prices, or user records as current facts."
        ),
        "learning": True,
        "tools": [],
    }
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


@contextmanager
def _rejecting_bridge(token: str) -> Iterator[tuple[str, list[dict[str, Any]]]]:
    calls: list[dict[str, Any]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers.get("content-length", "0"))
            raw = self.rfile.read(length)
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                payload = {"malformed": True}
            calls.append(
                {
                    "authorized": self.headers.get("x-me07-bridge-token") == token,
                    "tool_name": payload.get("tool_name"),
                }
            )
            body = json.dumps(
                {"ok": False, "error": "offline learning exposes no domain tools"}
            ).encode()
            self.send_response(409)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, _format: str, *_args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/tool", calls
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def _read_json_line(stream: TextIO, label: str, timeout: float) -> dict[str, Any]:
    ready, _, _ = select.select([stream], [], [], timeout)
    if not ready:
        raise TimeoutError(f"Morphz adapter timed out before {label}")
    line = stream.readline()
    if not line:
        raise RuntimeError(f"Morphz adapter ended before {label}")
    value = json.loads(line)
    if not isinstance(value, dict):
        raise TypeError(f"Morphz adapter returned non-object {label}")
    return value


def _command(
    *,
    binary: Path,
    database: Path,
    workspace: Path,
    artifacts: Path,
    manifest: Path,
    bridge_url: str,
    token_file: Path,
    domain: str,
    session: str,
    reply_timeout: int,
) -> list[str]:
    return [
        str(binary),
        f"--database={database}",
        f"--workspace-root={workspace}",
        f"--artifact-root={artifacts}",
        f"--tool-manifest={manifest}",
        f"--bridge-url={bridge_url}",
        f"--bridge-token-file={token_file}",
        f"--profile={PROFILE}",
        f"--agent-id=me07-{domain}-agent",
        f"--context-id=me07-{domain}-context",
        f"--session-id={session}",
        "--principal-id=STATE-Bench-Offline-Trainer",
        f"--reply-timeout-seconds={reply_timeout}",
    ]


def _environment(config_home: Path) -> dict[str, str]:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required from cloud_proxy_exec.py")
    environment = os.environ.copy()
    environment.pop("MORPHZ_ENV_FILE", None)
    environment.update(
        {
            "MORPHZ_HOME": str(config_home),
            "MORPHZ_PROVIDER_API_KEY": api_key,
        }
    )
    return environment


def _binding_checks(ready: dict[str, Any]) -> dict[str, bool]:
    return {
        "protocol": ready.get("protocol_id") == PROTOCOL_ID,
        "requested_model": ready.get("requested_model") == MODEL,
        "physical_model": ready.get("physical_model") == MODEL,
        "provider": ready.get("provider_instance_id") == "custom",
        "provider_protocol": ready.get("provider_protocol") == "openai-responses",
        "reasoning_max": ready.get("reasoning_effort") == "max",
        "fallback_disabled": ready.get("fallback") is False,
        "real_model": ready.get("deterministic_fake_not_reportable") is False,
        "learning_tools_only": ready.get("tool_names") == ["context_tx"],
    }


def _sqlite_state(database: Path, context_id: str) -> dict[str, Any]:
    with sqlite3.connect(database) as connection:
        projection = connection.execute(
            "SELECT revision, state_json, state_hash FROM mind_projections "
            "WHERE context_id = ?",
            (context_id,),
        ).fetchone()
        head = connection.execute(
            "SELECT revision, projection_hash, head_event_id FROM context_heads "
            "WHERE context_id = ?",
            (context_id,),
        ).fetchone()
        commits = connection.execute(
            "SELECT COUNT(*) FROM events WHERE topic = 'chat/context_tx_committed'"
        ).fetchone()[0]
    if projection is None or head is None:
        raise RuntimeError("Morphz snapshot is missing persisted Mind state")
    state_json = projection[1]
    return {
        "projection_revision": int(projection[0]),
        "projection_state_sha256": hashlib.sha256(state_json.encode()).hexdigest(),
        "projection_state_bytes": len(state_json.encode()),
        "projection_hash": projection[2],
        "head_revision": int(head[0]),
        "head_projection_hash": head[1],
        "head_event_present": bool(head[2]),
        "context_tx_commits": int(commits),
    }


def _backup_database(source: Path, target: Path) -> None:
    with (
        sqlite3.connect(source) as source_connection,
        sqlite3.connect(target) as target_connection,
    ):
        source_connection.backup(target_connection)


def _wait_clean_exit(process: subprocess.Popen[str], timeout: float) -> int:
    try:
        return process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)
        raise RuntimeError("Morphz adapter did not exit after stdin EOF")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--domain", required=True, choices=sorted(DOMAINS))
    parser.add_argument("--input-root", type=Path, required=True)
    parser.add_argument("--snapshot-dir", type=Path, required=True)
    parser.add_argument("--artifact-dir", type=Path, required=True)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--require-context-tx-each", action="store_true")
    parser.add_argument("--reply-timeout-seconds", type=int, default=1800)
    args = parser.parse_args()

    expected_suffix = Path("datasets/train_task_trajectories")
    input_root = args.input_root.resolve(strict=True)
    if input_root.parts[-len(expected_suffix.parts) :] != expected_suffix.parts:
        raise ValueError(
            "ME-07 Morphz training input must end in datasets/train_task_trajectories"
        )
    files = sorted((input_root / args.domain).glob("*.json"))
    if len(files) != 100:
        raise RuntimeError(
            f"expected 100 {args.domain} train trajectories, got {len(files)}"
        )
    if args.limit is not None:
        if args.limit < 1 or args.limit > len(files):
            raise ValueError("--limit must be between 1 and 100")
        files = files[: args.limit]
    if args.reply_timeout_seconds < 1:
        raise ValueError("--reply-timeout-seconds must be positive")

    binary = args.binary.resolve(strict=True)
    snapshot_dir = args.snapshot_dir.resolve()
    artifact_dir = args.artifact_dir.resolve()
    snapshot_dir.mkdir(parents=True, exist_ok=True)
    artifact_dir.mkdir(parents=True, exist_ok=False)
    database = snapshot_dir / f"{args.domain}.sqlite"
    if database.exists():
        raise FileExistsError(f"refusing to overwrite Morphz snapshot: {database}")
    clone = artifact_dir / f"{args.domain}-reload-clone.sqlite"
    config_home = artifact_dir / "morphz-home"
    proxy_url = _validate_proxy_url(os.environ.get("OPENAI_BASE_URL", ""))
    _write_isolated_config(config_home, proxy_url)
    manifest = artifact_dir / "learning-manifest.json"
    _write_manifest(manifest, args.domain)
    token_file = artifact_dir / "bridge.token"
    token_file.write_text(secrets.token_urlsafe(32), encoding="utf-8")
    token_file.chmod(0o600)
    workspace = artifact_dir / "workspace"
    runtime_artifacts = artifact_dir / "runtime-artifacts"
    stderr_path = artifact_dir / "morphz.stderr.log"
    environment = _environment(config_home)
    started = time.monotonic()
    episodes: list[dict[str, Any]] = []
    ready: dict[str, Any]

    with _rejecting_bridge(token_file.read_text(encoding="utf-8")) as (
        bridge_url,
        bridge_calls,
    ):
        command = _command(
            binary=binary,
            database=database,
            workspace=workspace,
            artifacts=runtime_artifacts,
            manifest=manifest,
            bridge_url=bridge_url,
            token_file=token_file,
            domain=args.domain,
            session=f"me07-{args.domain}-training-session",
            reply_timeout=args.reply_timeout_seconds,
        )
        with stderr_path.open("w", encoding="utf-8") as stderr:
            process = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=stderr,
                text=True,
                bufsize=1,
                cwd=artifact_dir,
                env=environment,
            )
            assert process.stdin is not None and process.stdout is not None
            ready = _read_json_line(process.stdout, "ready receipt", 120)
            binding_checks = _binding_checks(ready)
            if not all(binding_checks.values()):
                raise RuntimeError(f"Morphz binding Gate failed: {binding_checks}")
            previous_commits = int(ready["initial_context_tx_commits"])
            previous_version = int(ready["initial_mind_version"])
            previous_usage = {
                "model_calls": 0,
                "input_tokens": 0,
                "output_tokens": 0,
                "reasoning_tokens": 0,
                "total_tokens": 0,
            }
            for index, path in enumerate(files, start=1):
                episode, serialized = load_canonical_episode(path, args.domain)
                request_id = f"train-{args.domain}-{index:04d}"
                request = {
                    "request_id": request_id,
                    "text": (
                        "Offline learning episode. Study the canonical completed "
                        "trajectory below. Internalize only reusable, evidence-grounded "
                        "procedural lessons in durable Mind Frames; do not memorize "
                        "transient record values as current truth. When finished, reply "
                        "exactly TRAINING_EPISODE_INGESTED.\n\n"
                        f"<canonical_episode>{serialized}</canonical_episode>"
                    ),
                }
                process.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
                process.stdin.flush()
                turn = _read_json_line(
                    process.stdout,
                    f"episode {index} receipt",
                    args.reply_timeout_seconds + 60,
                )
                commits = int(turn["context_tx_commits"])
                version = int(turn["mind_version"])
                usage = {key: int(value) for key, value in turn["usage"].items()}
                delta_usage = {
                    key: usage[key] - previous_usage.get(key, 0) for key in usage
                }
                transaction_committed = (
                    commits > previous_commits and version > previous_version
                )
                if turn.get("text") != "TRAINING_EPISODE_INGESTED":
                    raise RuntimeError(
                        f"Morphz failed episode acknowledgement {path.name}: "
                        f"{turn.get('text')!r}"
                    )
                if args.require_context_tx_each and not transaction_committed:
                    raise RuntimeError(
                        f"Morphz did not commit learned Context for {path.name}"
                    )
                episodes.append(
                    {
                        "index": index,
                        "task_id": episode["task_id"],
                        "source_sha256": episode["source_sha256"],
                        "mind_version": version,
                        "context_tx_commits": commits,
                        "transaction_committed": transaction_committed,
                        "usage": delta_usage,
                    }
                )
                previous_commits = commits
                previous_version = version
                previous_usage = usage
            process.stdin.close()
            return_code = _wait_clean_exit(process, 60)
        if return_code != 0:
            raise RuntimeError(f"Morphz training adapter exited with {return_code}")
        if bridge_calls:
            raise RuntimeError("Morphz offline learning called a domain tool bridge")

        primary_state = _sqlite_state(database, f"me07-{args.domain}-context")
        _backup_database(database, clone)
        reload_stderr = artifact_dir / "reload.stderr.log"
        reload_command = _command(
            binary=binary,
            database=clone,
            workspace=artifact_dir / "reload-workspace",
            artifacts=artifact_dir / "reload-runtime-artifacts",
            manifest=manifest,
            bridge_url=bridge_url,
            token_file=token_file,
            domain=args.domain,
            session=f"me07-{args.domain}-reload-session",
            reply_timeout=args.reply_timeout_seconds,
        )
        with reload_stderr.open("w", encoding="utf-8") as stderr:
            reload_process = subprocess.Popen(
                reload_command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=stderr,
                text=True,
                bufsize=1,
                cwd=artifact_dir,
                env=environment,
            )
            assert (
                reload_process.stdin is not None and reload_process.stdout is not None
            )
            reload_ready = _read_json_line(
                reload_process.stdout, "reload ready receipt", 120
            )
            reload_process.stdin.close()
            reload_return_code = _wait_clean_exit(reload_process, 60)

    clone_state = _sqlite_state(clone, f"me07-{args.domain}-context")
    token_file.unlink(missing_ok=True)
    stderr_tail = stderr_path.read_text(encoding="utf-8")[-4000:]
    reload_stderr_tail = (artifact_dir / "reload.stderr.log").read_text(
        encoding="utf-8"
    )[-4000:]
    checks = {
        "trained_all_selected_episodes": len(episodes) == len(files),
        "all_acknowledged": len(episodes) > 0,
        "context_was_learned": any(
            episode["transaction_committed"] for episode in episodes
        ),
        "no_domain_bridge_calls": not bridge_calls,
        "reload_process_succeeded": reload_return_code == 0,
        "reload_binding_exact": all(_binding_checks(reload_ready).values()),
        "reload_mind_version_matches": reload_ready.get("initial_mind_version")
        == episodes[-1]["mind_version"],
        "reload_commit_count_matches": reload_ready.get("initial_context_tx_commits")
        == episodes[-1]["context_tx_commits"],
        "sqlite_backup_state_matches": primary_state == clone_state,
    }
    report = {
        "protocol_id": PROTOCOL_ID,
        "gate_or_run": "gate" if args.limit is not None else "formal_training",
        "reportable_score": False,
        "domain": args.domain,
        "binding": {
            "model": MODEL,
            "reasoning_effort": "max",
            "provider": "cliproxyapi",
            "api": "responses",
            "fallback": False,
        },
        "binary": {"path": str(binary), "sha256": _sha256(binary)},
        "input_root": str(input_root),
        "episode_count": len(episodes),
        "episodes": episodes,
        "initial_ready": ready,
        "reload_ready": reload_ready,
        "primary_state": primary_state,
        "reload_state": clone_state,
        "snapshot": str(database),
        "snapshot_sha256": _sha256(database),
        "reload_clone": str(clone),
        "reload_clone_sha256": _sha256(clone),
        "elapsed_seconds": round(time.monotonic() - started, 3),
        "checks": checks,
        "stderr_tail": stderr_tail,
        "reload_stderr_tail": reload_stderr_tail,
        "passed": all(checks.values()),
    }
    receipt_path = artifact_dir / f"{args.domain}-morphz-training-receipt.json"
    receipt_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "receipt": str(receipt_path),
                "snapshot": str(database),
                "episodes": len(episodes),
                "mind_version": episodes[-1]["mind_version"],
                "passed": report["passed"],
            },
            ensure_ascii=False,
        )
    )
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
