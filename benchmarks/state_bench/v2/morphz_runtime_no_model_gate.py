#!/usr/bin/env python3
"""Verify the ME-07 production Morphz adapter without calling a model.

The gate starts a loopback-only STATE-Bench tool bridge, launches the real
Morphz Runtime with its deterministic test client, sends one user turn, and
then verifies that the domain tool completed through the durable
``execution_jobs`` path.  Its output is explicitly non-reportable evidence;
it is only an infrastructure prerequisite for a paid smoke.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import secrets
import sqlite3
import subprocess
import tempfile
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

PROTOCOL_ID = "ME-07-STATE-Bench-public-agent-systems-v2"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


@contextmanager
def _bridge(token: str) -> Iterator[tuple[str, list[dict[str, Any]]]]:
    calls: list[dict[str, Any]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            if self.headers.get("x-me07-bridge-token") != token:
                self.send_response(403)
                self.end_headers()
                return
            length = int(self.headers.get("content-length", "0"))
            payload = json.loads(self.rfile.read(length))
            if payload.get("protocol_id") != PROTOCOL_ID:
                self.send_response(400)
                self.end_headers()
                return
            calls.append(payload)
            body = json.dumps({"ok": True, "result": {"status": "gate-ok"}}).encode()
            self.send_response(200)
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


def _manifest(path: Path) -> None:
    value = {
        "protocol_id": PROTOCOL_ID,
        "domain": "deterministic_gate",
        "task_id": "deterministic-gate-001",
        "system_prompt": "Use the gate_probe tool exactly once and report its result.",
        "tools": [
            {
                "name": "gate_probe",
                "description": "Deterministic ME-07 bridge probe",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": False,
                },
            }
        ],
    }
    path.write_text(json.dumps(value, sort_keys=True), encoding="utf-8")


def _read_json_line(stream: Any, label: str) -> dict[str, Any]:
    line = stream.readline()
    if not line:
        raise RuntimeError(f"Morphz adapter ended before {label}")
    value = json.loads(line)
    if not isinstance(value, dict):
        raise TypeError(f"Morphz adapter returned non-object {label}")
    return value


def _execution_jobs(database: Path) -> list[dict[str, Any]]:
    with sqlite3.connect(database) as connection:
        rows = connection.execute(
            "SELECT tool_name, status, error FROM execution_jobs ORDER BY created_at, id"
        ).fetchall()
    return [
        {"tool_name": name, "status": status, "error": error}
        for name, status, error in rows
    ]


def run(binary: Path, output: Path) -> dict[str, Any]:
    binary = binary.resolve(strict=True)
    output.mkdir(parents=True, exist_ok=False)
    database = output / "morphz.sqlite"
    workspace = output / "workspace"
    artifacts = output / "runtime-artifacts"
    manifest = output / "tool-manifest.json"
    token_file = output / "bridge.token"
    _manifest(manifest)
    token = secrets.token_urlsafe(32)
    token_file.write_text(token, encoding="utf-8")
    token_file.chmod(0o600)

    with _bridge(token) as (bridge_url, calls):
        command = [
            str(binary),
            f"--database={database}",
            f"--workspace-root={workspace}",
            f"--artifact-root={artifacts}",
            f"--tool-manifest={manifest}",
            f"--bridge-url={bridge_url}",
            f"--bridge-token-file={token_file}",
            "--profile=deterministic-gate",
            "--agent-id=me07-gate-agent",
            "--context-id=me07-gate-context",
            "--session-id=me07-gate-session",
            "--principal-id=STATE-Bench-User",
            "--reply-timeout-seconds=60",
            "--deterministic-fake-client",
        ]
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=output,
        )
        assert process.stdin is not None and process.stdout is not None
        ready = _read_json_line(process.stdout, "ready receipt")
        process.stdin.write(
            json.dumps({"request_id": "gate-turn-1", "text": "Run the gate."}) + "\n"
        )
        process.stdin.flush()
        turn = _read_json_line(process.stdout, "turn receipt")
        process.stdin.close()
        return_code = process.wait(timeout=30)
        stderr = process.stderr.read() if process.stderr is not None else ""

    jobs = _execution_jobs(database)
    checks = {
        "process_succeeded": return_code == 0,
        "ready_non_reportable": ready.get("deterministic_fake_not_reportable") is True,
        "ready_has_physical_gate_tool": "gate_probe"
        in ready.get("physical_tool_names", []),
        "ready_has_context_tx": "context_tx" in ready.get("tool_names", []),
        "reply_completed": turn.get("text") == "me07-deterministic-gate-complete",
        "bridge_called_once": len(calls) == 1
        and calls[0].get("tool_name") == "gate_probe",
        "durable_execution_succeeded": any(
            job["tool_name"] == "gate_probe" and job["status"] == "succeeded"
            for job in jobs
        ),
        "no_execution_failure": all(job["status"] == "succeeded" for job in jobs),
    }
    report = {
        "protocol_id": PROTOCOL_ID,
        "kind": "deterministic_fake_not_reportable",
        "binary": {"path": str(binary), "sha256": _sha256(binary)},
        "checks": checks,
        "passed": all(checks.values()),
        "ready": ready,
        "turn": turn,
        "bridge_calls": [{"tool_name": call.get("tool_name")} for call in calls],
        "execution_jobs": jobs,
        "stderr_tail": stderr[-2000:],
    }
    (output / "no_model_gate.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    token_file.unlink(missing_ok=True)
    if not report["passed"]:
        raise RuntimeError("ME-07 Morphz no-model Gate failed")
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.output is None:
        with tempfile.TemporaryDirectory(prefix="me07-morphz-gate-") as temp:
            report = run(args.binary, Path(temp) / "gate")
            print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    else:
        report = run(args.binary, args.output)
        print(json.dumps(report, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
