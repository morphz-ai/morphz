"""Persistence and snapshot-isolation Gate for the ME-07 Letta arm.

The Gate deliberately runs in two phases so the Letta server can be stopped
and restarted between them.  ``prepare`` asks the real Agent to store a fact
through Letta's native memory tools and exports a snapshot.  ``verify``
retrieves the same Agent after restart, recalls the fact, imports the snapshot
as a task-local clone, and confirms that the clone has the same durable memory.

This is an engineering Gate and must never be included in STATE-Bench scores.
"""

from __future__ import annotations

import argparse
import io
import json
import subprocess
import uuid
from pathlib import Path
from typing import Any

from letta_client import Letta

GATE_ID = "ME-07-letta-persistence-snapshot-v1"


def _server_pid(port: int) -> int:
    result = subprocess.run(
        ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
        check=True,
        capture_output=True,
        text=True,
    )
    values = {int(line) for line in result.stdout.splitlines() if line.strip()}
    if len(values) != 1:
        raise RuntimeError(f"expected one Letta listener on port {port}, got {values}")
    return values.pop()


def _assistant_texts(response: object) -> list[str]:
    texts: list[str] = []
    for message in getattr(response, "messages", []) or []:
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


def _tool_names(response: object) -> list[str]:
    names: list[str] = []
    for message in getattr(response, "messages", []) or []:
        call = getattr(message, "tool_call", None)
        name = getattr(call, "name", None)
        if isinstance(name, str):
            names.append(name)
    return names


def _blocks(client: Letta, agent_id: str) -> list[dict[str, Any]]:
    return [
        {"id": block.id, "label": block.label, "value": block.value}
        for block in client.agents.blocks.list(agent_id)
    ]


def _contains(blocks: list[dict[str, Any]], marker: str) -> bool:
    return any(marker in str(block.get("value", "")) for block in blocks)


def _binding(state: Any) -> dict[str, Any]:
    llm = state.llm_config
    embedding = state.embedding_config
    return {
        "model": llm.model,
        "model_endpoint_type": llm.model_endpoint_type,
        "model_endpoint": llm.model_endpoint,
        "reasoning_effort": llm.reasoning_effort,
        "context_window": llm.context_window,
        "fallback": False,
        "embedding_model": embedding.embedding_model if embedding else None,
        "embedding_endpoint_type": (
            embedding.embedding_endpoint_type if embedding else None
        ),
        "embedding_dimension": embedding.embedding_dim if embedding else None,
    }


def _create_agent(client: Letta, model_endpoint: str) -> Any:
    return client.agents.create(
        name=f"me07-letta-persistence-gate-{uuid.uuid4().hex[:8]}",
        agent_type="letta_v1_agent",
        llm_config={
            "context_window": 256_000,
            "model": "gpt-5.6-sol",
            "model_endpoint_type": "openai",
            "model_endpoint": model_endpoint,
            "handle": "openai/gpt-5.6-sol",
            "provider_name": "openai",
            "reasoning_effort": "max",
            "parallel_tool_calls": False,
        },
        embedding_config={
            "embedding_dim": 768,
            "embedding_endpoint_type": "ollama",
            "embedding_model": "nomic-embed-text:latest",
            "embedding_endpoint": "http://127.0.0.1:11434",
            "handle": "ollama/nomic-embed-text:latest",
            "batch_size": 32,
        },
        include_base_tools=True,
        include_base_tool_rules=True,
        memory_blocks=[
            {
                "label": "persona",
                "value": (
                    "You are the Letta arm in a reproducible Agent-system "
                    "persistence Gate. Use native Letta memory tools for durable facts."
                ),
            },
            {
                "label": "human",
                "value": "The evaluator requests concise, literal Gate acknowledgements.",
            },
        ],
    )


def prepare(args: argparse.Namespace) -> int:
    client = Letta(base_url=args.base_url)
    agent = _create_agent(client, args.model_endpoint)
    store = client.agents.messages.create(
        agent_id=agent.id,
        input=(
            "Persistence Gate: use your native Letta memory tool to store this "
            f"durable fact for future conversations: {args.fact}. After storing "
            "it, reply exactly MEMORY_STORED."
        ),
        max_steps=12,
        timeout=600,
    )
    blocks = _blocks(client, agent.id)
    exported = client.agents.export_file(
        agent.id, use_legacy_format=False, scrub_messages=False
    )
    args.snapshot.write_text(exported, encoding="utf-8")
    state = client.agents.retrieve(agent.id)
    receipt = {
        "gate": GATE_ID,
        "phase": "prepare",
        "reportable_score": False,
        "server_pid": _server_pid(args.port),
        "agent_id": agent.id,
        "fact": args.fact,
        "recall_marker": args.recall_marker,
        "binding": _binding(state),
        "assistant_texts": _assistant_texts(store),
        "tool_names": _tool_names(store),
        "memory_contains_fact": _contains(blocks, args.fact),
        "snapshot": str(args.snapshot),
    }
    receipt["passed"] = (
        receipt["assistant_texts"] == ["MEMORY_STORED"]
        and "memory_insert" in receipt["tool_names"]
        and receipt["memory_contains_fact"]
    )
    args.receipt.write_text(
        json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(receipt, ensure_ascii=False))
    return 0 if receipt["passed"] else 1


def verify(args: argparse.Namespace) -> int:
    prepared = json.loads(args.receipt.read_text(encoding="utf-8"))
    if prepared.get("gate") != GATE_ID or prepared.get("phase") != "prepare":
        raise ValueError("invalid Letta persistence prepare receipt")
    client = Letta(base_url=args.base_url)
    agent_id = str(prepared["agent_id"])
    fact = str(prepared["fact"])
    recall_marker = str(
        prepared.get("recall_marker") or fact.rsplit(" is ", maxsplit=1)[-1]
    ).rstrip(".")
    server_pid = _server_pid(args.port)
    if server_pid == prepared["server_pid"]:
        raise RuntimeError("Letta server was not restarted between Gate phases")

    persisted = client.agents.retrieve(agent_id)
    persisted_blocks = _blocks(client, agent_id)
    recall = client.agents.messages.create(
        agent_id=agent_id,
        input=(
            "Without storing or changing memory, report the exact ME-07 recovery "
            "code you were previously asked to remember. Reply with only the code."
        ),
        max_steps=8,
        timeout=600,
    )
    snapshot_bytes = args.snapshot.read_bytes()
    imported = client.agents.import_file(
        file=io.BytesIO(snapshot_bytes),
        append_copy_suffix=True,
        override_existing_tools=True,
    )
    if len(imported.agent_ids) != 1:
        raise RuntimeError(
            f"expected one imported Letta agent, got {imported.agent_ids}"
        )
    clone_id = imported.agent_ids[0]
    clone = client.agents.retrieve(clone_id)
    clone_blocks = _blocks(client, clone_id)
    clone_recall = client.agents.messages.create(
        agent_id=clone_id,
        input=(
            "Without storing or changing memory, report the exact ME-07 recovery "
            "code in your durable memory. Reply with only the code."
        ),
        max_steps=8,
        timeout=600,
    )
    recall_texts = _assistant_texts(recall)
    clone_texts = _assistant_texts(clone_recall)
    result = {
        "gate": GATE_ID,
        "phase": "verify",
        "reportable_score": False,
        "server_pid_before": prepared["server_pid"],
        "server_pid_after": server_pid,
        "server_restarted": server_pid != prepared["server_pid"],
        "agent_id": agent_id,
        "clone_agent_id": clone_id,
        "fact": fact,
        "recall_marker": recall_marker,
        "binding_after_restart": _binding(persisted),
        "clone_binding": _binding(clone),
        "persistent_memory_contains_fact": _contains(persisted_blocks, fact),
        "clone_memory_contains_fact": _contains(clone_blocks, fact),
        "recall_texts": recall_texts,
        "clone_recall_texts": clone_texts,
    }
    result["passed"] = all(
        [
            result["server_restarted"],
            result["persistent_memory_contains_fact"],
            result["clone_memory_contains_fact"],
            any(recall_marker in text for text in recall_texts),
            any(recall_marker in text for text in clone_texts),
            result["binding_after_restart"] == prepared["binding"],
            result["clone_binding"] == prepared["binding"],
        ]
    )
    args.output.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["passed"] else 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=["prepare", "verify"])
    parser.add_argument("--base-url", default="http://127.0.0.1:8283")
    parser.add_argument("--model-endpoint", default="http://127.0.0.1:18317/v1")
    parser.add_argument("--port", type=int, default=8283)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--fact",
        default="The ME-07 recovery code is CERULEAN-ORBIT-731.",
    )
    parser.add_argument("--recall-marker", default="CERULEAN-ORBIT-731")
    args = parser.parse_args()
    for path in [args.receipt, args.snapshot, args.output]:
        if path is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
    if args.phase == "prepare":
        return prepare(args)
    if args.output is None:
        parser.error("--output is required for verify")
    return verify(args)


if __name__ == "__main__":
    raise SystemExit(main())
