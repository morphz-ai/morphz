#!/usr/bin/env python3
"""Render a complete ATIF trajectory as human-readable Markdown."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


TICK = chr(96)


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)


def _fence(value: str, language: str = "text") -> str:
    length = 3
    while TICK * length in value:
        length += 1
    fence = TICK * length
    return f"{fence}{language}\n{value}\n{fence}"


def render(trajectory: dict[str, Any]) -> str:
    lines = [
        "# Morphz ATIF 执行轨迹（可读导出）",
        "",
        "> 本文件由原始 ATIF-v1.7 机械展开；未读取或加入隐藏 verifier/private tests。",
        "",
        "## 轨迹元数据",
        "",
        _fence(
            _json(
                {
                    key: value
                    for key, value in trajectory.items()
                    if key != "steps"
                }
            ),
            "json",
        ),
        "",
    ]
    for index, step in enumerate(trajectory.get("steps", []), start=1):
        step_id = step.get("step_id", index)
        source = step.get("source", "unknown")
        lines.extend(
            [
                f"## Step {step_id} · {source}",
                "",
                f"- 时间：{step.get('timestamp', '')}",
            ]
        )
        if step.get("model_name"):
            lines.append(f"- 模型：{step['model_name']}")
        if step.get("reasoning_effort"):
            lines.append(f"- Reasoning：{step['reasoning_effort']}")
        if step.get("metrics") is not None:
            lines.extend(["- Metrics：", "", _fence(_json(step["metrics"]), "json")])
        message = step.get("message")
        if message:
            lines.extend(["", "### 消息", "", _fence(str(message))])
        for call_index, call in enumerate(step.get("tool_calls") or [], start=1):
            lines.extend(
                [
                    "",
                    f"### 工具调用 {call_index} · {call.get('function_name', 'unknown')}",
                    "",
                    f"Call ID：{call.get('tool_call_id', '')}",
                    "",
                    _fence(_json(call.get("arguments")), "json"),
                ]
            )
            if call.get("extra") is not None:
                lines.extend(
                    ["", "调用元数据：", "", _fence(_json(call["extra"]), "json")]
                )
        observation = step.get("observation") or {}
        for result_index, result in enumerate(
            observation.get("results") or [], start=1
        ):
            lines.extend(
                [
                    "",
                    f"### 工具结果 {result_index}",
                    "",
                    f"来源 Call ID：{result.get('source_call_id', '')}",
                    "",
                    _fence(str(result.get("content", ""))),
                ]
            )
            if result.get("extra") is not None:
                lines.extend(
                    ["", "结果元数据：", "", _fence(_json(result["extra"]), "json")]
                )
        if step.get("extra") is not None:
            lines.extend(
                ["", "### Step 元数据", "", _fence(_json(step["extra"]), "json")]
            )
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    trajectory = json.loads(args.input.read_text(encoding="utf-8"))
    if not isinstance(trajectory, dict):
        raise ValueError("ATIF trajectory must be a JSON object")
    args.output.write_text(render(trajectory), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
