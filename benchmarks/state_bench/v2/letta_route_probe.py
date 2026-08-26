"""Real-model route and persistence probe for the ME-07 Letta arm.

This is a Gate artifact, not a scored STATE-Bench trial.  It binds Letta to
the same GPT-5.6 Sol route used by Morphz while using a frozen local embedding
backend for Letta's archival memory.
"""

from __future__ import annotations

import argparse
import json
import uuid
from pathlib import Path

from letta_client import Letta


def _assistant_texts(response: object) -> list[str]:
    texts: list[str] = []
    for message in getattr(response, "messages", []) or []:
        if getattr(message, "message_type", None) != "assistant_message":
            continue
        content = getattr(message, "content", None)
        if isinstance(content, str):
            texts.append(content)
        elif isinstance(getattr(message, "assistant_message", None), str):
            texts.append(message.assistant_message)
    return texts


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8283")
    parser.add_argument("--model-endpoint", default="http://127.0.0.1:18317/v1")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    client = Letta(base_url=args.base_url)
    agent = client.agents.create(
        name=f"me07-letta-route-gate-{uuid.uuid4().hex[:8]}",
        agent_type="letta_v1_agent",
        llm_config={
            "context_window": 256_000,
            "model": "gpt-5.6-sol",
            "model_endpoint_type": "openai",
            "model_endpoint": args.model_endpoint,
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
                "value": "You are the Letta arm in a reproducible Agent-system evaluation Gate.",
            },
            {
                "label": "human",
                "value": "The evaluator requests concise, literal Gate acknowledgements.",
            },
        ],
    )
    response = client.agents.messages.create(
        agent_id=agent.id,
        input="Reply with exactly LETTA_ROUTE_READY.",
        max_steps=8,
        timeout=600,
    )
    state = client.agents.retrieve(agent.id)
    llm = state.llm_config
    embedding = state.embedding_config
    texts = _assistant_texts(response)
    receipt = {
        "gate": "ME-07-letta-real-route-v1",
        "reportable_score": False,
        "agent_id": agent.id,
        "stop_reason": getattr(
            getattr(response, "stop_reason", None), "stop_reason", None
        ),
        "assistant_texts": texts,
        "binding": {
            "model": llm.model,
            "model_endpoint_type": llm.model_endpoint_type,
            "model_endpoint": llm.model_endpoint,
            "reasoning_effort": llm.reasoning_effort,
            "context_window": llm.context_window,
            "fallback": False,
        },
        "embedding": {
            "model": embedding.embedding_model if embedding else None,
            "endpoint_type": embedding.embedding_endpoint_type if embedding else None,
            "dimension": embedding.embedding_dim if embedding else None,
        },
        "passed": texts == ["LETTA_ROUTE_READY"],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(receipt, ensure_ascii=False))
    return 0 if receipt["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
