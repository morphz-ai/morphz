"""ME-07 adapters for public Agent-system comparison.

The Morphz arm intentionally delegates the complete reasoning/tool/memory loop
to the production Rust Runtime.  STATE-Bench remains authoritative for the
simulated enterprise state and official trajectory/scoring format; a
loopback-only bridge exposes its domain handlers as physical Morphz tools.
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import asdict, is_dataclass
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from letta_client import Letta
from state_bench.agents.base import AgentRuntimeContext, BaseAgent
from state_bench.client import BaseLLMClient

from benchmarks.state_bench.v2.me07_responses import ME07ResponsesClient
from benchmarks.state_bench.v2.mem0_reference import (
    create_mem0_memory,
    memory_results,
)

PROTOCOL_ID = "ME-07-STATE-Bench-public-agent-systems-v2"

_TRIAL_RUNTIME: ContextVar[dict[str, Any] | None] = ContextVar(
    "me07_trial_runtime", default=None
)


@contextmanager
def bind_trial_runtime(
    *, output_dir: Path, run_idx: int, trial_id: str
) -> Iterator[None]:
    """Bind per-trial metadata missing from STATE-Bench ``_run_single``.

    STATE-Bench v0.8.1 constructs ``AgentRuntimeContext`` without the batch
    run index or output directory.  That is harmless for a one-task smoke but
    would make repeated public-system runs reuse artifact names.  A
    ``ContextVar`` keeps the metadata isolated when the three paired arms run
    in parallel without mutating process-global environment variables.
    """

    if run_idx < 1:
        raise ValueError("ME-07 run_idx must be positive")
    token = _TRIAL_RUNTIME.set(
        {
            "output_dir": str(output_dir.resolve()),
            "run_idx": run_idx,
            "trial_id": _safe_component(trial_id),
        }
    )
    try:
        yield
    finally:
        _TRIAL_RUNTIME.reset(token)


def _apply_trial_runtime(runtime_context: AgentRuntimeContext) -> None:
    bound = _TRIAL_RUNTIME.get()
    if bound is None:
        return
    runtime_context.output_dir = str(bound["output_dir"])
    runtime_context.run_idx = int(bound["run_idx"])
    runtime_context.config = {
        **runtime_context.config,
        "me07_trial_id": str(bound["trial_id"]),
    }


def _safe_component(value: str) -> str:
    cleaned = "".join(
        character if character.isalnum() or character in "-_" else "-"
        for character in value
    )
    cleaned = cleaned.strip("-")
    if not cleaned:
        raise ValueError("ME-07 identifier cannot be empty after normalization")
    return cleaned


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    if hasattr(value, "model_dump"):
        return _jsonable(value.model_dump(mode="json"))
    if is_dataclass(value):
        return _jsonable(asdict(value))
    raise TypeError(f"STATE-Bench tool returned non-JSON value: {type(value).__name__}")


def _validate_reasoning_effort(value: str | None) -> None:
    if value not in {None, "max"}:
        raise ValueError(
            f"ME-07 public systems require reasoning=max, received {value!r}"
        )


def _tool_manifest(
    *,
    runtime_context: AgentRuntimeContext,
    system_prompt: str,
    tools: list[dict[str, Any]],
) -> dict[str, Any]:
    normalized = []
    for tool in tools:
        value = tool.get("function", tool) if tool.get("type") == "function" else tool
        name = value.get("name")
        parameters = value.get("parameters")
        if not isinstance(name, str) or not name:
            raise ValueError("STATE-Bench supplied a tool without a name")
        if not isinstance(parameters, dict):
            raise TypeError(f"STATE-Bench tool {name!r} has no JSON parameter schema")
        normalized.append(
            {
                "name": name,
                "description": str(value.get("description", "")),
                "parameters": parameters,
            }
        )
    return {
        "protocol_id": PROTOCOL_ID,
        "domain": runtime_context.domain,
        "task_id": runtime_context.task_id,
        "system_prompt": system_prompt,
        "tools": normalized,
    }


class ME07NoopClient(BaseLLMClient):
    """STATE-Bench constructor placeholder; public runtimes own their clients."""

    @classmethod
    def from_env(cls) -> ME07NoopClient:
        return cls()

    @property
    def model_name(self) -> str:
        return "runtime-owned-gpt-5.6-sol"


class _ToolBridge:
    def __init__(
        self, token: str, handlers: dict[str, Callable[[dict[str, Any]], Any]]
    ):
        self.token = token
        self.handlers = handlers
        self.calls: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        bridge = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                if self.headers.get("x-me07-bridge-token") != bridge.token:
                    self.send_response(403)
                    self.end_headers()
                    return
                try:
                    length = int(self.headers.get("content-length", "0"))
                    payload = json.loads(self.rfile.read(length))
                    if payload.get("protocol_id") != PROTOCOL_ID:
                        raise ValueError("protocol mismatch")
                    name = payload.get("tool_name")
                    arguments = payload.get("arguments")
                    if name not in bridge.handlers or not isinstance(arguments, dict):
                        raise ValueError("unknown tool or invalid arguments")
                    result = _jsonable(bridge.handlers[name](arguments))
                    record = {"name": name, "arguments": arguments, "result": result}
                    with bridge._lock:
                        bridge.calls.append(record)
                    body = json.dumps(
                        {"ok": True, "result": result}, ensure_ascii=False
                    ).encode()
                    self.send_response(200)
                except Exception as error:  # noqa: BLE001 - domain handlers may raise arbitrary errors
                    body = json.dumps(
                        {"ok": False, "error": f"{type(error).__name__}: {error}"},
                        ensure_ascii=False,
                    ).encode()
                    self.send_response(422)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, _format: str, *_args: object) -> None:
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}/tool"

    def calls_since(self, index: int) -> list[dict[str, Any]]:
        with self._lock:
            return json.loads(json.dumps(self.calls[index:], ensure_ascii=False))

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


class MorphzPublicRuntimeAgent(BaseAgent):
    """Production Morphz Runtime arm for STATE-Bench v2."""

    def __init__(
        self,
        _client: BaseLLMClient,
        system_prompt: str,
        tools: list[dict[str, Any]],
        tool_handlers: dict[str, Callable[[dict[str, Any]], Any]],
        runtime_context: AgentRuntimeContext | None = None,
        agent_reasoning_effort: str | None = None,
        **_kwargs: Any,
    ):
        super().__init__(runtime_context=runtime_context)
        _validate_reasoning_effort(agent_reasoning_effort)
        if runtime_context is None:
            raise ValueError("Morphz ME-07 arm requires AgentRuntimeContext")
        _apply_trial_runtime(runtime_context)
        self._context = runtime_context
        self._closed = False
        self._last_usage = {
            "input_tokens": 0,
            "output_tokens": 0,
            "reasoning_tokens": 0,
        }
        self._ready: dict[str, Any] | None = None
        self._last_turn: dict[str, Any] | None = None

        binary = Path(os.environ["MORPHZ_ME07_BINARY"]).resolve(strict=True)
        task_root = Path(os.environ["MORPHZ_ME07_TASK_ROOT"]).resolve()
        snapshot_dir_value = os.environ.get("MORPHZ_ME07_SNAPSHOT_DIR")
        if snapshot_dir_value:
            source_database = (
                Path(snapshot_dir_value)
                / f"{_safe_component(runtime_context.domain)}.sqlite"
            ).resolve(strict=True)
        else:
            source_database = Path(os.environ["MORPHZ_ME07_LEARNING_DATABASE"]).resolve(
                strict=True
            )
        profile = os.environ["MORPHZ_ME07_PROFILE"]
        deterministic_gate = os.environ.get("MORPHZ_ME07_DETERMINISTIC_GATE") == "1"
        run_name = "-".join(
            [
                _safe_component(runtime_context.domain),
                _safe_component(runtime_context.task_id),
                _safe_component(str(runtime_context.run_idx or 1)),
                str(os.getpid()),
                secrets.token_hex(4),
            ]
        )
        self.output = task_root / run_name
        self.output.mkdir(parents=True, exist_ok=False)
        database = self.output / "morphz.sqlite"
        shutil.copy2(source_database, database)
        workspace = self.output / "workspace"
        artifacts = self.output / "runtime-artifacts"
        manifest_path = self.output / "tool-manifest.json"
        manifest_path.write_text(
            json.dumps(
                _tool_manifest(
                    runtime_context=runtime_context,
                    system_prompt=system_prompt,
                    tools=tools,
                ),
                ensure_ascii=False,
                sort_keys=True,
            ),
            encoding="utf-8",
        )
        token = secrets.token_urlsafe(32)
        token_file = self.output / "bridge.token"
        token_file.write_text(token, encoding="utf-8")
        token_file.chmod(0o600)
        self._bridge = _ToolBridge(token, tool_handlers)
        stderr_path = self.output / "runtime.stderr.log"
        self._stderr_stream = stderr_path.open("w", encoding="utf-8")

        agent_id = f"me07-{_safe_component(runtime_context.domain)}-agent"
        context_id = f"me07-{_safe_component(runtime_context.domain)}-context"
        session_id = f"me07-{_safe_component(runtime_context.task_id)}-session"
        command = [
            str(binary),
            f"--database={database}",
            f"--workspace-root={workspace}",
            f"--artifact-root={artifacts}",
            f"--tool-manifest={manifest_path}",
            f"--bridge-url={self._bridge.url}",
            f"--bridge-token-file={token_file}",
            f"--profile={profile}",
            f"--agent-id={agent_id}",
            f"--context-id={context_id}",
            f"--session-id={session_id}",
            "--principal-id=STATE-Bench-User",
            f"--reply-timeout-seconds={int(os.environ.get('MORPHZ_ME07_REPLY_TIMEOUT_SECONDS', '1800'))}",
        ]
        if deterministic_gate:
            command.append("--deterministic-fake-client")
        self._process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self._stderr_stream,
            text=True,
            cwd=self.output,
        )
        self._ready = self._read_receipt("ready receipt")
        self._validate_ready(self._ready, deterministic_gate=deterministic_gate)
        token_file.unlink(missing_ok=True)

    def _read_receipt(self, label: str) -> dict[str, Any]:
        if self._process.stdout is None:
            raise RuntimeError("Morphz adapter stdout is unavailable")
        line = self._process.stdout.readline()
        if not line:
            return_code = self._process.poll()
            raise RuntimeError(
                f"Morphz adapter ended before {label}; exit={return_code}"
            )
        value = json.loads(line)
        if not isinstance(value, dict):
            raise TypeError(f"Morphz adapter returned non-object {label}")
        return value

    @staticmethod
    def _validate_ready(ready: dict[str, Any], *, deterministic_gate: bool) -> None:
        expected = {
            "protocol_id": PROTOCOL_ID,
            "requested_model": "deterministic-me07-gate"
            if deterministic_gate
            else "gpt-5.6-sol",
            "physical_model": "deterministic-me07-gate"
            if deterministic_gate
            else "gpt-5.6-sol",
            "provider_instance_id": "deterministic" if deterministic_gate else "custom",
            "provider_protocol": "in-process"
            if deterministic_gate
            else "openai-responses",
            "reasoning_effort": "none" if deterministic_gate else "max",
            "fallback": False,
            "deterministic_fake_not_reportable": deterministic_gate,
        }
        mismatches = {
            key: (ready.get(key), value)
            for key, value in expected.items()
            if ready.get(key) != value
        }
        if mismatches:
            raise RuntimeError(
                f"Morphz ME-07 model/runtime binding mismatch: {mismatches}"
            )
        physical = set(ready.get("physical_tool_names", []))
        declared = set(ready.get("tool_names", []))
        if "context_tx" not in declared or not (declared - {"context_tx"}).issubset(
            physical
        ):
            raise RuntimeError(
                "Morphz ME-07 domain tools were not materialized as physical tools"
            )

    @staticmethod
    def _latest_user_text(conversation: list[Any]) -> str:
        for item in reversed(conversation):
            if isinstance(item, dict) and item.get("role") == "user":
                content = item.get("content")
                if isinstance(content, str) and content.strip():
                    return content
        raise ValueError("STATE-Bench conversation has no user message")

    def act(
        self, conversation: list[Any]
    ) -> tuple[str, list[dict[str, Any]], list[Any]]:
        if self._closed:
            raise RuntimeError("Morphz ME-07 agent is closed")
        if self._process.stdin is None:
            raise RuntimeError("Morphz adapter stdin is unavailable")
        request_id = f"{self._context.task_id}-turn-{len(conversation)}"
        before = len(self._bridge.calls)
        self._process.stdin.write(
            json.dumps(
                {
                    "request_id": request_id,
                    "text": self._latest_user_text(conversation),
                },
                ensure_ascii=False,
            )
            + "\n"
        )
        self._process.stdin.flush()
        turn = self._read_receipt("turn receipt")
        self._last_turn = turn
        usage = turn.get("usage", {})
        current = {
            "input_tokens": int(usage.get("input_tokens", 0)),
            "output_tokens": int(usage.get("output_tokens", 0)),
            "reasoning_tokens": int(usage.get("reasoning_tokens", 0)),
        }
        delta = {key: max(0, current[key] - self._last_usage[key]) for key in current}
        self._last_usage = current
        self.add_token_usage(
            input_tokens=delta["input_tokens"],
            output_tokens=delta["output_tokens"],
            reasoning_output_tokens=delta["reasoning_tokens"],
        )
        text = str(turn.get("text", ""))
        calls = self._bridge.calls_since(before)
        return text, calls, [{"role": "assistant", "content": text}]

    def ingest_trajectory(self, trajectory: Any) -> None:
        metadata = getattr(trajectory, "metadata", None)
        if isinstance(metadata, dict):
            metadata["me07_agent_system"] = {
                "protocol_id": PROTOCOL_ID,
                "arm": "morphz",
                "ready": self._ready,
                "last_turn": self._last_turn,
                "runtime_output": str(self.output),
            }
        self.close()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            if self._process.stdin is not None:
                self._process.stdin.close()
            self._process.wait(timeout=30)
        finally:
            if self._process.poll() is None:
                self._process.terminate()
                try:
                    self._process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self._process.kill()
                    self._process.wait(timeout=10)
            self._bridge.close()
            self._stderr_stream.close()


def _letta_tool_schemas(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for tool in tools:
        value = tool.get("function", tool) if tool.get("type") == "function" else tool
        name = value.get("name")
        parameters = value.get("parameters")
        if not isinstance(name, str) or not name:
            raise ValueError("STATE-Bench supplied a Letta client tool without a name")
        if not isinstance(parameters, dict):
            raise TypeError(f"STATE-Bench tool {name!r} has no JSON parameter schema")
        normalized.append(
            {
                "name": name,
                "description": str(value.get("description", "")),
                "parameters": parameters,
            }
        )
    return normalized


def _letta_assistant_texts(response: Any) -> list[str]:
    texts: list[str] = []
    for message in response.messages or []:
        if getattr(message, "message_type", None) != "assistant_message":
            continue
        content = getattr(message, "content", None)
        if isinstance(content, str):
            texts.append(content)
        else:
            fallback = getattr(message, "assistant_message", None)
            if isinstance(fallback, str):
                texts.append(fallback)
    return texts


class LettaPublicRuntimeAgent(BaseAgent):
    """Full Letta Runtime arm using native memory and client-side domain tools."""

    def __init__(
        self,
        _client: BaseLLMClient,
        system_prompt: str,
        tools: list[dict[str, Any]],
        tool_handlers: dict[str, Callable[[dict[str, Any]], Any]],
        runtime_context: AgentRuntimeContext | None = None,
        agent_reasoning_effort: str | None = None,
        **_kwargs: Any,
    ):
        super().__init__(runtime_context=runtime_context)
        _validate_reasoning_effort(agent_reasoning_effort)
        if runtime_context is None:
            raise ValueError("Letta ME-07 arm requires AgentRuntimeContext")
        _apply_trial_runtime(runtime_context)
        self._context = runtime_context
        self._system_prompt = system_prompt
        self._handlers = tool_handlers
        self._client_tools = _letta_tool_schemas(tools)
        self._native_tool_calls: list[str] = []
        self._domain_tool_calls: list[dict[str, Any]] = []
        self._closed = False
        self._client = Letta(
            base_url=os.environ.get("ME07_LETTA_BASE_URL", "http://127.0.0.1:8283")
        )

        snapshot_dir = Path(os.environ["ME07_LETTA_SNAPSHOT_DIR"]).resolve()
        snapshot = snapshot_dir / f"{_safe_component(runtime_context.domain)}.af"
        if not snapshot.is_file():
            raise FileNotFoundError(f"missing frozen Letta domain snapshot: {snapshot}")
        with snapshot.open("rb") as stream:
            imported = self._client.agents.import_file(
                file=stream,
                append_copy_suffix=True,
                override_existing_tools=True,
            )
        if len(imported.agent_ids) != 1:
            raise RuntimeError(
                f"Letta snapshot must contain exactly one Agent: {imported.agent_ids}"
            )
        self.agent_id = imported.agent_ids[0]
        self._snapshot = snapshot
        state = self._client.agents.update(self.agent_id, system=system_prompt)
        self._validate_binding(state)

    @staticmethod
    def _validate_binding(state: Any) -> None:
        llm = state.llm_config
        embedding = state.embedding_config
        expected = {
            "model": "gpt-5.6-sol",
            "model_endpoint_type": "openai",
            "reasoning_effort": "max",
            "context_window": 256_000,
            "embedding_model": "nomic-embed-text:latest",
            "embedding_endpoint_type": "ollama",
            "embedding_dim": 768,
        }
        actual = {
            "model": llm.model,
            "model_endpoint_type": llm.model_endpoint_type,
            "reasoning_effort": llm.reasoning_effort,
            "context_window": llm.context_window,
            "embedding_model": embedding.embedding_model if embedding else None,
            "embedding_endpoint_type": (
                embedding.embedding_endpoint_type if embedding else None
            ),
            "embedding_dim": embedding.embedding_dim if embedding else None,
        }
        mismatches = {
            key: (actual[key], value)
            for key, value in expected.items()
            if actual[key] != value
        }
        if mismatches:
            raise RuntimeError(
                f"Letta ME-07 model/memory binding mismatch: {mismatches}"
            )

    @staticmethod
    def _latest_user_text(conversation: list[Any]) -> str:
        for item in reversed(conversation):
            if isinstance(item, dict) and item.get("role") == "user":
                content = item.get("content")
                if isinstance(content, str) and content.strip():
                    return content
        raise ValueError("STATE-Bench conversation has no user message")

    def _record_usage(self, response: Any) -> None:
        usage = getattr(response, "usage", None)
        if usage is None:
            return
        self.add_token_usage(
            input_tokens=int(getattr(usage, "prompt_tokens", 0) or 0),
            output_tokens=int(getattr(usage, "completion_tokens", 0) or 0),
            cached_input_tokens=int(getattr(usage, "cached_input_tokens", 0) or 0),
            reasoning_output_tokens=int(getattr(usage, "reasoning_tokens", 0) or 0),
        )

    def _record_native_tools(self, response: Any) -> None:
        for message in response.messages or []:
            if getattr(message, "message_type", None) != "tool_call_message":
                continue
            call = getattr(message, "tool_call", None)
            name = getattr(call, "name", None)
            if isinstance(name, str) and name not in self._handlers:
                self._native_tool_calls.append(name)

    def act(
        self, conversation: list[Any]
    ) -> tuple[str, list[dict[str, Any]], list[Any]]:
        if self._closed:
            raise RuntimeError("Letta ME-07 Agent is closed")
        response = self._client.agents.messages.create(
            agent_id=self.agent_id,
            input=self._latest_user_text(conversation),
            client_tools=self._client_tools,
            max_steps=int(os.environ.get("ME07_LETTA_MAX_STEPS", "32")),
            timeout=float(os.environ.get("ME07_LETTA_TIMEOUT_SECONDS", "1800")),
        )
        turn_calls: list[dict[str, Any]] = []
        assistant_texts: list[str] = []
        for _ in range(int(os.environ.get("ME07_LETTA_MAX_APPROVAL_ROUNDS", "16"))):
            self._record_usage(response)
            self._record_native_tools(response)
            assistant_texts.extend(_letta_assistant_texts(response))
            stop = getattr(getattr(response, "stop_reason", None), "stop_reason", None)
            if stop != "requires_approval":
                if stop not in {"end_turn", "tool_rule", "max_steps"}:
                    raise RuntimeError(f"unexpected Letta stop reason: {stop}")
                text = assistant_texts[-1] if assistant_texts else ""
                return text, turn_calls, [{"role": "assistant", "content": text}]

            approvals: list[dict[str, Any]] = []
            for message in response.messages or []:
                if getattr(message, "message_type", None) != "approval_request_message":
                    continue
                calls = getattr(message, "tool_calls", None) or [
                    getattr(message, "tool_call", None)
                ]
                for call in calls:
                    if call is None:
                        continue
                    name = getattr(call, "name", None)
                    call_id = getattr(call, "tool_call_id", None)
                    if name not in self._handlers or not isinstance(call_id, str):
                        raise ValueError(
                            f"Letta requested disallowed client tool: {name}"
                        )
                    arguments = json.loads(getattr(call, "arguments", "{}"))
                    if not isinstance(arguments, dict):
                        raise TypeError(
                            f"Letta tool {name!r} arguments are not an object"
                        )
                    result = _jsonable(self._handlers[name](arguments))
                    record = {"name": name, "arguments": arguments, "result": result}
                    turn_calls.append(record)
                    self._domain_tool_calls.append(record)
                    approvals.append(
                        {
                            "type": "tool",
                            "tool_call_id": call_id,
                            "tool_return": json.dumps(result, ensure_ascii=False),
                            "status": "success",
                        }
                    )
            if not approvals:
                raise RuntimeError("Letta required approval without a domain tool call")
            response = self._client.agents.messages.create(
                agent_id=self.agent_id,
                messages=[{"type": "approval", "approvals": approvals}],
                client_tools=self._client_tools,
                max_steps=int(os.environ.get("ME07_LETTA_MAX_STEPS", "32")),
                timeout=float(os.environ.get("ME07_LETTA_TIMEOUT_SECONDS", "1800")),
            )
        raise RuntimeError("Letta exceeded the ME-07 client-tool approval-round limit")

    def ingest_trajectory(self, trajectory: Any) -> None:
        output_root = Path(
            self._context.output_dir
            or os.environ.get("ME07_LETTA_TASK_ROOT", "/private/tmp/me07-letta-tasks")
        )
        output_root.mkdir(parents=True, exist_ok=True)
        safe_task = _safe_component(self._context.task_id)
        snapshot_path = output_root / f"{safe_task}-letta-agent.af"
        exported = self._client.agents.export_file(
            self.agent_id, use_legacy_format=False, scrub_messages=False
        )
        snapshot_path.write_text(exported, encoding="utf-8")
        blocks = [
            {"label": block.label, "value": block.value}
            for block in self._client.agents.blocks.list(self.agent_id)
        ]
        metadata = getattr(trajectory, "metadata", None)
        if isinstance(metadata, dict):
            metadata["me07_agent_system"] = {
                "protocol_id": PROTOCOL_ID,
                "arm": "letta",
                "agent_id": self.agent_id,
                "source_snapshot": str(self._snapshot),
                "final_snapshot": str(snapshot_path),
                "final_snapshot_sha256": sha256(exported.encode()).hexdigest(),
                "native_memory_tool_calls": self._native_tool_calls,
                "domain_tool_call_count": len(self._domain_tool_calls),
                "memory_blocks": blocks,
            }
        self._closed = True


class Mem0PublicReferenceAgent(BaseAgent):
    """Responses-based reference Agent backed by a frozen Mem0 OSS snapshot."""

    def __init__(
        self,
        _client: BaseLLMClient,
        system_prompt: str,
        tools: list[dict[str, Any]],
        tool_handlers: dict[str, Callable[[dict[str, Any]], Any]],
        runtime_context: AgentRuntimeContext | None = None,
        agent_reasoning_effort: str | None = None,
        **_kwargs: Any,
    ):
        super().__init__(runtime_context=runtime_context)
        _validate_reasoning_effort(agent_reasoning_effort)
        if runtime_context is None:
            raise ValueError("Mem0 ME-07 arm requires AgentRuntimeContext")
        _apply_trial_runtime(runtime_context)
        self._context = runtime_context
        self._system_prompt = system_prompt
        self._tools = tools
        self._handlers = tool_handlers
        self._closed = False
        self._retrievals: list[dict[str, Any]] = []
        self._domain_tool_calls: list[dict[str, Any]] = []
        self._responses = ME07ResponsesClient()

        source_root = Path(os.environ["ME07_MEM0_SNAPSHOT_DIR"]).resolve()
        source = source_root / _safe_component(runtime_context.domain)
        if not source.is_dir():
            raise FileNotFoundError(f"missing frozen Mem0 domain snapshot: {source}")
        task_parent = Path(
            runtime_context.output_dir
            or os.environ.get("ME07_MEM0_TASK_ROOT", "/private/tmp/me07-mem0-tasks")
        )
        task_parent.mkdir(parents=True, exist_ok=True)
        run_name = "-".join(
            [
                _safe_component(runtime_context.domain),
                _safe_component(runtime_context.task_id),
                _safe_component(str(runtime_context.run_idx or 1)),
                str(os.getpid()),
                secrets.token_hex(4),
            ]
        )
        self.output = task_parent / f"mem0-{run_name}"
        shutil.copytree(source, self.output)
        self._source = source
        self._namespace = f"me07-{runtime_context.domain}"
        self._memory = create_mem0_memory(
            root=self.output,
            domain=runtime_context.domain,
            responses_client=self._responses,
        )

    @staticmethod
    def _latest_user_text(conversation: list[Any]) -> str:
        for item in reversed(conversation):
            if isinstance(item, dict) and item.get("role") == "user":
                content = item.get("content")
                if isinstance(content, str) and content.strip():
                    return content
        raise ValueError("STATE-Bench conversation has no user message")

    def _record_usage(self, response: dict[str, Any]) -> None:
        usage = response.get("usage") or {}
        input_details = usage.get("input_tokens_details") or {}
        output_details = usage.get("output_tokens_details") or {}
        input_tokens = int(usage.get("input_tokens", 0) or 0)
        output_tokens = int(usage.get("output_tokens", 0) or 0)
        self.total_output_tokens += output_tokens
        self.add_token_usage(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cached_input_tokens=int(input_details.get("cached_tokens", 0) or 0),
            reasoning_output_tokens=int(output_details.get("reasoning_tokens", 0) or 0),
        )

    def _memory_context(self, query: str) -> str:
        result = self._memory.search(
            query,
            top_k=3,
            filters={"agent_id": self._namespace},
        )
        memories = memory_results(result)
        self._retrievals.append({"query": query, "results": memories})
        if not memories:
            return (
                "Mem0 returned no relevant historical procedural memories for this "
                "turn. Continue using the current task evidence and domain tools."
            )
        lines = [
            (
                "Historical procedural memories retrieved by Mem0 follow. They are not "
                "current customer facts. Apply only relevant procedures and verify all "
                "task-specific facts with the current conversation and domain tools."
            )
        ]
        lines.extend(
            f"{index}. {item.get('memory', '')}"
            for index, item in enumerate(memories, start=1)
        )
        return "\n".join(lines)

    def act(
        self, conversation: list[Any]
    ) -> tuple[str, list[dict[str, Any]], list[Any]]:
        if self._closed:
            raise RuntimeError("Mem0 ME-07 Agent is closed")
        latest_user = self._latest_user_text(conversation)
        prepared = self.inject_system_message(
            list(conversation), self._memory_context(latest_user)
        )
        request_input = list(prepared)
        response = self._responses.create(
            input_items=request_input,
            instructions=self._system_prompt,
            tools=self._tools,
        )
        self._record_usage(response)
        raw_items: list[Any] = []
        turn_calls: list[dict[str, Any]] = []

        for _ in range(int(os.environ.get("ME07_MEM0_MAX_TOOL_ROUNDS", "16"))):
            calls = self._responses.function_calls(response)
            if not calls:
                raw_items.extend(response.get("output", []))
                text = self._responses.output_text(response)
                return text, turn_calls, raw_items
            response_output = response.get("output", [])
            raw_items.extend(response_output)
            request_input.extend(response_output)
            tool_results: list[dict[str, Any]] = []
            for call in calls:
                name = call["name"]
                if name not in self._handlers:
                    raise ValueError(f"Mem0 Agent requested disallowed tool: {name}")
                result = _jsonable(self._handlers[name](call["arguments"]))
                record = {
                    "name": name,
                    "arguments": call["arguments"],
                    "result": result,
                }
                turn_calls.append(record)
                self._domain_tool_calls.append(record)
                output = {
                    "type": "function_call_output",
                    "call_id": call["call_id"],
                    "output": json.dumps(result, ensure_ascii=False),
                }
                tool_results.append(output)
                raw_items.append(output)
            request_input.extend(tool_results)
            response = self._responses.create(
                input_items=request_input,
                instructions=self._system_prompt,
                tools=self._tools,
            )
            self._record_usage(response)
        raise RuntimeError("Mem0 Agent exceeded the ME-07 domain-tool round limit")

    def ingest_trajectory(self, trajectory: Any) -> None:
        final_memories = memory_results(
            self._memory.get_all(filters={"agent_id": self._namespace}, top_k=10_000)
        )
        metadata = getattr(trajectory, "metadata", None)
        if isinstance(metadata, dict):
            metadata["me07_agent_system"] = {
                "protocol_id": PROTOCOL_ID,
                "arm": "mem0",
                "source_snapshot": str(self._source),
                "task_snapshot": str(self.output),
                "namespace": self._namespace,
                "retrievals": self._retrievals,
                "domain_tool_call_count": len(self._domain_tool_calls),
                "final_memories": final_memories,
                "model_receipts": self._responses.receipts,
            }
        vector_client = getattr(self._memory.vector_store, "client", None)
        if vector_client is not None and hasattr(vector_client, "close"):
            vector_client.close()
        self._responses.close()
        self._closed = True


__all__ = [
    "LettaPublicRuntimeAgent",
    "ME07NoopClient",
    "Mem0PublicReferenceAgent",
    "MorphzPublicRuntimeAgent",
    "bind_trial_runtime",
]
