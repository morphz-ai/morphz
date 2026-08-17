#!/usr/bin/env python3
"""No-model token/selector planner and deterministic freezer for DEMO-001."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any, Callable


ROOT = Path(__file__).resolve().parents[2]
FIXTURE_DIR = ROOT / "morphz-evals/tests/fixtures/roadshow_demo_001_v2"
BASE_FIXTURE = FIXTURE_DIR / "event_stream.json"
PROMPT_BUNDLE = FIXTURE_DIR / "prompt_bundle_candidate_v2.json"

AUTHORITY_IDS = {
    "orbit42-history-release-v1",
    "orbit42-history-release-v2",
    "orbit42-history-security-rule",
    "orbit42-stage1-release-v3",
    "orbit42-stage1-compliance-policy",
    "orbit42-stage4-late-archived-v1",
}

BACKGROUND_TEMPLATES = (
    "Closed customer-support review {index:03}; no ORBIT-42 production-state change.",
    "Reconciled vendor invoice {index:03}; no ORBIT-42 production-state change.",
    "Completed onboarding checklist {index:03}; no ORBIT-42 production-state change.",
    "Archived marketing draft {index:03}; no ORBIT-42 production-state change.",
    "Reviewed domain renewal {index:03}; no ORBIT-42 production-state change.",
    "Completed deployment diagnostic {index:03}; no ORBIT-42 production-state change.",
    "Recorded roadmap discussion {index:03}; no ORBIT-42 production-state change.",
    "Closed analytics investigation {index:03}; no ORBIT-42 production-state change.",
)

ARMS = (
    "persistent_messages",
    "summary_json_memory",
    "morphz_structured_context",
)

SUMMARY_SCHEMA = {
    "type": "object",
    "required": [
        "schema_version",
        "current_facts",
        "field_sources",
        "open_items",
        "source_notes",
        "last_maintained_event_sequence",
    ],
    "properties": {
        "schema_version": {"const": "demo-001-summary-v1"},
        "current_facts": {
            "type": "object",
            "required": [
                "project",
                "version",
                "port",
                "endpoint",
                "retention_days",
                "timezone",
                "security_rule",
            ],
            "properties": {
                "project": {"type": ["string", "null"]},
                "version": {"type": ["string", "null"]},
                "port": {"type": ["integer", "null"]},
                "endpoint": {"type": ["string", "null"]},
                "retention_days": {"type": ["integer", "null"]},
                "timezone": {"type": ["string", "null"]},
                "security_rule": {"type": ["string", "null"]},
            },
            "additionalProperties": False,
        },
        "field_sources": {"type": "object"},
        "open_items": {"type": "array", "items": {"type": "string"}},
        "source_notes": {"type": "array", "items": {"type": "string"}},
        "last_maintained_event_sequence": {"type": "integer"},
    },
    "additionalProperties": False,
}

SUMMARY_PROMPT = (
    "Update the JSON memory using only the prior valid memory and the new complete events. "
    "Return JSON matching the schema and no prose. Preserve a current fact until explicit "
    "evidence supersedes or revokes it. Physical arrival order alone does not establish "
    "authority. Superseded and archived-untrusted records are historical. Preserve event_id, "
    "principal_id and observed_sequence for each accepted field. Do not invent missing facts."
)


def compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def projected_event(event: dict[str, Any]) -> dict[str, Any]:
    fields = (
        "sequence",
        "event_id",
        "stage",
        "kind",
        "principal_id",
        "session_id",
        "thread_id",
        "payload",
    )
    return {field: event[field] for field in fields}


def background_event(index: int) -> dict[str, Any]:
    template = BACKGROUND_TEMPLATES[(index - 1) % len(BACKGROUND_TEMPLATES)]
    return {
        "sequence": 0,
        "event_id": f"company-history-background-{index:03}",
        "stage": "history",
        "kind": "evidence",
        "principal_id": "principal-release-owner",
        "session_id": "release-coordination",
        "thread_id": "company-operations-history",
        "injection_group": None,
        "scheduled_offset_ms": 0,
        "payload": {
            "status": "process-record",
            "project": "COMPANY-OPS",
            "record_type": "completed-business-operation",
            "text": template.format(index=index),
            "changes_orbit42_state": False,
        },
    }


def build_level(level: str) -> dict[str, Any]:
    base = json.loads(BASE_FIXTURE.read_text())
    background_count = {"normal_load": 32, "context_pressure": 128}[level]
    events = [dict(event) for event in base["events"][:3]]
    events.extend(background_event(index) for index in range(1, background_count + 1))
    tail = [dict(event) for event in base["events"][3:-1]]
    for event in tail:
        if event["event_id"] == "orbit42-stage1-compliance-policy":
            event = json.loads(json.dumps(event))
            event["payload"].pop("security_rule", None)
        events.append(event)
    events.append(
        {
            "sequence": 0,
            "event_id": "orbit42-stage4-current-state-request",
            "stage": "stage_4_late_conflict",
            "kind": "user_request",
            "principal_id": "principal-release-owner",
            "session_id": "release-coordination",
            "thread_id": "release",
            "injection_group": None,
            "scheduled_offset_ms": 0,
            "payload": {
                "request": "Report the current state after the late archived evidence using report_current_state exactly once."
            },
        }
    )
    events.append(dict(base["events"][-1]))
    for sequence, event in enumerate(events, start=1):
        event["sequence"] = sequence
    return {
        "fixture_id": base["fixture_id"],
        "fixture_version": f"frozen-v2-{level}",
        "purpose": "roadshow_demo",
        "load_level": level,
        "events": events,
    }


def get_counter(encoding_name: str) -> tuple[Callable[[str], int], str]:
    try:
        import tiktoken  # type: ignore

        encoding = tiktoken.get_encoding(encoding_name)
        return (
            lambda text: len(encoding.encode(text)),
            f"tiktoken:{tiktoken.__version__}:{encoding_name}",
        )
    except Exception as error:  # noqa: BLE001 - report an explicit deterministic fallback
        return (
            lambda text: math.ceil(len(text.encode("utf-8")) / 4),
            f"fallback:utf8_bytes_div_4:{type(error).__name__}",
        )


def select_history(
    history: list[dict[str, Any]], available_tokens: int, count: Callable[[str], int]
) -> tuple[list[dict[str, Any]], int]:
    selected: list[dict[str, Any]] = []
    used = 0
    for event in reversed(history):
        event_tokens = count(compact(projected_event(event)))
        if used + event_tokens > available_tokens:
            break
        selected.append(event)
        used += event_tokens
    selected.reverse()
    return selected, used


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--encoding", default="o200k_base")
    parser.add_argument("--active-input-cap", type=int, default=16_384)
    parser.add_argument("--wrapper-reserve", type=int, default=256)
    parser.add_argument("--prior-report-round-reserve", type=int, default=256)
    parser.add_argument("--output-cap", type=int, default=512)
    parser.add_argument(
        "--write-frozen",
        type=Path,
        help="write deterministic frozen-v2 fixtures and the planner report to DIR",
    )
    args = parser.parse_args()

    count, counter_name = get_counter(args.encoding)
    bundle = json.loads(PROMPT_BUNDLE.read_text())
    system_tokens = count(bundle["system_prompt"])
    tools_text = compact(bundle["tool_schemas"])
    tool_tokens = count(tools_text)

    report: dict[str, Any] = {
        "measurement": {
            "counter": counter_name,
            "encoding_requested": args.encoding,
            "active_input_cap": args.active_input_cap,
            "wrapper_reserve": args.wrapper_reserve,
            "prior_report_round_reserve": args.prior_report_round_reserve,
            "output_cap_separate": args.output_cap,
            "system_tokens": system_tokens,
            "tool_schema_tokens": tool_tokens,
        },
        "levels": {},
    }

    request_ids = (
        "orbit42-stage2-cross-session-request",
        "orbit42-stage4-current-state-request",
        "orbit42-stage5-final-action-request",
    )
    for level in ("normal_load", "context_pressure"):
        fixture = build_level(level)
        fixture_text = compact(fixture)
        level_report: dict[str, Any] = {
            "event_count": len(fixture["events"]),
            "fixture_utf8_bytes": len(fixture_text.encode("utf-8")),
            "fixture_tokens": count(fixture_text),
            "fixture_sha256": hashlib.sha256(fixture_text.encode()).hexdigest(),
            "requests": {},
        }
        for prior_report_rounds, request_id in enumerate(request_ids):
            current_index = next(
                index
                for index, event in enumerate(fixture["events"])
                if event["event_id"] == request_id
            )
            current = fixture["events"][current_index]
            request_text = current["payload"]["request"]
            request_tokens = count(request_text)
            prior_transcript_reserve = prior_report_rounds * args.prior_report_round_reserve
            fixed = (
                system_tokens
                + tool_tokens
                + request_tokens
                + args.wrapper_reserve
                + prior_transcript_reserve
            )
            available = max(0, args.active_input_cap - fixed)
            selected, selected_tokens = select_history(
                fixture["events"][:current_index], available, count
            )
            visible = {event["event_id"] for event in selected}
            authority_visibility = {
                event_id: event_id in visible for event_id in sorted(AUTHORITY_IDS)
            }
            level_report["requests"][request_id] = {
                "request_tokens": request_tokens,
                "prior_transcript_reserve": prior_transcript_reserve,
                "fixed_tokens": fixed,
                "event_budget_tokens": available,
                "selected_event_tokens": selected_tokens,
                "selected_event_count": len(selected),
                "selected_first_event": selected[0]["event_id"] if selected else None,
                "selected_last_event": selected[-1]["event_id"] if selected else None,
                "omitted_event_count": current_index - len(selected),
                "authority_visibility": authority_visibility,
            }
        report["levels"][level] = level_report

    if args.write_frozen is not None:
        output = args.write_frozen.resolve()
        output.mkdir(parents=True, exist_ok=True)
        for level in ("normal_load", "context_pressure"):
            fixture = build_level(level)
            path = output / f"event_stream_{level}.json"
            path.write_text(
                json.dumps(fixture, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        frozen_bundle = dict(bundle)
        frozen_bundle["status"] = "frozen-v2.1"
        frozen_bundle["model"] = "gpt-5.6-sol"
        frozen_bundle["model_profile"] = "roadshow-demo-001"
        frozen_bundle["provider_route"] = "custom"
        frozen_bundle["provider_transport"] = "CLIProxyAPI-compatible OpenAI Responses"
        frozen_bundle["reasoning_effort_requested"] = "max"
        frozen_bundle["active_input_cap"] = args.active_input_cap
        frozen_bundle["business_output_acceptance_cap"] = args.output_cap
        frozen_bundle["maintenance_output_acceptance_cap"] = 1024
        (output / "prompt_bundle.json").write_text(
            json.dumps(frozen_bundle, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        state_contract = {
            "status": "frozen-v2",
            "summary_schema": SUMMARY_SCHEMA,
            "summary_maintenance_prompt": SUMMARY_PROMPT,
            "maintenance_trigger_new_evidence_tokens": 4096,
            "state_cap_tokens": 2048,
            "repair_calls_per_maintenance": 1,
            "morphz_objects": [
                "release:orbit42/current",
                "policy:orbit42/retention",
                "policy:orbit42/timezone",
                "rule:orbit42/no-secret-logging",
            ],
            "morphz_transaction_validation": [
                "schema",
                "principal_object_permissions",
                "source_event_reference",
                "version_and_supersession",
            ],
        }
        (output / "state_contract.json").write_text(
            json.dumps(state_contract, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        queue = []
        queue_index = 0
        for level_index, level in enumerate(("normal_load", "context_pressure")):
            for cell_offset, pair_cell_id in enumerate(range(42001, 42006)):
                rotation = (cell_offset + level_index) % len(ARMS)
                for arm in ARMS[rotation:] + ARMS[:rotation]:
                    queue_index += 1
                    queue.append(
                        {
                            "queue_index": queue_index,
                            "load_level": level,
                            "pair_cell_id": pair_cell_id,
                            "arm": arm,
                            "sampling_seed_applied": False,
                        }
                    )
        (output / "queue.json").write_text(
            json.dumps(queue, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        (output / "token_selector_report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
