#!/usr/bin/env python3
"""Require every configured Node shard to cover the full current file inventory."""

import argparse
import json
import os
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
# GitHub allows 1 MiB of UTF-16 outputs per job. Bound each record below a
# quarter of that budget; four matrix records still leave bounded headroom.
MAX_OUTPUT_BYTES = 240 * 1024


def inventory(root=ROOT):
    return sorted(f"tests/{path.name}" for path in (root / "application/tests").glob("*.test.ts"))


def coordinates(total):
    if total not in (2, 4):
        raise ValueError("Only the configured two or four complete shards are supported")
    return frozenset(f"{index}/{total}" for index in range(1, total + 1))


def validate(record, expected, commit, total=2):
    if not re.fullmatch(r"[0-9a-f]{40}", commit) or record.get("source_commit") != commit:
        raise ValueError("Shard evidence belongs to another source commit")
    coverage = record["coverage"]
    counts = coverage["counts"]
    if not all(type(counts.get(key)) is int and counts[key] >= 0
               for key in ("tests", "passed", "failed", "cancelled", "skipped", "todo")):
        raise ValueError("Missing or invalid native test counts")
    if counts["passed"] == 0 or any(counts[key] for key in ("failed", "cancelled", "todo")):
        raise ValueError("Every shard must finish successfully without failures, cancellation or TODOs")
    if counts["tests"] != counts["passed"] + counts["skipped"]:
        raise ValueError("The final native test counts are inconsistent")
    if coverage.get("unexpectedSkips") != [] or "postgres" not in coverage.get("required", []):
        raise ValueError("Required PostgreSQL and skip auditing must remain enabled")
    if counts["skipped"] != len(coverage["optionalNotExecuted"]):
        raise ValueError("Every skipped case must retain its explicit capability receipt")
    shard = coverage["shard"]
    if shard.get("unexpectedFiles") != []:
        raise ValueError("Unexpected native file summaries cannot be ignored")
    if shard["coordinate"] not in coordinates(total) or shard["inventory"] != expected:
        raise ValueError("Shard must identify the complete current test inventory")
    executed = shard["executedFiles"]
    if not executed or executed != sorted(set(executed)) or not set(executed) <= set(expected):
        raise ValueError("Actual Node file summaries are missing, duplicated or foreign")
    return shard["coordinate"], set(executed)


def verify(records, expected, commit, total=2):
    required_coordinates = coordinates(total)
    if len(records) != total or not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("Every configured report and one complete source commit are required")
    seen_coordinates, executed = set(), set()
    for record in records:
        coordinate, files = validate(record, expected, commit, total)
        if coordinate in seen_coordinates or files & executed:
            raise ValueError("Duplicate shard or overlapping executed files")
        seen_coordinates.add(coordinate)
        executed.update(files)
    if seen_coordinates != required_coordinates or executed != set(expected):
        raise ValueError("The shards did not execute every current test file exactly once")
    return {"source_commit": commit, "files": len(executed), "shards": sorted(seen_coordinates),
            "passed": sum(record["coverage"]["counts"]["passed"] for record in records),
            "explicit_optional_omissions": sum(record["coverage"]["counts"]["skipped"] for record in records)}


def capture(log, coordinate, expected, commit, total=2):
    coverage = None
    with log.open() as stream:
        for line in stream:
            if line.startswith("[test coverage] "):
                coverage = json.loads(line.removeprefix("[test coverage] "))
    if coverage is None:
        raise ValueError("The native test process produced no final coverage receipt")
    record = {"source_commit": commit, "coverage": coverage}
    actual, _ = validate(record, expected, commit, total)
    if actual != coordinate:
        raise ValueError("The report does not belong to the requested matrix shard")
    return record


def write_output(path, record, expected, commit, total=2):
    coordinate, files = validate(record, expected, commit, total)
    payload = json.dumps(record, ensure_ascii=True, separators=(",", ":"))
    size = len(payload.encode("utf-16-le"))
    if size > MAX_OUTPUT_BYTES:
        raise ValueError("Native shard output exceeds its UTF-16 byte budget")
    # JSON escapes newlines: metadata cannot create another output assignment.
    with path.open("a", encoding="utf-8") as output:
        output.write(f"report_{coordinate[0]}={payload}\n")
    return {"shard": coordinate, "executed_files": len(files), "output_utf16_bytes": size}


def read_outputs(env, total=2, prefix="MACOS_NODE"):
    coordinates(total)
    if prefix not in ("MACOS_NODE", "WEB_NODE"):
        raise ValueError("Unknown shard evidence owner")
    records = []
    for index in range(1, total + 1):
        payload = env.get(f"{prefix}_REPORT_{index}")
        if not payload:
            raise ValueError(f"Missing native shard output {index}/{total}")
        if len(payload.encode("utf-16-le")) > MAX_OUTPUT_BYTES:
            raise ValueError("Native shard output exceeds its UTF-16 byte budget")
        record = json.loads(payload)
        if record["coverage"]["shard"]["coordinate"] != f"{index}/{total}":
            raise ValueError("Native matrix output does not match its shard coordinate")
        records.append(record)
    return records


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="operation", required=True)
    record = commands.add_parser("capture")
    record.add_argument("--log", type=Path, required=True)
    record.add_argument("--shard", required=True)
    record.add_argument("--total", type=int, choices=(2, 4), default=2)
    record.add_argument("--github-output", type=Path, required=True)
    record.add_argument("--commit", required=True)
    complete = commands.add_parser("verify")
    complete.add_argument("--commit", required=True)
    complete.add_argument("--total", type=int, choices=(2, 4), default=2)
    complete.add_argument("--report-prefix", choices=("MACOS_NODE", "WEB_NODE"), default="MACOS_NODE")
    args = parser.parse_args()
    expected = inventory()
    try:
        if args.operation == "capture":
            result = capture(args.log, args.shard, expected, args.commit, args.total)
            print(json.dumps(write_output(args.github_output, result, expected, args.commit, args.total)))
        else:
            reports = read_outputs(os.environ, args.total, args.report_prefix)
            print(json.dumps(verify(reports, expected, args.commit, args.total), indent=2))
    except (KeyError, TypeError, ValueError, OSError) as error:
        parser.exit(1, f"Node shard coverage rejected: {error}\n")


if __name__ == "__main__":
    main()
