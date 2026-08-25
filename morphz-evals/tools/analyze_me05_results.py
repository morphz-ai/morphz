#!/usr/bin/env python3
"""Reproduce ME-05 strict and post-hoc semantic-selection summaries."""

from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path
from typing import Any


MODELS = (
    "gpt-5.6-sol",
    "claude-opus-5",
    "grok-4.6",
    "gemini-3.7-flash-high",
    "deepseek-v4-pro",
    "bai-deepseek-v4-flash",
    "k3-256k",
    "glm-5.3",
    "qwen3.8-max-preview",
)


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def reports(root: Path, model: str, experiment: str) -> list[dict[str, Any]]:
    paths = []
    for stage in ("stage-a", "stage-b"):
        paths.extend((root / stage / model / experiment).glob("*/report.json"))
    return [load_json(path) for path in sorted(paths)]


def loose_json(raw: str) -> Any:
    value = raw.strip()
    if value.startswith("```") and value.endswith("```"):
        lines = value.splitlines()
        value = "\n".join(lines[1:-1])
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return None


def request_contract(episode: dict[str, Any]) -> dict[str, Any]:
    prompt = episode["request"]["messages"][-1]["content"]
    body = prompt.split("(infer-request\n", 1)[1].rsplit("\n)", 1)[0]
    return json.loads(body)


def semantic_selection_passed(episode: dict[str, Any]) -> bool:
    result = loose_json(episode.get("raw_output", ""))
    if not isinstance(result, dict) or not isinstance(result.get("selected"), list):
        return False
    selected = result["selected"]
    if len(selected) != len(set(selected)):
        return False
    request = request_contract(episode)
    candidates = {candidate["id"]: candidate for candidate in request["candidates"]}
    if any(identifier not in candidates for identifier in selected):
        return False
    if request["kind"] == "DETERMINISTIC_CONTROL":
        winner = max(request["candidates"], key=lambda item: item["closed_score"])["id"]
        return selected == [winner]
    rule = request["rule"]
    if len(selected) != rule["select_count"]:
        return False
    properties = [set(candidates[identifier]["properties"]) for identifier in selected]
    forbidden = set(rule["forbidden_properties"])
    if any(forbidden & item for item in properties):
        return False
    combined = set().union(*properties)
    return all(
        combined & set(required_group)
        for required_group in rule["required_property_groups"]
    )


def criterion_passed(episode: dict[str, Any], criterion_id: str) -> bool:
    return any(
        criterion["id"] == criterion_id and criterion["passed"]
        for criterion in episode.get("criteria", [])
    )


def analyze(root: Path) -> dict[str, Any]:
    aggregate = load_json(root / "me05_summary.json")
    model_results = []
    me03_failure_classes: Counter[str] = Counter()
    totals = Counter()
    for model in MODELS:
        me02_episodes = [
            episode
            for report in reports(root, model, "me02")
            for episode in report["episodes"]
        ]
        me03_episodes = [
            episode
            for report in reports(root, model, "me03")
            for episode in report["episodes"]
        ]
        me02_strict = sum(episode["success"] for episode in me02_episodes)
        me02_final = sum(
            criterion_passed(episode, "final-delivery") for episode in me02_episodes
        )
        me02_provider_failures = sum(
            bool(episode.get("error")) for episode in me02_episodes
        )
        me03_strict = sum(episode["success"] for episode in me03_episodes)
        me03_semantic = sum(semantic_selection_passed(episode) for episode in me03_episodes)
        me03_provider_failures = sum(
            bool(episode.get("request", {}).get("error")) for episode in me03_episodes
        )
        for episode in me03_episodes:
            if episode["success"]:
                continue
            if episode.get("request", {}).get("error"):
                me03_failure_classes["provider_or_empty_response"] += 1
            elif semantic_selection_passed(episode):
                me03_failure_classes["semantic_correct_schema_or_basis_failure"] += 1
            else:
                me03_failure_classes["semantic_selection_or_unparseable_failure"] += 1
        usage = next(
            item["usage"] for item in aggregate["models"] if item["model"] == model
        )
        model_results.append(
            {
                "model": model,
                "me02": {
                    "strict_program_execution_passed": me02_strict,
                    "episodes": len(me02_episodes),
                    "final_delivery_passed": me02_final,
                    "provider_failures": me02_provider_failures,
                },
                "me03": {
                    "strict_contract_passed": me03_strict,
                    "episodes": len(me03_episodes),
                    "semantic_selection_passed_post_hoc": me03_semantic,
                    "provider_or_empty_response_failures": me03_provider_failures,
                },
                "usage": usage,
            }
        )
        totals.update(
            {
                "me02_episodes": len(me02_episodes),
                "me02_strict": me02_strict,
                "me02_final": me02_final,
                "me02_provider_failures": me02_provider_failures,
                "me03_episodes": len(me03_episodes),
                "me03_strict": me03_strict,
                "me03_semantic": me03_semantic,
                "me03_provider_failures": me03_provider_failures,
            }
        )
    return {
        "schema": "morphz-me05-analysis-v1",
        "primary_strict_score": {
            "passed": aggregate["total_passed"],
            "episodes": aggregate["total_episodes"],
        },
        "totals": dict(totals),
        "me03_failure_classes": dict(sorted(me03_failure_classes.items())),
        "models": model_results,
        "analysis_boundary": (
            "ME-02 strict program execution and ME-03 strict contract scores are frozen primary "
            "metrics. ME-03 semantic_selection_passed_post_hoc ignores only output-schema/basis "
            "shape and re-evaluates selected candidates against the original visible contract; "
            "it is a diagnostic secondary metric, not a replacement scorer."
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = analyze(args.root.resolve())
    rendered = json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.output is None:
        print(rendered, end="")
    else:
        args.output.write_text(rendered, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
