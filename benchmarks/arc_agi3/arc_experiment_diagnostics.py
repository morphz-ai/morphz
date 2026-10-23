"""Read saved experiment receipts; never import an engine or run a solver.

This is engineering evidence, not an official ARC score. Provider tokens per
request-second include prefill and other request overhead, not pure decode TPS.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import re


def load_json(path, default=None):
    return json.loads(path.read_text()) if path.exists() else default


def load_lines(path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def summarize(root):
    root = Path(root)
    results = load_json(root / "results.json", [])
    protocol = load_json(root / "protocol.json", {})
    wire = load_lines(root / "provider-wire.jsonl")
    gpu = load_lines(root / "gpu.jsonl")
    http_statuses = Counter(str(row.get("status", "missing")) for row in wire)
    finishes = Counter()
    request_rates = []
    for row in wire:
        for part in row.get("response", []):
            if isinstance(part, dict):
                for choice in part.get("choices", []):
                    reason = choice.get("finish_reason")
                    if reason:
                        finishes[reason] += 1
        usage = row.get("usage") or {}
        elapsed = row.get("elapsed_s", 0)
        if row.get("completed") and row.get("status") == 200 and elapsed > 0:
            if "completion_tokens" in usage:
                request_rates.append(usage["completion_tokens"] / elapsed)
    memory = []
    for row in gpu:
        numbers = re.findall(r"\d+", row.get("sample", ""))
        if len(numbers) >= 2:
            memory.append((int(numbers[0]), int(numbers[1])))
    attempts = []
    for result in results:
        label = f"{result['game']}-{result['arm']}"
        directory = root / label
        rows = load_lines(directory / "workspace" / "trajectory.jsonl")
        jobs = load_json(directory / "tool-jobs.json", [])
        log_path = directory / "runtime.log"
        log = log_path.read_text(errors="replace") if log_path.exists() else ""
        log = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", log)
        inputs = [int(v) for v in re.findall(r"input_tokens=Some\((\d+)\)", log)]
        review = []
        for job in jobs:
            if job.get("tool_name") not in {"exec", "read"}:
                continue
            request = str(job.get("request_json", ""))
            if any(term in request for term in (
                "/kaggle/input", "arcengine", "environment_files", "site-packages", "bridge-source"
            )):
                review.append({k: job.get(k) for k in ("tool_name", "request_json", "status")})
        transitions = []
        for index, row in enumerate(rows):
            if index == 0 or any(row.get(k) != rows[index-1].get(k)
                                 for k in ("state", "levels_completed")):
                transitions.append({k: row.get(k) for k in (
                    "actions", "state", "levels_completed", "elapsed_s"
                )})
        attempts.append({
            "run": label,
            "result": result,
            "trajectory_rows": len(rows),
            "actual_recorded_actions": len(rows) - 1 if rows else None,
            "actions_match_result": len(rows) - 1 == result.get("actions") if rows else None,
            "best_levels_from_trajectory": max((r.get("levels_completed", 0) for r in rows), default=None),
            "level_transitions": transitions,
            "max_actual_input_tokens_from_runtime_log": max(inputs, default=None),
            "tool_counts": dict(Counter(job.get("tool_name", "unknown") for job in jobs)),
            "failed_tool_jobs": sum(job.get("status") == "failed" for job in jobs),
            "output_limit_failure_lines": [line for line in log.splitlines()
                if 'state="failed"' in line and "output length limit" in line],
            "runtime_protocol_failure_lines": [line for line in log.splitlines()
                if 'state="protocol_invalid"' in line or "Thread Activation evaluation failed" in line],
            "source_access_review_candidates": review,
        })
    return {
        "evidence": "Saved engine trajectories, Runtime tool receipts and provider wire",
        "official_score": False,
        "protocol": protocol,
        "attempts": attempts,
        "transport": {
            "saved_request_records": len(wire),
            "http_status_counts": dict(http_statuses),
            "request_error_count": sum(bool(row.get("error")) for row in wire),
            "completed_http_200": sum(row.get("status") == 200 and row.get("completed", False) for row in wire),
            "image_requests": sum(row.get("images_in_request", 0) > 0 for row in wire),
            "stream_finish_reasons": dict(finishes),
            "max_reported_prompt_tokens": max(((row.get("usage") or {}).get("prompt_tokens", 0) for row in wire), default=None),
            "output_tokens_per_request_second_including_prefill_mean": (
                sum(request_rates) / len(request_rates) if request_rates else None
            ),
        },
        "gpu": {
            "samples": len(gpu),
            "peak_used_mib": max((used for used, _ in memory), default=None),
            "total_mib": max((total for _, total in memory), default=None),
        },
        "limits": [
            "One bounded attempt per game is not a statistical performance estimate.",
            "No model WIN claim replaces official engine feedback.",
            "Full-access tool-log review is not an OS-enforced anti-cheating sandbox.",
            "A clean source-access keyword scan still requires manual tool review.",
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    report = summarize(args.directory)
    destination = args.directory / "DIAGNOSTICS.json"
    destination.write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
