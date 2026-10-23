"""Explicit projection for bounded, tool-free ARC semantic requests.

This is a test-provider adaptation, NOT a Runtime-wide attachment/continuation
fix. It never promotes reasoning text to an answer. The exact PNG must already
be named by SHA-256 in the Runtime's captured request before it can be sent.
"""
import base64
import copy
import hashlib
import json
from pathlib import Path


def prepare_semantic_request(request, frame_path):
    if request.get("tools"):
        raise ValueError("The semantic actor adapter only accepts tool-free requests")
    frame = Path(frame_path).read_bytes()
    if not frame.startswith(b"\x89PNG\r\n\x1a\n") or len(frame) > 8 * 1024 * 1024:
        raise ValueError("Expected a bounded PNG from the current workspace")
    digest = hashlib.sha256(frame).hexdigest()
    if digest not in json.dumps(request.get("messages", [])):
        raise ValueError("Current PNG lacks an exact SHA-256 capture in the Runtime request")
    prepared = copy.deepcopy(request)
    users = [m for m in prepared.get("messages", []) if m.get("role") == "user"]
    if not users:
        raise ValueError("Semantic request has no user input to project")
    latest = users[-1]
    content = latest.get("content", "")
    if isinstance(content, str):
        latest["content"] = [{"type": "text", "text": content}]
    elif not isinstance(content, list):
        raise ValueError("Unexpected semantic input carrier")
    url = "data:image/png;base64," + base64.b64encode(frame).decode()
    present = any(p.get("type") == "image_url" and p.get("image_url", {}).get("url") == url
                  for m in prepared["messages"] if isinstance(m.get("content"), list)
                  for p in m["content"] if isinstance(p, dict))
    if not present:
        latest["content"].append({"type": "image_url", "image_url": {"url": url, "detail": "auto"}})
    # Delegate calculation to the actual algorithms. Do not spend the entire
    # action budget on reasoning-only continuations of a narrow typed proposal.
    prepared.setdefault("chat_template_kwargs", {})["enable_thinking"] = False
    prepared["response_format"] = {"type": "json_schema", "json_schema": {
        "name": "arc_algorithm_request", "strict": True,
        "schema": {"type": "object", "properties": {"request": {"type": "string"}},
                   "required": ["request"], "additionalProperties": False}}}
    return prepared, {"profile": "captured-image-structured-nonthinking-actor@1",
                      "image_sha256": digest, "matched_runtime_capture": True,
                      "image_added": not present, "thinking_enabled": False,
                      "structured_return": "object containing request String"}


def response_summary(record):
    """Count channels; never reinterpret private reasoning as an executed result."""
    text, reasoning_chars, tools, finishes = "", 0, 0, []
    for piece in record.get("response", []):
        if isinstance(piece, str):
            try:
                piece = json.loads(piece)
            except ValueError:
                continue
        if not isinstance(piece, dict):
            continue
        for choice in piece.get("choices", []):
            delta = choice.get("delta") or choice.get("message") or {}
            text += delta.get("content") or ""
            reasoning_chars += len(delta.get("reasoning_content") or delta.get("reasoning") or "")
            tools += len(delta.get("tool_calls") or [])
            if choice.get("finish_reason"):
                finishes.append(choice["finish_reason"])
    return {"visible_chars": len(text.strip()), "reasoning_chars": reasoning_chars,
            "tool_deltas": tools, "finish_reasons": finishes,
            "empty_stop": (record.get("completed", False) and record.get("status") == 200
                           and "stop" in finishes and not text.strip() and not tools)}
