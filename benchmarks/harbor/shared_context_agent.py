"""Harbor adapter for the ME-09 shared-Context multi-Session experiment.

The model and cognitive Runtime live once on the benchmark host.  Each Harbor
trial contributes only a task-local Edge worker.  Eight independent Harbor
jobs run sequentially within their assigned lane and concurrently across
lanes, so every lane has one stable Session and Execution Target while all
lanes mount the same authoritative Context.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sqlite3
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from benchmarks.harbor.benchmark_integrity import (
    append_integrity_policy,
    audit_trajectory,
)
from benchmarks.harbor.morphz_atif import write_trajectory


def _request_json(
    base_url: str,
    dashboard_token: str,
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        base_url.rstrip("/") + path,
        data=data,
        method=method,
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {dashboard_token}",
            **({"Content-Type": "application/json"} if data is not None else {}),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = response.read()
    except urllib.error.HTTPError as error:
        detail = error.read(2048).decode("utf-8", errors="replace")
        raise RuntimeError(
            f"ME-09 Runtime request {method} {path} failed with "
            f"HTTP {error.code}: {detail}"
        ) from error
    decoded = json.loads(payload) if payload else {}
    if not isinstance(decoded, dict):
        raise RuntimeError(f"ME-09 Runtime returned a non-object for {method} {path}")
    return decoded


def _turn_snapshot(
    db_path: Path,
    *,
    session_id: str,
    root_turn_id: str,
) -> dict[str, Any]:
    connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5)
    connection.row_factory = sqlite3.Row
    try:
        thread = connection.execute(
            "SELECT id, revision, status, delivery_status, result_event_id "
            "FROM threads WHERE session_id = ? AND root_turn_id = ?",
            (session_id, root_turn_id),
        ).fetchone()
        reply = connection.execute(
            "SELECT id, payload FROM events "
            "WHERE session_id = ? AND root_turn_id = ? AND topic = 'chat/reply' "
            "ORDER BY rowid DESC LIMIT 1",
            (session_id, root_turn_id),
        ).fetchone()
    finally:
        connection.close()
    snapshot: dict[str, Any] = {
        "thread": dict(thread) if thread is not None else None,
        "reply_event_id": None,
        "reply_text": None,
    }
    if reply is not None:
        snapshot["reply_event_id"] = str(reply["id"])
        try:
            payload = json.loads(reply["payload"])
        except (TypeError, json.JSONDecodeError):
            payload = {}
        if isinstance(payload, dict):
            snapshot["reply_text"] = str(payload.get("text") or "")
    return snapshot


def _message_body(
    *,
    instruction: str,
    client_message_id: str,
    target_id: str,
) -> dict[str, Any]:
    """Build the native-Morphz ME-09 request without a Harness binding."""

    return {
        "text": instruction,
        "client_message_id": client_message_id,
        "reasoning_effort": "max",
        "target_id": target_id,
    }


class SharedContextMorphzAgent(BaseAgent):
    """One task-local Edge worker attached to a shared central Morphz Agent."""

    SUPPORTS_ATIF = True
    SUPPORTS_RESUME = False

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._root_turn_id: str | None = None
        self._instruction = ""
        self._runtime_result: dict[str, Any] = {}

    @staticmethod
    def name() -> str:
        return "morphz-shared-context"

    def version(self) -> str | None:
        return os.environ.get("MORPHZ_ME09_RUNTIME_VERSION")

    def _setting(self, name: str, default: str | None = None) -> str:
        value = os.environ.get(name, default)
        if value is None or not value.strip():
            raise ValueError(f"ME-09 adapter requires {name}")
        return value.strip()

    def _lane(self) -> tuple[int, str, str]:
        lane_id = int(self._setting("MORPHZ_ME09_LANE_ID"))
        if not 0 <= lane_id < 8:
            raise ValueError(f"ME-09 lane must be 0..7, got {lane_id}")
        manifest = json.loads(
            Path(self._setting("MORPHZ_ME09_MANIFEST")).read_text(encoding="utf-8")
        )
        lane = next(
            (item for item in manifest["lanes"] if int(item["lane_id"]) == lane_id),
            None,
        )
        if lane is None:
            raise ValueError(f"ME-09 manifest has no lane {lane_id}")
        task_name = str(self.session_id or "").split("__", maxsplit=1)[0]
        if task_name not in lane["tasks"]:
            raise ValueError(
                f"task {task_name!r} is not assigned to ME-09 lane {lane_id}"
            )
        return lane_id, str(lane["session_id"]), str(lane["target_id"])

    async def _resolve_workspace_root(self, environment: BaseEnvironment) -> str:
        result = await environment.exec(
            command="if [ -d /app ]; then printf '%s\\n' /app; else pwd -P; fi"
        )
        if result.return_code != 0:
            raise RuntimeError(
                "failed to discover the Harbor task workspace: "
                + (result.stderr or result.stdout or f"exit {result.return_code}")
            )
        workspace_root = result.stdout.strip()
        if not workspace_root or "\n" in workspace_root or not Path(workspace_root).is_absolute():
            raise ValueError(f"invalid Harbor task workspace: {workspace_root!r}")
        return workspace_root

    async def setup(self, environment: BaseEnvironment) -> None:
        binary = Path(self._setting("MORPHZ_ME09_BINARY")).expanduser().resolve()
        if not binary.is_file():
            raise FileNotFoundError(f"ME-09 Runtime binary does not exist: {binary}")
        runner = Path(__file__).with_name("run_me09_edge.sh")
        config = self.logs_dir / "morphz-me09-edge.toml"
        config.write_text(
            "\n".join(
                [
                    "[permissions]",
                    'mode = "full_access"',
                    'shell_environment_policy = "remove_sensitive"',
                    "",
                    "[storage]",
                    'backend = "sqlite"',
                    "",
                    "[edge_execution]",
                    "max_in_flight_per_node = 1",
                    "",
                ]
            ),
            encoding="utf-8",
        )
        await environment.upload_file(binary, "/tmp/morphz")
        await environment.upload_file(runner, "/tmp/run-me09-edge.sh")
        await environment.upload_file(config, "/tmp/morphz-me09-edge.toml")
        result = await environment.exec(
            command="chmod 0755 /tmp/morphz /tmp/run-me09-edge.sh"
        )
        if result.return_code != 0:
            raise RuntimeError(result.stderr or "failed to install ME-09 Edge worker")

    def _api(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        return _request_json(
            self._setting("MORPHZ_ME09_HOST_URL"),
            self._setting("MORPHZ_ME09_DASHBOARD_TOKEN"),
            method,
            path,
            body,
        )

    async def _wait_for_target(self, target_id: str, node_id: str) -> None:
        deadline = asyncio.get_running_loop().time() + 60
        while True:
            try:
                target = await asyncio.to_thread(
                    self._api, "GET", f"/api/execution-targets/{target_id}"
                )
            except RuntimeError as error:
                # The target does not exist until the Edge worker's first
                # signed heartbeat.  All other failures still surface at the
                # deadline with their causal target/node identity.
                if "HTTP 404" not in str(error):
                    raise
                target = {}
            if (
                target.get("status") == "online"
                and target.get("provider_node_id") == node_id
            ):
                return
            if asyncio.get_running_loop().time() >= deadline:
                raise TimeoutError(
                    f"ME-09 target {target_id} did not bind to Edge node {node_id}"
                )
            await asyncio.sleep(0.25)

    async def _wait_for_turn(
        self,
        *,
        session_id: str,
        root_turn_id: str,
    ) -> dict[str, Any]:
        db_path = Path(self._setting("MORPHZ_ME09_DB_PATH"))
        terminal_observed_at: float | None = None
        while True:
            snapshot = await asyncio.to_thread(
                _turn_snapshot,
                db_path,
                session_id=session_id,
                root_turn_id=root_turn_id,
            )
            if snapshot["reply_event_id"] is not None:
                snapshot["outcome"] = "reply"
                return snapshot
            thread = snapshot.get("thread")
            status = thread.get("status") if isinstance(thread, dict) else None
            if status in {"completed", "failed", "cancelled"}:
                now = asyncio.get_running_loop().time()
                terminal_observed_at = terminal_observed_at or now
                if now - terminal_observed_at >= 20:
                    snapshot["outcome"] = "terminal_without_reply"
                    return snapshot
            else:
                terminal_observed_at = None
            await asyncio.sleep(0.5)

    async def _cancel_turn(self, session_id: str, root_turn_id: str) -> None:
        db_path = Path(self._setting("MORPHZ_ME09_DB_PATH"))
        for _ in range(20):
            try:
                snapshot = await asyncio.to_thread(
                    _turn_snapshot,
                    db_path,
                    session_id=session_id,
                    root_turn_id=root_turn_id,
                )
            except (OSError, sqlite3.Error):
                await asyncio.sleep(0.25)
                continue
            thread = snapshot.get("thread")
            if isinstance(thread, dict):
                if thread.get("status") in {"completed", "failed", "cancelled"}:
                    return
                try:
                    await asyncio.to_thread(
                        self._api,
                        "POST",
                        f"/api/contexts/me09-shared-context/threads/{thread['id']}",
                        {
                            "action": "cancel",
                            "expected_revision": int(thread["revision"]),
                            "reason": "Harbor ended the ME-09 task deadline",
                        },
                    )
                except Exception as error:  # best-effort cancellation evidence
                    self.logger.error("ME-09 turn cancellation failed: %s", error)
                return
            await asyncio.sleep(0.25)

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        del context
        lane_id, session_id, target_id = self._lane()
        task_name = str(self.session_id or "").split("__", maxsplit=1)[0]
        self._instruction = append_integrity_policy(instruction)
        (self.logs_dir / "instruction.md").write_text(
            self._instruction, encoding="utf-8"
        )
        workspace_root = await self._resolve_workspace_root(environment)
        task_digest = hashlib.sha256(task_name.encode("utf-8")).hexdigest()[:16]
        node_id = f"me09-node-{lane_id:02d}-{task_digest}"

        pairing = await asyncio.to_thread(
            self._api,
            "POST",
            "/api/edge/pairing-codes",
            {"expires_in_seconds": 900},
        )
        pairing_code = str(pairing.get("code") or "")
        if not pairing_code:
            raise RuntimeError("ME-09 pairing response did not contain a code")
        edge_env = {
            "MORPHZ_ME09_EDGE_SERVER_URL": self._setting("MORPHZ_ME09_EDGE_URL"),
            "MORPHZ_ME09_PAIRING_CODE": pairing_code,
            "MORPHZ_ME09_NODE_ID": node_id,
            "MORPHZ_ME09_TARGET_ID": target_id,
            "MORPHZ_ME09_LANE_ID": str(lane_id),
            "MORPHZ_AGENT_ID": f"me09-edge-agent-{lane_id:02d}",
            "MORPHZ_CONTEXT_ID": f"me09-edge-context-{task_digest}",
            "MORPHZ_SESSION_ID": f"me09-edge-session-{task_digest}",
            "MORPHZ_STORAGE_SQLITE_PATH": "/tmp/morphz-me09-edge.db",
            "MORPHZ_WORKSPACE_ROOT": workspace_root,
            "MORPHZ_ARTIFACT_DIR": "/logs/artifacts",
            "MORPHZ_CODING_EVAL_MODE": "true",
            "MORPHZ_PERMISSION_MODE": "full_access",
            "MORPHZ_EXEC_NETWORK": "true",
        }
        started = await environment.exec(
            command="/tmp/run-me09-edge.sh start",
            env=edge_env,
        )
        if started.return_code != 0:
            raise RuntimeError(
                "ME-09 Edge startup failed: "
                + (started.stderr or started.stdout or f"exit {started.return_code}")[-4000:]
            )
        await self._wait_for_target(target_id, node_id)

        receipt = await asyncio.to_thread(
            self._api,
            "POST",
            f"/api/sessions/{session_id}/messages",
            _message_body(
                instruction=self._instruction,
                client_message_id=f"me09-{lane_id:02d}-{task_digest}",
                target_id=target_id,
            ),
        )
        self._root_turn_id = str(receipt.get("event_id") or "")
        if not self._root_turn_id:
            raise RuntimeError("ME-09 message receipt did not contain event_id")
        try:
            self._runtime_result = await self._wait_for_turn(
                session_id=session_id,
                root_turn_id=self._root_turn_id,
            )
        except asyncio.CancelledError:
            await asyncio.shield(self._cancel_turn(session_id, self._root_turn_id))
            raise
        finally:
            evidence = {
                "protocol_id": "ME-09-TB2.1-shared-context-8-session-v1",
                "lane_id": lane_id,
                "session_id": session_id,
                "target_id": target_id,
                "node_id": node_id,
                "task_name": task_name,
                "root_turn_id": self._root_turn_id,
                **self._runtime_result,
            }
            (self.logs_dir / "me09_runtime_result.json").write_text(
                json.dumps(evidence, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )

    def populate_context_post_run(self, context: AgentContext) -> None:
        if self._root_turn_id is None:
            return
        lane_id, session_id, _ = self._lane()
        db_path = Path(self._setting("MORPHZ_ME09_DB_PATH"))
        trajectory = write_trajectory(
            db_path,
            self.logs_dir / "trajectory.json",
            instruction=self._instruction,
            session_id=session_id,
            context_id="me09-shared-context",
            agent_version=self.version() or "unknown",
            configured_model="gpt-5.6-sol",
            reasoning_effort="max",
            permission_mode="full_access",
            root_turn_id=self._root_turn_id,
        )
        task_name = str(self.session_id or "me09-task").split("__", maxsplit=1)[0]
        integrity = audit_trajectory(
            self.logs_dir / "trajectory.json",
            task_name=task_name,
            output_path=self.logs_dir / "benchmark_integrity.json",
        )
        # The Terminal-Bench official verifier remains the primary score.
        # This scanner is retained only as a separate diagnostic, in line with
        # the frozen ME-08/ME-09 reporting rule.
        context.metadata = {
            "me09_lane_id": lane_id,
            "me09_root_turn_id": self._root_turn_id,
            "diagnostic_integrity": integrity,
        }
        metrics = trajectory.final_metrics
        if metrics is not None:
            context.n_input_tokens = metrics.total_prompt_tokens
            context.n_output_tokens = metrics.total_completion_tokens
            context.n_cache_tokens = metrics.total_cached_tokens
            context.cost_usd = metrics.total_cost_usd
